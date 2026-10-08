use super::BinaryLoggingFixture;
use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::json;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Output;

const SAMPLE_LIMIT: usize = 32;
const PATH_BYTES: usize = 256;
const LINE_BYTES: usize = 1024;
const SUMMARY: &str = "Archive skipped-entry summary for ";
const REASONS: [&str; 6] = [
    "entry with path escaping target dir",
    "symlink with unreadable target",
    "symlink with target escaping dir",
    "hardlink with unreadable source",
    "hardlink with source escaping dir",
    "entry whose parent resolves outside target",
];

// Write ordinary headers directly: Builder rejects traversal paths and its
// convenience helpers can reorder raw members after the accepted controls.
fn append_member(
    bytes: &mut Vec<u8>,
    path: &[u8],
    kind: tar::EntryType,
    link: &[u8],
    content: &[u8],
) -> io::Result<()> {
    if path.len() > 100 || link.len() > 100 {
        return Err(io::Error::other("ordinary fixture header is too long"));
    }
    let mut header = tar::Header::new_gnu();
    header.set_mode(0o644);
    header.set_size(content.len() as u64);
    header.set_entry_type(kind);
    header
        .as_mut_bytes()
        .get_mut(..path.len())
        .ok_or_else(|| io::Error::other("missing name field"))?
        .copy_from_slice(path);
    header
        .as_mut_bytes()
        .get_mut(157..157 + link.len())
        .ok_or_else(|| io::Error::other("missing link field"))?
        .copy_from_slice(link);
    header.set_cksum();
    bytes.extend_from_slice(header.as_bytes());
    bytes.extend_from_slice(content);
    bytes.resize(bytes.len().div_ceil(512) * 512, 0);
    Ok(())
}

fn append_file(bytes: &mut Vec<u8>, path: &[u8], content: &[u8]) -> io::Result<()> {
    append_member(bytes, path, tar::EntryType::Regular, b"", content)
}

fn tar_with_skips(skips: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    append_file(&mut bytes, b"before.txt", b"accepted before")?;
    for index in 0..skips {
        let (path, kind, link): (&[u8], _, &[u8]) = match index % 6 {
            0 => (b"../outside.txt", tar::EntryType::Regular, b""),
            1 => (b"unreadable-symlink", tar::EntryType::Symlink, b""),
            2 => (
                b"escaping-symlink",
                tar::EntryType::Symlink,
                b"../outside.txt",
            ),
            3 => (b"unreadable-hardlink", tar::EntryType::Link, b""),
            4 => (
                b"escaping-hardlink",
                tar::EntryType::Link,
                b"../outside.txt",
            ),
            _ => (b"escape/blocked.txt", tar::EntryType::Regular, b""),
        };
        append_member(&mut bytes, path, kind, link, b"")?;
    }
    Ok(bytes)
}

fn gzip(mut tar: Vec<u8>, compression: Compression, padding: usize) -> io::Result<Vec<u8>> {
    tar.extend_from_slice(&[0; 1024]);
    tar.resize(tar.len() + padding, 0);
    let mut encoder = GzEncoder::new(Vec::new(), compression);
    encoder.write_all(&tar)?;
    encoder.finish()
}

fn successful_archive(skips: usize) -> io::Result<Vec<u8>> {
    let mut tar = tar_with_skips(skips)?;
    append_file(&mut tar, b"after.txt", b"accepted after")?;
    gzip(tar, Compression::fast(), 0)
}

fn stage_archive(
    fixture: &BinaryLoggingFixture,
    name: &str,
    bytes: &[u8],
) -> io::Result<(PathBuf, String)> {
    let outside = fixture.dir.path().join("outside");
    std::fs::create_dir_all(&outside)?;
    std::fs::write(outside.join("sentinel.txt"), b"outside sentinel")?;
    std::fs::write(fixture.dir.path().join("outside.txt"), b"outside sentinel")?;
    let mount = fixture.dir.path().join(name);
    std::fs::create_dir(&mount)?;
    std::os::unix::fs::symlink(&outside, mount.join("escape"))?;
    let staged = fixture.dir.path().join(format!("{name}.tar.gz"));
    std::fs::write(&staged, bytes)?;
    Ok((mount, format!("file://{}", staged.display())))
}

fn apply(fixture: &BinaryLoggingFixture, mount: &Path, url: &str) -> io::Result<Output> {
    fixture.run_manifest_stdin(
        &serde_json::to_vec(&json!({"storageMounts": [{
            "mountPath": mount, "archiveUrl": url
        }]}))
        .map_err(io::Error::other)?,
    )
}

fn diagnostics(log: &str) -> Vec<&str> {
    log.lines()
        .filter(|line| {
            line.contains("] [WARN] [sandbox:guest-storage-apply] ")
                && (line.contains("Skipping ") || line.contains(SUMMARY))
        })
        .collect()
}

fn matching_sink_diagnostics(
    fixture: &BinaryLoggingFixture,
    output: &Output,
) -> io::Result<Vec<String>> {
    let system_log = fixture.read_system_log()?;
    let stderr = std::str::from_utf8(&output.stderr).map_err(io::Error::other)?;
    let mut lines = diagnostics(&system_log);
    let mut stderr_lines = diagnostics(stderr);
    // The shared file and stderr have separate locks; concurrent workers can
    // interleave complete records differently in the two sinks.
    lines.sort_unstable();
    stderr_lines.sort_unstable();
    assert_eq!(lines, stderr_lines, "actual sinks disagree");
    assert!(lines.iter().all(|line| line.len() < LINE_BYTES));
    Ok(lines.into_iter().map(str::to_owned).collect())
}

fn assert_attempt_diagnostics(lines: &[String], mount: &Path, skips: usize) {
    let attribution = format!(" (archive target: {})", mount.display());
    let samples: Vec<_> = lines
        .iter()
        .filter(|line| line.ends_with(&attribution))
        .collect();
    assert_eq!(samples.len(), skips.min(SAMPLE_LIMIT));
    let summary_prefix = format!("{SUMMARY}{}: ", mount.display());
    let summaries: Vec<_> = lines
        .iter()
        .filter(|line| line.contains(&summary_prefix))
        .collect();
    assert_eq!(summaries.len(), usize::from(skips != 0));
    if let Some(summary) = summaries.first() {
        assert!(summary.ends_with(&format!(
            "skipped={skips}, suppressed={}",
            skips.saturating_sub(SAMPLE_LIMIT)
        )));
    }
}

fn assert_outside_unchanged(fixture: &BinaryLoggingFixture, mount: &Path) -> io::Result<()> {
    assert_eq!(
        std::fs::read(fixture.dir.path().join("outside.txt"))?,
        b"outside sentinel"
    );
    let outside = fixture.dir.path().join("outside");
    assert_eq!(
        std::fs::read(outside.join("sentinel.txt"))?,
        b"outside sentinel"
    );
    assert_eq!(std::fs::read_dir(&outside)?.count(), 1);
    assert_eq!(std::fs::read_link(mount.join("escape"))?, outside);
    Ok(())
}

#[test]
fn bounded_skipped_entry_examples_and_summaries_preserve_extraction() -> io::Result<()> {
    for skips in [4096, 0, 31, 32, 33, 32768] {
        let fixture = BinaryLoggingFixture::new("skipped-entry-budget")?;
        let (mount, url) = stage_archive(&fixture, "mount", &successful_archive(skips)?)?;
        let output = apply(&fixture, &mount, &url)?;
        assert!(output.status.success());
        let lines = matching_sink_diagnostics(&fixture, &output)?;
        assert_eq!(
            lines.len(),
            skips.min(SAMPLE_LIMIT) + usize::from(skips != 0)
        );
        assert_attempt_diagnostics(&lines, &mount, skips);
        assert!(lines.iter().map(|line| line.len() + 1).sum::<usize>() <= 33 * LINE_BYTES);
        if skips >= 6 {
            for reason in REASONS {
                assert!(lines.iter().any(|line| line.contains(reason)), "{reason}");
            }
        }
        assert_eq!(std::fs::read(mount.join("before.txt"))?, b"accepted before");
        assert_eq!(std::fs::read(mount.join("after.txt"))?, b"accepted after");
        assert_eq!(std::fs::read_dir(&mount)?.count(), 3);
        assert_outside_unchanged(&fixture, &mount)?;
    }
    Ok(())
}

fn append_pax(bytes: &mut Vec<u8>, key: &str, value: &str) -> io::Result<()> {
    let suffix = format!(" {key}={value}\n");
    let mut size = suffix.len() + 1;
    loop {
        let next = suffix.len() + size.to_string().len();
        if size == next {
            break;
        }
        size = next;
    }
    append_member(
        bytes,
        b"pax",
        tar::EntryType::XHeader,
        b"",
        format!("{size}{suffix}").as_bytes(),
    )
}

#[test]
fn skipped_entry_metadata_is_byte_bounded_and_cannot_inject_records() -> io::Result<()> {
    let fixture = BinaryLoggingFixture::new("skipped-entry-rendering")?;
    let mut tar = tar_with_skips(0)?;
    let long = format!("../{}", "界".repeat(4096));
    let mut gnu_long = long.as_bytes().to_vec();
    gnu_long.push(0);
    for (kind, member_kind) in [
        (tar::EntryType::GNULongName, tar::EntryType::Regular),
        (tar::EntryType::GNULongLink, tar::EntryType::Symlink),
        (tar::EntryType::GNULongLink, tar::EntryType::Link),
    ] {
        append_member(&mut tar, b"extension", kind, b"", &gnu_long)?;
        append_member(&mut tar, b"placeholder", member_kind, b"", b"")?;
    }
    for (key, kind) in [
        ("path", tar::EntryType::Regular),
        ("linkpath", tar::EntryType::Symlink),
        ("linkpath", tar::EntryType::Link),
    ] {
        append_pax(&mut tar, key, &long)?;
        append_member(&mut tar, b"placeholder", kind, b"", b"")?;
    }
    let long_controls = format!("../{}\0", "\n".repeat(4096));
    append_member(
        &mut tar,
        b"extension",
        tar::EntryType::GNULongName,
        b"",
        long_controls.as_bytes(),
    )?;
    append_file(&mut tar, b"placeholder", b"")?;
    append_file(&mut tar, b"../line\n\r\t\x1b-quote\"-slash\\", b"")?;
    append_file(&mut tar, b"../invalid-\xff-name", b"")?;
    append_file(&mut tar, b"after.txt", b"accepted after")?;
    let (mount, url) = stage_archive(&fixture, "mount", &gzip(tar, Compression::fast(), 0)?)?;
    let output = apply(&fixture, &mount, &url)?;
    assert!(output.status.success());
    let lines = matching_sink_diagnostics(&fixture, &output)?;
    assert_eq!(lines.len(), 10);
    assert_attempt_diagnostics(&lines, &mount, 9);
    let attribution = format!(" (archive target: {})", mount.display());
    let samples: Vec<_> = lines
        .iter()
        .filter_map(|line| line.strip_suffix(&attribution))
        .collect();
    for line in &samples {
        let (_, paths) = line
            .split_once("dir: ")
            .ok_or_else(|| io::Error::other("missing sample reason"))?;
        for path in paths.split(" -> ") {
            assert!(path.len() <= PATH_BYTES);
        }
    }
    assert_eq!(
        samples.iter().filter(|line| line.ends_with("...")).count(),
        7
    );
    assert!(
        samples
            .iter()
            .any(|line| line.contains("line\\n\\r\\t\\u{1b}"))
    );
    assert!(
        samples
            .iter()
            .any(|line| line.contains("quote\\\"-slash\\\\"))
    );
    assert!(
        samples
            .iter()
            .any(|line| line.contains("invalid-\u{fffd}-name"))
    );
    assert_eq!(std::fs::read(mount.join("after.txt"))?, b"accepted after");
    assert_outside_unchanged(&fixture, &mount)?;
    Ok(())
}

#[test]
fn skipped_entry_archive_target_attribution_is_also_byte_bounded() -> io::Result<()> {
    let fixture = BinaryLoggingFixture::new("skipped-entry-long-target")?;
    let parent = fixture
        .dir
        .path()
        .join(format!("parent\n{}", "a".repeat(120)))
        .join("b".repeat(120))
        .join("c".repeat(120));
    let mount = parent.join("mount");
    std::fs::create_dir_all(&mount)?;
    assert!(mount.as_os_str().len() > PATH_BYTES);
    let sentinel = parent.join("outside.txt");
    std::fs::write(&sentinel, b"outside sentinel")?;
    let mut tar = Vec::new();
    append_file(&mut tar, b"../outside.txt", b"")?;
    append_file(&mut tar, b"after.txt", b"accepted after")?;
    let archive = fixture.dir.path().join("archive.tar.gz");
    std::fs::write(&archive, gzip(tar, Compression::fast(), 0)?)?;
    let output = apply(&fixture, &mount, &format!("file://{}", archive.display()))?;
    assert!(output.status.success());
    let lines = matching_sink_diagnostics(&fixture, &output)?;
    assert_eq!(lines.len(), 2);
    for line in &lines {
        let target = if let Some((_, target)) = line.split_once(" (archive target: ") {
            target
                .strip_suffix(')')
                .ok_or_else(|| io::Error::other("missing target delimiter"))?
        } else {
            line.split_once(SUMMARY)
                .and_then(|(_, summary)| summary.strip_suffix(": skipped=1, suppressed=0"))
                .ok_or_else(|| io::Error::other("missing summary target"))?
        };
        assert!(target.len() <= PATH_BYTES);
        assert!(target.ends_with("..."));
        assert!(target.contains("parent\\n"));
    }
    assert_eq!(std::fs::read(sentinel)?, b"outside sentinel");
    assert_eq!(std::fs::read(mount.join("after.txt"))?, b"accepted after");
    Ok(())
}

#[test]
fn skipped_entry_summary_survives_first_unpack_error() -> io::Result<()> {
    let fixture = BinaryLoggingFixture::new("skipped-entry-unpack-error")?;
    let mut tar = tar_with_skips(40)?;
    append_file(&mut tar, b"blocker", b"accepted blocker")?;
    append_file(&mut tar, b"blocker/child", b"cannot extract below a file")?;
    append_file(&mut tar, b"after.txt", b"must not extract")?;
    let (mount, url) = stage_archive(&fixture, "mount", &gzip(tar, Compression::fast(), 0)?)?;
    let output = apply(&fixture, &mount, &url)?;
    assert!(!output.status.success());
    let lines = matching_sink_diagnostics(&fixture, &output)?;
    assert_eq!(lines.len(), 33);
    assert_attempt_diagnostics(&lines, &mount, 40);
    assert_eq!(std::fs::read(mount.join("before.txt"))?, b"accepted before");
    assert_eq!(std::fs::read(mount.join("blocker"))?, b"accepted blocker");
    assert!(!mount.join("after.txt").exists());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("Failed to extract entry blocker/child")
    );
    assert_outside_unchanged(&fixture, &mount)?;
    Ok(())
}

#[test]
fn skipped_entry_summary_does_not_hide_late_gzip_failure() -> io::Result<()> {
    let fixture = BinaryLoggingFixture::new("skipped-entry-gzip-error")?;
    let mut tar = tar_with_skips(40)?;
    append_file(&mut tar, b"after.txt", b"accepted after")?;
    // Keep the corrupt trailer beyond decoder read-ahead until the existing
    // post-tar drain, so this also exercises the summary on that error exit.
    let mut archive = gzip(tar, Compression::none(), 64 * 1024)?;
    let crc_offset = archive.len() - 8;
    archive[crc_offset] ^= 1;
    let (mount, url) = stage_archive(&fixture, "mount", &archive)?;
    let output = apply(&fixture, &mount, &url)?;
    assert!(!output.status.success());
    let lines = matching_sink_diagnostics(&fixture, &output)?;
    assert_eq!(lines.len(), 33);
    assert_attempt_diagnostics(&lines, &mount, 40);
    assert_eq!(std::fs::read(mount.join("before.txt"))?, b"accepted before");
    assert_eq!(std::fs::read(mount.join("after.txt"))?, b"accepted after");
    assert!(String::from_utf8_lossy(&output.stderr).contains("Failed to finish gzip archive"));
    assert_outside_unchanged(&fixture, &mount)?;
    Ok(())
}

#[test]
fn independent_archive_workers_each_receive_a_fresh_diagnostic_budget() -> io::Result<()> {
    let fixture = BinaryLoggingFixture::new("skipped-entry-independent-workers")?;
    let mut mounts = Vec::new();
    let mut entries = Vec::new();
    for (index, skips) in [80, 44, 5].into_iter().enumerate() {
        let (mount, url) = stage_archive(
            &fixture,
            &format!("mount-{index}"),
            &successful_archive(skips)?,
        )?;
        entries.push(json!({"mountPath": mount, "archiveUrl": url}));
        mounts.push((mount, skips));
    }
    let output = fixture.run_manifest_stdin(
        &serde_json::to_vec(&json!({"storageMounts": entries})).map_err(io::Error::other)?,
    )?;
    assert!(output.status.success());
    let lines = matching_sink_diagnostics(&fixture, &output)?;
    assert_eq!(lines.len(), 32 + 32 + 5 + 3);
    for (mount, skips) in mounts {
        assert_attempt_diagnostics(&lines, &mount, skips);
        assert_eq!(std::fs::read(mount.join("after.txt"))?, b"accepted after");
        assert_outside_unchanged(&fixture, &mount)?;
    }
    Ok(())
}
