use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Operation {
    Write(usize),
    FileSync,
    Rename,
    DirectorySync,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Fault {
    PartialWrite(usize),
    FileSync,
    Rename,
    DirectorySync,
}

struct FaultIo {
    fault: Option<Fault>,
    operations: Vec<Operation>,
    written: usize,
    tmp_path: PathBuf,
    partial_bytes: Option<Vec<u8>>,
}

impl BitmapIo for FaultIo {
    fn write_all(&mut self, file: &mut File, bytes: &[u8]) -> io::Result<()> {
        self.operations.push(Operation::Write(bytes.len()));
        if let Some(Fault::PartialWrite(limit)) = self.fault {
            let remaining = limit.saturating_sub(self.written);
            if remaining < bytes.len() {
                FileSystem.write_all(file, &bytes[..remaining])?;
                self.written += remaining;
                self.partial_bytes = Some(std::fs::read(&self.tmp_path)?);
                return Err(io::Error::from_raw_os_error(libc::ENOSPC));
            }
        }
        FileSystem.write_all(file, bytes)?;
        self.written += bytes.len();
        Ok(())
    }

    fn sync_all(&mut self, file: &File) -> io::Result<()> {
        let (operation, fault) = if file.metadata()?.is_dir() {
            (Operation::DirectorySync, Fault::DirectorySync)
        } else {
            (Operation::FileSync, Fault::FileSync)
        };
        self.operations.push(operation);
        if self.fault == Some(fault) {
            return Err(io::Error::from_raw_os_error(libc::EIO));
        }
        FileSystem.sync_all(file)
    }

    fn rename(&mut self, from: &Path, to: &Path) -> io::Result<()> {
        self.operations.push(Operation::Rename);
        if self.fault == Some(Fault::Rename) {
            return Err(io::Error::from_raw_os_error(libc::EIO));
        }
        FileSystem.rename(from, to)
    }
}

fn assert_save_failure_and_retry(fault: Fault) {
    // Two payload chunks, with dirty bits in both and an old-only dirty bit.
    const BLOCKS: usize = (BITMAP_WORDS_PER_CHUNK + 2) * 64;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cow.bitmap");
    let tmp_path = bitmap_tmp_path_for(&path);
    let mut original: BitVec = bitvec![0; BLOCKS];
    original.set(3, true);
    save_bitmap(&original, &path).unwrap();
    let original_bytes = std::fs::read(&path).unwrap();

    let mut replacement: BitVec = bitvec![0; BLOCKS];
    replacement.set(0, true);
    replacement.set(BITMAP_CHUNK_BYTES * 8 + 1, true);
    replacement.set(BLOCKS - 1, true);
    let mut replacement_bytes = vec![0; 8 + BITMAP_CHUNK_BYTES + 16];
    replacement_bytes[..8].copy_from_slice(&(BLOCKS as u64).to_le_bytes());
    replacement_bytes[8] = 1;
    replacement_bytes[8 + BITMAP_CHUNK_BYTES] = 2;
    *replacement_bytes.last_mut().unwrap() = 0x80;

    let mut io = FaultIo {
        fault: Some(fault),
        operations: Vec::new(),
        written: 0,
        tmp_path: tmp_path.clone(),
        partial_bytes: None,
    };
    let error = save_bitmap_with_io(&replacement, &path, &mut io).unwrap_err();
    let NbdCowError::Io(error) = error else {
        panic!("expected the original I/O error, got {error:?}");
    };
    let expected_errno = match fault {
        Fault::PartialWrite(_) => libc::ENOSPC,
        _ => libc::EIO,
    };
    assert_eq!(error.raw_os_error(), Some(expected_errno));
    assert_eq!(
        std::fs::symlink_metadata(&tmp_path).unwrap_err().kind(),
        io::ErrorKind::NotFound,
        "temporary entry must be removed even after a partial write"
    );

    let complete_order = [
        Operation::Write(8),
        Operation::Write(BITMAP_CHUNK_BYTES),
        Operation::Write(16),
        Operation::FileSync,
        Operation::Rename,
        Operation::DirectorySync,
    ];
    let attempted_operations = match fault {
        Fault::PartialWrite(limit) => {
            assert_eq!(io.written, limit);
            assert_eq!(
                io.partial_bytes.as_deref(),
                Some(&replacement_bytes[..limit]),
                "the fault must follow a real partial temporary-file write"
            );
            if limit < 8 { 1 } else { 3 }
        }
        Fault::FileSync => 4,
        Fault::Rename => 5,
        Fault::DirectorySync => 6,
    };
    assert_eq!(io.operations, complete_order[..attempted_operations]);

    let (expected_bytes, expected_bitmap) = if fault == Fault::DirectorySync {
        // Rename has published the complete new inode. A directory fsync error
        // reports uncertain durability, not a reason to delete or roll it back.
        (&replacement_bytes, &replacement)
    } else {
        (&original_bytes, &original)
    };
    assert_eq!(&std::fs::read(&path).unwrap(), expected_bytes);
    assert_eq!(&load_bitmap(&path, BLOCKS).unwrap(), expected_bitmap);

    io.fault = None;
    io.operations.clear();
    save_bitmap_with_io(&replacement, &path, &mut io).unwrap();

    assert_eq!(io.operations, complete_order);
    assert_eq!(std::fs::read(&path).unwrap(), replacement_bytes);
    assert_eq!(load_bitmap(&path, BLOCKS).unwrap(), replacement);
    assert_eq!(
        std::fs::symlink_metadata(&tmp_path).unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
}

#[test]
fn partial_header_write_preserves_bitmap_and_allows_retry() {
    assert_save_failure_and_retry(Fault::PartialWrite(4));
}

#[test]
fn partial_later_chunk_write_preserves_bitmap_and_allows_retry() {
    assert_save_failure_and_retry(Fault::PartialWrite(8 + BITMAP_CHUNK_BYTES + 3));
}

#[test]
fn file_sync_failure_preserves_bitmap_and_allows_retry() {
    assert_save_failure_and_retry(Fault::FileSync);
}

#[test]
fn rename_failure_preserves_bitmap_and_allows_retry() {
    assert_save_failure_and_retry(Fault::Rename);
}

#[test]
fn directory_sync_failure_retains_replacement_and_allows_retry() {
    assert_save_failure_and_retry(Fault::DirectorySync);
}
