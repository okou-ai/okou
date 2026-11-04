use super::*;
use std::cell::Cell;
use std::io::{Read, Write};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

struct FailAfterPrefixReader<'a> {
    source: &'a mut fs::File,
    remaining: usize,
    bytes_read: &'a Cell<usize>,
}

impl Read for FailAfterPrefixReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            return Err(io::Error::other("injected read failure"));
        }
        let limit = self.remaining.min(buf.len());
        let count = self.source.read(&mut buf[..limit])?;
        self.remaining -= count;
        self.bytes_read.set(self.bytes_read.get() + count);
        Ok(count)
    }
}

struct FailAfterPrefixWriter<'a> {
    target: &'a mut fs::File,
    remaining: usize,
    bytes_written: &'a Cell<usize>,
}

impl Write for FailAfterPrefixWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            return Err(io::Error::other("injected write failure"));
        }
        let count = self.target.write(&buf[..self.remaining.min(buf.len())])?;
        self.remaining -= count;
        self.bytes_written.set(self.bytes_written.get() + count);
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.target.flush()
    }
}

fn assert_no_copy_temp_files(path: &Path) {
    assert!(fs::read_dir(path).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".vm0-copy-")
    }));
}

fn disable_system_log() {
    guest_telemetry::log::clear_system_log_file();
}

#[test]
fn copy_instruction_file_failure_keeps_existing_target() {
    disable_system_log();
    let dir = tempfile::tempdir().unwrap();
    let final_home = dir.path().join(".codex");
    fs::create_dir_all(&final_home).unwrap();
    fs::write(final_home.join("AGENTS.md"), "old instructions").unwrap();

    assert!(!copy_instruction_file(
        &dir.path().join("missing.md"),
        &final_home,
        InstructionFilename::Agents,
        "Copied instructions file",
    ));

    assert_eq!(
        fs::read_to_string(final_home.join("AGENTS.md")).unwrap(),
        "old instructions"
    );
    assert_eq!(fs::read_dir(&final_home).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn copy_instruction_file_write_failure_after_partial_copy_preserves_target() {
    disable_system_log();
    let dir = tempfile::tempdir().unwrap();
    let staged = dir.path().join("staged");
    let final_home = dir.path().join(".codex");
    fs::create_dir_all(&staged).unwrap();
    fs::create_dir_all(&final_home).unwrap();
    let source = staged.join("AGENTS.md");
    let target = final_home.join("AGENTS.md");
    fs::write(&source, "new instructions").unwrap();
    fs::write(&target, "old instructions").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
    let old_mode = fs::metadata(&target).unwrap().permissions().mode();
    let bytes_written = Cell::new(0);

    assert!(!copy_instruction_file_with(
        &source,
        &final_home,
        InstructionFilename::Agents,
        "Copied instructions file",
        |source, temp| {
            io::copy(
                source,
                &mut FailAfterPrefixWriter {
                    target: temp,
                    remaining: 4,
                    bytes_written: &bytes_written,
                },
            )
        },
    ));

    assert_eq!(bytes_written.get(), 4);
    assert_eq!(fs::read(&target).unwrap(), b"old instructions");
    assert_eq!(
        fs::metadata(&target).unwrap().permissions().mode(),
        old_mode
    );
    assert_no_copy_temp_files(&final_home);

    assert!(copy_instruction_file(
        &source,
        &final_home,
        InstructionFilename::Agents,
        "Copied instructions file",
    ));
    assert_eq!(fs::read(&target).unwrap(), b"new instructions");
    assert_no_copy_temp_files(&final_home);
}

#[test]
fn copy_instruction_file_read_failure_after_partial_copy_keeps_in_place_alternate() {
    disable_system_log();
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join(".codex");
    fs::create_dir_all(&mount).unwrap();
    let alternate = mount.join("CLAUDE.md");
    let target = mount.join("AGENTS.md");
    fs::write(&alternate, "alternate instructions").unwrap();
    let bytes_read = Cell::new(0);

    assert!(!copy_instruction_file_with(
        &alternate,
        &mount,
        InstructionFilename::Agents,
        "Normalized instructions file",
        |source, temp| {
            io::copy(
                &mut FailAfterPrefixReader {
                    source,
                    remaining: 4,
                    bytes_read: &bytes_read,
                },
                temp,
            )
        },
    ));

    assert_eq!(bytes_read.get(), 4);
    assert_eq!(fs::read(&alternate).unwrap(), b"alternate instructions");
    assert!(!target.exists());
    assert_no_copy_temp_files(&mount);

    assert!(copy_instruction_file(
        &alternate,
        &mount,
        InstructionFilename::Agents,
        "Normalized instructions file",
    ));
    assert_eq!(fs::read(&target).unwrap(), b"alternate instructions");
    assert!(!alternate.exists());
    assert_no_copy_temp_files(&mount);
}
#[test]
fn cleanup_instruction_files_removes_only_known_instruction_files() {
    disable_system_log();
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join(".codex");
    fs::create_dir_all(mount.join("skills").join("workflow")).unwrap();
    fs::write(mount.join("CLAUDE.md"), "old").unwrap();
    fs::write(mount.join("AGENTS.md"), "old").unwrap();
    fs::write(mount.join("settings.json"), "{}").unwrap();
    fs::write(
        mount.join("skills").join("workflow").join("SKILL.md"),
        "skill",
    )
    .unwrap();

    assert!(cleanup_instruction_files(&[InstructionCleanup::new(
        mount.to_string_lossy().into(),
        None,
    )]));

    assert!(!mount.join("AGENTS.md").exists());
    assert!(!mount.join("CLAUDE.md").exists());
    assert_eq!(
        fs::read_to_string(mount.join("settings.json")).unwrap(),
        "{}"
    );
    assert_eq!(
        fs::read_to_string(mount.join("skills").join("workflow").join("SKILL.md")).unwrap(),
        "skill"
    );
}
#[cfg(unix)]
#[test]
fn cleanup_instruction_files_removes_instruction_symlink_without_following_it() {
    disable_system_log();
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join(".codex");
    let linked_target = dir.path().join("outside.md");
    fs::create_dir_all(&mount).unwrap();
    fs::write(&linked_target, "outside").unwrap();
    std::os::unix::fs::symlink(&linked_target, mount.join("AGENTS.md")).unwrap();

    cleanup_instruction_files(&[InstructionCleanup::new(
        mount.to_string_lossy().into(),
        Some("AGENTS.md".into()),
    )]);

    assert!(mount.join("AGENTS.md").symlink_metadata().is_err());
    assert_eq!(fs::read_to_string(&linked_target).unwrap(), "outside");
}
#[cfg(unix)]
#[test]
fn cleanup_instruction_files_does_not_follow_home_symlink() {
    disable_system_log();
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join(".codex");
    let outside_home = dir.path().join("outside-home");
    fs::create_dir_all(&outside_home).unwrap();
    fs::write(outside_home.join("AGENTS.md"), "outside").unwrap();
    std::os::unix::fs::symlink(&outside_home, &mount).unwrap();

    cleanup_instruction_files(&[InstructionCleanup::new(
        mount.to_string_lossy().into(),
        None,
    )]);

    assert_eq!(
        fs::read_to_string(outside_home.join("AGENTS.md")).unwrap(),
        "outside"
    );
    assert!(mount.symlink_metadata().unwrap().file_type().is_symlink());
}
