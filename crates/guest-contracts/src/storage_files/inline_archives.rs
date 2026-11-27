//! Compressed archive sources carried inside the existing Storage file frame.

use super::{
    INPUT_MAGIC, MAX_MANIFEST_BYTES, MAX_PATH_BYTES, MAX_PAYLOAD_BYTES, MAX_STAGED_ARCHIVES,
    STAGED_ARCHIVE_DIR, bytes, number, put_bytes,
};
use std::collections::HashMap;
use std::io;
use std::path::Path;

// The decoded-file payload requires a nonzero mount count.
const ARCHIVE_TAG: [u8; 4] = [0; 4];

/// Determine whether a binary Storage payload carries compressed archives.
pub fn is_archive_payload(payload: &[u8]) -> bool {
    payload.starts_with(&ARCHIVE_TAG)
}

/// Attach unique staging paths and their original gzip bytes to a manifest.
/// Returns `None` when the sources do not fit a single bounded request.
pub fn encode_input(manifest: &[u8], sources: &[(&str, &[u8])]) -> Option<Vec<u8>> {
    if manifest.len() > MAX_MANIFEST_BYTES {
        return None;
    }
    let size = encoded_payload_len(sources.iter().copied())?;
    let mut output = Vec::with_capacity(16 + manifest.len() + size);
    output.extend_from_slice(INPUT_MAGIC);
    put_bytes(&mut output, manifest);
    output.extend_from_slice(&(size as u32).to_be_bytes());
    output.extend_from_slice(&ARCHIVE_TAG);
    output.extend_from_slice(&(sources.len() as u32).to_be_bytes());
    for (path, content) in sources {
        put_bytes(&mut output, path.as_bytes());
        put_bytes(&mut output, content);
    }
    Some(output)
}

/// Check the inline archive frame bounds without copying any archive bytes.
pub fn encoded_payload_len<'a>(
    sources: impl ExactSizeIterator<Item = (&'a str, &'a [u8])>,
) -> Option<usize> {
    if !(1..=MAX_STAGED_ARCHIVES).contains(&sources.len()) {
        return None;
    }
    let mut size = ARCHIVE_TAG.len() + size_of::<u32>();
    for (path, content) in sources {
        if !is_staging_path(path) || content.is_empty() {
            return None;
        }
        size = size.checked_add(2 * size_of::<u32>() + path.len())?;
        size = size.checked_add(content.len())?;
        if size > MAX_PAYLOAD_BYTES {
            return None;
        }
    }
    Some(size)
}

/// Decode the bounded source table with content borrowed from the input.
pub fn decode(payload: &[u8]) -> io::Result<HashMap<&str, &[u8]>> {
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid inline Storage archives",
        )
    };
    let mut input = payload.strip_prefix(&ARCHIVE_TAG).ok_or_else(invalid)?;
    let count = u32::from_be_bytes(number(&mut input)?) as usize;
    if count == 0 || count > MAX_STAGED_ARCHIVES || payload.len() > MAX_PAYLOAD_BYTES {
        return Err(invalid());
    }
    let mut sources = HashMap::with_capacity(count);
    for _ in 0..count {
        let path =
            std::str::from_utf8(bytes(&mut input, MAX_PATH_BYTES)?).map_err(|_| invalid())?;
        let content = bytes(&mut input, MAX_PAYLOAD_BYTES)?;
        if !is_staging_path(path) || content.is_empty() || sources.insert(path, content).is_some() {
            return Err(invalid());
        }
    }
    if !input.is_empty() {
        return Err(invalid());
    }
    Ok(sources)
}

fn is_staging_path(path: &str) -> bool {
    path.len() <= MAX_PATH_BYTES
        && !path.as_bytes().contains(&0)
        && path.ends_with(".tar.gz")
        && Path::new(path).parent() == Some(Path::new(STAGED_ARCHIVE_DIR))
}
