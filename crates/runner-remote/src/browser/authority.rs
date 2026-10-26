//! Adapter over existing official Runner authentication and Browser ownership.

use api_contracts::generated::{
    routes::runners::runs::by_run_id::browser as routes, types::runners::browser::*,
};
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_provider::HttpClient;
use runner_types::ids::RunId;
use serde::{Serialize, de::DeserializeOwned};
use std::time::Duration;
use zeroize::Zeroizing;

use super::{Failure, Result};

pub(super) struct Authority {
    http: HttpClient,
    client: reqwest::Client,
    token: Zeroizing<String>,
    identity: RunnerProcessIdentity,
}

#[derive(Clone, PartialEq)]
pub(super) struct Scope {
    pub instance: String,
    pub provider: String,
    pub chat: String,
    pub window: u64,
    pub expires: u64,
}

impl Authority {
    pub(super) fn new(
        http: HttpClient,
        token: &str,
        identity: RunnerProcessIdentity,
    ) -> Result<Self> {
        Ok(Self {
            http,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|_| Failure)?,
            token: Zeroizing::new(token.to_owned()),
            identity,
        })
    }

    async fn call<T: DeserializeOwned>(
        &self,
        route: api_contracts::ResolvedRoute,
        body: &impl Serialize,
    ) -> Result<T> {
        let body = serde_json::to_value(body).map_err(|_| Failure)?;
        let request = self
            .http
            .json_request(route, &self.token, &body)
            .map_err(|_| Failure)?;
        let mut response = self.client.execute(request).await.map_err(|_| Failure)?;
        const MAXIMUM: usize = 64 * 1024;
        if response.status() != reqwest::StatusCode::OK
            || response
                .content_length()
                .is_some_and(|size| size > MAXIMUM as u64)
        {
            return Err(Failure);
        }
        let mut bytes = Zeroizing::new(Vec::with_capacity(MAXIMUM));
        while let Some(chunk) = response.chunk().await.map_err(|_| Failure)? {
            if chunk.len() > MAXIMUM - bytes.len() {
                return Err(Failure);
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| Failure)
    }

    pub(super) async fn current(&self, run: RunId, expected: Option<&Scope>) -> Result<Scope> {
        let action = expected.map_or(
            ControlRequestAction::Inspect { instance_id: None },
            |scope| ControlRequestAction::Authorize {
                instance_id: scope.instance.clone(),
                provider_session_id: scope.provider.clone(),
                primary_window_id: scope.window,
            },
        );
        let body = ControlRequest {
            runner_identity: ControlRequestRunnerIdentity {
                runner_id: self.identity.runner_id().to_string(),
                heartbeat_generation: self.identity.heartbeat_generation() as i64,
            },
            action,
        };
        let response: ControlResponse = self
            .call(
                routes::control::route(routes::control::Params {
                    run_id: &run.to_string(),
                }),
                &body,
            )
            .await?;
        let ControlResponse::Accepted { instance } = response else {
            return Err(Failure);
        };
        let window = instance.window.ok_or(Failure)?;
        if instance.status != ControlResponseAcceptedInstanceStatus::Active
            || window.state != ControlResponseAcceptedInstanceWindowState::Active
        {
            return Err(Failure);
        }
        let physical = chrono::DateTime::parse_from_rfc3339(&instance.timeout_at)
            .map_err(|_| Failure)?
            .timestamp_millis();
        let expires = window
            .expires_at
            .min(u64::try_from(physical).map_err(|_| Failure)?);
        let scope = Scope {
            instance: instance.id,
            provider: instance.provider_session_id.ok_or(Failure)?,
            chat: window.chat_thread_id,
            window: window.primary_window_id,
            expires,
        };
        if expires <= now() || expected.is_some_and(|old| !old.same_resource(&scope)) {
            return Err(Failure);
        }
        Ok(scope)
    }

    pub(super) async fn connection(
        &self,
        run: RunId,
        scope: &Scope,
    ) -> Result<ConnectionResponseAcceptedConnection> {
        let body = ConnectionRequest {
            runner_identity: ConnectionRequestRunnerIdentity {
                runner_id: self.identity.runner_id().to_string(),
                heartbeat_generation: self.identity.heartbeat_generation() as i64,
            },
            instance_id: scope.instance.clone(),
            provider_session_id: scope.provider.clone(),
            primary_window_id: scope.window,
        };
        let result: ConnectionResponse = self
            .call(
                routes::connection::route(routes::connection::Params {
                    run_id: &run.to_string(),
                }),
                &body,
            )
            .await?;
        let ConnectionResponse::Accepted { connection } = result else {
            return Err(Failure);
        };
        if connection.instance_id != scope.instance
            || connection.provider_session_id != scope.provider
            || connection.chat_thread_id != scope.chat
            || connection.primary_window_id != scope.window
            || connection.expires_at <= now()
        {
            return Err(Failure);
        }
        Ok(connection)
    }
}

impl Scope {
    fn same_resource(&self, other: &Self) -> bool {
        self.instance == other.instance
            && self.provider == other.provider
            && self.chat == other.chat
            && self.window == other.window
    }
}

pub(super) fn now() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}
