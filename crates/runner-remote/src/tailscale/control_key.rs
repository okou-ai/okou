//! The fixed key-fetch operation uses exclusively the caller's owned IO.
//! TLS verification and domain ownership must precede this HTTP operation.

use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncWrite};
use ts_capabilityversion::CapabilityVersion;
use ts_http_util::{ClientExt, EmptyBody, ResponseExt};
use ts_keys::MachinePublicKey;

use super::{
    Failure,
    control_io::{LimitedIo, collect},
};

const KEY_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
struct KeyResponse {
    // No default: the SDK's key Default manufactures a random public key.
    #[serde(rename = "publicKey")]
    public_key: MachinePublicKey,
}

pub(super) async fn fetch<Io>(io: Io) -> Result<MachinePublicKey, Failure>
where
    Io: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    if !super::diagnostics::in_domain() {
        return Err(Failure::DomainFailed);
    }
    super::diagnostics::Stage::ControlKey.record();
    let mut url = ts_control::DEFAULT_CONTROL_SERVER
        .join("key")
        .map_err(|_| Failure::DomainFailed)?;
    url.query_pairs_mut()
        .append_pair("v", &CapabilityVersion::CURRENT.to_string());
    // HTTP overhead counts toward this conservative raw cap. There is no
    // independent dial, DNS lookup, URL override, redirect or retry path.
    let (io, _) = LimitedIo::new(io, KEY_BYTES);
    let client = ts_http_util::http1::connect::<EmptyBody>(io)
        .await
        .map_err(|_| Failure::DomainFailed)?;
    let response = client
        .get(&url, [])
        .await
        .map_err(|_| Failure::DomainFailed)?;
    if !response.status().is_success() {
        return Err(Failure::DomainFailed);
    }
    let body = collect(response.into_read(), KEY_BYTES).await?;
    let parsed: KeyResponse = serde_json::from_slice(&body).map_err(|_| Failure::DomainFailed)?;
    if parsed.public_key == MachinePublicKey::from_bytes([0; 32]) {
        return Err(Failure::DomainFailed);
    }
    Ok(parsed.public_key)
}
