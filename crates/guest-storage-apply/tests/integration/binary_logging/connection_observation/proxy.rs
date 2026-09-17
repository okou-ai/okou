use super::*;
use crate::support::{TcpTestServer, create_tar_gz};
use serde_json::json;

#[test]
fn environment_connect_proxy_preserves_recursive_setup_and_terminal_errors() {
    for accepted in [true, false] {
        let archive = create_tar_gz(&[("result", b"through-proxy")]).unwrap();
        let proxy = TcpTestServer::start(move |server| {
            let mut stream = accept(&server)?;
            request(&mut stream, "private-target.invalid:8080")?;
            if accepted {
                stream.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")?;
                stream.flush()?;
                request(&mut stream, "/private-archive?signature=private-token")?;
                respond(&mut stream, &archive)?;
                Ok(2)
            } else {
                stream.write_all(
                    b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )?;
                stream.flush()?;
                Ok(1)
            }
        })
        .unwrap();
        let fixture = BinaryLoggingFixture::new("connection-proxy").unwrap();
        let mount = fixture.dir.path().join("mount");
        let mut command = command(&fixture);
        command.env("HTTP_PROXY", proxy.base_url());
        let output = spawn_manifest(&mut command, &json!({"storageMounts": [{
            "mountPath": mount,
            "archiveUrl": "http://private-target.invalid:8080/private-archive?signature=private-token"
        }]})).unwrap().wait().unwrap();
        assert_eq!(output.status.success(), accepted, "{:?}", output);
        assert_eq!(proxy.finish().unwrap(), if accepted { 2 } else { 1 });
        if accepted {
            assert_eq!(
                std::fs::read(mount.join("result")).unwrap(),
                b"through-proxy"
            );
        } else {
            assert_eq!(std::fs::read_dir(&mount).unwrap().count(), 0);
        }
        let records = observations(&fixture).unwrap();
        assert_eq!(records.len(), 1, "{records:?}");
        assert_record(
            &records[0],
            if accepted {
                "response_headers"
            } else {
                "error"
            },
            if accepted {
                "new_for_call_only"
            } else {
                "unobserved"
            },
        );
        // The nested connector must not double count combined setup. The
        // resolver called by CONNECT remains separately marked as overlapping.
        assert_phase(&records[0], "resolve_outside_setup", 0, 0);
        assert_phase(&records[0], "resolve_inside_setup", 1, 0);
        assert_phase(
            &records[0],
            "connection_setup",
            u64::from(accepted),
            u64::from(!accepted),
        );
        assert!(!records[0].to_string().contains("private-"));
    }
}

#[test]
fn no_proxy_bypasses_configured_environment_proxy() {
    let archive = create_tar_gz(&[("result", b"direct")]).unwrap();
    let destination = TcpTestServer::start(move |server| {
        let mut stream = accept(&server)?;
        request(&mut stream, "/archive")?;
        respond(&mut stream, &archive)?;
        Ok(1)
    })
    .unwrap();
    let proxy = TcpTestServer::start(|server| {
        if server.accept()?.is_some() {
            return Err(io::Error::other("NO_PROXY request reached the proxy"));
        }
        Ok(0)
    })
    .unwrap();
    let fixture = BinaryLoggingFixture::new("connection-no-proxy").unwrap();
    let mount = fixture.dir.path().join("mount");
    let mut command = command(&fixture);
    command
        .env("HTTP_PROXY", proxy.base_url())
        .env("NO_PROXY", "127.0.0.1");
    let output = spawn_manifest(
        &mut command,
        &json!({"storageMounts": [{
            "mountPath": mount, "archiveUrl": format!("{}/archive", destination.base_url())
        }]}),
    )
    .unwrap()
    .wait()
    .unwrap();
    assert!(output.status.success(), "{:?}", output);
    assert_eq!(destination.finish().unwrap(), 1);
    assert_eq!(proxy.finish().unwrap(), 0);
    assert_eq!(std::fs::read(mount.join("result")).unwrap(), b"direct");
    let records = observations(&fixture).unwrap();
    assert_eq!(records.len(), 1, "{records:?}");
    assert_record(&records[0], "response_headers", "new_for_call_only");
    assert_phase(&records[0], "resolve_outside_setup", 1, 0);
    assert_phase(&records[0], "resolve_inside_setup", 0, 0);
    assert_phase(&records[0], "connection_setup", 1, 0);
}
