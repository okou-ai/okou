use super::*;
use std::fs;

fn encoded(raw: &[u8]) -> Vec<u8> {
    let mut writer = zstd::stream::write::Encoder::new(Vec::new(), -1).unwrap();
    writer.include_checksum(true).unwrap();
    writer.set_pledged_src_size(Some(raw.len() as u64)).unwrap();
    writer.write_all(raw).unwrap();
    writer.finish().unwrap()
}

fn invoke(path: &std::path::Path, size: usize, bytes: &[u8]) -> (i32, String) {
    let mut stderr = Vec::new();
    let code = super::super::run_cli(
        [
            "--zstd".into(),
            size.to_string(),
            "--".into(),
            path.to_str().unwrap().into(),
        ],
        bytes,
        &mut stderr,
    );
    (code, String::from_utf8(stderr).unwrap())
}

#[test]
fn invalid_compressed_arguments_report_usage_errors() {
    for args in [
        vec!["--zstd"],
        vec!["--zstd", "invalid", "--", "/unused"],
        vec!["--zstd", "0", "--private", "--", "/unused"],
        vec!["--zstd", "0", "--batch"],
    ] {
        let mut stderr = Vec::new();
        assert_eq!(
            super::super::run_cli(
                args.into_iter().map(str::to_string),
                b"".as_slice(),
                &mut stderr
            ),
            2
        );
        assert!(String::from_utf8(stderr).unwrap().contains("usage:"));
    }
}

#[test]
fn exact_size_zstd_preserves_bytes() {
    let dir = tempfile::tempdir().unwrap();
    for raw in [b"".as_slice(), b"test-stream\0"] {
        let payload = encoded(raw);
        let path = dir.path().join("out");
        assert_eq!(invoke(&path, raw.len(), &payload), (0, String::new()));
        assert_eq!(fs::read(path).unwrap(), raw);
    }
}

#[test]
fn short_and_oversized_decoded_streams_fail() {
    let dir = tempfile::tempdir().unwrap();
    let payload = encoded(b"hello");
    for size in [4, 6] {
        assert_ne!(invoke(&dir.path().join("out"), size, &payload).0, 0);
    }
}

#[test]
fn truncated_checksum_and_trailing_frames_fail() {
    let dir = tempfile::tempdir().unwrap();
    let encoded = encoded(b"hello");
    let mut corrupt = encoded.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    let mut trailing = encoded.clone();
    trailing.extend_from_slice(b"extra");
    let mut concatenated = encoded.clone();
    concatenated.extend_from_slice(&encoded);
    for bytes in [
        encoded[..encoded.len() - 1].to_vec(),
        corrupt,
        trailing,
        concatenated,
    ] {
        assert_ne!(invoke(&dir.path().join("out"), 5, &bytes).0, 0);
    }
}

#[test]
fn checksumless_and_oversized_window_frames_fail() {
    let dir = tempfile::tempdir().unwrap();
    let unchecked = zstd::stream::encode_all(b"hello".as_slice(), -1).unwrap();
    assert_eq!(
        zstd::stream::decode_all(unchecked.as_slice()).unwrap(),
        b"hello"
    );
    assert_ne!(invoke(&dir.path().join("unchecked"), 5, &unchecked).0, 0);

    // A valid empty frame with a 32 MiB window exceeds our 16 MiB limit.
    let empty = encoded(b"");
    let mut oversized = vec![0x28, 0xb5, 0x2f, 0xfd, 0x04, 120, 1, 0, 0];
    oversized.extend_from_slice(&empty[empty.len() - 4..]);
    assert!(
        zstd::stream::decode_all(oversized.as_slice())
            .unwrap()
            .is_empty()
    );
    assert_ne!(invoke(&dir.path().join("oversized"), 0, &oversized).0, 0);
}

#[test]
fn stream_keeps_destination_symlink_protection() {
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("original");
    let target = dir.path().join("target");
    fs::write(&original, b"unchanged").unwrap();
    std::os::unix::fs::symlink(&original, &target).unwrap();
    let payload = encoded(b"hello");
    assert_ne!(invoke(&target, 5, &payload).0, 0);
    assert_eq!(fs::read(&original).unwrap(), b"unchanged");
}

#[test]
fn declared_size_bound_fails_before_opening_target() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("absent");
    assert_ne!(invoke(&target, 15 * 1024 * 1024 + 1, b"").0, 0);
    assert!(!target.exists());
}
