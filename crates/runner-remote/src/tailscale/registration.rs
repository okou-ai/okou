//! Fresh memory-only identity and bounded public SDK registration composition.
//! Construct inside the owned native factory before its first startup await.

use bytes::Bytes;
use futures_util::Stream;
use std::sync::atomic::Ordering;
use tokio::io::{AsyncRead, AsyncWrite};
use ts_capabilityversion::CapabilityVersion;
use ts_control_serde::{HostInfo, RegisterAuth, RegisterRequest, RegisterResponse};
use ts_http_util::{BytesBody, ClientExt, EmptyBody, Http2, ResponseExt};
use ts_keys::{MachinePublicKey, NodeState};

use super::{
    Failure,
    control_io::{LimitedIo, collect},
    control_key,
};

const REGISTRATION_BYTES: usize = 64 * 1024;
const STARTUP_BYTES: usize = 1024 * 1024;

// Production uses the shared WebPKI policy with an explicit crypto provider.
// A controlled external TLS fixture can supply its own trusted roots without
// changing SDK code or replacing shared key/Noise/registration/map composition.
pub(super) trait Tls {
    async fn connect<Io>(
        &self,
        name: ts_tls_util::ServerName<'static>,
        io: Io,
    ) -> std::io::Result<ts_tls_util::TlsStream<Io>>
    where
        Io: AsyncRead + AsyncWrite + Unpin + Send + 'static;
}

pub(super) struct VerifiedTls;

impl Tls for VerifiedTls {
    async fn connect<Io>(
        &self,
        name: ts_tls_util::ServerName<'static>,
        io: Io,
    ) -> std::io::Result<ts_tls_util::TlsStream<Io>>
    where
        Io: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        // The SDK helper uses Rustls's process-default provider. Workspace
        // feature unification can enable both providers, so reuse the explicit
        // shared policy instead of relying on another client to initialize
        // global state. The SDK source and TLS stream/crypto remain unchanged.
        let config = crate::tls::client_config().map_err(std::io::Error::other)?;
        tokio_rustls::TlsConnector::from(config)
            .connect(name, io)
            .await
    }
}

pub(super) struct Registration {
    config: ts_control::Config,
    keys: NodeState,
}

impl Registration {
    pub(super) fn new() -> Self {
        Self {
            config: ts_control::Config {
                server_url: ts_control::DEFAULT_CONTROL_SERVER.clone(),
                hostname: Some(format!("okou-{}", uuid::Uuid::new_v4().simple())),
                client_name: Some("Okou".into()),
                tags: Vec::new(),
                ephemeral: true,
            },
            keys: NodeState::generate(),
        }
    }

    pub(super) fn keys(&self) -> &NodeState {
        &self.keys
    }

    pub(super) fn with_tags(tags: &[String]) -> Self {
        let mut registration = Self::new();
        registration.config.tags = tags.to_vec();
        registration
    }

    #[cfg(test)]
    pub(super) async fn connect_provisioned<KeyIo, ControlIo>(
        &self,
        key_io: KeyIo,
        control_io: ControlIo,
        key: &super::provisioning::Key,
    ) -> Result<Http2<BytesBody>, Failure>
    where
        KeyIo: AsyncRead + AsyncWrite + Unpin + Send + 'static,
        ControlIo: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        self.connect_tracked(key_io, control_io, key.expose(), &VerifiedTls, Some(key))
            .await
    }

    /// Keep the SDK's map request/model semantics. The length guard withholds
    /// each complete bounded frame before the SDK allocates or decodes it.
    pub(super) async fn maps(
        &self,
        client: &Http2<BytesBody>,
    ) -> Result<impl Stream<Item = ts_control::StateUpdate> + use<>, Failure> {
        if !super::diagnostics::in_domain() {
            return Err(Failure::DomainFailed);
        }
        super::diagnostics::Stage::Map.record();
        let mut request = ts_control::MapRequestBuilder::new(&self.keys)
            .as_stream()
            .build();
        let app = self.config.format_client_name();
        request.host_info = Some(HostInfo {
            hostname: self.config.hostname.as_deref(),
            app: &app,
            ipn_version: ts_control::PKG_VERSION,
            ..Default::default()
        });
        let url = self
            .config
            .server_url
            .join("machine/map")
            .map_err(|_| Failure::DomainFailed)?;
        let reader = ts_control::client::send_map_request(request, &url, client)
            .await
            .map_err(|_| Failure::DomainFailed)?;
        Ok(ts_control::client::map_stream(
            super::map_reader::MapReader::new(reader),
        ))
    }

    pub(super) async fn announce_home(
        &self,
        client: &Http2<BytesBody>,
        home: ts_derp::RegionId,
    ) -> Result<(), super::Failure> {
        if !super::diagnostics::in_domain() {
            return Err(super::Failure::DomainFailed);
        }
        let mut request = ts_control::MapRequestBuilder::new(&self.keys)
            .as_request()
            .preferred_derp(home)
            .build();
        let app = self.config.format_client_name();
        let net_info = request.host_info.take().and_then(|host| host.net_info);
        request.host_info = Some(HostInfo {
            hostname: self.config.hostname.as_deref(),
            app: &app,
            ipn_version: ts_control::PKG_VERSION,
            net_info,
            ..Default::default()
        });
        let url = self
            .config
            .server_url
            .join("machine/map")
            .map_err(|_| super::Failure::DomainFailed)?;
        // A non-streaming OmitPeers update is acknowledged by HTTP status;
        // control may omit the entire body. Authority stays with the map stream.
        let response = ts_control::client::send_map_request(request, &url, client)
            .await
            .map_err(|_| super::Failure::DomainFailed)?;
        drop(response);
        Ok(())
    }

    /// Production startup never delegates an independent dial to the SDK. The
    /// root has already retained these two IO owners before this first await.
    /// Both TLS names are fixed and use the SDK's verified WebPKI roots.
    #[cfg(test)]
    pub(super) async fn connect<KeyIo, ControlIo>(
        &self,
        key_io: KeyIo,
        control_io: ControlIo,
        derived_key: &str,
    ) -> Result<Http2<BytesBody>, Failure>
    where
        KeyIo: AsyncRead + AsyncWrite + Unpin + Send + 'static,
        ControlIo: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        self.connect_using(key_io, control_io, derived_key, &VerifiedTls)
            .await
    }

    #[cfg(test)]
    pub(super) async fn connect_using<KeyIo, ControlIo>(
        &self,
        key_io: KeyIo,
        control_io: ControlIo,
        derived_key: &str,
        tls: &impl Tls,
    ) -> Result<Http2<BytesBody>, Failure>
    where
        KeyIo: AsyncRead + AsyncWrite + Unpin + Send + 'static,
        ControlIo: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        self.connect_tracked(key_io, control_io, derived_key, tls, None)
            .await
    }

    pub(super) async fn connect_tracked<KeyIo, ControlIo>(
        &self,
        key_io: KeyIo,
        control_io: ControlIo,
        derived_key: &str,
        tls: &impl Tls,
        provider_key: Option<&super::provisioning::Key>,
    ) -> Result<Http2<BytesBody>, Failure>
    where
        KeyIo: AsyncRead + AsyncWrite + Unpin + Send + 'static,
        ControlIo: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        validate_key(derived_key)?;
        if !super::diagnostics::in_domain() {
            return Err(Failure::DomainFailed);
        }
        let server = ts_tls_util::server_name(&self.config.server_url)
            .ok_or(Failure::DomainFailed)?
            .to_owned();
        let (key_io, _) = LimitedIo::new(key_io, STARTUP_BYTES);
        super::diagnostics::Stage::KeyTls.record();
        let key_tls = tls
            .connect(server.clone(), key_io)
            .await
            .map_err(|_| Failure::DomainFailed)?;
        let public_key = control_key::fetch(key_tls).await?;
        let (control_io, registered) = LimitedIo::new(control_io, STARTUP_BYTES);
        super::diagnostics::Stage::ControlTls.record();
        let control_tls = tls
            .connect(server, control_io)
            .await
            .map_err(|_| Failure::DomainFailed)?;
        let client = self
            .noise_register_tracked(control_tls, public_key, derived_key, provider_key)
            .await?;
        // TLS/Noise framing and registration have all completed successfully.
        // Subsequent map IO retains its independent frame/inventory caps.
        registered.store(true, Ordering::Release);
        Ok(client)
    }

    /// This component accepts caller-authenticated IO for controlled protocol
    /// fixtures. Production reaches it only after the fixed verified TLS path.
    #[cfg(test)]
    pub(super) async fn noise_register<Io>(
        &self,
        io: Io,
        public_key: MachinePublicKey,
        derived_key: &str,
    ) -> Result<Http2<BytesBody>, Failure>
    where
        Io: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        self.noise_register_tracked(io, public_key, derived_key, None)
            .await
    }

    async fn noise_register_tracked<Io>(
        &self,
        io: Io,
        public_key: MachinePublicKey,
        derived_key: &str,
        provider_key: Option<&super::provisioning::Key>,
    ) -> Result<Http2<BytesBody>, Failure>
    where
        Io: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        validate_key(derived_key)?;
        if !super::diagnostics::in_domain() || public_key == MachinePublicKey::from_bytes([0; 32]) {
            return Err(Failure::DomainFailed);
        }
        super::diagnostics::Stage::Noise.record();
        let client = ts_http_util::http1::connect::<EmptyBody>(io)
            .await
            .map_err(|_| Failure::DomainFailed)?;
        let (handshake, initial) = ts_control_noise::Handshake::initialize(
            &ts_control::client::CONTROL_PROTOCOL_VERSION,
            &self.keys.machine_keys,
            &public_key,
            CapabilityVersion::CURRENT,
        );
        let io = ts_control::client::upgrade_ts2021(
            &self.config.server_url,
            &initial,
            handshake,
            &self.keys.machine_keys,
            client,
        )
        .await
        .map_err(|_| Failure::DomainFailed)?;
        let io = ts_control::client::read_challenge_packet(io)
            .await
            .map_err(|_| Failure::DomainFailed)?;
        self.register_tracked(io, derived_key, provider_key).await
    }

    /// The caller must already authenticate fixed-endpoint TLS/Noise IO. This
    /// composes the SDK serializer/response parser, not a replacement protocol.
    /// No follow-up URL, retry, key-file, environment or persisted identity path.
    #[cfg(test)]
    pub(super) async fn register<Io>(
        &self,
        io: Io,
        derived_key: &str,
    ) -> Result<Http2<BytesBody>, Failure>
    where
        Io: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        self.register_tracked(io, derived_key, None).await
    }

    async fn register_tracked<Io>(
        &self,
        io: Io,
        derived_key: &str,
        provider_key: Option<&super::provisioning::Key>,
    ) -> Result<Http2<BytesBody>, Failure>
    where
        Io: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        validate_key(derived_key)?;
        if !super::diagnostics::in_domain() {
            return Err(Failure::DomainFailed);
        }
        super::diagnostics::Stage::Registration.record();
        let app = self.config.format_client_name();
        let request = RegisterRequest {
            version: CapabilityVersion::CURRENT,
            node_key: self.keys.node_keys.public,
            nl_key: Some(self.keys.network_lock_keys.public),
            auth: Some(RegisterAuth::from(derived_key)),
            hostinfo: HostInfo {
                hostname: self.config.hostname.as_deref(),
                app: &app,
                ipn_version: ts_control::PKG_VERSION,
                request_tags: if self.config.tags.is_empty() {
                    None
                } else {
                    Some(self.config.tags.iter().map(String::as_str).collect())
                },
                ..Default::default()
            },
            ephemeral: true,
            ..Default::default()
        };
        let body = serde_json::to_vec(&request).map_err(|_| Failure::DomainFailed)?;
        let url = self
            .config
            .server_url
            .join("machine/register")
            .map_err(|_| Failure::DomainFailed)?;
        let header = (
            "Ts-Lb".parse().map_err(|_| Failure::DomainFailed)?,
            self.keys
                .node_keys
                .public
                .to_string()
                .parse()
                .map_err(|_| Failure::DomainFailed)?,
        );
        let (io, registered) = LimitedIo::new(io, REGISTRATION_BYTES);
        let client = ts_http_util::http2::connect(io)
            .await
            .map_err(|_| Failure::DomainFailed)?;
        if let Some(key) = provider_key {
            key.consuming()?;
        }
        let response = client
            .post(&url, [header], Bytes::from(body).into())
            .await
            .map_err(|_| Failure::DomainFailed)?;
        if !response.status().is_success() {
            return Err(Failure::DomainFailed);
        }
        let body = collect(response.into_read(), REGISTRATION_BYTES).await?;
        let response: RegisterResponse<'_> =
            serde_json::from_slice(&body).map_err(|_| Failure::DomainFailed)?;
        if !response.error.is_empty()
            || response.node_key_expired
            || !response.machine_authorized
            || !response.auth_url.is_empty()
        {
            return Err(Failure::DomainFailed);
        }
        // END_STREAM and all typed authorization checks completed. The subsequent
        // owned map reader must impose its independent per-frame/inventory caps.
        registered.store(true, Ordering::Release);
        Ok(client)
    }
}

fn validate_key(derived_key: &str) -> Result<(), Failure> {
    if !derived_key.starts_with("tskey-auth-")
        || derived_key.len() > 4096
        || derived_key.len() <= "tskey-auth-".len()
        || !derived_key
            .bytes()
            .all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(Failure::DomainFailed);
    }
    Ok(())
}
