use super::*;

#[test]
fn builds_canonical_rollout_relative_path() {
    let thread_id = CodexThreadId::parse("019e9154-c304-70f0-adde-36efb1be1701")
        .expect("valid Codex thread id");
    let timestamp = DateTime::parse_from_rfc3339("2026-06-04T07:18:08Z")
        .expect("valid timestamp")
        .with_timezone(&Utc);

    assert_eq!(
        codex_rollout_relative_path(&thread_id, timestamp),
        "sessions/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl"
    );
}
