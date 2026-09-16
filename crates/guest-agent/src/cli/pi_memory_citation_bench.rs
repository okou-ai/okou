//! Run with `cargo run --release -p guest-agent --example pi_memory_citation_bench`.
//! Inputs are allocated before timing; measurements exclude output destruction.
//! This benchmarks the canonical parser without making it a public library API.

use std::hint::black_box;
use std::time::Instant;

mod pi_memory_citation;

use pi_memory_citation::{CLOSE, CitationParser, OPEN, project_segments};

fn validate_streaming_drain() {
    let mut parser = CitationParser::new(0);
    parser.push("visible", 0);
    assert_eq!(parser.take_visible_segments(), [(0, "visible".to_string())]);
    assert_eq!(parser.finish().visible_segments, [""]);
}

fn main() {
    validate_streaming_drain();
    for size in [64 * 1024, 1024 * 1024, 8 * 1024 * 1024] {
        let text = "x".repeat(size);
        let hidden = format!("{OPEN}{text}{CLOSE}visible");
        for (name, input, visible) in [
            ("plain", text.as_str(), text.as_str()),
            ("hidden", hidden.as_str(), "visible"),
        ] {
            for iteration in 1..=3 {
                let start = Instant::now();
                let projection = project_segments(black_box(&[input]));
                let elapsed = start.elapsed();
                assert_eq!(projection.visible_segments, [visible]);
                assert!(projection.citation.is_none());
                assert_eq!(
                    projection.diagnostics.envelopes,
                    usize::from(name == "hidden")
                );
                assert_eq!(
                    projection.diagnostics.oversized_bodies,
                    usize::from(name == "hidden" && size > 64 * 1024)
                );
                println!(
                    "case={name} body_bytes={size} input_bytes={} iteration={iteration} elapsed_us={}",
                    input.len(),
                    elapsed.as_micros()
                );
                black_box(projection);
            }
        }
    }
}
