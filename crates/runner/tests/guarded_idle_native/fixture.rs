use std::{path::PathBuf, sync::Arc, time::Duration};

use runner_lifecycle::home_image_cache::{
    HomeImageCache, HomeImageLease, HomeImageLeaseIdentity, HomeImagePrepareRequest,
};
use runner_lifecycle::home_mount::ensure_home_drive_mounted;
use runner_lifecycle::host_memory_operations::{
    HostMemoryOperations, MemoryOperationError, MemoryOperationPolicy, ProcMemoryObservationSource,
};
use runner_lifecycle::host_memory_policy::HostMemoryBounds;
use runner_lifecycle::idle_pool::IdleRetirementEnvelope;
use runner_types::ids::RunId;
use sandbox::{
    EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecTermination, ResourceLimits, Sandbox, SandboxConfig,
    SandboxId,
};
use serde::Deserialize;
use shell_quote::quote_shell_arg;

use super::TestResult;

pub const PROFILE: &str = "vm0/default";
const IMAGE_BYTES: u64 = 16384 * 1024 * 1024;
const HOME: &str = api_contracts::generated::constants::runners::paths::CANONICAL_GUEST_HOME_DIR;

/// Required current measurements for this test host; no production selector/default.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Inputs {
    host_total_bytes: u64,
    operating_floor_bytes: u64,
    cleanup_reserve_bytes: u64,
    critical_available_bytes: u64,
    recovery_available_bytes: u64,
    live_growth_bytes: u64,
    tail_growth_bytes: u64,
    max_sample_age_millis: u64,
    max_operations: usize,
    max_cleanup_inflight: usize,
}

impl Inputs {
    pub fn load() -> TestResult<Self> {
        let path = PathBuf::from(std::env::var("OKOU_TEST_IDLE_MEMORY_POLICY")?);
        Ok(serde_json::from_slice(&std::fs::read(path)?)?)
    }

    pub fn operations(&self) -> Result<HostMemoryOperations, MemoryOperationError> {
        HostMemoryOperations::new(
            MemoryOperationPolicy {
                bounds: HostMemoryBounds {
                    host_total_bytes: self.host_total_bytes,
                    operating_floor_bytes: self.operating_floor_bytes,
                    cleanup_reserve_bytes: self.cleanup_reserve_bytes,
                    critical_available_bytes: self.critical_available_bytes,
                    recovery_available_bytes: self.recovery_available_bytes,
                },
                max_sample_age: Duration::from_millis(self.max_sample_age_millis),
                max_operations: self.max_operations,
                max_cleanup_inflight: self.max_cleanup_inflight,
            },
            Arc::new(ProcMemoryObservationSource),
        )
    }

    pub fn envelope(&self) -> IdleRetirementEnvelope {
        IdleRetirementEnvelope {
            live_growth_bytes: self.live_growth_bytes,
            tail_growth_bytes: self.tail_growth_bytes,
        }
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

pub fn sandbox_config(id: SandboxId, home: &mut HomeImageLease) -> SandboxConfig {
    SandboxConfig {
        id,
        resources: ResourceLimits {
            cpu_count: 2,
            memory_mb: 4096,
        },
        device_rate_limits: None,
        home_drive: home.home_drive_config(),
    }
}

fn runtime_dir(run_id: RunId) -> TestResult<String> {
    Ok(
        guest_contracts::runtime_paths::run_dir_for_home(HOME, &run_id.to_string())?
            .to_string_lossy()
            .into_owned(),
    )
}

pub async fn prepare_guest(sandbox: &mut dyn Sandbox, run_id: RunId) -> TestResult<()> {
    sandbox.bind_run_control(&run_id.to_string())?;
    sandbox.start().await?;
    ensure_home_drive_mounted(sandbox, run_id)
        .await
        .map_err(|failure| failure.error)?;
    let private = quote_shell_arg(&runtime_dir(run_id)?);
    exec(sandbox, &format!(
        "mkdir -p {private} && chmod 700 {private} && printf 'fixture private bytes' > {private}/fixture-private && chmod 600 {private}/fixture-private && printf 'native ordinary home bytes' > {HOME}/guarded-idle-ordinary"
    )).await?;
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
    Ok(())
}

async fn exec(sandbox: &dyn Sandbox, cmd: &str) -> TestResult<Vec<u8>> {
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
        return Err(std::io::Error::other("native guest fixture command failed").into());
    }
    Ok(result.stdout)
}
