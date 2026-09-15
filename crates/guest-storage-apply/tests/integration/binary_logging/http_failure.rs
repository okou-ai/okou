use super::BinaryLoggingFixture;
use crate::support::{TcpTestServer, assert_does_not_contain_any, read_http_request_path};
use httpmock::prelude::*;
use serde_json::json;
use std::io::{self, Write};
use std::time::Duration;

#[test]
fn denied_instructions_preserve_safe_http_evidence_and_remove_staging() {
    let server = MockServer::start();
    let denied = server.mock(|when, then| {
        when.method(GET).path("/private-object/archive.tar.gz");
        then.status(403)
            .header("content-type", "application/xml")
            .header("x-amz-request-id", "request-403")
            .header("cf-ray", "0123456789abcdef-PDX")
            .body(
                r#"<?xml version="1.0"?><Error xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
                <Code>AccessDenied</Code><Message>Request has expired.</Message>
                <Resource>/private-object/archive.tar.gz</Resource>
                <StringToSign>signature-secret</StringToSign>
                </Error>"#,
            );
    });
    let fixture = BinaryLoggingFixture::new("denied-instructions").unwrap();
    let mount = fixture.dir.path().join(".codex");
    let staging = fixture.dir.path().join("storage-instructions/0");
    let url = server.url(
        "/private-object/archive.tar.gz?X-Amz-Date=20260909T105332Z&X-Amz-Expires=3600&X-Amz-Signature=signature-secret&X-Amz-Credential=credential-secret",
    );
    let manifest = json!({"storageMounts": [{
        "mountPath": mount,
        "extractPath": staging,
        "archiveUrl": url,
        "instructionsTargetFilename": "AGENTS.md"
    }]});

    let output = fixture
        .run_manifest_stdin(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    denied.assert_calls(1);
    assert!(!staging.exists());
    assert!(!mount.join("AGENTS.md").exists());
    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log = fixture.read_system_log().unwrap();
    let ops_log = fixture.read_ops_log().unwrap();
    for (name, log) in [
        ("stderr", stderr.as_ref()),
        ("system", system_log.as_str()),
        ("ops", ops_log.as_str()),
    ] {
        for evidence in [
            "HTTP status 403",
            "request_host=127.0.0.1",
            "signing_date=20260909T105332Z",
            "expires_seconds=3600",
            "s3_code=AccessDenied",
            "s3_message_kind=request_expired",
            "x-amz-request-id=request-403",
            "cf-ray=0123456789abcdef-PDX",
        ] {
            assert!(
                log.contains(evidence),
                "missing {evidence} in {name}: {log}"
            );
        }
        assert_does_not_contain_any(
            name,
            log,
            &[
                &url,
                "private-object",
                "signature-secret",
                "credential-secret",
                "StringToSign",
            ],
        );
    }
}

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
