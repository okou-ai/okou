use std::io::Write;

use serde_json::json;

use super::*;

const THREAD: &str = "019e9154-c304-70f0-adde-36efb1be1701";
const TURN: &str = "019e9154-c304-70f0-adde-36efb1be1702";
const ITEM: &str = "msg_literal_fixture";

struct Harness {
    home: tempfile::TempDir,
    path: std::path::PathBuf,
}

impl Harness {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let parent = home.path().join("sessions/2026/09/08");
        std::fs::create_dir_all(&parent).unwrap();
        let path = parent.join(format!("rollout-{THREAD}.jsonl"));
        let result = Self { home, path };
        result.append(json!({"type": "session_meta", "payload": {"id": THREAD}}));
        result
    }

    fn append(&self, record: Value) {
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&self.path)
            .or_else(|_| std::fs::File::create(&self.path))
            .unwrap();
        writeln!(file, "{record}").unwrap();
        file.flush().unwrap();
    }

    fn repair(&self, resumed: bool) -> NativeCitationRepair {
        NativeCitationRepair::new(self.home.path().to_str().unwrap(), THREAD, resumed)
    }
}

fn raw(text: &str) -> Value {
    json!({"type":"response_item", "payload": {
        "type":"message", "id":ITEM, "role":"assistant", "phase":"final_answer",
        "internal_chat_message_metadata_passthrough":{"turn_id":TURN},
        "content":[{"type":"output_text", "text":text}]
    }})
}

fn normalized(text: &str) -> Value {
    json!({"type":"item.completed", "thread_id":THREAD, "turn_id":TURN,
        "item":{"type":"agent_message", "id":ITEM, "text":native_citation_projection(text)}})
}

fn terminal(status: &str) -> Value {
    json!({"type":status, "thread_id":THREAD, "turn_id":TURN})
}

#[test]
fn fresh_and_new_process_resume_wait_for_private_raw_before_ordered_publication() {
    let text = format!("explanation `{OPEN}` complete suffix");
    let safe = project_segments(&[&text]).visible_segments.concat();
    for resumed in [false, true] {
        let harness = Harness::new();
        // An identically named historical item is never the resumed raw source.
        let mut old = raw(&format!("old `{OPEN}` unrelated private history"));
        old["payload"]["internal_chat_message_metadata_passthrough"]["turn_id"] = json!("old-turn");
        harness.append(old);
        let mut repair = harness.repair(resumed);
        assert!(
            repair
                .submit(normalized(&text), Some("final_answer"), false)
                .is_empty()
        );
        let tool = json!({"type":"item.started", "item":{"type":"command_execution", "id":"tool"}});
        assert!(repair.submit(tool.clone(), None, false).is_empty());
        harness.append(raw(&text));
        let end = terminal("turn.completed");
        let events = repair.submit(end.clone(), None, true);
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["item"]["text"], safe);
        assert_eq!(events[1], tool);
        assert_eq!(events[2], end);
        assert!(
            repair
                .submit(normalized(&text), Some("final_answer"), false)
                .is_empty()
        );
        assert!(repair.drain(true).is_empty());
        assert!(
            std::fs::read_to_string(harness.path)
                .unwrap()
                .contains(&text)
        );
    }
}

#[test]
fn current_raw_can_arrive_before_the_normalized_notification() {
    let harness = Harness::new();
    let mut repair = harness.repair(false);
    let text = format!("`{OPEN}` suffix");
    harness.append(raw(&text));
    let events = repair.submit(normalized(&text), Some("final_answer"), false);
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0]["item"]["text"],
        project_segments(&[&text]).visible_segments.concat()
    );
}

#[test]
fn private_source_requires_exact_item_turn_role_phase_and_text_contract() {
    let text = format!("before `{OPEN}` private raw suffix");
    for (path, replacement) in [
        ("/payload/id", json!("unrelated-item")),
        ("/payload/role", json!("developer")),
        ("/payload/phase", json!("commentary")),
        (
            "/payload/internal_chat_message_metadata_passthrough/turn_id",
            json!("unrelated-turn"),
        ),
        ("/payload/content/0/type", json!("input_text")),
        ("/item/text", json!("different native projection `")),
        ("/payload/type", json!("reasoning")),
        ("/payload/id", Value::Null),
        ("/payload/phase", Value::Null),
        (
            "/payload/internal_chat_message_metadata_passthrough",
            Value::Null,
        ),
    ] {
        let harness = Harness::new();
        let mut repair = harness.repair(true);
        let mut record = raw(&text);
        let mut event = normalized(&text);
        let target = if path == "/item/text" {
            &mut event
        } else {
            &mut record
        };
        *target.pointer_mut(path).unwrap() = replacement;
        harness.append(record);
        let mut events = repair.submit(event.clone(), Some("final_answer"), false);
        events.extend(repair.submit(terminal("turn.failed"), None, true));
        assert_eq!(events, [event, terminal("turn.failed")], "{path}");
    }
}

#[test]
fn plan_controls_and_private_bodies_never_enter_recovered_suffix() {
    let private =
        format!("{OPEN}<citation_entries>private.md:1-2|note=[secret]</citation_entries>{CLOSE}");
    let text = format!("before `{OPEN}` suffix `{private}` after");
    let projected = repair_text(&text, &native_citation_projection(&text)).unwrap();
    assert!(projected.ends_with("suffix `` after"));
    assert!(!projected.contains("private.md") && !projected.contains("secret"));
    for plan in [
        "<proposed_plan>private plan</proposed_plan>",
        "<proposed_plan>unclosed private plan",
    ] {
        let text = format!("before `{OPEN}` {plan}");
        assert!(repair_text(&text, &native_citation_projection(&text)).is_none());
    }
    for body in [
        format!("`{OPEN}secret{CLOSE}`"),
        format!("```\n{OPEN}secret\n```"),
        format!("```\n{OPEN}\n``\n```\nsecret{CLOSE}"),
        format!("~~~~\n~~~\n{OPEN}\n~~~~\nsecret"),
        format!("{OPEN}invalid unclosed secret"),
    ] {
        let visible = repair_text(&body, &native_citation_projection(&body)).unwrap();
        assert!(!visible.contains("secret"));
    }
}

#[test]
fn missing_partial_oversized_and_cancelled_evidence_keep_native_events() {
    let text = format!("before `{OPEN}` raw suffix");
    for mode in ["missing", "partial", "oversized", "cancel"] {
        let harness = Harness::new();
        let mut repair = harness.repair(true);
        let event = normalized(&text);
        assert!(
            repair
                .submit(event.clone(), Some("final_answer"), false)
                .is_empty()
        );
        match mode {
            "partial" => {
                write!(
                    std::fs::OpenOptions::new()
                        .append(true)
                        .open(&harness.path)
                        .unwrap(),
                    "{{\"type\":"
                )
                .unwrap();
            }
            "oversized" => harness.append(raw(&"x".repeat(MAX_TEXT + 1))),
            "cancel" => harness.append(raw(&text)),
            _ => {}
        }
        let output = if mode == "cancel" {
            repair.abandon()
        } else {
            repair.drain(true)
        };
        assert_eq!(output, [event], "{mode}");
    }
}

#[test]
fn pending_limit_keeps_original_output_order_and_terminal_status() {
    let harness = Harness::new();
    let mut repair = harness.repair(true);
    let event = normalized(&format!("before `{OPEN}` raw suffix"));
    let mut expected = vec![event.clone()];
    let mut actual = repair.submit(event, Some("final_answer"), false);
    for id in 0..=MAX_PENDING_EVENTS {
        let tool = json!({"type":"item.started", "item":{"type":"command_execution", "id":id.to_string()}});
        expected.push(tool.clone());
        actual.extend(repair.submit(tool, None, false));
    }
    expected.push(terminal("turn.failed"));
    actual.extend(repair.submit(terminal("turn.failed"), None, true));
    assert_eq!(actual, expected);
}

#[test]
fn session_header_identity_is_required_for_post_resume_repair() {
    let text = format!("before `{OPEN}` observable suffix");
    for (kind, session_id, expected_text) in [
        (
            "session_meta",
            THREAD,
            "before `&lt;oai-mem-citation&gt;` observable suffix",
        ),
        ("session_meta", TURN, "before `"),
        ("response_item", THREAD, "before `"),
    ] {
        let harness = Harness::new();
        std::fs::write(
            &harness.path,
            format!("{}\n", json!({"type":kind,"payload":{"id":session_id}})),
        )
        .unwrap();
        let mut repair = harness.repair(true);
        // Append after the resume cursor is established so only the header
        // guard can reject otherwise repairable evidence in the invalid cases.
        harness.append(raw(&text));
        let event = normalized(&text);
        let mut expected = event.clone();
        expected["item"]["text"] = json!(expected_text);
        let mut events = repair.submit(event, Some("final_answer"), false);
        events.extend(repair.drain(true));
        assert_eq!(events, [expected], "{kind}, {session_id}");
    }
}

#[cfg(unix)]
#[test]
fn symlinked_session_descriptor_keeps_native_events() {
    let harness = Harness::new();
    let text = format!("before `{OPEN}` unrelated suffix");
    let outside = harness.home.path().join("outside.jsonl");
    std::fs::rename(&harness.path, &outside).unwrap();
    std::os::unix::fs::symlink(outside, &harness.path).unwrap();
    let mut repair = harness.repair(true);
    harness.append(raw(&text));
    let event = normalized(&text);
    let mut events = repair.submit(event.clone(), Some("final_answer"), false);
    events.extend(repair.drain(true));
    assert_eq!(events, [event]);
}
