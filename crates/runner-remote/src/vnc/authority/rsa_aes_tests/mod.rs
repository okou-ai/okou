use super::*;
use serde_json::json;

#[test]
fn exact_rsa_capabilities_and_generated_handoff_preserve_modes_and_255_byte_fields() {
    assert_eq!(rsa_aes_profiles(false).len(), 4);
    let profiles = rsa_aes_profiles(true);
    assert_eq!(profiles.len(), 12);
    for profile in profiles {
        let mode = match profile.security_type {
            ResolveRequestSupportedProfileSecurityType::RsaAesRa2 => "rsa_aes_ra2",
            ResolveRequestSupportedProfileSecurityType::RsaAesRa2256 => "rsa_aes_ra2_256",
            ResolveRequestSupportedProfileSecurityType::RsaAesRa2ne => "rsa_aes_ra2ne",
            ResolveRequestSupportedProfileSecurityType::RsaAesRa2ne256 => "rsa_aes_ra2ne_256",
            _ => panic!("unexpected RSA capability"),
        };
        let authentication = match profile.auth_method {
            ResolveRequestSupportedProfileAuthMethod::RsaAesPassword => {
                json!({"method":"rsa_aes_password","password":"界".repeat(85)})
            }
            ResolveRequestSupportedProfileAuthMethod::RsaAesUsernamePassword => {
                json!({"method":"rsa_aes_username_password","username":"界".repeat(85),"password":"界".repeat(85)})
            }
            _ => panic!("unexpected RSA credential"),
        };
        let transport = match profile.transport_type {
            ResolveRequestSupportedProfileTransportType::Direct => {
                assert!(!mode.contains("ra2ne"));
                json!({"type":"direct"})
            }
            ResolveRequestSupportedProfileTransportType::Ssh => {
                json!({"type":"ssh","connectionId":"10000000-0000-4000-8000-000000000001","generation":1})
            }
            ResolveRequestSupportedProfileTransportType::CloudflareAccess
            | ResolveRequestSupportedProfileTransportType::Tailscale => {
                panic!("native profiles must not be advertised before implementation")
            }
        };
        let response: ResolveResponse = serde_json::from_value(json!({"outcome":"resolved_rsa_aes","host":"127.0.0.1","port":5900,"generation":1,"transport":transport,"authentication":authentication,"security":{"type":mode,"serverKeySha256":"ab".repeat(32)}})).unwrap();
        let ResolveResponse::ResolvedRsaAes {
            host,
            port,
            generation,
            transport,
            authentication,
            security,
        } = response
        else {
            panic!("wrong private handoff");
        };
        let credential = rsa_aes_credential(
            chrono::Utc::now(),
            host,
            port,
            generation,
            transport,
            authentication,
            security,
            true,
        )
        .unwrap_or_else(|_| panic!("valid exact handoff rejected"));
        assert!(matches!(
            credential.authentication,
            Authentication::RsaAes { .. }
        ));
    }
}
