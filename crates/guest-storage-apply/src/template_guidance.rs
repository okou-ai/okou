//! Verify the same immutable template bytes on remote and staged archive paths.

use crate::{archive, error::DownloadError, source::ArchiveSource};
use guest_contracts::storage_manifest::{
    MAX_TEMPLATE_CONTENT_BYTES, MAX_TEMPLATE_FILE_BYTES, MAX_TEMPLATE_FILES,
    MAX_TEMPLATE_TAR_BYTES, TemplateGuidanceReference,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::{self, Read, Seek, Write},
    path::Path,
};

pub(crate) fn extract(
    source: ArchiveSource,
    target: &Path,
    concurrency: usize,
    reference: &TemplateGuidanceReference,
) -> Result<(), DownloadError> {
    reference.validate().map_err(DownloadError::new)?;
    // Spool with bounded memory: large templates do not enter the 8 MiB host
    // cache, and unverified bytes must not be published as template files.
    let (reader, _) = source.into_parts();
    let mut reader = reader.take(reference.archive_bytes + 1);
    let mut file =
        tempfile::tempfile().map_err(|_| DownloadError::new("Cannot stage template archive"))?;
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|_| DownloadError::new("Cannot read template archive"))?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > reference.archive_bytes {
            return Err(DownloadError::new("Template archive size mismatch"));
        }
        let chunk = buffer
            .get(..count)
            .ok_or_else(|| DownloadError::new("Invalid template archive read size"))?;
        digest.update(chunk);
        file.write_all(chunk)
            .map_err(|_| DownloadError::new("Cannot stage template archive"))?;
    }
    if bytes != reference.archive_bytes || hex::encode(digest.finalize()) != reference.sha256 {
        return Err(DownloadError::new("Template archive integrity mismatch"));
    }
    file.rewind()
        .map_err(|_| DownloadError::new("Cannot rewind template archive"))?;
    let mut paths = HashSet::new();
    let mut expanded = 0_u64;
    archive::extract_tar_gz_checked(
        ArchiveSource::local(file, Some(bytes)),
        target,
        concurrency,
        MAX_TEMPLATE_TAR_BYTES,
        |path, entry_type, size, header| {
            let mode = header.mode()?;
            let path = path
                .to_str()
                .ok_or_else(|| io::Error::other("Template path is not UTF-8"))?;
            if !archive::ancestors_within_target(&target.join(path), target)
                || !entry_type.is_file()
                || mode & 0o7777 != 0o644
                || path.len() > 4095
                || path.contains(['\\', '\0'])
                || path
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == ".." || part.len() > 255)
                || paths.len() >= MAX_TEMPLATE_FILES
                || !paths.insert(path.to_owned())
                || size > MAX_TEMPLATE_FILE_BYTES
            {
                return Err(io::Error::other("Invalid template guidance entry"));
            }
            expanded = expanded
                .checked_add(size)
                .ok_or_else(|| io::Error::other("Template content size overflow"))?;
            if expanded > MAX_TEMPLATE_CONTENT_BYTES {
                return Err(io::Error::other("Template guidance exceeds content limit"));
            }
            Ok(())
        },
    )?;
    if paths.is_empty() {
        return Err(DownloadError::new("Template archive contains no files"));
    }
    Ok(())
}
