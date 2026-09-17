//! Non-consuming progress waits; the remote process never belongs to its reader.

use std::time::Duration;

use runner_rpc_proto::ErrorCode;
use tokio::time::Instant;

use super::{Effects, FailureReason, Manager, Response, State, buffer, protocol};

impl Manager {
    pub(super) async fn read(&self, params: protocol::Read) -> Result<Response, ErrorCode> {
        if params.wait_ms > 30_000
            || !(1..=buffer::READ_BYTES).contains(&params.max_bytes)
            || !(1..=buffer::READ_CHUNKS).contains(&params.max_chunks)
        {
            return Err(ErrorCode::InvalidRequest);
        }
        let Some(entry) = self.get(params.session_id) else {
            return Ok(Response::failed(
                FailureReason::Unavailable,
                Effects::NotStarted,
            ));
        };
        let deadline = Instant::now() + Duration::from_millis(params.wait_ms);
        let invalidated = entry.access.cancelled();
        let mut permit = None;
        loop {
            // notify_waiters covers futures created before publication, including
            // ones not yet polled. Register before observing the same data lock.
            let changed = entry.changed.notified();
            if !entry.authorized() {
                return Ok(Response::failed(
                    FailureReason::Unavailable,
                    Effects::NotStarted,
                ));
            }
            {
                let data = entry.data.lock().unwrap_or_else(|p| p.into_inner());
                if params.cursor > data.output.end {
                    return Err(ErrorCode::InvalidRequest);
                }
                let terminal = matches!(data.state, State::Finished { .. } | State::Failed { .. });
                let progress = params.cursor < data.output.end;
                let expired = Instant::now() >= deadline;
                if progress || terminal || expired {
                    return Ok(Response::Read {
                        session: entry.info(&data),
                        wait_expired: params.wait_ms > 0 && expired && !progress && !terminal,
                        output: data
                            .output
                            .read(params.cursor, params.max_bytes, params.max_chunks)
                            .map_err(|_| ErrorCode::Protocol)?,
                    });
                }
            }
            if permit.is_none() {
                let Ok(admitted) = self.waiting_readers.try_acquire() else {
                    return Ok(Response::failed(
                        FailureReason::ResourceExhausted,
                        Effects::NotStarted,
                    ));
                };
                permit = Some(admitted);
            }
            // The outer RPC scope also owns Run/sandbox cancellation and its
            // deadline. Dropping this wait never cancels entry.scope.
            tokio::select! {
                biased;
                () = entry.scope.cancelled.cancelled() => (),
                () = invalidated.cancelled() => (),
                () = changed => (),
                () = tokio::time::sleep_until(deadline) => (),
            }
        }
    }
}
