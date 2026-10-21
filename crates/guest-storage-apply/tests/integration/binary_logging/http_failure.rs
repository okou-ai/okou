use super::BinaryLoggingFixture;
use crate::support::{TcpTestServer, read_http_request_path};
use httpmock::prelude::*;
use serde_json::json;
use std::io::{self, Write};
use std::time::Duration;

#[test]
fn forbidden_response_codes_are_distinct_without_echoing_arbitrary_messages() {
    let server = MockServer::start();
    for code in ["ExpiredRequest", "SignatureDoesNotMatch", "AccessDenied"] {
        let path = format!("/{code}/archive.tar.gz");
        let denied = server.mock(|when, then| {
            when.method(GET).path(&path);
            then.status(403).body(format!(
                "<Error><Code>{code}</Code><Message>private-message-secret</Message></Error>"
            ));
        });
        let fixture = BinaryLoggingFixture::new(code).unwrap();
        let manifest = json!({"storageMounts": [{
            "mountPath": fixture.dir.path().join("mount"),
            "archiveUrl": server.url(&path)
        }]});
        let output = fixture
            .run_manifest_stdin(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();

        assert_eq!(output.status.code(), Some(1));
        denied.assert_calls(1);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(&format!("s3_code={code}")), "{stderr}");
        assert!(!stderr.contains("private-message-secret"), "{stderr}");
    }
}

#[test]
fn untrusted_error_bodies_do_not_replace_the_original_http_failure_or_leak() {
    let server = MockServer::start();
    let cases = [
        ("<Error>private-body-secret".to_string(), "response_body=unrecognized"),
        ("<Error><Code>private-body-secret</Code></Error>".to_string(), "s3_code=unrecognized"),
        ("private-body-secret".repeat(4096), "response_body=too_large"),
        ("<!DOCTYPE Error [<!ENTITY secret 'private-body-secret'>]><Error><Code>&secret;</Code></Error>".to_string(), "response_body=unrecognized"),
    ];
    for (index, (body, expected)) in cases.into_iter().enumerate() {
        let path = format!("/{index}/archive.tar.gz");
        let denied = server.mock(|when, then| {
            when.method(GET).path(&path);
            then.status(403).body(body);
        });
        let fixture = BinaryLoggingFixture::new("untrusted-http-error").unwrap();
        let manifest = json!({"storageMounts": [{
            "mountPath": fixture.dir.path().join("mount"),
            "archiveUrl": server.url(&path)
        }]});
        let output = fixture
            .run_manifest_stdin(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();

        assert_eq!(output.status.code(), Some(1));
        denied.assert_calls(1);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("HTTP status 403"), "{stderr}");
        assert!(stderr.contains(expected), "{stderr}");
        assert!(!stderr.contains("private-body-secret"), "{stderr}");
    }
}

#[test]
fn truncated_forbidden_body_keeps_status() {
    let server = TcpTestServer::start(|server| {
        let mut stream = server
            .accept()?
            .ok_or_else(|| io::Error::other("missing archive request"))?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        read_http_request_path(&mut stream)?;
        stream.write_all(
            b"HTTP/1.1 403 Forbidden\r\nContent-Length: 1024\r\nConnection: close\r\n\r\n<Error>private-body-secret",
        )?;
        Ok(())
    })
    .unwrap();
    let fixture = BinaryLoggingFixture::new("truncated-forbidden-body").unwrap();
    let manifest = json!({"storageMounts": [{
        "mountPath": fixture.dir.path().join("mount"),
        "archiveUrl": format!("{}/archive.tar.gz", server.base_url())
    }]});

    let output = fixture
        .run_manifest_stdin(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();
    server.finish().unwrap();

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("HTTP status 403"), "{stderr}");
    assert!(stderr.contains("response_body=unavailable"), "{stderr}");
    assert!(!stderr.contains("Attempt 2/3"), "{stderr}");
    assert!(!stderr.contains("private-body-secret"), "{stderr}");
}
