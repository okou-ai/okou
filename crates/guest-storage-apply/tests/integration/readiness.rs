#![cfg(target_os = "linux")]

use crate::process::{self, CommandExecution};
use crate::support::create_tar_gz;
use guest_contracts::runtime_paths;
use guest_contracts::storage_manifest::{ArchiveReadiness, Manifest};
use serde_json::json;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

fn wait_for(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "observable path did not appear: {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn manifest(dir: &Path) -> Result<(Manifest, ArchiveReadiness), Box<dyn std::error::Error>> {
    fs::write(
        dir.join("ready.tar.gz"),
        create_tar_gz(&[("value", b"ready")])?,
    )?;
    fs::write(
        dir.join("pending.tar.gz"),
        create_tar_gz(&[("value", b"stale")])?,
    )?;
    let descriptor = ArchiveReadiness {
        id: uuid::Uuid::new_v4(),
        sources: vec![format!("file://{}", dir.join("pending.tar.gz").display())],
    };
    let manifest: Manifest = serde_json::from_value(json!({
        "storageMounts":[
            {"mountPath":dir.join("ready"),"archiveUrl":format!("file://{}",dir.join("ready.tar.gz").display())},
            {"mountPath":dir.join("pending"),"writeback":true,"archiveUrl":format!("file://{}",dir.join("pending.tar.gz").display())}
        ],
        "archiveReadiness":descriptor
    }))?;
    Ok((manifest, descriptor))
}

fn spawn(manifest: &Manifest, runtime: &Path) -> std::io::Result<CommandExecution> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-storage-apply"));
    command
        .arg("--manifest-stdin")
        .env("OKOU_RUN_ID", "readiness-test")
        .env(runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV, runtime);
    let bytes = serde_json::to_vec(manifest).map_err(std::io::Error::other)?;
    CommandExecution::spawn(&mut command, Some(&bytes))
}

#[test]
fn ready_input_applies_while_another_archive_waits_for_this_operation() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = dir.path().join("runtime");
    let (manifest, descriptor) = manifest(dir.path()).unwrap();
    let child = spawn(&manifest, &runtime).unwrap();
    wait_for(&dir.path().join("ready/value"));
    assert_eq!(fs::read(dir.path().join("ready/value")).unwrap(), b"ready");
    assert!(!dir.path().join("pending/value").exists());
    fs::write(
        dir.path().join("pending.tar.gz"),
        create_tar_gz(&[("value", b"fresh")]).unwrap(),
    )
    .unwrap();
    runtime_paths::write_private_new(descriptor.ready_path(&runtime, 0), []).unwrap();
    let output = child.wait().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read(dir.path().join("pending/value")).unwrap(),
        b"fresh"
    );
}

#[test]
fn producer_failure_fails_the_real_helper_and_leaves_the_pending_input_unapplied() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = dir.path().join("runtime");
    let (manifest, descriptor) = manifest(dir.path()).unwrap();
    let child = spawn(&manifest, &runtime).unwrap();
    wait_for(&dir.path().join("ready/value"));
    runtime_paths::write_private_new(descriptor.failed_path(&runtime), []).unwrap();
    assert!(!child.wait().unwrap().status.success());
    assert!(!dir.path().join("pending/value").exists());
}

#[test]
fn waiting_helper_is_killed_and_reaped_by_the_existing_process_owner() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = dir.path().join("runtime");
    let (manifest, descriptor) = manifest(dir.path()).unwrap();
    let child = spawn(&manifest, &runtime).unwrap();
    let pid = child.id().unwrap();
    wait_for(&descriptor.directory(&runtime));
    let error = child
        .wait_with_timeout(Duration::from_millis(40))
        .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    process::verify_child_reaped(pid).unwrap();
    assert!(!Path::new("/proc").join(pid.to_string()).exists());
}

#[test]
fn fifo_marker_is_rejected_without_blocking_the_real_helper() {
    use std::os::unix::ffi::OsStrExt;
    let dir = tempfile::tempdir().unwrap();
    let runtime = dir.path().join("runtime");
    let (manifest, descriptor) = manifest(dir.path()).unwrap();
    runtime_paths::ensure_dir(descriptor.directory(&runtime)).unwrap();
    let path =
        std::ffi::CString::new(descriptor.ready_path(&runtime, 0).as_os_str().as_bytes()).unwrap();
    // SAFETY: path is a live NUL-terminated pathname in this test's private directory.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    let output = spawn(&manifest, &runtime)
        .unwrap()
        .wait_with_timeout(Duration::from_secs(2))
        .unwrap();
    assert!(!output.status.success());
    assert!(!dir.path().join("ready/value").exists());
}

#[test]
fn runtime_alias_with_parent_component_is_rejected_before_any_input_changes() {
    for missing_leaf in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let runtime = dir.path().join("runtime");
        let anchor = runtime.join("anchor");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&anchor).unwrap();
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&anchor, outside.join("alias")).unwrap();

        let mut mount = outside.join("alias/..");
        if missing_leaf {
            mount.push("not-created");
        }
        let (mut manifest, descriptor) = manifest(dir.path()).unwrap();
        manifest.storages[0].mount_path = mount.to_string_lossy().into_owned();
        let stale = dir.path().join("stale");
        fs::create_dir(&stale).unwrap();
        fs::write(stale.join("keep"), b"original").unwrap();
        manifest
            .cleanup_paths
            .push(stale.to_string_lossy().into_owned());
        runtime_paths::write_private_new(descriptor.ready_path(&runtime, 0), []).unwrap();

        let output = spawn(&manifest, &runtime).unwrap().wait().unwrap();
        assert!(!output.status.success(), "missing leaf: {missing_leaf}");
        assert_eq!(fs::read(stale.join("keep")).unwrap(), b"original");
        assert!(!runtime.join("value").exists());
        assert!(!runtime.join("not-created/value").exists());
        assert!(!dir.path().join("pending/value").exists());
    }
}
