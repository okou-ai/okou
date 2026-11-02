use super::*;
use std::time::Duration;

fn track_tool_use(tracker: &mut StuckToolTracker, id: &str, name: &str) {
    let event = serde_json::json!({
        "type": "assistant",
        "message": {
            "content": [{"type": "tool_use", "id": id, "name": name}]
        }
    });

    track_claude_tool_events(&event, tracker);
}

fn track_tool_result(tracker: &mut StuckToolTracker, id: &str) {
    let event = serde_json::json!({
        "type": "user",
        "message": {
            "content": [{"type": "tool_result", "tool_use_id": id}]
        }
    });

    track_claude_tool_events(&event, tracker);
}

fn fill_stuck_tool_tracker(tracker: &mut StuckToolTracker) {
    for index in 0..MAX_TRACKED_STUCK_TOOLS {
        track_tool_use(tracker, &format!("tool-{index}"), "WebFetch");
    }
}

#[test]
fn track_claude_tools_updates_in_flight_state() {
    let mut tracker = StuckToolTracker::new();

    track_tool_use(&mut tracker, "tool-1", "WebFetch");
    assert!(tracker.contains_key("tool-1"));

    track_tool_result(&mut tracker, "tool-1");
    assert_eq!(tracker.len(), 0);
}

#[test]
fn stuck_tool_tracker_enforces_capacity_and_reuses_freed_slot() {
    let mut tracker = StuckToolTracker::new();
    fill_stuck_tool_tracker(&mut tracker);

    assert_eq!(tracker.len(), MAX_TRACKED_STUCK_TOOLS);

    track_tool_use(&mut tracker, "overflow", "WebSearch");

    assert_eq!(tracker.len(), MAX_TRACKED_STUCK_TOOLS);
    assert!(!tracker.contains_key("overflow"));
    for index in 0..MAX_TRACKED_STUCK_TOOLS {
        assert!(tracker.contains_key(&format!("tool-{index}")));
    }

    track_tool_result(&mut tracker, "tool-0");

    assert_eq!(tracker.len(), MAX_TRACKED_STUCK_TOOLS - 1);
    assert!(!tracker.contains_key("tool-0"));

    track_tool_use(&mut tracker, "later", "WebSearch");

    assert_eq!(tracker.len(), MAX_TRACKED_STUCK_TOOLS);
    assert!(tracker.contains_key("later"));
}

#[tokio::test(start_paused = true)]
async fn stuck_tool_tracker_refreshes_duplicate_at_capacity() {
    let mut tracker = StuckToolTracker::new();
    fill_stuck_tool_tracker(&mut tracker);
    tokio::time::advance(Duration::from_secs(1)).await;

    track_tool_use(&mut tracker, "tool-0", "WebSearch");

    assert_eq!(tracker.len(), MAX_TRACKED_STUCK_TOOLS);
    for index in 1..MAX_TRACKED_STUCK_TOOLS {
        track_tool_result(&mut tracker, &format!("tool-{index}"));
    }
    assert_eq!(tracker.len(), 1);
    assert_eq!(tracker.oldest_expired(1), None);
    assert_eq!(
        tracker.oldest_expired(0).map(|(name, _)| name),
        Some(StuckToolName::WebSearch)
    );
}

#[test]
fn stuck_tool_tracker_ignores_unsupported_tools() {
    let mut tracker = StuckToolTracker::new();

    track_tool_use(&mut tracker, "unsupported", "Bash");

    assert_eq!(tracker.len(), 0);
    assert!(!tracker.contains_key("unsupported"));
}

#[test]
fn stuck_tool_tracker_enforces_id_size_limit() {
    let mut tracker = StuckToolTracker::new();
    let maximum_id = "x".repeat(MAX_TRACKED_STUCK_TOOL_ID_BYTES);
    let oversized_id = "y".repeat(MAX_TRACKED_STUCK_TOOL_ID_BYTES + 1);

    track_tool_use(&mut tracker, &maximum_id, "WebFetch");
    track_tool_use(&mut tracker, &oversized_id, "WebFetch");

    assert_eq!(tracker.len(), 1);
    assert!(tracker.contains_key(&maximum_id));
    assert!(!tracker.contains_key(&oversized_id));
}
