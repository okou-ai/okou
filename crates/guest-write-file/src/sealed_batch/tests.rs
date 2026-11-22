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
    let empty_path = dir.path().join("empty");
    let last_path = dir.path().join("nested").join("output");
    let content = b"immutable bytes";
    let last_content = b"another body";
    let payload = encode_write_files(&[
        WriteFileBatchEntry {
            path: path.to_str().unwrap(),
            content,
        },
        WriteFileBatchEntry {
            path: empty_path.to_str().unwrap(),
            content: b"",
        },
        WriteFileBatchEntry {
            path: last_path.to_str().unwrap(),
            content: last_content,
        },
    ])
    .unwrap();

    let unsealed = input(&payload);
    assert!(write_sealed_batch(unsealed.as_fd()).is_err());
    assert!(!path.exists());
    assert!(!empty_path.exists());
    assert!(!last_path.exists());

    let trailing = [payload.as_slice(), b"x"].concat();
    for malformed in [&payload[..payload.len() - 1], trailing.as_slice()] {
        let file = input(malformed);
        seal(&file);
        assert!(write_sealed_batch(file.as_fd()).is_err());
        assert!(!path.exists());
        assert!(!empty_path.exists());
        assert!(!last_path.exists());
    }

    seal(&unsealed);
    write_sealed_batch(unsealed.as_fd()).unwrap();
    assert_eq!(std::fs::read(path).unwrap(), content);
    assert_eq!(std::fs::read(empty_path).unwrap(), b"");
    assert_eq!(std::fs::read(last_path).unwrap(), last_content);
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

#[test]
fn sealed_range_uses_mapped_bytes_when_kernel_declines_transfer() {
    let payload = b"before|selected|after";
    let input = input(payload);
    seal(&input);
    let mapping = SealedInput::map(input.as_fd(), MAX_BATCH_PAYLOAD_BYTES).unwrap();
    let selected = &mapping.as_bytes()[7..15];
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("output");
    // Linux sendfile rejects append-mode output. Normal writes still work.
    let mut output = File::options()
        .create_new(true)
        .append(true)
        .open(&path)
        .unwrap();
    output.write_all(b"existing: ").unwrap();

    copy_sealed_content(input.as_fd(), 7, selected, &mut output).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"existing: selected");

    let mut read_only = File::open(path).unwrap();
    let error = copy_sealed_content(input.as_fd(), 7, selected, &mut read_only).unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::EBADF));
}
