use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};

fn mode(path: &std::path::Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn resolve_run_id_from_fs(group_dir: &std::path::Path, prefix: &str) -> RunnerResult<RunId> {
    resolve_run_id(group_dir, prefix, read_claim_entries, inspect_claim_entry)
}

async fn run_cancel_with_fs(args: CancelArgs, home: HomePaths) -> RunnerResult<ExitCode> {
    run_cancel_with_home(args, home, read_claim_entries, inspect_claim_entry).await
}

fn fail_prefix_read(
    _claims_dir: &std::path::Path,
) -> std::io::Result<std::iter::Empty<std::io::Result<ClaimEntry>>> {
    Err(std::io::Error::other("prefix reader must not be called"))
}

#[test]
fn resolve_exact_uuid() {
    let dir = tempfile::tempdir().unwrap();
    let id = RunId::new_v4();
    std::fs::create_dir_all(local_queue::claims_dir(dir.path())).unwrap();
    std::fs::write(local_queue::claim_path(dir.path(), id), b"").unwrap();

    let resolved = resolve_run_id_from_fs(dir.path(), &id.to_string()).unwrap();
    assert_eq!(resolved, id);
}

#[test]
fn resolve_prefix_match() {
    let dir = tempfile::tempdir().unwrap();
    let id = RunId::new_v4();
    std::fs::create_dir_all(local_queue::claims_dir(dir.path())).unwrap();
    std::fs::write(local_queue::claim_path(dir.path(), id), b"").unwrap();

    let prefix = &id.to_string()[..8];
    let resolved = resolve_run_id_from_fs(dir.path(), prefix).unwrap();
    assert_eq!(resolved, id);
}

#[test]
fn resolve_no_match() {
    let dir = tempfile::tempdir().unwrap();
    let err = resolve_run_id_from_fs(dir.path(), "deadbeef").unwrap_err();
    assert!(err.to_string().contains("no claimed job"), "got: {err}");
}

#[test]
fn resolve_ambiguous() {
    let dir = tempfile::tempdir().unwrap();
    let id1 = RunId::new_v4();
    let id2 = RunId::new_v4();
    std::fs::create_dir_all(local_queue::claims_dir(dir.path())).unwrap();
    std::fs::write(local_queue::claim_path(dir.path(), id1), b"").unwrap();
    std::fs::write(local_queue::claim_path(dir.path(), id2), b"").unwrap();

    // Empty prefix matches every `.claim` file, so two files guarantee ambiguity.
    let err = resolve_run_id_from_fs(dir.path(), "").unwrap_err();
    assert!(err.to_string().contains("ambiguous"), "got: {err}");
}

#[test]
fn resolve_exact_uuid_no_claim() {
    let dir = tempfile::tempdir().unwrap();
    let id = RunId::new_v4();
    // No .claim file written.
    let err = resolve_run_id_from_fs(dir.path(), &id.to_string()).unwrap_err();
    assert!(err.to_string().contains("no claimed job"), "got: {err}");
}

#[test]
fn resolve_ignores_claim_file_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let id = RunId::new_v4();
    let claims_dir = local_queue::claims_dir(dir.path());
    std::fs::create_dir_all(&claims_dir).unwrap();
    let target = dir.path().join("target-claim");
    std::fs::write(&target, b"").unwrap();
    symlink(&target, local_queue::claim_path(dir.path(), id)).unwrap();

    let exact_err = resolve_run_id_from_fs(dir.path(), &id.to_string()).unwrap_err();
    assert!(
        exact_err.to_string().contains("no claimed job"),
        "got: {exact_err}"
    );
    let prefix_err = resolve_run_id_from_fs(dir.path(), &id.to_string()[..8]).unwrap_err();
    assert!(
        prefix_err.to_string().contains("no claimed job"),
        "got: {prefix_err}"
    );
}

#[tokio::test]
async fn run_cancel_exact_uuid_skips_prefix_reader_and_writes_cancel_file() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group_dir = home.groups_dir().join("test/group");
    std::fs::create_dir_all(local_queue::claims_dir(&group_dir)).unwrap();
    let run_id = RunId::new_v4();
    std::fs::write(local_queue::claim_path(&group_dir, run_id), b"").unwrap();

    let code = run_cancel_with_home(
        CancelArgs {
            run: run_id.to_string(),
            group: "test/group".into(),
        },
        home,
        fail_prefix_read,
        Ok,
    )
    .await
    .unwrap();

    assert_eq!(code, ExitCode::SUCCESS);
    let cancel_path = local_queue::cancel_path(&group_dir, run_id);
    assert!(cancel_path.exists());
    assert_eq!(mode(&local_queue::cancels_dir(&group_dir)), 0o700);
    assert_eq!(mode(&cancel_path), 0o600);
}

#[tokio::test]
async fn run_cancel_rejects_incomplete_claim_enumeration_without_marker() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group_dir = home.groups_dir().join("test/group");
    let claims_dir = local_queue::ensure_claims_dir(&group_dir).unwrap();
    let run_id = RunId::new_v4();
    let claim_path = local_queue::claim_path(&group_dir, run_id);
    local_queue::write_private_marker(&claim_path, "test claim marker").unwrap();
    let entries = vec![
        Ok(ClaimEntry {
            path: claim_path.clone(),
            is_file: true,
        }),
        Err(std::io::Error::other("injected enumeration failure")),
    ];

    let err = run_cancel_with_home(
        CancelArgs {
            run: run_id.to_string()[..8].into(),
            group: "test/group".into(),
        },
        home,
        move |_claims_dir| Ok(entries.into_iter()),
        Ok,
    )
    .await
    .unwrap_err();

    let message = err.to_string();
    assert!(
        message.contains(&claims_dir.display().to_string()),
        "got: {err}"
    );
    assert!(
        message.contains("injected enumeration failure"),
        "got: {err}"
    );
    assert!(!local_queue::cancel_path(&group_dir, run_id).exists());
    assert!(!local_queue::cancels_dir(&group_dir).exists());
}

#[tokio::test]
async fn run_cancel_rejects_claim_inspection_error_without_marker() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group_dir = home.groups_dir().join("test/group");
    let claims_dir = local_queue::ensure_claims_dir(&group_dir).unwrap();
    let run_id = RunId::new_v4();
    let claim_path = local_queue::claim_path(&group_dir, run_id);
    local_queue::write_private_marker(&claim_path, "test claim marker").unwrap();
    let entries = vec![Ok(claim_path.clone())];

    let err = run_cancel_with_home(
        CancelArgs {
            run: run_id.to_string()[..8].into(),
            group: "test/group".into(),
        },
        home,
        move |_claims_dir| Ok(entries.into_iter()),
        |path: std::path::PathBuf| -> std::io::Result<ClaimEntry> {
            Err(std::io::Error::other(format!(
                "inspect claim entry {}: injected file type failure",
                path.display()
            )))
        },
    )
    .await
    .unwrap_err();

    let message = err.to_string();
    assert!(
        message.contains(&claims_dir.display().to_string()),
        "got: {err}"
    );
    assert!(
        message.contains(&claim_path.display().to_string()),
        "got: {err}"
    );
    assert!(message.contains("injected file type failure"), "got: {err}");
    assert!(!local_queue::cancel_path(&group_dir, run_id).exists());
    assert!(!local_queue::cancels_dir(&group_dir).exists());
}

#[tokio::test]
async fn run_cancel_rejects_group_symlink_before_claim_lookup() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let groups_dir = home.groups_dir();
    std::fs::create_dir_all(&groups_dir).unwrap();
    let target = dir.path().join("target-group");
    std::fs::create_dir(&target).unwrap();
    let org_dir = groups_dir.join("test");
    std::fs::create_dir(&org_dir).unwrap();
    let group_dir = org_dir.join("group");
    symlink(&target, &group_dir).unwrap();

    let err = run_cancel_with_fs(
        CancelArgs {
            run: RunId::new_v4().to_string(),
            group: "test/group".into(),
        },
        home,
    )
    .await
    .unwrap_err();

    assert!(
        err.to_string().contains("invalid group directory"),
        "got: {err}"
    );
}

#[tokio::test]
async fn run_cancel_rejects_claims_symlink_before_prefix_lookup() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let group_dir = home.groups_dir().join("test/group");
    std::fs::create_dir_all(&group_dir).unwrap();
    let target = dir.path().join("target-claims");
    std::fs::create_dir(&target).unwrap();
    let run_id = RunId::new_v4();
    std::fs::write(target.join(format!("{run_id}.claim")), b"").unwrap();
    symlink(&target, local_queue::claims_dir(&group_dir)).unwrap();

    let err = run_cancel_with_fs(
        CancelArgs {
            run: run_id.to_string()[..8].into(),
            group: "test/group".into(),
        },
        home,
    )
    .await
    .unwrap_err();

    assert!(
        err.to_string().contains("invalid claims directory"),
        "got: {err}"
    );
}
