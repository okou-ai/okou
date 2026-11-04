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
        while tar_data.len() >= 512 && tar_data[tar_data.len() - 512..].iter().all(|&b| b == 0) {
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
