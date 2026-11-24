use super::*;
use flate2::Compression;
use flate2::write::GzEncoder;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use tempfile::TempDir;

fn gzip_archive(path: &str, content: &[u8]) -> Vec<u8> {
    let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Regular);
    header.set_mode(0o640);
    header.set_mtime(1_730_000_000);
    header.set_size(content.len() as u64);
    builder.append_data(&mut header, path, content).unwrap();
    builder.into_inner().unwrap().finish().unwrap()
}

fn extract(dir: &TempDir, bytes: &[u8]) -> (Result<(), DownloadError>, Duration) {
    let source = dir.path().join("archive.tar.gz");
    fs::write(&source, bytes).unwrap();
    let mut file = File::open(source).unwrap();
    try_extract(&mut file, dir.path()).expect("the test inflater starts")
}

#[test]
fn extracts_across_recycled_blocks_with_tar_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let content = b"bounded archive extraction\n".repeat(8000);
    let archive = gzip_archive("package/notes.txt", &content);

    let (result, _) = extract(&dir, &archive);
    result.unwrap_or_else(|error| panic!("{error}"));

    let path = dir.path().join("package/notes.txt");
    let metadata = fs::metadata(&path).unwrap();
    assert_eq!(metadata.permissions().mode() & 0o777, 0o640);
    assert_eq!(metadata.mtime(), 1_730_000_000);
    assert_eq!(metadata.atime(), 1_730_000_000);
    assert_eq!(fs::read(path).unwrap(), content);
}

#[test]
fn rejects_a_corrupt_gzip_trailer() {
    let dir = tempfile::tempdir().unwrap();
    let content = b"archive data\n".repeat(24_000);
    let mut archive = gzip_archive("notes.txt", &content);
    let crc = archive.len() - 8;
    archive[crc] ^= 1;

    let (result, _) = extract(&dir, &archive);
    assert!(result.is_err());
}

#[test]
fn settles_the_inflater_after_an_early_write_error() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("blocked");
    fs::write(&blocker, b"existing file").unwrap();
    let content = b"archive data\n".repeat(30_000);
    let archive = gzip_archive("blocked/notes.txt", &content);

    let (result, _) = extract(&dir, &archive);
    assert!(result.is_err());
    assert_eq!(fs::read(blocker).unwrap(), b"existing file");
}
