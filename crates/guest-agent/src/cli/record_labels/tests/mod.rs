use super::*;
use serde_json::Value;

/// Records are written as literal bytes: producers serialize `type` first,
/// while `serde_json` would reorder the keys of a constructed value.
const TRUNCATED_PI_TOOL_RESULT: &str = concat!(
    r#"{"type":"message_end","message":{"role":"toolResult","toolCallId":"call-1","#,
    r#""toolName":"edit","isError":false,"content":[{"type":"text","text":"@@ -1,"#,
);
const TRUNCATED_PROJECTED_TOOL_RESULT: &str = concat!(
    r#"{"type":"user","session_id":"session","message":{"role":"user","content":"#,
    r#"[{"type":"tool_result","tool_use_id":"call-1","content":[{"type":"text","#,
    r#""text":"@@ -1,"#,
);

#[test]
fn truncated_record_prefixes_keep_their_labels() {
    for (record, expected) in [
        (
            TRUNCATED_PI_TOOL_RESULT,
            EventLabels {
                event_type: "message_end",
                item_type: "toolResult",
            },
        ),
        (
            TRUNCATED_PROJECTED_TOOL_RESULT,
            EventLabels {
                event_type: "user",
                item_type: "tool_result",
            },
        ),
    ] {
        assert!(
            serde_json::from_str::<Value>(record).is_err(),
            "a mid-record prefix is not parsable JSON"
        );
        assert_eq!(prefix_labels(record.as_bytes()), expected);
    }
}

#[test]
fn labels_outside_the_window_are_unknown() {
    let beyond_window = "x".repeat(LABEL_SCAN_WINDOW_BYTES);
    let no_labels = format!(r#"{{"padding":"{beyond_window}","type":"assistant","#);
    assert_eq!(prefix_labels(no_labels.as_bytes()), EventLabels::UNKNOWN);

    let no_content = format!(
        r#"{{"type":"assistant","message":{{"id":"{beyond_window}","content":[{{"type":"text""#
    );
    assert_eq!(
        prefix_labels(no_content.as_bytes()),
        EventLabels {
            event_type: "assistant",
            item_type: UNKNOWN_LABEL,
        }
    );

    for empty in ["", "{", r#"{"type":"#, r#"{"type":"assist"#] {
        assert_eq!(prefix_labels(empty.as_bytes()), EventLabels::UNKNOWN);
    }
}

#[test]
fn unrecognized_values_stay_bounded_tokens() {
    let record = concat!(
        r#"{"type":"unpublished_record","message":{"role":"unpublished_role","#,
        r#""content":[{"type":"unpublished_block","#,
    );
    assert_eq!(
        prefix_labels(record.as_bytes()),
        EventLabels {
            event_type: "other",
            item_type: UNKNOWN_LABEL,
        }
    );

    let message = concat!(
        r#"{"type":"message_end","message":{"role":"unpublished_role","#,
        r#""content":[{"type":"text","#,
    );
    assert_eq!(
        prefix_labels(message.as_bytes()),
        EventLabels {
            event_type: "message_end",
            item_type: "other",
        }
    );

    let block = r#"{"type":"assistant","message":{"content":[{"type":"unpublished_block","#;
    assert_eq!(
        prefix_labels(block.as_bytes()),
        EventLabels {
            event_type: "assistant",
            item_type: "other",
        }
    );
}

#[test]
fn loop_and_turn_boundaries_keep_their_labels() {
    for record_type in ["agent_end", "turn_end"] {
        let record = format!(r#"{{"type":"{record_type}","messages":["#);
        assert_eq!(
            prefix_labels(record.as_bytes()),
            EventLabels {
                event_type: record_type,
                item_type: UNKNOWN_LABEL,
            }
        );
    }
}

#[test]
fn values_that_are_not_bare_tokens_are_not_labels() {
    let long = "t".repeat(MAX_LABEL_TOKEN_BYTES + 1);
    for record in [
        format!(r#"{{"type":"{long}","message":{{"content":[{{"type":"text","#),
        r#"{"type":"assi\u0073tant","message":{"content":[{"type":"text","#.to_string(),
        r#"{"type":9,"message":{"content":[{"type":"text","#.to_string(),
        r#"{"type"#.to_string(),
    ] {
        assert_eq!(prefix_labels(record.as_bytes()), EventLabels::UNKNOWN);
    }
}

#[test]
fn prefix_labels_match_the_delivery_labels_of_a_whole_record() {
    for record in [
        r#"{"type":"assistant","message":{"id":"m","type":"message","role":"assistant","content":[{"type":"text","text":"hello"}]}}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"call-1","name":"edit","input":{}}]}}"#,
        r#"{"type":"user","session_id":"session","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-1","content":[]}]}}"#,
        r#"{"type":"system","subtype":"init","message":{"content":[{"type":"text","text":"ready"}]}}"#,
    ] {
        let parsed = serde_json::from_str::<Value>(record).expect("record fixture");
        let (event_type, item_type) = super::super::message_event_delivery::labels(&parsed);
        assert_eq!(
            prefix_labels(record.as_bytes()),
            EventLabels {
                event_type,
                item_type,
            }
        );
    }
}

#[test]
fn size_buckets_name_ranges_without_exact_sizes() {
    const MIB: usize = 1024 * 1024;
    for (bytes, expected) in [
        (0, "<1MiB"),
        (MIB - 1, "<1MiB"),
        (MIB, "1-2MiB"),
        (3 * MIB, "2-4MiB"),
        (4 * MIB, "4-8MiB"),
        (8 * MIB, "8-16MiB"),
        (16 * MIB, ">=16MiB"),
        (usize::MAX, ">=16MiB"),
    ] {
        assert_eq!(size_bucket(bytes), expected);
    }
}
