use std::io::Write;

use super::*;

fn fixture() -> tempfile::NamedTempFile {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    let content: Vec<u8> = (0..2 * 1024 * 1024).map(|n| (n % 251) as u8).collect();
    file.write_all(&content).unwrap();
    file.as_file().sync_all().unwrap();
    file
}

fn evict(file: &File) {
    // This fixture owns the file; never flush/drop a global or shared cache.
    assert_eq!(
        unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) },
        0
    );
}

fn resident(file: &File, envelope: &Envelope) -> usize {
    let map = Residency::new(file).unwrap();
    envelope
        .ranges
        .iter()
        .map(|range| {
            let mut pages = vec![0u8; range.len().div_ceil(map.page_size)];
            map.observe(range.clone(), &mut pages).unwrap();
            pages.iter().filter(|entry| **entry & 1 != 0).count() * map.page_size
        })
        .sum()
}

#[test]
fn learned_sparse_ranges_warm_missing_pages_and_skip_hot_reads() {
    let file = fixture();
    evict(file.as_file());
    let mut buffer = [0u8; 4096];
    file.as_file().read_exact_at(&mut buffer, 0).unwrap();
    file.as_file()
        .read_exact_at(&mut buffer, 1024 * 1024)
        .unwrap();
    let stop = CancellationToken::new();
    let envelope = learn(file.path(), &stop, super::super::MAX_BYTES)
        .unwrap()
        .unwrap();
    assert!(envelope.bytes() < 2 * 1024 * 1024);
    assert!(envelope.ranges.iter().any(|range| range.contains(&0)));
    assert!(
        envelope
            .ranges
            .iter()
            .any(|range| range.contains(&(1024 * 1024)))
    );

    evict(file.as_file());
    assert_eq!(resident(file.as_file(), &envelope), 0);
    let cold = prefetch(file.path(), &envelope, &stop).unwrap();
    assert!(cold.requested_bytes > 0);
    assert!(cold.requested_bytes <= envelope.bytes());
    assert_eq!(resident(file.as_file(), &envelope), envelope.bytes());
    let hot = prefetch(file.path(), &envelope, &stop).unwrap();
    assert_eq!(hot.requested_bytes, 0);
    assert_eq!(hot.resident_bytes, envelope.bytes());

    let expected: Vec<u8> = (0..2 * 1024 * 1024).map(|n| (n % 251) as u8).collect();
    let mut actual = vec![0; expected.len()];
    file.as_file().read_exact_at(&mut actual, 0).unwrap();
    assert_eq!(actual, expected);
}

#[test]
fn uninformative_hot_observation_can_be_relearned_after_eviction() {
    let file = fixture();
    let stop = CancellationToken::new();
    let budget = 128 * 1024;
    assert!(learn(file.path(), &stop, budget).unwrap().is_none());
    evict(file.as_file());
    file.as_file().read_exact_at(&mut [0; 4096], 0).unwrap();
    let envelope = learn(file.path(), &stop, budget).unwrap().unwrap();
    assert!(envelope.bytes() <= budget);
    assert!(envelope.ranges.iter().any(|range| range.contains(&0)));
}

#[test]
fn replaced_snapshot_cannot_reuse_a_previous_envelope() {
    let file = fixture();
    let stop = CancellationToken::new();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("memory.bin");
    std::fs::hard_link(file.path(), &path).unwrap();
    let envelope = learn(&path, &stop, super::super::MAX_BYTES)
        .unwrap()
        .unwrap();
    let mut replacement = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
    replacement
        .write_all(b"replacement snapshot bytes")
        .unwrap();
    replacement.persist(&path).unwrap();

    let error = prefetch(&path, &envelope, &stop).err().unwrap();
    assert_eq!(error.to_string(), "snapshot memory identity changed");
    assert_eq!(std::fs::read(&path).unwrap(), b"replacement snapshot bytes");
}

#[test]
fn fragmented_residency_cannot_create_an_unbounded_index() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let page = usize::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).unwrap();
    file.as_file()
        .set_len(((MAX_RANGES + 1) * 2 * page) as u64)
        .unwrap();
    let data = vec![1; page];
    for index in 0..=MAX_RANGES {
        file.as_file()
            .write_all_at(&data, (index * 2 * page) as u64)
            .unwrap();
    }
    file.as_file().sync_all().unwrap();
    assert!(
        learn(
            file.path(),
            &CancellationToken::new(),
            super::super::MAX_BYTES
        )
        .unwrap()
        .is_none()
    );
}
