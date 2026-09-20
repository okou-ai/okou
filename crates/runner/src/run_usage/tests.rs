use super::*;
use serde_json::{json, to_value};

#[test]
fn runtime_installs_only_for_a_captured_enabled_switch() {
    let run_id = RunId::new_v4();
    let mut context = crate::test_fixtures::execution_context::execution_context_for_test(run_id);
    let (proxy, _crash_rx) = crate::proxy::MitmProxy::noop();
    let runtime = Runtime::new(MitmUsageHandle::from(&proxy));

    assert!(runtime.for_context(&context).is_none());
    context.feature_flags = Some(std::collections::HashMap::from([(
        FEATURE_SWITCH.to_owned(),
        false,
    )]));
    assert!(runtime.for_context(&context).is_none());

    context
        .feature_flags
        .as_mut()
        .unwrap()
        .insert(FEATURE_SWITCH.to_owned(), true);
    context.pi_launch_config = Some(launch(json!({
        "schemaVersion": 1,
        "state": "no-inference",
        "sampledAt": 0
    })));
    let owner = runtime.for_context(&context).unwrap();
    assert_eq!(owner.run_id, run_id);
    assert_eq!(owner.api, ApiFirstTurnSource::NoInference { sampled_at: 0 });
}

fn launch(usage: Value) -> Value {
    json!({
        "apiFirstTurn": {
            "continuation": {
                "mode": "untouched-h0",
                "apiUsage": usage
            }
        }
    })
}

fn observed(coverage: &str, tokens: Value) -> Value {
    json!({
        "schemaVersion": 1,
        "state": "observed",
        "sampledAt": 0,
        "coverage": coverage,
        "tokens": tokens
    })
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
fn captures_missing_invalid_no_inference_and_tolerant_additions() {
    assert_eq!(
        capture_api_source(None),
        ApiFirstTurnSource::Unavailable {
            reason: ApiUnavailableReason::MissingHandoff
        }
    );
    assert_eq!(
        capture_api_source(Some(&json!({"apiFirstTurn": {"continuation": {}}}))),
        ApiFirstTurnSource::Unavailable {
            reason: ApiUnavailableReason::MissingHandoff
        }
    );
    for value in [
        json!(null),
        json!({"apiFirstTurn": null}),
        json!({"apiFirstTurn": {"continuation": null}}),
        launch(json!(null)),
        launch(json!({"schemaVersion": 2, "state": "no-inference", "sampledAt": 0})),
        launch(
            json!({"schemaVersion": 1, "state": "no-inference", "sampledAt": MAX_SAFE_INTEGER + 1}),
        ),
        launch(json!({"schemaVersion": 1, "state": "no-inference"})),
    ] {
        assert_eq!(
            capture_api_source(Some(&value)),
            ApiFirstTurnSource::Unavailable {
                reason: ApiUnavailableReason::InvalidHandoff
            }
        );
    }
    let value = launch(json!({
        "schemaVersion": 1,
        "state": "no-inference",
        "sampledAt": 0,
        "future": {"additive": true}
    }));
    assert_eq!(
        capture_api_source(Some(&value)),
        ApiFirstTurnSource::NoInference { sampled_at: 0 }
    );
}

#[test]
fn validates_observed_coverage_required_nullable_categories_and_safe_integers() {
    let complete = json!({"input":0,"cacheRead":1,"cacheCreation":2,"output":3});
    let partial = json!({"input":0,"cacheRead":null,"cacheCreation":null,"output":null});
    let unavailable = json!({"input":null,"cacheRead":null,"cacheCreation":null,"output":null});
    for (coverage, tokens) in [
        ("complete", complete.clone()),
        ("partial", partial.clone()),
        ("unavailable", unavailable.clone()),
    ] {
        let value = launch(observed(coverage, tokens));
        assert!(matches!(
            capture_api_source(Some(&value)),
            ApiFirstTurnSource::Observed { .. }
        ));
    }
    for (coverage, tokens) in [
        ("complete", partial.clone()),
        ("partial", unavailable.clone()),
        ("unavailable", partial),
        (
            "complete",
            json!({"input":MAX_SAFE_INTEGER + 1,"cacheRead":0,"cacheCreation":0,"output":0}),
        ),
        (
            "complete",
            json!({"input":0,"cacheRead":0,"cacheCreation":0}),
        ),
    ] {
        let value = launch(observed(coverage, tokens));
        assert_eq!(
            capture_api_source(Some(&value)),
            ApiFirstTurnSource::Unavailable {
                reason: ApiUnavailableReason::InvalidHandoff
            }
        );
    }
    let additive = launch(observed(
        "complete",
        json!({
            "input":0,"cacheRead":1,"cacheCreation":2,"output":3,
            "futureCategory": 100
        }),
    ));
    assert_eq!(
        to_value(capture_api_source(Some(&additive))).unwrap(),
        json!({
            "state":"observed","sampledAt":0,"coverage":"complete",
            "tokens":{"input":0,"cacheRead":1,"cacheCreation":2,"output":3,"total":6}
        })
    );
}

#[test]
fn combines_each_known_contribution_once_and_preserves_partial_zero() {
    let api_value = launch(observed(
        "partial",
        json!({"input":5,"cacheRead":null,"cacheCreation":0,"output":null}),
    ));
    let api = capture_api_source(Some(&api_value));
    let sandbox = proxy(false, totals(7, 2, 3, 4));
    let expected = Combined::Observed {
        coverage: Coverage::Partial,
        observed_tokens: totals(12, 2, 3, 4),
    };
    assert_eq!(combine(&api, &sandbox), expected);
    assert_eq!(combine(&api, &sandbox), expected);

    let no_inference = ApiFirstTurnSource::NoInference { sampled_at: 0 };
    let unavailable = SandboxProxySource::Unavailable {
        reason: SandboxUnavailableReason::NotObserved,
    };
    assert_eq!(
        combine(&no_inference, &unavailable),
        Combined::Observed {
            coverage: Coverage::Partial,
            observed_tokens: totals(0, 0, 0, 0)
        }
    );
    assert_eq!(
        combine(
            &ApiFirstTurnSource::Unavailable {
                reason: ApiUnavailableReason::MissingHandoff
            },
            &unavailable
        ),
        Combined::Unavailable {
            reason: CombinedUnavailableReason::NoObservation
        }
    );
}

#[test]
fn complete_requires_both_complete_sources_and_overflow_emits_no_totals() {
    let api_value = launch(observed(
        "complete",
        json!({"input":1,"cacheRead":2,"cacheCreation":3,"output":4}),
    ));
    let api = capture_api_source(Some(&api_value));
    assert_eq!(
        combine(&api, &proxy(true, totals(5, 6, 7, 8))),
        Combined::Observed {
            coverage: Coverage::Complete,
            observed_tokens: totals(6, 8, 10, 12)
        }
    );

    let category_overflow = launch(observed(
        "complete",
        json!({"input":MAX_SAFE_INTEGER,"cacheRead":0,"cacheCreation":0,"output":0}),
    ));
    assert_eq!(
        combine(
            &capture_api_source(Some(&category_overflow)),
            &proxy(true, totals(1, 0, 0, 0))
        ),
        Combined::Overflow {
            coverage: Coverage::Complete
        }
    );

    let half = MAX_SAFE_INTEGER / 4;
    let total_overflow = launch(observed(
        "complete",
        json!({"input":half,"cacheRead":half,"cacheCreation":half,"output":half}),
    ));
    assert_eq!(
        combine(
            &capture_api_source(Some(&total_overflow)),
            &proxy(true, totals(1, 1, 1, 1))
        ),
        Combined::Overflow {
            coverage: Coverage::Complete
        }
    );
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
