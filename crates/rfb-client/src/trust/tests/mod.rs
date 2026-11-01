use super::*;

#[test]
fn a_request_without_a_usable_signing_scheme_is_not_a_selected_identity() {
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = rcgen::CertificateParams::new(vec!["client.example.test".into()])
        .unwrap()
        .self_signed(&key)
        .unwrap();
    let identity = ClientIdentity::from_pkcs8_der(
        vec![cert.der().clone()],
        PrivatePkcs8KeyDer::from(key.serialize_der()),
    )
    .unwrap();
    let selection = Arc::new(ClientAuthSelection::default());
    let resolver = RequiredClientCert {
        key: identity.0,
        selection: Arc::clone(&selection),
    };
    assert!(matches!(
        selection.require_selected(),
        Err(Error::ClientCertificateNotRequested)
    ));
    assert!(resolver.resolve(&[], &[]).is_none());
    assert!(matches!(
        selection.require_selected(),
        Err(Error::ClientCertificateNotSelected)
    ));
}
