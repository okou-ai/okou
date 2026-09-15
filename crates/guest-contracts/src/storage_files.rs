//! Bounded decoded storage files carried by the dedicated storage operation.
//!
//! This is an internal Runner/Guest contract, not an API manifest or persisted format.

use std::collections::HashSet;
use std::io::{self, Read};
use std::path::{Component, Path};

/// Maximum encoded files payload, including metadata.
pub const MAX_PAYLOAD_BYTES: usize = 15 * 1024 * 1024;
/// Maximum files in one admitted storage.
pub const MAX_FILES: usize = 32;
/// Maximum bytes in one file.
pub const MAX_FILE_BYTES: usize = 256 * 1024;
/// Maximum relative path length in bytes.
pub const MAX_PATH_BYTES: usize = 4096;
/// Maximum decoded content bytes in one storage.
pub const MAX_STORAGE_BYTES: usize = 1024 * 1024;
/// Maximum mount groups in one operation.
pub const MAX_MOUNTS: usize = 1024;
/// Prefix identifying binary input to the fixed storage helper.
pub const INPUT_MAGIC: &[u8; 8] = b"VM0FILE1";
/// Manifest limit within binary input; generic exec stdin is unchanged.
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
/// Maximum complete binary helper input.
pub const MAX_INPUT_BYTES: usize = 16 + MAX_MANIFEST_BYTES + MAX_PAYLOAD_BYTES;

/// Whether another manifest entry owns paths needed by a decoded mount.
///
/// Ordinary storage and artifacts own their whole mount. Instructions downloaded
/// into separate staging (or normalized in place without an archive) only manage
/// the instruction filenames and copy temporaries at their logical home. Their
/// unrelated children can therefore use decoded delivery. Callers must exclude
/// only the decoded entry itself, not other entries with the same mount path.
pub fn decoded_mount_conflicts(
    target: &Path,
    mount: &Path,
    instructions_target_filename: Option<&str>,
    extract_path: Option<&Path>,
    has_archive: bool,
) -> bool {
    if !absolute_mount(target) || !absolute_mount(mount) {
        return true;
    }
    let overlaps = |other: &Path| target.starts_with(other) || other.starts_with(target);
    if instructions_target_filename.is_some()
        && has_archive
        && let Some(staging) = extract_path
        && (!absolute_mount(staging) || overlaps(staging))
    {
        // Staging is extracted and later removed, even when logical homes differ.
        return true;
    }
    if !overlaps(mount) {
        return false;
    }
    if !matches!(
        instructions_target_filename,
        Some("CLAUDE.md" | "AGENTS.md")
    ) || (has_archive && extract_path.is_none())
    {
        return true;
    }
    let Ok(relative) = target.strip_prefix(mount) else {
        return true;
    };
    let Some(Component::Normal(child)) = relative.components().next() else {
        // A decoded mount at or above the instruction home still conflicts.
        return true;
    };
    let Some(child) = child.to_str() else {
        return true;
    };
    matches!(child, "CLAUDE.md" | "AGENTS.md")
        || child.starts_with(".CLAUDE.md.vm0-copy-")
        || child.starts_with(".AGENTS.md.vm0-copy-")
}

fn absolute_mount(path: &Path) -> bool {
    path.is_absolute()
        && !path.as_os_str().as_encoded_bytes().contains(&0)
        && path
            .components()
            .all(|part| matches!(part, Component::RootDir | Component::Normal(_)))
}

/// Build binary helper input containing a canonical manifest and decoded groups.
pub fn encode_input(manifest: &[u8], groups: &[(&str, &[StorageFile])]) -> io::Result<Vec<u8>> {
    if manifest.len() > MAX_MANIFEST_BYTES {
        return Err(invalid());
    }
    let files = encode(groups)?;
    let mut out = Vec::with_capacity(16 + manifest.len() + files.len());
    out.extend_from_slice(INPUT_MAGIC);
    put_bytes(&mut out, manifest);
    put_bytes(&mut out, &files);
    Ok(out)
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

/// Validate the admitted regular-file shape without touching the filesystem.
pub fn validate_files(files: &[StorageFile]) -> io::Result<()> {
    if files.is_empty() || files.len() > MAX_FILES {
        return Err(invalid());
    }
    let mut paths = Vec::new();
    let mut total = 0usize;
    for file in files {
        let path = Path::new(&file.path);
        if file.path.is_empty()
            || file.path.len() > MAX_PATH_BYTES
            || file.path.as_bytes().contains(&0)
            || path
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
            || path
                .components()
                .collect::<std::path::PathBuf>()
                .as_os_str()
                != path.as_os_str()
            || file.mode & !0o777 != 0
            || file.mtime > i64::MAX as u64
            || file.content.len() > MAX_FILE_BYTES
            || paths
                .iter()
                .any(|other: &&Path| path.starts_with(other) || other.starts_with(path))
        {
            return Err(invalid());
        }
        total = total.checked_add(file.content.len()).ok_or_else(invalid)?;
        if total > MAX_STORAGE_BYTES {
            return Err(invalid());
        }
        paths.push(path);
    }
    Ok(())
}

/// Encode a complete bounded set of mount groups.
pub fn encode(groups: &[(&str, &[StorageFile])]) -> io::Result<Vec<u8>> {
    if groups.is_empty() || groups.len() > MAX_MOUNTS {
        return Err(invalid());
    }
    let mut size = 4usize;
    let mut mounts = HashSet::new();
    for (mount, files) in groups {
        validate_mount(mount)?;
        validate_files(files)?;
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
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(&(groups.len() as u32).to_be_bytes());
    for (mount, files) in groups {
        put_bytes(&mut out, mount.as_bytes());
        out.extend_from_slice(&(files.len() as u32).to_be_bytes());
        for file in *files {
            put_bytes(&mut out, file.path.as_bytes());
            out.extend_from_slice(&file.mode.to_be_bytes());
            out.extend_from_slice(&file.mtime.to_be_bytes());
            put_bytes(&mut out, &file.content);
        }
    }
    Ok(out)
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
    let mut mounts = HashSet::new();
    for _ in 0..count {
        let mount_path = string(&mut input)?;
        validate_mount(&mount_path)?;
        if !mounts.insert(mount_path.clone()) {
            return Err(invalid());
        }
        let file_count = u32::from_be_bytes(number(&mut input)?) as usize;
        if file_count == 0 || file_count > MAX_FILES {
            return Err(invalid());
        }
        let mut files = Vec::with_capacity(file_count);
        for _ in 0..file_count {
            files.push(StorageFile {
                path: string(&mut input)?,
                mode: u32::from_be_bytes(number(&mut input)?),
                mtime: u64::from_be_bytes(number(&mut input)?),
                content: bytes(&mut input, MAX_FILE_BYTES)?.to_vec(),
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
mod tests {
    use super::*;

    #[test]
    fn validates_sizes_before_encoding_and_rejects_truncated_and_extra_input() {
        let mut files = vec![StorageFile {
            path: "file".into(),
            mode: 0o644,
            mtime: 1,
            content: vec![0; MAX_FILE_BYTES],
        }];
        let encoded = encode_input(b"{}", &[("/mount", &files)]).unwrap();
        let (manifest, payload) = split_input(&encoded).unwrap();
        assert_eq!(manifest, b"{}");
        assert_eq!(decode(payload).unwrap()[0].files, files);
        files[0].content.push(0);
        assert!(encode_input(b"{}", &[("/mount", &files)]).is_err());
        for end in [0, 7, 8, 12, encoded.len() - 1] {
            assert!(split_input(&encoded[..end]).is_err());
        }
        let mut trailing = encoded.clone();
        trailing.push(0);
        assert!(split_input(&trailing).is_err());
        let mut payload = payload.to_vec();
        payload[0..4].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(decode(&payload).is_err());
    }

    #[test]
    fn enforces_storage_count_path_metadata_and_manifest_bounds() {
        let mut files: Vec<_> = (0..MAX_FILES)
            .map(|index| StorageFile {
                path: format!("file-{index}"),
                mode: 0o777,
                mtime: i64::MAX as u64,
                content: vec![0; MAX_STORAGE_BYTES / MAX_FILES],
            })
            .collect();
        assert!(validate_files(&files).is_ok());
        files[0].content.push(0);
        assert!(validate_files(&files).is_err());
        files[0].content.pop();
        files.push(StorageFile {
            path: "extra".into(),
            mode: 0o644,
            mtime: 0,
            content: vec![],
        });
        assert!(validate_files(&files).is_err());
        files.pop();
        files[0].path = "a".repeat(MAX_PATH_BYTES);
        assert!(validate_files(&files).is_ok());
        files[0].path.push('a');
        assert!(validate_files(&files).is_err());
        files[0].path = "file-0".into();
        files[0].mode = 0o4755;
        assert!(validate_files(&files).is_err());
        files[0].mode = 0o644;
        files[0].mtime = i64::MAX as u64 + 1;
        assert!(validate_files(&files).is_err());
        files[0].mtime = 1;
        assert!(encode_input(&vec![b' '; MAX_MANIFEST_BYTES], &[("/mount", &files)]).is_ok());
        assert!(encode_input(&vec![b' '; MAX_MANIFEST_BYTES + 1], &[("/mount", &files)]).is_err());
    }

    #[test]
    fn aggregate_payload_limit_counts_content_and_framing() {
        let files: Vec<_> = (0..4)
            .map(|index| StorageFile {
                path: format!("file-{index}"),
                mode: 0o644,
                mtime: 1,
                content: vec![0; MAX_FILE_BYTES],
            })
            .collect();
        let mounts: Vec<_> = (0..15).map(|index| format!("/mount-{index}")).collect();
        let groups: Vec<_> = mounts
            .iter()
            .map(|mount| (mount.as_str(), files.as_slice()))
            .collect();
        assert!(encode(&groups[..14]).is_ok());
        assert!(encode(&groups).is_err());
    }
}
