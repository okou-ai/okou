//! One bounded diagnostic at the resolved connection-attempt boundary.

use rfb_client::{
    AuthenticationStage, ClientCertificateAuthentication, Error, RsaAesSecurity, X509Authentication,
};
use runner_types::ids::RunId;
use tokio::time::Instant;
use uuid::Uuid;

use super::{
    Failure,
    authority::{Authentication, Transport},
};

pub(super) struct Attempt {
    started: Instant,
    profile: &'static str,
    transport: &'static str,
    pub(super) stage: &'static str,
    rfb_error_code: Option<&'static str>,
    authentication_stage: Option<&'static str>,
    dh_check: Option<&'static str>,
    dh_generator: Option<u16>,
    dh_key_bytes: Option<u16>,
}

impl Attempt {
    pub(super) fn apply(&self, snapshot: &mut Option<super::evidence::Snapshot>) {
        if let Some(snapshot) = snapshot {
            snapshot.profile = Some(self.profile);
            snapshot.rfb_error_code = self.rfb_error_code;
            snapshot.authentication_stage = self.authentication_stage;
            snapshot.dh_check = self.dh_check;
            snapshot.dh_generator = self.dh_generator;
            snapshot.dh_key_bytes = self.dh_key_bytes;
        }
    }
    pub(super) fn new(
        started: Instant,
        authentication: &Authentication,
        transport: Transport,
    ) -> Self {
        let profile = match authentication {
            Authentication::Kerberos { .. } => "qemu_x509_gssapi",
            Authentication::X509 { authentication, .. } => match authentication {
                X509Authentication::None => "x509_none",
                X509Authentication::VncPassword(_) => "x509_vnc",
                X509Authentication::Plain(_) => "x509_plain",
                X509Authentication::QemuScramSha256(_) => "qemu_x509_sasl",
            },
            Authentication::ClientCertificate { authentication, .. } => match authentication {
                ClientCertificateAuthentication::None => "x509_none_client_certificate",
                ClientCertificateAuthentication::VncPassword(_) => "x509_vnc_client_certificate",
            },
            Authentication::AppleVncPassword(_) => "apple_vnc_password",
            Authentication::AppleDh(_) => "apple_dh",
            Authentication::AppleSrp(_) => "apple_srp",
            Authentication::AppleRsaSrp(_) => "apple_rsa_srp",
            Authentication::RsaAes { security, .. } => match security {
                RsaAesSecurity::Ra2 => "rsa_aes_ra2",
                RsaAesSecurity::Ra2_256 => "rsa_aes_ra2_256",
                RsaAesSecurity::Ra2ne => "rsa_aes_ra2ne",
                RsaAesSecurity::Ra2ne256 => "rsa_aes_ra2ne_256",
            },
        };
        Self {
            started,
            profile,
            transport: match transport {
                Transport::Direct => "direct",
                Transport::Ssh { .. } => "ssh",
            },
            stage: "transport",
            rfb_error_code: None,
            authentication_stage: None,
            dh_check: None,
            dh_generator: None,
            dh_key_bytes: None,
        }
    }

    pub(super) fn rfb_failure(&mut self, error: Error) -> Failure {
        self.rfb_error_code = Some(error.diagnostic_code());
        match &error {
            Error::AuthenticationDeadlineExceeded { stage } => {
                self.authentication_stage = Some(stage.as_str());
            }
            Error::InvalidAppleDhParameters {
                check,
                generator,
                key_bytes,
            } => {
                self.authentication_stage = Some(match check {
                    rfb_client::AppleDhParameterCheck::SecurityTypes => {
                        AuthenticationStage::SecurityNegotiation.as_str()
                    }
                    _ => AuthenticationStage::AppleDhAuthentication.as_str(),
                });
                self.dh_check = Some(check.as_str());
                self.dh_generator = *generator;
                self.dh_key_bytes = *key_bytes;
            }
            _ => {}
        }
        Failure::from(error)
    }

    pub(super) fn finish(&self, run: RunId, connection: Uuid, failure: Option<Failure>) {
        tracing::info!(
            run_id = %run,
            connection_id = %connection,
            vnc_auth_profile = self.profile,
            vnc_transport = self.transport,
            vnc_connection_stage = self.stage,
            outcome = if failure.is_some() { "failed" } else { "started" },
            failure_reason = ?failure,
            elapsed_ms = self.started.elapsed().as_millis() as u64,
            rfb_error_code = self.rfb_error_code,
            vnc_authentication_stage = self.authentication_stage,
            apple_dh_parameter_check = self.dh_check,
            apple_dh_generator = self.dh_generator,
            apple_dh_key_bytes = self.dh_key_bytes,
            "VNC connection attempt finished"
        );
    }
}
