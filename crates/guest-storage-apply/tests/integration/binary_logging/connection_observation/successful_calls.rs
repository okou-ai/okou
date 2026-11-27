use super::*;
use crate::support::{TcpTestServer, assert_does_not_contain_any, create_tar_gz};
use guest_contracts::storage_files::{self, StorageFile};
use serde_json::json;

fn respond_reusable_error(stream: &mut TcpStream) -> io::Result<()> {
    // The HTTP error path drains the response and allows the next request
    // to reuse this connection.
    let body = b"private-response-content";
    write!(
        stream,
        "HTTP/1.1 403 Forbidden\r\nContent-Length: {}\r\nConnection: keep-alive\r\nX-Private: private-header\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()
}

fn respond_reusable_archive(stream: &mut TcpStream, body: &[u8]) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()
}

#[test]
fn binary_reuses_connection_after_successful_fixed_length_archive() {
    let first = create_tar_gz(&[("first", b"first archive")]).unwrap();
    let second = create_tar_gz(&[("second", b"second archive")]).unwrap();
    let server = TcpTestServer::start(move |server| {
        let mut stream = accept(&server)?;
        request(&mut stream, "/first")?;
        respond_reusable_archive(&mut stream, &first)?;

        let next_path = read_http_request_path(&mut stream)?;
        let reused = !next_path.is_empty();
        if reused {
            assert_eq!(next_path, "/second");
        } else {
            stream = accept(&server)?;
            request(&mut stream, "/second")?;
        }
        respond(&mut stream, &second)?;
        Ok(reused)
    })
    .unwrap();
    let fixture = BinaryLoggingFixture::new("connection-success-reuse").unwrap();
    let parent = fixture.dir.path().join("mount");
    let child = parent.join("child");
    // Overlapping mounts serialize the two successful downloads.
    let manifest = json!({"storageMounts": [
        {"mountPath": parent, "archiveUrl": format!("{}/first", server.base_url())},
        {"mountPath": child, "archiveUrl": format!("{}/second", server.base_url())}
    ]});
    let output = run_manifest(&fixture, &manifest).unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        std::fs::read(parent.join("first")).unwrap(),
        b"first archive"
    );
    assert_eq!(
        std::fs::read(child.join("second")).unwrap(),
        b"second archive"
    );
    assert!(server.finish().unwrap(), "expected the same TCP connection");
    let records = observations(&fixture).unwrap();
    assert_eq!(records.len(), 2, "{records:?}");
    assert_record(&records[0], "response_headers", "new_for_call_only");
    assert_record(&records[1], "response_headers", "prior_call_only");
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
fn concurrent_calls_keep_observations_separate_and_reuse_connections() {
    const WAVE_SIZE: usize = 4;
    let archive = create_tar_gz(&[("result", b"independent")]).unwrap();
    let server = TcpTestServer::start(move |server| {
        let mut streams = Vec::new();
        let mut first_paths = Vec::new();
        // Hold every response until all four requests arrive. Each call must
        // own a different connection; no elapsed-time concurrency assertion.
        for _ in 0..WAVE_SIZE {
            let mut stream = accept(&server)?;
            first_paths.push(read_http_request_path(&mut stream)?);
            streams.push(stream);
        }
        for stream in &mut streams {
            respond_reusable_archive(stream, &archive)?;
        }
        let mut second_paths = Vec::new();
        for stream in &mut streams {
            let path = read_http_request_path(stream)?;
            if path.is_empty() {
                return Err(io::Error::other("archive connection closed before reuse"));
            }
            second_paths.push(path);
        }
        for stream in &mut streams {
            respond(stream, &archive)?;
        }
        first_paths.sort();
        second_paths.sort();
        Ok((first_paths, second_paths))
    })
    .unwrap();
    let fixture = BinaryLoggingFixture::new("connection-concurrent").unwrap();
    let parent = fixture.dir.path().join("mounts");
    let first_mounts: Vec<_> = (0..WAVE_SIZE)
        .map(|index| parent.join(format!("mount-{index}")))
        .collect();
    // Each follow-up waits for its active parent, which returns its connection
    // to the pool before releasing the reservation.
    let mounts: Vec<_> = first_mounts
        .iter()
        .cloned()
        .chain(first_mounts.iter().map(|mount| mount.join("follow-up")))
        .collect();
    let storage_mounts = mounts
        .iter()
        .enumerate()
        .map(|(index, mount)| {
            let url = format!("{}/archive-{index}", server.base_url());
            // URI schemes are case-insensitive; every accepted remote call must
            // retain its diagnostic even when the manifest preserves mixed case.
            let url = if index == 0 {
                url.replacen("http://", "HtTp://", 1)
            } else {
                url
            };
            json!({"mountPath": mount, "archiveUrl": url})
        })
        .collect::<Vec<_>>();
    let output = run_manifest(&fixture, &json!({"storageMounts": storage_mounts})).unwrap();
    let (first_paths, second_paths) = server.finish().unwrap();
    assert!(output.status.success(), "{:?}", output);
    assert_eq!(
        first_paths,
        ["/archive-0", "/archive-1", "/archive-2", "/archive-3"]
    );
    assert_eq!(
        second_paths,
        ["/archive-4", "/archive-5", "/archive-6", "/archive-7"]
    );
    for mount in &mounts {
        assert_eq!(std::fs::read(mount.join("result")).unwrap(), b"independent");
    }
    let records = observations(&fixture).unwrap();
    assert_eq!(records.len(), 2 * WAVE_SIZE, "{records:?}");
    let new_connections = records
        .iter()
        .filter(|record| record["transport_use"] == "new_for_call_only")
        .collect::<Vec<_>>();
    assert_eq!(new_connections.len(), WAVE_SIZE);
    for record in new_connections {
        assert_record(record, "response_headers", "new_for_call_only");
        assert_phase(record, "resolve_outside_setup", 1, 0);
        assert_phase(record, "resolve_inside_setup", 0, 0);
        assert_phase(record, "connection_setup", 1, 0);
    }
    for record in records
        .iter()
        .filter(|record| record["transport_use"] != "new_for_call_only")
    {
        assert_record(record, "response_headers", "prior_call_only");
        assert_phase(record, "resolve_outside_setup", 1, 0);
        assert_phase(record, "resolve_inside_setup", 0, 0);
        assert_phase(record, "connection_setup", 0, 0);
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
