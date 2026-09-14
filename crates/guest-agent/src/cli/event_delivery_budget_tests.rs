//! Exercise exact final requests and failure controls through the real sender.
use super::event_delivery::*;
use crate::env::Framework;
use crate::events;
use crate::http::HttpClient;
use crate::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::{Value, json};
use std::time::Duration;

const LIMIT: usize = 4 * 1024 * 1024;
const RUN_ID: &str = "delivery-\"\\-你好";

fn body(event: &Value, transport: bool) -> Result<String, String> {
    let mut public = event.clone();
    let citation = public
        .as_object_mut()
        .ok_or("event is not an object")?
        .remove("memoryCitation");
    let suffix = if transport {
        let citations = citation
            .map(|citation| json!({"sequenceNumber":19,"citation":citation}))
            .into_iter()
            .collect::<Vec<_>>();
        format!(
            ",\"piMemoryCitationTransport\":{{\"schemaVersion\":1,\"citations\":{}}}",
            json!(citations)
        )
    } else {
        public = event.clone();
        String::new()
    };
    Ok(format!(
        "{{\"runId\":{},\"events\":[{}]{suffix}}}",
        json!(RUN_ID),
        public
    ))
}

fn text_event(framework: Framework, text: &str) -> Value {
    let mut event = match framework {
        Framework::Pi => {
            json!({"type":"assistant","message":{"id":"message","role":"assistant","model":"test","usage":{"input_tokens":2},"content":[{"type":"text","text":text}]}})
        }
        _ => {
            json!({"type":"item.completed","thread_id":"thread","turn_id":"turn","item":{"id":"item","type":"agent_message","text":text}})
        }
    };
    if let Some(event) = event.as_object_mut() {
        event.insert("memoryCitation".into(), json!({"entries":[{"path":"memory.md","lineStart":1,"lineEnd":2,"note":"citation-你好\"\\\n"}],"rolloutIds":[]}));
    }
    events::prepare_event_for_delivery(event, 19, &SecretMasker::from_raw(""))
}

fn collaboration_event(states: Value) -> Result<Value, &'static str> {
    let receiver_ids = states
        .as_object()
        .ok_or("child states must be an object")?
        .keys()
        .collect::<Vec<_>>();
    Ok(events::prepare_event_for_delivery(
        json!({
            "type": "item.completed", "thread_id": "parent", "turn_id": "turn",
            "item": {
                "id": "wait", "type": "collab_agent_tool_call", "tool": "wait",
                "status": "completed", "sender_thread_id": "parent",
                "receiver_thread_ids": receiver_ids, "prompt": null,
                "model": "test-model", "reasoning_effort": "high", "agents_states": states,
            }
        }),
        19,
        &SecretMasker::from_raw(""),
    ))
}

#[tokio::test]
async fn sender_preserves_normal_bytes_and_accounts_for_exact_citation_envelopes() {
    for (framework, collaboration) in [
        (Framework::Pi, false),
        (Framework::Codex, false),
        (Framework::Codex, true),
    ] {
        let make_event = |text: &str| {
            if collaboration {
                collaboration_event(json!({
                    "status": {"status": "errored", "message": text},
                    "null-child": {"status": "running", "message": null},
                    "empty-child": {"status": "completed", "message": ""},
                }))
                .unwrap()
            } else {
                text_event(framework, text)
            }
        };
        for transport in [false, true] {
            for overflow in [None, Some(0), Some(1)] {
                let empty = make_event("");
                let retained = overflow.map_or(5, |extra| {
                    LIMIT - body(&empty, transport).unwrap().len() + extra
                });
                let event = make_event(&"x".repeat(retained));
                let expected = body(&event, transport).unwrap();
                if let Some(extra) = overflow {
                    assert_eq!(expected.len(), LIMIT + extra);
                }
                let expected_json: Value = serde_json::from_str(&expected).unwrap();
                let server = MockServer::start_async().await;
                let request = server.mock(|when, then| {
                    when.method(POST)
                        .path("/api/webhooks/agent/events")
                        .is_true(move |request| {
                            if overflow != Some(1) {
                                return request.body_ref() == expected.as_bytes();
                            }
                            let payload: Value =
                                serde_json::from_slice(request.body_ref()).unwrap();
                            request.body_ref().len() <= LIMIT
                                && request
                                    .body_string()
                                    .contains("bytes truncated for delivery")
                                && payload["piMemoryCitationTransport"]
                                    == expected_json["piMemoryCitationTransport"]
                                && payload["events"][0]["memoryCitation"]
                                    == expected_json["events"][0]["memoryCitation"]
                                && payload["events"][0]["sequenceNumber"] == 19
                                && (!collaboration || {
                                    let mut restored = payload["events"][0].clone();
                                    restored["item"]["agents_states"]["status"]["message"] =
                                        expected_json["events"][0]["item"]["agents_states"]
                                            ["status"]["message"]
                                            .clone();
                                    restored == expected_json["events"][0]
                                })
                        });
                    then.status(200);
                });
                let http = HttpClient::with_api_config(
                    server.base_url(),
                    "test-token",
                    "",
                    "test-session",
                    Duration::ZERO,
                )
                .unwrap();
                let runtime = EventDeliveryRuntime::start(http, RUN_ID, 19, transport).unwrap();
                runtime
                    .sender()
                    .try_send_for_framework(19, event, framework)
                    .unwrap();
                let report = runtime.finish().await.unwrap();
                assert_eq!(report.last_acknowledged_sequence, Some(19));
                assert!(report.diagnostic.is_none());
                request.assert_calls_async(1).await;
            }
        }
    }
}

#[tokio::test]
async fn collaboration_fallback_preserves_structure_beyond_content_discovery_limits() {
    for (child_count, key_bytes, message) in [
        (40, 0, Some("x".repeat(256 * 1024))),
        (300, 0, Some("x".repeat(32 * 1024))),
        (1500, 0, None),
        (1, 257, Some("x".repeat(LIMIT))),
        (30_000, 0, Some("\0".repeat(30))),
    ] {
        let mut states = serde_json::Map::new();
        for index in 0..child_count {
            let key = format!("child-{index:04}{}", "k".repeat(key_bytes));
            states.insert(key, json!({"status": "errored", "message": message}));
        }
        if message.is_none() {
            states.insert(
                "zz-last-child".into(),
                json!({"status": "completed", "message": "x".repeat(LIMIT)}),
            );
        }
        states.insert(
            "empty-child".into(),
            json!({"status": "running", "message": ""}),
        );
        states.insert(
            "null-child".into(),
            json!({"status": "pending_init", "message": null}),
        );
        states.insert(
            "short-child".into(),
            json!({"status": "completed", "message": "done"}),
        );
        let mut event = collaboration_event(Value::Object(states)).unwrap();
        event["item"]["prompt"] = json!("p".repeat(LIMIT));
        let mut expected = event.clone();
        expected["item"]["prompt"] = json!("[event content truncated for delivery]");
        for (child_id, state) in expected["item"]["agents_states"]
            .as_object_mut()
            .unwrap()
            .iter_mut()
        {
            if (child_id.starts_with("child-") || child_id == "zz-last-child")
                && state["message"].is_string()
            {
                state["message"] = json!("[event content truncated for delivery]");
            }
        }

        let server = MockServer::start_async().await;
        let request = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/events")
                .is_true(move |request| {
                    let payload: Value = serde_json::from_slice(request.body_ref()).unwrap();
                    let mut actual = payload["events"][0].clone();
                    for (child_id, state) in expected["item"]["agents_states"].as_object().unwrap()
                    {
                        if state["message"] == "[event content truncated for delivery]" {
                            let message = &mut actual["item"]["agents_states"][child_id]["message"];
                            // A per-field notice can be smaller than the fallback notice
                            // for short strings that expand under JSON escaping.
                            if !message.as_str().is_some_and(|text| {
                                text == "[event content truncated for delivery]"
                                    || text.contains("bytes truncated for delivery")
                            }) {
                                return false;
                            }
                            *message = state["message"].clone();
                        }
                    }
                    request.body_ref().len() <= LIMIT
                        && payload["events"].as_array().map(Vec::len) == Some(1)
                        && actual == expected
                });
            then.status(200);
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-session",
            Duration::ZERO,
        )
        .unwrap();
        let runtime = EventDeliveryRuntime::start(http, RUN_ID, 19, false).unwrap();
        runtime
            .sender()
            .try_send_for_framework(19, event, Framework::Codex)
            .unwrap();
        let report = runtime.finish().await.unwrap();
        assert_eq!(report.last_acknowledged_sequence, Some(19));
        assert!(report.diagnostic.is_none());
        request.assert_calls_async(1).await;
    }
}

#[tokio::test]
async fn impossible_citation_and_protected_core_fail_before_http() {
    let server = MockServer::start_async().await;
    let request = server.mock(|when, then| {
        when.method(POST);
        then.status(200);
    });
    for (framework, mut event) in [
        (Framework::Pi, text_event(Framework::Pi, "text")),
        (Framework::Pi, text_event(Framework::Pi, "text")),
        (Framework::Codex, text_event(Framework::Codex, "text")),
        (
            Framework::Codex,
            collaboration_event(json!({"child": {"status": "errored", "message": "text"}}))
                .unwrap(),
        ),
        (
            Framework::Codex,
            collaboration_event(json!({"child": {"status": "errored", "message": "text"}}))
                .unwrap(),
        ),
        (
            Framework::Codex,
            collaboration_event(json!({"child": {"status": "errored", "message": "text"}}))
                .unwrap(),
        ),
    ]
    .into_iter()
    .enumerate()
    .map(|(i, (framework, mut event))| {
        match i {
            0 => event["memoryCitation"]["entries"][0]["note"] = json!("x".repeat(LIMIT)),
            1 => event["message"]["id"] = json!("x".repeat(LIMIT)),
            2 => event["item"]["id"] = json!("x".repeat(LIMIT)),
            3 => event["item"]["receiver_thread_ids"] = json!(["x".repeat(LIMIT)]),
            4 => {
                event["item"]["agents_states"] =
                    json!({"x".repeat(LIMIT): {"status": "errored", "message": "text"}})
            }
            _ => event["item"]["reasoning_effort"] = json!("x".repeat(LIMIT)),
        }
        (framework, event)
    }) {
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-session",
            Duration::ZERO,
        )
        .unwrap();
        let runtime = EventDeliveryRuntime::start(http, RUN_ID, 19, true).unwrap();
        let error = runtime
            .sender()
            .try_send_for_framework(19, event.take(), framework)
            .unwrap_err();
        assert!(error.to_string().contains("serialized event budget"));
        assert!(runtime.finish().await.unwrap().last_acknowledged_sequence == Some(18));
    }
    request.assert_calls_async(0).await;
}

#[tokio::test]
async fn reduced_http_failure_still_breaks_acknowledgement_and_retries_identical_bytes() {
    let server = MockServer::start_async().await;
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Vec<u8>>::new()));
    let captured = seen.clone();
    let request = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .is_true(move |request| {
                captured.lock().unwrap().push(request.body_vec());
                request.body_ref().len() <= LIMIT
                    && request
                        .body_string()
                        .contains("bytes truncated for delivery")
            });
        then.status(500);
    });
    let http = HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "",
        "test-session",
        Duration::ZERO,
    )
    .unwrap();
    let runtime = EventDeliveryRuntime::start(http, RUN_ID, 19, true).unwrap();
    runtime
        .sender()
        .try_send_for_framework(
            19,
            text_event(Framework::Pi, &"x".repeat(LIMIT)),
            Framework::Pi,
        )
        .unwrap();
    let report = runtime.finish().await.unwrap();
    assert_eq!(report.last_acknowledged_sequence, Some(18));
    assert!(report.diagnostic.is_some());
    assert!(request.calls_async().await > 1);
    let requests = seen.lock().unwrap();
    assert!(requests.len() > 1);
    assert!(requests.iter().all(|body| body == &requests[0]));
}
