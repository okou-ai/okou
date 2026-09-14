#![cfg(test)]

use std::{
    io,
    process::{Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

use runner_rpc_proto::{
    Delivery, ErrorCode, Response, ResponseWriter,
    stream::{Frame, MAX_DATA_BYTES, MAX_DURATION_MS, Reader, Writer},
};
use serde_json::{json, value::RawValue};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
    time::timeout,
};

async fn input() -> Vec<u8> {
    let request =
        runner_rpc_proto::parse_request(br#"{"version":1,"method":"fixture.stream","params":{}}"#)
            .unwrap();
    let mut bytes = Vec::new();
    runner_rpc_proto::write_request(&mut bytes, &request)
        .await
        .unwrap();
    bytes
}

fn result() -> Response {
    Response::Result {
        data: RawValue::from_string("{\"businessSuccess\":false}".into()).unwrap(),
    }
}

async fn terminal(output: &[u8]) -> Response {
    let mut reader = Reader::responses(output);
    let mut terminal = None;
    while let Some(frame) = reader.next().await.unwrap() {
        if let Frame::Control(response) = frame
            && response.is_terminal()
        {
            terminal = Some(response);
        }
    }
    terminal.unwrap()
}

fn assert_error(response: Response, code: ErrorCode, delivery: Delivery) {
    assert_eq!(
        serde_json::to_value(response).unwrap(),
        json!({"type":"error","code":code,"delivery":delivery})
    );
}

#[tokio::test]
async fn streams_more_than_four_mib_in_both_directions_with_bounded_backpressure() {
    let (mut producer, input_reader) = tokio::io::duplex(1024);
    let (output_writer, output_reader) = tokio::io::duplex(1024);
    let (client, mut server) = UnixStream::pair().unwrap();
    let calls = AtomicUsize::new(0);
    let block = [0, 255, 128, 10].repeat(MAX_DATA_BYTES / 4);
    let helper = runner_rpc_client::stream::run_with_io(input_reader, output_writer, || async {
        calls.fetch_add(1, Ordering::Relaxed);
        Ok(client)
    });
    let send = async {
        producer.write_all(&input().await).await.unwrap();
        let mut writer = Writer::input(&mut producer);
        for _ in 0..80 {
            writer.send(&Frame::Data(block.clone())).await.unwrap();
        }
        writer.send(&Frame::End).await.unwrap();
        // Keep producer alive: End must suffice without stdin EOF.
    };
    let host = async {
        let request = runner_rpc_proto::read_request(&mut server).await.unwrap();
        assert_eq!(request.method, "fixture.stream");
        assert!(request.remaining_ms.unwrap() <= MAX_DURATION_MS);
        let (read, write) = tokio::io::split(server);
        let mut reader = Reader::input(read);
        let mut writer = Writer::responses(write);
        let mut bytes = 0;
        while let Some(frame) = reader.next().await.unwrap() {
            if let Frame::Data(data) = &frame {
                assert_eq!(data, &block);
                bytes += data.len();
            }
            writer.send(&frame).await.unwrap();
        }
        assert_eq!(bytes, 80 * MAX_DATA_BYTES);
        writer.send(&Frame::Control(result())).await.unwrap();
        writer
    };
    let receive = async {
        let mut reader = Reader::responses(output_reader);
        let mut bytes = 0;
        let mut completed = false;
        while let Some(frame) = reader.next().await.unwrap() {
            match frame {
                Frame::Data(data) => {
                    assert_eq!(data, block);
                    bytes += data.len();
                }
                Frame::End => (),
                Frame::Control(Response::Result { .. }) => completed = true,
                _ => panic!("unexpected control"),
            }
        }
        assert_eq!(bytes, 80 * MAX_DATA_BYTES);
        assert!(completed);
    };
    let (success, (), _writer, ()) = timeout(Duration::from_secs(10), async {
        tokio::join!(helper, send, host, receive)
    })
    .await
    .unwrap();
    assert!(success.unwrap()); // RPC success does not interpret businessSuccess.
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn legacy_rejection_completes_even_when_stream_input_never_arrives() {
    let (mut producer, input_reader) = tokio::io::duplex(1024);
    producer.write_all(&input().await).await.unwrap();
    let (client, mut server) = UnixStream::pair().unwrap();
    let mut output = Vec::new();
    let helper =
        runner_rpc_client::stream::run_with_io(input_reader, &mut output, || async { Ok(client) });
    let host = async {
        runner_rpc_proto::read_request(&mut server).await.unwrap();
        let mut writer = ResponseWriter::new(server);
        writer
            .send(&Response::error(
                ErrorCode::UnknownMethod,
                Delivery::NotDispatched,
            ))
            .await
            .unwrap();
        writer
    };
    let (success, _writer) = timeout(Duration::from_secs(2), async { tokio::join!(helper, host) })
        .await
        .unwrap();
    assert!(!success.unwrap());
    assert_error(
        terminal(&output).await,
        ErrorCode::UnknownMethod,
        Delivery::NotDispatched,
    );
    drop(producer);
}

#[tokio::test]
async fn invalid_header_and_caller_budget_never_connect_or_echo_data() {
    let calls = AtomicUsize::new(0);
    for bytes in [vec![], vec![255; 4], {
        let mut request = runner_rpc_proto::parse_request(
            br#"{"version":1,"method":"fixture.stream","params":{},"remaining_ms":1}"#,
        )
        .unwrap();
        request.remaining_ms = Some(1);
        let mut bytes = Vec::new();
        runner_rpc_proto::write_request(&mut bytes, &request)
            .await
            .unwrap();
        bytes
    }] {
        let mut output = Vec::new();
        let success =
            runner_rpc_client::stream::run_with_io(bytes.as_slice(), &mut output, || async {
                calls.fetch_add(1, Ordering::Relaxed);
                Err::<UnixStream, _>(io::Error::other("must not connect"))
            })
            .await
            .unwrap();
        assert!(!success);
        assert_error(
            terminal(&output).await,
            ErrorCode::InvalidRequest,
            Delivery::NotDispatched,
        );
    }
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn malformed_upload_closes_connection_without_replay() {
    let mut bytes = input().await;
    bytes.extend_from_slice(&[0, 0, 0, 1, 0]); // Empty Data is not End.
    let (client, mut server) = UnixStream::pair().unwrap();
    let mut output = Vec::new();
    let calls = AtomicUsize::new(0);
    let helper = runner_rpc_client::stream::run_with_io(bytes.as_slice(), &mut output, || async {
        calls.fetch_add(1, Ordering::Relaxed);
        Ok(client)
    });
    let host = async {
        runner_rpc_proto::read_request(&mut server).await.unwrap();
        let mut remaining = Vec::new();
        server.read_to_end(&mut remaining).await.unwrap();
        assert!(remaining.is_empty());
    };
    let (success, ()) = tokio::join!(helper, host);
    assert!(!success.unwrap());
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    assert_error(
        terminal(&output).await,
        ErrorCode::InvalidRequest,
        Delivery::Unknown,
    );
}

#[tokio::test]
async fn cancelling_the_invocation_closes_its_only_connection() {
    let (mut producer, input_reader) = tokio::io::duplex(1024);
    producer.write_all(&input().await).await.unwrap();
    let (client, mut server) = UnixStream::pair().unwrap();
    let mut output = Vec::new();
    let mut helper = Box::pin(runner_rpc_client::stream::run_with_io(
        input_reader,
        &mut output,
        || async { Ok(client) },
    ));
    tokio::select! {
        result = &mut helper => panic!("helper ended before cancellation: {result:?}"),
        request = runner_rpc_proto::read_request(&mut server) => {
            assert_eq!(request.unwrap().method, "fixture.stream");
        }
    }
    drop(helper);
    let mut trailing = Vec::new();
    timeout(Duration::from_secs(1), server.read_to_end(&mut trailing))
        .await
        .unwrap()
        .unwrap();
    assert!(trailing.is_empty());
    assert!(output.is_empty());
    drop(producer);
}

#[tokio::test]
async fn missing_or_duplicate_terminal_never_publishes_a_result() {
    for duplicate in [false, true] {
        let mut bytes = input().await;
        Writer::input(&mut bytes).send(&Frame::End).await.unwrap();
        let (client, mut server) = UnixStream::pair().unwrap();
        let mut output = Vec::new();
        let helper =
            runner_rpc_client::stream::run_with_io(bytes.as_slice(), &mut output, || async {
                Ok(client)
            });
        let host = async {
            runner_rpc_proto::read_request(&mut server).await.unwrap();
            let mut request_data = Reader::input(&mut server);
            assert!(matches!(
                request_data.next().await.unwrap(),
                Some(Frame::End)
            ));
            let mut wire = Vec::new();
            let mut writer = Writer::responses(&mut wire);
            writer.send(&Frame::Data(vec![255])).await.unwrap();
            writer.send(&Frame::End).await.unwrap();
            if duplicate {
                writer.send(&Frame::Control(result())).await.unwrap();
            }
            server.write_all(&wire).await.unwrap();
            if duplicate {
                let mut extra = Vec::new();
                Writer::responses(&mut extra)
                    .send(&Frame::Control(result()))
                    .await
                    .unwrap();
                server.write_all(&extra).await.unwrap();
            }
            server.shutdown().await.unwrap();
        };
        let (success, ()) = tokio::join!(helper, host);
        assert!(!success.unwrap());
        assert_error(
            terminal(&output).await,
            ErrorCode::Protocol,
            Delivery::Unknown,
        );
    }
}

#[tokio::test(start_paused = true)]
async fn streaming_budget_includes_input_and_connect_and_terminal_still_needs_eof() {
    let (mut producer, input_reader) = tokio::io::duplex(1024);
    let (client, mut server) = UnixStream::pair().unwrap();
    let mut output = Vec::new();
    let helper = runner_rpc_client::stream::run_with_io(input_reader, &mut output, || async {
        tokio::time::sleep(Duration::from_secs(5)).await;
        Ok(client)
    });
    let host = async {
        tokio::time::sleep(Duration::from_secs(10)).await;
        producer.write_all(&input().await).await.unwrap();
        let request = runner_rpc_proto::read_request(&mut server).await.unwrap();
        assert_eq!(request.remaining_ms, Some(MAX_DURATION_MS - 15_100));
        let mut bytes = Vec::new();
        Writer::responses(&mut bytes)
            .send(&Frame::Control(result()))
            .await
            .unwrap();
        server.write_all(&bytes).await.unwrap();
        // No host EOF: terminal must be withheld and eventually time out.
        let mut remainder = Vec::new();
        server.read_to_end(&mut remainder).await.unwrap();
    };
    let (success, ()) = tokio::join!(helper, host);
    assert!(!success.unwrap());
    assert_error(
        terminal(&output).await,
        ErrorCode::TimedOut,
        Delivery::Unknown,
    );
}

#[tokio::test(start_paused = true)]
async fn partially_written_stdout_is_not_replaced_after_deadline() {
    let mut bytes = input().await;
    Writer::input(&mut bytes).send(&Frame::End).await.unwrap();
    let (client, mut server) = UnixStream::pair().unwrap();
    let (output_writer, mut output_reader) = tokio::io::duplex(5);
    let helper =
        runner_rpc_client::stream::run_with_io(bytes.as_slice(), output_writer, || async {
            Ok(client)
        });
    let host = async {
        runner_rpc_proto::read_request(&mut server).await.unwrap();
        let mut input = Reader::input(&mut server);
        assert!(matches!(input.next().await.unwrap(), Some(Frame::End)));
        let mut writer = Writer::responses(server);
        writer.send(&Frame::Data(vec![255; 20])).await.unwrap();
        writer.send(&Frame::End).await.unwrap();
        writer.send(&Frame::Control(result())).await.unwrap();
    };
    let (success, ()) = tokio::join!(helper, host);
    assert_eq!(success.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
    let mut output = Vec::new();
    output_reader.read_to_end(&mut output).await.unwrap();
    assert_eq!(output, [0, 0, 0, 21, 0]);
}

#[tokio::test]
async fn executable_selects_framed_mode_without_creating_files_or_logging_input() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_runner-rpc-client"))
        .arg("--stream")
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
    assert_error(
        terminal(&output.stdout).await,
        ErrorCode::InvalidRequest,
        Delivery::NotDispatched,
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    for args in [
        vec!["--stream", "--stream"],
        vec!["--stream", "--socket", "secret"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_runner-rpc-client"))
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!String::from_utf8(output.stderr).unwrap().contains("secret"));
    }
}
