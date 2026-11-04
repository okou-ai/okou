use super::*;
use crate::test_fixtures::execution_context::execution_context_for_test;

mod finalizing_source;

fn minimal_context(run_id: RunId) -> ExecutionContext {
    let mut ctx = execution_context_for_test(run_id);
    ctx.sandbox_token = "sandbox-token".into();
    ctx
}

fn api_claim_timing() -> ApiClaimTiming {
    ApiClaimTiming::new(
        Duration::from_millis(10),
        Duration::from_millis(4),
        Duration::from_millis(2),
        Duration::from_millis(1),
        Duration::from_millis(3),
        ClaimResponseAttribution::from_body_and_encoding(100, None),
    )
}

#[test]
fn claim_response_attribution_uses_fixed_size_and_encoding_labels() {
    let cases = [
        (0, "lt_4_kib"),
        (4095, "lt_4_kib"),
        (4096, "4_16_kib"),
        (16384, "16_64_kib"),
        (65536, "64_256_kib"),
        (262144, "256_kib_1_mib"),
        (1048576, "ge_1_mib"),
    ];
    for (bytes, expected) in cases {
        assert_eq!(
            ClaimResponseAttribution::from_body_and_encoding(bytes, None).body_size_bucket(),
            expected,
        );
    }

    use reqwest::header::HeaderValue;
    let cases = [
        (None, "absent"),
        (Some(HeaderValue::from_static("identity")), "identity"),
        (Some(HeaderValue::from_static("GZIP")), "gzip"),
        (Some(HeaderValue::from_static("br")), "br"),
        (Some(HeaderValue::from_static("deflate")), "deflate"),
        (Some(HeaderValue::from_static("zstd")), "zstd"),
        (Some(HeaderValue::from_static("gzip, br")), "other"),
        (Some(HeaderValue::from_static(" ")), "invalid"),
        (Some(HeaderValue::from_bytes(b"\xff").unwrap()), "invalid"),
    ];
    for (header, expected) in cases {
        assert_eq!(
            ClaimResponseAttribution::from_body_and_encoding(100, header.as_ref())
                .content_encoding(),
            expected,
        );
    }
}

#[test]
fn claimed_job_rejects_mismatched_api_context() {
    let expected_run_id = RunId::from(uuid::Uuid::nil());
    let context_run_id = RunId::new_v4();

    let Err(err) = ClaimedJob::api(
        expected_run_id,
        minimal_context(context_run_id),
        api_claim_timing(),
    ) else {
        panic!("mismatched context must be rejected");
    };

    assert_eq!(
        err,
        ClaimedJobRunIdMismatch {
            expected_run_id,
            context_run_id,
        }
    );
}

#[test]
fn claimed_job_accepts_matching_api_context() {
    let run_id = RunId::from(uuid::Uuid::nil());

    let claimed = ClaimedJob::api(run_id, minimal_context(run_id), api_claim_timing())
        .expect("matching context is valid");
    assert_eq!(claimed.api_claim_timing(), Some(api_claim_timing()));
    let (context, completion_auth, active_input_source) = claimed.into_parts();

    assert_eq!(context.run_id, run_id);
    assert!(active_input_source.is_none());
    assert_eq!(
        completion_auth.into_sandbox_token(run_id).unwrap(),
        "sandbox-token"
    );
}

#[test]
fn claimed_job_local_context_has_no_api_claim_timing() {
    let run_id = RunId::from(uuid::Uuid::nil());

    let claimed = ClaimedJob::local(run_id, minimal_context(run_id))
        .expect("matching local context is valid");

    assert!(claimed.api_claim_timing().is_none());
}
