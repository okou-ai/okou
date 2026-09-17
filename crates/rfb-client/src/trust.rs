use std::sync::Arc;

use rustls::{ClientConfig, RootCertStore, pki_types::CertificateDer};

use crate::Error;

/// Explicit server trust policy. Certificate verification cannot be disabled.
pub struct TrustRoots(RootCertStore);

impl TrustRoots {
    /// Use the public trust anchors distributed by webpki-roots.
    pub fn public_roots() -> Self {
        Self(RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        })
    }

    /// Trust only these owner-supplied DER certificates, without implicitly adding
    /// public roots. At most eight certificates and 64 KiB total are accepted.
    /// The configuration layer must separately bound any encoded PEM input.
    pub fn custom(certificates: Vec<CertificateDer<'static>>) -> Result<Self, Error> {
        if !(1..=8).contains(&certificates.len()) {
            return Err(Error::InvalidTrustRoots);
        }
        let mut remaining: usize = 64 * 1024;
        for cert in &certificates {
            remaining = remaining
                .checked_sub(cert.len())
                .ok_or(Error::InvalidTrustRoots)?;
        }
        let mut roots = RootCertStore::empty();
        for cert in certificates {
            roots.add(cert).map_err(|_| Error::InvalidTrustRoots)?;
        }
        Ok(Self(roots))
    }

    pub(crate) fn into_config(self) -> Result<Arc<ClientConfig>, Error> {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let config = ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
            .map_err(Error::TlsConfiguration)?
            .with_root_certificates(self.0)
            .with_no_client_auth();
        Ok(Arc::new(config))
    }
}
