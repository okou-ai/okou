use super::*;

#[tokio::test]
async fn terminal_error_lines_survive_stderr_collection() {
    let fixtures: Vec<String> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/cli-terminal-stderr.json"
    )))
    .unwrap();
    for fixture in fixtures {
        let stderr = fixture.as_str();
        assert!(stderr.len() < CLI_STDERR_RESULT_MAX_LINE_BYTES);
        for suffix in ["\n", ""] {
            let wire = format!("{stderr}{suffix}");
            assert_eq!(collect_stderr_result_tail(wire.as_bytes()).await, [stderr]);
        }
    }
}
