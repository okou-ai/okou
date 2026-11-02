//! Smoke test: publish messages via the real Ably REST API and verify reception.
//!
//! Requires a real Ably API key in the `ABLY_API_KEY` environment variable.
//! Provision it with a secret manager or hidden shell prompt; do not put the
//! value in the command itself.
//!
//! ```sh
//! cargo run -p ably-subscriber --example smoke_test
//! ```
//!
//! `ABLY_API_KEY` format: `keyName:keySecret` (from your Ably dashboard).
//! Each REST publish, including error-body reading, has a 10-second deadline.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;

use ably_subscriber::{Event, SubscribeConfig, subscribe};

mod common;

const PUBLISH_TIMEOUT: Duration = Duration::from_secs(10);

/// A test case: publish `data` with optional `encoding`, expect `expected` back.
struct TestCase {
    /// Display label and message name (None = publish without a name field).
    label: &'static str,
    name: Option<&'static str>,
    data: serde_json::Value,
    encoding: Option<&'static str>,
    expected_name: Option<&'static str>,
    expected_data: serde_json::Value,
}

fn test_cases() -> Vec<TestCase> {
    vec![
        // --- Core JSON types ---
        TestCase {
            label: "json-object",
            name: Some("json-object"),
            data: serde_json::json!({"key": "value"}),
            encoding: None,
            expected_name: Some("json-object"),
            expected_data: serde_json::json!({"key": "value"}),
        },
        TestCase {
            label: "json-array",
            name: Some("json-array"),
            data: serde_json::json!([1, 2, 3]),
            encoding: None,
            expected_name: Some("json-array"),
            expected_data: serde_json::json!([1, 2, 3]),
        },
        TestCase {
            label: "string",
            name: Some("string"),
            data: serde_json::json!("hello world"),
            encoding: None,
            expected_name: Some("string"),
            expected_data: serde_json::json!("hello world"),
        },
        TestCase {
            label: "nested",
            name: Some("nested"),
            data: serde_json::json!({"a": {"b": [1, true, "x"]}}),
            encoding: None,
            expected_name: Some("nested"),
            expected_data: serde_json::json!({"a": {"b": [1, true, "x"]}}),
        },
        TestCase {
            label: "null-data",
            name: Some("null-data"),
            data: serde_json::Value::Null,
            encoding: None,
            expected_name: Some("null-data"),
            expected_data: serde_json::Value::Null,
        },
        // Ably stringifies bare primitives (non-object/array/string) on
        // REST→Realtime delivery, so the received data is a JSON string.
        TestCase {
            label: "integer",
            name: Some("integer"),
            data: serde_json::json!(42),
            encoding: None,
            expected_name: Some("integer"),
            expected_data: serde_json::json!("42"),
        },
        TestCase {
            label: "float",
            name: Some("float"),
            data: serde_json::json!(1.23),
            encoding: None,
            expected_name: Some("float"),
            expected_data: serde_json::json!("1.23"),
        },
        TestCase {
            label: "boolean",
            name: Some("boolean"),
            data: serde_json::json!(true),
            encoding: None,
            expected_name: Some("boolean"),
            expected_data: serde_json::json!("true"),
        },
        // --- String edge cases ---
        TestCase {
            label: "empty-string",
            name: Some("empty-string"),
            data: serde_json::json!(""),
            encoding: None,
            expected_name: Some("empty-string"),
            expected_data: serde_json::json!(""),
        },
        TestCase {
            label: "unicode",
            name: Some("unicode"),
            data: serde_json::json!("こんにちは 🌍"),
            encoding: None,
            expected_name: Some("unicode"),
            expected_data: serde_json::json!("こんにちは 🌍"),
        },
        // --- Explicit encoding ---
        // NOTE: Ably's REST→Realtime bridge consumes the encoding field before
        // forwarding, so the subscriber receives raw msgpack Binary data (no
        // encoding). This exercises the rmpv_to_json Binary→base64 path, not
        // decode_data's base64 branch (which is covered by unit tests).
        TestCase {
            label: "binary",
            name: Some("binary"),
            data: serde_json::json!("aGVsbG8gd29ybGQ="),
            encoding: Some("base64"),
            expected_name: Some("binary"),
            expected_data: serde_json::json!("aGVsbG8gd29ybGQ="),
        },
        TestCase {
            label: "json-encoded",
            name: Some("json-encoded"),
            data: serde_json::json!(r#"{"key":"value"}"#),
            encoding: Some("json"),
            expected_name: Some("json-encoded"),
            expected_data: serde_json::json!({"key": "value"}),
        },
        TestCase {
            label: "utf8-json-encoded",
            name: Some("utf8-json-encoded"),
            data: serde_json::json!(r#"[1,2,3]"#),
            encoding: Some("utf-8/json"),
            expected_name: Some("utf8-json-encoded"),
            expected_data: serde_json::json!([1, 2, 3]),
        },
        // --- String edge cases: escapes ---
        TestCase {
            label: "escape-chars",
            name: Some("escape-chars"),
            data: serde_json::json!("line1\nline2\t\"quoted\"\\back"),
            encoding: None,
            expected_name: Some("escape-chars"),
            expected_data: serde_json::json!("line1\nline2\t\"quoted\"\\back"),
        },
        // --- No name ---
        TestCase {
            label: "no-name",
            name: None,
            data: serde_json::json!("unnamed message"),
            encoding: None,
            expected_name: None,
            expected_data: serde_json::json!("unnamed message"),
        },
    ]
}

/// Wait for the `Connected` event on a subscription (15s timeout).
async fn wait_for_connected(
    sub: &mut ably_subscriber::Subscription,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(event) = sub.next().await {
            match event {
                Event::Connected => return Ok(()),
                Event::Error { code, message } => {
                    return Err(format!("connection error: code={code} {message}"));
                }
                _ => {}
            }
        }
        Err("subscription ended before connected".to_string())
    })
    .await
    .map_err(|_| "timeout waiting for Connected")?
    .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })
}

/// Receive a single message from the subscription (10s timeout).
async fn receive_message(
    sub: &mut ably_subscriber::Subscription,
) -> Result<ably_subscriber::Message, String> {
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(event) = sub.next().await {
            match event {
                Event::Message(msg) => return Ok(msg),
                Event::Error { code, message } => {
                    return Err(format!("error event: code={code} {message}"));
                }
                _ => {}
            }
        }
        Err("subscription ended".to_string())
    })
    .await
    .map_err(|_| "timeout waiting for message".to_string())?
}

/// Message fields sent through the Ably REST API.
struct PublishMessage<'a> {
    name: Option<&'a str>,
    data: &'a serde_json::Value,
    encoding: Option<&'a str>,
}

/// Publish a single message via Ably REST API.
async fn publish_message(
    client: &reqwest::Client,
    rest_url: &str,
    channel: &str,
    auth_header: &str,
    name: Option<&str>,
    data: &serde_json::Value,
    encoding: Option<&str>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    publish_message_with_timeout(
        client,
        rest_url,
        channel,
        auth_header,
        PublishMessage {
            name,
            data,
            encoding,
        },
        PUBLISH_TIMEOUT,
    )
    .await
}

async fn publish_message_with_timeout(
    client: &reqwest::Client,
    rest_url: &str,
    channel: &str,
    auth_header: &str,
    message: PublishMessage<'_>,
    publish_timeout: Duration,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let url = format!("{rest_url}/channels/{channel}/messages");

    let mut body = serde_json::json!({ "data": message.data });
    let obj = body.as_object_mut().ok_or("body is not an object")?;

    if let Some(n) = message.name {
        obj.insert("name".to_string(), serde_json::json!(n));
    }
    if let Some(enc) = message.encoding {
        obj.insert("encoding".to_string(), serde_json::json!(enc));
    }

    // Sending and reading an error body share one deadline. Expiry does not
    // imply Ably rejected the message, so do not retry this publish.
    tokio::time::timeout(publish_timeout, async {
        let resp = client
            .post(&url)
            .header("Authorization", format!("Basic {auth_header}"))
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("publish failed: HTTP {status} — {text}").into());
        }

        Ok(())
    })
    .await
    .map_err(|_| format!("publish timed out after {publish_timeout:?}"))?
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt::init();

    // --- Parse API key ---
    const USAGE: &str =
        "usage: smoke_test (set ABLY_API_KEY; API keys are not accepted as arguments)";
    if std::env::args_os().nth(1).is_some() {
        return Err(USAGE.into());
    }
    let api_key = std::env::var("ABLY_API_KEY").map_err(
        |_| "ABLY_API_KEY must be set to keyName:keySecret; API keys are not accepted as arguments",
    )?;

    let (key_name, key_secret) = api_key
        .split_once(':')
        .ok_or("ABLY_API_KEY must be in format keyName:keySecret")?;

    let auth_header = BASE64.encode(api_key.as_bytes());
    let rest_url = "https://rest.ably.io";

    // --- Unique channel ---
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("system time error: {e}"))?;
    let channel = format!("integration-test-{}", ts.as_millis());
    eprintln!("channel: {channel}");

    // --- Subscribe ---
    let kn = key_name.to_string();
    let ks = key_secret.to_string();

    let mut sub = subscribe(SubscribeConfig::new(
        Box::new(move || {
            let kn = kn.clone();
            let ks = ks.clone();
            Box::pin(async move { common::create_token_request(&kn, &ks, common::ONE_HOUR_TTL_MS) })
        }),
        channel.clone(),
    ))
    .await?;

    eprintln!("waiting for connection...");
    wait_for_connected(&mut sub).await?;
    eprintln!("connected — publishing test messages...");

    // --- Publish and verify each test case ---
    let cases = test_cases();
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let mut passed = 0usize;
    let mut failed = 0usize;

    for tc in &cases {
        let t0 = tokio::time::Instant::now();
        publish_message(
            &client,
            rest_url,
            &channel,
            &auth_header,
            tc.name,
            &tc.data,
            tc.encoding,
        )
        .await?;

        let result = receive_message(&mut sub).await;

        match result {
            Ok(msg) => {
                let name_ok = msg.name.as_deref() == tc.expected_name;
                let data_ok = msg.data == tc.expected_data;
                let id_ok = msg.id.is_some();
                let ts_ok = msg.timestamp.is_some();
                if name_ok && data_ok && id_ok && ts_ok {
                    eprintln!("  PASS: {} ({:?})", tc.label, t0.elapsed());
                    passed += 1;
                } else {
                    eprintln!("  FAIL: {}", tc.label);
                    if !name_ok {
                        eprintln!(
                            "    name: expected {:?}, got {:?}",
                            tc.expected_name,
                            msg.name.as_deref()
                        );
                    }
                    if !data_ok {
                        eprintln!("    data: expected {}, got {}", tc.expected_data, msg.data);
                    }
                    if !id_ok {
                        eprintln!("    id: expected Some, got None");
                    }
                    if !ts_ok {
                        eprintln!("    timestamp: expected Some, got None");
                    }
                    failed += 1;
                }
            }
            Err(e) => {
                eprintln!("  FAIL: {} — {e}", tc.label);
                failed += 1;
            }
        }
    }

    // Clean up message-test subscription before lifecycle tests.
    drop(sub);

    // =====================================================================
    // Lifecycle: token renewal
    // =====================================================================
    //
    // Connect with a short-TTL token (15s). For a still-valid token, the
    // five-minute renewal margin is capped at half its remaining lifetime,
    // so renewal is scheduled roughly halfway to expiry. After waiting longer
    // than the original token's lifetime, publish a message — if renewal
    // worked the message arrives; if not, the connection is dead.

    eprintln!();
    eprintln!("--- lifecycle: token renewal ---");

    let renewal_channel = format!("integration-renewal-{}", ts.as_millis());
    let kn = key_name.to_string();
    let ks = key_secret.to_string();
    let call_count = Arc::new(AtomicU32::new(0));

    let mut renewal_sub = subscribe(SubscribeConfig::new(
        Box::new(move || {
            let kn = kn.clone();
            let ks = ks.clone();
            let cc = call_count.clone();
            Box::pin(async move {
                let n = cc.fetch_add(1, Ordering::Relaxed);
                // First token: a still-valid short TTL schedules renewal
                // roughly halfway through its remaining validity.
                // Subsequent: the one-hour TTL places the next renewal outside
                // this smoke test's 20-second observation window.
                let ttl = if n == 0 {
                    15_000
                } else {
                    common::ONE_HOUR_TTL_MS
                };
                common::create_token_request(&kn, &ks, ttl)
            })
        }),
        renewal_channel.clone(),
    ))
    .await?;

    wait_for_connected(&mut renewal_sub).await?;

    // Wait for the original 15s token to expire.
    eprintln!("  waiting 20s for original token to expire...");
    tokio::time::sleep(Duration::from_secs(20)).await;

    // Publish and verify — if renewal failed, this will timeout.
    publish_message(
        &client,
        rest_url,
        &renewal_channel,
        &auth_header,
        Some("renewal-test"),
        &serde_json::json!("after-renewal"),
        None,
    )
    .await?;

    match receive_message(&mut renewal_sub).await {
        Ok(msg) if msg.data == serde_json::json!("after-renewal") => {
            eprintln!("  PASS: token-renewal");
            passed += 1;
        }
        Ok(msg) => {
            eprintln!("  FAIL: token-renewal — unexpected data: {}", msg.data);
            failed += 1;
        }
        Err(e) => {
            eprintln!("  FAIL: token-renewal — {e}");
            failed += 1;
        }
    }

    // =====================================================================
    // Lifecycle: graceful close
    // =====================================================================

    eprintln!();
    eprintln!("--- lifecycle: graceful close ---");
    match renewal_sub.close_and_wait().await {
        Ok(()) => {
            eprintln!("  PASS: graceful-close");
            passed += 1;
        }
        Err(e) => {
            eprintln!("  FAIL: graceful-close — {e}");
            failed += 1;
        }
    }

    // --- Summary ---
    let total = passed + failed;
    eprintln!();
    eprintln!("{passed} passed, {failed} failed, {total} total");

    if failed > 0 {
        std::process::exit(1);
    }

    Ok(())
}

#[cfg(test)]
mod smoke_test_tests;
