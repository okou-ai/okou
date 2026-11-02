//! Bounded decoded storage files carried by the dedicated storage operation.
//!
//! This is an internal Runner/Guest contract, not an API manifest or persisted format.

use std::collections::HashSet;
use std::io::{self, Read};
use std::path::Path;

/// Maximum encoded files payload, including metadata.
pub const MAX_PAYLOAD_BYTES: usize = 15 * 1024 * 1024;
/// Maximum files in one admitted storage.
pub const MAX_FILES: usize = 4096;
/// Maximum bytes in one file.
pub const MAX_FILE_BYTES: usize = 256 * 1024;
/// Maximum relative path length in bytes.
pub const MAX_PATH_BYTES: usize = 4096;
/// Maximum combined relative-path bytes in one admitted storage.
pub const MAX_TOTAL_PATH_BYTES: usize = 512 * 1024;
/// Maximum decoded content bytes in one storage.
pub const MAX_STORAGE_BYTES: usize = 8 * 1024 * 1024;
/// Maximum mount groups in one operation.
pub const MAX_MOUNTS: usize = 1024;
/// Retain the original 32-files-per-mount whole-input allocation envelope.
pub const MAX_TOTAL_FILES: usize = 32 * MAX_MOUNTS;
/// Prefix identifying binary input to the fixed storage helper.
pub const INPUT_MAGIC: &[u8; 8] = b"VM0FILE1";
/// Manifest limit within binary input; generic exec stdin is unchanged.
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
/// Maximum complete binary helper input.
pub const MAX_INPUT_BYTES: usize = 16 + MAX_MANIFEST_BYTES + MAX_PAYLOAD_BYTES;

mod bindings;
pub use bindings::{conflicting_mounts, validate_bindings};

/// Build binary helper input containing a canonical manifest and decoded groups.
pub fn encode_input(manifest: &[u8], groups: &[(&str, &[StorageFile])]) -> io::Result<Vec<u8>> {
    let payload_len = input_payload_len(manifest, groups)?;
    Ok(encode_validated_input(manifest, groups, payload_len))
}

/// Validated immutable input whose final byte copy may be deferred until use.
///
/// Construction checks all codec bounds without copying file contents. The
/// caller remains responsible for manifest semantics and mount bindings.
#[derive(Debug)]
pub struct PreparedInput<'a> {
    manifest: Box<[u8]>,
    groups: Vec<(&'a str, &'a [StorageFile])>,
    payload_len: usize,
}

impl<'a> PreparedInput<'a> {
    /// Validate owned manifest/descriptors while borrowing immutable file data.
    pub fn new(manifest: Vec<u8>, groups: Vec<(&'a str, &'a [StorageFile])>) -> io::Result<Self> {
        let payload_len = input_payload_len(&manifest, &groups)?;
        Ok(Self {
            // Do not retain serializer growth capacity for every future batch.
            manifest: manifest.into_boxed_slice(),
            groups,
            payload_len,
        })
    }

    /// Exact canonical manifest byte length.
    pub fn manifest_len(&self) -> usize {
        self.manifest.len()
    }

    /// Exact binary payload byte length, including its framing and metadata.
    pub fn payload_len(&self) -> usize {
        self.payload_len
    }

    /// Emit the already validated input without another fallible codec stage.
    pub fn into_bytes(self) -> Vec<u8> {
        encode_validated_input(&self.manifest, &self.groups, self.payload_len)
    }
}

fn input_payload_len(manifest: &[u8], groups: &[(&str, &[StorageFile])]) -> io::Result<usize> {
    if manifest.len() > MAX_MANIFEST_BYTES {
        return Err(invalid());
    }
    encoded_payload_len(groups)
}

fn encode_validated_input(
    manifest: &[u8],
    groups: &[(&str, &[StorageFile])],
    payload_len: usize,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + manifest.len() + payload_len);
    out.extend_from_slice(INPUT_MAGIC);
    put_bytes(&mut out, manifest);
    out.extend_from_slice(&(payload_len as u32).to_be_bytes());
    encode_groups_into(&mut out, groups);
    out
}

/// Split bounded binary input without copying its content.
pub fn split_input(mut input: &[u8]) -> io::Result<(&[u8], &[u8])> {
    if number::<8>(&mut input)? != *INPUT_MAGIC || input.len() > MAX_INPUT_BYTES - 8 {
        return Err(invalid());
    }
    let manifest = bytes(&mut input, MAX_MANIFEST_BYTES)?;
    let files = bytes(&mut input, MAX_PAYLOAD_BYTES)?;
    if !input.is_empty() || files.is_empty() {
        return Err(invalid());
    }
    Ok((manifest, files))
}

/// One regular file with the metadata supported by the direct path.
#[derive(Debug, PartialEq, Eq)]
pub struct StorageFile {
    /// Normalized relative path below the selected storage target.
    pub path: String,
    /// Unix permission bits; special mode bits are not admitted.
    pub mode: u32,
    /// Modification time in whole Unix seconds.
    pub mtime: u64,
    /// Final file content.
    pub content: Vec<u8>,
}

/// Decoded files belonging to exactly one manifest mount.
#[derive(Debug, PartialEq, Eq)]
pub struct StorageFiles {
    /// Exact logical mount path in the manifest.
    pub mount_path: String,
    /// Ordered files; unique and non-overlapping within this storage.
    pub files: Vec<StorageFile>,
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid decoded storage files")
}

mod validation;
pub use validation::validate_files;

/// Encode a complete bounded set of mount groups.
pub fn encode(groups: &[(&str, &[StorageFile])]) -> io::Result<Vec<u8>> {
    let size = encoded_payload_len(groups)?;
    let mut out = Vec::with_capacity(size);
    encode_groups_into(&mut out, groups);
    Ok(out)
}

fn encode_groups_into(out: &mut Vec<u8>, groups: &[(&str, &[StorageFile])]) {
    out.extend_from_slice(&(groups.len() as u32).to_be_bytes());
    for (mount, files) in groups {
        put_bytes(out, mount.as_bytes());
        out.extend_from_slice(&(files.len() as u32).to_be_bytes());
        for file in *files {
            put_bytes(out, file.path.as_bytes());
            out.extend_from_slice(&file.mode.to_be_bytes());
            out.extend_from_slice(&file.mtime.to_be_bytes());
            put_bytes(out, &file.content);
        }
    }
}

/// Validate the complete group set and return its encoded length without copying file content.
pub fn encoded_payload_len(groups: &[(&str, &[StorageFile])]) -> io::Result<usize> {
    if groups.is_empty() || groups.len() > MAX_MOUNTS {
        return Err(invalid());
    }
    let mut size = 4usize;
    let mut file_count = 0usize;
    let mut mounts = HashSet::new();
    for (mount, files) in groups {
        validate_mount(mount)?;
        validate_files(files)?;
        file_count = file_count.checked_add(files.len()).ok_or_else(invalid)?;
        if file_count > MAX_TOTAL_FILES {
            return Err(invalid());
        }
        if !mounts.insert(*mount) {
            return Err(invalid());
        }
        size += 4 + mount.len() + 4;
        for file in *files {
            size += 4 + file.path.len() + 4 + 8 + 4 + file.content.len();
        }
        if size > MAX_PAYLOAD_BYTES {
            return Err(invalid());
        }
    }
    Ok(size)
}

fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

fn number<const N: usize>(input: &mut &[u8]) -> io::Result<[u8; N]> {
    let mut bytes = [0; N];
    input.read_exact(&mut bytes)?;
    Ok(bytes)
}

fn bytes<'a>(input: &mut &'a [u8], limit: usize) -> io::Result<&'a [u8]> {
    let len = u32::from_be_bytes(number(input)?) as usize;
    if len > limit || len > input.len() {
        return Err(invalid());
    }
    let (value, rest) = input.split_at(len);
    *input = rest;
    Ok(value)
}

fn string(input: &mut &[u8]) -> io::Result<String> {
    String::from_utf8(bytes(input, MAX_PATH_BYTES)?.to_vec()).map_err(|_| invalid())
}

fn validate_mount(mount: &str) -> io::Result<()> {
    if mount.len() > MAX_PATH_BYTES
        || mount.as_bytes().contains(&0)
        || !Path::new(mount).is_absolute()
    {
        return Err(invalid());
    }
    Ok(())
}

/// Decode and validate all groups before any Guest filesystem changes.
pub fn decode(mut input: &[u8]) -> io::Result<Vec<StorageFiles>> {
    if input.len() > MAX_PAYLOAD_BYTES {
        return Err(invalid());
    }
    let count = u32::from_be_bytes(number(&mut input)?) as usize;
    if count == 0 || count > MAX_MOUNTS {
        return Err(invalid());
    }
    let mut groups = Vec::with_capacity(count);
    let mut total_files = 0usize;
    let mut mounts = HashSet::new();
    for _ in 0..count {
        let mount_path = string(&mut input)?;
        validate_mount(&mount_path)?;
        if !mounts.insert(mount_path.clone()) {
            return Err(invalid());
        }
        let file_count = u32::from_be_bytes(number(&mut input)?) as usize;
        total_files = total_files.checked_add(file_count).ok_or_else(invalid)?;
        if file_count == 0 || file_count > MAX_FILES || total_files > MAX_TOTAL_FILES {
            return Err(invalid());
        }
        let mut files = Vec::with_capacity(file_count);
        let mut path_bytes = 0usize;
        let mut content_bytes = 0usize;
        for _ in 0..file_count {
            let path = bytes(&mut input, MAX_PATH_BYTES)?;
            path_bytes = path_bytes.checked_add(path.len()).ok_or_else(invalid)?;
            if path_bytes > MAX_TOTAL_PATH_BYTES {
                return Err(invalid());
            }
            let mode = u32::from_be_bytes(number(&mut input)?);
            let mtime = u64::from_be_bytes(number(&mut input)?);
            let content = bytes(&mut input, MAX_FILE_BYTES)?;
            content_bytes = content_bytes
                .checked_add(content.len())
                .ok_or_else(invalid)?;
            if content_bytes > MAX_STORAGE_BYTES {
                return Err(invalid());
            }
            // Enforce each group's allocation envelope before copying borrowed
            // wire bytes. The final validation still owns all semantic checks.
            files.push(StorageFile {
                path: String::from_utf8(path.to_vec()).map_err(|_| invalid())?,
                mode,
                mtime,
                content: content.to_vec(),
            });
        }
        validate_files(&files)?;
        groups.push(StorageFiles { mount_path, files });
    }
    if !input.is_empty() {
        return Err(invalid());
    }
    Ok(groups)
}

#[cfg(test)]
mod tests;
