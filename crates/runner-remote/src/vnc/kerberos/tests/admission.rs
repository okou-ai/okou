//! Structural private handoffs; these synthetic credentials are not live tickets.
use super::*;
use base64::Engine;
use serde_json::{Value, json};

fn fixture(mode: &str) -> Vec<u8> {
    let text = include_str!("../../../../../kerberos-credentials/tests/fixtures/conformance.tsv");
    let line = text
        .lines()
        .find(|line| line.starts_with(&format!("{mode}\t")))
        .unwrap();
    let encoded = line.split('\t').nth(2).unwrap();
    encoded
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|bytes| u8::from_str_radix(std::str::from_utf8(bytes).unwrap(), 16).unwrap())
        .collect()
}

fn offline() -> Vec<u8> {
    fn data(bytes: &mut Vec<u8>, value: &[u8]) {
        bytes.extend_from_slice(&(value.len() as u32).to_be_bytes());
        bytes.extend_from_slice(value);
    }
    fn name(bytes: &mut Vec<u8>, parts: &[&str], kind: u32) {
        bytes.extend_from_slice(&kind.to_be_bytes());
        bytes.extend_from_slice(&(parts.len() as u32).to_be_bytes());
        data(bytes, b"EXAMPLE.INVALID");
        for part in parts {
            data(bytes, part.as_bytes());
        }
    }
    let mut bytes = vec![5, 4, 0, 0];
    name(&mut bytes, &["alice"], 1);
    name(&mut bytes, &["alice"], 1);
    name(&mut bytes, &["vnc", "host.example.invalid"], 2);
    bytes.extend_from_slice(&18u16.to_be_bytes());
    data(&mut bytes, &[0x37; 32]);
    let now = u32::try_from(chrono::Utc::now().timestamp()).unwrap();
    for time in [now - 1, now - 1, now + 3600, 0] {
        bytes.extend_from_slice(&time.to_be_bytes());
    }
    bytes.push(0);
    for _ in 0..3 {
        bytes.extend_from_slice(&0u32.to_be_bytes());
    }
    data(&mut bytes, b"SYNTHETIC_NOT_A_REAL_TICKET");
    data(&mut bytes, &[]);
    bytes
}

fn route(kind: &str) -> Value {
    match kind {
        "direct" => json!({"type":"direct"}),
        "ssh" => json!({"type":"ssh","connectionId":CONNECTION,"generation":7}),
        _ => {
            let mut route = json!({"type":kind,"configId":CONNECTION,"generation":7,
                "credentials":{"clientId":"synthetic-client","clientSecret":"synthetic-secret"}});
            if kind == "tailscale" {
                route["tags"] = json!(["tag:ssh"]);
            }
            route
        }
    }
}

fn response(source: &str, rfb: &str, kdc: Option<&str>) -> Value {
    let principal = json!({"realm":"EXAMPLE.INVALID","components":["alice"]});
    let service = json!({"realm":"EXAMPLE.INVALID","components":["vnc","host.example.invalid"]});
    let encoded = base64::engine::general_purpose::STANDARD;
    let authentication = match source {
        "password" => {
            json!({"method":"qemu_kerberos_password","initiator":principal,"password":"secret"})
        }
        "keytab" => {
            json!({"method":"qemu_kerberos_keytab","initiator":principal,"keytab":encoded.encode(fixture("keytab"))})
        }
        _ => {
            json!({"method":"qemu_kerberos_ticket","initiator":principal,"service":service,"ticketCache":encoded.encode(offline())})
        }
    };
    let mut rfb_route = route(rfb);
    if rfb == "cloudflare_access" {
        rfb_route["originTls"] = Value::Null;
    }
    json!({"outcome":"resolved_kerberos","host":"desktop.example.test","port":if rfb=="cloudflare_access"{443}else{5900},
        "generation":7,"credentialRevision":3,"serverName":"vnc.example.test","transport":rfb_route,"authentication":authentication,
        "security":{"type":"qemu_x509_gssapi","trust":{"mode":"system"},"service":service,
            "kdc":kdc.map(|kind|json!({"host":if kind=="cloudflare_access"{"kdc.example.test"}else{"peer.synthetic.ts.net"},
                "port":if kind=="cloudflare_access"{443}else{88},"transport":route(kind),"ticketLifetimeSeconds":1200,"renewableLifetimeSeconds":7200}))}})
}

fn parse(response: Value) -> Result<Credential, Failure> {
    let ResolveResponse::ResolvedKerberos {
        host,
        port,
        generation,
        credential_revision,
        server_name,
        transport,
        authentication,
        security,
    } = serde_json::from_value(response).unwrap()
    else {
        panic!("Kerberos handoff")
    };
    credential(
        chrono::Utc::now(),
        host,
        port,
        generation,
        credential_revision,
        server_name,
        transport,
        authentication,
        security,
        true,
    )
}

#[test]
fn independent_native_kdc_admission_preserves_password_keytab_and_offline_policies() {
    for rfb in ["direct", "ssh", "cloudflare_access", "tailscale"] {
        for source in ["password", "keytab"] {
            for kdc in ["cloudflare_access", "tailscale"] {
                let credential = parse(response(source, rfb, Some(kdc))).unwrap();
                let Authentication::Kerberos {
                    binding,
                    kdc,
                    credentials,
                    ..
                } = credential.authentication
                else {
                    panic!("Kerberos source")
                };
                assert!(credentials.is_online());
                assert_eq!(binding.revision, 3);
                let route = kdc.unwrap();
                assert!(route.native.is_some());
                assert!(route.node.is_none());
                assert!(binding.kdc == Some(route.transport));
                assert_eq!(
                    route.host,
                    if matches!(route.transport, Transport::Cloudflare { .. }) {
                        "kdc.example.test"
                    } else {
                        "peer.synthetic.ts.net"
                    }
                );
            }
        }
        let credential = parse(response("ticket", rfb, None)).unwrap();
        let Authentication::Kerberos {
            binding,
            kdc,
            credentials,
            ..
        } = credential.authentication
        else {
            panic!("offline source")
        };
        assert!(!credentials.is_online());
        assert!(kdc.is_none() && binding.kdc.is_none());
        for kdc in ["cloudflare_access", "tailscale"] {
            assert!(parse(response("ticket", rfb, Some(kdc))).is_err());
        }
    }
}

#[test]
fn native_kdc_does_not_relax_explicit_identity_or_snapshot_validation() {
    for kdc in ["cloudflare_access", "tailscale"] {
        for fault in ["realm", "spn", "configuration", "generation", "credentials"] {
            let mut value = response("password", "tailscale", Some(kdc));
            match fault {
                "realm" => value["security"]["service"]["realm"] = json!("WRONG.INVALID"),
                "spn" => {
                    value["security"]["service"]["components"] =
                        json!(["http", "host.example.invalid"])
                }
                "configuration" => {
                    value["security"]["kdc"]["transport"]["configId"] = json!("invalid")
                }
                "generation" => value["security"]["kdc"]["transport"]["generation"] = json!(0),
                _ => {
                    value["security"]["kdc"]["transport"]["credentials"]["clientSecret"] =
                        json!("bad\r\nheader")
                }
            }
            assert!(parse(value).is_err(), "{kdc} {fault}");
        }
    }
}
