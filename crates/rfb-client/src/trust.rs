use std::{
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use rustls::{
    ClientConfig, RootCertStore, SignatureScheme,
    client::ResolvesClientCert,
    pki_types::{CertificateDer, PrivatePkcs8KeyDer},
    sign::CertifiedKey,
};
use zeroize::Zeroizing;

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

    pub(crate) fn into_client_auth_config(
        self,
        identity: ClientIdentity,
    ) -> Result<(Arc<ClientConfig>, Arc<ClientAuthSelection>), Error> {
        // This state and the signer are fresh for each handshake; TLS resumption
        // cannot carry a previous connection's client-auth decision forward.
        let selection = Arc::new(ClientAuthSelection::default());
        let resolver = Arc::new(RequiredClientCert {
            key: identity.0,
            selection: Arc::clone(&selection),
        });
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let config = ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
            .map_err(Error::TlsConfiguration)?
            .with_root_certificates(self.0)
            .with_client_cert_resolver(resolver);
        Ok((Arc::new(config), selection))
    }
}

/// A bounded, unencrypted PKCS#8 private key and DER client certificate chain.
/// The key is parsed into a signer and validated against the first certificate.
/// Certificate validity and client trust are ultimately enforced by the server.
pub struct ClientIdentity(Arc<CertifiedKey>);

impl ClientIdentity {
    /// Require 1–8 DER certificates (<=64 KiB total) and a nonempty PKCS#8
    /// private key (<=16 KiB). Unsupported/encrypted keys fail closed.
    pub fn from_pkcs8_der(
        certificates: Vec<CertificateDer<'static>>,
        key: PrivatePkcs8KeyDer<'static>,
    ) -> Result<Self, Error> {
        // pki-types implements Zeroize but not Drop for owned PKCS#8 data.
        // Cover early validation errors; the Rustls AWS-LC key provider wraps
        // the consumed key in Zeroizing during parsing on all return paths.
        let mut key = Zeroizing::new(key);
        if !(1..=8).contains(&certificates.len())
            || certificates
                .iter()
                .try_fold(0usize, |total, cert| total.checked_add(cert.len()))
                .is_none_or(|total| total > 64 * 1024)
            || !(1..=16 * 1024).contains(&key.secret_pkcs8_der().len())
        {
            return Err(Error::InvalidClientIdentity);
        }
        for certificate in &certificates {
            rustls::server::ParsedCertificate::try_from(certificate)
                .map_err(|_| Error::InvalidClientIdentity)?;
        }
        let owned = std::mem::replace(&mut *key, PrivatePkcs8KeyDer::from(Vec::new()));
        let provider = rustls::crypto::aws_lc_rs::default_provider();
        let certified = CertifiedKey::from_der(certificates, owned.into(), &provider)
            .map_err(|_| Error::InvalidClientIdentity)?;
        // from_der allows an unknown match; this required-identity API does not.
        certified
            .keys_match()
            .map_err(|_| Error::InvalidClientIdentity)?;
        Ok(Self(Arc::new(certified)))
    }
}

impl fmt::Debug for ClientIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ClientIdentity([REDACTED])")
    }
}

#[derive(Default)]
pub(crate) struct ClientAuthSelection {
    requested: AtomicBool,
    selected: AtomicBool,
}

impl ClientAuthSelection {
    pub(crate) fn require_selected(&self) -> Result<(), Error> {
        if !self.requested.load(Ordering::Acquire) {
            return Err(Error::ClientCertificateNotRequested);
        }
        if !self.selected.load(Ordering::Acquire) {
            return Err(Error::ClientCertificateNotSelected);
        }
        Ok(())
    }
}

struct RequiredClientCert {
    key: Arc<CertifiedKey>,
    selection: Arc<ClientAuthSelection>,
}

impl fmt::Debug for RequiredClientCert {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RequiredClientCert([REDACTED])")
    }
}

impl ResolvesClientCert for RequiredClientCert {
    fn resolve(
        &self,
        _root_hint_subjects: &[&[u8]],
        sigschemes: &[SignatureScheme],
    ) -> Option<Arc<CertifiedKey>> {
        self.selection.requested.store(true, Ordering::Release);
        // Rustls will select a signer again after resolve. Do not count merely
        // receiving a request as presentation of a usable certificate.
        self.key.key.choose_scheme(sigschemes)?;
        self.selection.selected.store(true, Ordering::Release);
        Some(Arc::clone(&self.key))
    }

    fn has_certs(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
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
}
