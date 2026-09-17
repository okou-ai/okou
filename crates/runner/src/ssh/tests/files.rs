use runner_rpc_proto::{
    Response,
    stream::{Frame, Reader, Writer},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    path::Path,
    sync::atomic::Ordering,
    time::Duration,
};
use tokio::io::{AsyncWriteExt, DuplexStream};

use super::{
    harness::{CONNECTION, Harness, PASSWORD, Reply},
    wait_for,
};

async fn open(h: &Harness, method: &str, params: Value, remaining: u64) -> DuplexStream {
    let mut guest = h.open().await;
    let request = json!({"version":1,"method":format!("ssh.file.{method}"),"remaining_ms":remaining,"params":params}).to_string();
    guest.write_u32(request.len() as u32).await.unwrap();
    guest.write_all(request.as_bytes()).await.unwrap();
    guest
}

fn upload_params(path: &Path, size: usize, overwrite: bool) -> Value {
    json!({"sshConnectionId":CONNECTION,"remotePath":path,"size":size,"overwrite":overwrite})
}

async fn response(guest: impl tokio::io::AsyncRead + Unpin) -> (Value, Vec<u8>) {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut reader = Reader::responses(guest);
        let mut outcome = Value::Null;
        let mut data = Vec::new();
        while let Some(frame) = reader.next().await.unwrap() {
            match frame {
                Frame::Data(bytes) => data.extend(bytes),
                Frame::End => {}
                Frame::Control(Response::Result { data }) => {
                    outcome = serde_json::from_str(data.get()).unwrap()
                }
                Frame::Control(other) => outcome = serde_json::to_value(other).unwrap(),
            }
        }
        (outcome, data)
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn direct_file_transfer_completes_across_notification_outages() {
    let mut h = Harness::new(Reply::Sftp("normal")).await;
    let _resolve = h.resolve(h.credential(true)).await;
    upload_across_notification_outages(&h).await;
    h.shutdown().await;
}

#[tokio::test]
async fn active_upload_outlives_the_common_rpc_setup_deadline() {
    let mut h = Harness::new(Reply::Sftp("normal")).await;
    let _resolve = h.resolve(h.credential(true)).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file");
    let data = b"transfer after the setup deadline";
    let guest = open(
        &h,
        "upload",
        upload_params(&path, data.len(), false),
        900_000,
    )
    .await;
    let (read, write) = tokio::io::split(guest);
    // Remote staging proves setup finished before crossing its deadline.
    wait_for(|| std::fs::read_dir(dir.path()).unwrap().count() == 1).await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(61)).await;
    tokio::time::resume();
    let mut writer = Writer::input(write);
    writer.send(&Frame::Data(data.to_vec())).await.unwrap();
    writer.send(&Frame::End).await.unwrap();
    let (outcome, _) = response(read).await;
    assert_eq!(outcome["type"], "completed");
    assert_eq!(outcome["sha256"], hex::encode(Sha256::digest(data)));
    assert_eq!(std::fs::read(&path).unwrap(), data);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    h.shutdown().await;
}

pub(super) async fn upload_across_notification_outages(h: &Harness) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file");
    let data = b"bytes across a notification outage";
    let mut notifications = h.notifications();
    let guest = open(
        h,
        "upload",
        upload_params(&path, data.len(), false),
        900_000,
    )
    .await;
    let (read, write) = tokio::io::split(guest);
    // Actual remote staging proves SFTP has started before transport events arrive.
    wait_for(|| std::fs::read_dir(dir.path()).unwrap().count() == 1).await;
    for event in super::notifications::outage_events() {
        notifications.send(event).await;
    }
    drop(notifications);
    let mut writer = Writer::input(write);
    writer.send(&Frame::Data(data.to_vec())).await.unwrap();
    writer.send(&Frame::End).await.unwrap();
    let (outcome, _) = response(read).await;
    assert_eq!(outcome["type"], "completed");
    assert_eq!(outcome["sha256"], hex::encode(Sha256::digest(data)));
    assert_eq!(std::fs::read(&path).unwrap(), data);
    // A new transfer is also authorized without notification readiness.
    let (outcome, received) = download(h, &path).await;
    assert_eq!(outcome["type"], "completed");
    assert_eq!(received, data);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

pub(super) async fn upload(h: &Harness, path: &Path, bytes: &[u8], overwrite: bool) -> Value {
    let guest = open(
        h,
        "upload",
        upload_params(path, bytes.len(), overwrite),
        900_000,
    )
    .await;
    let (read, write) = tokio::io::split(guest);
    let send = async {
        let mut writer = Writer::input(write);
        for chunk in bytes.chunks(32768) {
            if writer.send(&Frame::Data(chunk.to_vec())).await.is_err() {
                return;
            }
        }
        let _ = writer.send(&Frame::End).await;
    };
    let ((outcome, data), ()) = tokio::join!(response(read), send);
    assert!(data.is_empty());
    outcome
}

pub(super) async fn download(h: &Harness, path: &Path) -> (Value, Vec<u8>) {
    response(
        open(
            h,
            "download",
            json!({"sshConnectionId":CONNECTION,"remotePath":path}),
            900_000,
        )
        .await,
    )
    .await
}

async fn roundtrip(mode: &'static str) {
    let mut h = Harness::new(Reply::Sftp(mode)).await;
    let mut credential = h.credential(true);
    credential.as_object_mut().unwrap().remove("privateKey");
    credential.as_object_mut().unwrap().remove("passphrase");
    credential["outcome"] = json!("resolved_password");
    credential["password"] = json!(PASSWORD);
    let _resolve = h.resolve(credential).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("literal $(touch nope); ☃ file");
    for size in [0, 258, 4 * 1024 * 1024 + 19] {
        let bytes: Vec<u8> = (0..size).map(|i| (i % 256) as u8).collect();
        let outcome = upload(&h, &path, &bytes, size != 0).await;
        assert_eq!(outcome["type"], "completed", "{outcome}");
        assert_eq!(outcome["effects"], "completed");
        assert_eq!(outcome["sha256"], hex::encode(Sha256::digest(&bytes)));
        assert!(outcome["residue"].is_null());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let (outcome, received) = download(&h, &path).await;
        assert_eq!(outcome["type"], "completed", "{outcome}");
        assert_eq!(outcome["sha256"], hex::encode(Sha256::digest(&bytes)));
        assert_eq!(received, bytes);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    wait_for(|| h.observed.reservations.load(Ordering::SeqCst) == 0).await;
    assert!(h.observed.commands.lock().unwrap().is_empty());
    h.shutdown().await;
}

#[tokio::test]
async fn binary_empty_and_large_files_roundtrip_with_password_and_opaque_handles() {
    roundtrip("normal").await;
}

#[tokio::test]
#[ignore = "explicit interoperability lane requires the OpenSSH sftp-server executable"]
async fn openssh_server_interoperability() {
    roundtrip("openssh").await;
}

#[tokio::test]
async fn no_clobber_symlinks_and_non_regular_paths_never_modify_destinations() {
    let h = Harness::new(Reply::Sftp("normal")).await;
    let _resolve = h.resolve(h.credential(true)).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("original");
    std::fs::write(&path, b"original").unwrap();
    let link = dir.path().join("link");
    symlink(&path, &link).unwrap();
    for (path, overwrite, reason) in [
        (&path, false, "destination_exists"),
        (&link, false, "not_regular_file"),
        (&link, true, "not_regular_file"),
    ] {
        let outcome = upload(&h, path, b"replacement", overwrite).await;
        assert_eq!(outcome["failure_reason"], reason, "{outcome}");
        assert_eq!(outcome["effects"], "not_started");
    }
    for path in [&link, &dir.path().to_path_buf()] {
        assert_eq!(
            download(&h, path).await.0["failure_reason"],
            "not_regular_file"
        );
    }
    assert_eq!(std::fs::read(&path).unwrap(), b"original");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
}

#[tokio::test]
async fn native_stream_helper_preserves_early_file_rejection_during_upload() {
    let h = Harness::new(Reply::Sftp("normal")).await;
    let _resolve = h.resolve(h.credential(true)).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("original");
    std::fs::write(&path, b"keep").unwrap();
    let mut input = Vec::new();
    let request = runner_rpc_proto::parse_request(
        json!({"version":1,"method":"ssh.file.upload","params":upload_params(&path, 4 * 1024 * 1024, false)})
            .to_string()
            .as_bytes(),
    )
    .unwrap();
    runner_rpc_proto::write_request(&mut input, &request)
        .await
        .unwrap();
    let mut writer = Writer::input(&mut input);
    for _ in 0..128 {
        writer.send(&Frame::Data(vec![255; 32768])).await.unwrap();
    }
    writer.send(&Frame::End).await.unwrap();
    let mut output = Vec::new();
    assert!(
        runner_rpc_client::stream::run_with_io(input.as_slice(), &mut output, || async {
            Ok(h.open().await)
        })
        .await
        .unwrap()
    );
    let outcome = response(output.as_slice()).await.0;
    assert_eq!(outcome["failure_reason"], "destination_exists", "{outcome}");
    assert_eq!(outcome["effects"], "not_started");
    assert_eq!(std::fs::read(&path).unwrap(), b"keep");
    wait_for(|| h.observed.reservations.load(Ordering::SeqCst) == 0).await;
}

#[tokio::test]
async fn sftp_failures_are_typed_and_never_publish_partial_files() {
    for (mode, reason) in [
        ("unsupported", "unsupported_operation"),
        ("denied", "permission_denied"),
        ("oversized", "protocol"),
        ("mismatched", "protocol"),
    ] {
        let h = Harness::new(Reply::Sftp(mode)).await;
        let _resolve = h.resolve(h.credential(true)).await;
        let dir = tempfile::tempdir().unwrap();
        let outcome = upload(&h, &dir.path().join("file"), b"content canary", false).await;
        assert_eq!(outcome["failure_reason"], reason, "{mode}: {outcome}");
        assert!(!outcome.to_string().contains("diagnostic canary"));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}

#[tokio::test]
async fn lost_acknowledgements_and_cleanup_failure_preserve_honest_effects_and_residue() {
    for (mode, effects, completed, published) in [
        ("lost-create", "not_started", false, false),
        ("lost-publish", "unknown", false, true),
        ("cleanup-denied", "completed", true, true),
    ] {
        let h = Harness::new(Reply::Sftp(mode)).await;
        let _resolve = h.resolve(h.credential(true)).await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        let outcome = upload(&h, &path, b"bytes", false).await;
        assert_eq!(outcome["effects"], effects, "{mode}: {outcome}");
        assert_eq!(outcome["type"] == "completed", completed);
        assert_eq!(path.exists(), published);
        assert!(Path::new(outcome["residue"].as_str().unwrap()).is_dir());
        if published {
            assert_eq!(std::fs::read(path).unwrap(), b"bytes");
        }
    }
}

#[tokio::test]
async fn missing_mutated_and_oversized_sources_fail_without_success() {
    let h = Harness::new(Reply::Sftp("mutate")).await;
    let _resolve = h.resolve(h.credential(true)).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file");
    assert_eq!(
        download(&h, &path).await.0["failure_reason"],
        "path_not_found"
    );
    std::fs::write(&path, b"data").unwrap();
    assert_eq!(
        download(&h, &path).await.0["failure_reason"],
        "source_changed"
    );
    std::fs::File::create(&path)
        .unwrap()
        .set_len(1_073_741_825)
        .unwrap();
    let outcome = download(&h, &path).await.0;
    assert_eq!(outcome["failure_reason"], "file_too_large");
    assert_eq!(outcome["actual_bytes"], 1_073_741_825_u64);
    assert_eq!(outcome["limits"]["max_file_bytes"], 1_073_741_824_u64);
}

#[tokio::test]
async fn transfer_capacity_and_invalidation_apply_without_subscription_readiness() {
    let mut h = Harness::new(Reply::Sftp("normal")).await;
    let resolve = h.resolve(h.credential(true)).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file");
    let first = open(&h, "upload", upload_params(&path, 5, false), 900_000).await;
    let second = open(&h, "upload", upload_params(&path, 5, false), 900_000).await;
    wait_for(|| std::fs::read_dir(dir.path()).unwrap().count() == 2).await;
    assert_eq!(
        download(&h, &path).await.0["failure_reason"],
        "transfer_limit"
    );
    resolve.assert_calls_async(1).await;
    let mut notifications = h.notifications();
    for event in super::notifications::outage_events() {
        notifications.send(event).await;
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }
    notifications
        .send(Some(ably_subscriber::Event::Message(
            ably_subscriber::Message {
                name: Some("ssh-authority-invalidated".into()),
                data: json!({"runId":h.run,"connectionId":CONNECTION}),
                id: None,
                client_id: None,
                timestamp: None,
            },
        )))
        .await;
    for stream in [first, second] {
        let outcome = response(stream).await.0;
        assert_eq!(outcome["failure_reason"], "configuration_changed");
        assert_eq!(outcome["effects"], "not_started");
    }
    assert!(!path.exists());
    wait_for(|| h.observed.reservations.load(Ordering::SeqCst) == 0).await;
    h.shutdown().await;
}

#[tokio::test]
async fn size_and_request_validation_precede_credential_resolution() {
    let h = Harness::new(Reply::Sftp("normal")).await;
    let resolve = h.resolve(h.credential(true)).await;
    let outcome = response(
        open(
            &h,
            "upload",
            upload_params(Path::new("/unused"), 1_073_741_825, false),
            900_000,
        )
        .await,
    )
    .await
    .0;
    assert_eq!(outcome["failure_reason"], "file_too_large");
    for path in ["", "/", "/file/", "/file/..", "a\0b"] {
        let outcome = download(&h, Path::new(path)).await.0;
        assert_eq!(outcome["code"], "invalid_request");
    }
    resolve.assert_calls_async(0).await;
}

#[tokio::test]
async fn incomplete_and_expired_uploads_clean_only_owned_staging_and_never_publish() {
    let h = Harness::new(Reply::Sftp("normal")).await;
    let _resolve = h.resolve(h.credential(true)).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file");
    let sentinel = dir.path().join("unrelated");
    std::fs::write(&sentinel, b"keep").unwrap();
    for expired in [false, true] {
        let guest = open(
            &h,
            "upload",
            upload_params(&path, 5, false),
            if expired { 4000 } else { 900_000 },
        )
        .await;
        let (read, write) = tokio::io::split(guest);
        let mut writer = Writer::input(write);
        writer.send(&Frame::Data(b"few".to_vec())).await.unwrap();
        if !expired {
            writer.send(&Frame::End).await.unwrap();
        }
        let outcome = response(read).await.0;
        assert_eq!(
            outcome["failure_reason"],
            if expired {
                "timed_out"
            } else {
                "source_changed"
            },
            "{outcome}"
        );
        assert_eq!(outcome["effects"], "not_started");
        assert!(outcome["residue"].is_null(), "{outcome}");
        assert!(!path.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"keep");
    }
}

#[tokio::test]
async fn subsystem_refusal_records_authenticated_connection_not_a_connectivity_warning() {
    let mut h = Harness::new(Reply::Reject).await;
    let dispatcher = h.take_dispatcher();
    let _resolve = h.resolve(h.credential(true)).await;
    let observed = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/ssh/observations", h.run))
                .json_body_includes(
                    json!({"expectedGeneration":7,"failureReason":null}).to_string(),
                );
            then.status(200).json_body(json!({"outcome":"recorded"}));
        })
        .await;
    assert_eq!(
        download(&h, Path::new("/unused")).await.0["failure_reason"],
        "subsystem_unavailable"
    );
    dispatcher.shutdown().await;
    observed.assert_calls_async(1).await;
    assert!(h.observed.commands.lock().unwrap().is_empty());
}

#[tokio::test]
async fn run_cancellation_releases_the_reservation_and_does_not_reconnect_for_cleanup() {
    let mut h = Harness::new(Reply::Sftp("normal")).await;
    let _resolve = h.resolve(h.credential(true)).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file");
    let guest = open(&h, "upload", upload_params(&path, 5, false), 900_000).await;
    wait_for(|| std::fs::read_dir(dir.path()).unwrap().count() == 1).await;
    h.cancel.cancel();
    let outcome = response(guest).await.0;
    assert_eq!(outcome["failure_reason"], "cancelled");
    assert_eq!(outcome["effects"], "not_started");
    assert!(outcome["residue"].is_string());
    assert!(!path.exists());
    wait_for(|| h.observed.reservations.load(Ordering::SeqCst) == 0).await;
    h.shutdown().await;
    assert_eq!(h.observed.attempts.lock().unwrap().len(), 1);
}
