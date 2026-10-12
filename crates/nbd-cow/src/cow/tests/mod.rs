use super::*;
use std::ffi::OsString;
use std::io::Write as IoWrite;
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;
use tempfile::NamedTempFile;

fn write_bitmap_file(path: &Path, blocks: u64, word: u64) {
    let mut data = blocks.to_le_bytes().to_vec();
    data.extend_from_slice(&word.to_le_bytes());
    std::fs::write(path, data).unwrap();
}

fn create_base_image(data: &[u8]) -> NamedTempFile {
    let mut f = NamedTempFile::new().unwrap();
    f.write_all(data).unwrap();
    f.flush().unwrap();
    f
}

fn make_cow(
    base: &NamedTempFile,
    cow_file: &NamedTempFile,
    size: u64,
    flush_threshold: usize,
) -> CowLayer {
    CowLayer::new(base.path(), cow_file.path(), size, 4096, flush_threshold).unwrap()
}

fn assert_invalid_input(result: Result<CowLayer>) {
    let err = match result {
        Ok(_) => panic!("expected invalid input error"),
        Err(err) => err,
    };
    assert!(
        matches!(&err, NbdCowError::Io(e) if e.kind() == std::io::ErrorKind::InvalidInput),
        "expected invalid input error, got {err:?}"
    );
}

#[test]
fn constructor_rejects_zero_block_size() {
    let base = create_base_image(&vec![0x00; 4096]);
    let cow_file = NamedTempFile::new().unwrap();

    let result = CowLayer::new(base.path(), cow_file.path(), 4096, 0, 1024 * 1024);

    assert_invalid_input(result);
}

#[test]
fn constructor_rejects_zero_size() {
    let base = create_base_image(&[]);
    let cow_file = NamedTempFile::new().unwrap();

    let result = CowLayer::new(base.path(), cow_file.path(), 0, 4096, 1024 * 1024);

    assert_invalid_input(result);
}

#[test]
fn constructor_rejects_non_block_aligned_size() {
    let base = create_base_image(&vec![0x00; 4097]);
    let cow_file = NamedTempFile::new().unwrap();

    let result = CowLayer::new(base.path(), cow_file.path(), 4097, 4096, 1024 * 1024);

    assert_invalid_input(result);
}

#[test]
fn read_from_base_when_no_writes() {
    let base = create_base_image(&vec![0xAA; 8192]);
    let cow_file = NamedTempFile::new().unwrap();
    let cow = make_cow(&base, &cow_file, 8192, 1024 * 1024);

    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xAA));

    cow.read(4096, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xAA));
}

#[test]
fn multiblock_clean_base_read_uses_one_file_read() {
    let mut base_data = Vec::new();
    base_data.extend_from_slice(&vec![0x10; 4096]);
    base_data.extend_from_slice(&vec![0x20; 4096]);
    base_data.extend_from_slice(&vec![0x30; 4096]);
    let base = create_base_image(&base_data);
    let cow_file = NamedTempFile::new().unwrap();
    let cow = make_cow(&base, &cow_file, 3 * 4096, 1024 * 1024);

    let mut buf = vec![0u8; 3 * 4096];
    cow.read(0, &mut buf).unwrap();

    assert!(buf[..4096].iter().all(|&b| b == 0x10));
    assert!(buf[4096..2 * 4096].iter().all(|&b| b == 0x20));
    assert!(buf[2 * 4096..].iter().all(|&b| b == 0x30));
    assert_eq!(cow.base_read_call_count(), 1);
    assert_eq!(cow.cow_read_call_count(), 0);
}

#[test]
fn write_then_read_returns_written_data() {
    let base = create_base_image(&vec![0x00; 8192]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 8192, 1024 * 1024);

    cow.write(0, &vec![0xBB; 4096]).unwrap();

    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xBB));

    // Second block still reads from base
    cow.read(4096, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0x00));
}

#[test]
fn partial_block_write() {
    let base = create_base_image(&vec![0xAA; 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    cow.write(100, &[0xFF; 10]).unwrap();

    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf[..100].iter().all(|&b| b == 0xAA));
    assert!(buf[100..110].iter().all(|&b| b == 0xFF));
    assert!(buf[110..].iter().all(|&b| b == 0xAA));
}

#[test]
fn flush_writes_to_cow_file() {
    let base = create_base_image(&vec![0x00; 8192]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 8192, 1024 * 1024);

    cow.write(0, &vec![0xCC; 4096]).unwrap();
    assert_eq!(cow.buffered_block_count(), 1);

    cow.flush().unwrap();
    assert_eq!(cow.buffered_block_count(), 0);
    assert_eq!(cow.dirty_block_count(), 1);

    // Data should still be readable (now from COW file)
    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xCC));
}

#[test]
fn default_threshold_flush_persists_one_contiguous_batch() {
    let data_len = crate::DEFAULT_FLUSH_THRESHOLD;
    let base = create_base_image(&vec![0x00; data_len]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, data_len as u64, data_len);
    let mut data = vec![0u8; data_len];
    for (block_idx, block) in data.chunks_mut(crate::BLOCK_SIZE).enumerate() {
        block.fill((block_idx % 251) as u8);
    }

    assert!(cow.write(0, &data).unwrap());
    cow.flush().unwrap();

    let mut persisted = vec![0u8; data_len];
    cow_file.as_file().read_exact_at(&mut persisted, 0).unwrap();
    assert!(persisted == data, "persisted contiguous batch differs");
    assert_eq!(cow.dirty_block_count(), data_len / crate::BLOCK_SIZE);
    assert_eq!(cow.buffered_block_count(), 0);
    assert_eq!(cow.buffer_bytes(), 0);

    let mut read_back = vec![0u8; data_len];
    cow.read(0, &mut read_back).unwrap();
    assert!(read_back == data, "COW read-back differs");
}

#[test]
fn multiblock_dirty_cow_read_uses_one_file_read() {
    let base = create_base_image(&vec![0x00; 4 * 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 4 * 4096, 1024 * 1024);

    cow.write(4096, &vec![0xA1; 4096]).unwrap();
    cow.write(2 * 4096, &vec![0xA2; 4096]).unwrap();
    cow.flush().unwrap();

    let mut buf = vec![0u8; 2 * 4096];
    cow.read(4096, &mut buf).unwrap();

    assert!(buf[..4096].iter().all(|&b| b == 0xA1));
    assert!(buf[4096..].iter().all(|&b| b == 0xA2));
    assert_eq!(cow.base_read_call_count(), 0);
    assert_eq!(cow.cow_read_call_count(), 1);
}

#[test]
fn buffer_threshold_triggers_flush_signal() {
    let base = create_base_image(&vec![0x00; 8192]);
    let cow_file = NamedTempFile::new().unwrap();
    // Threshold: 1 block (4096 bytes)
    let mut cow = make_cow(&base, &cow_file, 8192, 4096);

    let needs_flush = cow.write(0, &vec![0xDD; 4096]).unwrap();
    assert!(needs_flush, "should signal flush when threshold reached");
}

#[test]
fn out_of_bounds_error() {
    let base = create_base_image(&vec![0x00; 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    let mut buf = vec![0u8; 4096];
    let err = cow.read(4096, &mut buf);
    assert!(err.is_err());
}

#[test]
fn full_block_write_over_dirty_block_replaces_existing_contents() {
    let base = create_base_image(&vec![0x11; 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    cow.write(0, &vec![0xAA; 4096]).unwrap();
    cow.flush().unwrap();
    assert_eq!(cow.dirty_block_count(), 1);

    cow.write(0, &vec![0xBB; 4096]).unwrap();

    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xBB));

    cow.flush().unwrap();
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xBB));
}

#[test]
fn full_block_write_does_not_read_base_block() {
    let base = create_base_image(&[]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    cow.write(0, &vec![0xCC; 4096]).unwrap();

    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xCC));
}

#[test]
fn write_after_flush_overwrites_dirty_block() {
    let base = create_base_image(&vec![0x00; 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    // Write and flush
    cow.write(0, &vec![0xAA; 4096]).unwrap();
    cow.flush().unwrap();
    assert_eq!(cow.dirty_block_count(), 1);

    // Overwrite the same block (now in COW file, not buffer)
    cow.write(0, &vec![0xBB; 4096]).unwrap();
    assert_eq!(cow.buffered_block_count(), 1);

    // Read should return the latest write (from buffer)
    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xBB));

    // Flush again and read — should still be 0xBB
    cow.flush().unwrap();
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xBB));
}

#[test]
fn zero_length_read_write() {
    let base = create_base_image(&vec![0xAA; 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    // Zero-length read and write should succeed as no-ops
    cow.read(0, &mut []).unwrap();
    cow.write(0, &[]).unwrap();
    assert_eq!(cow.buffered_block_count(), 0);

    // Also at end of device
    cow.read(4096, &mut []).unwrap();
    cow.write(4096, &[]).unwrap();
}

#[test]
fn sync_without_writes() {
    let base = create_base_image(&vec![0x00; 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    // Sync with no writes should be a no-op (no COW file created)
    cow.sync().unwrap();
    assert_eq!(cow.dirty_block_count(), 0);
    assert_eq!(cow.buffered_block_count(), 0);
}

#[test]
fn cross_block_read_write() {
    let base = create_base_image(&vec![0xAA; 8192]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 8192, 1024 * 1024);

    cow.write(4090, &[0xEE; 100]).unwrap();

    let mut buf = vec![0u8; 100];
    cow.read(4090, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xEE));
    assert_eq!(cow.buffered_block_count(), 2);
}

#[test]
fn mixed_overlay_read_preserves_source_priority_and_run_boundaries() {
    let mut base_data = Vec::new();
    for fill in [0x10, 0x20, 0x30, 0x40, 0x50, 0x60] {
        base_data.extend_from_slice(&vec![fill; 4096]);
    }
    let base = create_base_image(&base_data);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 6 * 4096, 1024 * 1024);

    cow.write(4096, &vec![0xA1; 4096]).unwrap();
    cow.write(2 * 4096, &vec![0xA2; 4096]).unwrap();
    cow.flush().unwrap();
    cow.write(3 * 4096, &vec![0xB3; 4096]).unwrap();

    let mut buf = vec![0u8; 6 * 4096];
    cow.read(0, &mut buf).unwrap();

    assert!(buf[..4096].iter().all(|&b| b == 0x10));
    assert!(buf[4096..2 * 4096].iter().all(|&b| b == 0xA1));
    assert!(buf[2 * 4096..3 * 4096].iter().all(|&b| b == 0xA2));
    assert!(buf[3 * 4096..4 * 4096].iter().all(|&b| b == 0xB3));
    assert!(buf[4 * 4096..5 * 4096].iter().all(|&b| b == 0x50));
    assert!(buf[5 * 4096..].iter().all(|&b| b == 0x60));
    assert_eq!(cow.base_read_call_count(), 2);
    assert_eq!(cow.cow_read_call_count(), 1);
}

#[test]
fn non_aligned_read_preserves_partial_edges_across_sources() {
    let mut base_data = Vec::new();
    for fill in [0x10, 0x20, 0x30, 0x40] {
        base_data.extend_from_slice(&vec![fill; 4096]);
    }
    let base = create_base_image(&base_data);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 4 * 4096, 1024 * 1024);

    cow.write(4096, &vec![0xA1; 4096]).unwrap();
    cow.flush().unwrap();
    cow.write(2 * 4096, &vec![0xB2; 4096]).unwrap();

    let first_tail_len = 17;
    let last_head_len = 23;
    let offset = 4096 - first_tail_len;
    let len = first_tail_len + 2 * 4096 + last_head_len;
    let mut buf = vec![0u8; len];

    cow.read(offset as u64, &mut buf).unwrap();

    assert!(buf[..first_tail_len].iter().all(|&b| b == 0x10));
    assert!(
        buf[first_tail_len..first_tail_len + 4096]
            .iter()
            .all(|&b| b == 0xA1)
    );
    assert!(
        buf[first_tail_len + 4096..first_tail_len + 2 * 4096]
            .iter()
            .all(|&b| b == 0xB2)
    );
    assert!(buf[first_tail_len + 2 * 4096..].iter().all(|&b| b == 0x40));
}

#[test]
fn cross_block_write_preserves_partial_edges_around_full_middle_block() {
    let mut base_data = vec![0x10; 4096];
    base_data.extend_from_slice(&vec![0x20; 4096]);
    base_data.extend_from_slice(&vec![0x30; 4096]);
    let base = create_base_image(&base_data);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 3 * 4096, 1024 * 1024);

    let first_partial_len = 128;
    let middle_full_len = 4096;
    let last_partial_len = 256;
    let offset = 4096 - first_partial_len;
    let write_data = vec![0xEE; first_partial_len + middle_full_len + last_partial_len];

    cow.write(offset as u64, &write_data).unwrap();

    let mut first_block = vec![0u8; 4096];
    cow.read(0, &mut first_block).unwrap();
    assert!(first_block[..offset].iter().all(|&b| b == 0x10));
    assert!(first_block[offset..].iter().all(|&b| b == 0xEE));

    let mut middle_block = vec![0u8; 4096];
    cow.read(4096, &mut middle_block).unwrap();
    assert!(middle_block.iter().all(|&b| b == 0xEE));

    let mut last_block = vec![0u8; 4096];
    cow.read(8192, &mut last_block).unwrap();
    assert!(last_block[..last_partial_len].iter().all(|&b| b == 0xEE));
    assert!(last_block[last_partial_len..].iter().all(|&b| b == 0x30));

    assert_eq!(cow.buffered_block_count(), 3);
}

#[test]
fn bitmap_save_load_round_trip() {
    let base = create_base_image(&vec![0x00; 8192]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 8192, 1024 * 1024);

    // Write to block 0, flush to set dirty bit
    cow.write(0, &vec![0xAA; 4096]).unwrap();
    cow.flush().unwrap();
    assert_eq!(cow.dirty_block_count(), 1);

    // Save bitmap
    let bitmap_file = NamedTempFile::new().unwrap();
    cow.save_bitmap(bitmap_file.path()).unwrap();

    // Load bitmap and verify
    let loaded = bitmap::load_bitmap(bitmap_file.path(), 2).unwrap();
    assert_eq!(loaded.count_ones(), 1);
    assert!(loaded[0]); // block 0 is dirty
    assert!(!loaded[1]); // block 1 is clean
}

#[test]
fn bitmap_save_uses_documented_file_layout() {
    const BLOCK_SIZE: usize = 4096;
    const BLOCKS: usize = 131;
    let base = create_base_image(&vec![0x00; BLOCKS * BLOCK_SIZE]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, (BLOCKS * BLOCK_SIZE) as u64, 1024 * 1024);

    cow.write(0, &vec![0xA0; BLOCK_SIZE]).unwrap();
    cow.write((64 * BLOCK_SIZE) as u64, &vec![0xA1; BLOCK_SIZE])
        .unwrap();
    cow.write((130 * BLOCK_SIZE) as u64, &vec![0xA2; BLOCK_SIZE])
        .unwrap();
    cow.flush().unwrap();

    let bitmap_file = NamedTempFile::new().unwrap();
    cow.save_bitmap(bitmap_file.path()).unwrap();

    let data = std::fs::read(bitmap_file.path()).unwrap();
    assert_eq!(data.len(), 8 + 3 * 8);
    assert_eq!(&data[..8], &(BLOCKS as u64).to_le_bytes());
    assert_eq!(&data[8..16], &1u64.to_le_bytes());
    assert_eq!(&data[16..24], &1u64.to_le_bytes());
    assert_eq!(&data[24..32], &(1u64 << 2).to_le_bytes());
}

#[test]
fn bitmap_large_round_trip_preserves_file_layout() {
    const WORDS_PER_64K_PAYLOAD: usize = 64 * 1024 / 8;
    const WORDS: usize = WORDS_PER_64K_PAYLOAD + 2;
    const BLOCKS: usize = WORDS * 64;

    let mut dirty: BitVec = bitvec![0; BLOCKS];
    dirty.set(0, true);
    dirty.set(WORDS_PER_64K_PAYLOAD * 64, true);
    dirty.set(BLOCKS - 1, true);

    let bitmap_file = NamedTempFile::new().unwrap();
    bitmap::save_bitmap(&dirty, bitmap_file.path()).unwrap();

    let data = std::fs::read(bitmap_file.path()).unwrap();
    assert_eq!(data.len(), 8 + WORDS * 8);
    assert_eq!(&data[..8], &(BLOCKS as u64).to_le_bytes());
    assert_eq!(bitmap_word(&data, 0), 1);
    assert_eq!(bitmap_word(&data, WORDS_PER_64K_PAYLOAD), 1);
    assert_eq!(bitmap_word(&data, WORDS - 1), 1u64 << 63);

    let loaded = bitmap::load_bitmap(bitmap_file.path(), BLOCKS).unwrap();
    assert_eq!(loaded, dirty);
}

fn bitmap_word(data: &[u8], word_index: usize) -> u64 {
    let start = 8 + word_index * 8;
    u64::from_le_bytes(data[start..start + 8].try_into().unwrap())
}

#[test]
fn bitmap_load_wrong_block_count_errors() {
    let base = create_base_image(&vec![0x00; 8192]);
    let cow_file = NamedTempFile::new().unwrap();
    let cow = make_cow(&base, &cow_file, 8192, 1024 * 1024);

    let bitmap_file = NamedTempFile::new().unwrap();
    cow.save_bitmap(bitmap_file.path()).unwrap();

    // Try to load with wrong block count
    let result = bitmap::load_bitmap(bitmap_file.path(), 999);
    assert!(result.is_err());
}

#[test]
fn bitmap_load_truncated_data_errors() {
    let bitmap_file = NamedTempFile::new().unwrap();

    // Write header claiming 128 blocks but no bitmap data
    let num_blocks: u64 = 128;
    std::fs::write(bitmap_file.path(), num_blocks.to_le_bytes()).unwrap();

    let result = bitmap::load_bitmap(bitmap_file.path(), 128);
    assert!(result.is_err());

    // Write header + partial data (less than needed)
    let mut data = num_blocks.to_le_bytes().to_vec();
    data.extend_from_slice(&[0u8; 4]); // only 4 bytes, need 128/64*8 = 16
    std::fs::write(bitmap_file.path(), &data).unwrap();

    let result = bitmap::load_bitmap(bitmap_file.path(), 128);
    assert!(result.is_err());
}

#[test]
fn bitmap_load_ignores_extra_tail_bytes() {
    let bitmap_file = NamedTempFile::new().unwrap();
    let mut data = 1u64.to_le_bytes().to_vec();
    data.extend_from_slice(&0u64.to_le_bytes());
    data.extend_from_slice(&[0xAA; 16]);
    std::fs::write(bitmap_file.path(), data).unwrap();

    let loaded = bitmap::load_bitmap(bitmap_file.path(), 1).unwrap();

    assert_eq!(loaded.count_ones(), 0);
}

#[test]
fn bitmap_cow_coverage_rejects_truncated_dirty_block() {
    let bitmap_file = NamedTempFile::new().unwrap();
    write_bitmap_file(bitmap_file.path(), 2, 0b10);

    let result = validate_bitmap_cow_coverage(bitmap_file.path(), 4096, 4096, 2);

    assert!(result.is_err());
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("dirty bitmap references COW data")
    );
}

#[test]
fn bitmap_cow_coverage_accepts_clean_bitmap_with_short_cow_file() {
    let bitmap_file = NamedTempFile::new().unwrap();
    write_bitmap_file(bitmap_file.path(), 2, 0);

    validate_bitmap_cow_coverage(bitmap_file.path(), 0, 4096, 2).unwrap();
}

#[test]
fn bitmap_cow_coverage_accepts_covering_cow_file() {
    let bitmap_file = NamedTempFile::new().unwrap();
    write_bitmap_file(bitmap_file.path(), 2, 0b10);

    validate_bitmap_cow_coverage(bitmap_file.path(), 8192, 4096, 2).unwrap();
}

#[test]
fn bitmap_save_rejects_path_without_parent() {
    let base = create_base_image(&vec![0x00; 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    // `/` has no parent. The function must reject it before touching the FS
    // so callers can't accidentally skip the parent-dir fsync durability
    // guarantee by passing a degenerate path.
    let err = cow.save_bitmap(Path::new("/")).unwrap_err();
    assert!(matches!(err, NbdCowError::Io(_)), "got {err:?}");
}

#[test]
fn bitmap_save_handles_non_utf8_parent_path() {
    let tmp = tempfile::tempdir().unwrap();
    let non_utf8_dir = tmp.path().join(PathBuf::from(OsString::from_vec(
        b"bitmap-parent-\xff".to_vec(),
    )));
    std::fs::create_dir(&non_utf8_dir).unwrap();
    let base_path = non_utf8_dir.join("base.img");
    std::fs::write(&base_path, vec![0; 4096]).unwrap();
    let cow_path = non_utf8_dir.join("cow.img");
    let cow = CowLayer::new(&base_path, &cow_path, 4096, 4096, 1024 * 1024).unwrap();
    let bitmap_path = bitmap_path_for(&cow_path);
    let tmp_path = bitmap::bitmap_tmp_path_for(&bitmap_path);

    cow.save_bitmap(&bitmap_path).unwrap();

    assert!(bitmap_path.exists());
    assert!(!tmp_path.exists());
    bitmap::load_bitmap(&bitmap_path, 1).unwrap();
}

#[test]
fn bitmap_save_replaces_stale_tmp_symlink_without_following() {
    let tmp = tempfile::tempdir().unwrap();
    let base_path = tmp.path().join("base.img");
    std::fs::write(&base_path, vec![0; 4096]).unwrap();
    let cow_path = tmp.path().join("cow.img");
    let cow = CowLayer::new(&base_path, &cow_path, 4096, 4096, 1024 * 1024).unwrap();
    let bitmap_path = bitmap_path_for(&cow_path);
    let tmp_path = bitmap::bitmap_tmp_path_for(&bitmap_path);
    let symlink_target = tmp.path().join("tmp-symlink-target");
    std::fs::write(&symlink_target, b"keep").unwrap();
    std::os::unix::fs::symlink(&symlink_target, &tmp_path).unwrap();

    cow.save_bitmap(&bitmap_path).unwrap();

    assert!(
        std::fs::symlink_metadata(&bitmap_path)
            .unwrap()
            .file_type()
            .is_file()
    );
    assert!(!tmp_path.exists());
    assert_eq!(std::fs::read(&symlink_target).unwrap(), b"keep");
    bitmap::load_bitmap(&bitmap_path, 1).unwrap();
}

#[test]
fn bitmap_empty_round_trip() {
    let base = create_base_image(&vec![0x00; 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    let bitmap_file = NamedTempFile::new().unwrap();
    cow.save_bitmap(bitmap_file.path()).unwrap();

    let loaded = bitmap::load_bitmap(bitmap_file.path(), 1).unwrap();
    assert_eq!(loaded.count_ones(), 0);
}

#[test]
fn create_with_existing_bitmap_restores_dirty_state() {
    let base_data = vec![0x00; 8192];
    let base = create_base_image(&base_data);
    let cow_file = NamedTempFile::new().unwrap();

    // Phase 1: write, flush, save bitmap
    {
        let mut cow = make_cow(&base, &cow_file, 8192, 1024 * 1024);
        cow.write(0, &vec![0xBB; 4096]).unwrap();
        cow.flush().unwrap();
        let bitmap_path = bitmap_path_for(cow_file.path());
        cow.save_bitmap(&bitmap_path).unwrap();
    }

    // Phase 2: create new CowLayer with same paths — bitmap auto-loaded
    let cow2 = CowLayer::new(base.path(), cow_file.path(), 8192, 4096, 1024 * 1024).unwrap();
    assert_eq!(
        cow2.dirty_block_count(),
        1,
        "dirty bitmap should be restored"
    );

    // Read block 0 — should come from COW file, not base
    let mut buf = vec![0u8; 4096];
    cow2.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xBB), "restored data should match");

    // Read block 1 — should come from base
    cow2.read(4096, &mut buf).unwrap();
    assert!(
        buf.iter().all(|&b| b == 0x00),
        "unmodified block should read from base"
    );

    // Cleanup bitmap file
    let _ = std::fs::remove_file(bitmap_path_for(cow_file.path()));
}

#[test]
fn create_without_bitmap_starts_fresh() {
    let base = create_base_image(&vec![0xAA; 4096]);
    let cow_file = NamedTempFile::new().unwrap();

    // No bitmap file exists — should start with empty dirty set
    let cow = CowLayer::new(base.path(), cow_file.path(), 4096, 4096, 1024 * 1024).unwrap();
    assert_eq!(cow.dirty_block_count(), 0);

    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xAA));
}

#[test]
fn create_with_broken_bitmap_symlink_errors() {
    let base = create_base_image(&vec![0xAA; 4096]);
    let tmp = tempfile::tempdir().unwrap();
    let cow_path = tmp.path().join("cow.img");
    let bitmap_path = bitmap_path_for(&cow_path);
    std::os::unix::fs::symlink(tmp.path().join("missing-bitmap"), &bitmap_path).unwrap();

    let err = match CowLayer::new(base.path(), &cow_path, 4096, 4096, 1024 * 1024) {
        Ok(_) => panic!("expected broken bitmap symlink to fail"),
        Err(err) => err,
    };

    assert!(
        matches!(&err, NbdCowError::Io(e) if e.kind() == std::io::ErrorKind::NotFound),
        "expected missing broken bitmap target error, got {err:?}"
    );
}

#[test]
fn create_with_dirty_bitmap_beyond_cow_file_errors() {
    let base = create_base_image(&vec![0xAA; 8192]);
    let cow_file = NamedTempFile::new().unwrap();
    write_bitmap_file(&bitmap_path_for(cow_file.path()), 2, 0b10);

    let err = match CowLayer::new(base.path(), cow_file.path(), 8192, 4096, 1024 * 1024) {
        Ok(_) => panic!("expected truncated COW file to fail"),
        Err(err) => err,
    };

    assert!(
        err.to_string().contains("dirty bitmap references COW data"),
        "expected dirty bitmap coverage error, got {err:?}"
    );
}

// ---------- flush_buffered recovery tests ----------
//
// flush_buffered is driven directly with a controllable writer closure.
// Real error injection (/dev/full, file seals, RLIMIT_FSIZE) cannot
// reproduce partial-success-then-fail at arbitrary byte offset, which is the
// scenario the recovery logic protects against.

// Returns the two `NamedTempFile` handles alongside the `CowLayer` so the
// caller must bind them (as `_base`, `_cow_file`, etc.) to keep the backing
// files alive for the test's duration. Discarding them with `_` would drop
// the files mid-test and silently break reads.
fn seed_cow_with_writes(blocks: &[(u64, u8)]) -> (NamedTempFile, NamedTempFile, CowLayer) {
    // 8-block device = 32KB. All tests use at most 4 distinct blocks.
    let base = create_base_image(&vec![0x00; 8 * 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 8 * 4096, 1024 * 1024);
    for &(idx, fill) in blocks {
        cow.write(idx * 4096, &vec![fill; 4096]).unwrap();
    }
    (base, cow_file, cow)
}

fn buffered_len(buffers: &[IoSlice<'_>]) -> usize {
    buffers.iter().map(|buffer| buffer.len()).sum()
}

fn buffered_fills(buffers: &[IoSlice<'_>]) -> Vec<u8> {
    buffers.iter().map(|buffer| buffer[0]).collect()
}

#[test]
fn flush_buffered_success_path_drains_buffer() {
    let (_b, _c, mut cow) = seed_cow_with_writes(&[(0, 0xAA), (1, 0xBB), (5, 0xCC)]);

    let mut calls = Vec::new();
    cow.flush_buffered(|offset, buffers| {
        calls.push((offset, buffered_fills(buffers)));
        Ok(buffered_len(buffers))
    })
    .unwrap();

    assert_eq!(cow.buffered_block_count(), 0);
    assert_eq!(cow.buffer_bytes(), 0);
    assert_eq!(cow.dirty_block_count(), 3);
    assert_eq!(calls, vec![(0, vec![0xAA, 0xBB]), (5 * 4096, vec![0xCC])]);
}

#[test]
fn flush_buffered_default_threshold_uses_one_writer_call() {
    const BLOCK_SIZE: usize = 4096;
    let block_count = crate::DEFAULT_FLUSH_THRESHOLD / BLOCK_SIZE;
    assert_eq!(block_count, MAX_WRITE_IOVECS);
    let base = create_base_image(&vec![0x00; crate::DEFAULT_FLUSH_THRESHOLD]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(
        &base,
        &cow_file,
        crate::DEFAULT_FLUSH_THRESHOLD as u64,
        crate::DEFAULT_FLUSH_THRESHOLD,
    );
    cow.write(0, &vec![0xA5; crate::DEFAULT_FLUSH_THRESHOLD])
        .unwrap();

    let mut calls = Vec::new();
    cow.flush_buffered(|offset, buffers| {
        calls.push((offset, buffers.len(), buffered_len(buffers)));
        Ok(buffered_len(buffers))
    })
    .unwrap();

    assert_eq!(
        calls,
        vec![(0, block_count, crate::DEFAULT_FLUSH_THRESHOLD)]
    );
    assert_eq!(cow.buffered_block_count(), 0);
    assert_eq!(cow.dirty_block_count(), block_count);
}

#[test]
fn flush_buffered_splits_contiguous_data_at_iov_max() {
    const BLOCK_SIZE: usize = 4096;
    let block_count = MAX_WRITE_IOVECS + 1;
    let data_len = block_count * BLOCK_SIZE;
    let base = create_base_image(&vec![0x00; data_len]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, data_len as u64, data_len + 1);
    cow.write(0, &vec![0xA5; data_len]).unwrap();

    let mut calls = Vec::new();
    cow.flush_buffered(|offset, buffers| {
        calls.push((offset, buffers.len()));
        Ok(buffered_len(buffers))
    })
    .unwrap();

    assert_eq!(
        calls,
        vec![
            (0, MAX_WRITE_IOVECS),
            ((MAX_WRITE_IOVECS * BLOCK_SIZE) as u64, 1)
        ]
    );
    assert_eq!(cow.buffered_block_count(), 0);
    assert_eq!(cow.dirty_block_count(), block_count);
}

#[test]
fn flush_buffered_isolated_blocks_keep_one_call_each() {
    let (_b, _c, mut cow) = seed_cow_with_writes(&[(0, 0xA0), (2, 0xA2), (4, 0xA4), (6, 0xA6)]);

    let mut calls = Vec::new();
    cow.flush_buffered(|offset, buffers| {
        calls.push((offset, buffers.len()));
        Ok(buffered_len(buffers))
    })
    .unwrap();

    assert_eq!(
        calls,
        vec![(0, 1), (2 * 4096, 1), (4 * 4096, 1), (6 * 4096, 1)]
    );
}

#[test]
fn flush_buffered_fails_on_first_block_preserves_everything() {
    let (_b, _c, mut cow) = seed_cow_with_writes(&[(0, 0xAA), (1, 0xBB), (5, 0xCC)]);

    let err = cow
        .flush_buffered(|_off, _data| Err(std::io::Error::from(std::io::ErrorKind::StorageFull)))
        .unwrap_err();
    assert!(matches!(err, NbdCowError::Io(_)));

    // No block written: buffer intact, no dirty bits set.
    assert_eq!(cow.buffered_block_count(), 3);
    assert_eq!(cow.buffer_bytes(), 3 * 4096);
    assert_eq!(cow.dirty_block_count(), 0);
    // Originals still readable from the buffer (no dirty bit ⇒ fallthrough to buffer).
    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xAA));
    cow.read(5 * 4096, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xCC));
}

#[test]
fn flush_buffered_partial_block_failure_restores_full_block_and_retries() {
    let (_b, _c, mut cow) = seed_cow_with_writes(&[(0, 0xA0), (1, 0xA1), (2, 0xA2), (3, 0xA3)]);

    let mut calls = Vec::new();
    let err = cow
        .flush_buffered(|offset, buffers| {
            calls.push((
                offset,
                buffers
                    .iter()
                    .map(|buffer| buffer.len())
                    .collect::<Vec<_>>(),
            ));
            if calls.len() == 1 {
                Ok(2 * 4096 + 512)
            } else {
                Err(std::io::Error::from(std::io::ErrorKind::StorageFull))
            }
        })
        .unwrap_err();
    assert!(matches!(err, NbdCowError::Io(_)));

    assert_eq!(
        calls,
        vec![(0, vec![4096; 4]), (2 * 4096 + 512, vec![4096 - 512, 4096])]
    );
    assert_eq!(cow.dirty_block_count(), 2);
    assert_eq!(cow.buffered_block_count(), 2);
    assert_eq!(cow.buffer_bytes(), 2 * 4096);

    let mut buf = vec![0u8; 4096];
    cow.read(2 * 4096, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xA2));
    cow.read(3 * 4096, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xA3));

    let mut retry_calls = Vec::new();
    cow.flush_buffered(|offset, buffers| {
        retry_calls.push((offset, buffered_fills(buffers)));
        Ok(buffered_len(buffers))
    })
    .unwrap();

    assert_eq!(cow.buffered_block_count(), 0);
    assert_eq!(cow.buffer_bytes(), 0);
    assert_eq!(cow.dirty_block_count(), 4);
    assert_eq!(retry_calls, vec![(2 * 4096, vec![0xA2, 0xA3])]);
}

#[test]
fn flush_buffered_fails_on_last_block_preserves_only_last() {
    let (_b, _c, mut cow) = seed_cow_with_writes(&[(0, 0xA0), (1, 0xA1), (2, 0xA2), (3, 0xA3)]);

    let mut call_count = 0;
    let err = cow
        .flush_buffered(|_off, _buffers| {
            call_count += 1;
            if call_count == 1 {
                Ok(3 * 4096)
            } else {
                Err(std::io::Error::from(std::io::ErrorKind::StorageFull))
            }
        })
        .unwrap_err();
    assert!(matches!(err, NbdCowError::Io(_)));

    // Guards the tail boundary: only block 3 should be restored; blocks
    // [0..=2] stay written.
    assert_eq!(cow.dirty_block_count(), 3);
    assert_eq!(cow.buffered_block_count(), 1);
    assert_eq!(cow.buffer_bytes(), 4096);

    let mut buf = vec![0u8; 4096];
    cow.read(3 * 4096, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xA3));
}

#[test]
fn flush_buffered_retries_interrupted_and_advances_short_writes() {
    let (_b, _c, mut cow) = seed_cow_with_writes(&[(0, 0xA0), (1, 0xA1)]);

    let mut calls = Vec::new();
    cow.flush_buffered(|offset, buffers| {
        calls.push((
            offset,
            buffers
                .iter()
                .map(|buffer| buffer.len())
                .collect::<Vec<_>>(),
        ));
        match calls.len() {
            1 => Err(std::io::Error::from(std::io::ErrorKind::Interrupted)),
            2 => Ok(4096 + 7),
            _ => Ok(buffered_len(buffers)),
        }
    })
    .unwrap();

    assert_eq!(
        calls,
        vec![
            (0, vec![4096, 4096]),
            (0, vec![4096, 4096]),
            (4096 + 7, vec![4096 - 7])
        ]
    );
    assert_eq!(cow.buffered_block_count(), 0);
    assert_eq!(cow.dirty_block_count(), 2);
}

#[test]
fn flush_buffered_write_zero_preserves_everything() {
    let (_b, _c, mut cow) = seed_cow_with_writes(&[(0, 0xA0), (1, 0xA1)]);

    let err = cow.flush_buffered(|_, _| Ok(0)).unwrap_err();

    assert!(
        matches!(&err, NbdCowError::Io(error) if error.kind() == std::io::ErrorKind::WriteZero)
    );
    assert_eq!(cow.buffered_block_count(), 2);
    assert_eq!(cow.buffer_bytes(), 2 * 4096);
    assert_eq!(cow.dirty_block_count(), 0);
}

#[test]
fn flush_ensure_cow_fd_failure_preserves_buffer() {
    let base = create_base_image(&vec![0x00; 8 * 4096]);
    // Derive a path under a tempdir whose child subdir we never create —
    // ensure_cow_fd's File::open then fails ENOENT regardless of host FS state.
    let tmp = tempfile::tempdir().unwrap();
    let bad_cow_path = tmp.path().join("missing-subdir").join("cow.bin");
    let mut cow = CowLayer::new(base.path(), &bad_cow_path, 8 * 4096, 4096, 1024 * 1024).unwrap();

    cow.write(0, &vec![0xEE; 4096]).unwrap();
    cow.write(4096, &vec![0xDD; 4096]).unwrap();
    assert_eq!(cow.buffered_block_count(), 2);

    let err = cow.flush().unwrap_err();
    assert!(matches!(err, NbdCowError::Io(_)));

    // ensure_cow_fd early-exit must not have touched buffer state.
    assert_eq!(cow.buffered_block_count(), 2);
    assert_eq!(cow.buffer_bytes(), 2 * 4096);
    assert_eq!(cow.dirty_block_count(), 0);
}

// Sanity check that the full flush() wiring — ensure_cow_fd and the positioned
// batch writer — survives an end-to-end real I/O failure. /dev/full always
// returns ENOSPC on write, so this covers "fail on first batch" through the
// public API. Mid-drain coverage stays on the closure tests above.
#[test]
fn flush_with_dev_full_preserves_buffer() {
    if !std::path::Path::new("/dev/full").exists() {
        eprintln!("skip flush_with_dev_full_preserves_buffer: /dev/full not available");
        return;
    }
    let base = create_base_image(&vec![0x00; 8 * 4096]);
    // Point cow_path at /dev/full so ensure_cow_fd opens it.
    let mut cow = CowLayer::new(
        base.path(),
        std::path::Path::new("/dev/full"),
        8 * 4096,
        4096,
        1024 * 1024,
    )
    .unwrap();

    cow.write(0, &vec![0xEE; 4096]).unwrap();
    cow.write(4096, &vec![0xDD; 4096]).unwrap();

    let err = cow.flush().unwrap_err();
    assert!(matches!(err, NbdCowError::Io(_)));

    assert_eq!(cow.buffered_block_count(), 2);
    assert_eq!(cow.buffer_bytes(), 2 * 4096);
    assert_eq!(cow.dirty_block_count(), 0);
}
