use super::*;
use serde_json::json;
use std::sync::mpsc;

fn fixture() -> Result<(tempfile::TempDir, Manifest, PathBuf), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let runtime = dir.path().join("runtime");
    let manifest = serde_json::from_value(json!({
        "storageMounts": [{"mountPath":dir.path().join("input"), "archiveUrl":"file:///tmp/pending.tar.gz"}],
        "archiveReadiness":{"id":uuid::Uuid::new_v4(),"sources":["file:///tmp/pending.tar.gz"]}
    }))?;
    Ok((dir, manifest, runtime))
}

#[test]
fn publication_before_and_after_watcher_start_is_observed_and_owner_retires() {
    for publication in [0, 1, 2] {
        let (_dir, manifest, runtime) = fixture().unwrap();
        let descriptor = manifest.archive_readiness.as_ref().unwrap();
        if publication == 0 {
            runtime_paths::write_private_new(descriptor.ready_path(&runtime, 0), []).unwrap();
        }
        let readiness = Readiness::prepare(&manifest, Some(&runtime))
            .unwrap()
            .unwrap();
        let gate = readiness.gate("file:///tmp/pending.tar.gz").unwrap();
        assert_eq!(gate.load(Ordering::Acquire), publication == 0);
        if publication == 1 {
            runtime_paths::write_private_new(descriptor.ready_path(&runtime, 0), []).unwrap();
        }
        let (tx, rx) = mpsc::channel();
        let mut watcher = readiness
            .watch(move |event| {
                tx.send(event).unwrap();
            })
            .unwrap();
        if publication == 2 {
            runtime_paths::write_private_new(descriptor.ready_path(&runtime, 0), []).unwrap();
        }
        if publication != 0 {
            rx.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        }
        assert!(gate.load(Ordering::Acquire));
        watcher.finish().unwrap();
        // Channel disconnection proves the closure's owned worker has retired.
        while rx.try_recv().is_ok() {}
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1)).unwrap_err(),
            mpsc::RecvTimeoutError::Disconnected
        );
        watcher.finish().unwrap();
    }
}

#[test]
fn producer_abort_and_deadline_fail_and_join_the_owner() {
    for abort in [false, true] {
        let (_dir, manifest, runtime) = fixture().unwrap();
        let timeout = if abort {
            Duration::from_secs(2)
        } else {
            Duration::from_millis(30)
        };
        let readiness = Readiness::prepare_with_timeout(&manifest, Some(&runtime), timeout)
            .unwrap()
            .unwrap();
        let (tx, rx) = mpsc::channel();
        let mut watcher = readiness
            .watch(move |event| {
                tx.send(event).unwrap();
            })
            .unwrap();
        if abort {
            runtime_paths::write_private_new(
                manifest
                    .archive_readiness
                    .as_ref()
                    .unwrap()
                    .failed_path(&runtime),
                [],
            )
            .unwrap();
        }
        let error = loop {
            if let Err(error) = rx.recv_timeout(Duration::from_secs(2)).unwrap() {
                break error;
            }
        };
        assert_eq!(
            error.kind(),
            if abort {
                io::ErrorKind::Other
            } else {
                io::ErrorKind::TimedOut
            }
        );
        assert!(watcher.finish().is_err());
        watcher.finish().unwrap();
    }
}

#[test]
fn other_operation_markers_do_not_release_a_source() {
    let (_dir, manifest, runtime) = fixture().unwrap();
    let mut previous = manifest.archive_readiness.as_ref().unwrap().clone();
    previous.id = uuid::Uuid::new_v4();
    runtime_paths::write_private_new(previous.ready_path(&runtime, 0), []).unwrap();
    let readiness = Readiness::prepare(&manifest, Some(&runtime))
        .unwrap()
        .unwrap();
    assert!(
        !readiness
            .gate("file:///tmp/pending.tar.gz")
            .unwrap()
            .load(Ordering::Acquire)
    );
}

#[test]
fn invalid_markers_and_runtime_aliases_fail_before_input_cleanup() {
    for kind in [
        "contents",
        "symlink",
        "directory",
        "operation-symlink",
        "runtime-alias",
        "dangling-alias",
    ] {
        let (dir, mut manifest, runtime) = fixture().unwrap();
        let target = dir.path().join("input");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("keep"), "original").unwrap();
        manifest
            .cleanup_paths
            .push(target.to_string_lossy().into_owned());
        let descriptor = manifest.archive_readiness.as_ref().unwrap();
        runtime_paths::ensure_dir(descriptor.directory(&runtime)).unwrap();
        let marker = descriptor.ready_path(&runtime, 0);
        match kind {
            "contents" => std::fs::write(&marker, "not a publication").unwrap(),
            "symlink" => std::os::unix::fs::symlink(target.join("keep"), &marker).unwrap(),
            "directory" => std::fs::create_dir(&marker).unwrap(),
            "operation-symlink" => {
                std::fs::remove_dir(descriptor.directory(&runtime)).unwrap();
                std::os::unix::fs::symlink(&target, descriptor.directory(&runtime)).unwrap();
            }
            _ => {
                let alias = dir.path().join("alias");
                let destination = if kind == "runtime-alias" {
                    runtime.clone()
                } else {
                    runtime.join("not-created")
                };
                std::os::unix::fs::symlink(destination, &alias).unwrap();
                manifest
                    .cleanup_paths
                    .push(alias.to_string_lossy().into_owned());
            }
        }
        assert!(
            !crate::run_manifest_bytes_in_runtime(
                &serde_json::to_vec(&manifest).unwrap(),
                &runtime
            ),
            "{kind}"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("keep")).unwrap(),
            "original"
        );
    }
}

#[test]
fn abort_after_all_sources_ready_is_still_observed() {
    let (_dir, manifest, runtime) = fixture().unwrap();
    let descriptor = manifest.archive_readiness.as_ref().unwrap();
    runtime_paths::write_private_new(descriptor.ready_path(&runtime, 0), []).unwrap();
    let readiness = Readiness::prepare(&manifest, Some(&runtime))
        .unwrap()
        .unwrap();
    let (tx, rx) = mpsc::channel();
    let mut watcher = readiness
        .watch(move |event| {
            let _ = tx.send(event);
        })
        .unwrap();
    runtime_paths::write_private_new(descriptor.failed_path(&runtime), []).unwrap();
    assert!(rx.recv_timeout(Duration::from_secs(2)).unwrap().is_err());
    assert!(watcher.finish().is_err());
}

#[test]
fn missing_runtime_cannot_enable_pending_archives() {
    let (_dir, manifest, _runtime) = fixture().unwrap();
    assert!(Readiness::prepare(&manifest, None).is_err());
    let ordinary: Manifest = serde_json::from_value(json!({"storageMounts":[]})).unwrap();
    assert!(Readiness::prepare(&ordinary, None).unwrap().is_none());
}

#[test]
fn withdrawn_publication_or_removed_control_directory_fails_the_live_owner() {
    for remove_directory in [false, true] {
        let (_dir, manifest, runtime) = fixture().unwrap();
        let descriptor = manifest.archive_readiness.as_ref().unwrap();
        if !remove_directory {
            runtime_paths::write_private_new(descriptor.ready_path(&runtime, 0), []).unwrap();
        }
        let readiness = Readiness::prepare(&manifest, Some(&runtime))
            .unwrap()
            .unwrap();
        let (tx, rx) = mpsc::channel();
        let mut watcher = readiness
            .watch(move |event| {
                let _ = tx.send(event);
            })
            .unwrap();
        if remove_directory {
            std::fs::remove_dir(descriptor.directory(&runtime)).unwrap();
        } else {
            std::fs::remove_file(descriptor.ready_path(&runtime, 0)).unwrap();
        }
        assert!(rx.recv_timeout(Duration::from_secs(2)).unwrap().is_err());
        assert!(watcher.finish().is_err());
    }
}
