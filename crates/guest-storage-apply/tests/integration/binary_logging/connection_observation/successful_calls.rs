use super::*;
use crate::support::{TcpTestServer, assert_does_not_contain_any, create_tar_gz};
use guest_contracts::storage_files::{self, StorageFile};
use serde_json::json;

fn respond_reusable_error(stream: &mut TcpStream) -> io::Result<()> {
    // The HTTP error path drains its reader to EOF and returns the connection
    // to the pool. A successful archive stops at the gzip trailer instead,
    // which need not advance ureq's HTTP reader through its EOF cleanup.
    let body = b"private-response-content";
    write!(
        stream,
        "HTTP/1.1 403 Forbidden\r\nContent-Length: {}\r\nConnection: keep-alive\r\nX-Private: private-header\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()
}

#[test]
fn binary_observes_cold_and_prior_call_transport_without_sensitive_fields() {
    let archive = create_tar_gz(&[("private-file", b"private-file-content")]).unwrap();
    let server = TcpTestServer::start(move |server| {
        let mut stream = accept(&server)?;
        request(&mut stream, "/private-first?signature=private-signature")?;
        respond_reusable_error(&mut stream)?;
        request(&mut stream, "/private-second?credential=private-credential")?;
        respond(&mut stream, &archive)?;
        Ok(2)
    })
    .unwrap();
    let fixture = BinaryLoggingFixture::new("connection-reuse").unwrap();
    let parent = fixture.dir.path().join("private-mount");
    let child = parent.join("child");
    // Conflicting mount paths serialize the calls through the real scheduler.
    let manifest = json!({"storageMounts": [
        {"mountPath": parent, "archiveUrl": format!("{}/private-first?signature=private-signature", server.base_url())},
        {"mountPath": child, "archiveUrl": format!("{}/private-second?credential=private-credential", server.base_url())}
    ]});
    let output = run_manifest(&fixture, &manifest).unwrap();
    assert_eq!(server.finish().unwrap(), 2);
    assert_eq!(output.status.code(), Some(1), "{:?}", output);
    assert!(!parent.join("private-file").exists());
    assert_eq!(
        std::fs::read(child.join("private-file")).unwrap(),
        b"private-file-content"
    );
    let records = observations(&fixture).unwrap();
    assert_eq!(records.len(), 2, "{records:?}");
    assert_record(&records[0], "response_headers", "new_for_call_only");
    assert_record(&records[1], "response_headers", "prior_call_only");
    assert_phase(&records[0], "connection_setup", 1, 0);
    assert_phase(&records[1], "connection_setup", 0, 0);
    for record in &records {
        assert_phase(record, "resolve_outside_setup", 1, 0);
        assert_phase(record, "resolve_inside_setup", 0, 0);
        assert_does_not_contain_any(
            "connection observation",
            &record.to_string(),
            &[
                "private-",
                "127.0.0.1",
                "http://",
                fixture.dir.path().to_str().unwrap(),
            ],
        );
    }
}

#[test]
fn concurrent_calls_keep_observations_separate() {
    let archive = create_tar_gz(&[("result", b"independent")]).unwrap();
    let server = TcpTestServer::start(move |server| {
        let mut streams = Vec::new();
        let mut paths = Vec::new();
        // Hold every response until all four requests arrive. Each call must
        // own a different connection; no elapsed-time concurrency assertion.
        for _ in 0..4 {
            let mut stream = accept(&server)?;
            paths.push(read_http_request_path(&mut stream)?);
            streams.push(stream);
        }
        for stream in &mut streams {
            respond(stream, &archive)?;
        }
        paths.sort();
        Ok(paths)
    })
    .unwrap();
    let fixture = BinaryLoggingFixture::new("connection-concurrent").unwrap();
    let mounts: Vec<_> = (0..4)
        .map(|index| fixture.dir.path().join(format!("mount-{index}")))
        .collect();
    let manifest = json!({"storageMounts": mounts.iter().enumerate().map(|(index, mount)| {
        let url = format!("{}/archive-{index}", server.base_url());
        // URI schemes are case-insensitive; every accepted remote call must
        // retain its diagnostic even when the manifest preserves mixed case.
        let url = if index == 0 { url.replacen("http://", "HtTp://", 1) } else { url };
        json!({"mountPath": mount, "archiveUrl": url})
    }).collect::<Vec<_>>()});
    let output = run_manifest(&fixture, &manifest).unwrap();
    assert!(output.status.success(), "{:?}", output);
    assert_eq!(
        server.finish().unwrap(),
        ["/archive-0", "/archive-1", "/archive-2", "/archive-3"]
    );
    for mount in &mounts {
        assert_eq!(std::fs::read(mount.join("result")).unwrap(), b"independent");
    }
    let records = observations(&fixture).unwrap();
    assert_eq!(records.len(), 4, "{records:?}");
    for record in &records {
        assert_record(record, "response_headers", "new_for_call_only");
        assert_phase(record, "resolve_outside_setup", 1, 0);
        assert_phase(record, "resolve_inside_setup", 0, 0);
        assert_phase(record, "connection_setup", 1, 0);
    }
}

#[test]
fn redirect_call_can_use_both_prior_and_new_transports() {
    let archive = create_tar_gz(&[("result", b"redirected")]).unwrap();
    let destination = TcpTestServer::start(move |server| {
        let mut stream = accept(&server)?;
        request(&mut stream, "/final")?;
        respond(&mut stream, &archive)?;
        Ok(1)
    })
    .unwrap();
    let location = format!("{}/final", destination.base_url());
    let origin = TcpTestServer::start(move |server| {
        let mut stream = accept(&server)?;
        request(&mut stream, "/first")?;
        respond_reusable_error(&mut stream)?;
        request(&mut stream, "/redirect")?;
        write!(stream, "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
        stream.flush()?;
        Ok(2)
    })
    .unwrap();
    let fixture = BinaryLoggingFixture::new("connection-redirect").unwrap();
    let parent = fixture.dir.path().join("parent");
    let child = parent.join("child");
    let output = run_manifest(
        &fixture,
        &json!({"storageMounts": [
            {"mountPath": parent, "archiveUrl": format!("{}/first", origin.base_url())},
            {"mountPath": child, "archiveUrl": format!("{}/redirect", origin.base_url())}
        ]}),
    )
    .unwrap();
    assert_eq!(origin.finish().unwrap(), 2);
    assert_eq!(destination.finish().unwrap(), 1);
    assert_eq!(output.status.code(), Some(1), "{:?}", output);
    assert!(!parent.join("result").exists());
    assert_eq!(std::fs::read(child.join("result")).unwrap(), b"redirected");
    let records = observations(&fixture).unwrap();
    assert_eq!(
        records.len(),
        2,
        "redirect wire requests must share one record"
    );
    assert_record(&records[0], "response_headers", "new_for_call_only");
    assert_record(&records[1], "response_headers", "mixed");
    assert_phase(&records[1], "resolve_outside_setup", 2, 0);
    assert_phase(&records[1], "resolve_inside_setup", 0, 0);
    assert_phase(&records[1], "connection_setup", 1, 0);
}

#[test]
fn local_and_decoded_files_do_not_emit_remote_observations() {
    let fixture = BinaryLoggingFixture::new("connection-local-decoded").unwrap();
    let archive = fixture.dir.path().join("archive.tar.gz");
    std::fs::write(&archive, create_tar_gz(&[("local", b"from-file")]).unwrap()).unwrap();
    let local = fixture.dir.path().join("local");
    let decoded = fixture.dir.path().join("decoded");
    let manifest = serde_json::to_vec(&json!({"storageMounts": [
        {"mountPath": local, "archiveUrl": format!("file://{}", archive.display())},
        {"mountPath": decoded, "archiveUrl": "https://must-not-fetch.invalid/archive"}
    ]}))
    .unwrap();
    let files = [StorageFile {
        path: "decoded".into(),
        mode: 0o644,
        mtime: 100,
        content: b"from-decoded".to_vec(),
    }];
    let input =
        storage_files::encode_input(&manifest, &[(decoded.to_str().unwrap(), &files)]).unwrap();
    let output =
        CommandExecution::spawn(command(&fixture).arg("--storage-files-stdin"), Some(&input))
            .unwrap()
            .wait()
            .unwrap();
    assert!(output.status.success(), "{:?}", output);
    assert_eq!(std::fs::read(local.join("local")).unwrap(), b"from-file");
    assert_eq!(
        std::fs::read(decoded.join("decoded")).unwrap(),
        b"from-decoded"
    );
    assert!(observations(&fixture).unwrap().is_empty());
}
