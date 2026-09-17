//! Official Runner-owned SSH execution and sessions. No guest-supplied authority.

mod access;
mod authority;
mod cache;
mod engine;
mod files;
mod io;
mod keys;
mod network;
mod observation;
mod output;
mod pool;
mod sessions;
#[cfg(test)]
mod tests;

use runner_rpc_proto::{Delivery, ErrorCode, Response, ResponseWriter};
use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

use crate::{http::HttpClient, ids::RunId, runner_process_identity::RunnerProcessIdentity};
use authority::{Authority, CredentialAuth, PreparedAuth, PreparedCredential, Trust};
use io::GuestIo;
use network::{Network, PublicNetwork};

const TERMINAL_RESERVE: Duration = Duration::from_secs(1);

/// Only allow-listed business codes cross the guest/log boundary.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum FailureReason {
    Unavailable,
    AuthorityFailure,
    InvalidCredential,
    UnsupportedCredential,
    CredentialResourceLimit,
    UnsafeDestination,
    NetworkFailure,
    HostKeyMismatch,
    UnsupportedHostKey,
    ConfigurationChanged,
    AuthenticationFailed,
    Protocol,
    ExecRejected,
    Disconnected,
    TimedOut,
    Cancelled,
    ResourceExhausted,
    Transport,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Params {
    ssh_connection_id: String,
    command: String,
}

struct ExecRequest {
    run: RunId,
    connection: uuid::Uuid,
    command: String,
}

pub(crate) struct SshRuntime {
    authority: Arc<Authority>,
    network: Arc<dyn Network>,
    cpu: Arc<Semaphore>,
    reports: Arc<Semaphore>,
    cache: cache::Cache,
    access_tls: Arc<rustls::ClientConfig>,
}

impl SshRuntime {
    pub(crate) fn ably_message(&self, message: &ably_subscriber::Message) -> bool {
        use api_contracts::generated::types::runners::ssh::InvalidateNotification;
        if message.name.as_deref() != Some("ssh-authority-invalidated") {
            return false;
        }
        if message.data.get("connectionId").is_none() {
            return true;
        }
        let Ok(notification) =
            serde_json::from_value::<InvalidateNotification>(message.data.clone())
        else {
            tracing::warn!("Invalid SSH authority invalidation notification");
            return true;
        };
        let Ok(run) = notification.run_id.parse::<RunId>() else {
            return true;
        };
        let connection = match notification.connection_id {
            Some(value) => match value.parse::<uuid::Uuid>() {
                Ok(connection) => Some(connection),
                Err(_) => return true,
            },
            None => None,
        };
        self.cache.invalidate(run, connection);
        true
    }

    pub(crate) fn official(
        http: HttpClient,
        token: &str,
        identity: RunnerProcessIdentity,
    ) -> Result<Option<Arc<Self>>, crate::error::RunnerError> {
        use api_contracts::generated::constants::runners::OFFICIAL_RUNNER_TOKEN_PREFIX;
        if !token.starts_with(OFFICIAL_RUNNER_TOKEN_PREFIX) {
            return Ok(None);
        }
        // The prefix only selects transport. Every API call authenticates the
        // actual fleet secret and exact current winning claim independently.
        let authority = Authority::new(http, token.to_owned(), identity).map_err(|_| {
            crate::error::RunnerError::Internal("SSH authority client initialization failed".into())
        })?;
        Ok(Some(Arc::new(Self {
            authority: Arc::new(authority),
            network: Arc::new(PublicNetwork),
            cpu: Arc::new(Semaphore::new(2)),
            reports: Arc::new(Semaphore::new(4)),
            cache: cache::Cache::new(),
            access_tls: access::tls_config().map_err(|_| {
                crate::error::RunnerError::Internal("SSH Access TLS initialization failed".into())
            })?,
        })))
    }

    pub(crate) fn for_run(self: &Arc<Self>, run: RunId, cancel: &CancellationToken) -> Arc<Run> {
        let registration = self.cache.register(run);
        Arc::new(Run {
            runtime: Arc::clone(self),
            sessions: sessions::Manager::new(Arc::clone(self), run, registration, cancel.clone()),
        })
    }

    async fn dispatch(
        self: Arc<Self>,
        args: crate::guest_rpc::Request,
        sessions: Arc<sessions::Manager>,
    ) {
        let crate::guest_rpc::Request {
            input,
            lease,
            run,
            started,
            deadline,
            cancelled,
            sandbox_cancelled,
            request,
        } = args;
        let mut scope = Scope {
            cancelled,
            sandbox_cancelled,
            deadline,
        };
        if matches!(
            request.method.as_str(),
            "ssh.file.upload" | "ssh.file.download"
        ) {
            files::dispatch(
                &self,
                &sessions,
                files::Dispatch {
                    input,
                    lease,
                    run,
                    scope,
                    started,
                    request,
                },
            )
            .await;
            return;
        }
        let mut writer = ResponseWriter::new(input);
        let Some(remaining) = request.remaining_ms.filter(|ms| *ms > 1000) else {
            send_generic(&scope, &mut writer, ErrorCode::InvalidRequest).await;
            return;
        };
        scope.deadline = scope
            .deadline
            .min(started + Duration::from_millis(remaining.min(60_000)));
        let work = Scope {
            deadline: scope.deadline - TERMINAL_RESERVE,
            ..scope.clone()
        };
        if request.method.starts_with("ssh.session.") {
            sessions
                .dispatch(
                    &request.method,
                    request.params.get(),
                    &work,
                    &scope,
                    &mut writer,
                )
                .await;
            return;
        }
        let params: Params = match serde_json::from_str(request.params.get()) {
            Ok(params) => params,
            Err(_) => {
                send_generic(&scope, &mut writer, ErrorCode::InvalidRequest).await;
                return;
            }
        };
        let connection = match uuid::Uuid::parse_str(&params.ssh_connection_id) {
            Ok(id) if params.ssh_connection_id.len() == 36 && params.command.len() <= 64 * 1024 => {
                id
            }
            _ => {
                send_generic(&scope, &mut writer, ErrorCode::InvalidRequest).await;
                return;
            }
        };
        let mut output = output::Output::default();
        let result = self
            .execute(
                Arc::clone(&lease),
                ExecRequest {
                    run,
                    connection,
                    command: params.command,
                },
                &work,
                &mut writer,
                &mut output,
                &sessions,
            )
            .await;
        let observation = output.connection.finish(result.as_ref().err().copied());
        let outcome = output.terminal(result);
        // A poisoned writer cannot emit a replacement terminal after partial I/O.
        let terminal_scope = Scope {
            cancelled: CancellationToken::new(),
            deadline: scope.deadline.min(Instant::now() + TERMINAL_RESERVE),
            ..scope
        };
        let delivered = terminal_scope
            .wait(output.finish(&mut writer, outcome))
            .await
            .is_ok_and(|result| result.is_ok());
        tracing::info!(run_id = %run, connection_id = %connection, outcome = output.outcome(), failure_reason = ?output.failure(), elapsed_ms = started.elapsed().as_millis() as u64,
            stdout_bytes = output.stdout_bytes(), stderr_bytes = output.stderr_bytes(), stdout_truncated = output.stdout_truncated(), stderr_truncated = output.stderr_truncated(), terminal_delivered = delivered, "SSH execution finished");
        // The guest sees its terminal and EOF before any diagnostic API I/O.
        drop(writer);
        drop(lease);
        if let Some(observation) = observation {
            if let Ok(_permit) = Arc::clone(&self.reports).try_acquire_owned() {
                self.authority.observe(run, connection, observation).await;
            } else {
                tracing::info!(run_id = %run, connection_id = %connection, "SSH observation report capacity exhausted");
            }
        }
    }

    async fn execute(
        &self,
        lease: Arc<OwnedSemaphorePermit>,
        request: ExecRequest,
        scope: &Scope,
        writer: &mut ResponseWriter<GuestIo>,
        output: &mut output::Output,
        sessions: &sessions::Manager,
    ) -> Result<output::RemoteExit, FailureReason> {
        let run = request.run;
        let connection = request.connection;
        let access = sessions.registration.lookup(connection)?;
        let result = async {
            let credential = scope
                .wait(access.prepare(self.prepare(
                    Arc::clone(&lease),
                    run,
                    connection,
                    scope,
                    &mut output.connection,
                )))
                .await??;
            output.connection.generation = Some(
                credential
                    .trust
                    .lock()
                    .map_err(|_| FailureReason::Protocol)?
                    .generation,
            );
            output.connection.connecting = true;
            let transport = sessions
                .pool
                .acquire(
                    self,
                    pool::Request {
                        connection,
                        credential: Arc::clone(&credential),
                        access: access.clone(),
                        operation: lease,
                    },
                    scope,
                    &mut output.connection,
                )
                .await?;
            let result = transport
                .connected()
                .execute(request.command, scope, writer, output)
                .await;
            if result.is_ok() {
                transport.reuse();
            }
            // TOFU advances trust during this attempt, before user authentication.
            output.connection.generation = Some(
                credential
                    .trust
                    .lock()
                    .map_err(|_| FailureReason::Protocol)?
                    .generation,
            );
            result
        }
        .await;
        if result.as_ref().is_err_and(|failure| {
            matches!(
                failure,
                FailureReason::Unavailable
                    | FailureReason::AuthorityFailure
                    | FailureReason::InvalidCredential
                    | FailureReason::UnsupportedCredential
                    | FailureReason::CredentialResourceLimit
                    | FailureReason::HostKeyMismatch
                    | FailureReason::UnsupportedHostKey
                    | FailureReason::ConfigurationChanged
                    | FailureReason::AuthenticationFailed
            )
        }) {
            access.invalidate();
        }
        result
    }

    async fn prepare(
        &self,
        lease: Arc<OwnedSemaphorePermit>,
        run: RunId,
        connection: uuid::Uuid,
        scope: &Scope,
        observation: &mut observation::Attempt,
    ) -> Result<PreparedCredential, FailureReason> {
        let credential = scope
            .wait(self.authority.resolve(run, connection))
            .await??;
        let (private_key, passphrase) = match credential.auth {
            CredentialAuth::PrivateKey {
                private_key,
                passphrase,
            } => (private_key, passphrase),
            CredentialAuth::Password(password) => {
                scope.check()?;
                observation.generation = Some(credential.generation);
                return Ok(PreparedCredential {
                    host: credential.host,
                    port: credential.port,
                    username: credential.username,
                    trust: Mutex::new(Trust {
                        generation: credential.generation,
                        pin: credential.pin,
                    }),
                    auth: PreparedAuth::Password(password),
                    transport: credential.transport,
                });
            }
        };
        let cpu = scope
            .wait(Arc::clone(&self.cpu).acquire_owned())
            .await?
            .map_err(|_| FailureReason::ResourceExhausted)?;
        let worker_scope = scope.clone();
        let generation = credential.generation;
        let worker_lease = Arc::clone(&lease);
        let worker = tokio::task::spawn_blocking(move || {
            let _permit = cpu;
            let _lease = worker_lease;
            worker_scope.check()?;
            let key = keys::decode(
                private_key.expose(),
                passphrase.as_ref().map(|value| value.expose()),
            )?;
            worker_scope.check()?;
            Ok::<_, FailureReason>(PreparedCredential {
                host: credential.host,
                port: credential.port,
                username: credential.username,
                trust: Mutex::new(Trust {
                    generation: credential.generation,
                    pin: credential.pin,
                }),
                auth: PreparedAuth::PrivateKey(key),
                transport: credential.transport,
            })
        });
        let result = scope
            .wait(worker)
            .await?
            .map_err(|_| FailureReason::InvalidCredential)?;
        observation.generation = Some(generation);
        result
    }

    async fn open_socket(
        &self,
        lease: Arc<io::HostLease>,
        host: &str,
        port: u16,
        scope: &Scope,
    ) -> Result<tokio::net::TcpStream, FailureReason> {
        // System DNS can own blocking resolver work after its waiter is dropped.
        // Retain host capacity until resolution completes, independently of
        // the guest stream and its park reservation.
        let network = Arc::clone(&self.network);
        let host = host.to_owned();
        let resolver_lease = Arc::clone(&lease);
        let resolver = tokio::spawn(async move {
            let _lease = resolver_lease;
            network::destination(network, &host, port).await
        });
        let address = scope
            .wait(resolver)
            .await?
            .map_err(|_| FailureReason::NetworkFailure)??;
        scope
            .wait(self.network.connect(address))
            .await?
            .map_err(|_| FailureReason::NetworkFailure)
    }
}

#[derive(Clone)]
struct Scope {
    cancelled: CancellationToken,
    sandbox_cancelled: CancellationToken,
    deadline: Instant,
}

impl Scope {
    fn check(&self) -> Result<(), FailureReason> {
        if self.cancelled.is_cancelled() || self.sandbox_cancelled.is_cancelled() {
            Err(FailureReason::Cancelled)
        } else if Instant::now() >= self.deadline {
            Err(FailureReason::TimedOut)
        } else {
            Ok(())
        }
    }
    async fn wait<T>(
        &self,
        future: impl std::future::Future<Output = T>,
    ) -> Result<T, FailureReason> {
        use futures_util::FutureExt;
        self.check()?;
        let mut future = std::pin::pin!(future);
        // Most tiny output fragments are already buffered. Avoid registering
        // timers and cancellation waiters for every immediately-ready fragment.
        // Keep the same pinned future if I/O blocks; partial writes never restart.
        if let Some(result) = future.as_mut().now_or_never() {
            return Ok(result);
        }
        tokio::select! { biased;
            () = self.cancelled.cancelled() => Err(FailureReason::Cancelled),
            () = self.sandbox_cancelled.cancelled() => Err(FailureReason::Cancelled),
            () = tokio::time::sleep_until(self.deadline) => Err(FailureReason::TimedOut),
            result = future => Ok(result),
        }
    }
}

/// SSH's run-local authority and sessions, independent of guest RPC admission.
pub(crate) struct Run {
    runtime: Arc<SshRuntime>,
    sessions: Arc<sessions::Manager>,
}

impl Run {
    pub(crate) fn close(&self) {
        self.sessions.registration.close();
    }

    pub(crate) fn prune(&self) {
        self.sessions.prune();
    }

    pub(crate) async fn shutdown(&self) {
        self.sessions.shutdown().await;
    }

    pub(crate) async fn dispatch(&self, request: crate::guest_rpc::Request) {
        Arc::clone(&self.runtime)
            .dispatch(request, Arc::clone(&self.sessions))
            .await;
    }
}

async fn send_generic(scope: &Scope, writer: &mut ResponseWriter<GuestIo>, code: ErrorCode) {
    let _ = scope
        .wait(writer.send(&Response::error(code, Delivery::NotDispatched)))
        .await;
}

pub(crate) fn safe_log_metadata(metadata: &tracing::Metadata<'_>) -> bool {
    ![
        "russh",
        "ssh_key",
        "ssh_cipher",
        "tungstenite",
        "tokio_tungstenite",
        "rustls",
        "tokio_rustls",
    ]
    .iter()
    .any(|prefix| {
        metadata.target() == *prefix
            || metadata
                .target()
                .strip_prefix(prefix)
                .is_some_and(|suffix| suffix.starts_with("::"))
    })
}
