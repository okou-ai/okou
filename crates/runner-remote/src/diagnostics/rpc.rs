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

/// Only finite query-failure categories may cross the history boundary.
enum AuthorityFailure {
    Denied,
    Timeout,
    Transport,
    Service,
    InvalidResponse,
}

impl AuthorityFailure {
    fn query(self) -> Query {
        let message = match self {
            Self::Denied => {
                "Diagnostic history could not be read because the authority API denied the read request. Check this Run's read permissions. Current connectivity has not been checked."
            }
            Self::Timeout => {
                "Diagnostic history could not be read because the authority lookup timed out. Check API availability and the Runner's API connection. Current connectivity has not been checked."
            }
            Self::Transport => {
                "Diagnostic history could not be read because the authority API request or response could not be transferred. Check the Runner's API connection. Current connectivity has not been checked."
            }
            Self::Service => {
                "Diagnostic history could not be read because the authority API reported a service failure or rate limit. Check API health before trying the history query again. Current connectivity has not been checked."
            }
            Self::InvalidResponse => {
                "Diagnostic history could not be read because the authority API returned an invalid or oversized inventory response. Check API compatibility and response validity. Current connectivity has not been checked."
            }
        };
        Query {
            status: Status::AuthorityUnavailable,
            message: message.into(),
        }
    }
}

#[derive(Deserialize)]
struct Inventory {
    hosts: Vec<Host>,
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
    /// The token is from the authenticated install context, never the guest request.
    pub(crate) fn permits_check(&self, run: runner_types::ids::RunId, protocol: Protocol) -> bool {
        use base64::Engine;
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Claims {
            scope: String,
            run_id: String,
            capabilities: Vec<String>,
            exp: i64,
        }
        let Some(jwt) = self.token.strip_prefix("vm0_sandbox_") else {
            return false;
        };
        let mut parts = jwt.split('.');
        let _header = parts.next();
        let Some(payload) = parts.next().filter(|p| p.len() <= 65536) else {
            return false;
        };
        if parts.next().is_none() || parts.next().is_some() {
            return false;
        }
        let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload) else {
            return false;
        };
        let Ok(claims) = serde_json::from_slice::<Claims>(&bytes) else {
            return false;
        };
        let capability = match protocol {
            Protocol::Ssh => "ssh:write",
            Protocol::Vnc => "vnc:write",
        };
        claims.scope == "okou"
            && claims.run_id == run.to_string()
            && claims.exp > chrono::Utc::now().timestamp()
            && claims.capabilities.iter().any(|c| c == capability)
    }

    pub(crate) fn new(http: HttpClient, token: &str) -> Self {
        Self {
            http,
            token: Zeroizing::new(token.to_owned()),
        }
    }
    async fn hosts(&self, protocol: Protocol) -> Result<Vec<HostIdentity>, AuthorityFailure> {
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
                .send("remote_diagnostics_authority")
                .await
                .map_err(|error| match error {
                    runner_provider::ProviderError::ApiTransport(error)
                        if error.failure_kind == runner_provider::ApiFailureKind::Timeout =>
                    {
                        AuthorityFailure::Timeout
                    }
                    _ => AuthorityFailure::Transport,
                })?;
            match response.status() {
                reqwest::StatusCode::OK => {}
                reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
                    return Err(AuthorityFailure::Denied);
                }
                reqwest::StatusCode::REQUEST_TIMEOUT => return Err(AuthorityFailure::Timeout),
                status
                    if status.is_server_error()
                        || status == reqwest::StatusCode::TOO_MANY_REQUESTS =>
                {
                    return Err(AuthorityFailure::Service);
                }
                _ => return Err(AuthorityFailure::InvalidResponse),
            }
            const MAX_BYTES: usize = 512 * 1024;
            if response
                .content_length()
                .is_some_and(|n| n > MAX_BYTES as u64)
            {
                return Err(AuthorityFailure::InvalidResponse);
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| {
                if error.is_timeout() {
                    AuthorityFailure::Timeout
                } else {
                    AuthorityFailure::Transport
                }
            })? {
                if chunk.len() > MAX_BYTES - bytes.len() {
                    return Err(AuthorityFailure::InvalidResponse);
                }
                bytes.extend_from_slice(&chunk);
            }
            let inventory: Inventory =
                serde_json::from_slice(&bytes).map_err(|_| AuthorityFailure::InvalidResponse)?;
            let count = inventory.hosts.len();
            let mut visible = inventory
                .hosts
                .into_iter()
                .map(|host| host.id)
                .collect::<std::collections::HashSet<_>>();
            if count != visible.len()
                || count != inventory.identities.len()
                || inventory.identities.iter().any(|host| {
                    !visible.remove(&host.id)
                        || host.generation <= 0
                        || host.generation > i64::from(i32::MAX)
                })
            {
                return Err(AuthorityFailure::InvalidResponse);
            }
            Ok(inventory.identities)
        };
        tokio::time::timeout(Duration::from_secs(5), work)
            .await
            .map_err(|_| AuthorityFailure::Timeout)?
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
        ) | super::Cause::File(
            crate::ssh::FileFailure::TransferLimit | crate::ssh::FileFailure::FileTooLarge
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
    status: Status,
    message: String,
}

impl Handle {
    async fn query(
        &self,
        protocol: Protocol,
        selector: Selector,
        authority: Option<&Authority>,
    ) -> Query {
        let mut query = Query {
            status: Status::Unavailable,
            message: "Diagnostics are unavailable or disabled for this Run. Current connectivity has not been checked.".into(),
        };
        if !self.enabled() || !self.current() {
            return query;
        }
        let Some(authority) = authority else {
            return query;
        };
        query.status = Status::AuthorityUnavailable;
        query.message = "Diagnostic history is unavailable under current Run, host or dependency read authority. Check permissions and API availability. Current connectivity has not been checked.".into();
        let hosts = match authority.hosts(protocol).await {
            Ok(hosts) => hosts,
            Err(failure) => return failure.query(),
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
                    || !report.cause.is_some_and(unbound))
            {
                return query;
            }
            if !report.dependencies.is_empty() {
                let ssh = match authority.hosts(Protocol::Ssh).await {
                    Ok(hosts) => hosts,
                    Err(failure) => return failure.query(),
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
            query.message =
                "The Run assignment changed; historical diagnostics are unavailable.".into();
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
        let message = report.as_ref().and_then(super::Report::message);
        if report.is_some() && message.is_none() {
            query.status = Status::Unavailable;
        }
        query.message = message.unwrap_or_else(|| match query.status {
            Status::NoFailure => "No operational failure was recorded in this Run. Current connectivity has not been checked.".into(),
            Status::NotRetained => "No matching failure is retained in this Run's bounded history (64 detailed reports, latest failures pinned). Current connectivity has not been checked.".into(),
            _ => "Diagnostic detail is unavailable. Current connectivity has not been checked.".into(),
        });
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
        let data = {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::{Cause, Dependency, Identity, Operation};
    use crate::test_fixtures::http::{HttpClientConfig, http_client};
    use crate::test_fixtures::remote_inventory;
    use httpmock::MockServer;
    const CREATED_AT: &str = "2026-09-01T00:00:00.123456Z";

    #[tokio::test]
    async fn active_check_authority_is_bound_to_the_installed_run_execution_claims() {
        use base64::Engine;
        let api = MockServer::start_async().await;
        let http = http_client(HttpClientConfig {
            api_url: api.base_url(),
            vercel_bypass: None,
            client_session_id: "check-authority".into(),
        });
        let run = runner_types::ids::RunId::new_v4();
        let valid = serde_json::json!({"scope":"okou","runId":run,"capabilities":["ssh:write"],"exp":chrono::Utc::now().timestamp()+3600});
        for (field, value) in [
            ("scope", serde_json::json!("other")),
            (
                "runId",
                serde_json::json!(runner_types::ids::RunId::new_v4()),
            ),
            ("exp", serde_json::json!(0)),
            ("capabilities", serde_json::json!(["ssh:read", "vnc:write"])),
        ] {
            let mut claims = valid.clone();
            claims[field] = value;
            let token = format!(
                "vm0_sandbox_e30.{}.signature",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string())
            );
            assert!(
                !Authority::new(http.clone(), &token).permits_check(run, Protocol::Ssh),
                "{field}"
            );
        }
        let token = crate::test_fixtures::check_token(run, &["ssh:write"]);
        let authority = Authority::new(http, &token);
        assert!(authority.permits_check(run, Protocol::Ssh));
        assert!(!authority.permits_check(run, Protocol::Vnc));
    }

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
        let _ = handle.record(super::super::Record {
            effects: None,
            protocol: Protocol::Vnc,
            connection: vnc,
            operation: Operation::Start,
            identity: Identity {
                created_at: Some(CREATED_AT.parse().unwrap()),
                generation: Some(7),
                session: None,
            },
            cause: Some(Cause::Vnc(crate::vnc::Failure::InvalidCredential)),
            dependency: Some(Dependency {
                protocol: Protocol::Ssh,
                connection_id: ssh,
                cause: Some(Cause::Ssh(crate::ssh::FailureReason::HostKeyMismatch)),
                configuration_created_at: Some(CREATED_AT.parse().unwrap()),
                configuration_generation: Some(7),
            }),
            native: None,
            ssh: None,
            vnc: None,
        });
        let hidden = handle
            .query(Protocol::Vnc, Selector::default(), Some(&authority))
            .await;
        assert_eq!(
            serde_json::to_value(&hidden).unwrap()["status"],
            "authority_unavailable"
        );
        assert!(!hidden.message.contains(&ssh.to_string()));
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
        assert!(
            crate::test_fixtures::diagnostic_text(&result).contains(&format!(
                "- Dependency (ssh): {ssh}; cause: SSH host key mismatch;"
            ))
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
    async fn creation_precision_and_missing_identity_fail_closed() {
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
        let _ = handle.record(super::super::Record {
            effects: None,
            protocol: Protocol::Ssh,
            connection: host,
            operation: Operation::Exec,
            identity: Identity {
                created_at: Some(CREATED_AT.parse().unwrap()),
                generation: Some(7),
                session: None,
            },
            cause: Some(Cause::Ssh(crate::ssh::FailureReason::HostKeyMismatch)),
            dependency: None,
            native: None,
            ssh: None,
            vnc: None,
        });
        for created_at in ["2026-09-01T00:00:00.123457Z", CREATED_AT] {
            let inventory = api
                .mock_async(|when, then| {
                    when.method("GET").path("/api/ssh/hosts");
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
        let missing_identity = api
            .mock_async(|when, then| {
                when.method("GET").path("/api/ssh/hosts");
                then.status(200)
                    .json_body(serde_json::json!({"hosts":[{"id":host}]}));
            })
            .await;
        let unavailable = handle
            .query(Protocol::Ssh, Selector::default(), Some(&authority))
            .await;
        assert!(!unavailable.message.contains(&host.to_string()));
        assert_eq!(
            serde_json::to_value(&unavailable).unwrap()["status"],
            "authority_unavailable"
        );
        missing_identity.assert_calls_async(1).await;
    }
}
