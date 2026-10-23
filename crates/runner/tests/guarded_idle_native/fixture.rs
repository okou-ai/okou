use std::{path::PathBuf, sync::Arc, time::Duration};

use runner_lifecycle::home_image_cache::{
    HomeImageCache, HomeImageLease, HomeImageLeaseIdentity, HomeImagePrepareRequest,
};
use runner_lifecycle::home_mount::ensure_home_drive_mounted;
use runner_lifecycle::host_memory_operations::{
    HostMemoryOperations, MemoryObservationSource, MemoryOperationError, MemoryOperationPolicy,
    ProcMemoryObservationSource,
};
use runner_lifecycle::host_memory_policy::HostMemoryBounds;
use runner_lifecycle::host_memory_pressure::HostPressurePolicy;
use runner_lifecycle::idle_pool::IdleRetirementEnvelope;
use runner_types::ids::RunId;
use sandbox::{
    EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecTermination, ResourceLimits, Sandbox, SandboxConfig,
    SandboxId,
};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use shell_quote::quote_shell_arg;

use super::TestResult;

pub use runner_types::profile::DEFAULT_PROFILE_DEF as PROFILE_DEFINITION;

pub const PROFILE: &str = runner_types::profile_name::DEFAULT_PROFILE;
pub const HOME_DISK_MB: u32 = PROFILE_DEFINITION.home_disk_mb;
pub const IMAGE_BYTES: u64 = HOME_DISK_MB as u64 * 1024 * 1024;
pub const PAYLOAD_BYTES: usize = 64 * 1024;
const HOME: &str = api_contracts::generated::constants::runners::paths::CANONICAL_GUEST_HOME_DIR;

pub fn home_payload(run_id: RunId) -> Vec<u8> {
    run_id
        .to_string()
        .into_bytes()
        .into_iter()
        .cycle()
        .take(PAYLOAD_BYTES)
        .collect()
}

/// Required current measurements for this test host; no production selector/default.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Inputs {
    host_total_bytes: u64,
    operating_floor_bytes: u64,
    cleanup_reserve_bytes: u64,
    critical_available_bytes: u64,
    recovery_available_bytes: u64,
    live_growth_bytes: u64,
    tail_growth_bytes: u64,
    replacement_preparation_bytes: u64,
    max_sample_age_millis: u64,
    max_operations: usize,
    max_cleanup_inflight: usize,
    pressure_sample_period_millis: u64,
    pressure_recovery_sustain_millis: u64,
    pressure_wave_cooldown_millis: u64,
    pressure_optional_start_interval_millis: u64,
    pressure_max_wave_entries: usize,
}

impl Inputs {
    pub fn load() -> TestResult<Self> {
        let path = PathBuf::from(std::env::var("OKOU_TEST_IDLE_MEMORY_POLICY")?);
        Ok(serde_json::from_slice(&std::fs::read(path)?)?)
    }

    pub fn operations(&self) -> Result<HostMemoryOperations, MemoryOperationError> {
        self.operations_with_source(Arc::new(ProcMemoryObservationSource))
    }

    pub fn operations_with_source(
        &self,
        source: Arc<dyn MemoryObservationSource>,
    ) -> Result<HostMemoryOperations, MemoryOperationError> {
        HostMemoryOperations::new(
            MemoryOperationPolicy {
                bounds: self.bounds(),
                max_sample_age: Duration::from_millis(self.max_sample_age_millis),
                max_operations: self.max_operations,
                max_cleanup_inflight: self.max_cleanup_inflight,
            },
            source,
        )
    }

    fn bounds(&self) -> HostMemoryBounds {
        HostMemoryBounds {
            host_total_bytes: self.host_total_bytes,
            operating_floor_bytes: self.operating_floor_bytes,
            cleanup_reserve_bytes: self.cleanup_reserve_bytes,
            critical_available_bytes: self.critical_available_bytes,
            recovery_available_bytes: self.recovery_available_bytes,
        }
    }

    pub fn pressure_policy(&self) -> TestResult<HostPressurePolicy> {
        Ok(HostPressurePolicy {
            bounds: self.bounds(),
            max_sample_age: Duration::from_millis(self.max_sample_age_millis),
            recovery_sustain: Duration::from_millis(self.pressure_recovery_sustain_millis),
            wave_cooldown: Duration::from_millis(self.pressure_wave_cooldown_millis),
            optional_start_interval: Duration::from_millis(
                self.pressure_optional_start_interval_millis,
            ),
            max_wave_entries: std::num::NonZeroUsize::new(self.pressure_max_wave_entries)
                .ok_or_else(|| std::io::Error::other("pressure wave bound must be positive"))?,
        })
    }

    pub fn pressure_sample_period(&self) -> Duration {
        Duration::from_millis(self.pressure_sample_period_millis)
    }

    pub fn envelope(&self) -> IdleRetirementEnvelope {
        IdleRetirementEnvelope {
            live_growth_bytes: self.live_growth_bytes,
            tail_growth_bytes: self.tail_growth_bytes,
        }
    }

    pub fn replacement_plan(
        &self,
    ) -> Result<runner_lifecycle::host_memory_operations::MemoryOperationPlan, MemoryOperationError>
    {
        if self.replacement_preparation_bytes == 0 {
            return Err(MemoryOperationError::UnsupportedGrowth);
        }
        Ok(
            runner_lifecycle::host_memory_operations::MemoryOperationPlan::Fresh {
                memory_mib: 4096,
                preparation_bytes: self.replacement_preparation_bytes,
            },
        )
    }

    pub fn preparation_bytes(&self) -> u64 {
        self.replacement_preparation_bytes
    }
}

pub async fn checkout(
    cache: &HomeImageCache,
    run_id: RunId,
    sandbox_id: SandboxId,
    reuse_key: &str,
    rootfs_hash: &str,
) -> HomeImageLease {
    cache
        .prepare(HomeImagePrepareRequest {
            identity: HomeImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: PROFILE,
                rootfs_hash,
                reuse_key: Some(reuse_key),
                working_dir:
                    api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR,
                image_size_bytes: IMAGE_BYTES,
            },
            home_drive_required: true,
        })
        .await
}

pub async fn sandbox_config(id: SandboxId, home: &mut HomeImageLease) -> TestResult<SandboxConfig> {
    Ok(SandboxConfig {
        id,
        resources: ResourceLimits {
            cpu_count: PROFILE_DEFINITION.vcpu,
            memory_mb: PROFILE_DEFINITION.memory_mb,
        },
        device_rate_limits: None,
        home_drive: home.home_drive_config().await?,
    })
}

pub(super) fn runtime_dir(run_id: RunId) -> TestResult<String> {
    Ok(
        guest_contracts::runtime_paths::run_dir_for_home(HOME, &run_id.to_string())?
            .to_string_lossy()
            .into_owned(),
    )
}

pub async fn prepare_guest(sandbox: &mut dyn Sandbox, run_id: RunId) -> TestResult<()> {
    start_guest(sandbox, run_id).await?;
    prepare_started_guest(sandbox, run_id).await
}

pub async fn start_guest(sandbox: &mut dyn Sandbox, run_id: RunId) -> TestResult<()> {
    sandbox.bind_run_control(&run_id.to_string())?;
    sandbox.start().await?;
    Ok(())
}

pub async fn prepare_started_guest(sandbox: &mut dyn Sandbox, run_id: RunId) -> TestResult<()> {
    ensure_home_drive_mounted(sandbox, run_id)
        .await
        .map_err(|failure| failure.error)?;
    let private = quote_shell_arg(&runtime_dir(run_id)?);
    exec(sandbox, &format!(
        "mkdir -p {private} && chmod 700 {private} && printf 'fixture private bytes' > {private}/fixture-private && chmod 600 {private}/fixture-private && printf 'native ordinary home bytes' > {HOME}/guarded-idle-ordinary"
    )).await?;
    sandbox
        .write_file(
            &format!("{HOME}/guarded-idle-payload"),
            &home_payload(run_id),
        )
        .await?;
    Ok(())
}

pub async fn verify_saved_guest(sandbox: &dyn Sandbox, previous_run: RunId) -> TestResult<()> {
    let private = quote_shell_arg(&runtime_dir(previous_run)?);
    let bytes = exec(
        sandbox,
        &format!("test ! -e {private} && cat {HOME}/guarded-idle-ordinary"),
    )
    .await?;
    assert_eq!(bytes, b"native ordinary home bytes");
    let hash = hex::encode(sha2::Sha256::digest(home_payload(previous_run)));
    let actual = exec(sandbox, &format!("test $(wc -c < {HOME}/guarded-idle-payload) -eq {PAYLOAD_BYTES} && sha256sum {HOME}/guarded-idle-payload")).await?;
    let actual = std::str::from_utf8(&actual)?;
    if actual.split_whitespace().next() != Some(hash.as_str()) {
        return Err(std::io::Error::other("native original home payload was not restored").into());
    }
    Ok(())
}

/// Observe original private history and every original payload byte after unpark.
pub async fn verify_speculative_guest(
    sandbox: &dyn Sandbox,
    original: RunId,
) -> TestResult<String> {
    let private = quote_shell_arg(&runtime_dir(original)?);
    let bytes = exec(
        sandbox,
        &format!("cat {private}/fixture-private && cat {HOME}/guarded-idle-ordinary"),
    )
    .await?;
    if bytes != b"fixture private bytesnative ordinary home bytes" {
        return Err(std::io::Error::other(
            "speculative rollback changed original private/home bytes",
        )
        .into());
    }
    let actual = exec(sandbox, &format!(
        "test $(wc -c < {HOME}/guarded-idle-payload) -eq {PAYLOAD_BYTES} && sha256sum {HOME}/guarded-idle-payload"
    )).await?;
    let actual = std::str::from_utf8(&actual)?
        .split_whitespace()
        .next()
        .ok_or_else(|| std::io::Error::other("speculative payload digest absent"))?;
    if actual != hex::encode(sha2::Sha256::digest(home_payload(original))) {
        return Err(std::io::Error::other(
            "speculative rollback changed complete original payload",
        )
        .into());
    }
    Ok(actual.into())
}

pub async fn exec(sandbox: &dyn Sandbox, cmd: &str) -> TestResult<Vec<u8>> {
    let result = sandbox
        .exec(&ExecRequest {
            cmd,
            timeout: Duration::from_secs(30),
            env: &[],
            sudo: true,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        })
        .await?;
    if result.termination != (ExecTermination::Exited { exit_code: 0 })
        || result.stdout_truncated
        || result.stderr_truncated
    {
        return Err(std::io::Error::other(format!(
            "native guest fixture command failed: {cmd}; termination={:?}; stdout_truncated={}; stderr_truncated={}; stderr={}",
            result.termination, result.stdout_truncated, result.stderr_truncated,
            String::from_utf8_lossy(&result.stderr),
        )).into());
    }
    Ok(result.stdout)
}
