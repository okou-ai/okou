//! Independent structural FILE fixtures, not live Kerberos credentials.
#![cfg(test)]
use kerberos_credentials::{
    ClientKeytab, CredentialError, MAX_INPUT_BYTES, MAX_KEYS, MAX_RECORDS, MAX_TICKET_BYTES,
    Principal, ServiceTicketCache,
};

fn principal(parts: &[&str]) -> Principal {
    Principal::new(
        "EXAMPLE.INVALID".into(),
        parts.iter().map(|p| (*p).into()).collect(),
    )
    .unwrap()
}
fn client() -> Principal {
    principal(&["alice"])
}
fn server() -> Principal {
    principal(&["vnc", "host.example.invalid"])
}
fn data32(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&u32::try_from(bytes.len()).unwrap().to_be_bytes());
    out.extend_from_slice(bytes);
}
fn data16(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&u16::try_from(bytes.len()).unwrap().to_be_bytes());
    out.extend_from_slice(bytes);
}
fn name(out: &mut Vec<u8>, p: &Principal, short: bool, kind: u32) {
    if !short {
        out.extend_from_slice(&kind.to_be_bytes());
    }
    if short {
        out.extend_from_slice(&u16::try_from(p.components().len()).unwrap().to_be_bytes());
    } else {
        out.extend_from_slice(&u32::try_from(p.components().len()).unwrap().to_be_bytes());
    }
    for part in std::iter::once(p.realm()).chain(p.components().iter().map(String::as_str)) {
        if short {
            data16(out, part.as_bytes());
        } else {
            data32(out, part.as_bytes());
        }
    }
    if short {
        out.extend_from_slice(&kind.to_be_bytes());
    }
}

#[derive(Clone)]
struct Ticket {
    client: Principal,
    server: Principal,
    enctype: u16,
    key: Vec<u8>,
    times: [u32; 4],
    skey: u8,
    addresses: Vec<(u16, Vec<u8>)>,
    authdata: Vec<(u16, Vec<u8>)>,
    bytes: Vec<u8>,
    second: Vec<u8>,
}
impl Ticket {
    fn service() -> Self {
        Self {
            client: client(),
            server: server(),
            enctype: 18,
            key: vec![0x37; 32],
            times: [100, 100, 1000, 0],
            skey: 0,
            addresses: vec![],
            authdata: vec![],
            bytes: b"SYNTHETIC_NOT_A_REAL_TICKET".to_vec(),
            second: vec![],
        }
    }
    fn encode(&self) -> Vec<u8> {
        let mut v = vec![];
        name(&mut v, &self.client, false, 1);
        name(&mut v, &self.server, false, 2);
        v.extend_from_slice(&self.enctype.to_be_bytes());
        data32(&mut v, &self.key);
        for t in self.times {
            v.extend_from_slice(&t.to_be_bytes());
        }
        v.push(self.skey);
        v.extend_from_slice(&0x40000000u32.to_be_bytes());
        for items in [&self.addresses, &self.authdata] {
            v.extend_from_slice(&u32::try_from(items.len()).unwrap().to_be_bytes());
            for (kind, data) in items {
                v.extend_from_slice(&kind.to_be_bytes());
                data32(&mut v, data);
            }
        }
        data32(&mut v, &self.bytes);
        data32(&mut v, &self.second);
        v
    }
}
fn cache(header: &[u8], entries: &[Ticket]) -> Vec<u8> {
    let mut v = vec![5, 4];
    v.extend_from_slice(&u16::try_from(header.len()).unwrap().to_be_bytes());
    v.extend_from_slice(header);
    name(&mut v, &client(), false, 1);
    for t in entries {
        v.extend_from_slice(&t.encode());
    }
    v
}
fn parse_cache(bytes: Vec<u8>) -> Result<ServiceTicketCache, CredentialError> {
    ServiceTicketCache::parse(bytes, &client(), &server(), 200)
}

#[derive(Clone)]
struct Key {
    principal: Principal,
    timestamp: u32,
    kvno8: u8,
    enctype: u16,
    bytes: Vec<u8>,
    wide: Option<u32>,
    padding: Vec<u8>,
}
impl Key {
    fn aes(enctype: u16) -> Self {
        Self {
            principal: client(),
            timestamp: 100,
            kvno8: 2,
            enctype,
            bytes: vec![0x53; if enctype == 17 { 16 } else { 32 }],
            wide: Some(2),
            padding: vec![],
        }
    }
    fn record(&self) -> Vec<u8> {
        let mut v = vec![];
        name(&mut v, &self.principal, true, 1);
        v.extend_from_slice(&self.timestamp.to_be_bytes());
        v.push(self.kvno8);
        v.extend_from_slice(&self.enctype.to_be_bytes());
        data16(&mut v, &self.bytes);
        if let Some(n) = self.wide {
            v.extend_from_slice(&n.to_be_bytes());
        }
        v.extend_from_slice(&self.padding);
        v
    }
}
fn keytab(keys: &[Key]) -> Vec<u8> {
    let mut v = vec![5, 2];
    for k in keys {
        let r = k.record();
        v.extend_from_slice(&i32::try_from(r.len()).unwrap().to_be_bytes());
        v.extend_from_slice(&r);
    }
    v
}
fn parse_keytab(bytes: Vec<u8>) -> Result<ClientKeytab, CredentialError> {
    ClientKeytab::parse(bytes, &client())
}

#[test]
fn cache_selects_only_exact_service_and_is_idempotent() {
    let selected = Ticket::service();
    let mut tgt = selected.clone();
    tgt.server = principal(&["krbtgt", "EXAMPLE.INVALID"]);
    tgt.bytes = b"DISCARD_TGT".to_vec();
    let mut config = selected.clone();
    config.server = Principal::new(
        "X-CACHECONF:".into(),
        vec!["krb5_ccache_conf_data".into(), "proxy_impersonator".into()],
    )
    .unwrap();
    config.enctype = 0;
    config.key.clear();
    config.times = [0; 4];
    config.bytes = b"DISCARD_PROXY_REFRESH_CONFIG".to_vec();
    let header = [0, 1, 0, 8, 0, 0, 0, 30, 0, 0, 0, 0, 0, 99, 0, 2, 7, 8];
    let got = parse_cache(cache(&header, &[tgt, selected.clone(), config])).unwrap();
    assert_eq!(got.canonical_bytes(), cache(&[], &[selected]));
    assert_eq!(got.declared_expires_at(), 1000);
    let again = parse_cache(got.canonical_bytes().to_vec()).unwrap();
    assert_eq!(again.canonical_bytes(), got.canonical_bytes());
}

#[test]
fn cache_refuses_missing_duplicate_wrong_default_client_and_target() {
    let good = Ticket::service();
    let mut wrong = good.clone();
    wrong.server = principal(&["krbtgt", "EXAMPLE.INVALID"]);
    assert_eq!(
        parse_cache(cache(&[], &[wrong])).unwrap_err(),
        CredentialError::IdentityMismatch
    );
    assert_eq!(
        parse_cache(cache(&[], &[good.clone(), good.clone()])).unwrap_err(),
        CredentialError::IdentityMismatch
    );
    let mut wrong = good.clone();
    wrong.client = principal(&["bob"]);
    assert_eq!(
        parse_cache(cache(&[], &[good.clone(), wrong])).unwrap_err(),
        CredentialError::IdentityMismatch
    );
    assert_eq!(
        ServiceTicketCache::parse(
            cache(&[], std::slice::from_ref(&good)),
            &principal(&["bob"]),
            &server(),
            200
        )
        .unwrap_err(),
        CredentialError::IdentityMismatch
    );
    for target in [
        principal(&["qemu", "host.example.invalid"]),
        principal(&["VNC", "host.example.invalid"]),
        Principal::new("OTHER.INVALID".into(), server().components().to_vec()).unwrap(),
    ] {
        assert_eq!(
            ServiceTicketCache::parse(
                cache(&[], std::slice::from_ref(&good)),
                &client(),
                &target,
                200
            )
            .unwrap_err(),
            CredentialError::IdentityMismatch
        );
    }
}

#[test]
fn cache_rejects_unsupported_selected_material_without_fallback() {
    for variant in 0..7 {
        let mut t = Ticket::service();
        match variant {
            0 => t.addresses.push((2, vec![127, 0, 0, 1])),
            1 => t.authdata.push((1, vec![1])),
            2 => t.skey = 1,
            3 => t.second = vec![1],
            4 => t.enctype = 23,
            5 => t.key.pop().map(|_| ()).unwrap(),
            _ => t.bytes.clear(),
        }
        assert!(parse_cache(cache(&[], &[t])).is_err());
    }
    let mut t = Ticket::service();
    t.enctype = 17;
    t.key = vec![1; 16];
    assert!(parse_cache(cache(&[], &[t])).is_ok());
}

#[test]
fn cache_uses_explicit_declared_time_not_clock_offset_or_crypto_claim() {
    let mut t = Ticket::service();
    t.times[1] = 0;
    for now in [100, 999] {
        assert!(
            ServiceTicketCache::parse(cache(&[], &[t.clone()]), &client(), &server(), now).is_ok()
        );
    }
    for now in [99, 1000] {
        assert_eq!(
            ServiceTicketCache::parse(cache(&[], &[t.clone()]), &client(), &server(), now)
                .unwrap_err(),
            CredentialError::OutsideLifetime
        );
    }
    for times in [
        [0, 0, 1000, 0],
        [100, 99, 1000, 0],
        [100, 1000, 1000, 0],
        [100, 100, 1000, 999],
        [100, 100, u32::MAX, 0],
    ] {
        t.times = times;
        assert_eq!(
            parse_cache(cache(&[], &[t.clone()])).unwrap_err(),
            CredentialError::Invalid
        );
    }
    t.times = [100, 300, 1000, 2000];
    assert_eq!(
        parse_cache(cache(&[], &[t])).unwrap_err(),
        CredentialError::OutsideLifetime
    );
}

#[test]
fn cache_fully_parses_discarded_and_trailing_records() {
    let good = Ticket::service();
    let mut extra = good.clone();
    extra.server = principal(&["krbtgt", "EXAMPLE.INVALID"]);
    extra.addresses = vec![(2, vec![0; 8193])];
    assert!(parse_cache(cache(&[], &[good.clone(), extra])).is_err());
    let mut raw = cache(&[], &[good]);
    raw.push(0);
    assert!(parse_cache(raw).is_err());
}

#[test]
fn cache_budgets_header_records_lists_ticket_and_owned_input() {
    let mut t = Ticket::service();
    t.bytes = vec![9; MAX_TICKET_BYTES];
    assert!(parse_cache(cache(&[], &[t.clone()])).is_ok());
    t.bytes.push(9);
    assert!(parse_cache(cache(&[], &[t])).is_err());
    let good = Ticket::service();
    let mut extra = good.clone();
    extra.server = principal(&["krbtgt", "EXAMPLE.INVALID"]);
    let mut records = vec![extra.clone(); MAX_RECORDS - 1];
    records.push(good.clone());
    assert!(parse_cache(cache(&[], &records)).is_ok());
    records.push(extra.clone());
    assert!(parse_cache(cache(&[], &records)).is_err());
    extra.addresses = vec![(2, vec![]); 17];
    assert!(parse_cache(cache(&[], &[good.clone(), extra.clone()])).is_err());
    extra.addresses.clear();
    extra.authdata = vec![(1, vec![]); 17];
    assert!(parse_cache(cache(&[], &[good.clone(), extra])).is_err());
    assert!(parse_cache(cache(&[0; 1025], std::slice::from_ref(&good))).is_err());
    assert!(parse_cache(cache(&[0, 1, 0, 1, 0], std::slice::from_ref(&good))).is_err());
    let many_tags = [0, 99, 0, 0].repeat(17);
    assert!(parse_cache(cache(&many_tags, std::slice::from_ref(&good))).is_err());
    assert!(parse_cache(vec![0; MAX_INPUT_BYTES + 1]).is_err());
    let mut discarded = good.clone();
    discarded.server = principal(&["krbtgt", "EXAMPLE.INVALID"]);
    discarded.key.clear();
    let base = cache(&[], &[good.clone(), discarded.clone()]).len();
    discarded.key = vec![0; MAX_INPUT_BYTES - base];
    let full = cache(&[], &[good, discarded]);
    assert_eq!(full.len(), MAX_INPUT_BYTES);
    assert!(parse_cache(full).is_ok());
}

#[test]
fn all_cache_truncations_and_unbounded_prefix_lengths_refuse() {
    let raw = cache(&[], &[Ticket::service()]);
    for end in 0..raw.len() {
        assert!(parse_cache(raw[..end].to_vec()).is_err(), "prefix {end}");
    }
    for field in [4, 8, 12] {
        let mut bad = raw.clone();
        bad[field..field + 4].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(parse_cache(bad).is_err());
    }
    for version in [1, 2, 3, 5] {
        let mut bad = raw.clone();
        bad[1] = version;
        assert_eq!(parse_cache(bad).unwrap_err(), CredentialError::Unsupported);
    }
    let mut bad = raw;
    bad[4..8].copy_from_slice(&10u32.to_be_bytes());
    assert_eq!(parse_cache(bad).unwrap_err(), CredentialError::Unsupported);
}

#[test]
fn keytab_canonicalizes_versions_timestamp_padding_order_and_holes() {
    let mut old = Key::aes(17);
    old.wide = None;
    old.padding = vec![0; 3];
    let mut new = Key::aes(18);
    new.kvno8 = 99;
    new.wide = Some(1025);
    new.padding = b"ignored-record-padding".to_vec();
    let mut input = vec![5, 2];
    input.extend_from_slice(&(-7i32).to_be_bytes());
    input.extend_from_slice(&[0; 7]);
    input.extend_from_slice(&keytab(&[new.clone(), old.clone()])[2..]);
    input.extend_from_slice(&[0; 4]);
    let got = parse_keytab(input).unwrap();
    old.timestamp = 0;
    old.wide = Some(2);
    old.padding.clear();
    new.timestamp = 0;
    new.kvno8 = 1;
    new.padding.clear();
    assert_eq!(got.canonical_bytes(), keytab(&[old, new]));
    assert_eq!(
        parse_keytab(got.canonical_bytes().to_vec())
            .unwrap()
            .canonical_bytes(),
        got.canonical_bytes()
    );
}

#[test]
fn keytab_zero_wide_version_uses_format_defined_low_version() {
    let mut input = Key::aes(18);
    input.wide = Some(0);
    let got = parse_keytab(keytab(&[input.clone()])).unwrap();
    input.timestamp = 0;
    input.wide = Some(2);
    assert_eq!(got.canonical_bytes(), keytab(&[input]));
}

#[test]
fn keytab_refuses_mixed_identity_duplicate_unsupported_and_zero_version() {
    let good = Key::aes(18);
    let mut wrong = good.clone();
    wrong.principal = principal(&["bob"]);
    assert_eq!(
        parse_keytab(keytab(&[good.clone(), wrong])).unwrap_err(),
        CredentialError::IdentityMismatch
    );
    assert_eq!(
        parse_keytab(keytab(&[good.clone(), good.clone()])).unwrap_err(),
        CredentialError::IdentityMismatch
    );
    let mut wrong = good.clone();
    wrong.enctype = 23;
    assert_eq!(
        parse_keytab(keytab(&[wrong])).unwrap_err(),
        CredentialError::Unsupported
    );
    let mut wrong = good.clone();
    wrong.bytes.pop();
    assert_eq!(
        parse_keytab(keytab(&[wrong])).unwrap_err(),
        CredentialError::Invalid
    );
    let mut wrong = good;
    wrong.kvno8 = 0;
    wrong.wide = Some(0);
    assert_eq!(
        parse_keytab(keytab(&[wrong])).unwrap_err(),
        CredentialError::Invalid
    );
}

#[test]
fn keytab_signed_holes_end_markers_and_trailing_corruption_are_bounded() {
    let good = keytab(&[Key::aes(18)]);
    for signed in [i32::MIN, i32::MAX, -100] {
        let mut bad = vec![5, 2];
        bad.extend_from_slice(&signed.to_be_bytes());
        assert!(parse_keytab(bad).is_err());
    }
    let mut bad = good.clone();
    bad.extend_from_slice(&[0; 5]);
    assert!(parse_keytab(bad).is_err());
    let mut bad = good;
    bad.extend_from_slice(&(-1i32).to_be_bytes());
    bad.push(1);
    assert!(parse_keytab(bad).is_err());
    assert!(parse_keytab(vec![5, 2, 0, 0, 0, 0]).is_err());
}

#[test]
fn keytab_record_key_and_byte_budgets() {
    let mut keys = vec![];
    for n in 1..=MAX_KEYS {
        let mut k = Key::aes(18);
        k.wide = Some(u32::try_from(n).unwrap());
        keys.push(k);
    }
    assert!(parse_keytab(keytab(&keys)).is_ok());
    let mut k = Key::aes(17);
    k.wide = Some(100);
    keys.push(k);
    assert!(parse_keytab(keytab(&keys)).is_err());
    let raw = keytab(&[Key::aes(18)]);
    let mut full = vec![5, 2];
    let hole = MAX_INPUT_BYTES - raw.len() - 4;
    full.extend_from_slice(&(-i32::try_from(hole).unwrap()).to_be_bytes());
    full.extend(vec![0; hole]);
    full.extend_from_slice(&raw[2..]);
    assert_eq!(full.len(), MAX_INPUT_BYTES);
    assert!(parse_keytab(full).is_ok());
    let mut many = vec![5, 2];
    for _ in 0..MAX_RECORDS {
        many.extend_from_slice(&(-1i32).to_be_bytes());
        many.push(0);
    }
    many.extend_from_slice(&raw[2..]);
    assert!(parse_keytab(many).is_err());
    assert!(parse_keytab(vec![0; MAX_INPUT_BYTES + 1]).is_err());
}

#[test]
fn all_keytab_truncations_and_old_name_type_variants_refuse() {
    let raw = keytab(&[Key::aes(18)]);
    for end in 0..raw.len() {
        assert!(parse_keytab(raw[..end].to_vec()).is_err(), "prefix {end}");
    }
    for version in [0, 1, 3] {
        let mut bad = raw.clone();
        bad[1] = version;
        assert_eq!(parse_keytab(bad).unwrap_err(), CredentialError::Unsupported);
    }
    let type_position = 6 + 2 + 2 + client().realm().len() + 2 + "alice".len();
    let mut bad = raw;
    bad[type_position..type_position + 4].copy_from_slice(&10u32.to_be_bytes());
    assert_eq!(parse_keytab(bad).unwrap_err(), CredentialError::Unsupported);
}

#[test]
fn principals_preserve_structured_utf8_case_and_reject_invalid_budgets() {
    let special = Principal::new(
        "EXAMPLE.INVALID".into(),
        vec!["a/name@domain\\value".into(), "测试".into()],
    )
    .unwrap();
    assert_eq!(special.components(), ["a/name@domain\\value", "测试"]);
    assert_ne!(principal(&["alice"]), principal(&["Alice"]));
    assert!(Principal::new("R".repeat(255), vec!["x".repeat(255); 3]).is_ok());
    for (realm, parts) in [
        ("".into(), vec!["x".into()]),
        ("R".into(), vec![]),
        ("R".into(), vec!["".into()]),
        ("R".into(), vec!["x".into(); 9]),
        ("R".repeat(256), vec!["x".into()]),
        ("R".into(), vec!["x".repeat(256)]),
        ("R".repeat(255), vec!["x".repeat(255); 4]),
        ("R".into(), vec!["key\0value".into()]),
        ("R\n".into(), vec!["x".into()]),
    ] {
        assert!(Principal::new(realm, parts).is_err());
    }
}

#[test]
fn shared_language_neutral_conformance_vectors_match_public_outputs() {
    fn decode(hex: &str) -> Vec<u8> {
        assert_eq!(hex.len() % 2, 0);
        hex.as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| {
                let text = std::str::from_utf8(pair).unwrap();
                u8::from_str_radix(text, 16).unwrap()
            })
            .collect()
    }
    for row in include_str!("fixtures/conformance.tsv").lines().skip(1) {
        let fields: Vec<_> = row.split('\t').collect();
        assert_eq!(fields.len(), 5);
        let input = decode(fields[2]);
        let actual = match fields[1] {
            "cache" => parse_cache(input).map(|v| v.canonical_bytes().to_vec()),
            "keytab" => parse_keytab(input).map(|v| v.canonical_bytes().to_vec()),
            other => panic!("unknown synthetic vector mode {other}"),
        };
        if fields[4] == "Ok" {
            assert_eq!(actual.unwrap(), decode(fields[3]), "{}", fields[0]);
        } else {
            assert_eq!(
                format!("{:?}", actual.unwrap_err()),
                fields[4],
                "{}",
                fields[0]
            );
        }
    }
}

#[test]
fn malformed_byte_mutations_never_panic_and_owners_errors_are_redacted() {
    let c = cache(&[], &[Ticket::service()]);
    let k = keytab(&[Key::aes(18)]);
    for input in [&c, &k] {
        for pos in 0..input.len() {
            for byte in [0, 0xff] {
                let mut bad = input.clone();
                bad[pos] = byte;
                let _ = parse_cache(bad.clone());
                let _ = parse_keytab(bad);
            }
        }
    }
    assert_eq!(format!("{:?}", client()), "Principal([REDACTED])");
    assert_eq!(
        format!("{:?}", parse_cache(c).unwrap()),
        "ServiceTicketCache([REDACTED])"
    );
    assert_eq!(
        format!("{:?}", parse_keytab(k).unwrap()),
        "ClientKeytab([REDACTED])"
    );
    for error in [
        CredentialError::Invalid,
        CredentialError::Unsupported,
        CredentialError::IdentityMismatch,
        CredentialError::OutsideLifetime,
    ] {
        let rendered = format!("{error} {error:?}");
        assert!(
            !rendered.contains("alice")
                && !rendered.contains("SYNTHETIC")
                && !rendered.contains("EXAMPLE")
        );
    }
}
