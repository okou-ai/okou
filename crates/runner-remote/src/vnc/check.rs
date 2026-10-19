//! Initialize and close one normally admitted temporary session, without desktop IO.

use super::{Scope, protocol, sessions::Run};
use crate::diagnostics::trace::Progress;
use runner_rpc_proto::{Delivery, ErrorCode, Response, ResponseWriter};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

impl Run {
    pub(crate) async fn check(&self, args: crate::guest_rpc::Request) {
        let crate::guest_rpc::Request {
            input,
            lease,
            started,
            deadline,
            cancelled,
            sandbox_cancelled,
            request,
            ..
        } = args;
        let mut scope = Scope {
            cancelled,
            sandbox: sandbox_cancelled,
            session: CancellationToken::new(),
            native: Vec::new(),
            deadline,
        };
        let mut writer = ResponseWriter::new(input);
        let Some(remaining) = request.remaining_ms.filter(|ms| *ms > 1000) else {
            let _ = scope
                .wait(writer.send(&Response::error(
                    ErrorCode::InvalidRequest,
                    Delivery::NotDispatched,
                )))
                .await;
            return;
        };
        let Ok(params) = serde_json::from_str::<protocol::Start>(request.params.get()) else {
            let _ = scope
                .wait(writer.send(&Response::error(
                    ErrorCode::InvalidRequest,
                    Delivery::NotDispatched,
                )))
                .await;
            return;
        };
        scope.deadline = deadline.min(started + Duration::from_millis(remaining.min(60_000)))
            - Duration::from_secs(1);
        let Some(parent) = self.diagnostics_handle() else {
            let _ = scope
                .wait(writer.send(&Response::error(
                    ErrorCode::Unavailable,
                    Delivery::NotDispatched,
                )))
                .await;
            return;
        };
        let diagnostics = parent.check_scope();
        let (report, cleanup) = match self
            .start_observed(params, &scope, lease, Some(diagnostics), true)
            .await
        {
            Ok(session) => {
                let started = session.diagnostic_started();
                session.close();
                let result = scope.wait(session.closed.cancelled()).await;
                let cleanup = if result.is_ok() {
                    Progress::Passed
                } else {
                    Progress::Unknown
                };
                (
                    session.check_report(result.err(), cleanup, started),
                    cleanup,
                )
            }
            Err(failure) => (failure.report.map(|r| *r), Progress::Unknown),
        };
        let data = parent.finish_check(report, cleanup);
        if let Ok(data) = serde_json::value::to_raw_value(&data) {
            let _ = scope
                .terminal()
                .wait(writer.send(&Response::Result { data }))
                .await;
        }
    }
}
