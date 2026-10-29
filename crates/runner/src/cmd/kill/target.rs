use std::path::PathBuf;

use sandbox::SandboxControlTarget;

use crate::error::{RunnerError, RunnerResult};
use crate::run_resolution;
use runner_host::paths::HomePaths;
use runner_host::process::{
    self, DiscoveredProcesses, FirecrackerProcessInfo, ProcfsProcessGeneration,
};

use super::KillArgs;

#[derive(Debug)]
pub(super) enum RediscoverTargetError {
    Resolve(String),
    Changed(String),
}

impl RediscoverTargetError {
    pub(super) fn allows_disappeared_orphan_cleanup(&self) -> bool {
        matches!(self, Self::Resolve(_))
    }
}

impl std::fmt::Display for RediscoverTargetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Resolve(error) | Self::Changed(error) => f.write_str(error),
        }
    }
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct KillTarget {
    pub(super) pid: u32,
    pub(super) ppid: Option<u32>,
    pub(super) run_id: Option<String>,
    pub(super) sandbox_id: String,
    pub(super) base_dir: Option<PathBuf>,
    pub(super) generation: Option<ProcfsProcessGeneration>,
}

impl From<&FirecrackerProcessInfo> for KillTarget {
    fn from(process: &FirecrackerProcessInfo) -> Self {
        Self {
            pid: process.pid,
            ppid: process.ppid,
            run_id: None,
            sandbox_id: process.sandbox_id.clone(),
            base_dir: process.base_dir.clone(),
            generation: process.generation,
        }
    }
}

impl KillTarget {
    pub(super) fn control_target(&self) -> SandboxControlTarget {
        self.run_id.as_ref().map_or_else(
            || SandboxControlTarget::sandbox(&self.sandbox_id),
            |run_id| SandboxControlTarget::run(run_id, &self.sandbox_id),
        )
    }
}

struct ResolvedProcessTarget<'a> {
    process: &'a FirecrackerProcessInfo,
    run_id: Option<String>,
}

pub(super) struct ResolvedKillTarget {
    pub(super) target: KillTarget,
    pub(super) runner_pids: Vec<u32>,
}

struct LiveRunnerContext {
    runner_pids: Vec<u32>,
    run_mappings: Option<run_resolution::ActiveRunMappings>,
}

pub(super) async fn discover_and_resolve_target(
    args: &KillArgs,
) -> RunnerResult<ResolvedKillTarget> {
    let home = HomePaths::new()?;
    let live_runner_context = live_runner_context(&home, args.run.is_some()).await?;
    let discovered = process::discover_all().await;
    let resolved = resolve_target(args, &discovered, live_runner_context.run_mappings.as_ref())?;
    let mut target = KillTarget::from(resolved.process);
    target.run_id = resolved.run_id;

    Ok(ResolvedKillTarget {
        target,
        runner_pids: live_runner_context.runner_pids,
    })
}

async fn live_runner_context(
    home: &HomePaths,
    include_run_mappings: bool,
) -> RunnerResult<LiveRunnerContext> {
    let live_runners = crate::live_runner_instances::try_list(home).await?;
    let runner_pids = live_runners.iter().map(|runner| runner.pid).collect();
    let run_mappings = if include_run_mappings {
        Some(run_resolution::collect_active_run_mappings(&live_runners).await)
    } else {
        None
    };
    Ok(LiveRunnerContext {
        runner_pids,
        run_mappings,
    })
}

fn resolve_target<'a>(
    args: &KillArgs,
    discovered: &'a DiscoveredProcesses,
    run_mappings: Option<&run_resolution::ActiveRunMappings>,
) -> RunnerResult<ResolvedProcessTarget<'a>> {
    if let Some(ref run_id) = args.run {
        let mappings = run_mappings.ok_or_else(|| {
            RunnerError::Config("run mappings are required when resolving --run".into())
        })?;
        let resolved = resolve_by_run_id(run_id, mappings, &discovered.firecrackers)?;
        return Ok(ResolvedProcessTarget {
            process: resolved.process,
            run_id: Some(resolved.run_id),
        });
    }

    if let Some(ref sandbox_id) = args.sandbox {
        return Ok(ResolvedProcessTarget {
            process: resolve_by_sandbox_id(sandbox_id, &discovered.firecrackers)?,
            run_id: None,
        });
    }

    Err(RunnerError::Config(
        "one of --run or --sandbox is required".into(),
    ))
}

pub(super) async fn rediscover_same_target(
    args: &KillArgs,
    initial: &KillTarget,
) -> Result<ResolvedKillTarget, RediscoverTargetError> {
    let current = discover_and_resolve_target(args)
        .await
        .map_err(|error| RediscoverTargetError::Resolve(error.to_string()))?;
    ensure_same_target_after_confirmation(args, initial, &current.target)
        .map_err(RediscoverTargetError::Changed)?;
    Ok(current)
}

pub(super) async fn rediscover_same_sandbox_process(
    expected: &KillTarget,
) -> Result<ResolvedKillTarget, RediscoverTargetError> {
    let home =
        HomePaths::new().map_err(|error| RediscoverTargetError::Resolve(error.to_string()))?;
    let live_runner_context = live_runner_context(&home, false)
        .await
        .map_err(|error| RediscoverTargetError::Resolve(error.to_string()))?;
    let discovered = process::discover_all().await;
    let target = resolve_same_sandbox_process(expected, &discovered)?;

    Ok(ResolvedKillTarget {
        target,
        runner_pids: live_runner_context.runner_pids,
    })
}

fn resolve_same_sandbox_process(
    expected: &KillTarget,
    discovered: &DiscoveredProcesses,
) -> Result<KillTarget, RediscoverTargetError> {
    let matches: Vec<&FirecrackerProcessInfo> = discovered
        .firecrackers
        .iter()
        .filter(|process| process.sandbox_id == expected.sandbox_id)
        .collect();
    let process = match matches.as_slice() {
        [single] => *single,
        [] => {
            return Err(RediscoverTargetError::Resolve(format!(
                "sandbox '{}' no longer has a firecracker process",
                expected.sandbox_id
            )));
        }
        _ => {
            let pids: Vec<String> = matches
                .iter()
                .map(|process| process.pid.to_string())
                .collect();
            return Err(RediscoverTargetError::Resolve(format!(
                "sandbox '{}' has multiple firecracker processes: PID {}",
                expected.sandbox_id,
                pids.join(", ")
            )));
        }
    };
    let target = KillTarget::from(process);
    let target = KillTarget {
        run_id: expected.run_id.clone(),
        ..target
    };
    if !same_firecracker_identity(expected, &target) {
        return Err(RediscoverTargetError::Changed(
            "sandbox process already exited or changed identity".into(),
        ));
    }
    Ok(target)
}

fn ensure_same_target_after_confirmation(
    args: &KillArgs,
    initial: &KillTarget,
    current: &KillTarget,
) -> Result<(), String> {
    if args.run.is_some() {
        match (&initial.run_id, &current.run_id) {
            (Some(initial_run), Some(current_run)) if initial_run == current_run => {}
            (Some(initial_run), Some(current_run)) => {
                return Err(format!(
                    "run target changed from run '{}' to '{}'",
                    initial_run, current_run
                ));
            }
            _ => {
                return Err("run target could not be verified by active run identity".into());
            }
        }
        if current.sandbox_id != initial.sandbox_id {
            return Err(format!(
                "run target changed from sandbox '{}' to '{}'",
                initial.sandbox_id, current.sandbox_id
            ));
        }
        return Ok(());
    }

    if args.sandbox.is_some() {
        if current.sandbox_id != initial.sandbox_id {
            return Err(format!(
                "sandbox target changed from '{}' to '{}'",
                initial.sandbox_id, current.sandbox_id
            ));
        }
        if !same_firecracker_identity(initial, current) {
            return Err("sandbox process already exited or changed identity".into());
        }
        return Ok(());
    }

    Err("one of --run or --sandbox is required".into())
}

fn same_firecracker_identity(initial: &KillTarget, current: &KillTarget) -> bool {
    initial.pid == current.pid
        && initial.sandbox_id == current.sandbox_id
        && initial.base_dir == current.base_dir
        && matches!(
            (initial.generation, current.generation),
            (Some(initial), Some(current)) if initial == current
        )
}

/// Resolve a `--run` prefix to a single Firecracker process.
///
/// Maps run_id → sandbox_id via the provided mappings, then locates the FC
/// by sandbox_id. The caller is responsible for collecting `mappings` via
/// [`run_resolution::collect_active_run_mappings`] so this function stays pure and
/// testable.
struct ResolvedRunProcess<'a> {
    run_id: String,
    process: &'a FirecrackerProcessInfo,
}

fn resolve_by_run_id<'a>(
    input: &str,
    mappings: &run_resolution::ActiveRunMappings,
    firecrackers: &'a [FirecrackerProcessInfo],
) -> RunnerResult<ResolvedRunProcess<'a>> {
    let mapping = run_resolution::resolve_run_mapping(input, mappings)?;
    let fc_matches: Vec<&FirecrackerProcessInfo> = firecrackers
        .iter()
        .filter(|fc| fc.sandbox_id == mapping.sandbox_id)
        .collect();
    match fc_matches.as_slice() {
        [] => Err(RunnerError::Config(format!(
            "run '{input}' maps to sandbox '{}' but no firecracker process for it",
            mapping.sandbox_id
        ))),
        [single] => Ok(ResolvedRunProcess {
            run_id: mapping.run_id,
            process: single,
        }),
        _ => {
            let pids: Vec<String> = fc_matches.iter().map(|fc| fc.pid.to_string()).collect();
            let pid_list = pids.join(", ");
            Err(RunnerError::Config(format!(
                "run '{input}' maps to sandbox '{sandbox_id}' but multiple firecracker processes match it: PID {pid_list}",
                sandbox_id = mapping.sandbox_id,
            )))
        }
    }
}

/// Resolve a `--sandbox` prefix to a single Firecracker process.
///
/// Matches directly against running FC processes by sandbox_id prefix.
fn resolve_by_sandbox_id<'a>(
    input: &str,
    firecrackers: &'a [FirecrackerProcessInfo],
) -> RunnerResult<&'a FirecrackerProcessInfo> {
    if input.is_empty() {
        return Err(RunnerError::Config("sandbox id must not be empty".into()));
    }
    let fc_matches: Vec<&FirecrackerProcessInfo> = firecrackers
        .iter()
        .filter(|fc| fc.sandbox_id.starts_with(input))
        .collect();
    match fc_matches.as_slice() {
        [] => Err(RunnerError::Config(format!(
            "no running sandbox matches '{input}'"
        ))),
        [single] => Ok(single),
        _ => {
            let ids: Vec<&str> = fc_matches.iter().map(|fc| fc.sandbox_id.as_str()).collect();
            Err(RunnerError::Config(format!(
                "ambiguous sandbox prefix '{input}', matches: {}",
                ids.join(", ")
            )))
        }
    }
}

#[cfg(test)]
mod tests;
