use serde_json::{Value, json};

/// The exact public capability request expected by independent HTTP peers.
/// Keep this explicit rather than deriving expectations from production code.
pub(crate) fn supported_profiles(supports_ssh: bool) -> Value {
    let profiles = vec![
        json!({"authMethod":"none","securityType":"x509_none","transportType":"direct"}),
        json!({"authMethod":"vnc_password","securityType":"x509_vnc","transportType":"direct"}),
        json!({"authMethod":"username_password","securityType":"x509_plain","transportType":"direct"}),
        json!({"authMethod":"qemu_scram_sha256","securityType":"qemu_x509_sasl","transportType":"direct"}),
        json!({"authMethod":"client_certificate","securityType":"x509_none","transportType":"direct"}),
        json!({"authMethod":"client_certificate_vnc_password","securityType":"x509_vnc","transportType":"direct"}),
        json!({"authMethod":"none","securityType":"x509_none","transportType":"ssh"}),
        json!({"authMethod":"vnc_password","securityType":"x509_vnc","transportType":"ssh"}),
        json!({"authMethod":"username_password","securityType":"x509_plain","transportType":"ssh"}),
        json!({"authMethod":"qemu_scram_sha256","securityType":"qemu_x509_sasl","transportType":"ssh"}),
        json!({"authMethod":"client_certificate","securityType":"x509_none","transportType":"ssh"}),
        json!({"authMethod":"client_certificate_vnc_password","securityType":"x509_vnc","transportType":"ssh"}),
        json!({"authMethod":"vnc_password","securityType":"apple_vnc_password","transportType":"ssh"}),
        json!({"authMethod":"apple_dh_username_password","securityType":"apple_dh","transportType":"ssh"}),
        json!({"authMethod":"apple_srp_username_password","securityType":"apple_srp","transportType":"ssh"}),
        json!({"authMethod":"apple_rsa_srp_username_password","securityType":"apple_rsa_srp","transportType":"ssh"}),
        json!({"authMethod":"rsa_aes_password","securityType":"rsa_aes_ra2","transportType":"direct"}),
        json!({"authMethod":"rsa_aes_password","securityType":"rsa_aes_ra2","transportType":"ssh"}),
        json!({"authMethod":"rsa_aes_username_password","securityType":"rsa_aes_ra2","transportType":"direct"}),
        json!({"authMethod":"rsa_aes_username_password","securityType":"rsa_aes_ra2","transportType":"ssh"}),
        json!({"authMethod":"rsa_aes_password","securityType":"rsa_aes_ra2_256","transportType":"direct"}),
        json!({"authMethod":"rsa_aes_password","securityType":"rsa_aes_ra2_256","transportType":"ssh"}),
        json!({"authMethod":"rsa_aes_username_password","securityType":"rsa_aes_ra2_256","transportType":"direct"}),
        json!({"authMethod":"rsa_aes_username_password","securityType":"rsa_aes_ra2_256","transportType":"ssh"}),
        json!({"authMethod":"rsa_aes_password","securityType":"rsa_aes_ra2ne","transportType":"ssh"}),
        json!({"authMethod":"rsa_aes_username_password","securityType":"rsa_aes_ra2ne","transportType":"ssh"}),
        json!({"authMethod":"rsa_aes_password","securityType":"rsa_aes_ra2ne_256","transportType":"ssh"}),
        json!({"authMethod":"rsa_aes_username_password","securityType":"rsa_aes_ra2ne_256","transportType":"ssh"}),
    ];
    Value::Array(
        profiles
            .into_iter()
            .filter(|profile| supports_ssh || profile["transportType"] == "direct")
            .collect(),
    )
}

/// Accept either complete public capability state without relaxing other fields.
pub(crate) fn optional_kerberos_request(
    expected: Value,
    supports_ssh: bool,
) -> impl Fn(&httpmock::HttpMockRequest) -> bool + Send + Sync + 'static {
    let mut capable = expected.clone();
    let profiles = [
        json!({"authMethod":"qemu_kerberos_ticket","securityType":"qemu_x509_gssapi","transportType":"direct","kdcTransportType":"none"}),
        json!({"authMethod":"qemu_kerberos_keytab","securityType":"qemu_x509_gssapi","transportType":"direct","kdcTransportType":"direct"}),
        json!({"authMethod":"qemu_kerberos_keytab","securityType":"qemu_x509_gssapi","transportType":"direct","kdcTransportType":"ssh"}),
        json!({"authMethod":"qemu_kerberos_password","securityType":"qemu_x509_gssapi","transportType":"direct","kdcTransportType":"direct"}),
        json!({"authMethod":"qemu_kerberos_password","securityType":"qemu_x509_gssapi","transportType":"direct","kdcTransportType":"ssh"}),
        json!({"authMethod":"qemu_kerberos_ticket","securityType":"qemu_x509_gssapi","transportType":"ssh","kdcTransportType":"none"}),
        json!({"authMethod":"qemu_kerberos_keytab","securityType":"qemu_x509_gssapi","transportType":"ssh","kdcTransportType":"direct"}),
        json!({"authMethod":"qemu_kerberos_keytab","securityType":"qemu_x509_gssapi","transportType":"ssh","kdcTransportType":"ssh"}),
        json!({"authMethod":"qemu_kerberos_password","securityType":"qemu_x509_gssapi","transportType":"ssh","kdcTransportType":"direct"}),
        json!({"authMethod":"qemu_kerberos_password","securityType":"qemu_x509_gssapi","transportType":"ssh","kdcTransportType":"ssh"}),
    ];
    capable["supportedProfiles"]
        .as_array_mut()
        .unwrap()
        .extend(profiles.into_iter().filter(|profile| {
            supports_ssh
                || (profile["transportType"] == "direct" && profile["kdcTransportType"] != "ssh")
        }));
    move |request| {
        serde_json::from_slice::<Value>(request.body_ref())
            .is_ok_and(|body| body == expected || body == capable)
    }
}
