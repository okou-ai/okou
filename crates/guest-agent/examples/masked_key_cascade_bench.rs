//! Measure synchronous event preparation with cascading JSON keys.
//!
//! Build with `cargo build --release -p guest-agent --example masked_key_cascade_bench`,
//! then run `timeout 30s target/release/examples/masked_key_cascade_bench` from `crates/`.
//! Matcher compilation, input allocation, assertions, and output destruction are
//! excluded from timing. Measurements have no pass/fail timing threshold.

use base64::Engine;
use guest_agent::{events::prepare_event_payload_for_run_id, masker::SecretMasker};
use serde_json::{Map, Value, json};
use std::{hint::black_box, time::Instant};

fn main() {
    let raw = base64::engine::general_purpose::STANDARD.encode("a***b");
    let masker = SecretMasker::from_raw(&raw);
    let expected = json!({
        "runId": "bench-run",
        "events": [{"***": null, "sequenceNumber": 7}]
    });

    for n in [4_096, 8_192, 16_384, 32_768, 65_536, 131_072] {
        let key = format!("{}***{}", "a".repeat(n), "b".repeat(n));
        let key_bytes = key.len();
        let input = Value::Object(Map::from_iter([(key, Value::Null)]));
        for iteration in 1..=5 {
            let event = input.clone();
            let started = Instant::now();
            let payload =
                prepare_event_payload_for_run_id(black_box(event), 7, &masker, "bench-run");
            let elapsed = started.elapsed();
            assert_eq!(payload, expected);
            println!(
                "n={n} key_bytes={key_bytes} iteration={iteration} elapsed_ns={}",
                elapsed.as_nanos()
            );
            black_box(payload);
        }
    }
}
