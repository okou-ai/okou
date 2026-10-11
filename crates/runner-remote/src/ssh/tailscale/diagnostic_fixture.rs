//! Restricted Runner process fixture for configured startup and real SDK HTTP.
//! Only external loopback IO is replaced; no arbitrary work/authority is exposed.

use std::{net::SocketAddr, sync::Arc};

use api_contracts::generated::types::runners::ssh::ResolveResponseResolvedTailscaleTailscale;
use http_body_util::BodyExt;
use ts_http_util::{Client, EmptyBody, Request};
use ts_keys::NodeState;

use super::{Configuration, Failure, Pool, Registry, producer, provisioning_io, regional_relay};

fn configuration(canary: &str) -> Result<Configuration, Failure> {
    let authority: ResolveResponseResolvedTailscaleTailscale =
        serde_json::from_value(serde_json::json!({
            "configId": uuid::Uuid::new_v4().to_string(), "generation": 1,
            "clientId": "synthetic-client", "clientSecret": canary, "tags": ["tag:ssh"]
        }))
        .map_err(|_| Failure::DomainFailed)?;
    Configuration::new(authority)
}

#[derive(Clone)]
struct Api(SocketAddr);

impl provisioning_io::Dial for Api {
    type Io = tokio::net::TcpStream;
    async fn connect(&self) -> Result<Self::Io, Failure> {
        if !self.0.ip().is_loopback() {
            return Err(Failure::DomainFailed);
        }
        tokio::net::TcpStream::connect(self.0)
            .await
            .map_err(|_| Failure::DomainFailed)
    }
}

struct Control {
    address: SocketAddr,
    blocking: bool,
    canary: &'static str,
}

impl producer::ControlSockets for Control {
    type Io = tokio::net::TcpStream;

    // This test-support-only entry deliberately emits a raw TRACE canary and
    // panics on both owned thread kinds to qualify actual production sinks.
    // Unwrapping the blocking panic deliberately propagates it to the owner.
    #[expect(clippy::panic, clippy::unwrap_used)]
    async fn connect(&self, _keys: &NodeState) -> Result<(Self::Io, Self::Io), Failure> {
        let socket = tokio::net::TcpStream::connect(self.address)
            .await
            .map_err(|_| Failure::DomainFailed)?;
        let client = ts_http_util::http2::connect::<EmptyBody>(socket)
            .await
            .map_err(|_| Failure::DomainFailed)?;
        let request = Request::builder()
            .uri(format!(
                "http://{}/native-privacy-qualification",
                self.address
            ))
            .header("Authorization", format!("Bearer {}", self.canary))
            .body(EmptyBody::new())
            .map_err(|_| Failure::DomainFailed)?;
        let response = client
            .send(request)
            .await
            .map_err(|_| Failure::DomainFailed)?;
        let _ = response
            .into_body()
            .collect()
            .await
            .map_err(|_| Failure::DomainFailed)?;
        let canary = self.canary;
        let _private_span = tracing::info_span!(target: "hyper", "native private HTTP span", registration_body = canary).entered();
        // The fixture explicitly exercises a TRACE event; ordinary production
        // startup stages use INFO and must reach their configured sinks.
        tracing::event!(target: "ts_control", tracing::Level::TRACE, registration_body = canary, "synthetic private TRACE canary");
        tracing::warn!(target: "ts_actor", auth_url = canary, "synthetic private WARN canary");
        tracing::warn!(target: "hyper", body = canary, "synthetic HTTP WARN canary");
        tracing::warn!(target: "runner_remote::ssh::tailscale", stage = "startup", reason = "qualified_fixture", "native SSH stage");
        if self.blocking {
            tokio::task::spawn_blocking(move || panic!("{canary}"))
                .await
                .unwrap();
        }
        panic!("{canary}");
    }

    fn tls(&self) -> impl super::registration::Tls {
        super::registration::VerifiedTls
    }
}

pub(crate) async fn run(
    address: SocketAddr,
    blocking: bool,
    canary: &'static str,
) -> Result<(), crate::guest_rpc::CleanupError> {
    let operation = async {
        if !address.ip().is_loopback() {
            return Err(Failure::DomainFailed);
        }
        // The real fixed constructor also has an actual owned OS worker. Before
        // admission it must physically join without making any provider IO.
        let cold = Registry::new(Arc::new(Pool::new()));
        let node = cold.acquire_configured(configuration(canary)?, producer::work)?;
        drop(node);
        cold.shutdown().await?;

        let cache = crate::ssh::cache::Cache::new();
        let registration = cache.register(runner_types::ids::RunId::new_v4());
        let access = registration
            .lookup(uuid::Uuid::new_v4())
            .map_err(|_| Failure::DomainFailed)?;
        let node = access
            .native_configured(configuration(canary)?, move |configuration, journal| {
                producer::work_using(
                    configuration,
                    journal,
                    Api(address),
                    Control {
                        address,
                        blocking,
                        canary,
                    },
                    regional_relay::Verified(super::resolver::Resolver::new()),
                )
            })
            .map_err(|_| Failure::DomainFailed)?;
        let readiness = node.ready().await;
        let physical = node.physical().await;
        // An original dial after failed startup must not create another worker
        // or dispatch native IO, even though its configured client is retained.
        if node.dial("synthetic.invalid", 22).await.is_ok() {
            return Err(Failure::DomainFailed);
        }
        registration.close();
        let cleanup = registration.shutdown_native().await;
        readiness.and(physical).and(cleanup)
    };
    operation
        .await
        .map_err(|_| crate::guest_rpc::CleanupError::Native)
}
