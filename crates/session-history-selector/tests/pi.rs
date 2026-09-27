use std::fs::File;
use std::io::Write;

use serde_json::{Value, json};
use session_history_selector::{
    PiHistoryIneligibleReason as Reason, PiHistorySelection,
    select_pi_compact_generation_with_candidate_limit_for_test,
};
use tempfile::NamedTempFile;

const SESSION_ID: &str = "pi-checkpoint-test";

fn line(value: Value) -> String {
    format!("{value}\n")
}

fn entry(kind: &str, id: &str, parent: Option<&str>) -> Value {
    json!({"type":kind,"id":id,"parentId":parent,"timestamp":"2026-09-27T00:00:00Z"})
}

fn session() -> String {
    line(
        json!({"type":"session","version":3,"id":SESSION_ID,"cwd":"/home/user/workspace","timestamp":"2026-09-27T00:00:00Z"}),
    )
}

fn history(first_kept: &str, with_compact: bool) -> String {
    let mut source = session();
    source.push_str(&line(json!({"type":"thinking_level_change","id":"think","parentId":null,"timestamp":"2026-09-27T00:00:00Z","thinkingLevel":"high"})));
    source.push_str(&line(json!({"type":"message","id":"old","parentId":"think","timestamp":"2026-09-27T00:00:00Z","message":{"role":"user","content":"old prompt"}})));
    // Large old payload is never copied into the native compact generation.
    source.push_str(&line(json!({"type":"message","id":"large","parentId":"old","timestamp":"2026-09-27T00:00:00Z","message":{"role":"toolResult","toolCallId":"prior","toolName":"bash","content":"X".repeat(2048)}})));
    source.push_str(&line(json!({"type":"message","id":"kept","parentId":"large","timestamp":"2026-09-27T00:00:00Z","message":{"role":"user","content":"keep this"}})));
    if with_compact {
        source.push_str(&line(json!({"type":"compaction","id":"compact","parentId":"kept","timestamp":"2026-09-27T00:00:00Z","summary":"summary of old work","firstKeptEntryId":first_kept,"tokensBefore":42000})));
    }
    let parent = if with_compact { "compact" } else { "kept" };
    source.push_str(&line(json!({"type":"message","id":"done","parentId":parent,"timestamp":"2026-09-27T00:00:00Z","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"provider":"test","model":"test","stopReason":"stop","timestamp":1}})));
    source
}

fn select(source: &str, limit: u64) -> std::io::Result<PiHistorySelection> {
    let mut file = NamedTempFile::new()?;
    file.write_all(source.as_bytes())?;
    select_pi_compact_generation_with_candidate_limit_for_test(
        &mut File::open(file.path())?,
        SESSION_ID,
        limit,
    )
}

#[test]
fn retains_kept_precompact_messages_and_prior_thinking_state() {
    let source = history("kept", true);
    let result = select(&source, 1024).unwrap();
    let PiHistorySelection::Candidate(candidate) = result else {
        panic!("expected a bounded native generation: {result:?}");
    };
    assert!(candidate.candidate_size() < 1024);
    assert_eq!(candidate.source_size(), source.len() as u64);
    let rows: Vec<Value> = std::str::from_utf8(candidate.as_bytes())
        .unwrap()
        .lines()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect();
    assert_eq!(
        rows.iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [SESSION_ID, "think", "kept", "compact", "done"]
    );
    assert!(rows[1]["parentId"].is_null());
    assert_eq!(rows[2]["parentId"], "think");
    assert_eq!(rows[3]["firstKeptEntryId"], "kept");
    assert_eq!(
        rows.last().unwrap()["message"]["content"][0]["text"],
        "done"
    );
}

#[test]
fn carries_the_prior_assistant_model_when_compact_is_the_leaf() {
    let mut source = session();
    source.push_str(&line(json!({"type":"message","id":"model","parentId":null,"timestamp":"2026-09-27T00:00:00Z","message":{"role":"assistant","content":[{"type":"text","text":"previous model"}],"provider":"faux","model":"faux-1","stopReason":"stop","timestamp":1}})));
    source.push_str(&line(json!({"type":"thinking_level_change","id":"think","parentId":"model","timestamp":"2026-09-27T00:00:00Z","thinkingLevel":"high"})));
    source.push_str(&line(json!({"type":"message","id":"large","parentId":"think","timestamp":"2026-09-27T00:00:00Z","message":{"role":"user","content":"X".repeat(2048)}})));
    source.push_str(&line(json!({"type":"message","id":"kept","parentId":"large","timestamp":"2026-09-27T00:00:00Z","message":{"role":"user","content":"kept"}})));
    source.push_str(&line(json!({"type":"compaction","id":"compact","parentId":"kept","timestamp":"2026-09-27T00:00:00Z","summary":"summary","firstKeptEntryId":"kept","tokensBefore":1000})));
    let PiHistorySelection::Candidate(candidate) = select(&source, 1024).unwrap() else {
        panic!("expected bounded model-and-thinking generation");
    };
    let rows: Vec<Value> = std::str::from_utf8(candidate.as_bytes())
        .unwrap()
        .lines()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect();
    assert_eq!(
        rows.iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [SESSION_ID, "model", "think", "kept", "compact"]
    );
    assert!(rows[1]["parentId"].is_null());
    assert_eq!(rows[2]["parentId"], "model");
    assert_eq!(rows[3]["parentId"], "think");
    assert_eq!(rows[1]["message"]["provider"], "faux");
}

#[test]
fn preserves_native_session_name_before_the_compact_boundary() {
    let mut source = session();
    source.push_str(&line(json!({"type":"session_info","id":"name","parentId":null,"timestamp":"2026-09-27T00:00:00Z","name":"Retained title"})));
    source.push_str(&line(json!({"type":"message","id":"old","parentId":"name","timestamp":"2026-09-27T00:00:00Z","message":{"role":"user","content":"X".repeat(2048)}})));
    source.push_str(&line(json!({"type":"message","id":"kept","parentId":"old","timestamp":"2026-09-27T00:00:00Z","message":{"role":"user","content":"kept"}})));
    source.push_str(&line(json!({"type":"compaction","id":"compact","parentId":"kept","timestamp":"2026-09-27T00:00:00Z","summary":"summary","firstKeptEntryId":"kept","tokensBefore":1000})));
    source.push_str(&line(json!({"type":"message","id":"done","parentId":"compact","timestamp":"2026-09-27T00:00:00Z","message":{"role":"assistant","content":[],"provider":"faux","model":"faux-1","stopReason":"stop","timestamp":1}})));
    let PiHistorySelection::Candidate(candidate) = select(&source, 1024).unwrap() else {
        panic!("expected the session name to survive compaction");
    };
    let entries: Vec<Value> = std::str::from_utf8(candidate.as_bytes())
        .unwrap()
        .lines()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect();
    assert_eq!(entries[1]["type"], "session_info");
    assert_eq!(entries[1]["name"], "Retained title");
    assert!(entries[1]["parentId"].is_null());
    assert_eq!(entries[2]["parentId"], "name");
}

#[test]
fn rejects_unrestorable_prefix_custom_state_and_dangling_label() {
    let mut custom = session();
    custom.push_str(&line(json!({"type":"custom","id":"extension","parentId":null,"timestamp":"2026-09-27T00:00:00Z","customType":"state","data":{"counter":1}})));
    custom.push_str(&line(json!({"type":"message","id":"old","parentId":"extension","timestamp":"2026-09-27T00:00:00Z","message":{"role":"user","content":"X".repeat(2048)}})));
    custom.push_str(&line(json!({"type":"message","id":"kept","parentId":"old","timestamp":"2026-09-27T00:00:00Z","message":{"role":"user","content":"kept"}})));
    custom.push_str(&line(json!({"type":"compaction","id":"compact","parentId":"kept","timestamp":"2026-09-27T00:00:00Z","summary":"summary","firstKeptEntryId":"kept","tokensBefore":1000})));
    assert!(matches!(
        select(&custom, 1024).unwrap(),
        PiHistorySelection::Ineligible(Reason::UnsafeNativeState)
    ));

    let mut labeled = session();
    labeled.push_str(&line(json!({"type":"message","id":"old","parentId":null,"timestamp":"2026-09-27T00:00:00Z","message":{"role":"user","content":"X".repeat(2048)}})));
    labeled.push_str(&line(json!({"type":"message","id":"kept","parentId":"old","timestamp":"2026-09-27T00:00:00Z","message":{"role":"user","content":"kept"}})));
    labeled.push_str(&line(json!({"type":"label","id":"label","parentId":"kept","targetId":"old","timestamp":"2026-09-27T00:00:00Z","label":"bookmark"})));
    labeled.push_str(&line(json!({"type":"compaction","id":"compact","parentId":"label","timestamp":"2026-09-27T00:00:00Z","summary":"summary","firstKeptEntryId":"kept","tokensBefore":1000})));
    assert!(matches!(
        select(&labeled, 1024).unwrap(),
        PiHistorySelection::Ineligible(Reason::UnsafeNativeState)
    ));
    // A label whose target survives remains a valid native reference.
    let valid_label = labeled.replace("\"targetId\":\"old\"", "\"targetId\":\"kept\"");
    assert_ne!(valid_label, labeled);
    assert!(matches!(
        select(&valid_label, 1024).unwrap(),
        PiHistorySelection::Candidate(_)
    ));
}

#[test]
fn rejects_session_title_on_an_abandoned_branch() {
    let mut source = session();
    source.push_str(&line(json!({"type":"message","id":"old","parentId":null,"timestamp":"2026-09-27T00:00:00Z","message":{"role":"user","content":"X".repeat(2048)}})));
    source.push_str(&line(json!({"type":"session_info","id":"title","parentId":"old","timestamp":"2026-09-27T00:00:00Z","name":"Global title"})));
    source.push_str(&line(json!({"type":"message","id":"kept","parentId":"old","timestamp":"2026-09-27T00:00:00Z","message":{"role":"user","content":"kept"}})));
    source.push_str(&line(json!({"type":"compaction","id":"compact","parentId":"kept","timestamp":"2026-09-27T00:00:00Z","summary":"summary","firstKeptEntryId":"kept","tokensBefore":1000})));
    assert!(matches!(
        select(&source, 1024).unwrap(),
        PiHistorySelection::Ineligible(Reason::UnsafeNativeState)
    ));
}

#[test]
fn rejects_ineligible_or_oversized_generation_without_falling_back() {
    assert_eq!(
        select(&history("kept", false), 1024).unwrap(),
        PiHistorySelection::Ineligible(Reason::NoCompactBoundary)
    );
    assert_eq!(
        select(
            &format!("{}{{invalid json}}\n", history("kept", true)),
            1024
        )
        .unwrap(),
        PiHistorySelection::Ineligible(Reason::InvalidRecord)
    );
    assert_eq!(
        select(&history("absent", true), 1024).unwrap(),
        PiHistorySelection::Ineligible(Reason::InvalidCompactBoundary)
    );
    assert_eq!(
        select(&history("large", true), 1024).unwrap(),
        PiHistorySelection::Ineligible(Reason::CandidateTooLarge)
    );
    assert_eq!(
        select(&history("kept", true), 10_000).unwrap(),
        PiHistorySelection::Ineligible(Reason::SourceWithinGuard)
    );
    assert_eq!(
        select(
            &history("kept", true).replace("\"version\":3", "\"version\":99"),
            1024
        )
        .unwrap(),
        PiHistorySelection::Ineligible(Reason::UnsupportedVersion)
    );
}

#[test]
fn preserves_the_pinned_older_pi_compaction_and_pending_tool_fixture() {
    let source = include_str!(
        "../../../turbo/packages/pi-agent-runtime/src/test/fixtures/pi-0.84.1-session.jsonl"
    );
    let mut file = NamedTempFile::new().unwrap();
    file.write_all(source.as_bytes()).unwrap();
    let result = select_pi_compact_generation_with_candidate_limit_for_test(
        &mut File::open(file.path()).unwrap(),
        "pi-0841-rollback-fixture",
        source.len() as u64 - 1,
    )
    .unwrap();
    let PiHistorySelection::Candidate(candidate) = result else {
        panic!("expected a bounded native generation: {result:?}");
    };
    let entries: Vec<Value> = std::str::from_utf8(candidate.as_bytes())
        .unwrap()
        .lines()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect();
    assert_eq!(
        entries
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "pi-0841-rollback-fixture",
            "39d32408",
            "01001b0c",
            "7a8ffa1b",
            "83fe410a",
            "a6557155",
            "45a24675",
            "99c24a0f"
        ]
    );
    assert!(entries[1]["parentId"].is_null());
    assert_eq!(entries[2]["parentId"], "39d32408");
    assert_eq!(entries[3]["parentId"], "01001b0c");
    assert_eq!(entries[7]["firstKeptEntryId"], "7a8ffa1b");
}

#[test]
fn selects_only_the_active_branch_not_abandoned_payloads() {
    let mut source = session();
    source.push_str(&line(entry("model_change", "root", None)));
    source.push_str(&line(json!({"type":"message","id":"abandoned","parentId":"root","timestamp":"2026-09-27T00:00:00Z","message":{"role":"user","content":"X".repeat(2048)}})));
    source.push_str(&line(json!({"type":"branch_summary","id":"branch","parentId":"root","fromId":"abandoned","timestamp":"2026-09-27T00:00:00Z","summary":"earlier branch"})));
    source.push_str(&line(json!({"type":"compaction","id":"compact","parentId":"branch","timestamp":"2026-09-27T00:00:00Z","summary":"compacted","firstKeptEntryId":"branch"})));
    source.push_str(&line(entry("message", "done", Some("compact"))));
    let PiHistorySelection::Candidate(candidate) = select(&source, 1024).unwrap() else {
        panic!("expected active branch only");
    };
    let entries: Vec<Value> = std::str::from_utf8(candidate.as_bytes())
        .unwrap()
        .lines()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect();
    assert_eq!(
        entries
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [SESSION_ID, "root", "branch", "compact", "done"]
    );
}
