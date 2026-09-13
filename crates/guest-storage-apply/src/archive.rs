use crate::LOG_TAG;
use crate::error::DownloadError;
use crate::path::normalize_path;
use crate::source::{ArchiveSource, HttpBodyReadFailure};
use crate::tar_metadata::{MetadataBudget, MetadataReader};
use guest_telemetry::log_warn;
use std::io;
use std::path::Path;

/// Extract a gzip-compressed tar archive into an existing target directory.
///
/// `target` must be an existing canonical directory prepared before download
/// scheduling. Accepted entries are unpacked sequentially and directly into it.
/// Extraction is non-atomic and does not roll back entries written before a
/// later error. Entries rejected by the path and link safety checks, and link
/// targets or sources that are missing or unreadable for non-transport reasons,
/// are logged and skipped. Consequently, `Ok(())` means that all accepted
/// entries were processed and the enclosing gzip member passed validation,
/// not that every archive entry was unpacked.
///
/// # TOCTOU (documented, not mitigated)
///
/// The ancestor checks performed before each `unpack_in` do not provide TOCTOU
/// protection. Sequential entry processing only orders entries within this
/// process; it does not prevent another process from concurrently mutating the
/// destination tree (for example, atomically replacing a checked directory with
/// a symlink) between a check and the extraction below. The `tar` crate's
/// threat model explicitly excludes concurrent destination mutation, and
/// preventing such races requires OS primitives (e.g. `openat`/`O_PATH`) that
/// this crate does not use. Exposure is reduced by lifecycle assumptions owned
/// by callers: the runner applies storage before spawning the guest agent, and
/// the guest-storage-apply scheduler serializes logically or physically overlapping
/// targets within this process. Callers that permit concurrent access to an
/// extraction target must not rely on this function for containment.
///
/// # Errors
///
/// An unreadable archive entry or entry path, a failure to unpack an
/// accepted entry, or a gzip validation failure terminates extraction. Archive
/// errors are retriable when the source recorded an HTTP body-read failure;
/// otherwise they are fatal. Files written before an error remain in the target
/// directory.
pub(crate) fn extract_tar_gz(source: ArchiveSource, target: &Path) -> Result<(), DownloadError> {
    let (reader, http_body_read_failure) = source.into_parts();
    let decoder = flate2::read::GzDecoder::new(reader);
    let budget = MetadataBudget::default();
    let mut archive = tar::Archive::new(MetadataReader::new(decoder, &budget));

    // Extract entries one by one, validating paths to prevent symlink path traversal.
    let mut entries = archive
        .entries()
        .map_err(|e| archive_error(&http_body_read_failure, "Failed to read archive entries", e))?;
    loop {
        budget.begin_entry();
        let Some(entry) = entries.next() else {
            break;
        };
        let mut entry = entry.map_err(|e| {
            archive_error(&http_body_read_failure, "Failed to read archive entry", e)
        })?;
        budget.allow_payload(&mut entry).map_err(|e| {
            archive_error(&http_body_read_failure, "Failed to read archive entry", e)
        })?;

        let entry_path = entry
            .path()
            .map_err(|e| archive_error(&http_body_read_failure, "Failed to read entry path", e))?
            .into_owned();

        let entry_type = entry.header().entry_type();

        // Check that the entry path lexically stays within the target directory
        // (normalize to collapse any .. components before checking)
        let full_path = target.join(&entry_path);
        if !is_within(&full_path, target) {
            log_warn!(
                LOG_TAG,
                "Skipping entry with path escaping target dir: {}",
                entry_path.display()
            );
            continue;
        }

        // For symlinks, validate the resolved link target stays within the target directory
        if entry_type.is_symlink() {
            let link_target = match entry.link_name() {
                Ok(Some(t)) => t,
                Err(e) if http_body_read_failure.failed() => {
                    return Err(archive_error(
                        &http_body_read_failure,
                        format!("Failed to read symlink target {}", entry_path.display()),
                        e,
                    ));
                }
                _ => {
                    log_warn!(
                        LOG_TAG,
                        "Skipping symlink with unreadable target: {}",
                        entry_path.display()
                    );
                    continue;
                }
            };
            let link_dir = full_path.parent().unwrap_or(target);
            let resolved = link_dir.join(&*link_target);
            if !is_within(&resolved, target) {
                log_warn!(
                    LOG_TAG,
                    "Skipping symlink with target escaping dir: {} -> {}",
                    entry_path.display(),
                    link_target.display()
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
                        &http_body_read_failure,
                        format!("Failed to read hardlink source {}", entry_path.display()),
                        e,
                    ));
                }
                _ => {
                    log_warn!(
                        LOG_TAG,
                        "Skipping hardlink with unreadable source: {}",
                        entry_path.display()
                    );
                    continue;
                }
            };
            let resolved = target.join(&*link_name);
            if !is_within(&resolved, target) {
                log_warn!(
                    LOG_TAG,
                    "Skipping hardlink with source escaping dir: {} -> {}",
                    entry_path.display(),
                    link_name.display()
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
            log_warn!(
                LOG_TAG,
                "Skipping entry whose parent resolves outside target: {}",
                entry_path.display()
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
                &http_body_read_failure,
                format!("Failed to extract entry {}", entry_path.display()),
                e,
            )
        })?;
    }

    // Tar iteration stops at its end marker before gzip necessarily reaches its
    // trailer. Finish the same decoder to validate its CRC and uncompressed size.
    let mut decoder = archive.into_inner();
    io::copy(&mut decoder, &mut io::sink())
        .map_err(|e| archive_error(&http_body_read_failure, "Failed to finish gzip archive", e))?;

    Ok(())
}

fn archive_error(
    http_body_read_failure: &HttpBodyReadFailure,
    message: impl Into<String>,
    error: io::Error,
) -> DownloadError {
    let message = format!("{}: {error}", message.into());
    if http_body_read_failure.failed() {
        DownloadError::transport(message, true)
    } else {
        DownloadError::fatal(message)
    }
}

/// Check whether `path` stays within `target` after lexical normalization.
fn is_within(path: &Path, target: &Path) -> bool {
    normalize_path(path).starts_with(target)
}

/// Walk up from `path`'s parent toward `target`, find the deepest existing ancestor,
/// canonicalize it, and verify it still resolves within `target`.
/// Returns false if any ancestor resolves outside `target` (e.g., a symlink directory
/// was planted earlier in the archive to redirect writes outside the target).
fn ancestors_within_target(path: &Path, target: &Path) -> bool {
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
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use std::io::{Cursor, Write};
    use std::path::PathBuf;

    enum TarEntry<'a> {
        File(&'a str, &'a [u8]),
        Symlink(&'a str, &'a str),
        Hardlink(&'a str, &'a str),
        /// Hand-crafted entry for malicious-input tests that `tar::Builder`
        /// rejects (absolute paths, `..` components, empty linkname). Always
        /// written after all non-Raw entries in the archive.
        Raw {
            path: &'a [u8],
            /// Typeflag byte: `b'0'` regular file, `b'2'` symlink.
            entry_type: u8,
            /// Octal mode string like `b"0000644\0"`.
            mode: &'a [u8; 8],
            /// Empty = no data block appended (size stays zero).
            content: &'a [u8],
        },
    }

    /// Create a tar.gz archive with mixed file, link, and raw entries.
    fn create_tar_gz_entries(entries: &[TarEntry]) -> std::io::Result<Vec<u8>> {
        /// Strip builder-written EOF, splice hand-crafted tar headers onto the
        /// end, and re-add EOF. Scoped as an inner fn so the indexing-slicing
        /// allow stays off the rest of the helper.
        #[allow(clippy::indexing_slicing)]
        fn append_raw_entries(tar_data: &mut Vec<u8>, entries: &[TarEntry]) {
            while tar_data.len() >= 512 && tar_data[tar_data.len() - 512..].iter().all(|&b| b == 0)
            {
                tar_data.truncate(tar_data.len() - 512);
            }
            for entry in entries {
                if let TarEntry::Raw {
                    path,
                    entry_type,
                    mode,
                    content,
                } = entry
                {
                    let mut header_block = [0u8; 512];
                    header_block[..path.len()].copy_from_slice(path);
                    header_block[100..108].copy_from_slice(*mode);
                    header_block[108..116].copy_from_slice(b"0000000\0"); // uid
                    header_block[116..124].copy_from_slice(b"0000000\0"); // gid
                    let size_str = format!("{:011o}\0", content.len());
                    header_block[124..136].copy_from_slice(size_str.as_bytes());
                    header_block[136..148].copy_from_slice(b"00000000000\0"); // mtime
                    header_block[156] = *entry_type;
                    header_block[257..263].copy_from_slice(b"ustar\0");
                    header_block[263..265].copy_from_slice(b"00");
                    // Checksum: field filled with spaces, sum all bytes, write result.
                    header_block[148..156].copy_from_slice(b"        ");
                    let cksum: u32 = header_block.iter().map(|&b| b as u32).sum();
                    let cksum_str = format!("{:06o}\0 ", cksum);
                    header_block[148..156].copy_from_slice(cksum_str.as_bytes());

                    tar_data.extend_from_slice(&header_block);
                    if !content.is_empty() {
                        let mut data_block = [0u8; 512];
                        data_block[..content.len()].copy_from_slice(content);
                        tar_data.extend_from_slice(&data_block);
                    }
                }
            }
            tar_data.extend_from_slice(&[0u8; 1024]); // EOF
        }

        let mut tar_data = Vec::new();
        let has_raw = entries
            .iter()
            .any(|entry| matches!(entry, TarEntry::Raw { .. }));
        {
            let mut builder = tar::Builder::new(&mut tar_data);
            for entry in entries {
                match entry {
                    TarEntry::File(path, contents) => {
                        let mut header = tar::Header::new_gnu();
                        header.set_size(contents.len() as u64);
                        header.set_mode(0o644);
                        header.set_cksum();
                        builder.append_data(&mut header, path, *contents)?;
                    }
                    TarEntry::Symlink(path, target) => {
                        let mut header = tar::Header::new_gnu();
                        header.set_size(0);
                        header.set_mode(0o777);
                        header.set_entry_type(tar::EntryType::Symlink);
                        header.set_cksum();
                        builder.append_link(&mut header, path, target)?;
                    }
                    TarEntry::Hardlink(path, target) => {
                        let mut header = tar::Header::new_gnu();
                        header.set_size(0);
                        header.set_mode(0o644);
                        header.set_entry_type(tar::EntryType::Link);
                        header.set_cksum();
                        builder.append_link(&mut header, path, target)?;
                    }
                    TarEntry::Raw { .. } => {}
                }
            }
            builder.finish()?;
        }

        if has_raw {
            append_raw_entries(&mut tar_data, entries);
        }

        let mut gz_data = Vec::new();
        let mut encoder = GzEncoder::new(&mut gz_data, Compression::fast());
        encoder.write_all(&tar_data)?;
        encoder.finish()?;
        Ok(gz_data)
    }

    fn extract_archive(tar_gz: Vec<u8>, mount: &Path) -> bool {
        std::fs::create_dir_all(mount).unwrap();
        let target = mount.canonicalize().unwrap();
        extract_tar_gz(ArchiveSource::local(Cursor::new(tar_gz), None), &target).is_ok()
    }

    #[test]
    fn normalize_path_removes_dot() {
        assert_eq!(normalize_path(Path::new("/a/./b")), PathBuf::from("/a/b"));
    }

    #[test]
    fn normalize_path_collapses_parent() {
        assert_eq!(
            normalize_path(Path::new("/a/b/../c")),
            PathBuf::from("/a/c")
        );
    }

    #[test]
    fn normalize_path_does_not_escape_root() {
        // Going above root should not pop the root component
        assert_eq!(normalize_path(Path::new("/a/../../b")), PathBuf::from("/b"));
    }

    #[test]
    fn normalize_path_already_clean() {
        assert_eq!(
            normalize_path(Path::new("/usr/local/bin")),
            PathBuf::from("/usr/local/bin")
        );
    }

    #[test]
    fn normalize_path_multiple_dots() {
        assert_eq!(
            normalize_path(Path::new("/a/./b/./c")),
            PathBuf::from("/a/b/c")
        );
    }

    #[test]
    fn is_within_simple_child() {
        assert!(is_within(
            Path::new("/target/subdir/file.txt"),
            Path::new("/target")
        ));
    }

    #[test]
    fn is_within_rejects_traversal() {
        assert!(!is_within(
            Path::new("/target/../etc/passwd"),
            Path::new("/target")
        ));
    }

    #[test]
    fn is_within_exact_match() {
        assert!(is_within(Path::new("/target"), Path::new("/target")));
    }

    #[test]
    fn is_within_dot_in_path() {
        assert!(is_within(
            Path::new("/target/./subdir"),
            Path::new("/target")
        ));
    }

    #[test]
    fn is_within_rejects_sibling() {
        assert!(!is_within(
            Path::new("/target/../sibling/file"),
            Path::new("/target")
        ));
    }

    #[test]
    fn ancestors_within_target_simple() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path();
        std::fs::create_dir_all(target.join("sub")).unwrap();
        assert!(ancestors_within_target(
            &target.join("sub/file.txt"),
            target
        ));
    }

    #[test]
    fn ancestors_within_target_non_existent_parent() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path();
        // Parent "sub" doesn't exist yet — should walk up to target itself
        assert!(ancestors_within_target(
            &target.join("sub/deep/file.txt"),
            target
        ));
    }

    #[test]
    fn ancestors_within_target_symlink_escape() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        // Create a symlink inside target that points outside
        std::os::unix::fs::symlink(&outside, target.join("escape")).unwrap();
        assert!(!ancestors_within_target(
            &target.join("escape/file.txt"),
            &target
        ));
    }

    #[test]
    fn symlink_path_traversal_blocked() {
        let tar_gz = create_tar_gz_entries(&[
            TarEntry::File("legit.txt", b"safe content"),
            TarEntry::Symlink("evil_link", "../../etc/passwd"),
        ])
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("mount");
        let result = extract_archive(tar_gz, &mount);

        assert!(result);
        assert_eq!(
            std::fs::read_to_string(mount.join("legit.txt")).unwrap(),
            "safe content"
        );
        assert!(mount.join("evil_link").symlink_metadata().is_err());
    }

    #[test]
    fn symlink_within_target_allowed() {
        let tar_gz = create_tar_gz_entries(&[
            TarEntry::File("real.txt", b"real content"),
            TarEntry::Symlink("link.txt", "real.txt"),
        ])
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("mount");
        let result = extract_archive(tar_gz, &mount);

        assert!(result);
        assert_eq!(
            std::fs::read_to_string(mount.join("real.txt")).unwrap(),
            "real content"
        );
        assert!(
            mount
                .join("link.txt")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn path_traversal_via_dotdot_blocked() {
        let tar_gz = create_tar_gz_entries(&[
            TarEntry::File("legit.txt", b"safe"),
            TarEntry::Raw {
                path: b"../outside.txt",
                entry_type: b'0',
                mode: b"0000644\0",
                content: b"escaped",
            },
        ])
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("mount");
        let result = extract_archive(tar_gz, &mount);

        assert!(result);
        assert_eq!(
            std::fs::read_to_string(mount.join("legit.txt")).unwrap(),
            "safe"
        );
        assert!(!dir.path().join("outside.txt").exists());
    }

    #[test]
    fn two_step_symlink_attack_blocked() {
        let evil_target = tempfile::tempdir().unwrap();
        let evil_target_path = evil_target.path().to_str().unwrap();

        let tar_gz = create_tar_gz_entries(&[
            TarEntry::File("safe.txt", b"safe"),
            TarEntry::Symlink("subdir", evil_target_path),
            TarEntry::File("subdir/payload.txt", b"malicious"),
        ])
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("mount");
        let result = extract_archive(tar_gz, &mount);

        assert!(result);
        assert_eq!(
            std::fs::read_to_string(mount.join("safe.txt")).unwrap(),
            "safe"
        );
        assert!(!evil_target.path().join("payload.txt").exists());
    }

    #[test]
    fn hardlink_escaping_target_blocked() {
        let tar_gz = create_tar_gz_entries(&[
            TarEntry::File("legit.txt", b"safe"),
            TarEntry::Hardlink("evil_hardlink", "/etc/passwd"),
        ])
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("mount");
        let result = extract_archive(tar_gz, &mount);

        assert!(result);
        assert_eq!(
            std::fs::read_to_string(mount.join("legit.txt")).unwrap(),
            "safe"
        );
        assert!(!mount.join("evil_hardlink").exists());
    }

    #[test]
    fn symlink_relative_dotdot_escape_blocked() {
        let dir = tempfile::tempdir().unwrap();
        let outside_file = dir.path().join("secret.txt");
        std::fs::write(&outside_file, "secret data").unwrap();

        let tar_gz = create_tar_gz_entries(&[
            TarEntry::File("legit.txt", b"safe"),
            TarEntry::Symlink("escape", "../secret.txt"),
        ])
        .unwrap();

        let mount = dir.path().join("mount");
        let result = extract_archive(tar_gz, &mount);

        assert!(result);
        assert_eq!(
            std::fs::read_to_string(mount.join("legit.txt")).unwrap(),
            "safe"
        );
        assert!(mount.join("escape").symlink_metadata().is_err());
    }

    #[test]
    fn two_step_attack_deep_nested_blocked() {
        let evil_target = tempfile::tempdir().unwrap();
        let evil_target_path = evil_target.path().to_str().unwrap();

        let tar_gz = create_tar_gz_entries(&[
            TarEntry::Symlink("a", evil_target_path),
            TarEntry::File("a/b/c.txt", b"payload"),
        ])
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("mount");
        let result = extract_archive(tar_gz, &mount);

        assert!(result);
        assert!(!evil_target.path().join("b").exists());
        assert!(!evil_target.path().join("b/c.txt").exists());
    }

    #[test]
    fn hardlink_relative_dotdot_escape_blocked() {
        let tar_gz = create_tar_gz_entries(&[
            TarEntry::File("legit.txt", b"safe"),
            TarEntry::Hardlink("evil_hardlink", "../../../etc/passwd"),
        ])
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("mount");
        let result = extract_archive(tar_gz, &mount);

        assert!(result);
        assert_eq!(
            std::fs::read_to_string(mount.join("legit.txt")).unwrap(),
            "safe"
        );
        assert!(!mount.join("evil_hardlink").exists());
    }

    #[test]
    fn absolute_path_entry_blocked() {
        let tar_gz = create_tar_gz_entries(&[
            TarEntry::File("legit.txt", b"safe"),
            TarEntry::Raw {
                path: b"/etc/passwd",
                entry_type: b'0',
                mode: b"0000644\0",
                content: b"malicious",
            },
        ])
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("mount");
        let result = extract_archive(tar_gz, &mount);

        assert!(result);
        assert_eq!(
            std::fs::read_to_string(mount.join("legit.txt")).unwrap(),
            "safe"
        );
        assert!(!mount.join("etc/passwd").exists());
    }

    #[test]
    fn symlink_missing_link_target_skipped() {
        let tar_gz = create_tar_gz_entries(&[
            TarEntry::File("legit.txt", b"safe"),
            TarEntry::Raw {
                path: b"bad_symlink",
                entry_type: b'2',
                mode: b"0000777\0",
                content: b"",
            },
        ])
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("mount");
        let result = extract_archive(tar_gz, &mount);

        assert!(result);
        assert_eq!(
            std::fs::read_to_string(mount.join("legit.txt")).unwrap(),
            "safe"
        );
        assert!(mount.join("bad_symlink").symlink_metadata().is_err());
    }
}
