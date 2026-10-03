//! Public non-authentic codec canaries, never real Kerberos credentials or peer tokens.
use kerberos_credentials::{Principal, ServiceTicketCache};
use kerberos_worker::{Credentials, Source, TicketPolicy};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub fn principal(parts: &[&str]) -> Principal {
    Principal::new(
        "ISSUE37612.INVALID".into(),
        parts.iter().map(|p| (*p).into()).collect(),
    )
    .unwrap()
}
fn counted(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&u32::try_from(bytes.len()).unwrap().to_be_bytes());
    out.extend_from_slice(bytes);
}
fn file_principal(out: &mut Vec<u8>, parts: &[&str]) {
    out.extend_from_slice(&2u32.to_be_bytes());
    out.extend_from_slice(&u32::try_from(parts.len()).unwrap().to_be_bytes());
    counted(out, b"ISSUE37612.INVALID");
    for part in parts {
        counted(out, part.as_bytes());
    }
}
fn der(tag: u8, bytes: &[u8]) -> Vec<u8> {
    assert!(bytes.len() < 128);
    let mut out = vec![tag, u8::try_from(bytes.len()).unwrap()];
    out.extend_from_slice(bytes);
    out
}
pub fn ticket(host: &str) -> Vec<u8> {
    let mut fields = der(0xa0, &der(2, &[5]));
    fields.extend(der(0xa1, &der(0x1b, b"ISSUE37612.INVALID")));
    let mut components = der(0x1b, b"vnc");
    components.extend(der(0x1b, host.as_bytes()));
    let mut name = der(0xa0, &der(2, &[2]));
    name.extend(der(0xa1, &der(0x30, &components)));
    fields.extend(der(0xa2, &der(0x30, &name)));
    let mut encrypted = der(0xa0, &der(2, &[17]));
    encrypted.extend(der(0xa1, &der(2, &[1])));
    encrypted.extend(der(0xa2, &der(4, &[0; 16])));
    fields.extend(der(0xa3, &der(0x30, &encrypted)));
    der(0x61, &der(0x30, &fields))
}
pub fn now_seconds() -> u32 {
    u32::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    )
    .unwrap()
}
pub fn credentials(encoded_host: &str) -> Credentials {
    credentials_with_ticket(ticket(encoded_host))
}
pub fn credentials_with_ticket(encoded: Vec<u8>) -> Credentials {
    let now = now_seconds();
    credentials_until(encoded, now, now + 60)
}
pub fn credentials_until(encoded: Vec<u8>, now: u32, end: u32) -> Credentials {
    let mut file = vec![5, 4, 0, 0];
    file_principal(&mut file, &["probe"]);
    file_principal(&mut file, &["probe"]);
    file_principal(&mut file, &["vnc", "fixture"]);
    file.extend_from_slice(&17u16.to_be_bytes());
    counted(&mut file, &[0; 16]);
    for time in [now - 1, now - 1, end, 0] {
        file.extend_from_slice(&time.to_be_bytes());
    }
    file.push(0);
    file.extend_from_slice(&0u32.to_be_bytes());
    file.extend_from_slice(&0u32.to_be_bytes());
    file.extend_from_slice(&0u32.to_be_bytes());
    counted(&mut file, &encoded);
    counted(&mut file, &[]);
    let client = principal(&["probe"]);
    let server = principal(&["vnc", "fixture"]);
    let parsed = ServiceTicketCache::parse(file, &client, &server, now).unwrap();
    Credentials::new(client, server, Source::Ticket(parsed)).unwrap()
}
pub fn root() -> tempfile::TempDir {
    fs::create_dir_all(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let root = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    root
}
pub fn policy() -> TicketPolicy {
    TicketPolicy::new(Duration::from_secs(60), Duration::ZERO).unwrap()
}
