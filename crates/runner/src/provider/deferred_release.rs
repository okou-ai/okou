//! Durable, bounded delivery of physical Sandbox destruction facts. Uncertain
//! destruction writes no receipt and therefore cannot release API capacity.
use super::{DeferredSandboxFence, api::ApiClient};
use crate::ids::RunId;
use crate::runner_process_identity::RunnerProcessIdentity;
use crate::{lock, process};
use nix::fcntl::Flock;
use sandbox::SandboxId;
use std::fs::File;
use std::{path::PathBuf, time::Duration};
use tokio::{fs, io::AsyncWriteExt, sync::Mutex};
use tracing::warn;
use uuid::Uuid;

const RELEASE_SCAN_LIMIT: usize = 100;
const RELEASE_REQUEST_LIMIT: usize = 8;
const RELEASE_DELIVERY_TIMEOUT: Duration = Duration::from_secs(5);

/// What the API established about this proof. `Stale` is a definitive
/// acknowledgement that the receipt owns no capacity, so it can be closed.
/// `Inconclusive` means an obligation may remain: retain the receipt and the
/// claim barrier and retry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum ReleaseOutcome {
    Released,
    Stale,
    Inconclusive,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    run_id: RunId,
    runner_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner_epoch: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    heartbeat_generation: Option<u64>,
    proof: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ClaimReceipt {
    run_id: RunId,
    runner_id: Uuid,
    heartbeat_generation: u64,
    fence: Option<DeferredSandboxFence>,
    sandbox_id: Option<SandboxId>,
    actor_gone: bool,
    guest_cgroup: Option<PathBuf>,
}

#[derive(Default)]
struct ForeignRecovery {
    scopes: Option<fs::ReadDir>,
    active: Option<Box<DeferredReleaseOutbox>>,
}

pub(super) struct DeferredReleaseOutbox {
    directory: PathBuf,
    shared_root: Option<PathBuf>,
    owner: Mutex<Option<Flock<File>>>,
    foreign: Mutex<ForeignRecovery>,
    drain: Mutex<()>,
    claims: Mutex<()>,
    release_cursor: Mutex<Option<fs::ReadDir>>,
    recovery_cursor: Mutex<Option<fs::ReadDir>>,
}

impl DeferredReleaseOutbox {
    pub(super) fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            shared_root: None,
            owner: Mutex::new(None),
            foreign: Mutex::new(ForeignRecovery::default()),
            drain: Mutex::new(()),
            claims: Mutex::new(()),
            release_cursor: Mutex::new(None),
            recovery_cursor: Mutex::new(None),
        }
    }

    pub(super) fn new_shared(root: PathBuf, identity: &RunnerProcessIdentity) -> Self {
        let directory = root
            .join(format!(
                "{}-{}",
                identity.runner_id(),
                identity.heartbeat_generation()
            ))
            .join("releases");
        let mut outbox = Self::new(directory);
        outbox.shared_root = Some(root);
        outbox
    }

    fn owner_path(&self) -> PathBuf {
        self.directory.with_extension("owner-lock")
    }

    async fn own_scope(&self) -> std::io::Result<()> {
        let mut owner = self.owner.lock().await;
        if owner.is_none() {
            *owner = Some(
                lock::try_acquire(self.owner_path())
                    .await
                    .map_err(std::io::Error::other)?,
            );
        }
        Ok(())
    }

    /// A stopped version has no heartbeat. A current version owns recovery only
    /// while it holds that process scope's exclusive OS lock. Identity inequality
    /// alone never authorizes recovery while two versions run concurrently.
    pub(super) async fn recover_foreign(&self, api: &ApiClient, identity: &RunnerProcessIdentity) {
        let Some(root) = &self.shared_root else {
            return;
        };
        let Ok(mut cursor) = self.foreign.try_lock() else {
            return;
        };
        let recovery = async {
            if cursor.scopes.is_none() {
                match fs::read_dir(root).await {
                    Ok(entries) => cursor.scopes = Some(entries),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                    Err(error) => return Err(error),
                }
            }
            if cursor.active.is_none() {
                for _ in 0..100 {
                    let Some(entry) = cursor
                        .scopes
                        .as_mut()
                        .ok_or_else(|| std::io::Error::other("missing recovery scope cursor"))?
                        .next_entry()
                        .await?
                    else {
                        cursor.scopes = None;
                        return Ok(());
                    };
                    if !entry.file_type().await?.is_dir() {
                        continue;
                    }
                    let directory = entry.path().join("releases");
                    if directory == self.directory {
                        continue;
                    }
                    cursor.active = Some(Box::new(Self::new(directory)));
                    break;
                }
            }
            let Some(peer) = cursor.active.as_ref() else {
                return Ok(());
            };
            let guard = match lock::try_acquire_existing_or_missing(peer.owner_path()).await {
                Ok(lock::ExistingTryLock::Acquired(guard)) => guard,
                Ok(lock::ExistingTryLock::Busy | lock::ExistingTryLock::Missing) | Err(_) => {
                    cursor.active = None;
                    return Ok(());
                }
            };
            // Keep the guard in this scope through every proof and HTTP attempt.
            peer.flush_batch(api).await;
            peer.recover_claims(api, identity).await;
            let release_complete = peer.release_cursor.lock().await.is_none();
            let claim_complete = peer.recovery_cursor.lock().await.is_none();
            drop(guard);
            if release_complete && claim_complete {
                cursor.active = None;
            }
            Ok::<(), std::io::Error>(())
        };
        if let Err(error) = recovery.await {
            warn!(%error, "cross-version deferred recovery retained its obligations");
        }
    }

    pub(super) async fn record_and_flush(
        &self,
        api: &ApiClient,
        runner_id: Uuid,
        run_id: RunId,
        fence: DeferredSandboxFence,
    ) {
        let receipt = Receipt {
            run_id,
            runner_id,
            owner_epoch: Some(fence.owner_epoch),
            generation: Some(fence.generation),
            heartbeat_generation: None,
            proof: "destroyed".to_owned(),
        };
        self.persist_release(api, receipt).await;
    }

    async fn write_release(&self, receipt: &Receipt) -> std::io::Result<()> {
        fs::create_dir_all(&self.directory).await?;
        let path = self.directory.join(format!(
            "{}-{}.json",
            receipt.run_id,
            receipt.heartbeat_generation.unwrap_or_default()
        ));
        let staging = self.directory.with_extension("publishing");
        fs::create_dir_all(&staging).await?;
        let temporary = staging.join(format!("{}.tmp", Uuid::new_v4()));
        let bytes = serde_json::to_vec(receipt).map_err(std::io::Error::other)?;
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .await?;
        file.write_all(&bytes).await?;
        file.sync_all().await?;
        fs::rename(temporary, path).await?;
        fs::File::open(&self.directory).await?.sync_all().await
    }

    async fn persist_release(&self, api: &ApiClient, receipt: Receipt) {
        let run_id = receipt.run_id;
        if let Err(error) = self.write_release(&receipt).await {
            warn!(%run_id, %error, "failed to persist deferred Sandbox release; API capacity remains held");
            return;
        }
        // Keep the per-Run claim barrier until API acknowledgement. A delayed
        // not-started fact must never overlap a second claim by this process.
        self.flush_batch(api).await;
    }

    fn claim_path(&self, run_id: RunId) -> PathBuf {
        self.directory
            .with_extension("claims")
            .join(format!("{run_id}.json"))
    }

    async fn write_claim(&self, receipt: &ClaimReceipt, new: bool) -> std::io::Result<()> {
        let directory = self.directory.with_extension("claims");
        let staging = self.directory.with_extension("claim-publishing");
        fs::create_dir_all(&directory).await?;
        fs::create_dir_all(&staging).await?;
        let temporary = staging.join(format!("{}.tmp", Uuid::new_v4()));
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .await?;
        file.write_all(&serde_json::to_vec(receipt).map_err(std::io::Error::other)?)
            .await?;
        file.sync_all().await?;
        let path = self.claim_path(receipt.run_id);
        if new {
            // Never replace another uncertain claim for this Run.
            fs::hard_link(&temporary, &path).await?;
            fs::remove_file(temporary).await?;
        } else {
            fs::rename(temporary, path).await?;
        }
        fs::File::open(directory).await?.sync_all().await
    }

    pub(super) async fn begin_claim(
        &self,
        run_id: RunId,
        identity: &RunnerProcessIdentity,
    ) -> std::io::Result<()> {
        self.own_scope().await?;
        let _guard = self.claims.lock().await;
        self.write_claim(
            &ClaimReceipt {
                run_id,
                runner_id: identity.runner_id(),
                heartbeat_generation: identity.heartbeat_generation(),
                fence: None,
                sandbox_id: None,
                actor_gone: false,
                guest_cgroup: None,
            },
            true,
        )
        .await
    }

    pub(super) async fn accept_claim(
        &self,
        run_id: RunId,
        fence: Option<DeferredSandboxFence>,
    ) -> std::io::Result<()> {
        let _guard = self.claims.lock().await;
        if let Some(fence) = fence {
            let mut receipt: ClaimReceipt =
                serde_json::from_slice(&fs::read(self.claim_path(run_id)).await?)
                    .map_err(std::io::Error::other)?;
            receipt.fence = Some(fence);
            self.write_claim(&receipt, false).await
        } else {
            fs::remove_file(self.claim_path(run_id)).await
        }
    }

    pub(super) async fn bind_sandbox(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
    ) -> std::io::Result<()> {
        let _guard = self.claims.lock().await;
        let bytes = match fs::read(self.claim_path(run_id)).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let mut receipt: ClaimReceipt =
            serde_json::from_slice(&bytes).map_err(std::io::Error::other)?;
        if receipt.fence.is_none() || receipt.sandbox_id.is_some() {
            return Err(std::io::Error::other(
                "deferred claim cannot acquire a second Sandbox",
            ));
        }
        receipt.guest_cgroup = current_guest_cgroup(sandbox_id).await;
        receipt.sandbox_id = Some(sandbox_id);
        self.write_claim(&receipt, false).await
    }

    pub(super) async fn actor_gone(&self, run_id: RunId) {
        let _guard = self.claims.lock().await;
        let result = async {
            let bytes = match fs::read(self.claim_path(run_id)).await {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error),
            };
            let mut receipt: ClaimReceipt =
                serde_json::from_slice(&bytes).map_err(std::io::Error::other)?;
            receipt.actor_gone = true;
            self.write_claim(&receipt, false).await
        }
        .await;
        if let Err(error) = result {
            warn!(%run_id, %error, "deferred claim remains uncertain until Runner restart");
        }
    }

    pub(super) async fn recover_claims(&self, api: &ApiClient, identity: &RunnerProcessIdentity) {
        let Ok(_guard) = self.claims.try_lock() else {
            return;
        };
        let recovery = async {
            let mut cursor = self.recovery_cursor.lock().await;
            if cursor.is_none() {
                match fs::read_dir(self.directory.with_extension("claims")).await {
                    Ok(entries) => *cursor = Some(entries),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                    Err(error) => return Err(error),
                }
            }
            let mut discovery = None;
            for _ in 0..100 {
                let Some(entry) = cursor
                    .as_mut()
                    .ok_or_else(|| std::io::Error::other("missing claim recovery cursor"))?
                    .next_entry()
                    .await?
                else {
                    *cursor = None;
                    break;
                };
                let metadata = entry.metadata().await?;
                if !metadata.is_file() || metadata.len() > 4096 {
                    continue;
                }
                let receipt: ClaimReceipt =
                    match serde_json::from_slice(&fs::read(entry.path()).await?) {
                        Ok(receipt) => receipt,
                        Err(_) => continue, // Corrupt ownership is unknown, never release proof.
                    };
                if !receipt.actor_gone
                    && receipt.runner_id == identity.runner_id()
                    && receipt.heartbeat_generation == identity.heartbeat_generation()
                {
                    continue;
                }
                let proof = if let Some(sandbox_id) = receipt.sandbox_id {
                    if !captured_guest_cgroup_empty(receipt.guest_cgroup.as_deref()).await {
                        continue;
                    }
                    if discovery.is_none() {
                        discovery = Some(process::discover_all_with_status().await);
                    }
                    let scan = discovery
                        .as_ref()
                        .ok_or_else(|| std::io::Error::other("missing process recovery scan"))?;
                    let firecrackers = &scan.processes.firecrackers;
                    if !scan.proc_scan_complete
                        || firecrackers
                            .iter()
                            .any(|process| process.workspace_identity_incomplete())
                        || process::firecracker_process_exists_for_sandbox_id(
                            firecrackers,
                            &sandbox_id.to_string(),
                        )
                    {
                        continue;
                    }
                    "process-absent"
                } else {
                    // The old actor cannot later spawn: binding was fsynced
                    // before activation, or this actor explicitly relinquished.
                    "not-started"
                };
                let fence = receipt.fence;
                let release = Receipt {
                    run_id: receipt.run_id,
                    runner_id: receipt.runner_id,
                    owner_epoch: if proof == "not-started" {
                        None
                    } else {
                        fence.map(|f| f.owner_epoch)
                    },
                    generation: if proof == "not-started" {
                        None
                    } else {
                        fence.map(|f| f.generation)
                    },
                    heartbeat_generation: Some(receipt.heartbeat_generation),
                    proof: proof.to_owned(),
                };
                self.persist_release(api, release).await;
                break; // One receipt per heartbeat, including ambiguous claims.
            }
            Ok::<(), std::io::Error>(())
        };
        match tokio::time::timeout(Duration::from_secs(6), recovery).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                warn!(%error, "deferred claim recovery retained its ownership journal")
            }
            Err(_) => warn!("deferred claim recovery timed out; capacity remains held"),
        }
    }

    pub(super) async fn flush_batch(&self, api: &ApiClient) {
        self.flush_batch_with_timeout(api, RELEASE_DELIVERY_TIMEOUT)
            .await;
    }

    async fn flush_batch_with_timeout(&self, api: &ApiClient, timeout: Duration) {
        let Ok(_guard) = self.drain.try_lock() else {
            return;
        };
        // The cursor survives heartbeats and an active foreign-scope recovery.
        // A failed proof advances only delivery selection; it never removes the
        // durable receipt or per-Run claim barrier.
        let delivery = async {
            let mut cursor = self.release_cursor.lock().await;
            if cursor.is_none() {
                match fs::read_dir(&self.directory).await {
                    Ok(entries) => *cursor = Some(entries),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                    Err(error) => return Err(error),
                }
            }
            let mut requests = 0;
            for _ in 0..RELEASE_SCAN_LIMIT {
                let Some(entry) = cursor
                    .as_mut()
                    .ok_or_else(|| std::io::Error::other("missing release cursor"))?
                    .next_entry()
                    .await?
                else {
                    *cursor = None;
                    return Ok(());
                };
                if entry.path().extension().and_then(|ext| ext.to_str()) != Some("json") {
                    continue;
                }
                let metadata = entry.metadata().await?;
                if !metadata.is_file() || metadata.len() > 4096 {
                    continue;
                }
                let receipt: Receipt = match serde_json::from_slice(&fs::read(entry.path()).await?)
                {
                    Ok(receipt) => receipt,
                    Err(error) => {
                        let rejected = self.directory.with_extension("rejected");
                        fs::create_dir_all(&rejected).await?;
                        fs::rename(entry.path(), rejected.join(entry.file_name())).await?;
                        warn!(%error, "invalid deferred release receipt quarantined");
                        continue;
                    }
                };
                let mut body = serde_json::to_value(&receipt).map_err(std::io::Error::other)?;
                body.as_object_mut()
                    .ok_or_else(|| std::io::Error::other("invalid release receipt object"))?
                    .remove("runId");
                requests += 1;
                match api.release_deferred_sandbox(receipt.run_id, &body).await {
                    Ok(ReleaseOutcome::Inconclusive) => {
                        warn!(run_id = %receipt.run_id, "deferred release remains unresolved; receipt and claim barrier retained");
                    }
                    Ok(outcome) => {
                        // The API atomically fences an unclaimed v4 Run before
                        // acknowledging not-started, including delayed claims.
                        let _ = fs::remove_file(self.claim_path(receipt.run_id)).await;
                        if outcome == ReleaseOutcome::Released {
                            fs::remove_file(entry.path()).await?;
                        } else {
                            let rejected = self.directory.with_extension("rejected");
                            fs::create_dir_all(&rejected).await?;
                            fs::rename(entry.path(), rejected.join(entry.file_name())).await?;
                            warn!(run_id = %receipt.run_id, "stale deferred release receipt acknowledged without changing capacity");
                        }
                        fs::File::open(&self.directory).await?.sync_all().await?;
                    }
                    Err(error) => {
                        warn!(run_id = %receipt.run_id, %error, "deferred Sandbox release delivery retained for retry");
                    }
                }
                if requests == RELEASE_REQUEST_LIMIT {
                    return Ok(());
                }
            }
            Ok(())
        };
        match tokio::time::timeout(timeout, delivery).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => warn!(%error, "deferred Sandbox release scan retained for retry"),
            Err(_) => warn!("deferred Sandbox release delivery timed out; receipt retained"),
        }
    }
}

/// Official Runner startup requires a managed cgroup hierarchy. Check the
/// exact leaf again so a surviving pre-exec launcher cannot become a false
/// Firecracker-absence proof. Missing/unreadable hierarchy remains unknown.
async fn current_guest_cgroup(sandbox_id: SandboxId) -> Option<PathBuf> {
    let membership = fs::read_to_string("/proc/self/cgroup").await.ok()?;
    let path = membership
        .lines()
        .find_map(|line| line.strip_prefix("0::"))?;
    let control = PathBuf::from("/sys/fs/cgroup").join(path.trim_start_matches('/'));
    if control.file_name().and_then(|name| name.to_str()) != Some("control") {
        return None;
    }
    Some(
        control
            .parent()?
            .join("guests")
            .join(sandbox_id.to_string()),
    )
}

async fn captured_guest_cgroup_empty(leaf: Option<&std::path::Path>) -> bool {
    let Some(leaf) = leaf else {
        return false;
    };
    // A disappeared old version hierarchy is valid only while the real cgroup2
    // mount is still present. Permission and other inspection errors stay unknown.
    if !fs::try_exists("/sys/fs/cgroup/cgroup.controllers")
        .await
        .unwrap_or(false)
    {
        return false;
    }
    match fs::read_to_string(leaf.join("cgroup.events")).await {
        Ok(events) => events.lines().any(|line| line == "populated 0"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::symlink_metadata(leaf)
            .await
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::{HttpClient, HttpClientConfig};
    use httpmock::MockServer;

    fn api(server: &MockServer) -> ApiClient {
        ApiClient::new(
            HttpClient::new(HttpClientConfig {
                api_url: server.base_url(),
                vercel_bypass: None,
                client_session_id: "deferred-release-test".to_owned(),
            })
            .unwrap(),
            "runner-token".to_owned(),
        )
    }

    fn release_path(outbox: &DeferredReleaseOutbox, run_id: RunId) -> PathBuf {
        outbox.directory.join(format!("{run_id}-0.json"))
    }

    async fn write_destroyed_receipt(
        outbox: &DeferredReleaseOutbox,
        runner_id: Uuid,
        run_id: RunId,
        fence: DeferredSandboxFence,
    ) {
        outbox
            .write_release(&Receipt {
                run_id,
                runner_id,
                owner_epoch: Some(fence.owner_epoch),
                generation: Some(fence.generation),
                heartbeat_generation: None,
                proof: "destroyed".to_owned(),
            })
            .await
            .unwrap();
    }

    async fn seed_claimed_release(
        outbox: &DeferredReleaseOutbox,
        identity: &RunnerProcessIdentity,
        run_id: RunId,
        fence: DeferredSandboxFence,
    ) {
        outbox.begin_claim(run_id, identity).await.unwrap();
        outbox.accept_claim(run_id, Some(fence)).await.unwrap();
        write_destroyed_receipt(outbox, identity.runner_id(), run_id, fence).await;
    }

    #[tokio::test]
    async fn restarted_unstarted_claim_uses_original_process_identity() {
        let directory = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let client = api(&server);
        let run_id = RunId::new_v4();
        let original = RunnerProcessIdentity::new(Uuid::new_v4(), 1).unwrap();
        let current = RunnerProcessIdentity::new(original.runner_id(), 2).unwrap();
        let response = server.mock_async(|when, then| {
            when.method("POST").path(format!("/api/runners/jobs/{run_id}/release"))
                .json_body(serde_json::json!({ "runnerId": original.runner_id(), "heartbeatGeneration": 1, "proof": "not-started" }));
            then.status(200).json_body(serde_json::json!({ "outcome": "released" }));
        }).await;
        let path = directory.path().join("release");
        DeferredReleaseOutbox::new(path.clone())
            .begin_claim(run_id, &original)
            .await
            .unwrap();
        // A new reader has no old process's memory or callback.
        let recovered = DeferredReleaseOutbox::new(path);
        recovered.recover_claims(&client, &current).await;
        response.assert_calls_async(1).await;
        assert!(!recovered.claim_path(run_id).exists());
    }

    #[tokio::test]
    async fn failed_release_keeps_the_claim_barrier_until_acknowledged() {
        let directory = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let client = api(&server);
        let run_id = RunId::new_v4();
        let identity = RunnerProcessIdentity::new(Uuid::new_v4(), 1).unwrap();
        let outbox = DeferredReleaseOutbox::new(directory.path().join("release"));
        outbox.begin_claim(run_id, &identity).await.unwrap();
        outbox.actor_gone(run_id).await;
        let unavailable = server
            .mock_async(|when, then| {
                when.method("POST");
                then.status(503);
            })
            .await;
        outbox.recover_claims(&client, &identity).await;
        unavailable.assert_calls_async(1).await;
        assert_eq!(
            outbox
                .begin_claim(run_id, &identity)
                .await
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::AlreadyExists
        );
        unavailable.delete_async().await;
        let acknowledged = server
            .mock_async(|when, then| {
                when.method("POST");
                then.status(200)
                    .json_body(serde_json::json!({ "outcome": "released" }));
            })
            .await;
        outbox.flush_batch(&client).await;
        acknowledged.assert_calls_async(1).await;
        assert!(!outbox.claim_path(run_id).exists());
    }

    #[tokio::test]
    async fn unsupported_release_outcome_retains_claim_barrier() {
        let directory = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let client = api(&server);
        let run_id = RunId::new_v4();
        let identity = RunnerProcessIdentity::new(Uuid::new_v4(), 1).unwrap();
        let outbox = DeferredReleaseOutbox::new(directory.path().join("release"));
        outbox.begin_claim(run_id, &identity).await.unwrap();
        outbox.actor_gone(run_id).await;
        let ambiguous = server
            .mock_async(|when, then| {
                when.method("POST");
                then.status(200)
                    .json_body(serde_json::json!({ "released": false, "outcome": "future" }));
            })
            .await;
        outbox.recover_claims(&client, &identity).await;
        ambiguous.assert_calls_async(1).await;
        assert_eq!(
            outbox
                .begin_claim(run_id, &identity)
                .await
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::AlreadyExists
        );
    }

    #[tokio::test]
    async fn bounded_cursor_reaches_a_receipt_after_one_hundred_live_claims() {
        let directory = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let client = api(&server);
        let identity = RunnerProcessIdentity::new(Uuid::new_v4(), 2).unwrap();
        let old = RunnerProcessIdentity::new(identity.runner_id(), 1).unwrap();
        let outbox = DeferredReleaseOutbox::new(directory.path().join("release"));
        for _ in 0..101 {
            outbox
                .begin_claim(RunId::new_v4(), &identity)
                .await
                .unwrap();
        }
        let abandoned = RunId::new_v4();
        outbox.begin_claim(abandoned, &old).await.unwrap();
        let acknowledged = server
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/jobs/{abandoned}/release"));
                then.status(200)
                    .json_body(serde_json::json!({ "outcome": "released" }));
            })
            .await;
        for _ in 0..3 {
            outbox.recover_claims(&client, &identity).await;
        }
        acknowledged.assert_calls_async(1).await;
        assert!(!outbox.claim_path(abandoned).exists());
    }
    #[tokio::test]
    async fn another_version_recovers_only_after_the_original_owner_lock_is_gone() {
        let root = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let client = api(&server);
        let original = RunnerProcessIdentity::new(Uuid::new_v4(), 1).unwrap();
        let current = RunnerProcessIdentity::new(Uuid::new_v4(), 1).unwrap();
        let old = DeferredReleaseOutbox::new_shared(root.path().to_owned(), &original);
        let new = DeferredReleaseOutbox::new_shared(root.path().to_owned(), &current);
        let run_id = RunId::new_v4();
        old.begin_claim(run_id, &original).await.unwrap();
        let response = server.mock_async(|when, then| {
            when.method("POST").path(format!("/api/runners/jobs/{run_id}/release"))
                .json_body(serde_json::json!({ "runnerId": original.runner_id(), "heartbeatGeneration": 1, "proof": "not-started" }));
            then.status(200).json_body(serde_json::json!({ "outcome": "released" }));
        }).await;
        for _ in 0..3 {
            new.recover_foreign(&client, &current).await;
        }
        response.assert_calls_async(0).await;
        let claim_path = old.claim_path(run_id);
        drop(old);
        for _ in 0..3 {
            new.recover_foreign(&client, &current).await;
        }
        response.assert_calls_async(1).await;
        assert!(!claim_path.exists());
    }

    #[tokio::test]
    async fn another_version_retries_a_destroyed_receipt_after_failed_delivery() {
        let root = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let client = api(&server);
        let original = RunnerProcessIdentity::new(Uuid::new_v4(), 1).unwrap();
        let current = RunnerProcessIdentity::new(Uuid::new_v4(), 1).unwrap();
        let old = DeferredReleaseOutbox::new_shared(root.path().to_owned(), &original);
        let run_id = RunId::new_v4();
        let fence = DeferredSandboxFence {
            owner_epoch: 3,
            generation: 2,
        };
        old.begin_claim(run_id, &original).await.unwrap();
        old.accept_claim(run_id, Some(fence)).await.unwrap();
        let unavailable = server
            .mock_async(|when, then| {
                when.method("POST");
                then.status(503);
            })
            .await;
        old.record_and_flush(&client, original.runner_id(), run_id, fence)
            .await;
        unavailable.assert_calls_async(1).await;
        unavailable.delete_async().await;
        let response = server.mock_async(|when, then| {
            when.method("POST").path(format!("/api/runners/jobs/{run_id}/release"))
                .json_body(serde_json::json!({ "runnerId": original.runner_id(), "ownerEpoch": 3, "generation": 2, "proof": "destroyed" }));
            then.status(200).json_body(serde_json::json!({ "outcome": "released" }));
        }).await;
        let claim_path = old.claim_path(run_id);
        drop(old);
        let new = DeferredReleaseOutbox::new_shared(root.path().to_owned(), &current);
        for _ in 0..3 {
            new.recover_foreign(&client, &current).await;
        }
        response.assert_calls_async(1).await;
        assert!(!claim_path.exists());
    }

    #[tokio::test]
    async fn unresolved_receipt_does_not_starve_healthy_receipts_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let client = api(&server);
        let identity = RunnerProcessIdentity::new(Uuid::new_v4(), 1).unwrap();
        let fence = DeferredSandboxFence {
            owner_epoch: 3,
            generation: 2,
        };
        let path = directory.path().join("release");
        let writer = DeferredReleaseOutbox::new(path.clone());
        let unresolved_run = RunId::new_v4();
        let released_runs = [RunId::new_v4(), RunId::new_v4()];
        for run_id in std::iter::once(unresolved_run).chain(released_runs.iter().copied()) {
            seed_claimed_release(&writer, &identity, run_id, fence).await;
        }
        drop(writer);

        let unresolved = server
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/jobs/{unresolved_run}/release"));
                then.status(200)
                    .json_body(serde_json::json!({ "outcome": "inconclusive" }));
            })
            .await;
        let released = released_runs
            .iter()
            .map(|run_id| {
                server.mock(|when, then| {
                    when.method("POST")
                        .path(format!("/api/runners/jobs/{run_id}/release"));
                    then.status(200)
                        .json_body(serde_json::json!({ "outcome": "released" }));
                })
            })
            .collect::<Vec<_>>();

        let restarted = DeferredReleaseOutbox::new(path);
        restarted.flush_batch(&client).await;

        unresolved.assert_calls_async(1).await;
        for (run_id, acknowledgement) in released_runs.iter().zip(&released) {
            acknowledgement.assert_calls_async(1).await;
            assert!(!restarted.claim_path(*run_id).exists());
            assert!(!release_path(&restarted, *run_id).exists());
        }
        assert!(restarted.claim_path(unresolved_run).exists());
        assert!(release_path(&restarted, unresolved_run).exists());
        assert!(!directory.path().join("release.rejected").exists());

        unresolved.delete_async().await;
        let converged = server
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/jobs/{unresolved_run}/release"));
                then.status(200)
                    .json_body(serde_json::json!({ "outcome": "released" }));
            })
            .await;
        restarted.flush_batch(&client).await;
        converged.assert_calls_async(1).await;
        assert!(!restarted.claim_path(unresolved_run).exists());
        assert!(!release_path(&restarted, unresolved_run).exists());
    }

    #[tokio::test]
    async fn bounded_release_cursor_advances_past_one_scan_batch() {
        let directory = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let client = api(&server);
        let identity = RunnerProcessIdentity::new(Uuid::new_v4(), 1).unwrap();
        let fence = DeferredSandboxFence {
            owner_epoch: 3,
            generation: 2,
        };
        let outbox = DeferredReleaseOutbox::new(directory.path().join("release"));
        let mut run_ids = Vec::new();
        for _ in 0..=RELEASE_SCAN_LIMIT {
            let run_id = RunId::new_v4();
            seed_claimed_release(&outbox, &identity, run_id, fence).await;
            run_ids.push(run_id);
        }
        let unresolved = server
            .mock_async(|when, then| {
                when.method("POST");
                then.status(200)
                    .json_body(serde_json::json!({ "outcome": "inconclusive" }));
            })
            .await;

        let batches = (RELEASE_SCAN_LIMIT + RELEASE_REQUEST_LIMIT) / RELEASE_REQUEST_LIMIT;
        for _ in 0..batches {
            outbox.flush_batch(&client).await;
        }

        unresolved.assert_calls_async(RELEASE_SCAN_LIMIT + 1).await;
        for run_id in run_ids {
            assert!(outbox.claim_path(run_id).exists());
            assert!(release_path(&outbox, run_id).exists());
        }
    }

    #[tokio::test]
    async fn delivery_timeout_advances_to_unrelated_receipts() {
        let directory = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let client = api(&server);
        let identity = RunnerProcessIdentity::new(Uuid::new_v4(), 1).unwrap();
        let fence = DeferredSandboxFence {
            owner_epoch: 3,
            generation: 2,
        };
        let outbox = DeferredReleaseOutbox::new(directory.path().join("release"));
        let timed_out_run = RunId::new_v4();
        let released_runs = [RunId::new_v4(), RunId::new_v4()];
        for run_id in std::iter::once(timed_out_run).chain(released_runs.iter().copied()) {
            seed_claimed_release(&outbox, &identity, run_id, fence).await;
        }
        let timed_out = server
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/jobs/{timed_out_run}/release"));
                then.status(200)
                    .delay(Duration::from_secs(2))
                    .json_body(serde_json::json!({ "outcome": "released" }));
            })
            .await;
        let released = released_runs
            .iter()
            .map(|run_id| {
                server.mock(|when, then| {
                    when.method("POST")
                        .path(format!("/api/runners/jobs/{run_id}/release"));
                    then.status(200)
                        .json_body(serde_json::json!({ "outcome": "released" }));
                })
            })
            .collect::<Vec<_>>();

        for _ in 0..2 {
            outbox
                .flush_batch_with_timeout(&client, Duration::from_millis(500))
                .await;
            if released_runs
                .iter()
                .all(|run_id| !outbox.claim_path(*run_id).exists())
            {
                break;
            }
        }

        assert!(timed_out.calls_async().await >= 1);
        assert!(outbox.claim_path(timed_out_run).exists());
        assert!(release_path(&outbox, timed_out_run).exists());
        for (run_id, acknowledgement) in released_runs.iter().zip(&released) {
            acknowledgement.assert_calls_async(1).await;
            assert!(!outbox.claim_path(*run_id).exists());
            assert!(!release_path(&outbox, *run_id).exists());
        }
    }

    #[tokio::test]
    async fn concurrent_drains_do_not_duplicate_acknowledgements() {
        let directory = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let client = api(&server);
        let identity = RunnerProcessIdentity::new(Uuid::new_v4(), 1).unwrap();
        let fence = DeferredSandboxFence {
            owner_epoch: 3,
            generation: 2,
        };
        let outbox = DeferredReleaseOutbox::new(directory.path().join("release"));
        let unresolved_run = RunId::new_v4();
        let released_runs = [RunId::new_v4(), RunId::new_v4()];
        for run_id in std::iter::once(unresolved_run).chain(released_runs.iter().copied()) {
            seed_claimed_release(&outbox, &identity, run_id, fence).await;
        }
        let unresolved = server
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/jobs/{unresolved_run}/release"));
                then.status(200)
                    .json_body(serde_json::json!({ "outcome": "inconclusive" }));
            })
            .await;
        let released = released_runs
            .iter()
            .map(|run_id| {
                server.mock(|when, then| {
                    when.method("POST")
                        .path(format!("/api/runners/jobs/{run_id}/release"));
                    then.status(200)
                        .json_body(serde_json::json!({ "outcome": "released" }));
                })
            })
            .collect::<Vec<_>>();

        tokio::join!(
            outbox.flush_batch(&client),
            outbox.flush_batch(&client),
            outbox.flush_batch(&client),
            outbox.flush_batch(&client),
        );

        unresolved.assert_calls_async(1).await;
        assert!(outbox.claim_path(unresolved_run).exists());
        for (run_id, acknowledgement) in released_runs.iter().zip(&released) {
            acknowledgement.assert_calls_async(1).await;
            assert!(!outbox.claim_path(*run_id).exists());
        }
    }

    #[tokio::test]
    async fn foreign_recovery_keeps_its_release_cursor_between_heartbeats() {
        let root = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let client = api(&server);
        let original = RunnerProcessIdentity::new(Uuid::new_v4(), 1).unwrap();
        let current = RunnerProcessIdentity::new(Uuid::new_v4(), 1).unwrap();
        let old = DeferredReleaseOutbox::new_shared(root.path().to_owned(), &original);
        old.own_scope().await.unwrap();
        let fence = DeferredSandboxFence {
            owner_epoch: 3,
            generation: 2,
        };
        let mut run_ids = Vec::new();
        for _ in 0..=RELEASE_REQUEST_LIMIT {
            let run_id = RunId::new_v4();
            write_destroyed_receipt(&old, original.runner_id(), run_id, fence).await;
            run_ids.push(run_id);
        }
        let unresolved = server
            .mock_async(|when, then| {
                when.method("POST");
                then.status(200)
                    .json_body(serde_json::json!({ "outcome": "inconclusive" }));
            })
            .await;
        let current_outbox = DeferredReleaseOutbox::new_shared(root.path().to_owned(), &current);
        current_outbox.recover_foreign(&client, &current).await;
        unresolved.assert_calls_async(0).await;

        let old_directory = old.directory.clone();
        drop(old);
        // The busy probe consumed the root entry. One heartbeat closes that
        // scan, one sends the bounded batch, and one resumes its peer cursor.
        current_outbox.recover_foreign(&client, &current).await;
        current_outbox.recover_foreign(&client, &current).await;
        current_outbox.recover_foreign(&client, &current).await;

        unresolved
            .assert_calls_async(RELEASE_REQUEST_LIMIT + 1)
            .await;
        for run_id in run_ids {
            assert!(old_directory.join(format!("{run_id}-0.json")).exists());
        }
    }

    #[tokio::test]
    async fn release_proof_uses_the_captured_leaf_instead_of_the_observers_empty_scope() {
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("old");
        let observer = root.path().join("new");
        fs::create_dir_all(&original).await.unwrap();
        fs::create_dir_all(&observer).await.unwrap();
        fs::write(original.join("cgroup.events"), "populated 1\n")
            .await
            .unwrap();
        fs::write(observer.join("cgroup.events"), "populated 0\n")
            .await
            .unwrap();
        assert!(!captured_guest_cgroup_empty(Some(&original)).await);
        assert!(!captured_guest_cgroup_empty(None).await);
        fs::write(original.join("cgroup.events"), "populated 0\n")
            .await
            .unwrap();
        assert!(captured_guest_cgroup_empty(Some(&original)).await);
    }
}
