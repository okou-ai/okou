//! Host-owned snapshot binding to the immutable image generation.
//!
//! Guest page caches survive restore, so a cached Guest marker cannot establish
//! which Host file a restored virtio device currently reads. The snapshot owner
//! records the leased image's identity and checks it before admitting restore.
//! This uses the existing immutable-image ownership contract, not a content hash
//! or a claim that metadata authenticates a file against a malicious Host.

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const MAX_RECEIPT_BYTES: u64 = 8192;

#[derive(serde::Deserialize, serde::Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct RuntimeSource {
    path: PathBuf,
    device: u64,
    inode: u64,
    bytes: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
}

impl RuntimeSource {
    fn capture(path: &Path) -> io::Result<Self> {
        let path = fs::canonicalize(path)?;
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(invalid("runtime source is not a nonempty regular image"));
        }
        Ok(Self {
            path,
            device: metadata.dev(),
            inode: metadata.ino(),
            bytes: metadata.len(),
            modified_seconds: metadata.mtime(),
            modified_nanoseconds: metadata.mtime_nsec(),
        })
    }
}

pub(crate) fn record(path: &Path, source: &Path) -> io::Result<()> {
    let receipt = RuntimeSource::capture(source)?;
    let bytes = serde_json::to_vec(&receipt)?;
    if bytes.len() as u64 > MAX_RECEIPT_BYTES {
        return Err(invalid("runtime source receipt exceeds its bound"));
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(&bytes)?;
    file.sync_all()
}

/// Check the recorded image generation, optionally against the factory source.
pub(crate) fn verify(path: &Path, source: Option<&Path>) -> io::Result<()> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(invalid("runtime source receipt is not a regular file"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_RECEIPT_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_RECEIPT_BYTES {
        return Err(invalid("runtime source receipt exceeds its bound"));
    }
    let expected: RuntimeSource = serde_json::from_slice(&bytes)?;
    if !expected.path.is_absolute() {
        return Err(invalid("runtime source receipt path is not absolute"));
    }
    let current = RuntimeSource::capture(source.unwrap_or(&expected.path))?;
    if current != expected {
        return Err(invalid("snapshot runtime source changed since creation"));
    }
    Ok(())
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
pub(crate) fn record_fixture(output: &crate::paths::SnapshotOutputPaths) {
    let source = output.dir().join("fixture-runtime.ext4");
    if !source.exists() {
        fs::write(&source, b"owned fixture runtime image").unwrap();
    }
    record(&output.runtime_source(), &source).unwrap();
}
