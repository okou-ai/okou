use crate::support::{TarEntry, create_tar_gz_entries, run_guest_storage_apply_manifest_json};
use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::json;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::MetadataExt;
#[cfg(target_os = "linux")]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

fn apply(root: &Path, mount: &Path, archive: &[u8]) -> io::Result<bool> {
    let staged = root.join("staged.tar.gz");
    fs::write(&staged, archive)?;
    let manifest = json!({"storageMounts": [{
        "mountPath": mount, "archiveUrl": format!("file://{}", staged.display())
    }]});
    let manifest = serde_json::to_vec(&manifest).map_err(io::Error::other)?;
    Ok(run_guest_storage_apply_manifest_json(&manifest))
}

fn append_file(
    builder: &mut tar::Builder<GzEncoder<Vec<u8>>>,
    path: impl AsRef<Path>,
    contents: &[u8],
    mode: u32,
    mtime: u64,
) -> io::Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(contents.len() as u64);
    header.set_mode(mode);
    header.set_mtime(mtime);
    builder.append_data(&mut header, path, contents)
}

#[test]
fn ordinary_files_preserve_metadata_and_extended_names() {
    use std::os::unix::ffi::OsStrExt;
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let long = format!("nested/{}/file", "long".repeat(40));
    let binary = Path::new(std::ffi::OsStr::from_bytes(b"nested/non-utf8-\xff"));
    let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
    append_file(
        &mut builder,
        "nested/executable",
        b"run",
        0o4751,
        1234567890,
    )
    .unwrap();
    append_file(&mut builder, "nested/empty", b"", 0o600, 0).unwrap();
    append_file(&mut builder, &long, b"long name", 0o640, 1234567891).unwrap();
    append_file(&mut builder, binary, b"binary name", 0o644, 1234567892).unwrap();
    let archive = builder.into_inner().unwrap().finish().unwrap();

    assert!(apply(dir.path(), &mount, &archive).unwrap());
    for (path, contents, mode, mtime) in [
        (
            Path::new("nested/executable"),
            b"run".as_slice(),
            0o751,
            1234567890,
        ),
        (Path::new("nested/empty"), b"".as_slice(), 0o600, 1),
        (Path::new(&long), b"long name".as_slice(), 0o640, 1234567891),
        (binary, b"binary name".as_slice(), 0o644, 1234567892),
    ] {
        let path = mount.join(path);
        let metadata = fs::metadata(&path).unwrap();
        assert_eq!(metadata.mode() & 0o7777, mode);
        assert_eq!(metadata.mtime(), mtime);
        assert_eq!(fs::read(path).unwrap(), contents);
    }
}

#[test]
fn replacement_preserves_hardlinks_and_contained_symlink_parents() {
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    fs::create_dir(&mount).unwrap();
    let outside = dir.path().join("outside");
    fs::write(&outside, b"outside original").unwrap();
    fs::hard_link(&outside, mount.join("existing")).unwrap();
    let archive = create_tar_gz_entries(&[
        TarEntry::File("nested/file", b"first"),
        TarEntry::Hardlink("nested/link", "nested/file"),
        TarEntry::File("nested/file", b"replacement"),
        TarEntry::File("existing", b"new inode"),
        TarEntry::Symlink("alias", "nested"),
        TarEntry::File("alias/through-link", b"contained"),
        TarEntry::File("nested/after-link", b"ordinary again"),
    ])
    .unwrap();

    assert!(apply(dir.path(), &mount, &archive).unwrap());
    for (path, content) in [
        ("nested/file", b"replacement".as_slice()),
        ("nested/link", b"first".as_slice()),
        ("existing", b"new inode".as_slice()),
        ("nested/through-link", b"contained".as_slice()),
        ("nested/after-link", b"ordinary again".as_slice()),
    ] {
        assert_eq!(fs::read(mount.join(path)).unwrap(), content);
    }
    assert_eq!(fs::read(&outside).unwrap(), b"outside original");
    assert_ne!(
        fs::metadata(mount.join("existing")).unwrap().ino(),
        fs::metadata(outside).unwrap().ino()
    );
}

#[test]
fn many_distinct_parents_and_repeated_attempts_release_descriptors() {
    let paths = (0..160)
        .map(|i| format!("parent-{i}/nested/file"))
        .collect::<Vec<_>>();
    let entries = paths
        .iter()
        .map(|path| TarEntry::File(path, b"value"))
        .collect::<Vec<_>>();
    let archive = create_tar_gz_entries(&entries).unwrap();
    let dir = tempfile::tempdir().unwrap();
    for attempt in 0..3 {
        let mount = dir.path().join(format!("mount-{attempt}"));
        assert!(apply(dir.path(), &mount, &archive).unwrap());
        for path in &paths {
            assert_eq!(fs::read(mount.join(path)).unwrap(), b"value");
        }
    }
}

#[test]
fn truncated_ordinary_payload_fails_with_partial_output() {
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let mut header = tar::Header::new_gnu();
    header.set_path("nested/partial").unwrap();
    header.set_mode(0o644);
    header.set_mtime(1);
    header.set_size(4096);
    header.set_cksum();
    let mut gzip = GzEncoder::new(Vec::new(), Compression::fast());
    gzip.write_all(header.as_bytes()).unwrap();
    gzip.write_all(b"abc").unwrap();
    // Valid gzip, but the member payload is shorter than its tar size.
    let archive = gzip.finish().unwrap();

    assert!(!apply(dir.path(), &mount, &archive).unwrap());
    assert_eq!(fs::read(mount.join("nested/partial")).unwrap(), b"abc");
}

#[cfg(target_os = "linux")]
#[test]
fn descriptor_relative_writes_retain_the_full_path_limit() {
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let path = format!("{}file", format!("{}/", "d".repeat(100)).repeat(42));
    let archive = create_tar_gz_entries(&[
        TarEntry::File(&path, b"too long"),
        TarEntry::File("must-not-write", b"later"),
    ])
    .unwrap();

    assert!(!apply(dir.path(), &mount, &archive).unwrap());
    assert!(!mount.join("must-not-write").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn low_descriptor_limit_keeps_supported_archives_extractable() {
    const CHILD: &str = "OKOU_GUEST_ARCHIVE_LOW_NOFILE_CHILD";
    if std::env::var_os(CHILD).is_some() {
        many_distinct_parents_and_repeated_attempts_release_descriptors();
        for _ in 0..16 {
            truncated_ordinary_payload_fails_with_partial_output();
        }
        // Two slots suffice for the archive reader and output. The optimized
        // writer must release its root as well as cached parents before tar.
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("mount");
        let archive = create_tar_gz_entries(&[TarEntry::File("nested/file", b"value")]).unwrap();
        let staged = dir.path().join("staged.tar.gz");
        fs::write(&staged, archive).unwrap();
        let manifest = serde_json::to_vec(&json!({"storageMounts": [{
            "mountPath": mount, "archiveUrl": format!("file://{}", staged.display())
        }]}))
        .unwrap();
        let mut held = Vec::new();
        loop {
            match fs::File::open("/dev/null") {
                Ok(file) => held.push(file),
                Err(error) => {
                    assert_eq!(error.raw_os_error(), Some(libc::EMFILE));
                    break;
                }
            }
        }
        assert!(held.pop().is_some());
        assert!(held.pop().is_some());
        let success = run_guest_storage_apply_manifest_json(&manifest);
        drop(held);
        assert!(success);
        assert_eq!(fs::read(mount.join("nested/file")).unwrap(), b"value");
        return;
    }
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child
        .args([
            "--exact",
            "rooted_extraction::low_descriptor_limit_keeps_supported_archives_extractable",
            "--nocapture",
        ])
        .env(CHILD, "1");
    use std::os::unix::process::CommandExt;
    // SAFETY: the child closure invokes only the async-signal-safe setrlimit
    // syscall and constructs an error on failure. The parent limit is untouched.
    unsafe {
        child.pre_exec(|| {
            let limit = libc::rlimit {
                rlim_cur: 32,
                rlim_max: 32,
            };
            if libc::setrlimit(libc::RLIMIT_NOFILE, &limit) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let output = crate::process::CommandExecution::spawn(&mut child, None)
        .unwrap()
        .wait()
        .unwrap();
    assert!(
        output.status.success(),
        "child failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
}

#[cfg(target_os = "linux")]
#[test]
fn directory_mode_changes_recheck_cached_ancestors() {
    const CHILD: &str = "OKOU_GUEST_ARCHIVE_PERMISSIONS_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "--exact",
                "rooted_extraction::directory_mode_changes_recheck_cached_ancestors",
                "--nocapture",
            ])
            .env(CHILD, "1");
        let output = crate::process::CommandExecution::spawn(&mut child, None)
            .unwrap()
            .wait()
            .unwrap();
        assert!(
            output.status.success(),
            "child failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        return;
    }

    // SAFETY: only this isolated, single-test child changes credentials. Drop
    // them after exec so a root-only build directory does not prevent startup.
    unsafe {
        if libc::geteuid() == 0 {
            assert_eq!(libc::setgroups(0, std::ptr::null()), 0);
            assert_eq!(libc::setgid(65534), 0);
            assert_eq!(libc::setuid(65534), 0);
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
    append_file(&mut builder, "parent/nested/before", b"before", 0o644, 1).unwrap();
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Directory);
    header.set_mode(0);
    header.set_size(0);
    builder
        .append_data(&mut header, "parent", io::empty())
        .unwrap();
    append_file(&mut builder, "parent/nested/after", b"after", 0o644, 1).unwrap();
    append_file(&mut builder, "must-not-write", b"later", 0o644, 1).unwrap();
    let archive = builder.into_inner().unwrap().finish().unwrap();

    assert!(!apply(dir.path(), &mount, &archive).unwrap());
    // Restore traversal only for observing the result and fixture cleanup.
    fs::set_permissions(mount.join("parent"), fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        fs::read(mount.join("parent/nested/before")).unwrap(),
        b"before"
    );
    assert!(!mount.join("parent/nested/after").exists());
    assert!(!mount.join("must-not-write").exists());
}
