use super::BinaryLoggingFixture;
use crate::process::CommandExecution;
use crate::support::{TcpTestServerControl, read_http_request_path};
use serde_json::Value;
use std::collections::BTreeSet;
use std::io::{self, Write as _};
use std::net::TcpStream;
use std::process::{Command, Output};
use std::time::Duration;

mod failures;
mod proxy;
mod successful_calls;

const PREFIX: &str = "remote_connection_observation ";
const SOCKET_TIMEOUT: Duration = Duration::from_secs(5);

fn command(fixture: &BinaryLoggingFixture) -> Command {
    let mut command = fixture.command();
    for key in [
        "ALL_PROXY",
        "all_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "NO_PROXY",
        "no_proxy",
    ] {
        command.env_remove(key);
    }
    command
}

fn run_manifest(fixture: &BinaryLoggingFixture, manifest: &Value) -> io::Result<Output> {
    spawn_manifest(&mut command(fixture), manifest)?.wait()
}

fn spawn_manifest(command: &mut Command, manifest: &Value) -> io::Result<CommandExecution> {
    CommandExecution::spawn(
        command.arg("--manifest-stdin"),
        Some(&serde_json::to_vec(manifest)?),
    )
}

fn observations(fixture: &BinaryLoggingFixture) -> io::Result<Vec<Value>> {
    fixture
        .read_system_log()?
        .lines()
        .filter_map(|line| line.split_once(PREFIX).map(|(_, json)| json))
        .map(|json| serde_json::from_str(json).map_err(io::Error::other))
        .collect()
}

fn assert_keys(value: &Value, expected: &[&str]) {
    assert_eq!(
        value
            .as_object()
            .map(|object| object.keys().map(String::as_str).collect::<BTreeSet<_>>()),
        Some(expected.iter().copied().collect()),
        "unexpected observation fields: {value}"
    );
}

fn assert_record(record: &Value, outcome: &str, usage: &str) {
    assert_keys(
        record,
        &[
            "call_outcome",
            "request_to_response_headers_us",
            "resolve_outside_setup",
            "resolve_inside_setup",
            "connection_setup",
            "transport_use",
        ],
    );
    assert_eq!(record["call_outcome"], outcome);
    assert_eq!(record["transport_use"], usage);
    assert!(record["request_to_response_headers_us"].as_u64().is_some());
    for phase in [
        "resolve_outside_setup",
        "resolve_inside_setup",
        "connection_setup",
    ] {
        let value = &record[phase];
        let mut keys = vec![
            "status",
            "invocations",
            "completed",
            "errors",
            "interrupted",
        ];
        if value["status"] != "not_entered" {
            keys.push("duration_us");
            assert!(value["duration_us"].as_u64().is_some());
        }
        assert_keys(value, &keys);
        for counter in ["invocations", "completed", "errors", "interrupted"] {
            assert!(value[counter].as_u64().is_some());
        }
    }
}

fn assert_phase(record: &Value, phase: &str, completed: u64, errors: u64) {
    let value = &record[phase];
    let expected_status = match (completed, errors) {
        (0, 0) => "not_entered",
        (_, 0) => "completed",
        (0, _) => "failed",
        _ => "mixed",
    };
    assert_eq!(value["status"], expected_status, "{record}");
    assert_eq!(value["invocations"], completed + errors, "{record}");
    assert_eq!(value["completed"], completed, "{record}");
    assert_eq!(value["errors"], errors, "{record}");
    assert_eq!(value["interrupted"], 0, "{record}");
}

fn accept(server: &TcpTestServerControl) -> io::Result<TcpStream> {
    let stream = server
        .accept()?
        .ok_or_else(|| io::Error::new(io::ErrorKind::Interrupted, "missing test request"))?;
    stream.set_read_timeout(Some(SOCKET_TIMEOUT))?;
    stream.set_write_timeout(Some(SOCKET_TIMEOUT))?;
    Ok(stream)
}

fn request(stream: &mut TcpStream, expected: &str) -> io::Result<()> {
    let actual = read_http_request_path(stream)?;
    if actual != expected {
        return Err(io::Error::other(format!(
            "expected request {expected:?}, got {actual:?}"
        )));
    }
    Ok(())
}

fn respond(stream: &mut TcpStream, body: &[u8]) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()
}
