#![cfg(test)]

use std::io;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

use runner_rpc_proto::{Delivery, ErrorCode, Response, ResponseWriter};
use serde_json::{json, value::RawValue};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

fn input(method: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"version":1,"method":method,"params":{}})).unwrap()
}

fn frames(output: &[u8]) -> Vec<serde_json::Value> {
    output
        .split(|b| *b == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect()
}

fn expected_error(code: ErrorCode, delivery: Delivery) -> serde_json::Value {
    serde_json::to_value(Response::error(code, delivery)).unwrap()
}

fn event() -> Response {
    Response::Event {
        data: RawValue::from_string(r#"{"progress":1}"#.into()).unwrap(),
    }
}

fn result() -> Response {
    Response::Result {
        data: RawValue::from_string(r#"{"businessSuccess":false}"#.into()).unwrap(),
    }
}

fn wire(response: &Response) -> Vec<u8> {
    let bytes = serde_json::to_vec(response).unwrap();
    let mut frame = (bytes.len() as u32).to_be_bytes().to_vec();
    frame.extend(bytes);
    frame
}

#[tokio::test]
async fn one_shot_helper_forwards_unrelated_methods_without_executing_or_interpreting_payloads() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("must-not-exist");
    let script = format!("touch {}; echo 'literal $HOME `whoami`'", file.display());
    for (method, params) in [
        (
            "fixture.echo",
            json!({"text": script, "nested": [1, null, {"ok": false}]}),
        ),
        (
            "fixture.metrics",
            json!({"windows": [10, 20], "unit": "bytes"}),
        ),
    ] {
        let bytes =
            serde_json::to_vec_pretty(&json!({"version":1,"method":method,"params":params}))
                .unwrap();
        let (client, mut server) = UnixStream::pair().unwrap();
        let mut output = Vec::new();
        let calls = AtomicUsize::new(0);
        let helper = runner_rpc_client::run_with_io(bytes.as_slice(), &mut output, || async {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok(client)
        });
        let host = async {
            let received = runner_rpc_proto::read_request(&mut server).await.unwrap();
            assert_eq!(received.method, method);
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(received.params.get()).unwrap(),
                params
            );
            let mut writer = ResponseWriter::new(server);
            writer
                .send(&Response::Event {
                    data: RawValue::from_string(
                        "{\n\"nested\": [0, 255, 10, 128],\n\"text\": \"line\\nnext\"\n}".into(),
                    )
                    .unwrap(),
                })
                .await
                .unwrap();
            // The helper reports RPC completion even for a business failure.
            writer.send(&result()).await.unwrap();
        };
        let (succeeded, ()) = tokio::join!(helper, host);
        assert!(succeeded.unwrap());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert_eq!(
            frames(&output),
            [
                json!({"type":"event","data":{"nested":[0,255,10,128],"text":"line\nnext"}}),
                json!({"type":"result","data":{"businessSuccess":false}}),
            ]
        );
        assert!(!String::from_utf8(output).unwrap().contains(&script));
    }
    assert!(!file.exists());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn bridge_preserves_large_numeric_tokens_and_duplicate_business_fields() {
    let payload = "{\n\"n\":1234567890123456789012345678901234567890,\n\"n\":1e9999\n}";
    let bytes = format!(r#"{{"version":1,"method":"fixture.echo","params":{payload}}}"#);
    let (client, mut server) = UnixStream::pair().unwrap();
    let mut output = Vec::new();
    let helper =
        runner_rpc_client::run_with_io(bytes.as_bytes(), &mut output, || async { Ok(client) });
    let host = async {
        let received = runner_rpc_proto::read_request(&mut server).await.unwrap();
        assert_eq!(received.params.get(), payload);
        ResponseWriter::new(server)
            .send(&Response::Result {
                data: received.params,
            })
            .await
            .unwrap();
    };
    let (succeeded, ()) = tokio::join!(helper, host);
    assert!(succeeded.unwrap());
    assert_eq!(
        String::from_utf8(output).unwrap(),
        "{\"type\":\"result\",\"data\":{\"n\":1234567890123456789012345678901234567890,\"n\":1e9999}}\n"
    );
}

#[tokio::test]
async fn invalid_input_never_connects_and_never_echoes_untrusted_content() {
    let calls = AtomicUsize::new(0);
    for bytes in [
        b"invalid secret input".to_vec(),
        br#"[1,"fixture.echo",{}]"#.to_vec(),
        input(""),
        vec![b'x'; runner_rpc_proto::MAX_REQUEST_BYTES + 1],
        br#"{"version":1,"method":"fixture.echo","params":{},"host":"secret"}"#.to_vec(),
        br#"{"version":1,"method":"fixture.echo","params":{},"remaining_ms":60000}"#.to_vec(),
        br#"{"version":1,"method":"fixture.echo","params":{},"remaining_ms":null}"#.to_vec(),
    ] {
        let mut output = Vec::new();
        let result = runner_rpc_client::run_with_io(bytes.as_slice(), &mut output, || async {
            calls.fetch_add(1, Ordering::Relaxed);
            Err::<UnixStream, _>(io::Error::other("secret endpoint"))
        })
        .await
        .unwrap();
        assert!(!result);
        assert_eq!(
            frames(&output),
            [expected_error(
                ErrorCode::InvalidRequest,
                Delivery::NotDispatched
            )]
        );
    }
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

#[tokio::test(start_paused = true)]
async fn helper_transmits_only_its_remaining_budget_after_input_and_connection() {
    let (mut input_writer, input_reader) = tokio::io::duplex(1024);
    let (client, mut server) = UnixStream::pair().unwrap();
    let mut output = Vec::new();
    let helper = runner_rpc_client::run_with_io(input_reader, &mut output, || async {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        Ok(client)
    });
    let host = async {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        input_writer
            .write_all(&input("fixture.echo"))
            .await
            .unwrap();
        input_writer.shutdown().await.unwrap();
        let request = runner_rpc_proto::read_request(&mut server).await.unwrap();
        assert_eq!(request.remaining_ms, Some(44_900));
        ResponseWriter::new(server).send(&result()).await.unwrap();
    };
    let (succeeded, ()) = tokio::join!(helper, host);
    assert!(succeeded.unwrap());
}

#[tokio::test]
async fn helper_rejects_budget_metadata_overflow_before_transmission() {
    let base = r#"{"version":1,"method":"fixture.echo","params":{"text":""}}"#;
    let bytes = base.replacen(
        r#""""#,
        &format!(
            "\"{}\"",
            "x".repeat(runner_rpc_proto::MAX_REQUEST_BYTES - base.len())
        ),
        1,
    );
    assert_eq!(bytes.len(), runner_rpc_proto::MAX_REQUEST_BYTES);
    let (client, mut server) = UnixStream::pair().unwrap();
    let mut output = Vec::new();
    let helper =
        runner_rpc_client::run_with_io(bytes.as_bytes(), &mut output, || async { Ok(client) });
    let host = async {
        let mut bytes = Vec::new();
        server.read_to_end(&mut bytes).await.unwrap();
        assert!(bytes.is_empty());
    };
    let (succeeded, ()) = tokio::join!(helper, host);
    assert!(!succeeded.unwrap());
    assert_eq!(
        frames(&output),
        [expected_error(
            ErrorCode::InvalidRequest,
            Delivery::NotDispatched
        )]
    );
}

#[tokio::test]
async fn connection_failure_is_not_dispatched_but_lost_response_is_unknown_without_replay() {
    let bytes = input("fixture.echo");
    let mut output = Vec::new();
    assert!(
        !runner_rpc_client::run_with_io(bytes.as_slice(), &mut output, || async {
            Err::<UnixStream, _>(io::Error::other("secret endpoint"))
        })
        .await
        .unwrap()
    );
    assert_eq!(
        frames(&output),
        [expected_error(
            ErrorCode::Unavailable,
            Delivery::NotDispatched
        )]
    );

    for sent in [vec![], wire(&event()), vec![0, 0, 0, 10, b'{']] {
        let (client, mut server) = UnixStream::pair().unwrap();
        let mut output = Vec::new();
        let calls = AtomicUsize::new(0);
        let helper = runner_rpc_client::run_with_io(bytes.as_slice(), &mut output, || async {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok(client)
        });
        let host = async {
            runner_rpc_proto::read_request(&mut server).await.unwrap();
            server.write_all(&sent).await.unwrap();
            server.shutdown().await.unwrap();
        };
        let (result, ()) = tokio::join!(helper, host);
        assert!(!result.unwrap());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        let responses = frames(&output);
        assert_eq!(responses.iter().filter(|r| r["type"] != "event").count(), 1);
        assert_eq!(responses.last().unwrap()["delivery"], "unknown");
    }
    let (client, server) = UnixStream::pair().unwrap();
    drop(server);
    output.clear();
    assert!(
        !runner_rpc_client::run_with_io(bytes.as_slice(), &mut output, || async { Ok(client) })
            .await
            .unwrap()
    );
    assert_eq!(
        frames(&output),
        [expected_error(ErrorCode::Transport, Delivery::Unknown)]
    );
}

#[tokio::test]
async fn explicit_rejection_and_failure_after_events_are_distinct_from_results() {
    for (events, delivery) in [(false, Delivery::NotDispatched), (true, Delivery::Unknown)] {
        let bytes = input("fixture.unavailable");
        let (client, mut server) = UnixStream::pair().unwrap();
        let mut output = Vec::new();
        let helper =
            runner_rpc_client::run_with_io(bytes.as_slice(), &mut output, || async { Ok(client) });
        let host = async {
            runner_rpc_proto::read_request(&mut server).await.unwrap();
            let mut writer = ResponseWriter::new(server);
            if events {
                writer.send(&event()).await.unwrap();
            }
            writer
                .send(&Response::error(ErrorCode::Unavailable, delivery))
                .await
                .unwrap();
        };
        let (result, ()) = tokio::join!(helper, host);
        assert!(!result.unwrap());
        assert_eq!(
            frames(&output).last(),
            Some(&expected_error(ErrorCode::Unavailable, delivery))
        );
    }
}

#[tokio::test]
async fn duplicate_terminal_or_trailing_garbage_never_exposes_a_result() {
    let bytes = input("fixture.echo");
    for trailing in [wire(&result()), vec![1]] {
        let (client, mut server) = UnixStream::pair().unwrap();
        let mut output = Vec::new();
        let helper =
            runner_rpc_client::run_with_io(bytes.as_slice(), &mut output, || async { Ok(client) });
        let host = async {
            runner_rpc_proto::read_request(&mut server).await.unwrap();
            for frame in [wire(&event()), wire(&result()), trailing] {
                server.write_all(&frame).await.unwrap();
            }
            server.shutdown().await.unwrap();
        };
        let (result, ()) = tokio::join!(helper, host);
        assert!(!result.unwrap());
        let responses = frames(&output);
        assert_eq!(responses.iter().filter(|r| r["type"] != "event").count(), 1);
        assert!(!responses.iter().any(|r| r["type"] == "result"));
    }
}

#[tokio::test(start_paused = true)]
async fn input_and_connection_deadlines_never_claim_dispatch() {
    let (_input_writer, reader) = tokio::io::duplex(64);
    let mut output = Vec::new();
    let calls = AtomicUsize::new(0);
    assert!(
        !runner_rpc_client::run_with_io(reader, &mut output, || async {
            calls.fetch_add(1, Ordering::Relaxed);
            Err::<UnixStream, _>(io::Error::other("must not connect"))
        })
        .await
        .unwrap()
    );
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    assert_eq!(
        frames(&output),
        [expected_error(ErrorCode::TimedOut, Delivery::NotDispatched)]
    );
    output.clear();
    assert!(
        !runner_rpc_client::run_with_io(input("fixture.echo").as_slice(), &mut output, || {
            std::future::pending::<io::Result<UnixStream>>()
        })
        .await
        .unwrap()
    );
    assert_eq!(
        frames(&output),
        [expected_error(ErrorCode::TimedOut, Delivery::NotDispatched)]
    );
}

#[tokio::test(start_paused = true)]
async fn a_terminal_without_eof_times_out_as_unknown_instead_of_success() {
    let bytes = input("fixture.echo");
    let (client, mut server) = tokio::io::duplex(1024);
    let mut output = Vec::new();
    let helper =
        runner_rpc_client::run_with_io(bytes.as_slice(), &mut output, || async { Ok(client) });
    let host = async {
        runner_rpc_proto::read_request(&mut server).await.unwrap();
        server.write_all(&wire(&result())).await.unwrap();
        // Keep the write side open beyond the helper's deadline.
        tokio::time::sleep(std::time::Duration::from_secs(61)).await;
    };
    let (result, ()) = tokio::join!(helper, host);
    assert!(!result.unwrap());
    assert_eq!(
        frames(&output),
        [expected_error(ErrorCode::TimedOut, Delivery::Unknown)]
    );
}

#[tokio::test(start_paused = true)]
async fn partial_stdout_backpressure_or_broken_pipe_never_appends_another_terminal() {
    for broken in [false, true] {
        let bytes = input("fixture.echo");
        let (client, mut server) = tokio::io::duplex(1024);
        let (output, reader) = tokio::io::duplex(5);
        let reader = (!broken).then_some(reader);
        let helper =
            runner_rpc_client::run_with_io(bytes.as_slice(), output, || async { Ok(client) });
        let host = async {
            runner_rpc_proto::read_request(&mut server).await.unwrap();
            let mut writer = ResponseWriter::new(server);
            writer.send(&event()).await.unwrap();
            writer.send(&result()).await.unwrap();
        };
        let (result, ()) = tokio::join!(helper, host);
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
        if let Some(mut reader) = reader {
            let mut received = Vec::new();
            reader.read_to_end(&mut received).await.unwrap();
            assert!(received.len() <= 5);
            assert!(!received.contains(&b'\n'));
        }
    }
}

#[test]
fn executable_rejects_bad_input_without_files_or_payload_logs() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_runner-rpc-client"))
        .current_dir(dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"secret malformed input")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        frames(&output.stdout),
        [expected_error(
            ErrorCode::InvalidRequest,
            Delivery::NotDispatched
        )]
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);

    let output = Command::new(env!("CARGO_BIN_EXE_runner-rpc-client"))
        .args(["--socket", "/untrusted"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        !String::from_utf8(output.stderr)
            .unwrap()
            .contains("untrusted")
    );
}
