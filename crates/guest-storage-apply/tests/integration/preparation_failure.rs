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
    for phase in ["stale-cleanup", "instruction-cleanup", "write"] {
        let fixture = BinaryLoggingFixture::new("storage-permission-failure").unwrap();
        let home = fixture.dir.path().join("data");
        let archive = fixture.dir.path().join("data.tar.gz");
        fs::set_permissions(fixture.dir.path(), fs::Permissions::from_mode(0o777)).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("AGENTS.md"), b"existing instructions").unwrap();
        fs::write(home.join("CLAUDE.md"), b"alternate instructions").unwrap();
        fs::write(
            &archive,
            create_tar_gz(&[("new-data.txt", b"current data")]).unwrap(),
        )
        .unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o555)).unwrap();
        let entry =
            json!({"mountPath": home, "archiveUrl": format!("file://{}", archive.display())});
        let manifest = serde_json::to_vec(&json!({
            "storageMounts": if phase == "write" { vec![entry] } else { vec![] },
            "cleanupPaths": if phase == "stale-cleanup" { vec![home.clone()] } else { vec![] },
            "instructionCleanups": if phase == "instruction-cleanup" { vec![json!({"mountPath": home})] } else { vec![] }
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
    }
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
