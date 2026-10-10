use super::*;
use serde_json::{Value, json};

const TEST_RUN_ID: &str = "run-1";
const TEST_INITIAL_PROMPT: &str = "initial";

fn enabled_runtime() -> ActiveInputRuntime {
    enabled_runtime_with_initial_prompt(TEST_INITIAL_PROMPT)
}

fn enabled_runtime_with_initial_prompt(initial_prompt: &str) -> ActiveInputRuntime {
    ActiveInputRuntime::new_for_test(TEST_RUN_ID, initial_prompt)
}

fn active_input_uuid(sequence: u64) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("vm0:{TEST_RUN_ID}:active-input-test:{sequence}").as_bytes(),
    )
    .to_string()
}

fn active_input_payload(sequence: u64, text: &str) -> Vec<u8> {
    guest_contracts::active_input::encode_active_input(&active_input_uuid(sequence), text)
        .expect("active input payload should serialize")
}

fn accept_active_input(controller: &ActiveInputController, sequence: u64, text: &str) -> String {
    assert_eq!(
        controller.handle_control_payload(&active_input_payload(sequence, text)),
        ActiveInputControlOutcome::Accepted
    );
    active_input_uuid(sequence)
}

fn mark_accepted(controller: &ActiveInputController, uuid: &str, expects_replay: bool) {
    controller
        .mark_backend_accepted(
            &ActiveInputFrame {
                uuid: uuid.to_owned(),
                text: String::new(),
            },
            expects_replay,
        )
        .expect("test acceptance should be recorded");
}

fn user_event(uuid: &str, text: &str) -> Value {
    json!({
        "type": "user",
        "uuid": uuid,
        "message": {"role": "user", "content": text}
    })
}

fn uuidless_user_event(text: &str) -> Value {
    json!({
        "type": "user",
        "message": {"role": "user", "content": text}
    })
}

fn uuidless_text_block_user_event(text: &str) -> Value {
    json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": text}]
        }
    })
}

fn assert_pending(controller: &ActiveInputController, uuid: &str) {
    let state = controller
        .inner
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    assert!(state.pending_by_uuid.contains_key(uuid));
}

fn assert_not_pending(controller: &ActiveInputController, uuid: &str) {
    let state = controller
        .inner
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    assert!(!state.pending_by_uuid.contains_key(uuid));
}

#[test]
fn active_input_accepts_each_valid_payload() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();

    assert_eq!(
        controller.handle_control_payload(&active_input_payload(0, "hello")),
        ActiveInputControlOutcome::Accepted
    );
    assert_eq!(
        controller.handle_control_payload(&active_input_payload(1, "hello again")),
        ActiveInputControlOutcome::Accepted
    );
}

#[test]
fn active_input_rejects_invalid_payloads() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();

    for (case, payload, expected_diagnostic) in [
        (
            "bad-json",
            br#"{"type":"active-input""#.as_slice(),
            "active input payload is invalid",
        ),
        (
            "bad-type",
            br#"{"type":"other","eventId":"223f8797-a456-4eea-98f7-f7ab88c43c00","text":"hello"}"#.as_slice(),
            "active input payload type is unsupported",
        ),
        (
            "empty",
            br#"{"type":"active-input","eventId":"223f8797-a456-4eea-98f7-f7ab88c43c00","text":""}"#.as_slice(),
            "active input text is empty",
        ),
        (
            "missing-event-id",
            br#"{"type":"active-input","text":"hello"}"#.as_slice(),
            "active input payload is invalid",
        ),
        (
            "null-event-id",
            br#"{"type":"active-input","eventId":null,"text":"hello"}"#.as_slice(),
            "active input payload is invalid",
        ),
        (
            "malformed-event-id",
            br#"{"type":"active-input","eventId":"invalid","text":"hello"}"#.as_slice(),
            "active input event id is invalid",
        ),
        (
            "noncanonical-event-id",
            br#"{"type":"active-input","eventId":"223F8797-A456-4EEA-98F7-F7AB88C43C00","text":"hello"}"#.as_slice(),
            "active input event id is not canonical",
        ),
    ] {
        assert!(
            matches!(
                controller.handle_control_payload(payload),
                ActiveInputControlOutcome::Rejected { diagnostic }
                    if diagnostic == expected_diagnostic
            ),
            "payload should reject: {case}"
        );
    }
}

#[test]
fn active_input_rejects_when_disabled_or_closed() {
    let disabled = ActiveInputRuntime::new_disabled("run-1", "initial");
    assert!(matches!(
        disabled
            .controller()
            .handle_control_payload(br#"{"type":"active-input","text":"hello"}"#),
        ActiveInputControlOutcome::Rejected { diagnostic }
            if diagnostic == "active input is not supported for this agent"
    ));

    let runtime = enabled_runtime();
    let controller = runtime.controller();
    assert!(controller.close_for_result_if_idle());
    assert!(matches!(
        controller.handle_control_payload(&active_input_payload(0, "hello")),
        ActiveInputControlOutcome::Rejected { diagnostic } if diagnostic == "active input is closed"
    ));
}

#[test]
fn active_input_capacity_counts_pending_inputs() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();

    for index in 0..ACTIVE_INPUT_QUEUE_CAPACITY {
        assert_eq!(
            controller.handle_control_payload(&active_input_payload(index as u64, "hello")),
            ActiveInputControlOutcome::Accepted
        );
    }

    assert!(matches!(
        controller.handle_control_payload(&active_input_payload(100, "hello")),
        ActiveInputControlOutcome::QueueFull { diagnostic } if diagnostic == "active input queue is full"
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn active_input_can_release_capacity_for_sink_without_replay() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let mut writer = runtime.into_writer();

    for index in 0..ACTIVE_INPUT_QUEUE_CAPACITY {
        assert_eq!(
            controller.handle_control_payload(&active_input_payload(index as u64, "hello")),
            ActiveInputControlOutcome::Accepted
        );
        let frame = writer
            .next_frame()
            .await
            .expect("active input frame should be queued");
        writer.mark_writing(&frame.uuid);
        writer
            .mark_backend_accepted_without_replay(&frame)
            .expect("test acceptance should be recorded");
        assert_not_pending(&controller, &frame.uuid);
    }

    assert_eq!(
        controller.handle_control_payload(&active_input_payload(100, "next")),
        ActiveInputControlOutcome::Accepted
    );
    let _frame = writer
        .next_frame()
        .await
        .expect("new active input frame should be queued after delivered frames release capacity");
}

#[test]
fn replay_filter_consumes_initial_and_active_input_user_events() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "hello");

    let initial = json!({
        "type": "user",
        "uuid": claude_initial_prompt_uuid(TEST_RUN_ID),
        "message": {"role": "user", "content": "initial"}
    });
    assert_eq!(
        controller.replay_user_event_action(&initial),
        ReplayUserEventAction::InternalInitialPrompt
    );
    mark_accepted(&controller, &active_uuid, true);

    let active = user_event(&active_uuid, "follow-up");
    assert_eq!(
        controller.replay_user_event_action(&active),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_keeps_tool_result_user_events_external() {
    let runtime = enabled_runtime();
    let event = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "tool-1"}]
        }
    });

    assert_eq!(
        runtime.controller().replay_user_event_action(&event),
        ReplayUserEventAction::External
    );
}

#[test]
fn replay_filter_keeps_multi_tool_result_user_events_external() {
    let runtime = enabled_runtime();
    let event = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "tool-1"},
                {"type": "tool_result", "tool_use_id": "tool-2"}
            ]
        }
    });

    assert_eq!(
        runtime.controller().replay_user_event_action(&event),
        ReplayUserEventAction::External
    );
}

#[test]
fn replay_filter_filters_mixed_text_and_tool_result_user_events() {
    let runtime = enabled_runtime();
    let event = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {"type": "text", "text": "prompt-like text"},
                {"type": "tool_result", "tool_use_id": "tool-1"}
            ]
        }
    });

    assert_eq!(
        runtime.controller().replay_user_event_action(&event),
        ReplayUserEventAction::UnknownPromptUser
    );
}

#[test]
fn replay_filter_consumes_matching_uuid_even_with_non_string_content() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "hello");

    let initial = json!({
        "type": "user",
        "uuid": claude_initial_prompt_uuid(TEST_RUN_ID),
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": "initial"}]
        }
    });
    assert_eq!(
        controller.replay_user_event_action(&initial),
        ReplayUserEventAction::InternalInitialPrompt
    );
    mark_accepted(&controller, &active_uuid, true);

    let active = json!({
        "type": "user",
        "uuid": active_uuid,
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": "follow-up"}]
        }
    });
    assert_eq!(
        controller.replay_user_event_action(&active),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_does_not_consume_accepted_uuid_before_writer_owns_input() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    let stale = user_event(&active_uuid, "follow-up");

    assert_eq!(
        controller.replay_user_event_action(&stale),
        ReplayUserEventAction::UnknownPromptUser
    );
    assert!(!controller.close_for_result_if_idle());

    controller.mark_writing(&active_uuid);
    let replay = user_event(&active_uuid, "follow-up");
    assert_eq!(
        controller.replay_user_event_action(&replay),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_treats_text_block_user_events_without_uuid_as_unknown_prompt() {
    let runtime = enabled_runtime();
    let event = uuidless_text_block_user_event("follow-up");

    assert_eq!(
        runtime.controller().replay_user_event_action(&event),
        ReplayUserEventAction::UnknownPromptUser
    );
}

#[test]
fn replay_filter_consumes_uuidless_active_input_replay_by_text() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    mark_accepted(&controller, &active_uuid, true);
    assert!(!controller.close_for_result_if_idle());

    let event = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_consumes_oldest_uuidless_text_match() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();

    for sequence in 0..2 {
        assert_eq!(
            controller.handle_control_payload(&active_input_payload(sequence, "same-text")),
            ActiveInputControlOutcome::Accepted
        );
    }
    let first_uuid = active_input_uuid(0);
    let second_uuid = active_input_uuid(1);
    mark_accepted(&controller, &first_uuid, true);
    mark_accepted(&controller, &second_uuid, true);
    assert!(!controller.close_for_result_if_idle());

    let event = uuidless_user_event("same-text");
    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::InternalActiveInput
    );
    assert_not_pending(&controller, &first_uuid);
    assert_pending(&controller, &second_uuid);

    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_defers_uuidless_text_match_while_writing_until_written() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    controller.mark_writing(&active_uuid);
    assert!(!controller.close_for_result_if_idle());

    let event = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::InternalActiveInput
    );
    assert_pending(&controller, &active_uuid);

    mark_accepted(&controller, &active_uuid, true);
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_clears_multiple_uuidless_writing_replays_after_writes() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();

    for (sequence, text) in [(0, "first"), (1, "second")] {
        let payload = active_input_payload(sequence, text);
        assert_eq!(
            controller.handle_control_payload(&payload),
            ActiveInputControlOutcome::Accepted
        );
    }
    let first_uuid = active_input_uuid(0);
    let second_uuid = active_input_uuid(1);
    assert!(!controller.close_for_result_if_idle());

    for (uuid, text) in [(&first_uuid, "first"), (&second_uuid, "second")] {
        controller.mark_writing(uuid);
        let event = json!({
            "type": "user",
            "message": {"role": "user", "content": text}
        });
        assert_eq!(
            controller.replay_user_event_action(&event),
            ReplayUserEventAction::InternalActiveInput
        );
        mark_accepted(&controller, uuid, true);
    }

    assert!(controller.close_for_result_if_idle());
}

#[test]
fn followup_result_can_close_after_uuidless_replay_before_backend_acceptance() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    assert!(!controller.close_for_result_if_idle());

    controller.mark_writing(&active_uuid);
    let event = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::InternalActiveInput
    );

    assert!(controller.close_for_result_if_idle());
    mark_accepted(&controller, &active_uuid, true);
    assert!(matches!(
        controller.handle_control_payload(&active_input_payload(1, "late")),
        ActiveInputControlOutcome::Rejected { diagnostic } if diagnostic == "active input is closed"
    ));
}

#[test]
fn mark_writing_does_not_regress_replay_observed_pending_input() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    assert!(!controller.close_for_result_if_idle());

    controller.mark_writing(&active_uuid);
    let event = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::InternalActiveInput
    );

    controller.mark_writing(&active_uuid);
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_does_not_consume_unwritten_uuidless_text_match() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    assert_eq!(
        controller.handle_control_payload(&active_input_payload(0, "same-text")),
        ActiveInputControlOutcome::Accepted
    );

    let event = uuidless_user_event("same-text");
    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::UnknownPromptUser
    );
    assert!(!controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_does_not_consume_uuidless_text_match_before_first_result() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "same-text");
    mark_accepted(&controller, &active_uuid, true);

    let event = uuidless_user_event("same-text");
    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::UnknownPromptUser
    );
    assert!(!controller.close_for_result_if_idle());
}

#[test]
fn followup_result_closes_writer_owned_pending_input_without_replay() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    mark_accepted(&controller, &active_uuid, true);

    assert!(!controller.close_for_result_if_idle());
    assert!(controller.close_for_result_if_idle());
    assert!(matches!(
        controller.handle_control_payload(&active_input_payload(1, "late")),
        ActiveInputControlOutcome::Rejected { diagnostic } if diagnostic == "active input is closed"
    ));
}

#[test]
fn followup_result_without_replay_completes_one_written_pending_input_at_a_time() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();

    for sequence in 0..2 {
        assert_eq!(
            controller.handle_control_payload(&active_input_payload(sequence, "follow-up")),
            ActiveInputControlOutcome::Accepted
        );
    }
    let first_uuid = active_input_uuid(0);
    let second_uuid = active_input_uuid(1);
    mark_accepted(&controller, &first_uuid, true);
    mark_accepted(&controller, &second_uuid, true);

    assert!(!controller.close_for_result_if_idle());
    assert!(!controller.close_for_result_if_idle());
    assert_not_pending(&controller, &first_uuid);
    assert_pending(&controller, &second_uuid);
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn followup_result_without_replay_keeps_later_unwritten_pending_input_open() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();

    for sequence in 0..2 {
        assert_eq!(
            controller.handle_control_payload(&active_input_payload(sequence, "follow-up")),
            ActiveInputControlOutcome::Accepted
        );
    }
    let first_uuid = active_input_uuid(0);
    let second_uuid = active_input_uuid(1);
    mark_accepted(&controller, &first_uuid, true);

    assert!(!controller.close_for_result_if_idle());
    assert!(!controller.close_for_result_if_idle());
    assert_not_pending(&controller, &first_uuid);
    assert_pending(&controller, &second_uuid);
    assert!(!controller.close_for_result_if_idle());

    mark_accepted(&controller, &second_uuid, true);
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn followup_result_keeps_writing_pending_input_open_without_replay() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    controller.mark_writing(&active_uuid);

    assert!(!controller.close_for_result_if_idle());
    assert!(!controller.close_for_result_if_idle());
    mark_accepted(&controller, &active_uuid, true);
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn followup_result_keeps_unwritten_pending_input_open_without_replay() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    assert_eq!(
        controller.handle_control_payload(&active_input_payload(0, "follow-up")),
        ActiveInputControlOutcome::Accepted
    );

    assert!(!controller.close_for_result_if_idle());
    assert!(!controller.close_for_result_if_idle());
    assert_eq!(
        controller.handle_control_payload(&active_input_payload(1, "still-open")),
        ActiveInputControlOutcome::Accepted
    );
}

#[test]
fn replay_filter_consumes_uuidless_text_match_after_initial_replay_before_first_result() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    mark_accepted(&controller, &active_uuid, true);

    let initial = uuidless_user_event("initial");
    assert_eq!(
        controller.replay_user_event_action(&initial),
        ReplayUserEventAction::UnknownPromptUser
    );

    let active = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&active),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_does_not_consume_text_match_with_unknown_uuid() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    mark_accepted(&controller, &active_uuid, true);
    assert!(!controller.close_for_result_if_idle());

    let unknown_uuid = json!({
        "type": "user",
        "uuid": "not-vm0-active-input",
        "message": {"role": "user", "content": "follow-up"}
    });
    assert_eq!(
        controller.replay_user_event_action(&unknown_uuid),
        ReplayUserEventAction::UnknownPromptUser
    );

    let uuidless = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&uuidless),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_does_not_consume_text_match_with_non_string_uuid() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    mark_accepted(&controller, &active_uuid, true);
    assert!(!controller.close_for_result_if_idle());

    for uuid in [json!(123), Value::Null] {
        let event = json!({
            "type": "user",
            "uuid": uuid,
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&event),
            ReplayUserEventAction::UnknownPromptUser
        );
    }

    let uuidless = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&uuidless),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_does_not_unlock_initial_prompt_from_unknown_uuid() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    mark_accepted(&controller, &active_uuid, true);

    let unknown_uuid_initial_text = json!({
        "type": "user",
        "uuid": "not-vm0-initial-prompt",
        "message": {"role": "user", "content": "initial"}
    });
    assert_eq!(
        controller.replay_user_event_action(&unknown_uuid_initial_text),
        ReplayUserEventAction::UnknownPromptUser
    );

    let active_before_initial = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&active_before_initial),
        ReplayUserEventAction::UnknownPromptUser
    );

    let initial = json!({
        "type": "user",
        "uuid": claude_initial_prompt_uuid(TEST_RUN_ID),
        "message": {"role": "user", "content": "initial"}
    });
    assert_eq!(
        controller.replay_user_event_action(&initial),
        ReplayUserEventAction::InternalInitialPrompt
    );

    let active_after_initial = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&active_after_initial),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_does_not_unlock_initial_prompt_from_non_string_uuid() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    mark_accepted(&controller, &active_uuid, true);

    let malformed_initial = json!({
        "type": "user",
        "uuid": 123,
        "message": {"role": "user", "content": "initial"}
    });
    assert_eq!(
        controller.replay_user_event_action(&malformed_initial),
        ReplayUserEventAction::UnknownPromptUser
    );

    let active_before_initial = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&active_before_initial),
        ReplayUserEventAction::UnknownPromptUser
    );

    let initial = uuidless_user_event("initial");
    assert_eq!(
        controller.replay_user_event_action(&initial),
        ReplayUserEventAction::UnknownPromptUser
    );

    let active_after_initial = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&active_after_initial),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_waits_for_second_uuidless_same_text_before_first_result() {
    let runtime = enabled_runtime_with_initial_prompt("same-text");
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "same-text");
    mark_accepted(&controller, &active_uuid, true);

    let initial = uuidless_user_event("same-text");
    assert_eq!(
        controller.replay_user_event_action(&initial),
        ReplayUserEventAction::UnknownPromptUser
    );

    let active = uuidless_user_event("same-text");
    assert_eq!(
        controller.replay_user_event_action(&active),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_consumes_uuidless_text_block_active_input_replay() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    mark_accepted(&controller, &active_uuid, true);
    assert!(!controller.close_for_result_if_idle());

    let event = uuidless_text_block_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_filters_unknown_user_content_blocks() {
    let runtime = enabled_runtime();

    for content in [
        json!([{"type": "image", "source": "future-schema"}]),
        json!({"type": "future-schema"}),
        json!([]),
    ] {
        let event = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": content
            }
        });

        assert_eq!(
            runtime.controller().replay_user_event_action(&event),
            ReplayUserEventAction::UnknownPromptUser
        );
    }
}

#[test]
fn replay_filter_keeps_non_user_role_events_external_without_advancing_prompt_replay() {
    let runtime = enabled_runtime_with_initial_prompt("follow-up");
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    mark_accepted(&controller, &active_uuid, true);

    let malformed = json!({
        "type": "user",
        "message": {"role": "assistant", "content": "follow-up"}
    });
    assert_eq!(
        controller.replay_user_event_action(&malformed),
        ReplayUserEventAction::External
    );

    let first_valid_prompt_like = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&first_valid_prompt_like),
        ReplayUserEventAction::UnknownPromptUser
    );

    let second_valid_prompt_like = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&second_valid_prompt_like),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_keeps_non_user_role_uuid_matches_external() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    mark_accepted(&controller, &active_uuid, true);

    let malformed = json!({
        "type": "user",
        "uuid": active_uuid,
        "message": {"role": "assistant", "content": "follow-up"}
    });
    assert_eq!(
        controller.replay_user_event_action(&malformed),
        ReplayUserEventAction::External
    );

    let replay = json!({
        "type": "user",
        "uuid": active_input_uuid(0),
        "message": {"role": "user", "content": "follow-up"}
    });
    assert_eq!(
        controller.replay_user_event_action(&replay),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_keeps_non_string_role_events_external() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    mark_accepted(&controller, &active_uuid, true);

    let malformed = json!({
        "type": "user",
        "uuid": active_uuid,
        "message": {"role": 123, "content": "follow-up"}
    });
    assert_eq!(
        controller.replay_user_event_action(&malformed),
        ReplayUserEventAction::External
    );

    let replay = json!({
        "type": "user",
        "uuid": active_input_uuid(0),
        "message": {"role": "user", "content": "follow-up"}
    });
    assert_eq!(
        controller.replay_user_event_action(&replay),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_keeps_child_user_events_external() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    mark_accepted(&controller, &active_uuid, true);

    let child = json!({
        "type": "user",
        "uuid": active_uuid,
        "parent_tool_use_id": "tool-1",
        "message": {"role": "user", "content": "follow-up"}
    });
    assert_eq!(
        controller.replay_user_event_action(&child),
        ReplayUserEventAction::External
    );

    let replay = json!({
        "type": "user",
        "uuid": active_input_uuid(0),
        "parent_tool_use_id": null,
        "message": {"role": "user", "content": "follow-up"}
    });
    assert_eq!(
        controller.replay_user_event_action(&replay),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_does_not_unlock_uuidless_match_from_non_initial_prompt_like_event() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "follow-up");
    mark_accepted(&controller, &active_uuid, true);

    let historical = uuidless_user_event("historical");
    assert_eq!(
        controller.replay_user_event_action(&historical),
        ReplayUserEventAction::UnknownPromptUser
    );

    let active_before_initial = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&active_before_initial),
        ReplayUserEventAction::UnknownPromptUser
    );

    let initial = uuidless_user_event("initial");
    assert_eq!(
        controller.replay_user_event_action(&initial),
        ReplayUserEventAction::UnknownPromptUser
    );

    let active_after_initial = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&active_after_initial),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}
