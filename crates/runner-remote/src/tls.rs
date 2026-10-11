//! Shared WebPKI policy with an explicit provider under feature unification.

use rustls::{ClientConfig, RootCertStore};
use std::sync::Arc;

pub(crate) fn client_config() -> Result<Arc<ClientConfig>, rustls::Error> {
    Ok(Arc::new(
        ClientConfig::builder_with_provider(
            Arc::new(rustls::crypto::aws_lc_rs::default_provider()),
        )
        .with_safe_default_protocol_versions()?
        .with_root_certificates(RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        })
        .with_no_client_auth(),
    ))
}
