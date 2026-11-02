use crate::LOG_TAG;
use crate::error::DownloadError;
use crate::path::normalize_path;
use crate::source::ArchiveSource;
use crate::tar_metadata::{MetadataBudget, MetadataReader};
use guest_telemetry::log_warn;
use std::io::{self, Read};
use std::path::Path;

#[cfg(target_os = "linux")]
pub(crate) mod rooted;

/// Extract a gzip-compressed tar archive into an existing target directory.
///
/// `target` must be an existing canonical directory prepared before download
/// scheduling. Accepted entries are unpacked sequentially and directly into it.
/// Extraction is non-atomic and does not roll back entries written before a
/// later error. Entries rejected by the path and link safety checks, and link
/// targets or sources that are missing or unreadable for non-transport reasons,
/// are skipped with bounded diagnostics: at most 32 examples per attempt and
/// one skipped/suppressed summary, including on failure. Displayed paths are
/// escaped and capped at 256 bytes; safety checks use the unchanged paths.
/// Consequently, `Ok(())` means that all accepted entries were processed and
/// the enclosing gzip member passed validation,
/// not that every archive entry was unpacked.
///
/// # TOCTOU (documented, not mitigated)
///
/// The ancestor checks performed before each `unpack_in` do not provide TOCTOU
/// protection. Sequential entry processing only orders entries within this
/// process; it does not prevent another process from concurrently mutating the
/// destination tree (for example, atomically replacing a checked directory with
/// a symlink) between a check and the extraction below. The `tar` crate's
/// threat model explicitly excludes concurrent destination mutation. The Linux
/// ordinary-file writer also caches directory identities for the duration of
/// an extraction; it does not protect against an external directory rename.
/// Exposure is reduced by lifecycle assumptions owned
/// by callers: the runner applies storage before spawning the guest agent, and
/// the guest-storage-apply scheduler serializes logically or physically overlapping
/// targets within this process. Callers that permit concurrent access to an
/// extraction target must not rely on this function for containment.
///
/// # Errors
///
/// An unreadable archive entry or entry path, a failure to unpack an
/// accepted entry, or a gzip validation failure terminates extraction. Files
/// written before an error remain in the target directory.
pub(crate) fn extract_tar_gz(source: ArchiveSource, target: &Path) -> Result<(), DownloadError> {
    extract_tar_gz_checked(source, target, u64::MAX, |_, _, _| Ok(()))
}

/// Reuse Storage extraction with an additional package contract before each write.
/// Callers publish the private staging directory only after this succeeds.
pub(crate) fn extract_tar_gz_checked(
    source: ArchiveSource,
    target: &Path,
    max_unpacked_bytes: u64,
    mut validate_entry: impl FnMut(&Path, tar::EntryType, u64) -> io::Result<()>,
) -> Result<(), DownloadError> {
    let mut skipped_entries = SkippedEntries { target, skipped: 0 };
    #[cfg(target_os = "linux")]
    let mut rooted = rooted::RootedWriter::new(target);
    let (reader, http_body_read_failure) = source.into_parts();
    let decoder = flate2::read::GzDecoder::new(reader).take(max_unpacked_bytes.saturating_add(1));
    let budget = MetadataBudget::default();
    let mut archive = tar::Archive::new(MetadataReader::new(decoder, &budget));

    // Extract entries one by one, validating paths to prevent symlink path traversal.
    let mut entries = archive
        .entries()
        .map_err(|e| archive_error("Failed to read archive entries", e))?;
    loop {
        budget.begin_entry();
        let Some(entry) = entries.next() else {
            break;
        };
        let mut entry = entry.map_err(|e| archive_error("Failed to read archive entry", e))?;
        budget
            .allow_payload(&mut entry)
            .map_err(|e| archive_error("Failed to read archive entry", e))?;

        let entry_path = entry
            .path()
            .map_err(|e| archive_error("Failed to read entry path", e))?
            .into_owned();

        let entry_type = entry.header().entry_type();
        validate_entry(&entry_path, entry_type, entry.size())
            .map_err(|e| archive_error("Invalid archive entry", e))?;

        #[cfg(target_os = "linux")]
        {
            // Only plain, new regular files have the metadata and replacement
            // semantics implemented by the rooted writer. Tar owns all others.
            if entry_type.is_file()
                && entry
                    .pax_extensions()
                    .map_err(|e| archive_error("Failed to read entry metadata", e))?
                    .is_none()
                && rooted.try_unpack(&entry_path, &mut entry).map_err(|e| {
                    archive_error(
                        format!("Failed to extract entry {}", entry_path.display()),
                        e,
                    )
                })?
            {
                continue;
            }
            // General tar operations can replace links or change directory
            // permissions. Never reuse ancestry across one of those operations.
            rooted.invalidate();
        }

        // Check that the entry path lexically stays within the target directory
        // (normalize to collapse any .. components before checking)
        let full_path = target.join(&entry_path);
        if !is_within(&full_path, target) {
            skipped_entries.record("entry with path escaping target dir", &entry_path, None);
            continue;
        }

        // For symlinks, validate the resolved link target stays within the target directory
        if entry_type.is_symlink() {
            let link_target = match entry.link_name() {
                Ok(Some(t)) => t,
                Err(e) if http_body_read_failure.failed() => {
                    return Err(archive_error(
                        format!("Failed to read symlink target {}", entry_path.display()),
                        e,
                    ));
                }
                _ => {
                    skipped_entries.record("symlink with unreadable target", &entry_path, None);
                    continue;
                }
            };
            let link_dir = full_path.parent().unwrap_or(target);
            let resolved = link_dir.join(&*link_target);
            if !is_within(&resolved, target) {
                skipped_entries.record(
                    "symlink with target escaping dir",
                    &entry_path,
                    Some(&link_target),
                );
                continue;
            }
        }

        // For hardlinks, validate the link source stays within the target directory
        if entry_type == tar::EntryType::Link {
            let link_name = match entry.link_name() {
                Ok(Some(t)) => t,
                Err(e) if http_body_read_failure.failed() => {
                    return Err(archive_error(
                        format!("Failed to read hardlink source {}", entry_path.display()),
                        e,
                    ));
                }
                _ => {
                    skipped_entries.record("hardlink with unreadable source", &entry_path, None);
                    continue;
                }
            };
            let resolved = target.join(&*link_name);
            if !is_within(&resolved, target) {
                skipped_entries.record(
                    "hardlink with source escaping dir",
                    &entry_path,
                    Some(&link_name),
                );
                continue;
            }
        }

        // Verify that parent directories haven't been replaced by symlinks pointing outside
        // the target (two-step attack: first create a symlink dir, then write entries through
        // it). Walk up to the deepest existing ancestor since the immediate parent may not
        // exist yet. This applies to ALL entry types — a symlink/hardlink entry extracted
        // through a malicious symlink directory is equally dangerous.
        if !ancestors_within_target(&full_path, target) {
            skipped_entries.record(
                "entry whose parent resolves outside target",
                &entry_path,
                None,
            );
            continue;
        }

        // This check-plus-unpack sequence is not TOCTOU-safe: sequential processing of a single
        // archive stream only orders entries within this process, and another process can still
        // replace a checked directory or symlink between the ancestor check and the extraction
        // below. Safety relies on the caller's lifecycle/exclusivity assumptions documented on
        // `extract_tar_gz`.
        entry.unpack_in(target).map_err(|e| {
            archive_error(
                format!("Failed to extract entry {}", entry_path.display()),
                e,
            )
        })?;
    }

    // Tar iteration stops at its end marker before gzip necessarily reaches its
    // trailer. Finish the same decoder to validate its CRC and uncompressed size.
    let mut decoder = archive.into_inner();
    io::copy(&mut decoder, &mut io::sink())
        .map_err(|e| archive_error("Failed to finish gzip archive", e))?;
    if decoder.into_inner().limit() == 0 {
        return Err(DownloadError::new("Archive exceeds expanded size limit"));
    }

    Ok(())
}

const MAX_SKIP_EXAMPLES: u64 = 32;
const MAX_DIAGNOSTIC_PATH_BYTES: usize = 256;

/// Owned by one extraction attempt, never shared between worker threads.
struct SkippedEntries<'a> {
    target: &'a Path,
    skipped: u64,
}

impl SkippedEntries<'_> {
    fn record(&mut self, reason: &'static str, path: &Path, link: Option<&Path>) {
        self.skipped = self.skipped.saturating_add(1);
        if self.skipped > MAX_SKIP_EXAMPLES {
            return;
        }

        // Render only sampled entries, without copying full GNU/PAX names.
        let path = diagnostic_path(path);
        let target = diagnostic_path(self.target);
        if let Some(link) = link {
            log_warn!(
                LOG_TAG,
                "Skipping {reason}: {path} -> {} (archive target: {target})",
                diagnostic_path(link)
            );
        } else {
            log_warn!(
                LOG_TAG,
                "Skipping {reason}: {path} (archive target: {target})"
            );
        }
    }
}

impl Drop for SkippedEntries<'_> {
    fn drop(&mut self) {
        if self.skipped != 0 {
            // A neutral count, not a success record: also emitted on early errors.
            log_warn!(
                LOG_TAG,
                "Archive skipped-entry summary for {}: skipped={}, suppressed={}",
                diagnostic_path(self.target),
                self.skipped,
                self.skipped.saturating_sub(MAX_SKIP_EXAMPLES)
            );
        }
    }
}

/// Bound both the input inspected and escaped UTF8 output. Lossy decoding is
/// diagnostic-only; containment and unpacking always use the original paths.
fn diagnostic_path(path: &Path) -> String {
    const ELLIPSIS: &str = "...";
    let bytes = path.as_os_str().as_encoded_bytes();
    let (prefix, remainder) = bytes.split_at(bytes.len().min(MAX_DIAGNOSTIC_PATH_BYTES));
    let mut rendered = String::with_capacity(MAX_DIAGNOSTIC_PATH_BYTES);
    let mut truncated = !remainder.is_empty();
    for character in String::from_utf8_lossy(prefix).chars() {
        let escaped = character.escape_debug();
        let length = escaped.clone().map(char::len_utf8).sum::<usize>();
        if rendered.len() + length > MAX_DIAGNOSTIC_PATH_BYTES - ELLIPSIS.len() {
            truncated = true;
            break;
        }
        rendered.extend(escaped);
    }
    if truncated {
        rendered.push_str(ELLIPSIS);
    }
    rendered
}

fn archive_error(message: impl Into<String>, error: io::Error) -> DownloadError {
    DownloadError::new(format!("{}: {error}", message.into()))
}

/// Check whether `path` stays within `target` after lexical normalization.
fn is_within(path: &Path, target: &Path) -> bool {
    normalize_path(path).starts_with(target)
}

/// Walk up from `path`'s parent toward `target`, find the deepest existing ancestor,
/// canonicalize it, and verify it still resolves within `target`.
/// Returns false if any ancestor resolves outside `target` (e.g., a symlink directory
/// was planted earlier in the archive to redirect writes outside the target).
pub(crate) fn ancestors_within_target(path: &Path, target: &Path) -> bool {
    // Start from parent — path itself is the entry being extracted (doesn't exist yet).
    let Some(mut ancestor) = path.parent() else {
        return true;
    };
    loop {
        if ancestor == target {
            return true; // Reached target itself, which is already canonical
        }
        // Use symlink_metadata (lstat) instead of exists (stat) so we detect
        // dangling symlinks — exists() follows symlinks and returns false for them.
        if ancestor.symlink_metadata().is_ok() {
            return match ancestor.canonicalize() {
                Ok(canonical) => canonical.starts_with(target),
                Err(_) => false, // dangling symlink or permission error
            };
        }
        match ancestor.parent() {
            Some(parent) => ancestor = parent,
            None => return true,
        }
    }
}

#[cfg(test)]
mod property_tests;

#[cfg(test)]
mod tests;
