use super::*;
use serde_json::{json, to_value};

#[test]
fn runtime_installs_for_every_context() {
    let run_id = RunId::new_v4();
    let context = crate::test_fixtures::execution_context::execution_context_for_test(run_id);
    let (proxy, _crash_rx) = runner_network::proxy::MitmProxy::noop();
    let runtime = Runtime::new(MitmUsageHandle::from(&proxy));

    let owner = runtime.for_context(&context);
    assert_eq!(owner.run_id, run_id);
}

fn proxy(complete: bool, tokens: TokenTotals) -> SandboxProxySource {
    SandboxProxySource::Observed {
        sampled_at_ms: 1,
        revision: 2,
        coverage: if complete {
            Coverage::Complete
        } else {
            Coverage::Partial
        },
        reasons: if complete {
            vec![]
        } else {
            vec![CoverageReason::HistoryLost]
        },
        observed_responses: 1,
        outstanding_responses: 0,
        tokens,
    }
}

fn totals(input: u64, cache_read: u64, cache_creation: u64, output: u64) -> TokenTotals {
    TokenTotals {
        input,
        cache_read,
        cache_creation,
        output,
        total: input + cache_read + cache_creation + output,
    }
}

#[test]
fn combined_usage_is_the_sandbox_proxy_observation() {
    assert_eq!(
        combine(&proxy(true, totals(5, 6, 7, 8))),
        Combined::Observed {
            coverage: Coverage::Complete,
            observed_tokens: totals(5, 6, 7, 8)
        }
    );
    assert_eq!(
        combine(&proxy(false, totals(0, 0, 0, 0))),
        Combined::Observed {
            coverage: Coverage::Partial,
            observed_tokens: totals(0, 0, 0, 0)
        }
    );
    assert_eq!(
        combine(&SandboxProxySource::Unavailable {
            reason: SandboxUnavailableReason::NotObserved,
        }),
        Combined::Unavailable {
            reason: CombinedUnavailableReason::NoObservation
        }
    );
}

#[test]
fn unsafe_proxy_quantities_emit_no_totals() {
    let half = MAX_SAFE_INTEGER / 2;
    assert_eq!(
        combine(&proxy(true, totals(half, half, 1, 1))),
        Combined::Overflow {
            coverage: Coverage::Complete
        }
    );
}

#[test]
fn result_has_no_api_first_turn_source() {
    let sandbox_proxy = proxy(true, totals(1, 2, 3, 4));
    let result = ResultDto {
        schema_version: 1,
        run_id: RunId::new_v4(),
        combined: combine(&sandbox_proxy),
        sources: Sources { sandbox_proxy },
    };
    let value = to_value(&result).unwrap();
    assert_eq!(
        value["sources"],
        json!({
            "sandboxProxy": {
                "state": "observed",
                "sampledAtMs": 1,
                "revision": 2,
                "coverage": "complete",
                "reasons": [],
                "observedResponses": 1,
                "outstandingResponses": 0,
                "tokens": {"input":1,"cacheRead":2,"cacheCreation":3,"output":4,"total":10}
            }
        })
    );
    assert_eq!(value["combined"]["coverage"], "complete");
}

#[test]
fn maps_mitm_business_and_io_states_without_fabricating_zero() {
    let run_id = RunId::new_v4();
    assert_eq!(
        sandbox_proxy_source(Ok(RunUsageObservation::Unavailable { run_id })),
        SandboxProxySource::Unavailable {
            reason: SandboxUnavailableReason::NotObserved
        }
    );
    for (kind, reason) in [
        (
            io::ErrorKind::NotConnected,
            SandboxUnavailableReason::LaunchUnavailable,
        ),
        (io::ErrorKind::WouldBlock, SandboxUnavailableReason::Busy),
        (io::ErrorKind::TimedOut, SandboxUnavailableReason::TimedOut),
        (
            io::ErrorKind::InvalidData,
            SandboxUnavailableReason::InvalidResponse,
        ),
        (
            io::ErrorKind::BrokenPipe,
            SandboxUnavailableReason::Transport,
        ),
    ] {
        assert_eq!(
            sandbox_proxy_source(Err(io::Error::new(kind, "test"))),
            SandboxProxySource::Unavailable { reason }
        );
    }
}
