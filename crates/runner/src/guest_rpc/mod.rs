//! One assignment-bound guest RPC owner; each consumer retains its business authority.

#[cfg(test)]
mod tests;

use std::{sync::Arc, time::Duration};

use runner_rpc_proto::{Delivery, ErrorCode, Response, ResponseWriter};
use sandbox::{AcceptedGuestRpc, GuestRpcAcceptor, GuestRpcStream, Sandbox};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    task::{JoinHandle, JoinSet},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

use crate::{ids::RunId, run_usage, ssh, types::ExecutionContext, vnc};

const RUN_REQUEST_CAPACITY: usize = 8;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub(crate) struct Runtime {
    pub(crate) ssh: Option<Arc<ssh::SshRuntime>>,
    pub(crate) vnc: Option<Arc<vnc::VncRuntime>>,
    pub(crate) usage: Option<run_usage::Runtime>,
}

/// The stream and permit move together into a consumer. Host work may retain
/// the permit independently after releasing guest I/O and its park reservation.
pub(crate) struct Request {
    pub(crate) input: Box<dyn GuestRpcStream>,
    pub(crate) lease: Arc<OwnedSemaphorePermit>,
    pub(crate) run: RunId,
    pub(crate) started: Instant,
    pub(crate) deadline: Instant,
    pub(crate) cancelled: CancellationToken,
    pub(crate) sandbox_cancelled: CancellationToken,
    pub(crate) request: runner_rpc_proto::Request,
}

impl Runtime {
    pub(crate) fn install(
        &self,
        sandbox: &dyn Sandbox,
        context: &ExecutionContext,
        cancel: &CancellationToken,
    ) -> Option<Run> {
        let acceptor = sandbox.guest_rpc(&context.run_id.to_string())?;
        let usage = self
            .usage
            .as_ref()
            .and_then(|runtime| runtime.for_context(context));
        Some(self.start_with_usage(
            acceptor,
            sandbox.id().to_owned(),
            context.run_id,
            cancel,
            usage,
        ))
    }

    #[cfg(test)]
    pub(crate) fn start(
        &self,
        acceptor: Arc<dyn GuestRpcAcceptor>,
        sandbox: String,
        run: RunId,
        cancel: &CancellationToken,
    ) -> Run {
        self.start_with_usage(acceptor, sandbox, run, cancel, None)
    }

    fn start_with_usage(
        &self,
        acceptor: Arc<dyn GuestRpcAcceptor>,
        sandbox: String,
        run: RunId,
        cancel: &CancellationToken,
        usage: Option<Arc<run_usage::Run>>,
    ) -> Run {
        let cancel = cancel.child_token();
        let ssh = self
            .ssh
            .as_ref()
            .map(|runtime| runtime.for_run(run, &cancel));
        let vnc = self
            .vnc
            .as_ref()
            .map(|runtime| runtime.for_run(run, &cancel));
        let task_cancel = cancel.clone();
        let task_ssh = ssh.clone();
        let task_vnc = vnc.clone();
        let task = tokio::spawn(serve(
            acceptor,
            sandbox,
            run,
            task_cancel,
            task_ssh,
            task_vnc,
            usage,
        ));
        Run {
            cancel,
            task: Some(task),
            ssh,
            vnc,
        }
    }
}

async fn serve(
    acceptor: Arc<dyn GuestRpcAcceptor>,
    sandbox: String,
    run: RunId,
    cancel: CancellationToken,
    ssh: Option<Arc<ssh::Run>>,
    vnc: Option<Arc<vnc::Run>>,
    usage: Option<Arc<run_usage::Run>>,
) {
    let permits = Arc::new(Semaphore::new(RUN_REQUEST_CAPACITY));
    let mut prune = tokio::time::interval(Duration::from_secs(30));
    prune.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut tasks = JoinSet::new();
    loop {
        let accepted = tokio::select! {
            biased;
            () = cancel.cancelled() => break,
            _ = prune.tick(), if ssh.is_some() => {
                if let Some(ssh) = &ssh { ssh.prune(); }
                continue;
            }
            result = tasks.join_next(), if !tasks.is_empty() => {
                if result.is_some_and(|result| result.is_err()) {
                    tracing::warn!(run_id = %run, "Guest RPC request task failed");
                }
                continue;
            }
            result = acceptor.accept() => match result {
                Ok(accepted) => accepted,
                Err(_) => break,
            },
        };
        if accepted.sandbox_id != sandbox {
            continue;
        }
        let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else {
            tracing::info!(run_id = %run, sandbox_id = %sandbox, outcome = "resource_exhausted", "Guest RPC admission rejected");
            reject(accepted, &cancel).await;
            continue;
        };
        let scope = Scope {
            cancelled: cancel.child_token(),
            sandbox_cancelled: accepted.cancelled,
            deadline: Instant::now() + REQUEST_TIMEOUT,
        };
        tasks.spawn(dispatch(
            accepted.stream,
            Arc::new(permit),
            run,
            scope,
            ssh.clone(),
            vnc.clone(),
            usage.clone(),
        ));
    }
    cancel.cancel();
    if let Some(ssh) = &ssh {
        ssh.close();
    }
    if let Some(vnc) = &vnc {
        vnc.close();
    }
    while tasks.join_next().await.is_some() {}
    if let Some(ssh) = &ssh {
        ssh.shutdown().await;
    }
    if let Some(vnc) = &vnc {
        vnc.shutdown().await;
    }
}

async fn dispatch(
    mut input: Box<dyn GuestRpcStream>,
    lease: Arc<OwnedSemaphorePermit>,
    run: RunId,
    scope: Scope,
    ssh: Option<Arc<ssh::Run>>,
    vnc: Option<Arc<vnc::Run>>,
    usage: Option<Arc<run_usage::Run>>,
) {
    let _cancel_on_drop = scope.cancelled.clone().drop_guard();
    let started = Instant::now();
    let request = match scope.wait(runner_rpc_proto::read_request(&mut input)).await {
        Some(Ok(request)) => request,
        _ => {
            scope.error(input, ErrorCode::InvalidRequest).await;
            return;
        }
    };
    if matches!(
        request.method.as_str(),
        "ssh.exec" | "ssh.file.upload" | "ssh.file.download"
    ) || request.method.starts_with("ssh.session.")
    {
        if let Some(ssh) = ssh {
            // Only request parsing uses the setup deadline here. The consumer
            // owns execution budgets, including the longer file-transfer bound.
            ssh.dispatch(Request {
                input,
                lease,
                run,
                started,
                deadline: scope.deadline,
                cancelled: scope.cancelled,
                sandbox_cancelled: scope.sandbox_cancelled,
                request,
            })
            .await;
        } else {
            scope.error(input, ErrorCode::Unavailable).await;
        }
    } else if matches!(
        request.method.as_str(),
        "vnc.session.start"
            | "vnc.session.list"
            | "vnc.session.status"
            | "vnc.session.close"
            | "vnc.capture"
            | "vnc.input"
    ) {
        if let Some(vnc) = vnc {
            vnc.dispatch(Request {
                input,
                lease,
                run,
                started,
                deadline: scope.deadline,
                cancelled: scope.cancelled,
                sandbox_cancelled: scope.sandbox_cancelled,
                request,
            })
            .await;
        } else {
            scope.error(input, ErrorCode::Unavailable).await;
        }
    } else if request.method == "run.usage" {
        if let Some(usage) = usage {
            usage
                .dispatch(Request {
                    input,
                    lease,
                    run,
                    started,
                    deadline: scope.deadline,
                    cancelled: scope.cancelled,
                    sandbox_cancelled: scope.sandbox_cancelled,
                    request,
                })
                .await;
        } else {
            scope.error(input, ErrorCode::Unavailable).await;
        }
    } else {
        scope.error(input, ErrorCode::UnknownMethod).await;
    }
}

struct Scope {
    cancelled: CancellationToken,
    sandbox_cancelled: CancellationToken,
    deadline: Instant,
}

impl Scope {
    async fn wait<T>(&self, future: impl std::future::Future<Output = T>) -> Option<T> {
        tokio::select! {
            biased;
            () = self.cancelled.cancelled() => None,
            () = self.sandbox_cancelled.cancelled() => None,
            () = tokio::time::sleep_until(self.deadline) => None,
            result = future => Some(result),
        }
    }

    async fn error(&self, input: Box<dyn GuestRpcStream>, code: ErrorCode) {
        let mut writer = ResponseWriter::new(input);
        let _ = self
            .wait(writer.send(&Response::error(code, Delivery::NotDispatched)))
            .await;
    }
}

async fn reject(accepted: AcceptedGuestRpc, cancel: &CancellationToken) {
    Scope {
        cancelled: cancel.clone(),
        sandbox_cancelled: accepted.cancelled,
        deadline: Instant::now() + Duration::from_millis(100),
    }
    .error(accepted.stream, ErrorCode::ResourceExhausted)
    .await;
}

pub(crate) struct Run {
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
    ssh: Option<Arc<ssh::Run>>,
    vnc: Option<Arc<vnc::Run>>,
}

impl Run {
    fn close(&self) {
        self.cancel.cancel();
        if let Some(ssh) = &self.ssh {
            ssh.close();
        }
        if let Some(vnc) = &self.vnc {
            vnc.close();
        }
    }

    pub(crate) async fn shutdown(mut self) {
        self.close();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        self.close();
    }
}
