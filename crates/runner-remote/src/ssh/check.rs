//! A fresh authenticated connection with no remote command or channel.

use super::{FailureReason, Run, Scope, TERMINAL_RESERVE, observation, pool};
use crate::diagnostics::{Cause, Operation, trace::Progress};
use runner_rpc_proto::{Delivery, ErrorCode, Response, ResponseWriter};
use serde::Deserialize;
use std::{sync::Arc, time::Duration};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Params {
    connection_id: uuid::Uuid,
}

impl Run {
    pub(crate) async fn check(&self, args: crate::guest_rpc::Request) {
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
        let mut writer = ResponseWriter::new(input);
        let mut scope = Scope {
            cancelled,
            sandbox_cancelled,
            deadline,
        };
        let params = serde_json::from_str::<Params>(request.params.get());
        let Some(remaining) = request.remaining_ms.filter(|ms| *ms > 1000) else {
            let _ = scope
                .wait(writer.send(&Response::error(
                    ErrorCode::InvalidRequest,
                    Delivery::NotDispatched,
                )))
                .await;
            return;
        };
        let Ok(params) = params else {
            let _ = scope
                .wait(writer.send(&Response::error(
                    ErrorCode::InvalidRequest,
                    Delivery::NotDispatched,
                )))
                .await;
            return;
        };
        scope.deadline = deadline.min(started + Duration::from_millis(remaining.min(60_000)));
        let work = Scope {
            deadline: scope.deadline - TERMINAL_RESERVE,
            ..scope.clone()
        };
        let parent = self.diagnostics();
        let diagnostics = parent.check_scope();
        let mut observation = observation::Attempt::new(&diagnostics);
        let mut cleanup = Progress::Unknown;
        let result = async {
            let access = self
                .sessions
                .registration
                .lookup(params.connection_id)?
                .with_diagnostics(diagnostics.clone());
            let credential = work
                .wait(access.prepare_session(self.runtime.prepare(
                    Arc::clone(&lease),
                    run,
                    params.connection_id,
                    &work,
                    &mut observation,
                )))
                .await??;
            observation.connecting = true;
            let transport = self
                .sessions
                .pool
                .acquire_fresh(
                    &self.runtime,
                    pool::Request {
                        connection: params.connection_id,
                        credential,
                        access,
                        operation: Arc::clone(&lease),
                    },
                    &work,
                    &mut observation,
                )
                .await?;
            let closed = transport.closed();
            drop(transport);
            work.wait(closed.cancelled()).await?;
            cleanup = Progress::Passed;
            Ok::<_, FailureReason>(())
        }
        .await;
        let report = observation.snapshot(
            &diagnostics,
            params.connection_id,
            Operation::ActiveCheck,
            None,
            result.err().map(Cause::Ssh),
        );
        // No observation API write and no lease reuse: this is check-owned work.
        let data = parent.finish_check(report, cleanup);
        let terminal = Scope {
            cancelled: CancellationToken::new(),
            deadline: scope.deadline.min(Instant::now() + TERMINAL_RESERVE),
            ..scope
        };
        if let Ok(data) = serde_json::value::to_raw_value(&data) {
            let _ = terminal.wait(writer.send(&Response::Result { data })).await;
        }
    }
}
