use crate::binary_logging::BinaryLoggingFixture;
use crate::process::CommandExecution;
use crate::support::create_tar_gz;
use guest_contracts::storage_files::{self, StorageFile};
use serde_json::json;
use std::fs;
use std::os::unix::fs::symlink;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::process::CommandExt;

#[test]
fn input_permission_failures_exit_nonzero_without_removing_existing_inputs() {
    for phase in ["stale-cleanup", "cleanup", "normalize", "write"] {
        let fixture = BinaryLoggingFixture::new("instruction-permission-failure").unwrap();
        let home = fixture.dir.path().join(".codex");
        let stage = fixture.dir.path().join("storage-instructions/0");
        let archive = fixture.dir.path().join("instructions.tar.gz");
        fs::set_permissions(fixture.dir.path(), fs::Permissions::from_mode(0o777)).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("AGENTS.md"), b"existing instructions").unwrap();
        fs::write(home.join("CLAUDE.md"), b"alternate instructions").unwrap();
        fs::write(
            &archive,
            create_tar_gz(&[("AGENTS.md", b"current instructions")]).unwrap(),
        )
        .unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o555)).unwrap();
        let entry = match phase {
            "write" => json!({
                "mountPath": home,
                "extractPath": stage,
                "archiveUrl": format!("file://{}", archive.display()),
                "instructionsTargetFilename": "AGENTS.md"
            }),
            _ => {
                json!({"mountPath": home, "cached": true, "instructionsTargetFilename": "AGENTS.md"})
            }
        };
        let manifest = serde_json::to_vec(&json!({
            "storageMounts": if phase == "stale-cleanup" { vec![] } else { vec![entry] },
            "cleanupPaths": if phase == "stale-cleanup" { vec![home.clone()] } else { vec![] },
            "instructionCleanups": if phase == "cleanup" {
                vec![json!({"mountPath": home, "targetFilename": "AGENTS.md"})]
            } else { vec![] }
        }))
        .unwrap();
        let mut command = fixture.command();
        command.arg("--manifest-stdin");
        // Root can write through mode bits, so use an unprivileged child when
        // the test process owns the fixture as root. Other users test directly.
        if fs::metadata(fixture.dir.path()).unwrap().uid() == 0 {
            command.uid(65534);
        }
        let output = CommandExecution::spawn(&mut command, Some(&manifest))
            .unwrap()
            .wait()
            .unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            output.status.code(),
            Some(1),
            "{phase}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read(home.join("AGENTS.md")).unwrap(),
            b"existing instructions",
            "{phase}"
        );
        assert_eq!(
            fs::read(home.join("CLAUDE.md")).unwrap(),
            b"alternate instructions",
            "{phase}"
        );
        assert!(!stage.exists(), "{phase}");
    }
}

#[test]
fn staged_instruction_write_failure_exits_nonzero_and_stops_normalization() {
    let fixture = BinaryLoggingFixture::new("instruction-write-failure").unwrap();
    let home = fixture.dir.path().join(".codex");
    let later_home = fixture.dir.path().join("later-home");
    let stage = fixture.dir.path().join("storage-instructions/0");
    let archive = fixture.dir.path().join("instructions.tar.gz");
    fs::create_dir_all(home.join("AGENTS.md")).unwrap();
    fs::create_dir_all(home.join("sessions")).unwrap();
    fs::write(home.join("sessions/history.jsonl"), b"native history").unwrap();
    fs::create_dir_all(&later_home).unwrap();
    fs::write(later_home.join("CLAUDE.md"), b"later instructions").unwrap();
    fs::write(
        &archive,
        create_tar_gz(&[("AGENTS.md", b"current instructions")]).unwrap(),
    )
    .unwrap();
    let manifest = json!({
        "storageMounts": [
            {
                "mountPath": home,
                "extractPath": stage,
                "archiveUrl": format!("file://{}", archive.display()),
                "instructionsTargetFilename": "AGENTS.md"
            },
            {
                "mountPath": later_home,
                "cached": true,
                "instructionsTargetFilename": "AGENTS.md"
            }
        ]
    });

    let output = fixture
        .run_manifest_stdin(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert!(home.join("AGENTS.md").is_dir());
    assert_eq!(
        fs::read(home.join("sessions/history.jsonl")).unwrap(),
        b"native history"
    );
    assert!(!stage.exists());
    assert!(!later_home.join("AGENTS.md").exists());
    assert_eq!(
        fs::read(later_home.join("CLAUDE.md")).unwrap(),
        b"later instructions"
    );
}

#[test]
fn missing_cached_instructions_exit_nonzero() {
    let fixture = BinaryLoggingFixture::new("cached-instruction-missing").unwrap();
    let home = fixture.dir.path().join(".codex");
    fs::create_dir_all(&home).unwrap();
    let manifest = json!({
        "storageMounts": [{
            "mountPath": home,
            "cached": true,
            "instructionsTargetFilename": "AGENTS.md"
        }]
    });

    let output = fixture
        .run_manifest_stdin(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert!(!home.join("AGENTS.md").exists());
}

#[test]
fn instruction_cleanup_failure_stops_before_download() {
    let fixture = BinaryLoggingFixture::new("instruction-cleanup-failure").unwrap();
    let home = fixture.dir.path().join(".codex");
    let target = fixture.dir.path().join("skill");
    let archive = fixture.dir.path().join("skill.tar.gz");
    fs::create_dir_all(home.join("AGENTS.md")).unwrap();
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("SKILL.md"), b"old skill").unwrap();
    fs::write(
        &archive,
        create_tar_gz(&[("SKILL.md", b"new skill")]).unwrap(),
    )
    .unwrap();
    let manifest = json!({
        "storageMounts": [{"mountPath": target, "archiveUrl": format!("file://{}", archive.display())}],
        "instructionCleanups": [{"mountPath": home, "targetFilename": "AGENTS.md"}]
    });

    let output = fixture
        .run_manifest_stdin(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert!(home.join("AGENTS.md").is_dir());
    assert_eq!(fs::read(target.join("SKILL.md")).unwrap(), b"old skill");
}

#[test]
fn stale_path_cleanup_failure_stops_before_later_cleanup_and_download() {
    let fixture = BinaryLoggingFixture::new("stale-path-cleanup-failure").unwrap();
    let alias = fixture.dir.path().join("alias");
    let outside = fixture.dir.path().join("outside");
    let later = fixture.dir.path().join("later/nested");
    let skill = fixture.dir.path().join("skill");
    let archive = fixture.dir.path().join("skill.tar.gz");
    fs::create_dir_all(outside.join("stale")).unwrap();
    fs::write(outside.join("stale/content"), b"outside content").unwrap();
    fs::create_dir_all(&later).unwrap();
    fs::write(later.join("content"), b"later content").unwrap();
    symlink(&outside, &alias).unwrap();
    fs::write(
        &archive,
        create_tar_gz(&[("SKILL.md", b"current skill")]).unwrap(),
    )
    .unwrap();
    let manifest = json!({
        "storageMounts": [{"mountPath": skill, "archiveUrl": format!("file://{}", archive.display())}],
        "cleanupPaths": [alias.join("stale"), later]
    });

    let manifest = serde_json::to_vec(&manifest).unwrap();
    for decoded in [false, true] {
        let output = if decoded {
            let files = [StorageFile {
                path: "SKILL.md".into(),
                content: b"current skill".to_vec(),
                mode: 0o644,
                mtime: 0,
            }];
            let input =
                storage_files::encode_input(&manifest, &[(skill.to_str().unwrap(), &files)])
                    .unwrap();
            CommandExecution::spawn(fixture.command().arg("--storage-files-stdin"), Some(&input))
                .unwrap()
                .wait()
                .unwrap()
        } else {
            fixture.run_manifest_stdin(&manifest).unwrap()
        };

        assert_eq!(output.status.code(), Some(1));
        assert_eq!(
            fs::read(outside.join("stale/content")).unwrap(),
            b"outside content"
        );
        assert_eq!(fs::read(later.join("content")).unwrap(), b"later content");
        assert!(!skill.exists());
    }
}
