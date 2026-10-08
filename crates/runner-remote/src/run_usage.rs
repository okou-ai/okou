//! Current-assignment provider-token observations composed at query time.

use std::{future::Future, io, sync::Arc, time::Duration};

use runner_rpc_proto::{Delivery, ErrorCode, Response, ResponseWriter};
use runner_types::{ids::RunId, types::ExecutionContext};
use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::guest_rpc;
use runner_network::proxy::{
    CoverageReason, MitmRunUsage, MitmUsageHandle, RunUsageObservation, TokenTotals,
};

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const TERMINAL_RESERVE: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub struct Runtime {
    mitm: MitmUsageHandle,
}

impl Runtime {
    pub fn new(mitm: MitmUsageHandle) -> Self {
        Self { mitm }
    }

    pub(crate) fn for_context(&self, context: &ExecutionContext) -> Arc<Run> {
        Arc::new(Run {
            run_id: context.run_id,
            mitm: self.mitm.for_run(context.run_id),
        })
    }
}

pub(crate) struct Run {
    run_id: RunId,
    mitm: MitmRunUsage,
}

impl Run {
    async fn snapshot(&self) -> ResultDto {
        let sandbox_proxy = sandbox_proxy_source(self.mitm.snapshot().await);
        ResultDto {
            schema_version: 1,
            run_id: self.run_id,
            combined: combine(&sandbox_proxy),
            sources: Sources { sandbox_proxy },
        }
    }

    pub(crate) async fn dispatch(&self, request: guest_rpc::Request) {
        let guest_rpc::Request {
            input,
            lease,
            run: _,
            started,
            deadline,
            cancelled,
            sandbox_cancelled,
            request,
        } = request;
        let _lease = lease;
        let mut writer = ResponseWriter::new(input);
        let Some(remaining) = request.remaining_ms.filter(|remaining| *remaining > 1000) else {
            send_error(
                &mut writer,
                &cancelled,
                &sandbox_cancelled,
                deadline,
                ErrorCode::InvalidRequest,
            )
            .await;
            return;
        };
        let deadline = deadline.min(started + Duration::from_millis(remaining.min(60_000)));
        if serde_json::from_str::<Empty>(request.params.get()).is_err() {
            send_error(
                &mut writer,
                &cancelled,
                &sandbox_cancelled,
                deadline,
                ErrorCode::InvalidRequest,
            )
            .await;
            return;
        }
        let Some(result) = wait(
            &cancelled,
            &sandbox_cancelled,
            deadline - TERMINAL_RESERVE,
            self.snapshot(),
        )
        .await
        else {
            return;
        };
        let Ok(data) = serde_json::value::to_raw_value(&result) else {
            return;
        };
        let _ = wait(
            &cancelled,
            &sandbox_cancelled,
            deadline,
            writer.send(&Response::Result { data }),
        )
        .await;
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

async fn wait<T>(
    cancelled: &CancellationToken,
    sandbox_cancelled: &CancellationToken,
    deadline: Instant,
    future: impl Future<Output = T>,
) -> Option<T> {
    tokio::select! {
        biased;
        () = cancelled.cancelled() => None,
        () = sandbox_cancelled.cancelled() => None,
        () = tokio::time::sleep_until(deadline) => None,
        value = future => Some(value),
    }
}

async fn send_error(
    writer: &mut ResponseWriter<Box<dyn sandbox::GuestRpcStream>>,
    cancelled: &CancellationToken,
    sandbox_cancelled: &CancellationToken,
    deadline: Instant,
    code: ErrorCode,
) {
    let _ = wait(
        cancelled,
        sandbox_cancelled,
        deadline,
        writer.send(&Response::error(code, Delivery::NotDispatched)),
    )
    .await;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Coverage {
    Complete,
    Partial,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
enum SandboxProxySource {
    Unavailable {
        reason: SandboxUnavailableReason,
    },
    Observed {
        #[serde(rename = "sampledAtMs")]
        sampled_at_ms: u64,
        revision: u64,
        coverage: Coverage,
        reasons: Vec<CoverageReason>,
        #[serde(rename = "observedResponses")]
        observed_responses: u64,
        #[serde(rename = "outstandingResponses")]
        outstanding_responses: u64,
        tokens: TokenTotals,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum SandboxUnavailableReason {
    NotObserved,
    LaunchUnavailable,
    Busy,
    TimedOut,
    InvalidResponse,
    Transport,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
enum Combined {
    Observed {
        coverage: Coverage,
        #[serde(rename = "observedTokens")]
        observed_tokens: TokenTotals,
    },
    Unavailable {
        reason: CombinedUnavailableReason,
    },
    Overflow {
        coverage: Coverage,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum CombinedUnavailableReason {
    NoObservation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Sources {
    sandbox_proxy: SandboxProxySource,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultDto {
    schema_version: u8,
    run_id: RunId,
    combined: Combined,
    sources: Sources,
}

fn sandbox_proxy_source(snapshot: io::Result<RunUsageObservation>) -> SandboxProxySource {
    match snapshot {
        Ok(RunUsageObservation::Available(snapshot)) => SandboxProxySource::Observed {
            sampled_at_ms: snapshot.sampled_at_ms,
            revision: snapshot.revision,
            coverage: if snapshot.complete {
                Coverage::Complete
            } else {
                Coverage::Partial
            },
            reasons: snapshot.reasons,
            observed_responses: snapshot.observed_responses,
            outstanding_responses: snapshot.outstanding_responses,
            tokens: snapshot.totals,
        },
        Ok(RunUsageObservation::Unavailable { .. }) => SandboxProxySource::Unavailable {
            reason: SandboxUnavailableReason::NotObserved,
        },
        Err(error) => SandboxProxySource::Unavailable {
            reason: match error.kind() {
                io::ErrorKind::NotConnected => SandboxUnavailableReason::LaunchUnavailable,
                io::ErrorKind::WouldBlock => SandboxUnavailableReason::Busy,
                io::ErrorKind::TimedOut => SandboxUnavailableReason::TimedOut,
                io::ErrorKind::InvalidData => SandboxUnavailableReason::InvalidResponse,
                _ => SandboxUnavailableReason::Transport,
            },
        },
    }
}

#[cfg(test)]
pub(crate) fn test_run(run_id: RunId) -> Arc<Run> {
    let (proxy, _crash_rx) = runner_network::proxy::MitmProxy::noop();
    Arc::new(Run {
        run_id,
        mitm: MitmUsageHandle::from(&proxy).for_run(run_id),
    })
}

fn combine(sandbox: &SandboxProxySource) -> Combined {
    let SandboxProxySource::Observed {
        coverage, tokens, ..
    } = sandbox
    else {
        return Combined::Unavailable {
            reason: CombinedUnavailableReason::NoObservation,
        };
    };
    if [
        tokens.input,
        tokens.cache_read,
        tokens.cache_creation,
        tokens.output,
        tokens.total,
    ]
    .into_iter()
    .any(|value| value > MAX_SAFE_INTEGER)
    {
        return Combined::Overflow {
            coverage: *coverage,
        };
    }
    Combined::Observed {
        coverage: *coverage,
        observed_tokens: tokens.clone(),
    }
}

#[cfg(test)]
mod tests;
