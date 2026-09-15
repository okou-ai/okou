use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use guest_control_client::GuestControlClient;
use guest_control_proto::{ExecTermination, VSOCK_PORT};

use crate::support::{join_raw_guest_connection, wait_for_path};

#[tokio::test]
async fn decoded_files_cross_the_contained_bulk_input_boundary() {
    use guest_contracts::storage_files::{self, StorageFile};
    let directory = tempfile::tempdir().unwrap();
    let program = directory.path().join("helper");
    fs::write(
        &program,
        "#!/bin/sh\n[ \"$1\" = --storage-files-stdin ] || exit 42\ncat\n",
    )
    .unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
    let vsock = directory.path().join("vsock");
    let listener = format!("{}_{VSOCK_PORT}", vsock.display());
    let resources = directory.path().to_owned();
    let host =
        GuestControlClient::wait_for_connection(vsock.to_str().unwrap(), Duration::from_secs(5));
    let guest = async {
        wait_for_path(std::path::Path::new(&listener), Duration::from_secs(5)).await;
        std::thread::spawn(move || {
            let stream = guest_control_server::connect_unix(&listener)?;
            guest_control_server::handle_connection_with_test_storage_resources(
                stream, program, resources,
            )
        })
    };
    let (host, guest) = tokio::join!(host, guest);
    let host = host.unwrap();
    let files = vec![StorageFile {
        path: "file".into(),
        mode: 0o644,
        mtime: 1,
        content: vec![42; 200_000],
    }];
    let input =
        storage_files::encode_input(br#"{"storageMounts":[]}"#, &[("/mount", &files)]).unwrap();
    let result = host
        .guest_storage_manifest(&input, "test-run", "/run", 1000, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, input);
    assert!(result.stderr.is_empty());
    drop(host);
    join_raw_guest_connection(guest);
}

#[tokio::test]
async fn storage_resources_cross_the_real_client_server_boundary() {
    let directory = tempfile::tempdir().unwrap();
    let program = directory.path().join("helper");
    fs::write(
        &program,
        "#!/bin/sh\ncat >/dev/null\nprintf applied\nprintf warning >&2\n",
    )
    .unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(
        directory.path().join("cpu.stat"),
        "usage_usec 5100000\nnr_throttled 27\n",
    )
    .unwrap();
    fs::write(directory.path().join("memory.peak"), "268435456\n").unwrap();
    fs::write(directory.path().join("memory.high"), "max\n").unwrap();
    let vsock = directory.path().join("vsock");
    let listener = format!("{}_{VSOCK_PORT}", vsock.display());
    let resources = directory.path().to_owned();
    let host =
        GuestControlClient::wait_for_connection(vsock.to_str().unwrap(), Duration::from_secs(5));
    let guest = async {
        wait_for_path(std::path::Path::new(&listener), Duration::from_secs(5)).await;
        std::thread::spawn(move || {
            let stream = guest_control_server::connect_unix(&listener)?;
            guest_control_server::handle_connection_with_test_storage_resources(
                stream, program, resources,
            )
        })
    };
    let (host, guest) = tokio::join!(host, guest);
    let host = host.unwrap();
    for index in 0..2 {
        if index == 1 {
            fs::write(directory.path().join("cpu.stat"), "usage_usec malformed\n").unwrap();
        }
        let result = host
            .guest_storage_manifest(
                b"{}",
                "8d7a07c8-15b2-446f-9f47-36d32028baa6",
                "/run",
                1000,
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
        assert_eq!(result.stdout, b"applied");
        assert_eq!(result.stderr, b"warning");
        assert!(result.diagnostic.is_empty());
        let resources = result.resources.unwrap();
        assert_eq!(
            resources.cpu_usage_usec,
            if index == 0 { Some(5_100_000) } else { None }
        );
        assert_eq!(resources.memory_peak_bytes, Some(268_435_456));
        assert_eq!(resources.memory_current_bytes, None);
    }
    drop(host);
    join_raw_guest_connection(guest);
}
