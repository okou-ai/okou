use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::os::unix::net::UnixListener;
use std::sync::mpsc;
use std::time::Duration;

use flate2::Compression;
use flate2::write::GzEncoder;
use nix::sys::stat::Mode;
use tokio::sync::oneshot;
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

#[test]
fn kvm_permission_denied_reports_least_privilege_guidance() {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());

    tracing::subscriber::with_default(subscriber, || {
        tracing::callsite::rebuild_interest_cache();
        report_kvm_check(Err(std::io::Error::from(
            std::io::ErrorKind::PermissionDenied,
        )));
    });

    let events = captured.entries();
    assert_eq!(events.len(), 1, "captured events: {events:#?}");
    let event = &events[0];
    assert_eq!(event.level, Level::WARN);
    let message = event
        .fields
        .get("message")
        .unwrap_or_else(|| panic!("missing message field; event={event:#?}"));
    assert!(message.contains("root:kvm"));
    assert!(message.contains("0660"));
    assert!(message.contains("host/container KVM access"));
    assert!(message.contains("permission denied"));
    assert!(!message.contains("chmod 666"));
    assert!(!message.contains("0666"));
}

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn produced_artifact(path: &Path, content: &[u8]) -> ProducedSetupArtifact {
    let mut file = create_setup_temp_file_at(path).unwrap();
    std::io::Write::write_all(&mut file, content).unwrap();
    std::io::Write::flush(&mut file).unwrap();
    ProducedSetupArtifact {
        path: TempPath::try_from_path(path).unwrap(),
        file,
        sha256: hex::encode(Sha256::digest(content)),
    }
}

fn artifact_identity(content: &[u8]) -> SetupArtifactIdentity {
    SetupArtifactIdentity {
        size: u64::try_from(content.len()).unwrap(),
        sha256: hex::encode(Sha256::digest(content)),
    }
}

fn tarball_with_entry(entry_name: &str, content: &[u8]) -> Vec<u8> {
    let encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut builder = tar::Builder::new(encoder);
    let mut header = tar::Header::new_gnu();
    header.set_size(content.len() as u64);
    header.set_mode(0o755);
    header.set_cksum();
    builder
        .append_data(&mut header, entry_name, content)
        .unwrap();
    builder.into_inner().unwrap().finish().unwrap()
}

async fn wait_until_path_is_removed(path: &Path) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while path.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("setup temp was not removed");
}

#[test]
fn check_architecture_returns_current() {
    let arch = check_architecture().unwrap();
    assert!(
        arch == "x86_64" || arch == "aarch64",
        "unexpected arch: {arch}"
    );
    assert_eq!(arch, std::env::consts::ARCH);
}

#[test]
fn select_sha_x86_64() {
    assert_eq!(select_sha("x86_64", "sha_x86", "sha_arm"), "sha_x86");
}

#[test]
fn select_sha_aarch64() {
    assert_eq!(select_sha("aarch64", "sha_x86", "sha_arm"), "sha_arm");
}

#[test]
fn verify_sha256_matching() {
    let result = verify_sha256("abc123", "abc123", "test");
    assert!(result.is_ok());
}

#[test]
fn verify_sha256_mismatch() {
    let result = verify_sha256("abc123", "def456", "test");
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("SHA256 mismatch"), "got: {err}");
    assert!(err.contains("abc123"));
    assert!(err.contains("def456"));
}

#[test]
fn check_system_dependencies_only_returns_known_deps() {
    let missing = check_system_dependencies();
    let known = start_system_dependencies();
    for dep in &missing {
        assert!(
            known.contains(dep),
            "unexpected dependency reported as missing: {dep}"
        );
    }
}

#[test]
fn runner_start_dependencies_include_openssl_for_proxy_ca_validation() {
    assert!(RUNNER_START_SYSTEM_DEPENDENCIES.contains(&"openssl"));
    assert!(!OTHER_COMMAND_SYSTEM_DEPENDENCIES.contains(&"openssl"));
}

#[test]
fn start_dependencies_include_sandbox_runtime_commands() {
    let start_dependencies = start_system_dependencies();
    for dependency in sandbox_firecracker::runtime_required_commands() {
        assert!(start_dependencies.contains(&dependency));
    }
    assert!(start_dependencies.contains(&"conntrack"));
}

#[test]
fn ensure_setup_shared_dir_creates_shared_directory() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("setup").join("firecracker");

    ensure_setup_shared_dir(&path).unwrap();

    assert_eq!(mode(&path), runner_host::host_file::SHARED_TRUSTED_DIR_MODE);
    assert!(path.is_dir());
}

#[test]
fn ensure_setup_shared_dir_normalizes_existing_directory() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("setup");
    std::fs::create_dir(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();

    ensure_setup_shared_dir(&path).unwrap();

    assert_eq!(mode(&path), runner_host::host_file::SHARED_TRUSTED_DIR_MODE);
}

#[test]
fn ensure_setup_shared_dir_rejects_parent_segment_before_creating_missing_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("base");
    std::fs::create_dir(&base).unwrap();

    let error = ensure_setup_shared_dir(&base.join("missing").join("..").join("leaf")).unwrap_err();

    assert!(
        matches!(error, RunnerError::Internal(_)),
        "unexpected error: {error}"
    );
    assert!(
        error.to_string().contains("parent directory segment"),
        "unexpected error: {error}"
    );
    assert!(!base.join("missing").exists());
    assert!(!base.join("leaf").exists());
}

#[test]
fn ensure_setup_shared_dir_rejects_final_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let link = dir.path().join("link");
    std::fs::create_dir(&target).unwrap();
    symlink(&target, &link).unwrap();

    let error = ensure_setup_shared_dir(&link).unwrap_err();

    assert!(
        error.to_string().contains("symlink") || error.to_string().contains("not a directory"),
        "unexpected error: {error}"
    );
}

#[test]
fn ensure_setup_shared_dir_rejects_intermediate_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let link = dir.path().join("link");
    std::fs::create_dir(&target).unwrap();
    symlink(&target, &link).unwrap();

    let error = ensure_setup_shared_dir(&link.join("child")).unwrap_err();

    assert!(
        error.to_string().contains("symlink") || error.to_string().contains("not a directory"),
        "unexpected error: {error}"
    );
    assert!(!target.join("child").exists());
}

#[test]
fn ensure_setup_shared_dir_rejects_unsafe_writable_parent() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("unsafe");
    std::fs::create_dir(&parent).unwrap();
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o777)).unwrap();

    let error = ensure_setup_shared_dir(&parent.join("child")).unwrap_err();

    assert!(
        error.to_string().contains("group/other writable"),
        "unexpected error: {error}"
    );
    assert!(!parent.join("child").exists());
}

#[test]
fn create_setup_temp_file_at_creates_private_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".artifact.tmp");

    let file = create_setup_temp_file_at(&path).unwrap();
    drop(file);

    assert_eq!(mode(&path), SETUP_TEMP_ARTIFACT_MODE);
}

#[test]
fn create_setup_temp_file_at_rejects_stale_symlink_without_following() {
    let dir = tempfile::tempdir().unwrap();
    let outside = dir.path().join("outside");
    let link = dir.path().join(".artifact.tmp");
    std::fs::write(&outside, b"outside").unwrap();
    symlink(&outside, &link).unwrap();

    let error = create_setup_temp_file_at(&link).unwrap_err();

    assert!(
        error.to_string().contains("File exists")
            || error.to_string().contains("file exists")
            || error.to_string().contains("exists"),
        "unexpected error: {error}"
    );
    assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
    assert!(
        std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[tokio::test]
async fn file_sha256_computes_correctly() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.bin");
    std::fs::write(&path, b"hello world").unwrap();
    let sha = file_sha256(&path).await.unwrap();
    // SHA256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    assert_eq!(
        sha,
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    );
}

#[tokio::test]
async fn file_sha256_empty_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("empty.bin");
    std::fs::write(&path, b"").unwrap();
    let sha = file_sha256(&path).await.unwrap();
    // SHA256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    assert_eq!(
        sha,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[tokio::test]
async fn ensure_artifact_installed_returns_false_for_missing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nonexistent");
    let expected = artifact_identity(b"anything");
    assert!(
        !ensure_artifact_installed(&path, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn ensure_artifact_installed_returns_false_for_wrong_sha() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file.bin");
    std::fs::write(&path, b"content").unwrap();
    let expected = SetupArtifactIdentity {
        size: u64::try_from(b"content".len()).unwrap(),
        sha256: "wrong_sha".to_owned(),
    };
    assert!(
        !ensure_artifact_installed(&path, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn ensure_artifact_installed_returns_false_for_wrong_size() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file.bin");
    std::fs::write(&path, b"content").unwrap();
    let mut expected = artifact_identity(b"content");
    expected.size += 1;

    assert!(
        !ensure_artifact_installed(&path, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn ensure_artifact_installed_returns_true_for_matching_sha_and_kernel_mode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file.bin");
    std::fs::write(&path, b"content").unwrap();
    std::fs::set_permissions(
        &path,
        std::fs::Permissions::from_mode(SETUP_KERNEL_ARTIFACT_MODE),
    )
    .unwrap();
    let expected = artifact_identity(b"content");
    assert!(
        ensure_artifact_installed(&path, &expected, SETUP_KERNEL_ARTIFACT_MODE)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn ensure_artifact_installed_returns_true_for_matching_sha_and_mode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file.bin");
    std::fs::write(&path, b"content").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let expected = artifact_identity(b"content");

    assert!(
        ensure_artifact_installed(&path, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn ensure_artifact_installed_repairs_matching_file_mode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file.bin");
    std::fs::write(&path, b"content").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let expected = artifact_identity(b"content");

    assert!(
        ensure_artifact_installed(&path, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
            .await
            .unwrap()
    );
    assert_eq!(mode(&path), SETUP_EXECUTABLE_ARTIFACT_MODE);
}

#[tokio::test]
async fn ensure_artifact_installed_repairs_readonly_trusted_file_mode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file.bin");
    std::fs::write(&path, b"content").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
    let expected = artifact_identity(b"content");

    assert!(
        ensure_artifact_installed(&path, &expected, SETUP_KERNEL_ARTIFACT_MODE)
            .await
            .unwrap()
    );
    assert_eq!(mode(&path), SETUP_KERNEL_ARTIFACT_MODE);
}

#[tokio::test]
async fn ensure_artifact_installed_does_not_follow_symlink_artifact() {
    let dir = tempfile::tempdir().unwrap();
    let outside = dir.path().join("outside.bin");
    let link = dir.path().join("file.bin");
    std::fs::write(&outside, b"content").unwrap();
    symlink(&outside, &link).unwrap();
    let expected = artifact_identity(b"content");

    assert!(
        !ensure_artifact_installed(&link, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
            .await
            .unwrap()
    );
    assert_eq!(std::fs::read(&outside).unwrap(), b"content");
}

#[tokio::test]
async fn ensure_artifact_installed_returns_false_for_fifo_without_blocking() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file.bin");
    nix::unistd::mkfifo(&path, Mode::from_bits_truncate(0o600)).unwrap();
    let expected = artifact_identity(b"anything");

    assert!(
        !ensure_artifact_installed(&path, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn ensure_artifact_installed_returns_false_for_unix_socket() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file.bin");
    let _listener = UnixListener::bind(&path).unwrap();
    let expected = artifact_identity(b"anything");

    assert!(
        !ensure_artifact_installed(&path, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn ensure_artifact_installed_returns_false_for_directory() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file.bin");
    std::fs::create_dir(&path).unwrap();
    let expected = artifact_identity(b"anything");

    assert!(
        !ensure_artifact_installed(&path, &expected, SETUP_EXECUTABLE_ARTIFACT_MODE)
            .await
            .unwrap()
    );
}

#[test]
fn validate_same_setup_file_identity_rejects_different_files() {
    let dir = tempfile::tempdir().unwrap();
    let first_path = dir.path().join("first.bin");
    let second_path = dir.path().join("second.bin");
    std::fs::write(&first_path, b"first").unwrap();
    std::fs::write(&second_path, b"second").unwrap();
    let first = File::open(&first_path).unwrap();
    let second = File::open(&second_path).unwrap();
    let first_stat = setup_file_stat(&first, &first_path, "first").unwrap();
    let second_stat = setup_file_stat(&second, &second_path, "second").unwrap();

    let error = validate_same_setup_file_identity(
        &first_stat,
        &second_stat,
        &second_path,
        "test setup artifact",
    )
    .unwrap_err();

    assert!(error.to_string().contains("device/inode"));
}

#[test]
fn validate_setup_artifact_mode_rejects_wrong_mode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file.bin");
    std::fs::write(&path, b"content").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let file = File::open(&path).unwrap();
    let stat = setup_file_stat(&file, &path, "test").unwrap();

    let error = validate_setup_artifact_mode(&stat, &path, SETUP_EXECUTABLE_ARTIFACT_MODE, "test")
        .unwrap_err();

    assert!(error.to_string().contains("mode"));
}

#[tokio::test]
async fn verify_and_install_installs_produced_artifact() {
    let dir = tempfile::tempdir().unwrap();
    let tmp_path = dir.path().join("tmp.bin");
    let target = dir.path().join("target.bin");
    let artifact = produced_artifact(&tmp_path, b"content");
    let expected = artifact_identity(b"content");

    verify_and_install(
        artifact,
        &expected,
        "test",
        &target,
        SETUP_EXECUTABLE_ARTIFACT_MODE,
    )
    .await
    .unwrap();

    assert_eq!(std::fs::read(&target).unwrap(), b"content");
    assert_eq!(mode(&target), SETUP_EXECUTABLE_ARTIFACT_MODE);
    assert!(!tmp_path.exists());
}

#[tokio::test]
async fn verify_and_install_removes_produced_artifact_on_wrong_sha() {
    let dir = tempfile::tempdir().unwrap();
    let tmp_path = dir.path().join("tmp.bin");
    let target = dir.path().join("target.bin");
    let artifact = produced_artifact(&tmp_path, b"content");
    let expected = SetupArtifactIdentity {
        size: u64::try_from(b"content".len()).unwrap(),
        sha256: "wrong_sha".to_owned(),
    };

    let result = verify_and_install(
        artifact,
        &expected,
        "test",
        &target,
        SETUP_EXECUTABLE_ARTIFACT_MODE,
    )
    .await;

    assert!(result.is_err());
    assert!(!tmp_path.exists(), "SHA mismatch should clean temp file");
    assert!(!target.exists());
}

#[tokio::test]
async fn verify_and_install_removes_produced_artifact_on_wrong_size() {
    let dir = tempfile::tempdir().unwrap();
    let tmp_path = dir.path().join("tmp.bin");
    let target = dir.path().join("target.bin");
    let artifact = produced_artifact(&tmp_path, b"content");
    let mut expected = artifact_identity(b"content");
    expected.size += 1;

    let result = verify_and_install(
        artifact,
        &expected,
        "test",
        &target,
        SETUP_EXECUTABLE_ARTIFACT_MODE,
    )
    .await;

    assert!(result.is_err());
    assert!(!tmp_path.exists(), "size mismatch should clean temp file");
    assert!(!target.exists());
}

#[tokio::test]
async fn verify_and_install_rejects_replaced_temp_path() {
    let dir = tempfile::tempdir().unwrap();
    let tmp_path = dir.path().join("tmp.bin");
    let target = dir.path().join("target.bin");
    let artifact = produced_artifact(&tmp_path, b"content");
    let expected = artifact_identity(b"content");
    std::fs::remove_file(&tmp_path).unwrap();
    std::fs::write(&tmp_path, b"replacement").unwrap();

    let result = verify_and_install(
        artifact,
        &expected,
        "test",
        &target,
        SETUP_EXECUTABLE_ARTIFACT_MODE,
    )
    .await;

    assert!(result.is_err());
    assert!(!target.exists());
    assert!(
        !tmp_path.exists(),
        "failed install should clean replacement temp path"
    );
}

#[tokio::test]
async fn verify_and_install_errors_when_rename_fails_with_invalid_target() {
    let dir = tempfile::tempdir().unwrap();
    let tmp_path = dir.path().join("tmp.bin");
    let target = dir.path().join("target.bin");
    let artifact = produced_artifact(&tmp_path, b"content");
    let expected = artifact_identity(b"content");
    std::fs::create_dir(&target).unwrap();

    let result = verify_and_install(
        artifact,
        &expected,
        "test",
        &target,
        SETUP_EXECUTABLE_ARTIFACT_MODE,
    )
    .await;

    assert!(result.is_err());
    assert!(target.is_dir());
    assert!(!tmp_path.exists(), "failed install should clean temp file");
}

#[tokio::test]
async fn cancelled_blocking_extraction_removes_archive_and_output_temps() {
    let dir = tempfile::tempdir().unwrap();
    let content = b"extracted content";
    let tarball = tarball_with_entry("tool", content);
    let archive_path = dir.path().join("archive.tarball.tmp");
    let archive = produced_artifact(&archive_path, &tarball);
    let target = dir.path().join("tool");
    let expected = artifact_identity(content);
    let (entered_tx, entered_rx) = oneshot::channel();
    let (start_tx, start_rx) = mpsc::channel();
    let (output_tx, output_rx) = oneshot::channel();
    let (finish_tx, finish_rx) = mpsc::channel();
    let target_for_task = target.clone();

    let task = tokio::task::spawn_blocking(move || {
        entered_tx.send(()).unwrap();
        start_rx.recv().unwrap();
        let output =
            extract_tar_entry_blocking(archive, &target_for_task, "tool", "test", expected.size)?;
        output_tx.send(output.path.to_path_buf()).unwrap();
        finish_rx.recv().unwrap();
        Ok::<ProducedSetupArtifact, RunnerError>(output)
    });

    tokio::time::timeout(Duration::from_secs(2), entered_rx)
        .await
        .expect("blocking extraction did not start")
        .expect("blocking extraction dropped its start signal");
    assert!(archive_path.exists());

    drop(task);
    start_tx.send(()).unwrap();
    let output_path = tokio::time::timeout(Duration::from_secs(2), output_rx)
        .await
        .expect("blocking extraction did not create its output temp")
        .expect("blocking extraction dropped its output signal");

    wait_until_path_is_removed(&archive_path).await;
    assert!(output_path.exists());
    finish_tx.send(()).unwrap();
    wait_until_path_is_removed(&output_path).await;
    assert!(!target.exists());
}

#[tokio::test]
async fn cancelled_blocking_install_removes_uninstalled_temp() {
    let dir = tempfile::tempdir().unwrap();
    let tmp_path = dir.path().join("tmp.bin");
    let target = dir.path().join("target.bin");
    std::fs::create_dir(&target).unwrap();
    let artifact = produced_artifact(&tmp_path, b"content");
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let target_for_task = target.clone();

    let task = tokio::task::spawn_blocking(move || {
        entered_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        install_produced_artifact(artifact, &target_for_task, SETUP_EXECUTABLE_ARTIFACT_MODE)
    });

    tokio::time::timeout(Duration::from_secs(2), entered_rx)
        .await
        .expect("blocking install did not start")
        .expect("blocking install dropped its start signal");
    assert!(tmp_path.exists());

    drop(task);
    release_tx.send(()).unwrap();

    wait_until_path_is_removed(&tmp_path).await;
    assert!(target.is_dir());
}

#[tokio::test]
async fn verify_and_install_replaces_wrong_sha_regular_target() {
    let dir = tempfile::tempdir().unwrap();
    let tmp_path = dir.path().join("tmp.bin");
    let target = dir.path().join("target.bin");
    let artifact = produced_artifact(&tmp_path, b"new content");
    let expected = artifact_identity(b"new content");
    std::fs::write(&target, b"old content").unwrap();

    verify_and_install(
        artifact,
        &expected,
        "test",
        &target,
        SETUP_EXECUTABLE_ARTIFACT_MODE,
    )
    .await
    .unwrap();

    assert_eq!(std::fs::read(&target).unwrap(), b"new content");
    assert_eq!(mode(&target), SETUP_EXECUTABLE_ARTIFACT_MODE);
}

#[tokio::test]
async fn verify_and_install_accepts_verified_target_after_install_failure() {
    let dir = tempfile::tempdir().unwrap();
    let tmp_path = dir.path().join("tmp.bin");
    let target = dir.path().join("target.bin");
    std::fs::write(&target, b"content").unwrap();
    std::fs::set_permissions(
        &target,
        std::fs::Permissions::from_mode(SETUP_EXECUTABLE_ARTIFACT_MODE),
    )
    .unwrap();
    let expected = artifact_identity(b"content");
    let artifact = produced_artifact(&tmp_path, b"content");
    std::fs::remove_file(&tmp_path).unwrap();

    verify_and_install(
        artifact,
        &expected,
        "test",
        &target,
        SETUP_EXECUTABLE_ARTIFACT_MODE,
    )
    .await
    .unwrap();
}
