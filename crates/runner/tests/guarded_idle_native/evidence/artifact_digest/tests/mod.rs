use super::*;
use std::io::Write;
use std::os::fd::AsRawFd;

fn residency(file: &std::fs::File, length: usize) -> TestResult<Vec<u8>> {
    // SAFETY: sysconf has no pointer arguments.
    let page = usize::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) })?;
    let mut vector = vec![0_u8; length.div_ceil(page)];
    // SAFETY: this fixture owns a stable regular file; the read-only mapping
    // is never dereferenced and remains mapped until mincore finishes.
    let address = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            length,
            libc::PROT_READ,
            libc::MAP_SHARED,
            file.as_raw_fd(),
            0,
        )
    };
    if address == libc::MAP_FAILED {
        return Err(io::Error::last_os_error().into());
    }
    // SAFETY: address covers length bytes and vector covers every mapped page.
    let result = unsafe { libc::mincore(address, length, vector.as_mut_ptr()) };
    let error = io::Error::last_os_error();
    // SAFETY: this is the exact still-owned mapping returned above.
    if unsafe { libc::munmap(address, length) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    if result != 0 {
        return Err(error.into());
    }
    Ok(vector.into_iter().map(|value| value & 1).collect())
}

#[test]
fn digest_does_not_populate_owned_cold_file_pages() -> TestResult<()> {
    let mut source = tempfile::NamedTempFile::new()?;
    let mut bytes = b"abcd".repeat(512 * 1024);
    bytes.extend_from_slice(b"end");
    source.write_all(&bytes)?;
    source.as_file().sync_all()?;
    // SAFETY: advice affects only this new private descriptor; no shared
    // input, global cache or existing workload is modified.
    let result =
        unsafe { libc::posix_fadvise(source.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result).into());
    }
    assert!(
        residency(source.as_file(), bytes.len())?
            .iter()
            .all(|v| *v == 0)
    );
    assert_eq!(
        file_sha256(source.path())?,
        "37d9fa413ca11f3953793fd3df74135680b5f0a9aedffeb887f673ca2c59476c"
    );
    assert!(
        residency(source.as_file(), bytes.len())?
            .iter()
            .all(|v| *v == 0),
        "native artifact verification populated the observed page cache"
    );
    assert_eq!(std::fs::read(source.path())?, bytes);
    assert!(
        residency(source.as_file(), bytes.len())?
            .iter()
            .all(|v| *v == 1)
    );
    Ok(())
}

#[test]
fn digest_covers_empty_partial_and_multiple_buffers() -> TestResult<()> {
    for length in [0, 17, 1024 * 1024, 1024 * 1024 + 3] {
        let mut source = tempfile::NamedTempFile::new()?;
        let bytes: Vec<u8> = (0..length).map(|index| (index % 251) as u8).collect();
        source.write_all(&bytes)?;
        assert_eq!(
            file_sha256(source.path())?,
            hex::encode(Sha256::digest(&bytes))
        );
    }
    Ok(())
}

#[test]
fn digest_refuses_symlinks_and_nonregular_inputs() -> TestResult<()> {
    let directory = tempfile::tempdir()?;
    let original = directory.path().join("original");
    std::fs::write(&original, b"original bytes")?;
    let link = directory.path().join("link");
    std::os::unix::fs::symlink(&original, &link)?;
    assert!(file_sha256(&link).is_err());
    assert!(file_sha256(directory.path()).is_err());
    Ok(())
}
