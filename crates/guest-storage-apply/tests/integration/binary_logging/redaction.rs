use super::{BinaryLoggingFixture, assert_download_total_success_present};
use crate::process;
use crate::support::{
    TcpTestServer, TcpTestServerControl, assert_does_not_contain_any, create_tar_gz,
    read_http_request_path, write_manifest,
};
use httpmock::prelude::*;
use std::io;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;

const SERVER_STREAM_READ_TIMEOUT: Duration = Duration::from_secs(1);
const SERVER_START_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy)]
enum ConnectionBehavior {
    Drop,
    Hold,
}

struct ConnectionDropServer {
    server: TcpTestServer<usize>,
    request_started_rx: Receiver<()>,
}

impl ConnectionDropServer {
    fn start() -> io::Result<Self> {
        Self::start_with_behavior(ConnectionBehavior::Drop)
    }

    fn start_holding() -> io::Result<Self> {
        Self::start_with_behavior(ConnectionBehavior::Hold)
    }

    fn start_with_behavior(behavior: ConnectionBehavior) -> io::Result<Self> {
        let (request_started_tx, request_started_rx) = mpsc::channel();
        let server = TcpTestServer::start(move |server| {
            serve_dropped_connections(server, request_started_tx, behavior)
        })?;

        Ok(Self {
            server,
            request_started_rx,
        })
    }

    fn base_url(&self) -> &str {
        self.server.base_url()
    }

    fn wait_for_request(&self) -> io::Result<()> {
        match self.request_started_rx.recv_timeout(SERVER_START_TIMEOUT) {
            Ok(()) => Ok(()),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "connection-drop server received no request within {SERVER_START_TIMEOUT:?}"
                ),
            )),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(io::Error::other(
                "connection-drop server exited before receiving a request",
            )),
        }
    }

    fn finish(self) -> io::Result<usize> {
        self.server.finish()
    }
}

fn serve_dropped_connections(
    server: TcpTestServerControl,
    request_started_tx: Sender<()>,
    behavior: ConnectionBehavior,
) -> io::Result<usize> {
    let mut accepted = 0;
    loop {
        let Some(mut stream) = server.accept()? else {
            return Ok(accepted);
        };
        stream.set_read_timeout(Some(SERVER_STREAM_READ_TIMEOUT))?;
        read_http_request_path(&mut stream)?;
        accepted += 1;
        let _ = request_started_tx.send(());
        if matches!(behavior, ConnectionBehavior::Hold) {
            server.wait_for_shutdown();
            return Ok(accepted);
        }
    }
}

#[test]
fn binary_does_not_log_http_archive_url_on_success() {
    let server = MockServer::start();
    let tar_gz = create_tar_gz(&[("secret.txt", b"downloaded")]).unwrap();

    let mock = server.mock(|when, then| {
        when.method(GET).path("/storage-object-key/archive.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&tar_gz);
    });

    let fixture = BinaryLoggingFixture::new("secret-url-success").unwrap();
    let mount = fixture.dir.path().join("mount");
    let url = server.url(
        "/storage-object-key/archive.tar.gz?X-Amz-Signature=super-secret-token&X-Amz-Credential=credential-secret",
    );
    let manifest =
        write_manifest(&fixture.dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(mount.join("secret.txt")).unwrap(),
        "downloaded"
    );
    mock.assert_calls(1);

    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log_content = fixture.read_system_log().unwrap();
    let ops_log_content = fixture.read_ops_log().unwrap();
    let forbidden = [
        url.as_str(),
        "storage-object-key",
        "X-Amz-Signature",
        "super-secret-token",
        "X-Amz-Credential",
        "credential-secret",
    ];
    assert_does_not_contain_any("stderr", &stderr, &forbidden);
    assert_does_not_contain_any("system log", &system_log_content, &forbidden);
    assert_does_not_contain_any("sandbox ops log", &ops_log_content, &forbidden);
}

#[test]
fn binary_does_not_log_http_archive_url_on_fatal_status() {
    let server = MockServer::start();

    let mock = server.mock(|when, then| {
        when.method(GET)
            .path("/failing-storage-object/archive.tar.gz");
        then.status(404);
    });

    let fixture = BinaryLoggingFixture::new("secret-url-fatal").unwrap();
    let mount = fixture.dir.path().join("mount");
    let url = server.url(
        "/failing-storage-object/archive.tar.gz?X-Amz-Signature=fatal-secret-token&X-Amz-Credential=fatal-credential",
    );
    let manifest =
        write_manifest(&fixture.dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(!output.status.success());
    mock.assert_calls(1);

    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log_content = fixture.read_system_log().unwrap();
    let ops_log_content = fixture.read_ops_log().unwrap();
    let forbidden = [
        url.as_str(),
        "failing-storage-object",
        "X-Amz-Signature",
        "fatal-secret-token",
        "X-Amz-Credential",
        "fatal-credential",
    ];
    assert_does_not_contain_any("stderr", &stderr, &forbidden);
    assert_does_not_contain_any("system log", &system_log_content, &forbidden);
    assert_does_not_contain_any("sandbox ops log", &ops_log_content, &forbidden);
    assert!(
        stderr.contains("HTTP status 404"),
        "unexpected stderr: {stderr}"
    );

    let ops = fixture.ops_entries().unwrap();
    assert!(
        ops.iter()
            .any(|entry| entry["action_type"] == "storage_download"
                && entry["success"] == false
                && entry["error"]
                    .as_str()
                    .is_some_and(|error| error.contains("HTTP status 404")
                        && error.contains("mountPath=")
                        && error.contains("urlScheme=http"))),
        "missing failed storage_download entry: {ops_log_content}"
    );
    assert_download_total_success_present(&ops, false);
}

#[test]
fn binary_classifies_malformed_http_url_without_logging_it() {
    let fixture = BinaryLoggingFixture::new("malformed-secret-url").unwrap();
    let mount = fixture.dir.path().join("mount");
    let url = "http://invalid host/storage-object/archive.tar.gz?X-Amz-Signature=malformed-secret-token&X-Amz-Credential=malformed-credential";
    let manifest =
        write_manifest(&fixture.dir, &[(mount.to_str().unwrap(), Some(url))], None).unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(!output.status.success());

    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log_content = fixture.read_system_log().unwrap();
    let ops_log_content = fixture.read_ops_log().unwrap();
    let forbidden = [
        url,
        "invalid host",
        "X-Amz-Signature",
        "malformed-secret-token",
        "X-Amz-Credential",
        "malformed-credential",
    ];
    assert_does_not_contain_any("stderr", &stderr, &forbidden);
    assert_does_not_contain_any("system log", &system_log_content, &forbidden);
    assert_does_not_contain_any("sandbox ops log", &ops_log_content, &forbidden);

    let expected_error = "HTTP request error (kind=invalid_request)";

    let ops = fixture.ops_entries().unwrap();
    assert!(
        ops.iter()
            .any(|entry| entry["action_type"] == "storage_download"
                && entry["success"] == false
                && entry["error"]
                    .as_str()
                    .is_some_and(|error| error.contains(expected_error))),
        "missing classified storage_download entry: {ops_log_content}"
    );
    assert_download_total_success_present(&ops, false);
}

#[test]
fn binary_classifies_system_resolver_failure_without_logging_url() {
    let fixture = BinaryLoggingFixture::new("resolver-failure-secret-url").unwrap();
    let mount = fixture.dir.path().join("mount");
    let hostname = format!("{}.invalid", "a".repeat(64));
    let url = format!(
        "http://{hostname}/storage-object/archive.tar.gz?X-Amz-Signature=resolver-secret-token&X-Amz-Credential=resolver-credential"
    );
    let manifest = write_manifest(
        &fixture.dir,
        &[(mount.to_str().unwrap(), Some(url.as_str()))],
        None,
    )
    .unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(!output.status.success());

    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log_content = fixture.read_system_log().unwrap();
    let ops_log_content = fixture.read_ops_log().unwrap();
    let forbidden = [
        url.as_str(),
        hostname.as_str(),
        "storage-object",
        "X-Amz-Signature",
        "resolver-secret-token",
        "X-Amz-Credential",
        "resolver-credential",
        "failed to lookup address information",
    ];
    assert_does_not_contain_any("stderr", &stderr, &forbidden);
    assert_does_not_contain_any("system log", &system_log_content, &forbidden);
    assert_does_not_contain_any("sandbox ops log", &ops_log_content, &forbidden);

    let expected_error = "HTTP request error (kind=dns phase=resolve)";

    let ops = fixture.ops_entries().unwrap();
    assert!(
        ops.iter()
            .any(|entry| entry["action_type"] == "storage_download"
                && entry["success"] == false
                && entry["error"]
                    .as_str()
                    .is_some_and(|error| error.contains(expected_error))),
        "missing classified storage_download entry: {ops_log_content}"
    );
    assert_download_total_success_present(&ops, false);
}

#[test]
fn binary_classifies_connection_drop_without_logging_url() {
    let server = ConnectionDropServer::start().unwrap();
    let base_url = server.base_url().to_owned();
    let fixture = BinaryLoggingFixture::new("connection-drop-secret-url").unwrap();
    let mount = fixture.dir.path().join("mount");
    let url = format!(
        "{base_url}/storage-object/archive.tar.gz?X-Amz-Signature=connection-secret-token&X-Amz-Credential=connection-credential"
    );
    let manifest =
        write_manifest(&fixture.dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();
    let accepted = server.finish().unwrap();

    assert!(!output.status.success());
    assert_eq!(accepted, 1);

    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log_content = fixture.read_system_log().unwrap();
    let ops_log_content = fixture.read_ops_log().unwrap();
    let forbidden = [
        url.as_str(),
        "storage-object",
        "X-Amz-Signature",
        "connection-secret-token",
        "X-Amz-Credential",
        "connection-credential",
    ];
    assert_does_not_contain_any("stderr", &stderr, &forbidden);
    assert_does_not_contain_any("system log", &system_log_content, &forbidden);
    assert_does_not_contain_any("sandbox ops log", &ops_log_content, &forbidden);

    let expected_error = "HTTP request error (kind=io io_kind=UnexpectedEof)";

    let ops = fixture.ops_entries().unwrap();
    assert!(
        ops.iter()
            .any(|entry| entry["action_type"] == "storage_download"
                && entry["success"] == false
                && entry["error"]
                    .as_str()
                    .is_some_and(|error| error.contains(expected_error))),
        "missing classified storage_download entry: {ops_log_content}"
    );
    assert_download_total_success_present(&ops, false);
}

#[cfg(unix)]
#[test]
fn binary_timeout_terminates_child_and_connection_responder() {
    let server = ConnectionDropServer::start_holding().unwrap();
    let fixture = BinaryLoggingFixture::new("held-connection-timeout").unwrap();
    let mount = fixture.dir.path().join("mount");
    let url = format!("{}/held.tar.gz", server.base_url());
    let manifest =
        write_manifest(&fixture.dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();
    let execution = fixture.spawn_manifest_path(&manifest).unwrap();
    let child_id = execution.id().unwrap();

    server.wait_for_request().unwrap();
    let error = execution.wait_with_timeout(Duration::ZERO).unwrap_err();
    let accepted = server.finish().unwrap();

    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    let message = error.to_string();
    assert!(message.contains("guest-storage-apply timed out after 0ns"));
    assert!(message.contains("kill=signal sent"));
    assert!(message.contains("reap=completed with"));
    assert!(message.contains("stdout="));
    assert!(message.contains("stderr="));
    assert!(message.contains("[INFO] [sandbox:guest-storage-apply] Downloading 1 items"));
    assert_eq!(accepted, 1);
    process::verify_child_reaped(child_id).unwrap();
}

#[test]
fn binary_records_artifact_404_as_fatal_status() {
    let server = MockServer::start();

    let mock = server.mock(|when, then| {
        when.method(GET)
            .path("/failing-artifact-object/archive.tar.gz");
        then.status(404);
    });

    let fixture = BinaryLoggingFixture::new("artifact-secret-url-fatal").unwrap();
    let mount = fixture.dir.path().join("artifact-mount");
    let url = server.url(
        "/failing-artifact-object/archive.tar.gz?X-Amz-Signature=artifact-secret-token&X-Amz-Credential=artifact-credential",
    );
    let manifest = write_manifest(
        &fixture.dir,
        &[],
        Some((mount.to_str().unwrap(), Some(&url))),
    )
    .unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(!output.status.success());
    mock.assert_calls(1);

    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log_content = fixture.read_system_log().unwrap();
    let ops_log_content = fixture.read_ops_log().unwrap();
    let forbidden = [
        url.as_str(),
        "failing-artifact-object",
        "X-Amz-Signature",
        "artifact-secret-token",
        "X-Amz-Credential",
        "artifact-credential",
    ];
    assert_does_not_contain_any("stderr", &stderr, &forbidden);
    assert_does_not_contain_any("system log", &system_log_content, &forbidden);
    assert_does_not_contain_any("sandbox ops log", &ops_log_content, &forbidden);
    assert!(
        stderr.contains("HTTP status 404"),
        "unexpected stderr: {stderr}"
    );

    let ops = fixture.ops_entries().unwrap();
    assert!(
        ops.iter()
            .any(|entry| entry["action_type"] == "artifact_download"
                && entry["success"] == false
                && entry["error"]
                    .as_str()
                    .is_some_and(|error| error.contains("HTTP status 404")
                        && error.contains("mountPath=")
                        && error.contains("urlScheme=http"))),
        "missing failed artifact_download entry: {ops_log_content}"
    );
    assert_download_total_success_present(&ops, false);
}

#[test]
fn binary_does_not_log_file_archive_path_on_missing_local_file() {
    let fixture = BinaryLoggingFixture::new("secret-file-path").unwrap();
    let missing = fixture.dir.path().join("secret-staged-archive.tar.gz");
    assert!(!missing.exists());

    let mount = fixture.dir.path().join("mount");
    let url = format!("file://{}", missing.display());
    let manifest =
        write_manifest(&fixture.dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(!output.status.success());

    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log_content = fixture.read_system_log().unwrap();
    let ops_log_content = fixture.read_ops_log().unwrap();
    let missing_path = missing.to_string_lossy();
    let forbidden = [url.as_str(), missing_path.as_ref(), "secret-staged-archive"];
    assert_does_not_contain_any("stderr", &stderr, &forbidden);
    assert_does_not_contain_any("system log", &system_log_content, &forbidden);
    assert_does_not_contain_any("sandbox ops log", &ops_log_content, &forbidden);
    let ops = fixture.ops_entries().unwrap();
    assert!(
        ops.iter().any(|entry| {
            entry["action_type"] == "storage_download"
                && entry["success"] == false
                && entry["outcome"] == "file_unknown"
                && entry["reason"] == "other"
        }),
        "missing bounded failed local attribution: {ops_log_content}"
    );
}

#[cfg(unix)]
#[test]
fn binary_classifies_non_file_local_archive_as_unknown_without_logging_path() {
    let fixture = BinaryLoggingFixture::new("secret-non-file-path").unwrap();
    let non_file = fixture.dir.path().join("secret-staged-archive-directory");
    std::fs::create_dir(&non_file).unwrap();

    let mount = fixture.dir.path().join("mount");
    let url = format!("file://{}", non_file.display());
    let manifest =
        write_manifest(&fixture.dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log_content = fixture.read_system_log().unwrap();
    let ops_log_content = fixture.read_ops_log().unwrap();
    let non_file_path = non_file.to_string_lossy();
    let forbidden = [
        url.as_str(),
        non_file_path.as_ref(),
        "secret-staged-archive",
    ];
    assert_does_not_contain_any("stderr", &stderr, &forbidden);
    assert_does_not_contain_any("system log", &system_log_content, &forbidden);
    assert_does_not_contain_any("sandbox ops log", &ops_log_content, &forbidden);
    let ops = fixture.ops_entries().unwrap();
    assert!(
        ops.iter().any(|entry| {
            entry["action_type"] == "storage_download"
                && entry["success"] == false
                && entry["outcome"] == "file_unknown"
                && entry["reason"] == "other"
        }),
        "missing bounded failed local attribution: {ops_log_content}"
    );
}
