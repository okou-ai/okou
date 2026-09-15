//! Pending conflicts must preserve overlay order without blocking independent work.

use super::{
    COMPLETION_TIMEOUT, REQUEST_START_TIMEOUT, ReleaseGate, RequestObservations, path_to_string,
    serve_archive, serve_blocked_archive, spawn_guest_storage_apply, wait_for_event,
};
use crate::support::create_tar_gz;
use httpmock::MockServer;
use std::path::{Path, PathBuf};
use std::sync::mpsc;

fn assert_pending_overlay_order(
    dir: &tempfile::TempDir,
    mounts: [PathBuf; 4],
    physical_parent: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let servers: [MockServer; 4] = std::array::from_fn(|_| MockServer::start());
    let archives = [
        create_tar_gz(&[("a.txt", b"blocker")])?,
        create_tar_gz(&[("b/value.txt", b"parent")])?,
        create_tar_gz(&[("value.txt", b"child")])?,
        create_tar_gz(&[("data.txt", b"independent")])?,
    ];
    let names = ["blocker", "parent", "child", "independent"];
    let observations = RequestObservations::new();
    let blocker_release = ReleaseGate::new();
    let (event_tx, event_rx) = mpsc::channel();
    for ((server, body), name) in servers.iter().zip(archives).zip(names) {
        let event_tx = event_tx.clone();
        let on_start = move || {
            event_tx
                .send(name.to_owned())
                .map_err(|error| format!("failed to send {name} start: {error}"))
        };
        if name == "blocker" {
            serve_blocked_archive(
                server,
                "/archive.tar.gz",
                body,
                on_start,
                blocker_release.waiter(),
                name.to_owned(),
                observations.clone(),
            );
        } else {
            serve_archive(
                server,
                "/archive.tar.gz",
                body,
                on_start,
                name.to_owned(),
                observations.clone(),
            );
        }
    }
    let storages = mounts
        .iter()
        .zip(&servers)
        .map(|(mount, server)| Ok((path_to_string(mount)?, server.url("/archive.tar.gz"))))
        .collect::<std::io::Result<Vec<_>>>()?;
    let execution = spawn_guest_storage_apply("pending-overlay-order", dir, &storages)?;

    // D must start while A is held: this also rejects a global-FIFO fix.
    let mut seen = Vec::new();
    for name in ["blocker", "independent"] {
        wait_for_event(&event_rx, &mut seen, name, REQUEST_START_TIMEOUT)?;
    }
    blocker_release.release_one();
    execution.wait_for_completion(
        "pending-overlay-order",
        COMPLETION_TIMEOUT,
        &blocker_release,
        &observations,
    )?;

    let starts = observations.snapshot().started;
    let parent_start = starts
        .iter()
        .position(|name| name == "parent")
        .ok_or("parent request did not start")?;
    let child_start = starts
        .iter()
        .position(|name| name == "child")
        .ok_or("child request did not start")?;
    let final_content = std::fs::read_to_string(physical_parent.join("b/value.txt"))?;
    assert_eq!(
        (parent_start < child_start, final_content.as_str()),
        (true, "child"),
        "pending parent must precede its child; starts={starts:?}"
    );
    assert_eq!(starts.len(), 4, "unexpected download count: {starts:?}");
    assert_eq!(
        std::fs::read_to_string(physical_parent.join("a/a.txt"))?,
        "blocker"
    );
    assert_eq!(
        std::fs::read_to_string(mounts[3].join("data.txt"))?,
        "independent"
    );
    Ok(())
}

#[test]
fn pending_parent_precedes_later_child_while_independent_download_starts() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("mount");
    let mounts = [
        parent.join("a"),
        parent.clone(),
        parent.join("b"),
        dir.path().join("independent"),
    ];
    assert_pending_overlay_order(&dir, mounts, &parent).unwrap();
}

#[cfg(unix)]
#[test]
fn canonical_pending_parent_precedes_later_aliased_child() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("physical");
    let mounts = [
        dir.path().join("blocker-alias"),
        dir.path().join("parent-alias"),
        dir.path().join("child-alias"),
        dir.path().join("independent"),
    ];
    for (target, alias) in [parent.join("a"), parent.clone(), parent.join("b")]
        .iter()
        .zip(&mounts)
    {
        std::fs::create_dir_all(target).unwrap();
        std::os::unix::fs::symlink(target, alias).unwrap();
    }
    assert_pending_overlay_order(&dir, mounts, &parent).unwrap();
}
