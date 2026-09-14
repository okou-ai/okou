//! Filesystem scenarios use explicit process discovery state so unrelated host
//! processes cannot trigger the production fail-closed guard before assertions.

use std::time::Duration;

use nix::fcntl::FlockArg;

use super::*;
use crate::cmd::gc::test_support::{assert_is_symlink, old_gc_time, set_mtime, test_home};
use crate::process::discovery_test_support::{ProcfsFixture, UNCERTAIN_STAT_FAULTS};

fn discovered_base_dirs(leases: &[DeadRunnerBaseDirLease]) -> Vec<PathBuf> {
    leases
        .iter()
        .filter_map(|lease| lease.base_dir.clone())
        .collect()
}

fn discover_dead_runner_base_dirs(locks_dir: &Path) -> Vec<DeadRunnerBaseDirLease> {
    discover_initially_free_base_dir_lock_candidates(locks_dir)
        .into_iter()
        .filter_map(acquire_dead_runner_base_dir_lease)
        .collect()
}

fn discover_base_dir_lock_candidates(home: &HomePaths) -> Vec<DeadRunnerBaseDirLockCandidate> {
    discover_initially_free_base_dir_lock_candidates(&home.locks_dir())
}

fn write_base_dir_lock(home: &HomePaths, base_dir: &Path) -> PathBuf {
    let lock_path = home.base_dir_lock(base_dir);
    std::fs::write(&lock_path, base_dir.as_os_str().as_encoded_bytes()).unwrap();
    lock_path
}

fn failing_remove_dir_all(_path: &Path) -> RemoveDirAllFuture<'_> {
    Box::pin(async { Err(std::io::Error::other("injected workspace removal failure")) })
}

fn firecracker_with_base_dir(
    pid: u32,
    sandbox_id: &str,
    base_dir: &Path,
) -> crate::process::FirecrackerProcessInfo {
    crate::process::FirecrackerProcessInfo {
        pid,
        ppid: Some(1),
        sandbox_id: sandbox_id.to_string(),
        base_dir: Some(base_dir.to_path_buf()),
        generation: None,
    }
}

fn incomplete_firecracker(pid: u32) -> crate::process::FirecrackerProcessInfo {
    crate::process::FirecrackerProcessInfo {
        pid,
        ppid: Some(1),
        sandbox_id: format!("pid-{pid}"),
        base_dir: None,
        generation: None,
    }
}

#[test]
fn discover_dead_runner_base_dirs_reads_lock_files() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    write_base_dir_lock(&home, Path::new("/data/runner-01"));
    write_base_dir_lock(&home, Path::new("/data/runner-02"));

    let dirs = discover_dead_runner_base_dirs(&home.locks_dir());
    assert_eq!(dirs.len(), 2);
    let base_dirs = discovered_base_dirs(&dirs);
    assert!(base_dirs.contains(&PathBuf::from("/data/runner-01")));
    assert!(base_dirs.contains(&PathBuf::from("/data/runner-02")));
}

#[test]
fn discover_dead_runner_base_dirs_keeps_empty_locks_for_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    // Empty lock file (pre-upgrade runner)
    std::fs::write(locks_dir.join("base-dir-empty.lock"), "").unwrap();
    // Non-base-dir lock file
    std::fs::write(locks_dir.join("rootfs-abc.lock"), "/some/path").unwrap();

    let dirs = discover_dead_runner_base_dirs(&home.locks_dir());
    assert_eq!(dirs.len(), 1);
    assert_eq!(dirs[0].base_dir, None);
}

#[test]
fn discover_dead_runner_base_dirs_missing_dir() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    // locks dir does not exist
    let dirs = discover_dead_runner_base_dirs(&home.locks_dir());
    assert!(dirs.is_empty());
}

#[test]
fn discover_dead_runner_base_dirs_skips_held_locks() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    // Lock file with content, held by us (simulating a live runner).
    let lock_path = write_base_dir_lock(&home, Path::new("/data/live-runner"));
    let file = std::fs::File::options()
        .read(true)
        .write(true)
        .open(&lock_path)
        .unwrap();
    let _held = Flock::lock(file, FlockArg::LockExclusive).unwrap();

    // Lock file with content, NOT held (simulating a dead runner).
    write_base_dir_lock(&home, Path::new("/data/dead-runner"));

    let dirs = discover_dead_runner_base_dirs(&home.locks_dir());
    assert_eq!(dirs.len(), 1);
    assert_eq!(dirs[0].base_dir, Some(PathBuf::from("/data/dead-runner")));
}

#[test]
fn discover_dead_runner_base_dirs_keeps_lock_guard_alive() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let lock_path = write_base_dir_lock(&home, Path::new("/data/dead-runner"));

    let leases = discover_dead_runner_base_dirs(&home.locks_dir());
    assert_eq!(leases.len(), 1);
    match probe_existing_lock(&lock_path) {
        ExistingLockProbe::Held => {}
        _ => panic!("base-dir lease must keep the lock held"),
    }

    drop(leases);
    match probe_existing_lock(&lock_path) {
        ExistingLockProbe::Free(_) => {}
        _ => panic!("base-dir lock should be free after dropping leases"),
    }
}

#[test]
fn discover_initially_free_base_dir_lock_candidates_drops_probe_guards() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let lock_path = write_base_dir_lock(&home, Path::new("/data/dead-runner"));

    let candidates = discover_base_dir_lock_candidates(&home);
    assert_eq!(candidates.len(), 1);
    match probe_existing_lock(&lock_path) {
        ExistingLockProbe::Free(lock_guard) => drop(lock_guard),
        _ => panic!("initial candidate discovery must drop free probe guards"),
    }
}

#[tokio::test]
async fn gc_workspace_orphans_excludes_candidate_held_during_initial_discovery() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let base_dir = dir.path().join("runner-data");
    let workspace = base_dir.join("workspaces").join("run-old");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("cow.img"), b"data").unwrap();
    set_mtime(&workspace, old_gc_time());

    let lock_path = write_base_dir_lock(&home, &base_dir);
    let lock_file = std::fs::File::options()
        .read(true)
        .write(true)
        .open(&lock_path)
        .unwrap();
    let held_lock = Flock::lock(lock_file, FlockArg::LockExclusive).unwrap();

    let candidates = discover_base_dir_lock_candidates(&home);
    assert!(
        candidates.is_empty(),
        "a base dir held at initial discovery must be excluded for the pass"
    );

    drop(held_lock);
    match probe_existing_lock(&lock_path) {
        ExistingLockProbe::Free(lock_guard) => drop(lock_guard),
        _ => panic!("the simulated runner lock should now be free"),
    }

    let summary = gc_workspace_orphans_with_candidates(
        candidates,
        &[],
        &HashSet::new(),
        false,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();

    assert_eq!(summary.workspaces_cleaned, 0);
    assert_eq!(summary.base_dir_locks_removed, 0);
    assert!(workspace.exists(), "the old workspace must remain");
    assert!(lock_path.exists(), "the retry lock must remain");
}

#[tokio::test]
async fn gc_workspace_orphans_preserves_workspace_created_after_pass_reference() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let workspace_age_reference = old_gc_time();
    let base_dir = dir.path().join("runner-data");
    let lock_path = write_base_dir_lock(&home, &base_dir);

    let candidates = discover_base_dir_lock_candidates(&home);
    assert_eq!(candidates.len(), 1);
    match probe_existing_lock(&lock_path) {
        ExistingLockProbe::Free(lock_guard) => drop(lock_guard),
        _ => panic!("initial candidate discovery must not retain the lock"),
    }

    let workspace = base_dir.join("workspaces").join("run-new");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("cow.img"), b"data").unwrap();
    set_mtime(&workspace, workspace_age_reference + Duration::from_secs(1));

    let summary = gc_workspace_orphans_with_candidates(
        candidates,
        &[],
        &HashSet::new(),
        false,
        workspace_age_reference,
        false,
    )
    .await
    .unwrap();

    assert_eq!(summary.workspaces_cleaned, 0);
    assert_eq!(summary.base_dir_locks_removed, 0);
    assert!(
        workspace.exists(),
        "the post-boundary workspace must remain"
    );
    assert!(lock_path.exists(), "the retry lock must remain");
}

#[tokio::test]
async fn gc_workspace_orphans_does_not_recreate_missing_candidate_lock() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let lock_path = write_base_dir_lock(&home, Path::new("/data/dead-runner"));

    let candidates = discover_base_dir_lock_candidates(&home);
    assert_eq!(candidates.len(), 1);
    std::fs::remove_file(&lock_path).unwrap();

    let summary = gc_workspace_orphans_with_candidates(
        candidates,
        &[],
        &HashSet::new(),
        false,
        SystemTime::now(),
        true,
    )
    .await
    .unwrap();

    assert_eq!(summary.workspaces_cleaned, 0);
    assert_eq!(summary.base_dir_locks_removed, 0);
    assert!(
        !lock_path.exists(),
        "GC must not recreate a lock path that disappeared after discovery"
    );
}

#[tokio::test]
async fn gc_workspace_orphans_deletes_old_orphan() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    // Create a fake base_dir with a workspace
    let base_dir = dir.path().join("runner-data");
    let workspaces_dir = base_dir.join("workspaces");
    let workspace = workspaces_dir.join("run-abc-123");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("cow.img"), vec![0u8; 4096]).unwrap();

    // Register base_dir in lock file
    write_base_dir_lock(&home, &base_dir);

    // Set workspace mtime to 1 hour ago (past GC_MIN_AGE)
    let old_time = SystemTime::now() - Duration::from_secs(3600);
    std::fs::File::open(&workspace)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    let summary = gc_workspace_orphans_with_candidates(
        discover_base_dir_lock_candidates(&home),
        &[],
        &HashSet::new(),
        false,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();

    assert!(!workspace.exists(), "orphaned workspace should be deleted");
    assert_eq!(summary.workspaces_cleaned, 1);
    assert!(summary.bytes_freed > 0 || cfg!(target_os = "macos"));
    assert_eq!(summary.base_dir_locks_removed, 1);
}

#[tokio::test]
async fn gc_workspace_orphans_retries_after_workspace_removal_failure() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let base_dir = dir.path().join("runner-data");
    let workspace = base_dir.join("workspaces").join("run-old");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("cow.img"), vec![0u8; 4096]).unwrap();
    set_mtime(&workspace, old_gc_time());
    let lock_path = write_base_dir_lock(&home, &base_dir);

    let failed = gc_workspace_orphans_with_candidates_and_remove(
        discover_base_dir_lock_candidates(&home),
        &[],
        &HashSet::new(),
        false,
        SystemTime::now(),
        false,
        failing_remove_dir_all,
    )
    .await
    .unwrap();

    assert!(workspace.exists(), "failed cleanup must keep the workspace");
    assert_eq!(failed.workspaces_cleaned, 0);
    assert_eq!(failed.bytes_freed, 0);
    assert_eq!(failed.base_dir_locks_removed, 0);
    assert!(
        lock_path.exists(),
        "failed cleanup must keep the retry lock"
    );

    let retried = gc_workspace_orphans_with_candidates(
        discover_base_dir_lock_candidates(&home),
        &[],
        &HashSet::new(),
        false,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();

    assert_eq!(retried.workspaces_cleaned, 1);
    assert!(retried.bytes_freed > 0 || cfg!(target_os = "macos"));
    assert_eq!(retried.base_dir_locks_removed, 1);
    assert!(
        !workspace.exists(),
        "retry should remove the orphaned workspace"
    );
    assert!(!lock_path.exists(), "retry should remove the base-dir lock");
}

#[tokio::test]
async fn gc_workspace_orphans_skips_recent() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let base_dir = dir.path().join("runner-data");
    let workspace = base_dir.join("workspaces").join("run-new-456");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("cow.img"), b"data").unwrap();
    // mtime = now (default), so workspace is too recent

    write_base_dir_lock(&home, &base_dir);

    let summary = gc_workspace_orphans_with_candidates(
        discover_base_dir_lock_candidates(&home),
        &[],
        &HashSet::new(),
        false,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();

    assert!(workspace.exists(), "recent workspace should NOT be deleted");
    assert_eq!(summary.workspaces_cleaned, 0);
    assert_eq!(summary.base_dir_locks_removed, 0);
}

#[tokio::test]
async fn gc_workspace_orphans_dry_run_preserves() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let base_dir = dir.path().join("runner-data");
    let workspace = base_dir.join("workspaces").join("run-dry-789");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("cow.img"), b"data").unwrap();

    let lock_path = write_base_dir_lock(&home, &base_dir);

    let old_time = SystemTime::now() - Duration::from_secs(3600);
    std::fs::File::open(&workspace)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    let summary = gc_workspace_orphans_with_candidates(
        discover_base_dir_lock_candidates(&home),
        &[],
        &HashSet::new(),
        false,
        SystemTime::now(),
        true,
    )
    .await
    .unwrap();

    assert!(workspace.exists(), "dry-run should NOT delete");
    assert!(
        lock_path.exists(),
        "dry-run should NOT remove base-dir lock"
    );
    assert_eq!(summary.workspaces_cleaned, 1);
    assert!(summary.bytes_freed > 0 || cfg!(target_os = "macos"));
    assert_eq!(summary.base_dir_locks_removed, 1);
}

#[tokio::test]
async fn gc_workspace_orphans_preserves_files_after_discovery_stat_faults() {
    for fault in UNCERTAIN_STAT_FAULTS {
        for successful_reads in 0..4 {
            let dir = tempfile::tempdir().unwrap();
            let home = test_home(dir.path());
            std::fs::create_dir_all(home.locks_dir()).unwrap();
            let base_dir = dir.path().join("runner-data");
            let workspace = base_dir.join("workspaces").join("run-old");
            std::fs::create_dir_all(&workspace).unwrap();
            let image_path = workspace.join("cow.img");
            std::fs::write(&image_path, b"live workspace data").unwrap();
            set_mtime(&workspace, old_gc_time());
            let lock_path = write_base_dir_lock(&home, &base_dir);
            let candidates = discover_base_dir_lock_candidates(&home);

            let fixture = ProcfsFixture::new(&workspace);
            let discovered = fixture
                .discover_with_stat_fault(successful_reads, fault)
                .await;
            assert!(discovered.proc_scan_complete);
            let firecrackers = discovered.processes.firecrackers;
            let uncertain = workspace_firecracker_discovery_uncertain(&firecrackers, &[]).await;
            let summary = gc_workspace_orphans_with_candidates(
                candidates,
                &firecrackers,
                &HashSet::new(),
                uncertain,
                SystemTime::now(),
                false,
            )
            .await
            .unwrap();

            assert_eq!(
                summary.workspaces_cleaned, 0,
                "{fault:?} after {successful_reads} successful stat reads"
            );
            assert_eq!(summary.bytes_freed, 0);
            assert_eq!(summary.base_dir_locks_removed, 0);
            assert_eq!(std::fs::read(&image_path).unwrap(), b"live workspace data");
            assert!(lock_path.exists(), "lock must remain for a later retry");
        }
    }
}

#[tokio::test]
async fn gc_workspace_orphans_skips_when_incomplete_firecracker_unattributed() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let base_dir = dir.path().join("runner-data");
    let workspace = base_dir.join("workspaces").join("run-old");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("cow.img"), b"data").unwrap();
    set_mtime(&workspace, old_gc_time());
    let lock_path = write_base_dir_lock(&home, &base_dir);

    let candidates = discover_base_dir_lock_candidates(&home);
    let firecrackers = [incomplete_firecracker(1234)];
    let summary = gc_workspace_orphans_with_candidates(
        candidates,
        &firecrackers,
        &HashSet::new(),
        true,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();

    assert_eq!(summary.workspaces_cleaned, 0);
    assert_eq!(summary.base_dir_locks_removed, 0);
    assert!(
        workspace.exists(),
        "uncertain discovery must preserve workspace"
    );
    assert!(lock_path.exists(), "lock must remain for a later retry");
}

#[tokio::test]
async fn gc_workspace_orphans_skips_when_process_discovery_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let base_dir = dir.path().join("runner-data");
    let workspace = base_dir.join("workspaces").join("run-old");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("cow.img"), b"data").unwrap();
    set_mtime(&workspace, old_gc_time());
    let lock_path = write_base_dir_lock(&home, &base_dir);

    let candidates = discover_base_dir_lock_candidates(&home);
    let summary = gc_workspace_orphans_with_candidates(
        candidates,
        &[],
        &HashSet::new(),
        true,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();

    assert_eq!(summary.workspaces_cleaned, 0);
    assert_eq!(summary.base_dir_locks_removed, 0);
    assert!(
        workspace.exists(),
        "incomplete process discovery must preserve workspace"
    );
    assert!(lock_path.exists(), "lock must remain for a later retry");
}

#[tokio::test]
async fn gc_workspace_orphans_cleans_when_incomplete_firecracker_is_live_runner_owned() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let base_dir = dir.path().join("runner-data");
    let workspace = base_dir.join("workspaces").join("run-old");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("cow.img"), b"data").unwrap();
    set_mtime(&workspace, old_gc_time());
    let lock_path = write_base_dir_lock(&home, &base_dir);

    let candidates = discover_base_dir_lock_candidates(&home);
    let firecrackers = [incomplete_firecracker(1234)];
    let summary = gc_workspace_orphans_with_candidates(
        candidates,
        &firecrackers,
        &HashSet::new(),
        false,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();

    assert_eq!(summary.workspaces_cleaned, 1);
    assert_eq!(summary.base_dir_locks_removed, 1);
    assert!(
        !workspace.exists(),
        "unrelated old workspace should be removed"
    );
    assert!(
        !lock_path.exists(),
        "base-dir lock can be removed after conclusive cleanup"
    );
}

#[tokio::test]
async fn gc_workspace_orphans_preserves_known_live_firecracker_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let base_dir = dir.path().join("runner-data");
    let sandbox_id = "sandbox-live";
    let workspace = base_dir.join("workspaces").join(sandbox_id);
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("cow.img"), b"data").unwrap();
    set_mtime(&workspace, old_gc_time());
    let lock_path = write_base_dir_lock(&home, &base_dir);

    let candidates = discover_base_dir_lock_candidates(&home);
    let firecrackers = [firecracker_with_base_dir(1234, sandbox_id, &base_dir)];
    let summary = gc_workspace_orphans_with_candidates(
        candidates,
        &firecrackers,
        &HashSet::new(),
        false,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();

    assert_eq!(summary.workspaces_cleaned, 0);
    assert_eq!(summary.base_dir_locks_removed, 0);
    assert!(
        workspace.exists(),
        "known live Firecracker workspace must remain"
    );
    assert!(
        lock_path.exists(),
        "lock must remain while workspace remains"
    );
}

#[tokio::test]
async fn gc_workspace_orphans_preserves_live_runner_base_dir_candidate() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let base_dir = dir.path().join("runner-data");
    let workspace = base_dir.join("workspaces").join("run-old");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("cow.img"), b"data").unwrap();
    set_mtime(&workspace, old_gc_time());
    let lock_path = write_base_dir_lock(&home, &base_dir);

    let candidates = discover_base_dir_lock_candidates(&home);
    let live_runner_base_dirs = HashSet::from([base_dir.clone()]);
    let summary = gc_workspace_orphans_with_candidates(
        candidates,
        &[],
        &live_runner_base_dirs,
        false,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();

    assert_eq!(summary.workspaces_cleaned, 0);
    assert_eq!(summary.base_dir_locks_removed, 0);
    assert!(
        workspace.exists(),
        "live runner base dir must not be cleaned"
    );
    assert!(
        lock_path.exists(),
        "lock must remain for live runner base dir"
    );
}

#[tokio::test]
async fn base_dir_lock_cleanup_removes_missing_or_empty_base_dir_lock() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let missing_base_dir = dir.path().join("missing-runner-data");
    let missing_lock = write_base_dir_lock(&home, &missing_base_dir);

    let empty_base_dir = dir.path().join("empty-runner-data");
    std::fs::create_dir_all(empty_base_dir.join("workspaces")).unwrap();
    let empty_lock = write_base_dir_lock(&home, &empty_base_dir);

    let empty_content_lock = locks_dir.join("base-dir-empty-content.lock");
    std::fs::write(&empty_content_lock, "").unwrap();

    let relative_content_lock = locks_dir.join("base-dir-relative-content.lock");
    std::fs::write(&relative_content_lock, "relative-runner-data").unwrap();

    let candidates = discover_base_dir_lock_candidates(&home);
    let summary = gc_workspace_orphans_with_candidates(
        candidates,
        &[],
        &HashSet::new(),
        false,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();

    assert_eq!(summary.workspaces_cleaned, 0);
    assert_eq!(summary.base_dir_locks_removed, 4);
    assert!(
        !missing_lock.exists(),
        "missing base-dir lock should be removed"
    );
    assert!(
        !empty_lock.exists(),
        "empty base-dir lock should be removed"
    );
    assert!(
        !empty_content_lock.exists(),
        "empty-content base-dir lock should be removed"
    );
    assert!(
        !relative_content_lock.exists(),
        "relative-content base-dir lock should be removed"
    );
}

#[tokio::test]
async fn base_dir_lock_cleanup_preserves_recent_workspace_retry_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let base_dir = dir.path().join("runner-data");
    let workspace = base_dir.join("workspaces").join("run-recent");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("cow.img"), b"data").unwrap();
    let lock_path = write_base_dir_lock(&home, &base_dir);

    let candidates = discover_base_dir_lock_candidates(&home);
    let summary = gc_workspace_orphans_with_candidates(
        candidates,
        &[],
        &HashSet::new(),
        false,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();

    assert_eq!(summary.workspaces_cleaned, 0);
    assert_eq!(summary.base_dir_locks_removed, 0);
    assert!(workspace.exists(), "recent workspace should remain");
    assert!(lock_path.exists(), "lock must remain for future retry");
}

#[tokio::test]
async fn gc_workspace_orphans_no_base_dirs() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    // No lock files, no running processes → no base_dirs
    let summary = gc_workspace_orphans(&home, false).await.unwrap();
    assert_eq!(summary.workspaces_cleaned, 0);
    assert_eq!(summary.bytes_freed, 0);
    assert_eq!(summary.base_dir_locks_removed, 0);
}

#[tokio::test]
async fn gc_workspace_orphans_skips_non_directory_entries() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let base_dir = dir.path().join("runner-data");
    let workspaces_dir = base_dir.join("workspaces");
    std::fs::create_dir_all(&workspaces_dir).unwrap();

    // Regular file in workspaces/ — must NOT be deleted
    let stray_file = workspaces_dir.join(".gitkeep");
    std::fs::write(&stray_file, "").unwrap();
    let old_time = SystemTime::now() - Duration::from_secs(3600);
    std::fs::File::open(&stray_file)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    write_base_dir_lock(&home, &base_dir);

    let summary = gc_workspace_orphans_with_candidates(
        discover_base_dir_lock_candidates(&home),
        &[],
        &HashSet::new(),
        false,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();
    assert_eq!(summary.workspaces_cleaned, 0);
    assert!(stray_file.exists(), "non-directory entries must be skipped");
}

#[tokio::test]
async fn gc_workspace_orphans_base_dir_without_workspaces_subdir() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    // base_dir exists but has no workspaces/ subdirectory
    let base_dir = dir.path().join("runner-data");
    std::fs::create_dir_all(&base_dir).unwrap();

    write_base_dir_lock(&home, &base_dir);

    let summary = gc_workspace_orphans_with_candidates(
        discover_base_dir_lock_candidates(&home),
        &[],
        &HashSet::new(),
        false,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();
    assert_eq!(summary.workspaces_cleaned, 0);
    assert_eq!(summary.bytes_freed, 0);
    assert_eq!(summary.base_dir_locks_removed, 1);
}

#[tokio::test]
async fn gc_workspace_orphans_mixed_old_and_recent() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let base_dir = dir.path().join("runner-data");
    let workspaces_dir = base_dir.join("workspaces");

    // Old workspace — should be deleted
    let old_ws = workspaces_dir.join("run-old");
    std::fs::create_dir_all(&old_ws).unwrap();
    std::fs::write(old_ws.join("cow.img"), vec![0u8; 4096]).unwrap();
    let old_time = SystemTime::now() - Duration::from_secs(3600);
    std::fs::File::open(&old_ws)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    // Recent workspace — should be kept
    let new_ws = workspaces_dir.join("run-new");
    std::fs::create_dir_all(&new_ws).unwrap();
    std::fs::write(new_ws.join("cow.img"), b"data").unwrap();
    // mtime = now (default)

    write_base_dir_lock(&home, &base_dir);

    let summary = gc_workspace_orphans_with_candidates(
        discover_base_dir_lock_candidates(&home),
        &[],
        &HashSet::new(),
        false,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();

    assert_eq!(
        summary.workspaces_cleaned, 1,
        "only old workspace should be cleaned"
    );
    assert!(!old_ws.exists(), "old workspace should be deleted");
    assert!(new_ws.exists(), "recent workspace should be kept");
    assert!(summary.bytes_freed > 0 || cfg!(target_os = "macos"));
    assert_eq!(summary.base_dir_locks_removed, 0);
}

#[cfg(unix)]
#[tokio::test]
async fn gc_workspace_orphans_skips_symlink_workspaces_dir() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let base_dir = dir.path().join("runner-data");
    std::fs::create_dir_all(&base_dir).unwrap();
    let outside_workspaces = dir.path().join("outside-workspaces");
    let outside_workspace = outside_workspaces.join("run-old");
    std::fs::create_dir_all(&outside_workspace).unwrap();
    std::fs::write(outside_workspace.join("cow.img"), b"outside").unwrap();
    set_mtime(&outside_workspace, old_gc_time());
    std::os::unix::fs::symlink(&outside_workspaces, base_dir.join("workspaces")).unwrap();

    write_base_dir_lock(&home, &base_dir);

    let summary = gc_workspace_orphans_with_candidates(
        discover_base_dir_lock_candidates(&home),
        &[],
        &HashSet::new(),
        false,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();

    assert_eq!(summary.workspaces_cleaned, 0);
    assert_eq!(summary.bytes_freed, 0);
    assert_is_symlink(
        &base_dir.join("workspaces"),
        "symlinked workspaces dir must remain",
    );
    assert!(
        outside_workspace.exists(),
        "GC must not enumerate and delete through a symlinked workspaces dir"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn gc_workspace_orphans_skips_symlink_base_dir() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let base_dir = dir.path().join("runner-data");
    let outside_base_dir = dir.path().join("outside-runner-data");
    let outside_workspace = outside_base_dir.join("workspaces").join("run-old");
    std::fs::create_dir_all(&outside_workspace).unwrap();
    std::fs::write(outside_workspace.join("cow.img"), b"outside").unwrap();
    set_mtime(&outside_workspace, old_gc_time());
    std::os::unix::fs::symlink(&outside_base_dir, &base_dir).unwrap();

    write_base_dir_lock(&home, &base_dir);

    let summary = gc_workspace_orphans_with_candidates(
        discover_base_dir_lock_candidates(&home),
        &[],
        &HashSet::new(),
        false,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();

    assert_eq!(summary.workspaces_cleaned, 0);
    assert_eq!(summary.bytes_freed, 0);
    assert_is_symlink(&base_dir, "symlinked base dir must remain");
    assert!(
        outside_workspace.exists(),
        "GC must not enumerate workspaces through a symlinked base dir"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn gc_workspace_orphans_skips_symlink_workspace_entry() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let base_dir = dir.path().join("runner-data");
    let workspaces_dir = base_dir.join("workspaces");
    std::fs::create_dir_all(&workspaces_dir).unwrap();
    let outside_workspace = dir.path().join("outside-workspace");
    std::fs::create_dir_all(&outside_workspace).unwrap();
    std::fs::write(outside_workspace.join("cow.img"), b"outside").unwrap();
    set_mtime(&outside_workspace, old_gc_time());
    let workspace_link = workspaces_dir.join("run-link");
    std::os::unix::fs::symlink(&outside_workspace, &workspace_link).unwrap();

    write_base_dir_lock(&home, &base_dir);

    let summary = gc_workspace_orphans_with_candidates(
        discover_base_dir_lock_candidates(&home),
        &[],
        &HashSet::new(),
        false,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();

    assert_eq!(summary.workspaces_cleaned, 0);
    assert_eq!(summary.bytes_freed, 0);
    assert_is_symlink(&workspace_link, "symlinked workspace entry must remain");
    assert!(
        outside_workspace.exists(),
        "GC must not delete a symlinked workspace target"
    );
}

#[test]
fn discover_dead_runner_base_dirs_rejects_hash_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let trimmed_base_dir = Path::new("/data/runner-01");
    let lock_path = home.base_dir_lock(trimmed_base_dir);
    std::fs::write(&lock_path, b"/data/runner-01\n").unwrap();

    let dirs = discover_dead_runner_base_dirs(&home.locks_dir());
    assert_eq!(dirs.len(), 1);
    assert_eq!(dirs[0].base_dir, None);
}

#[tokio::test]
async fn gc_workspace_orphans_does_not_scan_mismatched_base_dir_lock_name() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let base_dir = dir.path().join("runner-data");
    let workspace = base_dir.join("workspaces").join("run-old");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("cow.img"), b"data").unwrap();
    set_mtime(&workspace, old_gc_time());

    let lock_path = locks_dir.join("base-dir-mismatch.lock");
    std::fs::write(&lock_path, base_dir.as_os_str().as_encoded_bytes()).unwrap();

    let summary = gc_workspace_orphans_with_candidates(
        discover_base_dir_lock_candidates(&home),
        &[],
        &HashSet::new(),
        false,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();

    assert_eq!(summary.workspaces_cleaned, 0);
    assert_eq!(summary.base_dir_locks_removed, 1);
    assert!(
        workspace.exists(),
        "mismatched base-dir lock must not authorize workspace cleanup"
    );
    assert!(!lock_path.exists(), "mismatched lock should be removed");
}

#[test]
fn discover_dead_runner_base_dirs_preserves_trailing_space() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let base_dir = PathBuf::from("/data/runner-01 ");
    write_base_dir_lock(&home, &base_dir);

    let dirs = discover_dead_runner_base_dirs(&home.locks_dir());
    assert_eq!(dirs.len(), 1);
    assert_eq!(dirs[0].base_dir, Some(base_dir));
}

#[test]
fn discover_dead_runner_base_dirs_accepts_non_utf8_path_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let mut base_dir_bytes = b"/data/runner-".to_vec();
    base_dir_bytes.push(0xff);
    let base_dir = PathBuf::from(OsString::from_vec(base_dir_bytes.clone()));
    write_base_dir_lock(&home, &base_dir);

    let dirs = discover_dead_runner_base_dirs(&home.locks_dir());
    assert_eq!(dirs.len(), 1);
    assert_eq!(dirs[0].base_dir, Some(base_dir));
}

#[test]
fn discover_dead_runner_base_dirs_keeps_whitespace_only_locks_for_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    // Whitespace-only content should be treated as empty
    std::fs::write(locks_dir.join("base-dir-ws-only.lock"), "  \n\t\n").unwrap();

    let dirs = discover_dead_runner_base_dirs(&home.locks_dir());
    assert_eq!(dirs.len(), 1);
    assert_eq!(dirs[0].base_dir, None);
}

#[tokio::test]
async fn gc_workspace_orphans_multiple_base_dirs() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    // Two distinct base_dirs, each with an old orphaned workspace
    let base_dir_a = dir.path().join("runner-a");
    let ws_a = base_dir_a.join("workspaces").join("run-aaa");
    std::fs::create_dir_all(&ws_a).unwrap();
    std::fs::write(ws_a.join("cow.img"), vec![0u8; 4096]).unwrap();

    let base_dir_b = dir.path().join("runner-b");
    let ws_b = base_dir_b.join("workspaces").join("run-bbb");
    std::fs::create_dir_all(&ws_b).unwrap();
    std::fs::write(ws_b.join("cow.img"), vec![0u8; 4096]).unwrap();

    // Register both in separate lock files
    write_base_dir_lock(&home, &base_dir_a);
    write_base_dir_lock(&home, &base_dir_b);

    // Age both workspaces past GC_MIN_AGE
    let old_time = SystemTime::now() - Duration::from_secs(3600);
    for ws in [&ws_a, &ws_b] {
        std::fs::File::open(ws)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();
    }

    let summary = gc_workspace_orphans_with_candidates(
        discover_base_dir_lock_candidates(&home),
        &[],
        &HashSet::new(),
        false,
        SystemTime::now(),
        false,
    )
    .await
    .unwrap();

    assert_eq!(
        summary.workspaces_cleaned, 2,
        "both orphans should be cleaned"
    );
    assert!(!ws_a.exists(), "workspace A should be deleted");
    assert!(!ws_b.exists(), "workspace B should be deleted");
    assert!(summary.bytes_freed > 0 || cfg!(target_os = "macos"));
    assert_eq!(summary.base_dir_locks_removed, 2);
}
