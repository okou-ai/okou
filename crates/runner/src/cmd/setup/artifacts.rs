use std::path::PathBuf;

use crate::deps::{
    FIRECRACKER_ARCHIVE_SHA256_AARCH64, FIRECRACKER_ARCHIVE_SHA256_X86_64,
    FIRECRACKER_ARCHIVE_SIZE_AARCH64, FIRECRACKER_ARCHIVE_SIZE_X86_64, FIRECRACKER_SHA256_AARCH64,
    FIRECRACKER_SHA256_X86_64, FIRECRACKER_SIZE_AARCH64, FIRECRACKER_SIZE_X86_64,
    FIRECRACKER_VERSION, KERNEL_SHA256_AARCH64, KERNEL_SHA256_X86_64, KERNEL_SIZE_AARCH64,
    KERNEL_SIZE_X86_64, KERNEL_VERSION, MITMDUMP_SHA256_AARCH64, MITMDUMP_SHA256_X86_64,
    MITMDUMP_SIZE_AARCH64, MITMDUMP_SIZE_X86_64, MITMDUMP_TAR_ENTRY,
    MITMPROXY_ARCHIVE_SHA256_AARCH64, MITMPROXY_ARCHIVE_SHA256_X86_64,
    MITMPROXY_ARCHIVE_SIZE_AARCH64, MITMPROXY_ARCHIVE_SIZE_X86_64, MITMPROXY_VERSION,
    firecracker_tar_entry, firecracker_url, kernel_url, mitmdump_url,
};
use crate::error::RunnerResult;
use crate::paths::HomePaths;

use super::{
    SETUP_EXECUTABLE_ARTIFACT_MODE, SETUP_KERNEL_ARTIFACT_MODE, SetupArtifactIdentity,
    download_and_extract, download_to_temp, ensure_artifact_installed, select_sha, select_size,
    verify_and_install,
};

enum SetupArtifactSource {
    Direct,
    TarEntry {
        entry_name: String,
        archive: SetupArtifactIdentity,
    },
}

struct SetupArtifact {
    label: &'static str,
    display_name: String,
    target: PathBuf,
    installed: SetupArtifactIdentity,
    mode: u32,
    url: String,
    source: SetupArtifactSource,
}

pub(super) async fn install_firecracker(
    client: &reqwest::Client,
    paths: &HomePaths,
    arch: &str,
) -> RunnerResult<()> {
    install_setup_artifact(client, firecracker_artifact(paths, arch)).await
}

pub(super) async fn install_kernel(
    client: &reqwest::Client,
    paths: &HomePaths,
    arch: &str,
) -> RunnerResult<()> {
    install_setup_artifact(client, kernel_artifact(paths, arch)).await
}

pub(super) async fn install_mitmdump(
    client: &reqwest::Client,
    paths: &HomePaths,
    arch: &str,
) -> RunnerResult<()> {
    install_setup_artifact(client, mitmdump_artifact(paths, arch)).await
}

async fn install_setup_artifact(
    client: &reqwest::Client,
    artifact: SetupArtifact,
) -> RunnerResult<()> {
    if ensure_artifact_installed(&artifact.target, &artifact.installed, artifact.mode).await? {
        tracing::info!(
            "[OK] {} already installed, skipping download",
            artifact.display_name
        );
        return Ok(());
    }

    tracing::info!("downloading {} from {}", artifact.label, artifact.url);

    let produced = match &artifact.source {
        SetupArtifactSource::Direct => {
            download_to_temp(
                client,
                &artifact.url,
                &artifact.target,
                "download",
                artifact.label,
                &artifact.installed,
            )
            .await?
        }
        SetupArtifactSource::TarEntry {
            entry_name,
            archive,
        } => {
            download_and_extract(
                client,
                &artifact.url,
                artifact.label,
                entry_name,
                &artifact.target,
                archive,
                &artifact.installed,
            )
            .await?
        }
    };

    verify_and_install(
        produced,
        &artifact.installed,
        artifact.label,
        &artifact.target,
        artifact.mode,
    )
    .await?;
    tracing::info!("[OK] {} installed", artifact.display_name);
    Ok(())
}

fn setup_artifact_identity(size: u64, sha256: &str) -> SetupArtifactIdentity {
    SetupArtifactIdentity {
        size,
        sha256: sha256.to_owned(),
    }
}

fn firecracker_artifact(paths: &HomePaths, arch: &str) -> SetupArtifact {
    SetupArtifact {
        label: "firecracker",
        display_name: format!("firecracker {FIRECRACKER_VERSION}"),
        target: paths.firecracker_bin(FIRECRACKER_VERSION),
        installed: setup_artifact_identity(
            select_size(arch, FIRECRACKER_SIZE_X86_64, FIRECRACKER_SIZE_AARCH64),
            select_sha(arch, FIRECRACKER_SHA256_X86_64, FIRECRACKER_SHA256_AARCH64),
        ),
        mode: SETUP_EXECUTABLE_ARTIFACT_MODE,
        url: firecracker_url(arch),
        source: SetupArtifactSource::TarEntry {
            entry_name: firecracker_tar_entry(arch),
            archive: setup_artifact_identity(
                select_size(
                    arch,
                    FIRECRACKER_ARCHIVE_SIZE_X86_64,
                    FIRECRACKER_ARCHIVE_SIZE_AARCH64,
                ),
                select_sha(
                    arch,
                    FIRECRACKER_ARCHIVE_SHA256_X86_64,
                    FIRECRACKER_ARCHIVE_SHA256_AARCH64,
                ),
            ),
        },
    }
}

fn kernel_artifact(paths: &HomePaths, arch: &str) -> SetupArtifact {
    SetupArtifact {
        label: "kernel",
        display_name: format!("kernel vmlinux-{KERNEL_VERSION}"),
        target: paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION),
        installed: setup_artifact_identity(
            select_size(arch, KERNEL_SIZE_X86_64, KERNEL_SIZE_AARCH64),
            select_sha(arch, KERNEL_SHA256_X86_64, KERNEL_SHA256_AARCH64),
        ),
        mode: SETUP_KERNEL_ARTIFACT_MODE,
        url: kernel_url(arch),
        source: SetupArtifactSource::Direct,
    }
}

fn mitmdump_artifact(paths: &HomePaths, arch: &str) -> SetupArtifact {
    SetupArtifact {
        label: "mitmdump",
        display_name: format!("mitmdump {MITMPROXY_VERSION}"),
        target: paths.mitmdump_bin(MITMPROXY_VERSION),
        installed: setup_artifact_identity(
            select_size(arch, MITMDUMP_SIZE_X86_64, MITMDUMP_SIZE_AARCH64),
            select_sha(arch, MITMDUMP_SHA256_X86_64, MITMDUMP_SHA256_AARCH64),
        ),
        mode: SETUP_EXECUTABLE_ARTIFACT_MODE,
        url: mitmdump_url(arch),
        source: SetupArtifactSource::TarEntry {
            entry_name: MITMDUMP_TAR_ENTRY.to_owned(),
            archive: setup_artifact_identity(
                select_size(
                    arch,
                    MITMPROXY_ARCHIVE_SIZE_X86_64,
                    MITMPROXY_ARCHIVE_SIZE_AARCH64,
                ),
                select_sha(
                    arch,
                    MITMPROXY_ARCHIVE_SHA256_X86_64,
                    MITMPROXY_ARCHIVE_SHA256_AARCH64,
                ),
            ),
        },
    }
}

runner_test_group!(cmd_other; #[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use flate2::Compression;
    use flate2::write::GzEncoder;
    use httpmock::Method::GET;
    use httpmock::MockServer;
    use sha2::{Digest, Sha256};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;
    use tokio::task::JoinHandle;

    use super::*;

    fn sha256_hex(content: &[u8]) -> String {
        hex::encode(Sha256::digest(content))
    }

    fn content_identity(content: &[u8]) -> SetupArtifactIdentity {
        SetupArtifactIdentity {
            size: u64::try_from(content.len()).unwrap(),
            sha256: sha256_hex(content),
        }
    }

    fn test_client() -> reqwest::Client {
        reqwest::Client::builder().build().unwrap()
    }

    fn mode(path: &std::path::Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn tarball_with_entry(entry_name: &str, content: &[u8]) -> Vec<u8> {
        tarball_with_entry_compression(entry_name, content, Compression::default())
    }

    fn tarball_with_entry_compression(
        entry_name: &str,
        content: &[u8],
        compression: Compression,
    ) -> Vec<u8> {
        let encoder = GzEncoder::new(Vec::new(), compression);
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

    fn assert_identity(identity: &SetupArtifactIdentity, size: u64, sha256: &str) {
        assert_eq!(identity.size, size);
        assert_eq!(identity.sha256, sha256);
    }

    fn assert_tar_source(
        source: &SetupArtifactSource,
        expected_entry: &str,
        archive_size: u64,
        archive_sha256: &str,
    ) {
        let SetupArtifactSource::TarEntry {
            entry_name,
            archive,
        } = source
        else {
            panic!("expected tar entry source");
        };
        assert_eq!(entry_name, expected_entry);
        assert_identity(archive, archive_size, archive_sha256);
    }

    async fn spawn_http_response(response: Vec<u8>) -> (String, JoinHandle<std::io::Result<()>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await?;
            let mut request = [0_u8; 1024];
            let request_size = stream.read(&mut request).await?;
            if request_size == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "setup fixture received an empty request",
                ));
            }
            stream.write_all(&response).await
        });
        (format!("http://{address}/artifact"), task)
    }

    async fn spawn_stalled_http_response(
        content_length: usize,
        body_prefix: Vec<u8>,
    ) -> (
        String,
        oneshot::Receiver<()>,
        oneshot::Sender<()>,
        JoinHandle<std::io::Result<()>>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (body_sent_tx, body_sent_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await?;
            let mut request = [0_u8; 1024];
            let request_size = stream.read(&mut request).await?;
            if request_size == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "setup fixture received an empty request",
                ));
            }
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(headers.as_bytes()).await?;
            stream.write_all(&body_prefix).await?;
            stream.flush().await?;
            let _ = body_sent_tx.send(());
            let _ = release_rx.await;
            Ok(())
        });
        (
            format!("http://{address}/artifact"),
            body_sent_rx,
            release_tx,
            task,
        )
    }

    async fn finish_http_response(task: JoinHandle<std::io::Result<()>>) {
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("setup fixture timed out")
            .expect("setup fixture task failed")
            .expect("setup fixture response failed");
    }

    fn setup_temp_files(root: &Path) -> Vec<PathBuf> {
        if !root.exists() {
            return Vec::new();
        }

        let mut pending = vec![root.to_owned()];
        let mut temp_files = Vec::new();
        while let Some(directory) = pending.pop() {
            for entry in std::fs::read_dir(directory).unwrap() {
                let entry = entry.unwrap();
                let file_type = entry.file_type().unwrap();
                if file_type.is_dir() {
                    pending.push(entry.path());
                } else if entry.file_name().to_string_lossy().ends_with(".tmp") {
                    temp_files.push(entry.path());
                }
            }
        }
        temp_files
    }

    async fn wait_for_setup_temp_count(root: &Path, expected: usize) -> Vec<PathBuf> {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let temp_files = setup_temp_files(root);
                if temp_files.len() == expected {
                    return temp_files;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("setup temp count did not reach the expected value")
    }

    #[test]
    fn artifact_descriptors_preserve_metadata_by_arch() {
        let paths = HomePaths::with_root(PathBuf::from("/setup-root"));

        let firecracker_x86 = firecracker_artifact(&paths, "x86_64");
        assert_eq!(
            firecracker_x86.target,
            paths.firecracker_bin(FIRECRACKER_VERSION)
        );
        assert_eq!(firecracker_x86.mode, SETUP_EXECUTABLE_ARTIFACT_MODE);
        assert_identity(
            &firecracker_x86.installed,
            FIRECRACKER_SIZE_X86_64,
            FIRECRACKER_SHA256_X86_64,
        );
        assert_eq!(firecracker_x86.url, firecracker_url("x86_64"));
        assert_tar_source(
            &firecracker_x86.source,
            &firecracker_tar_entry("x86_64"),
            FIRECRACKER_ARCHIVE_SIZE_X86_64,
            FIRECRACKER_ARCHIVE_SHA256_X86_64,
        );

        let firecracker_aarch64 = firecracker_artifact(&paths, "aarch64");
        assert_identity(
            &firecracker_aarch64.installed,
            FIRECRACKER_SIZE_AARCH64,
            FIRECRACKER_SHA256_AARCH64,
        );
        assert_eq!(firecracker_aarch64.url, firecracker_url("aarch64"));
        assert_tar_source(
            &firecracker_aarch64.source,
            &firecracker_tar_entry("aarch64"),
            FIRECRACKER_ARCHIVE_SIZE_AARCH64,
            FIRECRACKER_ARCHIVE_SHA256_AARCH64,
        );

        let kernel_x86 = kernel_artifact(&paths, "x86_64");
        assert_eq!(
            kernel_x86.target,
            paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION)
        );
        assert_eq!(kernel_x86.mode, SETUP_KERNEL_ARTIFACT_MODE);
        assert_identity(
            &kernel_x86.installed,
            KERNEL_SIZE_X86_64,
            KERNEL_SHA256_X86_64,
        );
        assert_eq!(kernel_x86.url, kernel_url("x86_64"));
        assert!(matches!(kernel_x86.source, SetupArtifactSource::Direct));

        let kernel_aarch64 = kernel_artifact(&paths, "aarch64");
        assert_identity(
            &kernel_aarch64.installed,
            KERNEL_SIZE_AARCH64,
            KERNEL_SHA256_AARCH64,
        );
        assert_eq!(kernel_aarch64.url, kernel_url("aarch64"));
        assert!(matches!(kernel_aarch64.source, SetupArtifactSource::Direct));

        let mitmdump_x86 = mitmdump_artifact(&paths, "x86_64");
        assert_eq!(mitmdump_x86.target, paths.mitmdump_bin(MITMPROXY_VERSION));
        assert_eq!(mitmdump_x86.mode, SETUP_EXECUTABLE_ARTIFACT_MODE);
        assert_identity(
            &mitmdump_x86.installed,
            MITMDUMP_SIZE_X86_64,
            MITMDUMP_SHA256_X86_64,
        );
        assert_eq!(mitmdump_x86.url, mitmdump_url("x86_64"));
        assert_tar_source(
            &mitmdump_x86.source,
            MITMDUMP_TAR_ENTRY,
            MITMPROXY_ARCHIVE_SIZE_X86_64,
            MITMPROXY_ARCHIVE_SHA256_X86_64,
        );

        let mitmdump_aarch64 = mitmdump_artifact(&paths, "aarch64");
        assert_identity(
            &mitmdump_aarch64.installed,
            MITMDUMP_SIZE_AARCH64,
            MITMDUMP_SHA256_AARCH64,
        );
        assert_eq!(mitmdump_aarch64.url, mitmdump_url("aarch64"));
        assert_tar_source(
            &mitmdump_aarch64.source,
            MITMDUMP_TAR_ENTRY,
            MITMPROXY_ARCHIVE_SIZE_AARCH64,
            MITMPROXY_ARCHIVE_SHA256_AARCH64,
        );
    }

    #[tokio::test]
    async fn installed_artifact_skips_download() {
        let dir = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let content = b"already installed";
        let target = dir.path().join("artifact.bin");
        std::fs::write(&target, content).unwrap();
        std::fs::set_permissions(
            &target,
            std::fs::Permissions::from_mode(SETUP_EXECUTABLE_ARTIFACT_MODE),
        )
        .unwrap();

        let download = server
            .mock_async(|when, then| {
                when.method(GET).path("/artifact.bin");
                then.status(200).body("should not download");
            })
            .await;
        let artifact = SetupArtifact {
            label: "test",
            display_name: "test artifact".to_owned(),
            target: target.clone(),
            installed: content_identity(content),
            mode: SETUP_EXECUTABLE_ARTIFACT_MODE,
            url: server.url("/artifact.bin"),
            source: SetupArtifactSource::Direct,
        };
        let client = test_client();

        install_setup_artifact(&client, artifact).await.unwrap();

        download.assert_calls_async(0).await;
        assert_eq!(std::fs::read(&target).unwrap(), content);
        assert_eq!(mode(&target), SETUP_EXECUTABLE_ARTIFACT_MODE);
    }

    #[tokio::test]
    async fn direct_artifact_downloads_and_installs() {
        let dir = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let content = b"direct artifact".to_vec();
        let download = server
            .mock_async(|when, then| {
                when.method(GET).path("/direct.bin");
                then.status(200).body(content.clone());
            })
            .await;
        let target = dir.path().join("nested").join("direct.bin");
        let artifact = SetupArtifact {
            label: "direct",
            display_name: "direct artifact".to_owned(),
            target: target.clone(),
            installed: content_identity(&content),
            mode: SETUP_KERNEL_ARTIFACT_MODE,
            url: server.url("/direct.bin"),
            source: SetupArtifactSource::Direct,
        };
        let client = test_client();

        install_setup_artifact(&client, artifact).await.unwrap();

        download.assert_calls_async(1).await;
        assert_eq!(std::fs::read(&target).unwrap(), content);
        assert_eq!(mode(&target), SETUP_KERNEL_ARTIFACT_MODE);
    }

    #[tokio::test]
    async fn cancelled_direct_download_removes_temp_without_installing_target() {
        let dir = tempfile::tempdir().unwrap();
        let content = b"direct artifact".to_vec();
        let (url, body_sent, release, server_task) =
            spawn_stalled_http_response(content.len(), b"d".to_vec()).await;
        let target = dir.path().join("nested").join("direct.bin");
        let artifact = SetupArtifact {
            label: "direct",
            display_name: "direct artifact".to_owned(),
            target: target.clone(),
            installed: content_identity(&content),
            mode: SETUP_KERNEL_ARTIFACT_MODE,
            url,
            source: SetupArtifactSource::Direct,
        };
        let client = test_client();
        let install_task =
            tokio::spawn(async move { install_setup_artifact(&client, artifact).await });

        tokio::time::timeout(Duration::from_secs(2), body_sent)
            .await
            .expect("setup fixture did not send the partial body")
            .expect("setup fixture dropped the body signal");
        let temp_files = wait_for_setup_temp_count(dir.path(), 1).await;
        assert!(temp_files.iter().all(|path| path.exists()));

        install_task.abort();
        assert!(install_task.await.unwrap_err().is_cancelled());
        release.send(()).unwrap();
        finish_http_response(server_task).await;

        wait_for_setup_temp_count(dir.path(), 0).await;
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn tar_entry_artifact_downloads_extracts_and_installs() {
        let dir = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let content = b"tar entry artifact".to_vec();
        let tarball = tarball_with_entry("tool", &content);
        let download = server
            .mock_async(|when, then| {
                when.method(GET).path("/archive.tar.gz");
                then.status(200).body(tarball.clone());
            })
            .await;
        let target = dir.path().join("nested").join("tool");
        let artifact = SetupArtifact {
            label: "tar-entry",
            display_name: "tar entry artifact".to_owned(),
            target: target.clone(),
            installed: content_identity(&content),
            mode: SETUP_EXECUTABLE_ARTIFACT_MODE,
            url: server.url("/archive.tar.gz"),
            source: SetupArtifactSource::TarEntry {
                entry_name: "tool".to_owned(),
                archive: content_identity(&tarball),
            },
        };
        let client = test_client();

        install_setup_artifact(&client, artifact).await.unwrap();

        download.assert_calls_async(1).await;
        assert_eq!(std::fs::read(&target).unwrap(), content);
        assert_eq!(mode(&target), SETUP_EXECUTABLE_ARTIFACT_MODE);
    }

    #[tokio::test]
    async fn known_oversized_body_is_rejected_before_temp_creation() {
        let dir = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let body = b"larger body".to_vec();
        let download = server
            .mock_async(|when, then| {
                when.method(GET).path("/oversized.bin");
                then.status(200).body(body.clone());
            })
            .await;
        let expected = b"small";
        let target = dir.path().join("nested").join("artifact.bin");
        let artifact = SetupArtifact {
            label: "direct",
            display_name: "direct artifact".to_owned(),
            target: target.clone(),
            installed: content_identity(expected),
            mode: SETUP_KERNEL_ARTIFACT_MODE,
            url: server.url("/oversized.bin"),
            source: SetupArtifactSource::Direct,
        };
        let client = test_client();

        let error = install_setup_artifact(&client, artifact).await.unwrap_err();

        download.assert_calls_async(1).await;
        assert!(
            error.to_string().contains("source size mismatch"),
            "unexpected error: {error}"
        );
        assert!(!target.exists());
        assert!(!target.parent().unwrap().exists());
        assert!(setup_temp_files(dir.path()).is_empty());
    }

    #[tokio::test]
    async fn unknown_length_oversized_body_stops_before_excess_write() {
        let dir = tempfile::tempdir().unwrap();
        let response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n6\r\nabcdef\r\n0\r\n\r\n".to_vec();
        let (url, server_task) = spawn_http_response(response).await;
        let target = dir.path().join("artifact.bin");
        let artifact = SetupArtifact {
            label: "direct",
            display_name: "direct artifact".to_owned(),
            target: target.clone(),
            installed: content_identity(b"abc"),
            mode: SETUP_KERNEL_ARTIFACT_MODE,
            url,
            source: SetupArtifactSource::Direct,
        };
        let client = test_client();

        let error = install_setup_artifact(&client, artifact).await.unwrap_err();
        finish_http_response(server_task).await;

        assert!(
            error.to_string().contains("exceeds expected size"),
            "unexpected error: {error}"
        );
        assert!(!target.exists());
        assert!(setup_temp_files(dir.path()).is_empty());
    }

    #[tokio::test]
    async fn unknown_length_short_body_is_rejected_and_cleaned_up() {
        let dir = tempfile::tempdir().unwrap();
        let response = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nabc".to_vec();
        let (url, server_task) = spawn_http_response(response).await;
        let target = dir.path().join("artifact.bin");
        let artifact = SetupArtifact {
            label: "direct",
            display_name: "direct artifact".to_owned(),
            target: target.clone(),
            installed: content_identity(b"abcde"),
            mode: SETUP_KERNEL_ARTIFACT_MODE,
            url,
            source: SetupArtifactSource::Direct,
        };
        let client = test_client();

        let error = install_setup_artifact(&client, artifact).await.unwrap_err();
        finish_http_response(server_task).await;

        assert!(
            error.to_string().contains("source size mismatch"),
            "unexpected error: {error}"
        );
        assert!(error.to_string().contains("got 3 bytes"));
        assert!(!target.exists());
        assert!(setup_temp_files(dir.path()).is_empty());
    }

    #[tokio::test]
    async fn tar_archive_sha_mismatch_is_rejected_before_extraction() {
        let dir = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let content = b"tar entry artifact".to_vec();
        let tarball = tarball_with_entry("tool", &content);
        let download = server
            .mock_async(|when, then| {
                when.method(GET).path("/archive.tar.gz");
                then.status(200).body(tarball.clone());
            })
            .await;
        let target = dir.path().join("tool");
        let artifact = SetupArtifact {
            label: "tar-entry",
            display_name: "tar entry artifact".to_owned(),
            target: target.clone(),
            installed: content_identity(&content),
            mode: SETUP_EXECUTABLE_ARTIFACT_MODE,
            url: server.url("/archive.tar.gz"),
            source: SetupArtifactSource::TarEntry {
                entry_name: "tool".to_owned(),
                archive: SetupArtifactIdentity {
                    size: u64::try_from(tarball.len()).unwrap(),
                    sha256: sha256_hex(b"different archive"),
                },
            },
        };
        let client = test_client();

        let error = install_setup_artifact(&client, artifact).await.unwrap_err();

        download.assert_calls_async(1).await;
        assert!(
            error.to_string().contains("source SHA256 mismatch"),
            "unexpected error: {error}"
        );
        assert!(!target.exists());
        assert!(setup_temp_files(dir.path()).is_empty());
    }

    #[tokio::test]
    async fn tar_entry_declared_size_mismatch_is_rejected_before_output() {
        let dir = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let content = b"tar entry artifact".to_vec();
        let tarball = tarball_with_entry("tool", &content);
        let download = server
            .mock_async(|when, then| {
                when.method(GET).path("/archive.tar.gz");
                then.status(200).body(tarball.clone());
            })
            .await;
        let target = dir.path().join("tool");
        let artifact = SetupArtifact {
            label: "tar-entry",
            display_name: "tar entry artifact".to_owned(),
            target: target.clone(),
            installed: SetupArtifactIdentity {
                size: u64::try_from(content.len()).unwrap() + 1,
                sha256: sha256_hex(&content),
            },
            mode: SETUP_EXECUTABLE_ARTIFACT_MODE,
            url: server.url("/archive.tar.gz"),
            source: SetupArtifactSource::TarEntry {
                entry_name: "tool".to_owned(),
                archive: content_identity(&tarball),
            },
        };
        let client = test_client();

        let error = install_setup_artifact(&client, artifact).await.unwrap_err();

        download.assert_calls_async(1).await;
        assert!(
            error.to_string().contains("entry size mismatch"),
            "unexpected error: {error}"
        );
        assert!(!target.exists());
        assert!(setup_temp_files(dir.path()).is_empty());
    }

    #[tokio::test]
    async fn truncated_tar_entry_read_error_cleans_temps() {
        let dir = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let content = vec![b'x'; 128 * 1024];
        let mut tarball = tarball_with_entry_compression("tool", &content, Compression::none());
        tarball.truncate(tarball.len() - 64 * 1024);
        let download = server
            .mock_async(|when, then| {
                when.method(GET).path("/truncated.tar.gz");
                then.status(200).body(tarball.clone());
            })
            .await;
        let target = dir.path().join("tool");
        let artifact = SetupArtifact {
            label: "tar-entry",
            display_name: "tar entry artifact".to_owned(),
            target: target.clone(),
            installed: content_identity(&content),
            mode: SETUP_EXECUTABLE_ARTIFACT_MODE,
            url: server.url("/truncated.tar.gz"),
            source: SetupArtifactSource::TarEntry {
                entry_name: "tool".to_owned(),
                archive: content_identity(&tarball),
            },
        };
        let client = test_client();

        let error = install_setup_artifact(&client, artifact).await.unwrap_err();

        download.assert_calls_async(1).await;
        assert!(
            error.to_string().contains("read tar entry"),
            "unexpected error: {error}"
        );
        assert!(!target.exists());
        assert!(setup_temp_files(dir.path()).is_empty());
    }
});
