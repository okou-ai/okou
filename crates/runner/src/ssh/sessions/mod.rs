//! Run-local processes. Records, host work and short guest RPCs have separate owners.

mod buffer;
mod process;
mod protocol;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::Engine;
use runner_rpc_proto::{ErrorCode, ResponseWriter};
use serde::{Deserialize, de::DeserializeOwned};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot},
    time::Instant,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use uuid::Uuid;

use super::{
    FailureReason, Scope, SshRuntime,
    cache::{Access, Registration},
    io::GuestIo,
};
use crate::ids::RunId;
use protocol::{Effects, Info, Rejection, Response, State};

const CAPACITY: usize = 8;
const LIFETIME: Duration = Duration::from_secs(2 * 60 * 60);
const RETENTION: Duration = Duration::from_secs(5 * 60);
const INPUT_BYTES: usize = 16 * 1024;

pub(super) struct Manager {
    runtime: Arc<SshRuntime>,
    run: RunId,
    pub(super) registration: Arc<Registration>,
    pub(super) pool: Arc<super::pool::Pool>,
    cancel: CancellationToken,
    capacity: Arc<Semaphore>,
    entries: Mutex<HashMap<Uuid, Arc<Entry>>>,
    tasks: TaskTracker,
}

struct Entry {
    id: Uuid,
    connection: Uuid,
    scope: Scope,
    access: Access,
    lease: Arc<OwnedSemaphorePermit>,
    commands: mpsc::Sender<Command>,
    data: Mutex<Data>,
}

struct Data {
    state: State,
    effects: Effects,
    generation: Option<i64>,
    stdin_closed: bool,
    completed: Option<Instant>,
    output: buffer::Buffer,
}

enum Input {
    Write { bytes: Vec<u8>, eof: bool },
    Signal(protocol::SignalName),
}

struct Command {
    input: Input,
    scope: Scope,
    reply: oneshot::Sender<Response>,
}

impl Entry {
    fn info(&self, data: &Data) -> Info {
        Info {
            session_id: self.id,
            ssh_connection_id: self.connection,
            generation: data.generation,
            state: data.state.clone(),
            effects: data.effects,
            stdin_closed: data.stdin_closed,
            oldest_cursor: data.output.oldest(),
            end_cursor: data.output.end,
        }
    }

    fn current(&self) -> Result<(), FailureReason> {
        self.scope.check()?;
        self.access.check()
    }

    fn authorized(&self) -> bool {
        // The process deadline ends execution; its result still has the normal
        // retention window while the Run and authority remain current.
        !self.scope.cancelled.is_cancelled()
            && !self.scope.sandbox_cancelled.is_cancelled()
            && self.access.check().is_ok()
    }
}

impl Manager {
    pub(super) fn new(
        runtime: Arc<SshRuntime>,
        run: RunId,
        registration: Arc<Registration>,
        cancel: CancellationToken,
    ) -> Arc<Self> {
        Arc::new(Self {
            runtime,
            run,
            registration,
            pool: super::pool::Pool::new(run, cancel.clone()),
            cancel,
            capacity: Arc::new(Semaphore::new(CAPACITY)),
            entries: Mutex::new(HashMap::new()),
            tasks: TaskTracker::new(),
        })
    }

    pub(super) fn prune(&self) {
        self.pool.prune();
        let now = Instant::now();
        self.entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|_, entry| {
                let expired = !entry.authorized()
                    || entry
                        .data
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .completed
                        .is_some_and(|at| now.duration_since(at) >= RETENTION);
                if expired {
                    entry.scope.cancelled.cancel();
                }
                !expired
            });
    }

    pub(super) async fn shutdown(&self) {
        self.cancel.cancel();
        self.tasks.close();
        self.tasks.wait().await;
        self.pool.shutdown().await;
        self.entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }

    fn get(&self, id: Uuid) -> Option<Arc<Entry>> {
        self.entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&id)
            .filter(|entry| entry.authorized())
            .cloned()
    }

    fn start(&self, params: protocol::Start, scope: &Scope) -> Response {
        let result = (|| {
            scope.check()?;
            let permit = Arc::clone(&self.capacity)
                .try_acquire_owned()
                .map_err(|_| FailureReason::ResourceExhausted)?;
            let access = self.registration.session_access(params.ssh_connection_id)?;
            let (commands, receiver) = mpsc::channel(CAPACITY);
            let entry = Arc::new(Entry {
                id: Uuid::new_v4(),
                connection: params.ssh_connection_id,
                scope: Scope {
                    cancelled: self.cancel.child_token(),
                    sandbox_cancelled: scope.sandbox_cancelled.clone(),
                    deadline: Instant::now() + LIFETIME,
                },
                access,
                lease: Arc::new(permit),
                commands,
                data: Mutex::new(Data {
                    state: State::Starting,
                    effects: Effects::NotStarted,
                    generation: None,
                    stdin_closed: false,
                    completed: None,
                    output: buffer::Buffer::default(),
                }),
            });
            entry.current()?;
            self.entries
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(entry.id, Arc::clone(&entry));
            let id = entry.id;
            let runtime = Arc::clone(&self.runtime);
            let pool = Arc::clone(&self.pool);
            let run = self.run;
            self.tasks.spawn(async move {
                process::run(runtime, pool, run, entry, params, receiver).await;
            });
            Ok(id)
        })();
        match result {
            Ok(session_id) => Response::Started { session_id },
            Err(reason) => Response::failed(reason, Effects::NotStarted),
        }
    }

    async fn input(&self, id: Uuid, input: Input, scope: &Scope) -> Response {
        let Some(entry) = self.get(id) else {
            return Response::failed(FailureReason::Unavailable, Effects::NotStarted);
        };
        {
            let data = entry.data.lock().unwrap_or_else(|p| p.into_inner());
            if !matches!(data.state, State::Running) {
                return Response::Rejected {
                    reason: Rejection::NotRunning,
                };
            }
        }
        let (reply, received) = oneshot::channel();
        if let Err(error) = entry.commands.try_send(Command {
            input,
            scope: scope.clone(),
            reply,
        }) {
            let reason = match error {
                mpsc::error::TrySendError::Full(_) => FailureReason::ResourceExhausted,
                mpsc::error::TrySendError::Closed(_) => FailureReason::Disconnected,
            };
            return Response::failed(reason, Effects::NotStarted);
        }
        // Losing an acknowledgement after queue submission must never imply replay is safe.
        match scope.wait(received).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => Response::failed(FailureReason::Disconnected, Effects::Unknown),
            Err(reason) => Response::failed(reason, Effects::Unknown),
        }
    }

    async fn handle(&self, method: &str, raw: &str, scope: &Scope) -> Result<Response, ErrorCode> {
        self.prune();
        match method {
            "ssh.session.start" => {
                let params: protocol::Start = parse(raw)?;
                if matches!(&params.program, protocol::Program::Exec { command } if command.is_empty() || command.len() > 65536)
                {
                    return Err(ErrorCode::InvalidRequest);
                }
                Ok(self.start(params, scope))
            }
            "ssh.session.list" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Empty {}
                let _: Empty = parse(raw)?;
                let entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
                let sessions = entries
                    .values()
                    .filter(|entry| entry.authorized())
                    .map(|entry| entry.info(&entry.data.lock().unwrap_or_else(|p| p.into_inner())))
                    .collect();
                Ok(Response::Sessions { sessions })
            }
            "ssh.session.read" => {
                let params: protocol::Read = parse(raw)?;
                let Some(entry) = self.get(params.session_id) else {
                    return Ok(Response::failed(
                        FailureReason::Unavailable,
                        Effects::NotStarted,
                    ));
                };
                let data = entry.data.lock().unwrap_or_else(|p| p.into_inner());
                if params.cursor > data.output.end {
                    return Err(ErrorCode::InvalidRequest);
                }
                Ok(Response::Read {
                    session: entry.info(&data),
                    output: data
                        .output
                        .read(params.cursor)
                        .map_err(|_| ErrorCode::Protocol)?,
                })
            }
            "ssh.session.status" => {
                let params: protocol::Id = parse(raw)?;
                let Some(entry) = self.get(params.session_id) else {
                    return Ok(Response::failed(
                        FailureReason::Unavailable,
                        Effects::NotStarted,
                    ));
                };
                let data = entry.data.lock().unwrap_or_else(|p| p.into_inner());
                Ok(Response::Status {
                    session: entry.info(&data),
                })
            }
            "ssh.session.write" => {
                let params: protocol::Write = parse(raw)?;
                if params.data_base64.len() > INPUT_BYTES.div_ceil(3) * 4 {
                    return Err(ErrorCode::InvalidRequest);
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(&params.data_base64)
                    .map_err(|_| ErrorCode::InvalidRequest)?;
                if bytes.len() > INPUT_BYTES
                    || (bytes.is_empty() && !params.eof)
                    || base64::engine::general_purpose::STANDARD.encode(&bytes)
                        != params.data_base64
                {
                    return Err(ErrorCode::InvalidRequest);
                }
                Ok(self
                    .input(
                        params.session_id,
                        Input::Write {
                            bytes,
                            eof: params.eof,
                        },
                        scope,
                    )
                    .await)
            }
            "ssh.session.signal" => {
                let params: protocol::Signal = parse(raw)?;
                Ok(self
                    .input(params.session_id, Input::Signal(params.signal), scope)
                    .await)
            }
            "ssh.session.close" => {
                let params: protocol::Id = parse(raw)?;
                let Some(entry) = self
                    .entries
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&params.session_id)
                else {
                    return Ok(Response::failed(
                        FailureReason::Unavailable,
                        Effects::NotStarted,
                    ));
                };
                entry.scope.cancelled.cancel();
                let effects = entry.data.lock().unwrap_or_else(|p| p.into_inner()).effects;
                Ok(Response::Closed {
                    session_id: entry.id,
                    effects,
                })
            }
            _ => Err(ErrorCode::UnknownMethod),
        }
    }

    pub(super) async fn dispatch(
        &self,
        method: &str,
        raw: &str,
        scope: &Scope,
        terminal: &Scope,
        writer: &mut ResponseWriter<GuestIo>,
    ) {
        let response = match scope.wait(self.handle(method, raw, scope)).await {
            Ok(Ok(data)) => serde_json::value::to_raw_value(&data)
                .map(|data| runner_rpc_proto::Response::Result { data })
                .unwrap_or_else(|_| {
                    runner_rpc_proto::Response::error(
                        ErrorCode::Protocol,
                        runner_rpc_proto::Delivery::Unknown,
                    )
                }),
            Ok(Err(code)) => {
                runner_rpc_proto::Response::error(code, runner_rpc_proto::Delivery::NotDispatched)
            }
            Err(reason) => {
                let Ok(data) =
                    serde_json::value::to_raw_value(&Response::failed(reason, Effects::Unknown))
                else {
                    return;
                };
                runner_rpc_proto::Response::Result { data }
            }
        };
        let terminal = Scope {
            cancelled: CancellationToken::new(),
            deadline: terminal
                .deadline
                .min(Instant::now() + super::TERMINAL_RESERVE),
            ..terminal.clone()
        };
        let _ = terminal.wait(writer.send(&response)).await;
    }
}

fn parse<T: DeserializeOwned>(raw: &str) -> Result<T, ErrorCode> {
    serde_json::from_str(raw).map_err(|_| ErrorCode::InvalidRequest)
}
