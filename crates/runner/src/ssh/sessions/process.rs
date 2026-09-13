use std::{sync::Arc, time::Duration};

use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf, client};
use tokio::{sync::mpsc, time::Instant};

use super::super::{
    FailureReason, Scope, SshRuntime, engine,
    observation::Attempt,
    output::{RemoteExit, Stream},
    pool,
};
use super::{
    Command, Entry, Input,
    protocol::{Effects, Program, Rejection, Response, Start, State},
};
use crate::ids::RunId;

pub(super) async fn run(
    runtime: Arc<SshRuntime>,
    pool: Arc<pool::Pool>,
    run: RunId,
    entry: Arc<Entry>,
    start: Start,
    receiver: mpsc::Receiver<Command>,
) {
    let mut observation = Attempt::default();
    let cancelled = entry.access.cancelled();
    let result = tokio::select! { biased;
        () = cancelled.cancelled() => Err(FailureReason::ConfigurationChanged),
        result = execute(&runtime, &pool, run, &entry, start, receiver, &mut observation) => result,
    };
    {
        let mut data = entry.data.lock().unwrap_or_else(|p| p.into_inner());
        data.generation = observation.generation;
        data.state = match result.as_ref() {
            Ok(exit) => {
                data.effects = Effects::Completed;
                State::Finished { exit: exit.clone() }
            }
            Err(reason) => State::Failed {
                failure_reason: *reason,
            },
        };
        data.completed = Some(Instant::now());
    }
    // This task owns no guest I/O. Diagnostic reporting never extends a park lease.
    if let Some(report) = observation.finish(result.err())
        && let Ok(_permit) = Arc::clone(&runtime.reports).try_acquire_owned()
    {
        runtime
            .authority
            .observe(run, entry.connection, report)
            .await;
    }
}

async fn execute(
    runtime: &SshRuntime,
    pool: &Arc<pool::Pool>,
    run: RunId,
    entry: &Entry,
    start: Start,
    receiver: mpsc::Receiver<Command>,
    observation: &mut Attempt,
) -> Result<RemoteExit, FailureReason> {
    let scope = &entry.scope;
    let setup = Scope {
        deadline: scope.deadline.min(Instant::now() + Duration::from_secs(60)),
        ..scope.clone()
    };
    entry.current()?;
    let credential = setup
        .wait(entry.access.prepare_session(runtime.prepare(
            Arc::clone(&entry.lease),
            run,
            entry.connection,
            &setup,
            observation,
        )))
        .await??;
    observation.generation = Some(
        credential
            .trust
            .lock()
            .map_err(|_| FailureReason::Protocol)?
            .generation,
    );
    entry
        .data
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .generation = observation.generation;
    observation.connecting = true;
    let connected = pool
        .acquire(
            runtime,
            pool::Request {
                connection: entry.connection,
                credential: Arc::clone(&credential),
                access: entry.access.clone(),
                operation: Arc::clone(&entry.lease),
                retained: true,
            },
            &setup,
            observation,
        )
        .await?;
    observation.generation = Some(
        credential
            .trust
            .lock()
            .map_err(|_| FailureReason::Protocol)?
            .generation,
    );
    entry
        .data
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .generation = observation.generation;
    let result = scope
        .wait(async {
            let mut channel = setup
                .wait(connected.connected().session.channel_open_session())
                .await?
                .map_err(|_| FailureReason::Protocol)?;
            if start.pty {
                setup
                    .wait(channel.request_pty(true, "xterm-256color", 80, 24, 0, 0, &[]))
                    .await?
                    .map_err(|_| FailureReason::Disconnected)?;
                acknowledgement(&mut channel, &setup).await?;
            }
            entry.current()?;
            entry.data.lock().unwrap_or_else(|p| p.into_inner()).effects = Effects::Unknown;
            let sent = match start.program {
                Program::Exec { command } => setup.wait(channel.exec(true, command)).await?,
                Program::Shell {} => setup.wait(channel.request_shell(true)).await?,
            };
            sent.map_err(|_| FailureReason::Disconnected)?;
            if let Err(reason) = acknowledgement(&mut channel, &setup).await {
                if reason == FailureReason::ExecRejected {
                    entry.data.lock().unwrap_or_else(|p| p.into_inner()).effects =
                        Effects::NotStarted;
                }
                return Err(reason);
            }
            entry.current()?;
            entry.data.lock().unwrap_or_else(|p| p.into_inner()).state = State::Running;
            let (reader, writer) = channel.split();
            // Keep draining the remote channel while stdin is flow-controlled.
            tokio::select! {
                result = read(entry, reader) => result,
                result = write(entry, writer, receiver) => result,
            }
        })
        .await
        .and_then(|result| result);
    if result.is_ok() {
        connected.reuse();
    }
    result
}

async fn acknowledgement(
    channel: &mut russh::Channel<client::Msg>,
    scope: &Scope,
) -> Result<(), FailureReason> {
    loop {
        match scope.wait(channel.wait()).await? {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::Failure) => return Err(FailureReason::ExecRejected),
            Some(ChannelMsg::WindowAdjusted { .. }) => (),
            Some(ChannelMsg::Close) | None => return Err(FailureReason::Disconnected),
            _ => return Err(FailureReason::Protocol),
        }
    }
}

async fn read(entry: &Entry, mut reader: ChannelReadHalf) -> Result<RemoteExit, FailureReason> {
    let mut exit = None;
    let mut eof = false;
    loop {
        match reader.wait().await {
            Some(ChannelMsg::Data { data }) if !eof => entry
                .data
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .output
                .append(Stream::Stdout, &data)?,
            Some(ChannelMsg::ExtendedData { ext: 1, data }) if !eof => entry
                .data
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .output
                .append(Stream::Stderr, &data)?,
            Some(ChannelMsg::ExitStatus { exit_status }) if exit.is_none() => {
                exit = Some(RemoteExit::Status { code: exit_status })
            }
            Some(ChannelMsg::ExitSignal {
                signal_name,
                core_dumped,
                ..
            }) if exit.is_none() => {
                exit = Some(RemoteExit::Signal {
                    signal: engine::signal(&signal_name),
                    core_dumped,
                })
            }
            Some(ChannelMsg::Eof) if !eof => eof = true,
            Some(ChannelMsg::WindowAdjusted { .. }) => (),
            Some(ChannelMsg::Close) => return exit.ok_or(FailureReason::Disconnected),
            None => return Err(FailureReason::Disconnected),
            _ => return Err(FailureReason::Protocol),
        }
    }
}

async fn write(
    entry: &Entry,
    writer: ChannelWriteHalf<client::Msg>,
    mut receiver: mpsc::Receiver<Command>,
) -> Result<RemoteExit, FailureReason> {
    while let Some(command) = receiver.recv().await {
        if command.reply.is_closed() {
            continue;
        }
        if let Err(reason) = command.scope.check().and_then(|()| entry.current()) {
            let _ = command
                .reply
                .send(Response::failed(reason, Effects::NotStarted));
            continue;
        }
        if matches!(&command.input, Input::Write { .. })
            && entry
                .data
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .stdin_closed
        {
            let _ = command.reply.send(Response::Rejected {
                reason: Rejection::StdinClosed,
            });
            continue;
        }
        let result = command
            .scope
            .wait(async {
                match command.input {
                    Input::Write { bytes, eof } => {
                        if !bytes.is_empty() {
                            writer.data_bytes(bytes).await?;
                        }
                        if eof {
                            writer.eof().await?;
                            entry
                                .data
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .stdin_closed = true;
                        }
                        Ok(())
                    }
                    Input::Signal(signal) => writer.signal(signal.remote()).await,
                }
            })
            .await
            .and_then(|result| result.map_err(|_| FailureReason::Disconnected));
        match result {
            Ok(()) => {
                let _ = command.reply.send(Response::Submitted {
                    session_id: entry.id,
                    effects: Effects::Unknown,
                });
            }
            Err(reason) => {
                let _ = command
                    .reply
                    .send(Response::failed(reason, Effects::Unknown));
                // Do not leave a partially written input available for a later retry.
                return Err(reason);
            }
        }
    }
    Err(FailureReason::Cancelled)
}
