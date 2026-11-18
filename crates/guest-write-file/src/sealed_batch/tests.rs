use std::fs::File;
use std::os::fd::{AsRawFd, FromRawFd};

use guest_control_proto::{WriteFileBatchEntry, encode_write_files};

use super::*;

fn input(bytes: &[u8]) -> File {
    // SAFETY: The static name and flags are valid for memfd_create.
    let fd = unsafe { libc::memfd_create(c"batch-test".as_ptr(), libc::MFD_ALLOW_SEALING) };
    assert!(fd >= 0, "{}", io::Error::last_os_error());
    // SAFETY: memfd_create returned ownership of this descriptor.
    let mut file = unsafe { File::from_raw_fd(fd) };
    file.write_all(bytes).unwrap();
    file
}

fn seal(file: &File) {
    let seals = libc::F_SEAL_WRITE | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW;
    // SAFETY: The descriptor is open and F_ADD_SEALS takes an integer mask.
    assert_eq!(
        unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, seals) },
        0
    );
}

#[test]
fn sealed_input_requires_immutable_complete_batch_before_output() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("output");
    let content = b"immutable bytes";
    let payload = encode_write_files(&[WriteFileBatchEntry {
        path: path.to_str().unwrap(),
        content,
    }])
    .unwrap();

    let unsealed = input(&payload);
    assert!(write_sealed_batch(unsealed.as_fd()).is_err());
    assert!(!path.exists());

    let trailing = [payload.as_slice(), b"x"].concat();
    for malformed in [&payload[..payload.len() - 1], trailing.as_slice()] {
        let file = input(malformed);
        seal(&file);
        assert!(write_sealed_batch(file.as_fd()).is_err());
        assert!(!path.exists());
    }

    seal(&unsealed);
    write_sealed_batch(unsealed.as_fd()).unwrap();
    assert_eq!(std::fs::read(path).unwrap(), content);
}

#[test]
fn sealed_input_length_is_bounded() {
    for size in [0, MAX_BATCH_PAYLOAD_BYTES + 1] {
        let file = input(b"");
        file.set_len(size as u64).unwrap();
        seal(&file);
        let error = write_sealed_batch(file.as_fd()).unwrap_err();
        assert_eq!(error.to_string(), "invalid batch input size");
    }
}
