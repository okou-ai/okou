//! Complete private payload and allocation ownership in one exact child process.
use super::super::allocation::{LARGEST, LIVE_PAYLOAD_BYTES, Measurement, RELEASED_PAYLOAD_BYTES};
use super::*;
use base64::Engine as _;
use std::sync::atomic::Ordering;
use std::time::Duration;

const CHILD_ENV: &str = "OKOU_TEST_SECRET_PAYLOAD_MEMORY";
const CHILD_TEST: &str = "executor::tests::env_tests::memory::secret_payload_memory_child";

#[tokio::test]
async fn secret_payload_materialization_uses_one_encoded_buffer() {
    let output = crate::test_fixtures::ignored_child::run_ignored_child_test(
        CHILD_TEST,
        (CHILD_ENV, "1"),
        &[],
        Duration::from_secs(60),
    )
    .await;
    assert!(
        !output.truncated,
        "allocation child output must be complete"
    );
    eprintln!("{}", output.stderr);
}

#[test]
#[ignore = "ordinary parent runs this exact guarded allocation process"]
fn secret_payload_memory_child() {
    if !crate::test_fixtures::ignored_child::ignored_child_test_env_guard_enabled((CHILD_ENV, "1"))
    {
        return;
    }
    let mut observations = Vec::new();
    for token_only in [true, false] {
        let mut context = minimal_context();
        context.prompt = "complete private payload prompt".into();
        context.append_system_prompt = Some("complete system prompt".into());
        context.sandbox_token = if token_only {
            "token,\n\0界".repeat(32 * 1024)
        } else {
            "token,\n\0界".into()
        };
        context.secret_values =
            (!token_only).then(|| {
                let mut values = vec![String::new(), "duplicate,\n\0界".into()];
                values.extend((0..8).map(|index| {
                    format!("secret-{index},\n\0界{}", "x".repeat(256 * 1024 + index))
                }));
                values.push("duplicate,\n\0界".into());
                values.push(String::new());
                values
            });
        let source = std::iter::once(context.sandbox_token.as_bytes())
            .chain(
                context
                    .secret_values
                    .iter()
                    .flatten()
                    .map(|value| value.as_bytes()),
            )
            .collect::<Vec<_>>();
        let expected_encoding = source
            .iter()
            .map(|value| base64::engine::general_purpose::STANDARD.encode(value))
            .collect::<Vec<_>>()
            .join(",");
        let mut expected = build_run_payload_for_run(&context).unwrap();
        expected.secret_values = expected_encoding;
        let prepared = super::super::super::env::prepare_run_payload_for_run(&context).unwrap();
        let measurement = Measurement::start();
        let result = prepared.into_run_payload(&context);
        let largest = LARGEST.load(Ordering::Relaxed);
        let live = LIVE_PAYLOAD_BYTES.load(Ordering::Relaxed);
        let released = RELEASED_PAYLOAD_BYTES.load(Ordering::Relaxed);
        drop(measurement);

        let payload = result.unwrap();
        let complete_payload_matches = payload == expected;
        assert!(complete_payload_matches, "complete private payload changed");
        let decoded = payload
            .secret_values
            .split(',')
            .map(|part| {
                base64::engine::general_purpose::STANDARD
                    .decode(part)
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(decoded.len(), source.len());
        for (actual, original) in decoded.iter().zip(&source) {
            assert!(actual == original, "a complete secret entry changed");
        }
        let output_bytes = payload.secret_values.len();
        eprintln!(
            "token_only={token_only}: output={output_bytes}, largest={largest}, live={live}, released={released}"
        );
        observations.push((output_bytes, largest, live, released));
    }
    // Original source/oracle/result buffers stay independently owned. Only
    // allocations made by materialization are observed; this is not total/RSS.
    for (output_bytes, largest, live, released) in observations {
        assert_eq!(
            largest, output_bytes,
            "final encoded allocation size changed"
        );
        assert_eq!(
            live, output_bytes,
            "only the final large output should remain"
        );
        assert_eq!(
            released, 0,
            "materialization retained intermediate encoded buffers"
        );
    }
}
