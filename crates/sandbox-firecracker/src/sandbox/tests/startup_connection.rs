use super::*;

struct UnwindingStartObserver {
    entered: Option<tokio::sync::oneshot::Sender<()>>,
    release: std::sync::mpsc::Receiver<()>,
}

impl SandboxStartObserver for UnwindingStartObserver {
    fn record_stage(&mut self, stage: SandboxStartStage, _duration: Duration, success: bool) {
        if stage == SandboxStartStage::BackendLaunch {
            assert!(!success);
            self.entered.take().unwrap().send(()).unwrap();
            // One other runtime worker remains available for the real listener.
            // Dropping the sender also releases this callback on fixture panic.
            tokio::task::block_in_place(|| {
                let _ = self.release.recv();
            });
            panic!("injected startup observer panic");
        }
    }
}

async fn listener_exists(path: &Path, expected: bool) -> bool {
    tokio::time::timeout(Duration::from_secs(1), async {
        while path.try_exists().unwrap() != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn startup_unwind_retires_listener_and_handshake() {
    let workspace = tempfile::tempdir().unwrap();
    let mut retained = Vec::new();
    for restore in [false, true] {
        for accepted in [false, true] {
            let dir = workspace.path().join(format!("{restore}-{accepted}"));
            let mut sandbox = test_sandbox_with_state(SandboxState::Created);
            guest_rpc::prepare_socket_paths(&mut sandbox, &dir);
            if restore {
                sandbox.factory_config.snapshot = Some(crate::SnapshotConfig {
                    snapshot_path: dir.join("snapshot.bin"),
                    memory_path: dir.join("memory.bin"),
                    cow_path: dir.join("cow.img"),
                    drive_bind_path: dir.join("drive"),
                    home_drive_bind_path: dir.join("home"),
                    vsock_bind_dir: dir.join("snapshot-vsock"),
                });
            }
            let listener_path = std::path::PathBuf::from(format!(
                "{}_{}",
                sandbox.sock_paths.vsock().display(),
                guest_control_proto::VSOCK_PORT,
            ));
            let (release, released) = std::sync::mpsc::channel();
            let (entered, ready) = tokio::sync::oneshot::channel();
            let mut observer = UnwindingStartObserver {
                entered: Some(entered),
                release: released,
            };
            let startup =
                tokio::spawn(async move { sandbox.start_with_observer(&mut observer).await });
            tokio::time::timeout(Duration::from_secs(1), ready)
                .await
                .unwrap()
                .unwrap();
            assert!(listener_exists(&listener_path, true).await);
            let mut peer = if accepted {
                let peer = UnixStream::connect(&listener_path).await.unwrap();
                assert!(listener_exists(&listener_path, false).await);
                Some(peer)
            } else {
                None
            };

            // Unwind the real startup stack before its explicit error cleanup.
            release.send(()).unwrap();
            assert!(startup.await.unwrap_err().is_panic());
            let retired = if let Some(peer) = peer.as_mut() {
                let mut byte = [0];
                matches!(
                    tokio::time::timeout(Duration::from_secs(1), peer.read(&mut byte)).await,
                    Ok(Ok(0))
                )
            } else {
                listener_exists(&listener_path, false).await
            };
            if !retired {
                retained.push(format!("restore={restore},accepted={accepted}"));
                // Clean actual endpoints even in the unchanged-production
                // negative control, then report every mode/state observation.
                if peer.is_none() {
                    peer = Some(UnixStream::connect(&listener_path).await.unwrap());
                }
                let peer = peer.as_mut().unwrap();
                peer.shutdown().await.unwrap();
                let mut byte = [0];
                assert_eq!(
                    tokio::time::timeout(Duration::from_secs(1), peer.read(&mut byte))
                        .await
                        .unwrap()
                        .unwrap(),
                    0,
                );
                assert!(listener_exists(&listener_path, false).await);
            }
        }
    }
    assert!(
        retained.is_empty(),
        "startup unwind retained resources: {retained:?}",
    );
}
