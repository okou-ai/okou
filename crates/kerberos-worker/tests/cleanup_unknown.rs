//! Isolated process: a deliberately unconfirmed cleanup permanently quarantines
//! one real slot. Never share this process-global failure with the other tests.
#![cfg(test)]
pub mod common;
use kerberos_worker::{Error, NoKdc};
use std::{fs, os::unix::fs::symlink, time::Duration};
use tokio::time::Instant;

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; strict matrix job"]
async fn actual_cleanup_unknown_reaps_but_retains_capacity_until_owner_reconciliation() {
    let parent = common::root();
    let root = parent.path().join("owned-root");
    fs::create_dir(&root).unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let root = root.canonicalize().unwrap();
    let (context, _) = kerberos_worker::open(
        &root,
        common::credentials("fixture"),
        common::policy(),
        Instant::now() + Duration::from_secs(10),
        &mut NoKdc,
    )
    .await
    .unwrap();
    let id = context.process_id();
    let retained = parent.path().join("retained-owned-root");
    // Change only this test-owned ancestor. An ELOOP makes absence unknowable even
    // for UID0; the native process's existing readonly mounts are unaffected.
    fs::rename(&root, &retained).unwrap();
    symlink("owned-root", &root).unwrap();
    assert_eq!(context.close().await.unwrap_err(), Error::CleanupUnknown);
    assert!(!std::path::Path::new(&format!("/proc/{id}")).exists());
    fs::remove_file(&root).unwrap();
    fs::rename(&retained, &root).unwrap();
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    let (remaining, _) = kerberos_worker::open(
        &root,
        common::credentials("fixture"),
        common::policy(),
        Instant::now() + Duration::from_secs(10),
        &mut NoKdc,
    )
    .await
    .unwrap();
    let third = kerberos_worker::open(
        &root,
        common::credentials("fixture"),
        common::policy(),
        Instant::now() + Duration::from_millis(40),
        &mut NoKdc,
    )
    .await;
    assert!(matches!(third, Err(Error::Deadline)));
    assert!(std::path::Path::new(&format!("/proc/{}", remaining.process_id())).exists());
    remaining.close().await.unwrap();
    assert_eq!(fs::read_dir(root).unwrap().count(), 0);
    // Restoring a pathname is not permission to clear an unknown-cleanup slot.
}
