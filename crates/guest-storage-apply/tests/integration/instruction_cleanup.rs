use crate::binary_logging::BinaryLoggingFixture;
use crate::process::CommandExecution;
use crate::support::create_tar_gz;
use serde_json::json;
use std::fs;
use std::os::unix::fs::symlink;
use std::os::unix::net::UnixListener;

#[test]
fn instruction_cleanup_rejects_symlinked_pi_parent_before_later_work() {
    for instruction_only in [false, true] {
        let fixture = BinaryLoggingFixture::new("instruction-cleanup-pi-parent").unwrap();
        let alias = fixture.dir.path().join(".pi");
        let outside = fixture.dir.path().join("outside");
        let target = outside.join("agent");
        let later = fixture.dir.path().join("later");
        let download = fixture.dir.path().join("download");
        let archive = fixture.dir.path().join("skill.tar.gz");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&later).unwrap();
        fs::write(target.join("CLAUDE.md"), b"outside claude").unwrap();
        fs::write(target.join("AGENTS.md"), b"outside agents").unwrap();
        fs::write(later.join("AGENTS.md"), b"later instructions").unwrap();
        fs::write(
            &archive,
            create_tar_gz(&[("SKILL.md", b"current skill")]).unwrap(),
        )
        .unwrap();
        symlink(&outside, &alias).unwrap();
        let mut instruction_cleanups = Vec::new();
        if instruction_only {
            instruction_cleanups.push(json!({"mountPath": alias.join("agent")}));
        }
        instruction_cleanups.push(json!({"mountPath": later}));
        let manifest = serde_json::to_vec(&json!({
            "storageMounts": [{
                "mountPath": download,
                "archiveUrl": format!("file://{}", archive.display())
            }],
            "cleanupPaths": if instruction_only { vec![] } else { vec![alias.join("agent")] },
            "instructionCleanups": instruction_cleanups
        }))
        .unwrap();

        let output = fixture.run_manifest_stdin(&manifest).unwrap();

        assert_eq!(
            output.status.code(),
            Some(1),
            "instruction_only={instruction_only}, target files: {:?}, {:?}",
            fs::read(target.join("CLAUDE.md")),
            fs::read(target.join("AGENTS.md"))
        );
        assert_eq!(
            fs::read(target.join("CLAUDE.md")).unwrap(),
            b"outside claude"
        );
        assert_eq!(
            fs::read(target.join("AGENTS.md")).unwrap(),
            b"outside agents"
        );
        assert!(
            fs::symlink_metadata(&alias)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::read(later.join("AGENTS.md")).unwrap(),
            b"later instructions"
        );
        assert!(!download.exists());
    }
}

#[test]
fn instruction_cleanup_preserves_pi_data_and_unlinks_only_selected_instruction_files() {
    let fixture = BinaryLoggingFixture::new("instruction-cleanup-pi-data").unwrap();
    let home = fixture.dir.path().join(".pi/agent");
    let missing = fixture.dir.path().join("missing/agent");
    let empty = fixture.dir.path().join("empty");
    let referent = fixture.dir.path().join("outside.md");
    let preserved = [
        ("settings.json", b"settings".as_slice()),
        ("sessions/history.jsonl", b"native history".as_slice()),
        ("skills/workflow/SKILL.md", b"skill".as_slice()),
        ("MEMORY.md", b"memory instructions".as_slice()),
        ("memory/notes.md", b"memory notes".as_slice()),
    ];
    for (relative, content) in preserved {
        let path = home.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    fs::create_dir(&empty).unwrap();
    fs::write(home.join("CLAUDE.md"), b"stale claude").unwrap();
    fs::write(&referent, b"outside instructions").unwrap();
    symlink(&referent, home.join("AGENTS.md")).unwrap();
    let manifest = serde_json::to_vec(&json!({
        "storageMounts": [],
        "instructionCleanups": [
            {"mountPath": missing},
            {"mountPath": empty},
            {"mountPath": home, "targetFilename": "CLAUDE.md"}
        ]
    }))
    .unwrap();

    assert!(
        fixture
            .run_manifest_stdin(&manifest)
            .unwrap()
            .status
            .success()
    );
    assert!(fs::symlink_metadata(home.join("CLAUDE.md")).is_err());
    assert!(
        fs::symlink_metadata(home.join("AGENTS.md"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    for (relative, content) in preserved {
        assert_eq!(fs::read(home.join(relative)).unwrap(), content);
    }
    assert_eq!(fs::read(&referent).unwrap(), b"outside instructions");
    assert!(!missing.exists());
    assert!(empty.is_dir());

    let manifest = serde_json::to_vec(&json!({
        "storageMounts": [],
        "instructionCleanups": [{"mountPath": home}]
    }))
    .unwrap();

    assert!(
        fixture
            .run_manifest_stdin(&manifest)
            .unwrap()
            .status
            .success()
    );
    assert!(fs::symlink_metadata(home.join("AGENTS.md")).is_err());
    assert_eq!(fs::read(&referent).unwrap(), b"outside instructions");
    for (relative, content) in preserved {
        assert_eq!(fs::read(home.join(relative)).unwrap(), content);
    }
}

#[test]
fn instruction_cleanup_rejects_non_file_leaves_without_removing_them() {
    let fixture = BinaryLoggingFixture::new("instruction-cleanup-non-files").unwrap();
    let directory_home = fixture.dir.path().join("directory-home");
    let socket_home = fixture.dir.path().join("socket-home");
    fs::create_dir_all(directory_home.join("AGENTS.md")).unwrap();
    fs::write(directory_home.join("AGENTS.md/keep"), b"directory content").unwrap();
    fs::create_dir_all(&socket_home).unwrap();
    let socket = UnixListener::bind(socket_home.join("AGENTS.md")).unwrap();
    for home in [&directory_home, &socket_home] {
        let manifest = serde_json::to_vec(&json!({
            "storageMounts": [],
            "instructionCleanups": [{"mountPath": home}]
        }))
        .unwrap();

        assert_eq!(
            fixture.run_manifest_stdin(&manifest).unwrap().status.code(),
            Some(1)
        );
    }

    assert_eq!(
        fs::read(directory_home.join("AGENTS.md/keep")).unwrap(),
        b"directory content"
    );
    assert!(socket_home.join("AGENTS.md").exists());
    drop(socket);
}

#[test]
fn instruction_cleanup_empty_mount_path_preserves_working_directory_files() {
    let fixture = BinaryLoggingFixture::new("instruction-cleanup-empty-path").unwrap();
    fs::write(fixture.dir.path().join("CLAUDE.md"), b"cwd claude").unwrap();
    fs::write(fixture.dir.path().join("AGENTS.md"), b"cwd agents").unwrap();
    let manifest = serde_json::to_vec(&json!({
        "storageMounts": [],
        "instructionCleanups": [{"mountPath": ""}]
    }))
    .unwrap();
    let mut command = fixture.command();
    command
        .current_dir(fixture.dir.path())
        .arg("--manifest-stdin");

    let output = CommandExecution::spawn(&mut command, Some(&manifest))
        .unwrap()
        .wait()
        .unwrap();

    assert!(output.status.success());
    assert_eq!(
        fs::read(fixture.dir.path().join("CLAUDE.md")).unwrap(),
        b"cwd claude"
    );
    assert_eq!(
        fs::read(fixture.dir.path().join("AGENTS.md")).unwrap(),
        b"cwd agents"
    );
}
