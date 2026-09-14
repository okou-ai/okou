//! Runner-owned binary file RPCs on the existing verified SSH transport.

mod codec;
mod protocol;
mod sftp;
mod transfer;

use runner_rpc_proto::{
    Delivery, ErrorCode, Response,
    stream::{Frame, MAX_DURATION_MS, MAX_STREAM_BYTES, Reader, Writer},
};
use russh::ChannelMsg;
use std::{sync::Arc, time::Duration};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

use super::{FailureReason, Scope, SshRuntime, io::GuestIo, observation::Attempt, pool, sessions};
use crate::ids::RunId;
use protocol::{Direction, Effects, Failure, FileFailure, Outcome, Request};

pub(super) fn capacity() -> Arc<Semaphore> {
    Arc::new(Semaphore::new(protocol::CAPACITY))
}

pub(super) struct Dispatch {
    pub(super) input: GuestIo,
    pub(super) lease: Arc<OwnedSemaphorePermit>,
    pub(super) run: RunId,
    pub(super) scope: Scope,
    pub(super) started: Instant,
    pub(super) request: runner_rpc_proto::Request,
}

pub(super) async fn dispatch(runtime: &SshRuntime, sessions: &sessions::Manager, args: Dispatch) {
    let Dispatch {
        input,
        lease,
        run,
        mut scope,
        started,
        request,
    } = args;
    let (read, write) = tokio::io::split(input);
    let mut input = Reader::input(read);
    let mut output = Writer::responses(write);
    let parsed = Request::parse(&request.method, request.params.get());
    let (Some(request), Some(remaining)) = (parsed, request.remaining_ms.filter(|ms| *ms > 2000))
    else {
        let _ = scope
            .wait(output.send(&Frame::Control(Response::Error {
                code: ErrorCode::InvalidRequest,
                delivery: Delivery::NotDispatched,
            })))
            .await;
        return;
    };
    let setup_deadline = scope.deadline;
    scope.deadline = started + Duration::from_millis(remaining.min(MAX_DURATION_MS));
    let work = Scope {
        deadline: scope.deadline - Duration::from_secs(2),
        ..scope.clone()
    };
    let setup = Scope {
        deadline: work.deadline.min(setup_deadline),
        ..work.clone()
    };
    let mut outcome = Outcome::new(&request);
    let mut observation = Attempt::default();
    let permit = Arc::clone(&sessions.file_transfers).try_acquire_owned();
    let result: Result<(), Failure> = async {
        let _permit = permit.map_err(|_| FileFailure::TransferLimit)?;
        if request.size.is_some_and(|size| size > MAX_STREAM_BYTES) {
            return Err(FileFailure::FileTooLarge.into());
        }
        let access = sessions.registration.session_access(request.connection)?;
        let invalidated = access.cancelled();
        let operation = async {
            let credential = setup
                .wait(access.prepare(runtime.prepare(
                    Arc::clone(&lease),
                    run,
                    request.connection,
                    &setup,
                    &mut observation,
                )))
                .await??;
            observation.connecting = true;
            let transport = sessions
                .pool
                .acquire(
                    runtime,
                    pool::Request {
                        connection: request.connection,
                        credential: Arc::clone(&credential),
                        access: access.clone(),
                        operation: Arc::clone(&lease),
                        retained: true,
                    },
                    &setup,
                    &mut observation,
                )
                .await?;
            observation.generation = Some(
                credential
                    .trust
                    .lock()
                    .map_err(|_| FailureReason::Protocol)?
                    .generation,
            );
            let mut channel = setup
                .wait(transport.connected().session.channel_open_session())
                .await?
                .map_err(|_| FailureReason::Disconnected)?;
            setup
                .wait(channel.request_subsystem(true, "sftp"))
                .await?
                .map_err(|_| FailureReason::Disconnected)?;
            loop {
                match setup.wait(channel.wait()).await? {
                    Some(ChannelMsg::Success) => break,
                    Some(ChannelMsg::WindowAdjusted { .. }) => {}
                    Some(ChannelMsg::Failure) => {
                        return Err(FileFailure::SubsystemUnavailable.into());
                    }
                    _ => return Err(FailureReason::Protocol.into()),
                }
            }
            let mut client = setup
                .wait(sftp::Client::init(channel.into_stream()))
                .await??;
            let mut staging = transfer::Staging::default();
            let result = work
                .wait(transfer::run(
                    &request,
                    &mut client,
                    &mut input,
                    &mut output,
                    &mut outcome,
                    &mut staging,
                ))
                .await;
            // Work timeout still leaves a small bounded cleanup window. Revoked
            // authority/Run cancellation instead drops the transport immediately.
            let cleanup = Scope {
                deadline: scope.deadline - Duration::from_millis(200),
                ..scope.clone()
            };
            let _ = cleanup
                .wait(staging.cleanup(&mut client, &mut outcome))
                .await;
            // This lease is always retired, never pooled after SFTP.
            result?
        };
        let result = tokio::select! {
            biased;
            () = invalidated.cancelled() => Err(FailureReason::ConfigurationChanged.into()),
            result = operation => result,
        };
        if matches!(
            result,
            Err(Failure::Ssh(
                FailureReason::AuthenticationFailed
                    | FailureReason::HostKeyMismatch
                    | FailureReason::UnsupportedHostKey
                    | FailureReason::ConfigurationChanged
            ))
        ) {
            access.invalidate();
        }
        result
    }
    .await;
    match result {
        Ok(()) => outcome.kind = "completed",
        Err(_) if outcome.effects == Effects::Completed => outcome.kind = "completed",
        Err(failure) => outcome.failure_reason = Some(failure),
    }
    let report = observation.finish(match outcome.failure_reason {
        Some(Failure::Ssh(reason)) => Some(reason),
        _ => None,
    });
    let terminal = Scope {
        cancelled: CancellationToken::new(),
        deadline: scope
            .deadline
            .min(Instant::now() + Duration::from_millis(200)),
        ..scope
    };
    let _ = terminal
        .wait(async {
            if request.direction == Direction::Download {
                output.send(&Frame::End).await?;
            }
            let value = serde_json::value::to_raw_value(&outcome).map_err(std::io::Error::other)?;
            output
                .send(&Frame::Control(Response::Result { data: value }))
                .await?;
            // Half-close the reply, then drain pending input within this same
            // reporting budget. Dropping an unread Unix/vsock receive queue
            // immediately can reset the bridge before its reply reaches the
            // guest. The helper stops input once it sees the terminal + EOF.
            while let Ok(Some(_)) = input.next().await {}
            Ok::<_, std::io::Error>(())
        })
        .await;
    drop(input);
    drop(output);
    drop(lease);
    if let Some(report) = report
        && let Ok(_permit) = Arc::clone(&runtime.reports).try_acquire_owned()
    {
        runtime
            .authority
            .observe(run, request.connection, report)
            .await;
    }
}
