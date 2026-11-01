use super::*;

#[test]
fn certificate_handoff_requires_bounded_matching_pkcs8_before_network() {
    let key = rcgen::KeyPair::generate().unwrap();
    let certificate = rcgen::CertificateParams::new(vec!["client.example.test".into()])
        .unwrap()
        .self_signed(&key)
        .unwrap();
    let encoded_cert = base64::engine::general_purpose::STANDARD.encode(certificate.der());
    let encoded_key = base64::engine::general_purpose::STANDARD.encode(key.serialize_der());
    let parse = |certificates: Vec<String>, encoded: String| {
        let secret = serde_json::from_value(serde_json::json!(encoded)).unwrap();
        client_identity(certificates, secret)
    };
    assert!(parse(vec![encoded_cert.clone()], encoded_key.clone()).is_ok());
    let wrong_key = rcgen::KeyPair::generate().unwrap();
    assert!(matches!(
        parse(
            vec![encoded_cert.clone()],
            base64::engine::general_purpose::STANDARD.encode(wrong_key.serialize_der())
        ),
        Err(Failure::InvalidCredential)
    ));
    for certificates in [vec![], vec![encoded_cert.clone(); 9], vec!["AAAA".into()]] {
        assert!(matches!(
            parse(certificates, encoded_key.clone()),
            Err(Failure::InvalidCredential)
        ));
    }
    assert!(matches!(
        parse(vec![encoded_cert], "AAAA".into()),
        Err(Failure::InvalidCredential)
    ));
}

#[test]
fn custom_trust_requires_only_bounded_complete_certificate_blocks() {
    let key = rcgen::KeyPair::generate().unwrap();
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    let certificate = params.self_signed(&key).unwrap();
    let certificate = format!(
        "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
        base64::engine::general_purpose::STANDARD.encode(certificate.der())
    );
    for valid in [certificate.clone(), certificate.repeat(8)] {
        assert!(custom_roots(Zeroizing::new(valid)).is_ok());
    }
    for invalid in [
        String::new(),
        " \n\t".into(),
        "x".repeat(MAX_CA_BYTES + 1),
        "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----".into(),
        certificate.replace("CERTIFICATE", "PRIVATE KEY"),
        certificate.replace("-----END CERTIFICATE-----", ""),
        format!("junk\n{certificate}"),
        format!("{certificate}junk"),
        format!("{certificate}\u{200b}"),
        certificate.repeat(9),
    ] {
        assert!(matches!(
            custom_roots(Zeroizing::new(invalid)),
            Err(Failure::InvalidCredential)
        ));
    }
}
