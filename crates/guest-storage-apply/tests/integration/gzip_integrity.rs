use crate::support::{
    TcpTestServer, create_tar_gz, manifest_json, read_http_request_path,
    run_guest_storage_apply_manifest_json,
};
use flate2::Compression;
use flate2::write::GzEncoder;
use httpmock::prelude::*;
use std::io::{self, Write};
use std::path::Path;
use std::time::Duration;

const ARCHIVE_PATH: &str = "/archive.tar.gz";
const FILE_PATH: &str = "file.txt";
const PAYLOAD: &[u8] = b"ORIGINAL_PAYLOAD";
const RETRY_ATTEMPTS: usize = 3;

fn create_stored_archive() -> io::Result<Vec<u8>> {
    let mut tar = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_mode(0o644);
    header.set_size(PAYLOAD.len() as u64);
    header.set_cksum();
    tar.append_data(&mut header, FILE_PATH, PAYLOAD)?;

    // Stored DEFLATE blocks keep the payload available for a literal bit change
    // without damaging tar headers or its end markers.
    let mut gzip = GzEncoder::new(Vec::new(), Compression::none());
    gzip.write_all(&tar.into_inner()?)?;
    // Valid tar record padding keeps the withheld trailer beyond HTTP/decoder
    // read-ahead, so transport failures occur after tar entry iteration ends.
    gzip.write_all(&[0; 64 * 1024])?;
    gzip.finish()
}

fn apply_archive(mount: &Path, url: &str) -> io::Result<bool> {
    let mount = mount
        .to_str()
        .ok_or_else(|| io::Error::other("test mount is not UTF-8"))?;
    let manifest = manifest_json(&[(mount, Some(url))], None)?;
    Ok(run_guest_storage_apply_manifest_json(&manifest))
}

fn assert_corrupt_archive_rejected(bytes: &[u8]) -> io::Result<()> {
    let dir = tempfile::tempdir()?;
    let archive = dir.path().join("archive.tar.gz");
    std::fs::write(&archive, bytes)?;
    let local_url = format!("file://{}", archive.display());
    assert!(!apply_archive(&dir.path().join("local"), &local_url)?);

    let server = MockServer::start();
    let response = server.mock(|when, then| {
        when.method(GET).path(ARCHIVE_PATH);
        then.status(200)
            .header("content-type", "application/gzip")
            .body(bytes);
    });
    // The HTTP body is complete even when the gzip trailer is absent: this is
    // an archive-format failure, not a retriable HTTP body-read failure.
    assert!(!apply_archive(
        &dir.path().join("remote"),
        &server.url(ARCHIVE_PATH),
    )?);
    response.assert_calls(1);
    Ok(())
}

#[test]
fn corrupt_gzip_crc_is_rejected() {
    let mut archive = create_stored_archive().unwrap();
    let crc_offset = archive.len() - 8;
    archive[crc_offset] ^= 1;
    assert_corrupt_archive_rejected(&archive).unwrap();
}

#[test]
fn corrupt_gzip_size_is_rejected() {
    let mut archive = create_stored_archive().unwrap();
    let size_offset = archive.len() - 4;
    archive[size_offset] ^= 1;
    assert_corrupt_archive_rejected(&archive).unwrap();
}

#[test]
fn changed_gzip_payload_with_original_crc_is_rejected() {
    let mut archive = create_stored_archive().unwrap();
    let offset = archive
        .windows(PAYLOAD.len())
        .position(|window| window == PAYLOAD)
        .unwrap();
    archive[offset] = b'X';
    assert_corrupt_archive_rejected(&archive).unwrap();
}

#[test]
fn missing_gzip_trailer_is_rejected() {
    let mut archive = create_stored_archive().unwrap();
    archive.truncate(archive.len() - 8);
    assert_corrupt_archive_rejected(&archive).unwrap();
}

#[test]
fn valid_stored_and_compressed_archives_extract() {
    for archive in [
        create_stored_archive().unwrap(),
        create_tar_gz(&[(FILE_PATH, PAYLOAD)]).unwrap(),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("archive.tar.gz");
        std::fs::write(&staged, archive).unwrap();
        let mount = dir.path().join("mount");
        let url = format!("file://{}", staged.display());

        assert!(apply_archive(&mount, &url).unwrap());
        assert_eq!(std::fs::read(mount.join(FILE_PATH)).unwrap(), PAYLOAD);
    }
}

#[test]
fn valid_empty_archive_extracts() {
    let dir = tempfile::tempdir().unwrap();
    let staged = dir.path().join("empty.tar.gz");
    std::fs::write(&staged, create_tar_gz(&[]).unwrap()).unwrap();
    let mount = dir.path().join("mount");
    let url = format!("file://{}", staged.display());

    assert!(apply_archive(&mount, &url).unwrap());
    assert_eq!(std::fs::read_dir(mount).unwrap().count(), 0);
}

fn start_late_truncation_server(
    archive: Vec<u8>,
    failures: usize,
) -> io::Result<TcpTestServer<usize>> {
    // Preserve the complete tar payload and both end markers, withholding only
    // the gzip trailer while advertising the full HTTP Content-Length.
    let partial: Vec<u8> = archive.iter().copied().take(archive.len() - 8).collect();
    TcpTestServer::start(move |server| {
        let mut requests = 0;
        while let Some(mut stream) = server.accept()? {
            stream.set_read_timeout(Some(Duration::from_secs(1)))?;
            stream.set_write_timeout(Some(Duration::from_secs(1)))?;
            let path = read_http_request_path(&mut stream)?;
            if path != ARCHIVE_PATH {
                return Err(io::Error::other(format!("unexpected request: {path}")));
            }
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/gzip\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                archive.len(),
            )?;
            let body = if requests < failures {
                &partial
            } else {
                &archive
            };
            stream.write_all(body)?;
            requests += 1;
            if requests == RETRY_ATTEMPTS {
                break;
            }
        }
        Ok(requests)
    })
}

#[test]
fn late_http_body_failure_retries_then_extracts() {
    let server = start_late_truncation_server(create_stored_archive().unwrap(), 1).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = format!("{}{ARCHIVE_PATH}", server.base_url());

    let result = apply_archive(&mount, &url).unwrap();
    let requests = server.finish().unwrap();

    assert!(result);
    assert_eq!(requests, 2);
    assert_eq!(std::fs::read(mount.join(FILE_PATH)).unwrap(), PAYLOAD);
}

#[test]
fn late_http_body_failures_exhaust_retries() {
    let server =
        start_late_truncation_server(create_stored_archive().unwrap(), RETRY_ATTEMPTS).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let url = format!("{}{ARCHIVE_PATH}", server.base_url());

    let result = apply_archive(&dir.path().join("mount"), &url).unwrap();
    let requests = server.finish().unwrap();

    assert!(!result);
    assert_eq!(requests, RETRY_ATTEMPTS);
}
