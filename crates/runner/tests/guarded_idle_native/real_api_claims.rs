//! Actual API/DB arbitration; each claimant retains its independent native owner.

use std::{
    collections::BTreeMap,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
};

use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_lifecycle::idle_pool::{IdlePoolIncoming, test_support::ParkedIdleCandidateBuilder};
use runner_provider::http::{HttpClient, HttpClientConfig};
use runner_provider::{
    ApiProvider, ApiProviderConfig, BuiltinFirewallCatalogCachePaths, JobCandidate, JobProvider,
    RunCancellationRegistry,
};
use runner_supervisor::pre_claim_admission::{
    GuardedSpeculativeAdmission, GuardedSpeculativeRollback,
};
use runner_types::types::ExecutionContext;
use sandbox::{Sandbox, SandboxBackingProcess};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::*;

/// A failed fixture retains physical/data/authorization custody for diagnosis.
struct RetainOnFailure<T: Send + 'static> {
    value: Option<T>,
    proof: Arc<evidence::Case>,
}

impl<T: Send + 'static> RetainOnFailure<T> {
    fn new(value: T, proof: &Arc<evidence::Case>) -> Self {
        Self {
            value: Some(value),
            proof: proof.clone(),
        }
    }
    fn get_mut(&mut self) -> TestResult<&mut T> {
        self.value
            .as_mut()
            .ok_or_else(|| io::Error::other("fixture custody has already transferred").into())
    }
    fn transfer(mut self) -> TestResult<T> {
        self.value
            .take()
            .ok_or_else(|| io::Error::other("fixture custody already transferred").into())
    }
}

impl<T: Send + 'static> Drop for RetainOnFailure<T> {
    fn drop(&mut self) {
        if let Some(value) = self.value.take() {
            self.proof.retain(value);
        }
    }
}

struct Winner {
    claim: ExecutionContext,
    auth: Option<runner_provider::CompletionAuth>,
    _active_inputs: Option<runner_provider::ActiveInputSource>,
    parts: runner_lifecycle::idle_pool::ReusableIdleSandboxParts,
    lease: runner_lifecycle::resource_budget::BudgetLease,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    source_sha: String,
    api_url: String,
    token: String,
    group: String,
    order: String,
    cases: BTreeMap<String, Scenario>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Scenario {
    original_run_id: RunId,
    claim_run_id: RunId,
    reuse_key: String,
    runner_ids: [uuid::Uuid; 2],
    control_directory: PathBuf,
    predecessor_context: ExecutionContext,
    original_completed_at: String,
}

pub struct Input {
    pub original_run_id: RunId,
    pub reuse_key: String,
    pub predecessor_context: ExecutionContext,
    pub original_completed_at: String,
    run: RunId,
    role: &'static str,
    runner: RunnerProcessIdentity,
    api_url: String,
    token: String,
    group: String,
    control: PathBuf,
    order: String,
}

fn manifest() -> TestResult<Manifest> {
    let path = PathBuf::from(std::env::var("OKOU_TEST_REAL_API_MANIFEST")?);
    let metadata = std::fs::symlink_metadata(&path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 1024 * 1024 {
        return Err(io::Error::other("real API manifest must be a bounded regular file").into());
    }
    let value: Manifest = serde_json::from_slice(&std::fs::read(path)?)?;
    let url = reqwest::Url::parse(&value.api_url)?;
    if value.source_sha != evidence::compiled_source()?
        || url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(value.order.as_str(), "a" | "b" | "both")
        || !value.token.starts_with("vm0_official_")
        || value.cases.keys().map(String::as_str).collect::<Vec<_>>() != ["fresh", "snapshot"]
    {
        return Err(
            io::Error::other("real API inputs changed their isolated source/authority").into(),
        );
    }
    Ok(value)
}

pub fn order() -> TestResult<String> {
    Ok(manifest()?.order)
}

pub fn release_failed_gates() -> TestResult<()> {
    for case in manifest()?.cases.values() {
        std::fs::write(
            case.control_directory.join("failed.ready"),
            b"native owner failed",
        )?;
    }
    Ok(())
}

impl Input {
    pub fn load(second: bool, restored: bool) -> TestResult<Self> {
        let mut manifest = manifest()?;
        let case = manifest
            .cases
            .remove(if restored { "snapshot" } else { "fresh" })
            .ok_or_else(|| io::Error::other("native API mode missing"))?;
        if case.runner_ids[0] == case.runner_ids[1]
            || case.original_run_id == case.claim_run_id
            || case.predecessor_context.run_id != case.original_run_id
            || case.reuse_key.is_empty()
            || !std::fs::symlink_metadata(&case.control_directory)?.is_dir()
        {
            return Err(
                io::Error::other("native claim original identities are inconsistent").into(),
            );
        }
        let [first_runner, second_runner] = case.runner_ids;
        Ok(Self {
            original_run_id: case.original_run_id,
            reuse_key: case.reuse_key,
            predecessor_context: case.predecessor_context,
            original_completed_at: case.original_completed_at,
            run: case.claim_run_id,
            role: if second { "b" } else { "a" },
            runner: RunnerProcessIdentity::new(
                if second { second_runner } else { first_runner },
                1,
            )?,
            api_url: manifest.api_url,
            token: manifest.token,
            group: manifest.group,
            control: case.control_directory,
            order: manifest.order,
        })
    }
}

async fn complete_task(
    input: &Input,
    context: &ExecutionContext,
    sandbox: &dyn Sandbox,
) -> TestResult<Value> {
    if context.run_id != input.run || context.reuse_key.as_deref() != Some(input.reuse_key.as_str())
    {
        return Err(io::Error::other("actual API winner changed target identity").into());
    }
    fixture::verify_speculative_guest(sandbox, input.original_run_id).await?;
    let marker = json!({"run_id":input.run,"runner_id":input.runner.runner_id(),"role":input.role,"source_sha":evidence::compiled_source()?});
    let text = serde_json::to_string(&marker)?;
    let script = format!(
        "import pathlib; p=pathlib.Path('/home/user/native-claim-task.json'); f=p.open('x'); f.write({text:?}); f.close(); print(p.read_text())"
    );
    let bytes = fixture::exec(
        sandbox,
        &format!("python3 -I -c {}", shell_quote::quote_shell_arg(&script)),
    )
    .await?;
    if serde_json::from_slice::<Value>(&bytes)? != marker {
        return Err(io::Error::other("native winner task did not execute exactly once").into());
    }
    let client = reqwest::Client::new();
    let events = json!({"runId":input.run,"events":[
        {"type":"system","subtype":"init","session_id":input.run,"sequenceNumber":0},
        {"type":"assistant","sequenceNumber":1,"message":{"content":[{"type":"text","text":text}]}},
        {"type":"result","sequenceNumber":2,"result":text}
    ]});
    for (path, body) in [
        ("/api/webhooks/agent/events", events),
        (
            "/api/webhooks/agent/complete",
            json!({"runId":input.run,"exitCode":0,"lastEventSequence":2,
            "completion":{"cliAgentType":context.cli_agent_type,"cliAgentSessionId":input.run,
                "cliAgentSessionHistoryDisposition":"native_only"}}),
        ),
    ] {
        let response = client
            .post(format!("{}{path}", input.api_url))
            .bearer_auth(&context.sandbox_token)
            .json(&body)
            .send()
            .await?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(io::Error::other(format!(
                "real native callback failed: {}",
                response.status()
            ))
            .into());
        }
        let _: Value = response.json().await?;
    }
    Ok(marker)
}

pub async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    proof: &Arc<evidence::Case>,
    directory: &Path,
    backing: Arc<dyn SandboxBackingProcess>,
    input: &Input,
) -> TestResult<()> {
    use super::cleanup_progress::{accounting, pending, settled};
    use runner_lifecycle::guest_timezone::GuestTimezoneIntent;

    let mut custody = RetainOnFailure::new(context, proof);
    let context = custody.get_mut()?;

    context
        .status
        .set_idle_snapshot(context.pool.lock().await.status_snapshot())
        .await?;
    let path = directory.join("status.json");
    let io_gate = Arc::new(foreground_io::Gate::new()?);
    proof.install_foreground_io(io_gate.clone())?;
    let mut probe = foreground_probe::Probe::new(
        &context.pool,
        &context.budget,
        directory,
        &context.rootfs_hash,
    )
    .await?;
    let provider: Arc<dyn JobProvider> = ApiProvider::new(
        HttpClient::new(HttpClientConfig {
            api_url: input.api_url.clone(),
            vercel_bypass: None,
            client_session_id: format!("native-real-api-{}", input.role),
            runner_version: env!("CARGO_PKG_VERSION"),
        })?,
        input.token.clone(),
        ApiProviderConfig {
            ably_side_message_handler: None,
            runner_identity: input.runner,
            runner_hostname: Some(format!("native-real-api-{}", input.role)),
            group: input.group.clone(),
            supported_profiles: vec![fixture::PROFILE.into()],
            installed_okou_cli: None,
        },
        BuiltinFirewallCatalogCachePaths {
            cache_path: directory.join("real-firewall.json"),
            lock_path: directory.join("real-firewall.lock"),
        },
        CancellationToken::new(),
        RunCancellationRegistry::new(),
    );
    let reservation = context
        .pool
        .lock()
        .await
        .take_reserved(&context.reuse_key)
        .ok_or_else(|| io::Error::other("real claimant lost original reservation"))?;
    let mut admission = match GuardedSpeculativeAdmission::new(reservation) {
        Ok(value) => value,
        Err(owner) => {
            proof.retain(owner);
            return Err(io::Error::other("real claimant received a running owner").into());
        }
    };
    let outcome: TestResult<()> = async {
        let candidate = JobCandidate::new(input.run, fixture::PROFILE.into())
            .with_reuse_key(Some(input.reuse_key.clone())).with_history_generation_run_id(Some(input.original_run_id));
        let mut prepare = Box::pin(admission.prepare_and_claim(provider.clone(), candidate, &context.tracker));
        let mut prepared = None;
        pending(prepare.as_mut(), &mut prepared).await?;
        proof.require_full_lease()?;
        let pool_hold = context.pool.lock().await;
        let pool_held_ns = evidence::clocks()?.0;
        probe.request()?;
        {
            let heartbeat = probe.complete();tokio::pin!(heartbeat);
            if futures_util::poll!(&mut heartbeat).is_ready() {
                return Err(io::Error::other("real claimant heartbeat ignored its held pool").into());
            }
        }
        let heartbeat_pending_ns = evidence::clocks()?.0;
        let observer = foreground_probe::observe().await?;
        let pool_released_ns = evidence::clocks()?.0;
        drop(pool_hold);
        let heartbeat = probe.complete().await?;
        proof.real_claim_witness("claim_wait_progress",json!({"run_id":input.run,"original_run_id":input.original_run_id,
            "runner_identity":input.runner,"role":input.role,"order":input.order,"heartbeat":heartbeat,"observer":observer,
            "pool_held_ns":pool_held_ns,"heartbeat_pending_ns":heartbeat_pending_ns,
            "pool_released_ns":pool_released_ns,"heartbeat_polled_pending":true,
            "preparation_polled_pending":true,"original_full_lease_active":true,"allocated":context.budget.allocated()}))?;
        let mut ready = OpenOptions::new().write(true).create_new(true).open(input.control.join(format!("{}.ready",input.role)))?;
        ready.write_all(b"accepted native owner and independent progress\n")?;
        ready.sync_all()?;
        let prepared = match prepared {Some(result)=>result,None=>prepare.as_mut().await};
        drop(prepare);
        prepared.map_err(io::Error::other)?;
        proof.require_full_lease()?;
        if admission.preparation_error().is_some() { return Err(io::Error::other("real Guest preparation failed").into()); }
        let won = match admission.commit() {
            Ok((claimed, owner, lease)) => {
                let (claim, auth, active_inputs) = claimed.into_parts();
                let mut winner = RetainOnFailure::new(Winner {claim,auth:Some(auth),_active_inputs:active_inputs,parts:owner.into_parts(),lease},proof);
                let held=winner.get_mut()?;
                let marker = complete_task(input, &held.claim, &*held.parts.sandbox).await?;
                let id=held.parts.sandbox.id().parse()?;
                let auth=held.auth.take().ok_or_else(||io::Error::other("winner completion authority consumed"))?;
                provider.complete(runner_types::types::CompleteRequest {run_id:input.run,exit_code:0,
                    failure_reason:None,error:None,sandbox_id:Some(id)},auth).await;
                let claim=&held.claim;
                proof.real_claim_witness("winner_executed",json!({"marker":marker,"runner_identity":input.runner,
                    "returned_run_id":claim.run_id,"returned_reuse_key":claim.reuse_key,
                    "completion_authority_sha256":continuation::digest(claim.sandbox_token.as_bytes()),
                    "original_full_lease_active":true,"allocated":context.budget.allocated()}))?;
                if held.parts.sandbox.park().await? != SandboxParkOutcome::Reusable {
                    return Err(io::Error::other("winner did not physically repark for required saving").into());
                }
                if held.parts.home_promotion.is_none() {return Err(io::Error::other("winner lost required promotion").into());}
                let Winner {claim,mut parts,lease,..}=winner.transfer()?;
                let promotion=parts.home_promotion.take().ok_or_else(||io::Error::other("checked winner promotion absent"))?;
                let candidate = ParkedIdleCandidateBuilder::new(&input.reuse_key,lease).with_sandbox(parts.sandbox)
                    .with_source_run_id(claim.run_id)
                    .with_factory(context.factory.clone()).with_sandbox_id(id).with_profile_name(fixture::PROFILE)
                    .with_rootfs_hash(&context.rootfs_hash).with_history_generation_run_id(input.original_run_id)
                    .with_last_completed_at(input.original_completed_at.clone()).with_home_promotion(promotion)
                    .with_storage_fingerprints(parts.storage_fingerprints)
                    .with_guest_timezone_intent(GuestTimezoneIntent::from_context(&claim)).build();
                let mut candidate=RetainOnFailure::new(candidate,proof);
                candidate.get_mut()?.capture_retirement_backing()?;
                let mut incoming = RetainOnFailure::new(IdlePoolIncoming::park(candidate.transfer()?),proof);
                incoming.get_mut()?.capture_backing()?;
                let insertion = context.tracker.insert_pool_entry(&context.pool,incoming.get_mut()?,&context.operations,inputs.envelope(),"native_real_claim_winner_repark").await?;
                if let Some(task)=insertion.retirement {proof.retain(task);return Err(io::Error::other("winner replaced unrelated inventory").into());}
                if let Some(owner)=incoming.transfer()?.into_owner(){proof.retain(owner);return Err(io::Error::other("winner insertion did not accept ownership").into());}
                context.status.set_idle_snapshot(insertion.snapshot).await?;
                true
            }
            Err(_) => {
                if let Some(claimed)=admission.take_claim_response()? {proof.retain(claimed);return Err(io::Error::other("successful claim could not activate its prepared resource").into());}
                let restored = admission.rollback(&context.pool,&context.tracker,&context.status,&context.operations,inputs.envelope(),fixture::IMAGE_BYTES).await?;
                let GuardedSpeculativeRollback::Restored(restored)=restored else {return Err(io::Error::other("loser did not restore its original native owner").into());};
                if let Some(task)=restored.retirement {proof.retain(task);return Err(io::Error::other("loser replaced unrelated inventory").into());}
                proof.real_claim_witness("loser_restored",json!({"run_id":input.run,"runner_identity":input.runner,
                    "revision":restored.snapshot.revision,
                    "published_status":serde_json::from_slice::<Value>(&tokio::fs::read(&path).await?)?,
                    "original_full_lease_active":true,"allocated":context.budget.allocated()}))?;
                false
            }
        };
        std::fs::write(directory.join("real-claim-result.json"),serde_json::to_vec(&json!({"won":won,"run_id":input.run,"role":input.role}))?)?;
        claim_loss::save(claim_loss::Saving {context,inputs,proof,gate:&io_gate,probe:&mut probe,path:&path,backing:&backing,witness:evidence::Case::real_claim_witness}).await
    }.await;
    let released = io_gate.release();
    let failure_gate = if outcome.is_err() {
        proof.retain(admission);
        // Only opens fixture-owned transport gates; the API still chooses outcomes.
        std::fs::write(input.control.join("failed.ready"), b"native owner failed")
    } else {
        Ok(())
    };
    context.tracker.close_and_wait().await;
    let operations = context.operations.close_and_wait().await;
    provider.shutdown().await;
    let heartbeat = probe.finish().await;
    released?;
    heartbeat?;
    failure_gate?;
    outcome?;
    let operations = operations?;
    settled(&operations)?;
    let activations = context.tracker.take_retained_activation_owners()?;
    let finalizing = context.tracker.take_retained_finalizing_owners()?;
    if !activations.is_empty() || !finalizing.is_empty() {
        proof.retain((activations, finalizing));
        return Err(io::Error::other("real claim retained unresolved owners").into());
    }
    proof.real_claim_witness(
        "producers_joined",
        json!({"run_id":input.run,"role":input.role,
        "claim_joined":true,"provider_joined":true,"heartbeat_joined":true,"saving_joined":true,
        "allocated":context.budget.allocated(),"accounting":accounting(&operations)}),
    )?;
    custody.transfer()?;
    Ok(())
}

pub async fn verify_saved(
    sandbox: &dyn Sandbox,
    directory: &Path,
    input: &Input,
    proof: &evidence::Case,
) -> TestResult<()> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct SavedResult {
        run_id: RunId,
        role: String,
        won: bool,
    }
    let result: SavedResult =
        serde_json::from_slice(&std::fs::read(directory.join("real-claim-result.json"))?)?;
    if result.run_id != input.run || result.role != input.role {
        return Err(io::Error::other("saved claim result changed its original identity").into());
    }
    let marker = if result.won {
        let actual = fixture::exec(sandbox, "cat /home/user/native-claim-task.json").await?;
        let actual: Value = serde_json::from_slice(&actual)?;
        if actual
            != json!({"run_id":input.run,"runner_id":input.runner.runner_id(),"role":input.role,"source_sha":evidence::compiled_source()?})
        {
            return Err(io::Error::other("saved winner task identity changed").into());
        }
        actual
    } else {
        fixture::exec(sandbox, "test ! -e /home/user/native-claim-task.json").await?;
        Value::Null
    };
    proof.real_claim_witness(
        "saved_task_verified",
        json!({"run_id":input.run,"role":input.role,
        "won":result.won,"marker":marker,"original_data_verified":true}),
    )?;
    Ok(())
}
