#![cfg(target_os = "linux")]

use crate::process::{self, CommandExecution};
use crate::support::create_tar_gz;
use cli_test_support::directory_permissions::DirectoryPermissions;
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
    // Entries are extracted in order, so the trailing marker witnesses that
    // the preceding value has been completely written and closed.
    fs::write(
        dir.join("ready.tar.gz"),
        create_tar_gz(&[("value", b"ready"), (".applied", b"")])?,
    )?;
    fs::write(
        dir.join("pending.tar.gz"),
        create_tar_gz(&[("value", b"stale")])?,
    )?;
    let descriptor = ArchiveReadiness {
        id: uuid::Uuid::new_v4(),
        sources: vec![format!("file://{}", dir.join("pending.tar.gz").display())],
        wait_timeout_ms: None,
        check_only: false,
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

fn unprivileged_command(dir: &Path, runtime: &Path) -> std::io::Result<Command> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::os::unix::process::CommandExt;

    // Root bypasses mode bits. An accessible copied binary and dropped child
    // identity keep these CLI fixtures on the real permission boundary.
    let root = fs::metadata(dir)?.uid() == 0;
    let binary = if root {
        let binary = dir.join("guest-storage-apply");
        fs::copy(env!("CARGO_BIN_EXE_guest-storage-apply"), &binary)?;
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755))?;
        binary
    } else {
        env!("CARGO_BIN_EXE_guest-storage-apply").into()
    };
    fs::set_permissions(dir, fs::Permissions::from_mode(0o777))?;
    for name in ["ready.tar.gz", "pending.tar.gz"] {
        fs::set_permissions(dir.join(name), fs::Permissions::from_mode(0o644))?;
    }
    let mut command = Command::new(binary);
    command
        .arg("--manifest-stdin")
        .current_dir(dir)
        .env("OKOU_RUN_ID", "readiness-permission-test")
        .env(runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV, runtime);
    if root {
        command.uid(65534);
    }
    Ok(command)
}

#[test]
fn eligibility_leaves_inaccessible_reused_storage_to_ordinary_application() {
    use guest_contracts::storage_manifest::StorageEntry;

    let dir = tempfile::tempdir().unwrap();
    let runtime = dir.path().join("runtime");
    let protected = dir.path().join("protected");
    let kept = protected.join("kept");
    fs::create_dir_all(&kept).unwrap();
    fs::write(kept.join("sentinel"), b"preserved input").unwrap();
    let (mut manifest, _) = manifest(dir.path()).unwrap();
    manifest.storages.insert(
        0,
        StorageEntry {
            template_guidance: None,
            mount_path: kept.display().to_string(),
            archive_url: None,
            cached: true,
            vas_storage_name: Some("kept".into()),
            vas_version_id: Some("v1".into()),
        },
    );
    manifest.cleanup_paths = ["ready", "pending"]
        .map(|name| dir.path().join(name).display().to_string())
        .to_vec();
    manifest.archive_readiness.as_mut().unwrap().check_only = true;
    let mut command = unprivileged_command(dir.path(), &runtime).unwrap();
    let restore = DirectoryPermissions::set(&protected, 0o0).unwrap();
    let output =
        CommandExecution::spawn(&mut command, Some(&serde_json::to_vec(&manifest).unwrap()))
            .unwrap()
            .wait()
            .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!serde_json::from_slice::<bool>(&output.stdout).unwrap());
    assert!(!dir.path().join("ready/value").exists());
    assert!(!runtime.join("archive-readiness").exists());

    manifest.archive_readiness = None;
    let output =
        CommandExecution::spawn(&mut command, Some(&serde_json::to_vec(&manifest).unwrap()))
            .unwrap()
            .wait()
            .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fs::read(dir.path().join("ready/value")).unwrap(), b"ready");
    assert_eq!(
        fs::read(dir.path().join("pending/value")).unwrap(),
        b"stale"
    );
    restore.restore().unwrap();
    assert_eq!(fs::read(kept.join("sentinel")).unwrap(), b"preserved input");
}

#[test]
fn eligibility_requires_unaliased_inputs_without_applying_or_cleaning_them() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let runtime = dir.path().join("runtime");
    fs::create_dir_all(&runtime).unwrap();
    fs::write(runtime.join("retained"), b"private").unwrap();
    let (mut manifest, _) = manifest(dir.path()).unwrap();
    manifest.archive_readiness.as_mut().unwrap().check_only = true;
    fs::create_dir_all(dir.path().join("ready")).unwrap();
    fs::write(dir.path().join("ready/old"), b"retained input").unwrap();
    manifest
        .cleanup_paths
        .push(dir.path().join("ready").display().to_string());
    let output = spawn(&manifest, &runtime).unwrap().wait().unwrap();
    assert!(output.status.success());
    assert!(serde_json::from_slice::<bool>(&output.stdout).unwrap());
    for overlap in [false, true] {
        let alias = dir.path().join("alias");
        if alias.exists() {
            fs::remove_file(&alias).unwrap();
        }
        symlink(if overlap { &runtime } else { dir.path() }, &alias).unwrap();
        manifest.artifacts[0].mount_path = alias
            .join(if overlap { "input" } else { "pending" })
            .display()
            .to_string();
        let output = spawn(&manifest, &runtime).unwrap().wait().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!serde_json::from_slice::<bool>(&output.stdout).unwrap());
        assert_eq!(
            fs::read(dir.path().join("ready/old")).unwrap(),
            b"retained input"
        );
        assert_eq!(fs::read(runtime.join("retained")).unwrap(), b"private");
        assert!(!dir.path().join("ready/value").exists());
        assert!(!runtime.join("archive-readiness").exists());
    }
    // Disjoint aliases remain valid ordinary inputs; only overlap admission is
    // conservative. Runtime-overlapping aliases above must stay non-mutating.
    fs::remove_file(dir.path().join("alias")).unwrap();
    symlink(dir.path(), dir.path().join("alias")).unwrap();
    manifest.artifacts[0].mount_path = dir.path().join("alias/pending").display().to_string();
    manifest.archive_readiness = None;
    let output = spawn(&manifest, &runtime).unwrap().wait().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read(dir.path().join("pending/value")).unwrap(),
        b"stale"
    );
    assert_eq!(fs::read(runtime.join("retained")).unwrap(), b"private");
}

#[test]
fn eligibility_keeps_cleanup_of_obstructing_instruction_ancestors_on_the_ordinary_path() {
    use guest_contracts::storage_manifest::InstructionCleanupEntry;
    use std::os::unix::fs::symlink;
    for obstruction in ["file", "cyclic", "overlong-alias"] {
        let dir = tempfile::tempdir().unwrap();
        let runtime = dir.path().join("runtime");
        let work = dir.path().join("work");
        fs::create_dir(&work).unwrap();
        let instructions = work.join("AGENTS.md");
        let alias = match obstruction {
            "cyclic" => Some(instructions.clone()),
            "overlong-alias" => Some(dir.path().join("x".repeat(256))),
            _ => None,
        };
        if let Some(target) = &alias {
            symlink(target, &instructions).unwrap();
        } else {
            fs::write(&instructions, b"previous instructions").unwrap();
        }
        let (mut manifest, _) = manifest(dir.path()).unwrap();
        manifest.artifacts[0].mount_path = instructions.join("nested").display().to_string();
        manifest.instruction_cleanups.push(InstructionCleanupEntry {
            mount_path: work.display().to_string(),
            target_filename: Some("AGENTS.md".into()),
        });
        manifest.archive_readiness.as_mut().unwrap().check_only = true;
        let output = spawn(&manifest, &runtime).unwrap().wait().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!serde_json::from_slice::<bool>(&output.stdout).unwrap());
        if let Some(target) = &alias {
            assert_eq!(fs::read_link(&instructions).unwrap(), *target);
        } else {
            assert_eq!(fs::read(&instructions).unwrap(), b"previous instructions");
        }
        assert!(!dir.path().join("ready/value").exists());
        assert!(!runtime.join("archive-readiness").exists());

        // Only the ordinary application may remove the old file/alias before
        // preparing this otherwise valid nested mount.
        manifest.archive_readiness = None;
        let output = spawn(&manifest, &runtime).unwrap().wait().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read(instructions.join("nested/value")).unwrap(),
            b"stale"
        );
        assert_eq!(fs::read(dir.path().join("ready/value")).unwrap(), b"ready");
    }
}

#[test]
fn ordinary_application_owns_cleanup_and_required_permission_failures() {
    use guest_contracts::storage_manifest::InstructionCleanupEntry;
    use std::os::unix::fs::{PermissionsExt, symlink};

    for cleanup in ["instruction", "all-instructions", "stale-path"] {
        let dir = tempfile::tempdir().unwrap();
        let runtime = dir.path().join("runtime");
        let work = dir.path().join("work");
        let protected = dir.path().join("protected");
        fs::create_dir(&work).unwrap();
        fs::create_dir(&protected).unwrap();
        fs::write(protected.join("sentinel"), b"untouched").unwrap();
        let instructions = work.join(if cleanup == "all-instructions" {
            "CLAUDE.md"
        } else {
            "AGENTS.md"
        });
        symlink(&protected, &instructions).unwrap();
        let (mut manifest, _) = manifest(dir.path()).unwrap();
        manifest.artifacts[0].mount_path = instructions.join("nested").display().to_string();
        manifest.archive_readiness.as_mut().unwrap().check_only = true;

        let mut command = unprivileged_command(dir.path(), &runtime).unwrap();
        fs::set_permissions(&work, fs::Permissions::from_mode(0o777)).unwrap();
        let restore = DirectoryPermissions::set(&protected, 0o0).unwrap();
        let mut run = |manifest: &Manifest| {
            CommandExecution::spawn(&mut command, Some(&serde_json::to_vec(manifest).unwrap()))
                .unwrap()
                .wait()
                .unwrap()
        };

        let output = run(&manifest);
        assert!(output.status.success());
        assert!(!serde_json::from_slice::<bool>(&output.stdout).unwrap());
        // The query does not predict cleanup success or suppress a real apply
        // failure. Without cleanup, the same active target still fails EACCES.
        let descriptor = manifest.archive_readiness.take();
        assert_eq!(run(&manifest).status.code(), Some(1));
        manifest.archive_readiness = descriptor;
        if cleanup == "stale-path" {
            manifest.cleanup_paths.push(work.display().to_string());
        } else {
            manifest.instruction_cleanups.push(InstructionCleanupEntry {
                mount_path: work.display().to_string(),
                target_filename: (cleanup == "instruction").then(|| "AGENTS.md".into()),
            });
        }
        let output = run(&manifest);
        assert!(
            output.status.success(),
            "{cleanup}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!serde_json::from_slice::<bool>(&output.stdout).unwrap());
        assert_eq!(fs::read_link(&instructions).unwrap(), protected);
        assert!(!dir.path().join("ready/value").exists());
        assert!(!runtime.join("archive-readiness").exists());

        manifest.archive_readiness = None;
        let output = run(&manifest);
        assert!(
            output.status.success(),
            "{cleanup}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read(instructions.join("nested/value")).unwrap(),
            b"stale"
        );
        assert_eq!(fs::read(dir.path().join("ready/value")).unwrap(), b"ready");
        restore.restore().unwrap();
        assert_eq!(fs::read(protected.join("sentinel")).unwrap(), b"untouched");
    }
}

#[test]
fn ready_input_applies_while_another_archive_waits_for_this_operation() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = dir.path().join("runtime");
    let (manifest, descriptor) = manifest(dir.path()).unwrap();
    let child = spawn(&manifest, &runtime).unwrap();
    wait_for(&dir.path().join("ready/.applied"));
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
    wait_for(&dir.path().join("ready/.applied"));
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
