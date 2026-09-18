use super::*;
use crate::support::TcpTestServer;
use serde_json::json;

#[test]
fn returned_call_outcome_is_separate_from_http_status_and_archive_success() {
    for (name, response, outcome) in [
        (
            "http-error",
            b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".as_slice(),
            "response_headers",
        ),
        (
            "invalid-archive",
            b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\ninvalid".as_slice(),
            "response_headers",
        ),
        ("protocol-error", b"not HTTP\r\n\r\n".as_slice(), "error"),
    ] {
        let server = TcpTestServer::start(move |server| {
            let mut stream = accept(&server)?;
            request(&mut stream, "/archive")?;
            stream.write_all(response)?;
            stream.flush()?;
            Ok(1)
        })
        .unwrap();
        let fixture = BinaryLoggingFixture::new(name).unwrap();
        let mount = fixture.dir.path().join("mount");
        let output = run_manifest(
            &fixture,
            &json!({"storageMounts": [{
                "mountPath": mount, "archiveUrl": format!("{}/archive", server.base_url())
            }]}),
        )
        .unwrap();
        assert_eq!(output.status.code(), Some(1), "{:?}", output);
        assert_eq!(server.finish().unwrap(), 1);
        assert_eq!(std::fs::read_dir(&mount).unwrap().count(), 0);
        let records = observations(&fixture).unwrap();
        assert_eq!(records.len(), 1, "{records:?}");
        assert_record(&records[0], outcome, "new_for_call_only");
        assert_phase(&records[0], "resolve_outside_setup", 1, 0);
        assert_phase(&records[0], "resolve_inside_setup", 0, 0);
        assert_phase(&records[0], "connection_setup", 1, 0);
    }
}

#[cfg(unix)]
#[test]
fn externally_killed_call_does_not_fabricate_a_terminal_observation() {
    use std::io::Read as _;
    use std::os::unix::process::ExitStatusExt as _;
    use std::sync::mpsc;

    let (requested_tx, requested_rx) = mpsc::channel();
    let server = TcpTestServer::start(move |server| {
        let mut stream = accept(&server)?;
        request(&mut stream, "/held-headers")?;
        requested_tx.send(()).map_err(io::Error::other)?;
        let mut byte = [0];
        match stream.read(&mut byte) {
            Ok(0) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::ConnectionReset => Ok(()),
            other => Err(io::Error::other(format!(
                "expected child disconnect, got {other:?}"
            ))),
        }
    })
    .unwrap();
    let fixture = BinaryLoggingFixture::new("connection-external-kill").unwrap();
    let mount = fixture.dir.path().join("mount");
    let child = spawn_manifest(
        &mut command(&fixture),
        &json!({"storageMounts": [{
            "mountPath": mount, "archiveUrl": format!("{}/held-headers", server.base_url())
        }]}),
    )
    .unwrap();
    requested_rx.recv_timeout(SOCKET_TIMEOUT).unwrap();
    let child_id = child.id().unwrap();
    let pid = libc::pid_t::try_from(child_id).unwrap();
    // SAFETY: the PID belongs to the live child owned by CommandExecution;
    // the socket gate proves its call has not received response headers.
    assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
    let output = child.wait().unwrap();
    assert_eq!(output.status.signal(), Some(libc::SIGKILL));
    crate::process::verify_child_reaped(child_id).unwrap();
    server.finish().unwrap();
    assert_eq!(std::fs::read_dir(&mount).unwrap().count(), 0);
    assert!(observations(&fixture).unwrap().is_empty());
}
