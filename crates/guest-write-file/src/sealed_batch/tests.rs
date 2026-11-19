use std::fs::File;

use guest_control_proto::{WriteFileBatchEntry, encode_write_files};
use rustix::fs::{MemfdFlags, SealFlags, fcntl_add_seals, memfd_create};

use super::*;

fn input(bytes: &[u8]) -> File {
    let fd = memfd_create(c"batch-test", MemfdFlags::ALLOW_SEALING).unwrap();
    let mut file = File::from(fd);
    file.write_all(bytes).unwrap();
    file
}

fn seal(file: &File) {
    let seals = SealFlags::WRITE | SealFlags::SHRINK | SealFlags::GROW;
    fcntl_add_seals(file, seals).unwrap();
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
