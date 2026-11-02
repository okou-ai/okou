use std::io::Cursor;

use super::*;

#[test]
fn compressed_reader_stops_at_actual_byte_limit() {
    let mut reader = CompressedLimitReader::new(Cursor::new(b"abcd"), 3);
    let mut output = Vec::new();

    let error = reader.read_to_end(&mut output).unwrap_err();

    assert_eq!(output, b"abc");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
}

#[test]
fn decompressed_reader_bounds_high_ratio_zstd_output() {
    let compressed = zstd::stream::encode_all(Cursor::new(vec![0u8; 4096]), 1).unwrap();
    let decoder = zstd::stream::read::Decoder::new(Cursor::new(compressed)).unwrap();
    let phase = Rc::new(Cell::new(ReadPhase::Payload));
    let limits = TemplateArchiveLimits {
        max_decompressed_bytes: 1024,
        max_compressed_bytes: u64::MAX,
    };
    let mut reader = DecompressedLimitReader::new(decoder, limits, phase);
    let mut output = Vec::new();

    let error = reader.read_to_end(&mut output).unwrap_err();

    assert_eq!(output.len(), 1024);
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
}

#[test]
fn archive_limit_arithmetic_rejects_overflow() {
    let error = TemplateArchiveLimits::new(u64::MAX).unwrap_err();

    assert!(matches!(error, R2Error::Io(_)));
}

#[test]
fn decoder_rejects_window_larger_than_explicit_limit() {
    let mut header = tar::Header::new_gnu();
    header.set_path(TEMPLATE_FILE).unwrap();
    header.set_entry_type(tar::EntryType::Regular);
    header.set_mode(0o644);
    header.set_size(0);
    header.set_cksum();
    let mut tar_bytes = header.as_bytes().to_vec();
    tar_bytes.extend_from_slice(&[0; TAR_TRAILER_BYTES as usize]);

    // Build the frame directly so its 2^28-byte window is independent of
    // encoder heuristics for this small payload. There is no content size.
    let mut frame = vec![0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x90];
    // A final raw block stores its payload length above the three flag bits.
    let raw_block_header = ((tar_bytes.len() as u32) << 3) | 1;
    frame.extend_from_slice(&raw_block_header.to_le_bytes()[..3]);
    frame.extend_from_slice(&tar_bytes);

    // Prove the complete frame is valid when its advertised window is allowed.
    let mut decoder = zstd::stream::read::Decoder::new(Cursor::new(&frame)).unwrap();
    decoder.window_log_max(28).unwrap();
    let mut decoded = Vec::new();
    decoder.read_to_end(&mut decoded).unwrap();
    assert_eq!(decoded, tar_bytes);

    let staging = tempfile::tempdir().unwrap();

    let error = unpack_template_from_reader(
        Cursor::new(frame),
        staging.path(),
        0,
        TemplateArchiveLimits::new(0).unwrap(),
    )
    .unwrap_err();

    assert!(matches!(error, TemplateUnpackError::Invalid(_)));
}

#[test]
fn second_member_payload_is_not_unpacked() {
    let encoder = zstd::stream::write::Encoder::new(Vec::new(), 1).unwrap();
    let mut builder = tar::Builder::new(encoder);
    for (name, contents) in [
        (TEMPLATE_FILE, b"hello".as_slice()),
        ("extra.txt", b"must not unpack".as_slice()),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_path(name).unwrap();
        header.set_mode(0o644);
        header.set_size(contents.len() as u64);
        header.set_cksum();
        builder.append(&header, Cursor::new(contents)).unwrap();
    }
    let encoder = builder.into_inner().unwrap();
    let archive = encoder.finish().unwrap();
    let staging = tempfile::tempdir().unwrap();

    let error = unpack_template_from_reader(
        Cursor::new(archive),
        staging.path(),
        5,
        TemplateArchiveLimits::new(5).unwrap(),
    )
    .unwrap_err();

    assert!(matches!(error, TemplateUnpackError::Invalid(_)));
    assert_eq!(
        std::fs::read(staging.path().join(TEMPLATE_FILE)).unwrap(),
        b"hello"
    );
    assert!(!staging.path().join("extra.txt").exists());
}

#[test]
fn extraction_failure_on_local_staging_path_is_local() {
    let source = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(source.path(), b"hello").unwrap();
    let mut archive = Vec::new();
    pack_template_to_writer(&mut archive, source.path()).unwrap();
    let staging_file = tempfile::NamedTempFile::new().unwrap();

    let error = unpack_template_from_reader(
        Cursor::new(archive),
        staging_file.path(),
        5,
        TemplateArchiveLimits::new(5).unwrap(),
    )
    .unwrap_err();

    assert!(matches!(error, TemplateUnpackError::Local(_)));
}
