use std::path::PathBuf;

use super::*;

#[test]
fn copy_temp_path_distinguishes_process_seq_and_nonce() {
    let host_path = PathBuf::from("/tmp/system.log");

    let base = copy_temp_path(&host_path, 101, 7, 1);
    assert_ne!(base, copy_temp_path(&host_path, 102, 7, 1));
    assert_ne!(base, copy_temp_path(&host_path, 101, 8, 1));
    assert_ne!(base, copy_temp_path(&host_path, 101, 7, 2));
    assert_eq!(
        base.file_name().and_then(|name| name.to_str()),
        Some(".system.log.vm0tmp-101-7-1")
    );
}

#[tokio::test]
async fn create_copy_temp_file_uses_unique_paths_for_same_seq() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "guest-control-client-copy-temp-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let host_path = dir.join("system.log");

    let (first_guard, first_file) = create_copy_temp_file(&host_path, 7).await.unwrap();
    let (second_guard, second_file) = create_copy_temp_file(&host_path, 7).await.unwrap();
    let first_path = first_guard.path().to_owned();
    let second_path = second_guard.path().to_owned();

    assert_ne!(first_path, second_path);
    assert!(first_path.exists());
    assert!(second_path.exists());
    drop(first_file);
    drop(second_file);
    drop(first_guard);
    drop(second_guard);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn create_copy_temp_file_removes_temp_when_async_waiter_is_cancelled() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "guest-control-client-copy-temp-cancellation-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let host_path = dir.join("system.log");

    runtime.block_on(async {
        let (created_tx, created_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let create_task = tokio::spawn(async move {
            create_copy_temp_file_with_validator(&host_path, 7, move |_file, path| {
                created_tx.send(path.to_owned()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
            .await
        });

        let temp_path = created_rx.await.unwrap();
        assert!(temp_path.exists());

        create_task.abort();
        match create_task.await {
            Ok(_) => panic!("temp creation task completed before cancellation"),
            Err(error) => assert!(error.is_cancelled()),
        }
        release_tx.send(()).unwrap();
        tokio::task::spawn_blocking(|| {}).await.unwrap();

        assert!(!temp_path.exists());
    });

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn create_copy_temp_file_removes_temp_when_validation_fails() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "guest-control-client-copy-temp-validation-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let host_path = dir.join("system.log");

    let result = create_copy_temp_file_with_validator(&host_path, 7, |_file, _path| {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "forced validation failure",
        ))
    })
    .await;
    let error = match result {
        Ok(_) => panic!("temp file validation unexpectedly succeeded"),
        Err(error) => error,
    };

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(std::fs::read_dir(&dir).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("vm0tmp")
    }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn host_temp_file_guard_removes_temp_on_drop() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "guest-control-client-temp-guard-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(".system.log.vm0tmp-guard");
    std::fs::write(&path, b"partial").unwrap();

    {
        let _guard = HostTempFileGuard::new(path.clone());
    }

    assert!(!path.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn copy_file_stream_settings_keep_configured_chunk_headroom() {
    // Actual guest reads may produce smaller frames, so bounded runtime
    // overflow handling remains the correctness guard.
    let configured_max_chunks =
        COPY_FILE_STREAM_MAX_BYTES.div_ceil(COPY_FILE_STREAM_CHUNK_LIMIT as u64);
    assert!(configured_max_chunks < COPY_FILE_STREAM_QUEUE_CAPACITY as u64);
    assert_eq!(
        COPY_FILE_STREAM_QUEUE_CAPACITY,
        exec_operation::test_support::MAX_STREAM_CAPACITY
    );
}
