//! Real independently owned observation and API-backed heartbeat completion.

use std::{collections::BTreeMap, net::Ipv4Addr, path::Path, sync::Arc, time::Duration};

use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_lifecycle::{
    active_runs::ActiveRuns, home_image_cache::snapshot::HomeCacheStateSnapshot,
    lifecycle::RunnerMode, resource_budget::ResourceBudget,
};
use runner_provider::{
    ApiProvider, ApiProviderConfig, BuiltinFirewallCatalogCachePaths, JobProvider,
    RunCancellationRegistry,
    http::{HttpClient, HttpClientConfig},
};
use runner_supervisor::{
    heartbeat::{HeartbeatContext, HeartbeatContextInit, HeartbeatController, HeartbeatProfile},
    host_memory::HostMemoryObserver,
    idle_lifecycle::SharedIdlePool,
};
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::{
    TestResult,
    continuation_api::{Api, TOKEN},
    evidence, fixture, io,
};

pub async fn observe() -> TestResult<Value> {
    let started = evidence::clocks()?.0;
    let observer = HostMemoryObserver::spawn();
    let mut observations = observer.subscribe_for_test();
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let observation = observations.borrow_and_update().clone();
            let now = tokio::time::Instant::now();
            if let Ok(available) = observation.available_bytes_at(now, Duration::from_secs(5)) {
                let age = observation
                    .age_at(now)
                    .ok_or_else(|| io::Error::other("native observer clock invalid"))?;
                return Ok::<_, Box<dyn std::error::Error + Send + Sync>>(json!({
                    "started_ns": started, "completed_ns": evidence::clocks()?.0,
                    "available_bytes": available, "age_ns": u64::try_from(age.as_nanos())?,
                    "read_duration_ns": u64::try_from(observation.read_duration().as_nanos())?,
                    "joined": true,
                }));
            }
            observations.changed().await?;
        }
    })
    .await;
    let joined = observer.shutdown().await;
    let observed = result.map_err(io::Error::other)??;
    joined?;
    Ok(observed)
}

pub struct Probe {
    api: Api,
    provider: Arc<dyn JobProvider>,
    controller: HeartbeatController,
    runner: RunnerProcessIdentity,
    sequence: u64,
}

impl Probe {
    pub fn hold_claim_failure(
        &self,
        run: super::RunId,
        outcome: super::claim_peer::Outcome,
    ) -> TestResult<(Arc<dyn JobProvider>, Arc<super::claim_peer::Gate>)> {
        Ok((
            self.provider.clone(),
            self.api
                .hold_claim_with_outcome(run, self.runner, outcome)?,
        ))
    }

    pub fn hold_claim(
        &self,
        run: super::RunId,
    ) -> TestResult<(Arc<dyn JobProvider>, Arc<super::claim_peer::Gate>)> {
        Ok((
            self.provider.clone(),
            self.api.hold_claim(run, self.runner)?,
        ))
    }

    pub async fn new(
        pool: &SharedIdlePool,
        budget: &Arc<ResourceBudget>,
        path: &Path,
        rootfs_hash: &str,
    ) -> TestResult<Self> {
        let api = Api::bind(Ipv4Addr::LOCALHOST).await?;
        let runner = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1)?;
        let provider: Arc<dyn JobProvider> = ApiProvider::new(
            HttpClient::new(HttpClientConfig {
                api_url: api.host_url.clone(),
                vercel_bypass: None,
                client_session_id: "native-foreground".into(),
                runner_version: env!("CARGO_PKG_VERSION"),
            })?,
            TOKEN.into(),
            ApiProviderConfig {
                ably_side_message_handler: None,
                runner_identity: runner,
                runner_hostname: None,
                group: "native-foreground".into(),
                supported_profiles: vec![fixture::PROFILE.into()],
                installed_okou_cli: None,
            },
            BuiltinFirewallCatalogCachePaths {
                cache_path: path.join("foreground-firewall.json"),
                lock_path: path.join("foreground-firewall.lock"),
            },
            CancellationToken::new(),
            RunCancellationRegistry::new(),
        );
        let profiles = BTreeMap::from([(
            fixture::PROFILE.into(),
            HeartbeatProfile {
                vcpu: 2,
                memory_mb: 4096,
                rootfs_hash: rootfs_hash.into(),
                home_disk_mb: fixture::HOME_DISK_MB,
            },
        )]);
        let active = ActiveRuns::new(Arc::new(Notify::new()));
        let controller = HeartbeatController::new(HeartbeatContext::new(HeartbeatContextInit {
            idle_pool: pool,
            runner_identity: runner,
            runner_hostname: None,
            group: "native-foreground",
            profiles: &profiles,
            budget,
            provider: provider.clone(),
            active_runs: &active,
            home_cache_snapshot: HomeCacheStateSnapshot::new(),
            sandbox_op_reporter: None,
        }));
        Ok(Self {
            api,
            provider,
            controller,
            runner,
            sequence: 0,
        })
    }

    pub fn request(&mut self) -> TestResult<()> {
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or_else(|| io::Error::other("native heartbeat sequence overflow"))?;
        self.controller.request(RunnerMode::Running)?;
        Ok(())
    }

    pub fn has_receipts(&self) -> TestResult<bool> {
        Ok(!self.api.runner_heartbeats()?.is_empty())
    }

    pub async fn complete(&mut self) -> TestResult<Value> {
        tokio::time::timeout(Duration::from_secs(5), self.controller.wait_for_send()).await??;
        self.controller.finish_send(RunnerMode::Running)?;
        let receipts = self.api.runner_heartbeats()?;
        let receipt = receipts
            .last()
            .ok_or_else(|| io::Error::other("native heartbeat was not delivered"))?;
        let value = &receipt["state"];
        if receipts.len() as u64 != self.sequence
            || value["runnerId"].as_str() != Some(self.runner.runner_id().to_string().as_str())
            || value["snapshotGeneration"].as_u64() != Some(self.runner.heartbeat_generation())
            || value["snapshotSequence"].as_u64() != Some(self.sequence)
            || value["group"] != "native-foreground"
            || value["mode"] != "running"
            || receipt["acknowledgement_status"] != 204
        {
            return Err(io::Error::other(
                "native heartbeat identity/order/acknowledgement changed",
            )
            .into());
        }
        Ok(json!({"receipt": receipt, "send_joined": true,
            "completed_ns": evidence::clocks()?.0}))
    }

    pub async fn finish(mut self) -> TestResult<()> {
        let sends = self.controller.drain().await;
        self.provider.shutdown().await;
        drop(self.controller);
        let peer = self.api.finish().await;
        sends?;
        peer
    }
}

#[cfg(test)]
mod tests;
