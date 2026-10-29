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
