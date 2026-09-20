//! Current-assignment provider-token observations composed at query time.

use std::{future::Future, io, sync::Arc, time::Duration};

use runner_rpc_proto::{Delivery, ErrorCode, Response, ResponseWriter};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::{
    guest_rpc,
    ids::RunId,
    proxy::{CoverageReason, MitmRunUsage, MitmUsageHandle, RunUsageObservation, TokenTotals},
    types::ExecutionContext,
};

const FEATURE_SWITCH: &str = "runUsage";
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const TERMINAL_RESERVE: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub(crate) struct Runtime {
    mitm: MitmUsageHandle,
}

impl Runtime {
    pub(crate) fn new(mitm: MitmUsageHandle) -> Self {
        Self { mitm }
    }

    pub(crate) fn for_context(&self, context: &ExecutionContext) -> Option<Arc<Run>> {
        let enabled = context
            .feature_flags
            .as_ref()
            .and_then(|flags| flags.get(FEATURE_SWITCH))
            .copied()
            .unwrap_or(false);
        enabled.then(|| {
            Arc::new(Run {
                run_id: context.run_id,
                api: capture_api_source(context.pi_launch_config.as_ref()),
                mitm: self.mitm.for_run(context.run_id),
            })
        })
    }
}

pub(crate) struct Run {
    run_id: RunId,
    api: ApiFirstTurnSource,
    mitm: MitmRunUsage,
}

impl Run {
    async fn snapshot(&self) -> ResultDto {
        let sandbox_proxy = sandbox_proxy_source(self.mitm.snapshot().await);
        ResultDto {
            schema_version: 1,
            run_id: self.run_id,
            combined: combine(&self.api, &sandbox_proxy),
            sources: Sources {
                api_first_turn: self.api.clone(),
                sandbox_proxy,
            },
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
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiTokens {
    input: Option<u64>,
    cache_read: Option<u64>,
    cache_creation: Option<u64>,
    output: Option<u64>,
    total: Option<u64>,
}

impl ApiTokens {
    fn from_handoff(tokens: HandoffTokens) -> Self {
        let [input, cache_read, cache_creation, output] = tokens.values();
        let total = [input, cache_read, cache_creation, output]
            .into_iter()
            .try_fold(0_u64, |sum, value| sum.checked_add(value?))
            .filter(|total| *total <= MAX_SAFE_INTEGER);
        Self {
            input,
            cache_read,
            cache_creation,
            output,
            total,
        }
    }

    fn values(&self) -> [Option<u64>; 4] {
        [
            self.input,
            self.cache_read,
            self.cache_creation,
            self.output,
        ]
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
enum ApiFirstTurnSource {
    Unavailable {
        reason: ApiUnavailableReason,
    },
    NoInference {
        #[serde(rename = "sampledAt")]
        sampled_at: u64,
    },
    Observed {
        #[serde(rename = "sampledAt")]
        sampled_at: u64,
        coverage: Coverage,
        tokens: ApiTokens,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ApiUnavailableReason {
    MissingHandoff,
    InvalidHandoff,
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
    api_first_turn: ApiFirstTurnSource,
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

#[derive(Deserialize)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum HandoffUsage {
    NoInference {
        schema_version: u8,
        sampled_at: u64,
    },
    Observed {
        schema_version: u8,
        sampled_at: u64,
        coverage: CoverageInput,
        tokens: HandoffTokens,
    },
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CoverageInput {
    Complete,
    Partial,
    Unavailable,
}

impl CoverageInput {
    fn output(self) -> Coverage {
        match self {
            Self::Complete => Coverage::Complete,
            Self::Partial => Coverage::Partial,
            Self::Unavailable => Coverage::Unavailable,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandoffTokens {
    input: NullableQuantity,
    cache_read: NullableQuantity,
    cache_creation: NullableQuantity,
    output: NullableQuantity,
}

impl HandoffTokens {
    fn values(&self) -> [Option<u64>; 4] {
        [
            self.input.0,
            self.cache_read.0,
            self.cache_creation.0,
            self.output.0,
        ]
    }

    fn valid(&self, coverage: CoverageInput) -> bool {
        let values = self.values();
        let all_safe = values
            .iter()
            .flatten()
            .all(|value| *value <= MAX_SAFE_INTEGER);
        let known = values.iter().filter(|value| value.is_some()).count();
        all_safe
            && match coverage {
                CoverageInput::Complete => known == values.len(),
                CoverageInput::Partial => known > 0,
                CoverageInput::Unavailable => known == 0,
            }
    }
}

#[derive(Deserialize)]
struct NullableQuantity(Option<u64>);

fn capture_api_source(pi_launch_config: Option<&Value>) -> ApiFirstTurnSource {
    let value = match api_usage_value(pi_launch_config) {
        Ok(Some(value)) => value,
        Ok(None) => {
            return ApiFirstTurnSource::Unavailable {
                reason: ApiUnavailableReason::MissingHandoff,
            };
        }
        Err(()) => {
            return ApiFirstTurnSource::Unavailable {
                reason: ApiUnavailableReason::InvalidHandoff,
            };
        }
    };
    let usage: HandoffUsage = match serde_json::from_value(value.clone()) {
        Ok(usage) => usage,
        Err(_) => {
            return ApiFirstTurnSource::Unavailable {
                reason: ApiUnavailableReason::InvalidHandoff,
            };
        }
    };
    match usage {
        HandoffUsage::NoInference {
            schema_version: 1,
            sampled_at,
        } if sampled_at <= MAX_SAFE_INTEGER => ApiFirstTurnSource::NoInference { sampled_at },
        HandoffUsage::Observed {
            schema_version: 1,
            sampled_at,
            coverage,
            tokens,
        } if sampled_at <= MAX_SAFE_INTEGER && tokens.valid(coverage) => {
            ApiFirstTurnSource::Observed {
                sampled_at,
                coverage: coverage.output(),
                tokens: ApiTokens::from_handoff(tokens),
            }
        }
        _ => ApiFirstTurnSource::Unavailable {
            reason: ApiUnavailableReason::InvalidHandoff,
        },
    }
}

fn api_usage_value(pi_launch_config: Option<&Value>) -> Result<Option<&Value>, ()> {
    let Some(config) = pi_launch_config else {
        return Ok(None);
    };
    let config = config.as_object().ok_or(())?;
    let Some(api_first_turn) = config.get("apiFirstTurn") else {
        return Ok(None);
    };
    let api_first_turn = api_first_turn.as_object().ok_or(())?;
    let Some(continuation) = api_first_turn.get("continuation") else {
        return Ok(None);
    };
    let continuation = continuation.as_object().ok_or(())?;
    Ok(continuation.get("apiUsage"))
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
    let (proxy, _crash_rx) = crate::proxy::MitmProxy::noop();
    Arc::new(Run {
        run_id,
        api: ApiFirstTurnSource::NoInference { sampled_at: 0 },
        mitm: MitmUsageHandle::from(&proxy).for_run(run_id),
    })
}

fn combine(api: &ApiFirstTurnSource, sandbox: &SandboxProxySource) -> Combined {
    let mut values = [0_u128; 4];
    let mut observed = false;
    let api_complete = match api {
        ApiFirstTurnSource::NoInference { .. } => {
            observed = true;
            true
        }
        ApiFirstTurnSource::Observed {
            coverage, tokens, ..
        } => {
            for (target, value) in values.iter_mut().zip(tokens.values()) {
                if let Some(value) = value {
                    observed = true;
                    *target += u128::from(value);
                }
            }
            *coverage == Coverage::Complete
        }
        ApiFirstTurnSource::Unavailable { .. } => false,
    };
    let mitm_complete = match sandbox {
        SandboxProxySource::Observed {
            coverage, tokens, ..
        } => {
            observed = true;
            for (target, value) in values.iter_mut().zip([
                tokens.input,
                tokens.cache_read,
                tokens.cache_creation,
                tokens.output,
            ]) {
                *target += u128::from(value);
            }
            *coverage == Coverage::Complete
        }
        SandboxProxySource::Unavailable { .. } => false,
    };
    if !observed {
        return Combined::Unavailable {
            reason: CombinedUnavailableReason::NoObservation,
        };
    }
    let coverage = if api_complete && mitm_complete {
        Coverage::Complete
    } else {
        Coverage::Partial
    };
    let total = values.iter().sum::<u128>();
    if values
        .iter()
        .chain(std::iter::once(&total))
        .any(|value| *value > u128::from(MAX_SAFE_INTEGER))
    {
        return Combined::Overflow { coverage };
    }
    Combined::Observed {
        coverage,
        observed_tokens: TokenTotals {
            input: values[0] as u64,
            cache_read: values[1] as u64,
            cache_creation: values[2] as u64,
            output: values[3] as u64,
            total: total as u64,
        },
    }
}

#[cfg(test)]
mod tests;
