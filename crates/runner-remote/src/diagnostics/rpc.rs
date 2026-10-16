//! Passive queries reauthorize through existing metadata-only Run inventories.

use runner_provider::HttpClient;
use runner_rpc_proto::{Response, ResponseWriter};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use uuid::Uuid;
use zeroize::Zeroizing;

use super::{Handle, Protocol, Selector};

pub(crate) struct Authority {
    http: HttpClient,
    token: Zeroizing<String>,
}

#[derive(Deserialize)]
struct Inventory {
    hosts: Vec<Host>,
    diagnostics: InventoryDiagnostics,
}
#[derive(Deserialize)]
struct InventoryDiagnostics {
    version: u8,
    identities: Vec<HostIdentity>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostIdentity {
    id: Uuid,
    created_at: chrono::DateTime<chrono::Utc>,
    generation: i64,
}
#[derive(Deserialize)]
struct Host {
    id: Uuid,
}

impl Authority {
    pub(crate) fn new(http: HttpClient, token: &str) -> Self {
        Self {
            http,
            token: Zeroizing::new(token.to_owned()),
        }
    }
    async fn hosts(&self, protocol: Protocol) -> Result<Vec<HostIdentity>, ()> {
        let route = api_contracts::Route::new(
            api_contracts::Method::Get,
            match protocol {
                Protocol::Ssh => "/api/ssh/hosts",
                Protocol::Vnc => "/api/vnc/hosts",
            },
        );
        let work = async {
            let mut response = self
                .http
                .request_route(route, &self.token)
                .query(&[("diagnostics", "1")])
                .send("remote_diagnostics_authority")
                .await
                .map_err(|_| ())?;
            if response.status() != reqwest::StatusCode::OK {
                return Err(());
            }
            const MAX_BYTES: usize = 512 * 1024;
            if response
                .content_length()
                .is_some_and(|n| n > MAX_BYTES as u64)
            {
                return Err(());
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
                if chunk.len() > MAX_BYTES - bytes.len() {
                    return Err(());
                }
                bytes.extend_from_slice(&chunk);
            }
            let inventory: Inventory = serde_json::from_slice(&bytes).map_err(|_| ())?;
            let count = inventory.hosts.len();
            let mut visible = inventory
                .hosts
                .into_iter()
                .map(|host| host.id)
                .collect::<std::collections::HashSet<_>>();
            if inventory.diagnostics.version != 1
                || count != visible.len()
                || count != inventory.diagnostics.identities.len()
                || inventory.diagnostics.identities.iter().any(|host| {
                    !visible.remove(&host.id)
                        || host.generation <= 0
                        || host.generation > i64::from(i32::MAX)
                })
            {
                return Err(());
            }
            Ok(inventory.diagnostics.identities)
        };
        tokio::time::timeout(Duration::from_secs(5), work)
            .await
            .map_err(|_| ())?
    }
}

fn permits(
    hosts: &[HostIdentity],
    id: Uuid,
    created_at: Option<chrono::DateTime<chrono::Utc>>,
) -> bool {
    hosts
        .iter()
        .any(|host| host.id == id && created_at.is_none_or(|expected| host.created_at == expected))
}

fn unbound(cause: super::Cause) -> bool {
    use crate::{ssh::FailureReason as S, vnc::Failure as V};
    matches!(
        cause,
        super::Cause::Ssh(
            S::Unavailable
                | S::AuthorityFailure
                | S::ResourceExhausted
                | S::Cancelled
                | S::TimedOut
                | S::UnsafeDestination
                | S::ConfigurationChanged
        ) | super::Cause::Vnc(
            V::Unavailable
                | V::Authority
                | V::ResourceExhausted
                | V::Cancelled
                | V::TimedOut
                | V::InvalidInput
                | V::UnsupportedProfile
        )
    )
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Found,
    NoFailure,
    NotRetained,
    AuthorityUnavailable,
    Unavailable,
}

#[derive(Serialize)]
struct Query {
    schema_version: u8,
    status: Status,
    report: Option<super::Report>,
    retention: Retention,
}
#[derive(Serialize)]
struct Retention {
    capacity: usize,
    evicted: u64,
    latest_failure_pinned: bool,
}

impl Handle {
    async fn query(
        &self,
        protocol: Protocol,
        selector: Selector,
        authority: Option<&Authority>,
    ) -> Query {
        let mut query = Query {
            schema_version: 1,
            status: Status::Unavailable,
            report: None,
            retention: Retention {
                capacity: super::CAPACITY,
                evicted: 0,
                latest_failure_pinned: true,
            },
        };
        if !self.enabled() || !self.current() {
            return query;
        }
        let Some(authority) = authority else {
            return query;
        };
        query.status = Status::AuthorityUnavailable;
        let Ok(hosts) = authority.hosts(protocol).await else {
            return query;
        };
        if selector
            .connection_id
            .is_some_and(|id| !permits(&hosts, id, None))
        {
            return query;
        }
        let report = self.select(protocol, &selector);
        if let Some(report) = &report {
            if !permits(
                &hosts,
                report.connection_id,
                report.configuration_created_at,
            ) {
                return query;
            }
            if report.configuration_created_at.is_none()
                && (report.native.is_some()
                    || !report.dependencies.is_empty()
                    || !unbound(report.cause))
            {
                return query;
            }
            if !report.dependencies.is_empty() {
                let Ok(ssh) = authority.hosts(Protocol::Ssh).await else {
                    return query;
                };
                if report.dependencies.iter().any(|d| {
                    !permits(&ssh, d.connection_id, d.configuration_created_at)
                        || (d.configuration_created_at.is_none()
                            && (report.native.is_some()
                                || d.cause.is_some_and(|cause| !unbound(cause))))
                }) {
                    return query;
                }
            }
        }
        if !self.current() {
            query.status = Status::Unavailable;
            return query;
        }
        query.status = if report.is_some() {
            Status::Found
        } else if selector.connection_id.is_some()
            || selector.attempt_id.is_some()
            || selector.session_id.is_some()
        {
            Status::NotRetained
        } else {
            Status::NoFailure
        };
        query.report = report;
        query.retention.evicted = self
            .store
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .evicted;
        query
    }

    pub(crate) async fn dispatch(
        &self,
        request: super::super::guest_rpc::Request,
        authority: Option<Arc<Authority>>,
    ) {
        let super::super::guest_rpc::Request {
            input,
            lease,
            deadline,
            cancelled,
            sandbox_cancelled,
            request,
            ..
        } = request;
        let _lease = lease;
        let scope = crate::guest_rpc::Scope {
            cancelled,
            sandbox_cancelled,
            deadline,
        };
        let data = if request.method == "remote.diagnostics.capabilities" {
            if serde_json::from_str::<Empty>(request.params.get()).is_err() {
                scope
                    .error(input, runner_rpc_proto::ErrorCode::InvalidRequest)
                    .await;
                return;
            }
            serde_json::value::to_raw_value(&Capabilities {
                schema_version: 1,
                passive_query: self.enabled() && self.current(),
                active_check: false,
            })
        } else {
            let Ok(selector) = serde_json::from_str::<Selector>(request.params.get()) else {
                scope
                    .error(input, runner_rpc_proto::ErrorCode::InvalidRequest)
                    .await;
                return;
            };
            let protocol = if request.method == "ssh.diagnose" {
                Protocol::Ssh
            } else {
                Protocol::Vnc
            };
            let Some(query) = scope
                .wait(self.query(protocol, selector, authority.as_deref()))
                .await
            else {
                return;
            };
            serde_json::value::to_raw_value(&query)
        };
        if let Ok(data) = data {
            let _ = scope
                .wait(ResponseWriter::new(input).send(&Response::Result { data }))
                .await;
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Serialize)]
struct Capabilities {
    schema_version: u8,
    passive_query: bool,
    active_check: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::{Cause, Dependency, Identity, Operation};
    use crate::test_fixtures::http::{HttpClientConfig, http_client};
    use crate::test_fixtures::remote_inventory;
    use httpmock::MockServer;
    const CREATED_AT: &str = "2026-09-01T00:00:00.123456Z";

    #[tokio::test]
    async fn nested_evidence_requires_both_current_inventories_and_drops_provider_text() {
        let api = MockServer::start_async().await;
        let authority = Authority::new(
            http_client(HttpClientConfig {
                api_url: api.base_url(),
                vercel_bypass: None,
                client_session_id: "history-authority".into(),
            }),
            "agent-token-canary",
        );
        let vnc = Uuid::new_v4();
        let ssh = Uuid::new_v4();
        let inventory = api
            .mock_async(|when, then| {
                when.method("GET")
                    .path("/api/vnc/hosts")
                    .query_param("diagnostics", "1")
                    .header("authorization", "Bearer agent-token-canary");
                then.status(200)
                    .json_body(remote_inventory(&[(&vnc.to_string(), 7)], CREATED_AT));
            })
            .await;
        let denied = api
            .mock_async(|when, then| {
                when.method("GET").path("/api/ssh/hosts");
                then.status(403).body("credential-canary");
            })
            .await;
        let handle = Handle::new(runner_types::ids::RunId::new_v4(), true);
        handle.record(super::super::Record {
            protocol: Protocol::Vnc,
            connection: vnc,
            operation: Operation::Start,
            identity: Identity {
                created_at: Some(CREATED_AT.parse().unwrap()),
                generation: Some(7),
                session: None,
            },
            cause: Cause::Vnc(crate::vnc::Failure::InvalidCredential),
            dependency: Some(Dependency {
                protocol: Protocol::Ssh,
                connection_id: ssh,
                cause: Some(Cause::Ssh(crate::ssh::FailureReason::HostKeyMismatch)),
                configuration_created_at: Some(CREATED_AT.parse().unwrap()),
                configuration_generation: Some(7),
            }),
            native: None,
        });
        let hidden = handle
            .query(Protocol::Vnc, Selector::default(), Some(&authority))
            .await;
        assert_eq!(
            serde_json::to_value(&hidden).unwrap()["status"],
            "authority_unavailable"
        );
        assert!(hidden.report.is_none());
        denied.delete_async().await;
        let allowed = api
            .mock_async(|when, then| {
                when.method("GET").path("/api/ssh/hosts");
                then.status(200)
                    .json_body(remote_inventory(&[(&ssh.to_string(), 7)], CREATED_AT));
            })
            .await;
        let result = serde_json::to_value(
            handle
                .query(Protocol::Vnc, Selector::default(), Some(&authority))
                .await,
        )
        .unwrap();
        assert_eq!(result["status"], "found");
        assert_eq!(
            result["report"]["dependencies"][0]["cause"]["code"],
            "host_key_mismatch"
        );
        for secret in [
            "inventory-host-canary",
            "credential-canary",
            "agent-token-canary",
        ] {
            assert!(!result.to_string().contains(secret));
        }
        inventory.assert_calls_async(2).await;
        allowed.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn creation_precision_and_old_identity_writers_fail_closed() {
        let api = MockServer::start_async().await;
        let authority = Authority::new(
            http_client(HttpClientConfig {
                api_url: api.base_url(),
                vercel_bypass: None,
                client_session_id: "creation-authority".into(),
            }),
            "agent",
        );
        let host = Uuid::new_v4();
        let handle = Handle::new(runner_types::ids::RunId::new_v4(), true);
        handle.record(super::super::Record {
            protocol: Protocol::Ssh,
            connection: host,
            operation: Operation::Exec,
            identity: Identity {
                created_at: Some(CREATED_AT.parse().unwrap()),
                generation: Some(7),
                session: None,
            },
            cause: Cause::Ssh(crate::ssh::FailureReason::HostKeyMismatch),
            dependency: None,
            native: None,
        });
        for created_at in ["2026-09-01T00:00:00.123457Z", CREATED_AT] {
            let inventory = api
                .mock_async(|when, then| {
                    when.method("GET")
                        .path("/api/ssh/hosts")
                        .query_param("diagnostics", "1");
                    then.status(200)
                        .json_body(remote_inventory(&[(&host.to_string(), 99)], created_at));
                })
                .await;
            let result = serde_json::to_value(
                handle
                    .query(Protocol::Ssh, Selector::default(), Some(&authority))
                    .await,
            )
            .unwrap();
            assert_eq!(
                result["status"],
                if created_at == CREATED_AT {
                    "found"
                } else {
                    "authority_unavailable"
                }
            );
            inventory.delete_async().await;
        }
        let old = api
            .mock_async(|when, then| {
                when.method("GET").path("/api/ssh/hosts");
                then.status(200)
                    .json_body(serde_json::json!({"hosts":[{"id":host}]}));
            })
            .await;
        let unavailable = handle
            .query(Protocol::Ssh, Selector::default(), Some(&authority))
            .await;
        assert!(unavailable.report.is_none());
        assert_eq!(
            serde_json::to_value(&unavailable).unwrap()["status"],
            "authority_unavailable"
        );
        old.assert_calls_async(1).await;
    }
}
