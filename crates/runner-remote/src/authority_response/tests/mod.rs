//! Raw authority responses consumed through both public SSH and VNC RPC owners.

use raw_http_test_support::raw_http::RawHttpAction;

pub(crate) struct Scenario {
    pub(crate) name: &'static str,
    pub(crate) action: RawHttpAction,
    pub(crate) reason: &'static str,
}

fn response(body: &[u8], chunked: bool) -> Vec<u8> {
    if !chunked {
        let mut bytes = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        bytes.extend_from_slice(body);
        return bytes;
    }
    let mut bytes =
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
    for chunk in body.chunks(32 * 1024) {
        bytes.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
        bytes.extend_from_slice(chunk);
        bytes.extend_from_slice(b"\r\n");
    }
    bytes.extend_from_slice(b"0\r\n\r\n");
    bytes
}

pub(crate) fn scenarios() -> Vec<Scenario> {
    let mut cases = Vec::new();
    for (length, reason) in [
        (512 * 1024, "unavailable"),
        (512 * 1024 + 1, "authority_failure"),
    ] {
        let mut body = br#"{"outcome":"unavailable"}"#.to_vec();
        body.resize(length, b' ');
        for chunked in [false, true] {
            cases.push(Scenario {
                name: match (chunked, reason) {
                    (false, "unavailable") => "declared exact limit",
                    (true, "unavailable") => "chunked exact limit",
                    (false, _) => "declared one-byte overflow",
                    (true, _) => "chunked one-byte overflow",
                },
                action: RawHttpAction::Respond(response(&body, chunked)),
                reason,
            });
        }
    }
    for (name, bytes) in [
        ("declared overflow before body", b"HTTP/1.1 200 OK\r\nContent-Length: 524289\r\nConnection: close\r\n\r\n".as_slice()),
        ("truncated transfer", b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nauthority-response-secret-canary".as_slice()),
        ("non-200 response", b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".as_slice()),
    ] {
        cases.push(Scenario {
            name,
            action: RawHttpAction::Respond(bytes.to_vec()),
            reason: "authority_failure",
        });
    }
    cases.push(Scenario {
        name: "malformed JSON",
        action: RawHttpAction::Respond(response(b"authority-response-secret-canary", false)),
        reason: "authority_failure",
    });
    cases.push(Scenario {
        name: "disconnected authority",
        action: RawHttpAction::Disconnect,
        reason: "authority_failure",
    });
    cases
}
