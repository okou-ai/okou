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

use runner_types::{ids::RunId, types::ExecutionContext};

use crate::{native, run_usage, ssh, vnc};

const RUN_REQUEST_CAPACITY: usize = 8;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Required host cleanup failed. No SDK/provider error or panic payload crosses this boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum CleanupError {
    #[error("guest RPC owner failed during required cleanup")]
    Owner,
    #[error("native resource cleanup was not confirmed")]
    Native,
}

#[derive(Clone)]
pub struct Runtime {
    native: native::Runtime,
    pub ssh: Option<Arc<ssh::SshRuntime>>,
    pub vnc: Option<Arc<vnc::VncRuntime>>,
    pub usage: Option<run_usage::Runtime>,
}

impl runner_provider::AblySideMessageHandler for Runtime {
    fn handle(&self, message: &ably_subscriber::Message) -> bool {
        let ssh = self
            .ssh
            .as_ref()
            .is_some_and(|runtime| runtime.handle(message));
        // Both owners must see SSH revocation: VNC can depend on that route.
        let vnc = self
            .vnc
            .as_ref()
            .is_some_and(|runtime| runtime.handle(message));
        ssh || vnc
    }
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

#[derive(Clone)]
struct Consumers {
    ssh: Option<Arc<ssh::Run>>,
    vnc: Option<Arc<vnc::Run>>,
    usage: Option<Arc<run_usage::Run>>,
    diagnostics: crate::diagnostics::Handle,
    authority: Option<Arc<crate::diagnostics::Authority>>,
}

impl Runtime {
    pub fn new(
        ssh: Option<Arc<ssh::SshRuntime>>,
        vnc: Option<Arc<vnc::VncRuntime>>,
        usage: Option<run_usage::Runtime>,
    ) -> Self {
        Self {
            native: native::Runtime::new(),
            ssh,
            vnc,
            usage,
        }
    }

    pub fn install(
        &self,
        sandbox: &dyn Sandbox,
        context: &ExecutionContext,
        cancel: &CancellationToken,
    ) -> Option<Run> {
        let acceptor = sandbox.guest_rpc(&context.run_id.to_string())?;
        let usage = self
            .usage
            .as_ref()
            .map(|runtime| runtime.for_context(context));
        let authority = context
            .platform_environment
            .get("OKOU_TOKEN")
            .and_then(|token| {
                let http = self
                    .ssh
                    .as_ref()
                    .map(|s| s.http_client())
                    .or_else(|| self.vnc.as_ref().map(|v| v.http_client()))?;
                Some(Arc::new(crate::diagnostics::Authority::new(http, token)))
            });
        Some(self.start_with_diagnostics(
            acceptor,
            sandbox.id().to_owned(),
            context.run_id,
            cancel,
            usage,
            authority,
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

    #[cfg(test)]
    fn start_with_usage(
        &self,
        acceptor: Arc<dyn GuestRpcAcceptor>,
        sandbox: String,
        run: RunId,
        cancel: &CancellationToken,
        usage: Option<Arc<run_usage::Run>>,
    ) -> Run {
        self.start_with_diagnostics(acceptor, sandbox, run, cancel, usage, None)
    }

    pub(crate) fn start_with_diagnostics(
        &self,
        acceptor: Arc<dyn GuestRpcAcceptor>,
        sandbox: String,
        run: RunId,
        cancel: &CancellationToken,
        usage: Option<Arc<run_usage::Run>>,
        authority: Option<Arc<crate::diagnostics::Authority>>,
    ) -> Run {
        let cancel = cancel.child_token();
        let native = self
            .native
            .register_with_diagnostics(run, &cancel, authority.is_some());
        let ssh = self
            .ssh
            .as_ref()
            .map(|runtime| runtime.for_run(run, &cancel, Arc::clone(&native)));
        let vnc = self
            .vnc
            .as_ref()
            .map(|runtime| runtime.for_run(run, &cancel, ssh.clone(), Arc::clone(&native)));
        if let Some(vnc) = &vnc {
            vnc.set_diagnostics(native.diagnostics.clone());
        }
        let task_ssh = ssh.clone();
        let task_vnc = vnc.clone();
        let task_native = Arc::clone(&native);
        let task = tokio::spawn(serve(
            acceptor,
            sandbox,
            run,
            task_native,
            Consumers {
                ssh: task_ssh,
                vnc: task_vnc,
                usage,
                diagnostics: native.diagnostics.clone(),
                authority,
            },
        ));
        Run {
            cancel,
            task: Some(task),
            native,
            ssh,
            vnc,
        }
    }
}

async fn serve(
    acceptor: Arc<dyn GuestRpcAcceptor>,
    sandbox: String,
    run: RunId,
    native: Arc<native::Run>,
    consumers: Consumers,
) {
    let ssh = consumers.ssh.clone();
    let vnc = consumers.vnc.clone();
    let cancel = native.cancelled();
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
            consumers.clone(),
        ));
    }
    cancel.cancel();
    native.close();
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
    // The Registry keeps any failure sticky for shutdown() and later replacement.
    // Settling here also retains physical cleanup when its external waiter is gone.
    let _ = native.shutdown().await;
}

async fn dispatch(
    mut input: Box<dyn GuestRpcStream>,
    lease: Arc<OwnedSemaphorePermit>,
    run: RunId,
    scope: Scope,
    consumers: Consumers,
) {
    let Consumers {
        ssh,
        vnc,
        usage,
        diagnostics,
        authority,
    } = consumers;
    let _cancel_on_drop = scope.cancelled.clone().drop_guard();
    let started = Instant::now();
    let request = match scope.wait(runner_rpc_proto::read_request(&mut input)).await {
        Some(Ok(request)) => request,
        _ => {
            scope.error(input, ErrorCode::InvalidRequest).await;
            return;
        }
    };
    if matches!(request.method.as_str(), "ssh.check" | "vnc.check") {
        let protocol = if request.method == "ssh.check" {
            crate::diagnostics::Protocol::Ssh
        } else {
            crate::diagnostics::Protocol::Vnc
        };
        if !diagnostics.enabled()
            || !diagnostics.current()
            || !authority
                .as_ref()
                .is_some_and(|a| a.permits_check(run, protocol))
        {
            scope.error(input, ErrorCode::Unavailable).await;
            return;
        }
        let request = Request {
            input,
            lease,
            run,
            started,
            deadline: scope.deadline,
            cancelled: scope.cancelled.clone(),
            sandbox_cancelled: scope.sandbox_cancelled.clone(),
            request,
        };
        match protocol {
            crate::diagnostics::Protocol::Ssh => {
                if let Some(ssh) = ssh {
                    ssh.check(request).await;
                } else {
                    scope.error(request.input, ErrorCode::Unavailable).await;
                }
            }
            crate::diagnostics::Protocol::Vnc => {
                if let Some(vnc) = vnc {
                    vnc.check(request).await;
                } else {
                    scope.error(request.input, ErrorCode::Unavailable).await;
                }
            }
        }
    } else if matches!(request.method.as_str(), "ssh.diagnose" | "vnc.diagnose") {
        diagnostics
            .dispatch(
                Request {
                    input,
                    lease,
                    run,
                    started,
                    deadline: scope.deadline,
                    cancelled: scope.cancelled,
                    sandbox_cancelled: scope.sandbox_cancelled,
                    request,
                },
                authority,
            )
            .await;
    } else if matches!(
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

pub(crate) struct Scope {
    pub(crate) cancelled: CancellationToken,
    pub(crate) sandbox_cancelled: CancellationToken,
    pub(crate) deadline: Instant,
}

impl Scope {
    pub(crate) async fn wait<T>(&self, future: impl std::future::Future<Output = T>) -> Option<T> {
        tokio::select! {
            biased;
            () = self.cancelled.cancelled() => None,
            () = self.sandbox_cancelled.cancelled() => None,
            () = tokio::time::sleep_until(self.deadline) => None,
            result = future => Some(result),
        }
    }

    pub(crate) async fn error(&self, input: Box<dyn GuestRpcStream>, code: ErrorCode) {
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

pub struct Run {
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
    native: Arc<native::Run>,
    ssh: Option<Arc<ssh::Run>>,
    vnc: Option<Arc<vnc::Run>>,
}

impl Run {
    #[cfg(test)]
    pub(crate) fn native(&self) -> Arc<native::Run> {
        Arc::clone(&self.native)
    }

    #[cfg(test)]
    pub(crate) fn ssh(&self) -> Option<Arc<ssh::Run>> {
        self.ssh.clone()
    }

    fn close(&self) {
        self.cancel.cancel();
        self.native.close();
        if let Some(ssh) = &self.ssh {
            ssh.close();
        }
        if let Some(vnc) = &self.vnc {
            vnc.close();
        }
    }

    pub async fn shutdown(mut self) -> Result<(), CleanupError> {
        self.close();
        let task = self.task.take();
        let Some(task) = task else {
            return self
                .native
                .shutdown()
                .await
                .map_err(|_| CleanupError::Native);
        };
        // Transfer join ownership before any cleanup await. Dropping this waiter
        // cannot detach the ordinary serve epilogue or its retained native owners.
        let mut joined = self.native.retain_cleanup(task);
        let outcome = |result| match result {
            Ok(true) => Ok(()),
            _ => Err(CleanupError::Owner),
        };
        // A native failure must reach the executor at its five-second deadline,
        // even if the ordinary serve epilogue is still waiting for host work.
        let native = async {
            self.native
                .shutdown()
                .await
                .map_err(|_| CleanupError::Native)
        };
        tokio::pin!(native);
        tokio::select! {
            result = &mut native => match result {
                Ok(()) => outcome(joined.await),
                Err(error) => Err(error),
            },
            result = &mut joined => native.await.and(outcome(result)),
        }
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        self.close();
    }
}
