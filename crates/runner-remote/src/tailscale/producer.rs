//! The fixed production entry retains its root before any provider/network await.

use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite};
use ts_keys::NodeState;

use super::{
    Configuration, Failure, Journal, Work,
    domain::Control,
    node_root::Root,
    provisioning::Provider,
    provisioning_io, regional_relay,
    registration::{Registration, Tls},
};

pub(super) trait ControlSockets: Send + 'static {
    type Io: AsyncRead + AsyncWrite + Unpin + Send + 'static;
    async fn connect(&self, keys: &NodeState) -> Result<(Self::Io, Self::Io), Failure>;
    fn tls(&self) -> impl Tls;
}

struct FixedControl(super::resolver::Resolver);

impl ControlSockets for FixedControl {
    type Io = tokio::net::TcpStream;
    async fn connect(&self, _keys: &NodeState) -> Result<(Self::Io, Self::Io), Failure> {
        if !super::diagnostics::in_domain() {
            return Err(Failure::DomainFailed);
        }
        const HOST: &str = "controlplane.tailscale.com";
        tokio::try_join!(self.0.connect(HOST, 443), self.0.connect(HOST, 443))
    }
    fn tls(&self) -> impl Tls {
        super::registration::VerifiedTls
    }
}

pub(crate) fn work(configuration: Configuration, journal: Arc<Journal>) -> Work {
    let resolver = super::resolver::Resolver::new();
    work_using(
        configuration,
        journal,
        provisioning_io::Https(resolver.clone()),
        FixedControl(resolver.clone()),
        regional_relay::Verified(resolver),
    )
}

#[cfg(test)]
#[derive(Clone)]
pub(crate) struct TestServices {
    pub(super) api: super::tests::provisioning::fixture::Secure,
    pub(super) control: super::tests::startup::secure::Sockets,
    pub(super) relay: super::tests::provisioning::regional_fixture::Relay,
}

#[cfg(test)]
impl TestServices {
    pub(crate) fn work(&self, configuration: Configuration, journal: Arc<Journal>) -> Work {
        work_using(
            configuration,
            journal,
            self.api.clone(),
            self.control.clone(),
            self.relay.clone(),
        )
    }
}

// Private typed dependencies permit controlled external-service qualification.
// Guest/native authority never chooses an origin, resolver, TLS policy or dial.
pub(super) fn work_using<P, C, D>(
    configuration: Configuration,
    journal: Arc<Journal>,
    provider_io: P,
    control_io: C,
    relay_io: D,
) -> Work
where
    P: provisioning_io::Dial + Send,
    C: ControlSockets,
    D: regional_relay::Dial + Send,
{
    Box::new(move |control: Control| {
        let (root, client) = Root::new(control.cancelled());
        Box::pin(async move {
            control.retain_client(client)?;
            let provider = Provider::new(configuration, journal, provider_io, &control)?;
            let registration = Registration::with_tags(provider.tags());
            let key = provider.create().await?;
            let (key_io, native_io) = control_io.connect(registration.keys()).await?;
            let client = registration
                .connect_tracked(
                    key_io,
                    native_io,
                    key.expose(),
                    &control_io.tls(),
                    Some(&key),
                )
                .await?;
            root.registered(registration, client, relay_io, &control)
                .await
        })
    })
}
