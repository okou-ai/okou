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
mod tests {
    use super::super::KillArgs;
    use super::super::test_support::{
        discovered_with_firecrackers, make_fc, make_fc_from_target, make_target,
    };
    use super::*;

    fn make_run_target(pid: u32, run_id: &str, sandbox_id: &str) -> KillTarget {
        KillTarget {
            run_id: Some(run_id.into()),
            ..make_target(pid, sandbox_id)
        }
    }

    /// Build an `ActiveRunMappings` from a vec of `(run_id, sandbox_id)` pairs
    /// with zero read failures — the common test case.
    fn mappings(entries: Vec<(String, String)>) -> run_resolution::ActiveRunMappings {
        let total = if entries.is_empty() { 0 } else { 1 };
        run_resolution::ActiveRunMappings {
            entries,
            runners_total: total,
            runners_failed: 0,
        }
    }

    #[tokio::test]
    async fn live_runner_context_uses_registry_pids_for_orphan_owners() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let handle = crate::live_runner_instances::publish(
            &home,
            crate::live_runner_instances::LiveRunnerInstanceMetadata {
                config_path: dir.path().join("benchmark.yaml"),
                base_dir: dir.path().join("benchmark-base"),
                runner_group: "vm0/test".into(),
                subcommand: "benchmark".into(),
            },
        )
        .await
        .unwrap();

        let context = live_runner_context(&home, false).await.unwrap();

        assert_eq!(context.runner_pids, vec![std::process::id()]);
        assert!(context.run_mappings.is_none());
        assert!(handle.remove_if_current().await.unwrap());
    }

    #[tokio::test]
    async fn live_runner_context_fails_when_registry_cannot_be_validated() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        std::fs::create_dir_all(dir.path().join("vm0-runner")).unwrap();
        std::fs::write(home.live_runner_instances_dir(), b"not a directory").unwrap();

        let error = match live_runner_context(&home, false).await {
            Ok(_) => panic!("expected unreadable registry to fail"),
            Err(error) => error,
        };

        assert!(
            error.to_string().contains("validate live runner instances"),
            "{error}"
        );
    }

    // -- resolve_by_run_id (run_id → FC lookup via status + FC list) ---------

    #[test]
    fn by_run_id_mapped_sandbox_not_running() {
        let status = mappings(vec![("run-x-1".into(), "sandbox-gone".into())]);
        let fcs: Vec<FirecrackerProcessInfo> = vec![];
        let Err(e) = resolve_by_run_id("run-x", &status, &fcs) else {
            panic!("expected error when sandbox has no firecracker process");
        };
        let msg = e.to_string();
        assert!(msg.contains("run 'run-x'"), "{msg}");
        assert!(msg.contains("sandbox-gone"), "{msg}");
        assert!(msg.contains("no firecracker process"), "{msg}");
    }

    #[test]
    fn by_run_id_rejects_duplicate_sandbox_processes() {
        let status = mappings(vec![("run-x-1".into(), "sandbox-dup".into())]);
        let fcs = vec![make_fc(200, "sandbox-dup"), make_fc(201, "sandbox-dup")];

        let Err(e) = resolve_by_run_id("run-x", &status, &fcs) else {
            panic!("expected error when multiple firecracker processes share a sandbox id");
        };
        let msg = e.to_string();

        assert!(msg.contains("multiple firecracker processes"), "{msg}");
        assert!(msg.contains("200"), "{msg}");
        assert!(msg.contains("201"), "{msg}");
    }

    #[test]
    fn resolve_target_uses_supplied_registry_mappings() {
        let args = KillArgs {
            run: Some("run-live".into()),
            sandbox: None,
            force: true,
        };
        let discovered = DiscoveredProcesses {
            firecrackers: vec![make_fc(200, "sandbox-live")],
            mitmdumps: vec![],
            dnsmasqs: vec![],
        };
        let supplied_mappings = mappings(vec![("run-live-123".into(), "sandbox-live".into())]);

        let resolved = resolve_target(&args, &discovered, Some(&supplied_mappings)).unwrap();

        assert_eq!(resolved.process.pid, 200);
        assert_eq!(resolved.run_id.as_deref(), Some("run-live-123"));
    }

    // -- resolve_by_sandbox_id tests -----------------------------------------

    #[test]
    fn by_sandbox_id_prefix_match() {
        let fcs = vec![make_fc(200, "orphan-sandbox-id-123")];
        let result = resolve_by_sandbox_id("orphan-sandbox", &fcs);
        assert_eq!(result.unwrap().pid, 200);
    }

    #[test]
    fn by_sandbox_id_ambiguous() {
        let fcs = vec![
            make_fc(400, "orphan-aaa-111"),
            make_fc(401, "orphan-aaa-222"),
        ];
        let Err(e) = resolve_by_sandbox_id("orphan-aaa", &fcs) else {
            panic!("expected ambiguity error");
        };
        let msg = e.to_string();
        assert!(msg.contains("ambiguous"), "{msg}");
        assert!(msg.contains("orphan-aaa-111"), "{msg}");
        assert!(msg.contains("orphan-aaa-222"), "{msg}");
    }

    #[test]
    fn by_sandbox_id_no_match() {
        let fcs = vec![make_fc(100, "sbox-A")];
        let result = resolve_by_sandbox_id("nonexistent", &fcs);
        assert!(result.is_err());
    }

    #[test]
    fn by_sandbox_id_empty_input() {
        let fcs = vec![make_fc(100, "sbox-A")];
        let result = resolve_by_sandbox_id("", &fcs);
        assert!(result.is_err());
    }

    #[test]
    fn by_sandbox_id_empty_list() {
        let fcs: Vec<FirecrackerProcessInfo> = vec![];
        let result = resolve_by_sandbox_id("abc", &fcs);
        assert!(result.is_err());
    }

    #[test]
    fn sandbox_reresolution_requires_same_process_identity() {
        let args = KillArgs {
            run: None,
            sandbox: Some("sbox".into()),
            force: true,
        };
        let initial = make_target(200, "sbox-123");
        let mut current = make_target(200, "sbox-123");
        current.generation.as_mut().unwrap().starttime += 1;

        let error = ensure_same_target_after_confirmation(&args, &initial, &current).unwrap_err();

        assert!(error.contains("changed identity"), "{error}");
    }

    #[test]
    fn sandbox_reresolution_requires_same_canonical_process_facts() {
        let args = KillArgs {
            run: None,
            sandbox: Some("sbox".into()),
            force: true,
        };
        let initial = make_target(200, "sbox-123");

        let mut changed_pid = initial.clone();
        changed_pid.pid += 1;
        assert!(
            ensure_same_target_after_confirmation(&args, &initial, &changed_pid).is_err(),
            "changed PID must not retain sandbox process identity"
        );

        let mut changed_base_dir = initial.clone();
        changed_base_dir.base_dir = Some(PathBuf::from("/data/r2"));
        assert!(
            ensure_same_target_after_confirmation(&args, &initial, &changed_base_dir).is_err(),
            "changed workspace base must not retain sandbox process identity"
        );
    }

    #[test]
    fn run_reresolution_requires_same_sandbox() {
        let args = KillArgs {
            run: Some("run".into()),
            sandbox: None,
            force: true,
        };
        let initial = make_run_target(200, "run-123", "sbox-old");
        let current = make_run_target(201, "run-123", "sbox-new");

        let error = ensure_same_target_after_confirmation(&args, &initial, &current).unwrap_err();

        assert!(error.contains("run target changed"), "{error}");
        assert!(error.contains("sbox-old"), "{error}");
        assert!(error.contains("sbox-new"), "{error}");
    }

    #[test]
    fn run_reresolution_requires_same_run_identity() {
        let args = KillArgs {
            run: Some("run".into()),
            sandbox: None,
            force: true,
        };
        let initial = make_run_target(200, "run-old", "sbox-reused");
        let current = make_run_target(200, "run-new", "sbox-reused");

        let error = ensure_same_target_after_confirmation(&args, &initial, &current).unwrap_err();

        assert!(error.contains("run target changed from run"), "{error}");
        assert!(error.contains("run-old"), "{error}");
        assert!(error.contains("run-new"), "{error}");
    }

    #[test]
    fn run_reresolution_rejects_missing_run_identity() {
        let args = KillArgs {
            run: Some("run".into()),
            sandbox: None,
            force: true,
        };
        let initial = make_run_target(200, "run-old", "sbox-reused");
        let current = make_target(200, "sbox-reused");

        let error = ensure_same_target_after_confirmation(&args, &initial, &current).unwrap_err();

        assert!(error.contains("active run identity"), "{error}");
    }

    #[test]
    fn same_sandbox_fallback_accepts_exact_identity_without_run_status() {
        let expected = make_target(200, "sbox-123");
        let discovered = discovered_with_firecrackers(vec![make_fc_from_target(&expected)]);

        let target = resolve_same_sandbox_process(&expected, &discovered).unwrap();

        assert_eq!(target, expected);
    }

    #[test]
    fn same_sandbox_fallback_rejects_changed_process_identity() {
        let expected = make_target(200, "sbox-123");
        let mut changed = make_target(200, "sbox-123");
        changed.generation.as_mut().unwrap().starttime += 1;
        let discovered = discovered_with_firecrackers(vec![make_fc_from_target(&changed)]);

        let error = resolve_same_sandbox_process(&expected, &discovered).unwrap_err();

        assert!(error.to_string().contains("changed identity"));
    }
}
