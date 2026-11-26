use super::*;
use flate2::Compression;
use flate2::write::GzEncoder;
use std::fs;
use std::io::Seek;
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

fn extract(dir: &TempDir, bytes: &[u8], inline: bool) -> Result<(), DownloadError> {
    if inline {
        try_extract_inline(bytes, dir.path(), 1).expect("the test inflater starts")
    } else {
        let source = dir.path().join("archive.tar.gz");
        fs::write(&source, bytes).unwrap();
        let mut file = File::open(source).unwrap();
        try_extract_staged(&mut file, dir.path(), 1)
            .expect("the test inflater starts")
            .0
    }
}

#[test]
fn wide_read_ahead_samples_a_prefix_of_small_regular_files() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("archive.tar.gz");
    let content = [b'a'; 16 * 1024];

    for (file_count, large_file, expected) in
        [(16, None, true), (15, None, false), (16, Some(4), false)]
    {
        let encoder = GzEncoder::new(fs::File::create(&source).unwrap(), Compression::none());
        let mut archive = tar::Builder::new(encoder);
        for index in 0..file_count {
            let size = if large_file == Some(index) {
                content.len()
            } else {
                128
            };
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(size as u64);
            archive
                .append_data(&mut header, format!("file-{index}"), &content[..size])
                .unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap();

        let mut staged = File::open(&source).unwrap();
        let bytes = fs::read(&source).unwrap();
        assert_eq!(
            has_small_file_prefix(|output, offset| staged.read_exact_at(output, offset)),
            expected
        );
        assert_eq!(staged.stream_position().unwrap(), 0);
        assert_eq!(
            has_small_file_prefix(|output, offset| read_inline_at(&bytes, output, offset)),
            expected
        );
    }
}

#[test]
fn extracts_across_recycled_blocks_with_tar_metadata() {
    let line = b"bounded archive extraction\n";
    let content = line.repeat((3 * BLOCK_BYTES).div_ceil(line.len()));
    let archive = gzip_archive("package/notes.txt", &content);

    for inline in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let result = extract(&dir, &archive, inline);
        result.unwrap_or_else(|error| panic!("{error}"));

        let path = dir.path().join("package/notes.txt");
        let metadata = fs::metadata(&path).unwrap();
        assert_eq!(metadata.permissions().mode() & 0o777, 0o640);
        assert_eq!(metadata.mtime(), 1_730_000_000);
        assert_eq!(metadata.atime(), 1_730_000_000);
        assert_eq!(fs::read(path).unwrap(), content);
    }
}

#[test]
fn rejects_a_corrupt_gzip_trailer() {
    let content = b"archive data\n".repeat(24_000);
    let mut archive = gzip_archive("notes.txt", &content);
    let crc = archive.len() - 8;
    archive[crc] ^= 1;

    for inline in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let result = extract(&dir, &archive, inline);
        assert!(result.is_err());
    }
}

#[test]
fn settles_the_inflater_after_an_early_write_error() {
    let content = vec![b'x'; 3 * BLOCK_BYTES];
    let archive = gzip_archive("blocked/notes.txt", &content);

    for inline in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("blocked");
        fs::write(&blocker, b"existing file").unwrap();
        let result = extract(&dir, &archive, inline);
        assert!(result.is_err());
        assert_eq!(fs::read(blocker).unwrap(), b"existing file");
    }
}
