use crate::support::{
    TarEntry, TcpTestServer, create_tar_gz, create_tar_gz_entries, manifest_json,
    read_http_request_path, run_guest_storage_apply, run_guest_storage_apply_manifest_json,
    write_manifest,
};
use httpmock::prelude::*;
use httpmock::{HttpMockRequest, HttpMockResponse, Mock};
use std::io::Write;
use std::net::TcpStream;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

const STORAGE_ARCHIVE_PATH: &str = "/storage.tar.gz";
const ARTIFACT_ARCHIVE_PATH: &str = "/artifact.tar.gz";
const EXPECTED_RETRY_ATTEMPTS: usize = 3;

fn mock_gzip_archive<'server>(
    server: &'server MockServer,
    path: &str,
    body: &[u8],
) -> Mock<'server> {
    server.mock(|when, then| {
        when.method(GET).path(path);
        then.status(200)
            .header("content-type", "application/gzip")
            .body(body);
    })
}

fn mock_status<'server>(server: &'server MockServer, path: &str, status: u16) -> Mock<'server> {
    server.mock(|when, then| {
        when.method(GET).path(path);
        then.status(status);
    })
}

fn mock_500_then_gzip_archive<'server>(
    server: &'server MockServer,
    path: &str,
    body: &[u8],
) -> Mock<'server> {
    let calls = AtomicUsize::new(0);
    let body = body.to_vec();

    server.mock(move |when, then| {
        when.method(GET).path(path);
        then.respond_with(move |_req: &HttpMockRequest| {
            if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                HttpMockResponse::builder().status(500).build()
            } else {
                HttpMockResponse::builder()
                    .status(200)
                    .header("content-type", "application/gzip")
                    .body(body.clone())
                    .build()
            }
        });
    })
}

fn write_storage_manifest(
    dir: &tempfile::TempDir,
    mount: &Path,
    archive_url: Option<&str>,
) -> std::io::Result<std::path::PathBuf> {
    let mount_path = path_to_str(mount)?;
    write_manifest(dir, &[(mount_path, archive_url)], None)
}

fn write_artifact_manifest(
    dir: &tempfile::TempDir,
    mount: &Path,
    archive_url: Option<&str>,
) -> std::io::Result<std::path::PathBuf> {
    let mount_path = path_to_str(mount)?;
    write_manifest(dir, &[], Some((mount_path, archive_url)))
}

fn run_storage_download(
    dir: &tempfile::TempDir,
    mount: &Path,
    archive_url: Option<&str>,
) -> std::io::Result<bool> {
    let manifest = write_storage_manifest(dir, mount, archive_url)?;
    Ok(run_guest_storage_apply(path_to_str(&manifest)?))
}

fn run_artifact_download(
    dir: &tempfile::TempDir,
    mount: &Path,
    archive_url: Option<&str>,
) -> std::io::Result<bool> {
    let manifest = write_artifact_manifest(dir, mount, archive_url)?;
    Ok(run_guest_storage_apply(path_to_str(&manifest)?))
}

fn path_to_str(path: &Path) -> std::io::Result<&str> {
    path.to_str().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "path is not valid UTF-8")
    })
}

fn start_truncated_then_valid_server(archive: Vec<u8>) -> std::io::Result<TcpTestServer<usize>> {
    let partial_len = (archive.len() / 2).max(1);
    let partial_archive: Vec<u8> = archive.iter().copied().take(partial_len).collect();

    TcpTestServer::start(move |server| {
        let mut storage_requests = 0;
        loop {
            let Some(mut stream) = server.accept()? else {
                return Ok(storage_requests);
            };
            let path = read_http_request_path(&mut stream)?;
            if path == STORAGE_ARCHIVE_PATH {
                if storage_requests == 0 {
                    write_response(&mut stream, &partial_archive, archive.len())?;
                } else {
                    write_response(&mut stream, &archive, archive.len())?;
                }
                storage_requests += 1;
                if storage_requests == 2 {
                    break;
                }
            } else {
                write_response(&mut stream, &[], 0)?;
            }
        }
        Ok(storage_requests)
    })
}

fn write_response(
    stream: &mut TcpStream,
    body: &[u8],
    content_length: usize,
) -> std::io::Result<()> {
    let headers = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/gzip\r\ncontent-length: {content_length}\r\nconnection: close\r\n\r\n"
    );
    stream.write_all(headers.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

#[test]
fn single_storage_download() {
    let server = MockServer::start();
    let tar_gz = create_tar_gz(&[("hello.txt", b"hello world")]).unwrap();
    mock_gzip_archive(&server, STORAGE_ARCHIVE_PATH, &tar_gz);

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url(STORAGE_ARCHIVE_PATH);
    let result = run_storage_download(&dir, &mount, Some(&url)).unwrap();

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("hello.txt")).unwrap(),
        "hello world"
    );
}

#[test]
fn http_storage_malicious_entries_are_skipped_while_safe_entries_extract() {
    let server = MockServer::start();
    let tar_gz = create_tar_gz_entries(&[
        TarEntry::File("safe.txt", b"safe"),
        TarEntry::Symlink("evil_symlink", "../outside.txt"),
        TarEntry::Hardlink("evil_hardlink", "../outside.txt"),
        TarEntry::Raw {
            path: b"../path_escape.txt",
            entry_type: b'0',
            mode: b"0000644\0",
            content: b"escaped",
        },
    ])
    .unwrap();

    let mock = mock_gzip_archive(&server, STORAGE_ARCHIVE_PATH, &tar_gz);

    let dir = tempfile::tempdir().unwrap();
    let outside_file = dir.path().join("outside.txt");
    std::fs::write(&outside_file, "outside").unwrap();

    let mount = dir.path().join("mount");
    let url = server.url(STORAGE_ARCHIVE_PATH);
    let result = run_storage_download(&dir, &mount, Some(&url)).unwrap();

    assert!(result);
    mock.assert_calls(1);
    assert_eq!(
        std::fs::read_to_string(mount.join("safe.txt")).unwrap(),
        "safe"
    );
    assert_eq!(std::fs::read_to_string(&outside_file).unwrap(), "outside");
    assert!(!dir.path().join("path_escape.txt").exists());
    assert!(mount.join("evil_symlink").symlink_metadata().is_err());
    assert!(!mount.join("evil_hardlink").exists());
}

#[test]
fn six_storages_parallel() {
    let server = MockServer::start();
    let dir = tempfile::tempdir().unwrap();

    let mut storages = Vec::new();
    let mut mocks = Vec::new();

    for i in 0..6 {
        let filename = format!("file_{i}.txt");
        let content = format!("content_{i}");
        let tar_gz = create_tar_gz(&[(&filename, content.as_bytes())]).unwrap();
        let path = format!("/storage_{i}.tar.gz");

        let mock = mock_gzip_archive(&server, &path, &tar_gz);
        mocks.push(mock);

        let mount = dir.path().join(format!("mount_{i}"));
        storages.push((
            mount.to_str().unwrap().to_string(),
            server.url(format!("/storage_{i}.tar.gz")),
        ));
    }

    let storage_refs: Vec<(&str, Option<&str>)> = storages
        .iter()
        .map(|(m, u)| (m.as_str(), Some(u.as_str())))
        .collect();

    let manifest = write_manifest(&dir, &storage_refs, None).unwrap();
    let result = run_guest_storage_apply(manifest.to_str().unwrap());

    assert!(result);

    for (i, mock) in mocks.iter().enumerate() {
        mock.assert();
        let mount = dir.path().join(format!("mount_{i}"));
        let content = std::fs::read_to_string(mount.join(format!("file_{i}.txt"))).unwrap();
        assert_eq!(content, format!("content_{i}"));
    }
}

// Regression test: storages with overlapping paths (e.g. /home/user/.claude and
// /home/user/.claude/skills/foo) must remain valid when scheduled safely.
#[test]
fn parent_child_mount_paths_download_successfully() {
    let server = MockServer::start();
    let dir = tempfile::tempdir().unwrap();

    let parent_tar = create_tar_gz(&[("config.json", b"parent config")]).unwrap();
    let child_a_tar = create_tar_gz(&[("skill.json", b"skill a")]).unwrap();
    let child_b_tar = create_tar_gz(&[("skill.json", b"skill b")]).unwrap();
    let child_c_tar = create_tar_gz(&[("skill.json", b"skill c")]).unwrap();

    let m_parent = mock_gzip_archive(&server, "/parent.tar.gz", &parent_tar);
    let m_child_a = mock_gzip_archive(&server, "/child_a.tar.gz", &child_a_tar);
    let m_child_b = mock_gzip_archive(&server, "/child_b.tar.gz", &child_b_tar);
    let m_child_c = mock_gzip_archive(&server, "/child_c.tar.gz", &child_c_tar);

    let parent_mount = dir.path().join("claude");
    let child_a_mount = dir.path().join("claude/skills/alpha");
    let child_b_mount = dir.path().join("claude/skills/beta");
    let child_c_mount = dir.path().join("claude/skills/gamma");

    let url_parent = server.url("/parent.tar.gz");
    let url_child_a = server.url("/child_a.tar.gz");
    let url_child_b = server.url("/child_b.tar.gz");
    let url_child_c = server.url("/child_c.tar.gz");

    let storages: Vec<(&str, Option<&str>)> = vec![
        (parent_mount.to_str().unwrap(), Some(&url_parent)),
        (child_a_mount.to_str().unwrap(), Some(&url_child_a)),
        (child_b_mount.to_str().unwrap(), Some(&url_child_b)),
        (child_c_mount.to_str().unwrap(), Some(&url_child_c)),
    ];

    let manifest = write_manifest(&dir, &storages, None).unwrap();
    let result = run_guest_storage_apply(manifest.to_str().unwrap());

    assert!(result);
    m_parent.assert();
    m_child_a.assert();
    m_child_b.assert();
    m_child_c.assert();

    assert_eq!(
        std::fs::read_to_string(parent_mount.join("config.json")).unwrap(),
        "parent config"
    );
    assert_eq!(
        std::fs::read_to_string(child_a_mount.join("skill.json")).unwrap(),
        "skill a"
    );
    assert_eq!(
        std::fs::read_to_string(child_b_mount.join("skill.json")).unwrap(),
        "skill b"
    );
    assert_eq!(
        std::fs::read_to_string(child_c_mount.join("skill.json")).unwrap(),
        "skill c"
    );
}

#[test]
fn artifact_download_success() {
    let server = MockServer::start();
    let tar_gz = create_tar_gz(&[("artifact.txt", b"artifact data")]).unwrap();
    mock_gzip_archive(&server, ARTIFACT_ARCHIVE_PATH, &tar_gz);

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("artifact_mount");
    let url = server.url(ARTIFACT_ARCHIVE_PATH);
    let result = run_artifact_download(&dir, &mount, Some(&url)).unwrap();

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("artifact.txt")).unwrap(),
        "artifact data"
    );
}

#[test]
fn artifact_404_fatal() {
    let server = MockServer::start();
    let mock = mock_status(&server, ARTIFACT_ARCHIVE_PATH, 404);

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("artifact_mount");
    let url = server.url(ARTIFACT_ARCHIVE_PATH);
    let result = run_artifact_download(&dir, &mount, Some(&url)).unwrap();

    assert!(!result);
    mock.assert_calls(1);
}

#[test]
fn storage_404_fatal() {
    let server = MockServer::start();
    mock_status(&server, STORAGE_ARCHIVE_PATH, 404);

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url(STORAGE_ARCHIVE_PATH);
    let result = run_storage_download(&dir, &mount, Some(&url)).unwrap();
    assert!(!result);
}

#[test]
fn server_error_exhausts_retries() {
    let server = MockServer::start();
    let mock = mock_status(&server, STORAGE_ARCHIVE_PATH, 500);

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url(STORAGE_ARCHIVE_PATH);
    let result = run_storage_download(&dir, &mount, Some(&url)).unwrap();

    assert!(!result);
    mock.assert_calls(EXPECTED_RETRY_ATTEMPTS);
}

#[test]
fn rate_limit_exhausts_retries() {
    let server = MockServer::start();
    let mock = mock_status(&server, STORAGE_ARCHIVE_PATH, 429);

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url(STORAGE_ARCHIVE_PATH);
    let result = run_storage_download(&dir, &mount, Some(&url)).unwrap();

    assert!(!result);
    mock.assert_calls(EXPECTED_RETRY_ATTEMPTS);
}

#[test]
fn invalid_tar_gz_non_retriable() {
    let server = MockServer::start();
    let mock = mock_gzip_archive(&server, STORAGE_ARCHIVE_PATH, b"this is not a valid tar.gz");

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url(STORAGE_ARCHIVE_PATH);
    let result = run_storage_download(&dir, &mount, Some(&url)).unwrap();

    assert!(!result);
    mock.assert_calls(1);
}

#[test]
fn http_metadata_body_read_error_retries_then_succeeds() -> std::io::Result<()> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut builder = tar::Builder::new(encoder);
    builder.append_pax_extensions([("comment", vec![b'A'; 32 * 1024].as_slice())])?;
    let mut header = tar::Header::new_ustar();
    header.set_size(2);
    header.set_mode(0o644);
    header.set_cksum();
    builder.append_data(&mut header, "ok.txt", &b"ok"[..])?;
    let archive = builder.into_inner()?.finish()?;
    let server = start_truncated_then_valid_server(archive)?;
    let dir = tempfile::tempdir()?;
    let mount = dir.path().join("mount");
    let url = format!("{}{STORAGE_ARCHIVE_PATH}", server.base_url());

    assert!(run_storage_download(&dir, &mount, Some(&url))?);
    assert_eq!(server.finish()?, 2);
    assert_eq!(std::fs::read(mount.join("ok.txt"))?, b"ok");
    Ok(())
}

#[test]
fn http_body_read_error_retries_then_succeeds() {
    let tar_gz = create_tar_gz(&[("recovered.txt", b"recovered")]).unwrap();
    let server = start_truncated_then_valid_server(tar_gz).unwrap();
    let base_url = server.base_url().to_owned();

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = format!("{base_url}{STORAGE_ARCHIVE_PATH}");
    let result = run_storage_download(&dir, &mount, Some(&url)).unwrap();
    let storage_requests = server.finish().unwrap();

    assert!(result);
    assert_eq!(storage_requests, 2);
    assert_eq!(
        std::fs::read_to_string(mount.join("recovered.txt")).unwrap(),
        "recovered"
    );
}

#[test]
fn null_and_missing_urls_skip_download() {
    let dir = tempfile::tempdir().unwrap();
    let mount1 = dir.path().join("mount1");
    let mount2 = dir.path().join("mount2");

    let manifest = write_manifest(
        &dir,
        &[
            (mount1.to_str().unwrap(), None),
            (mount2.to_str().unwrap(), Some("null")),
        ],
        None,
    )
    .unwrap();

    let result = run_guest_storage_apply(manifest.to_str().unwrap());
    assert!(result);
}

#[test]
fn manifest_file_not_found() {
    let result = run_guest_storage_apply("/tmp/nonexistent-manifest-path.json");
    assert!(!result);
}

#[test]
fn manifest_json_invalid() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = dir.path().join("manifest.json");
    std::fs::write(&manifest_path, "{{not valid json").unwrap();

    let result = run_guest_storage_apply(manifest_path.to_str().unwrap());
    assert!(!result);
}

#[test]
fn manifest_json_from_stdin_valid() {
    let json = manifest_json(&[], None).unwrap();

    let result = run_guest_storage_apply_manifest_json(&json);

    assert!(result);
}

#[test]
fn manifest_json_from_stdin_invalid() {
    let result = run_guest_storage_apply_manifest_json(b"{{not valid json secret-body");

    assert!(!result);
}

#[test]
fn artifact_500_fatal() {
    let server = MockServer::start();
    let mock = mock_status(&server, ARTIFACT_ARCHIVE_PATH, 500);

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("artifact_mount");
    let url = server.url(ARTIFACT_ARCHIVE_PATH);
    let result = run_artifact_download(&dir, &mount, Some(&url)).unwrap();

    assert!(!result);
    mock.assert_calls(EXPECTED_RETRY_ATTEMPTS);
}

#[test]
fn retry_then_succeed() {
    let server = MockServer::start();
    let tar_gz = create_tar_gz(&[("recovered.txt", b"recovered")]).unwrap();
    let mock = mock_500_then_gzip_archive(&server, STORAGE_ARCHIVE_PATH, &tar_gz);

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url(STORAGE_ARCHIVE_PATH);
    let result = run_storage_download(&dir, &mount, Some(&url)).unwrap();

    assert!(result);
    mock.assert_calls(2);
    assert_eq!(
        std::fs::read_to_string(mount.join("recovered.txt")).unwrap(),
        "recovered"
    );
}

#[test]
fn storages_partial_failure() {
    let server = MockServer::start();
    let tar_gz = create_tar_gz(&[("ok.txt", b"ok")]).unwrap();

    mock_gzip_archive(&server, "/good.tar.gz", &tar_gz);
    mock_status(&server, "/bad.tar.gz", 404);

    let dir = tempfile::tempdir().unwrap();
    let mount_good = dir.path().join("good");
    let mount_bad = dir.path().join("bad");
    let url_good = server.url("/good.tar.gz");
    let url_bad = server.url("/bad.tar.gz");

    let manifest = write_manifest(
        &dir,
        &[
            (mount_good.to_str().unwrap(), Some(&url_good)),
            (mount_bad.to_str().unwrap(), Some(&url_bad)),
        ],
        None,
    )
    .unwrap();

    let result = run_guest_storage_apply(manifest.to_str().unwrap());

    assert!(!result);
    // The successful storage should still have extracted its file
    assert_eq!(
        std::fs::read_to_string(mount_good.join("ok.txt")).unwrap(),
        "ok"
    );
}

#[test]
fn artifact_null_url_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("artifact_mount");

    // archiveUrl is the string "null" — should be treated as missing
    let result = run_artifact_download(&dir, &mount, Some("null")).unwrap();
    assert!(result);

    // archiveUrl is absent entirely
    let result = run_artifact_download(&dir, &mount, None).unwrap();
    assert!(result);
}
