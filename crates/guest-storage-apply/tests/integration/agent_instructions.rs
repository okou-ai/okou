use guest_contracts::agent_instructions::{
    InstructionApplication, InstructionCheck, SOURCE_FILENAME, instruction_paths,
};
use guest_storage_apply::{apply_agent_instructions, check_agent_instructions, run_manifest_bytes};
use std::{fs, io, path::Path};

fn stage(home: &Path, framework: &str, content: &[u8]) -> io::Result<std::path::PathBuf> {
    let staging = instruction_paths(home, framework)
        .ok_or_else(|| io::Error::other("Unsupported fixture framework"))?
        .staging;
    fs::create_dir_all(&staging)?;
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut tar = tar::Builder::new(encoder);
    let mut header = tar::Header::new_gnu();
    header.set_mode(0o600);
    header.set_size(content.len() as u64);
    header.set_cksum();
    tar.append_data(&mut header, SOURCE_FILENAME, content)?;
    let archive = tar.into_inner()?.finish()?;
    let source = home.join("input.tar.gz");
    fs::write(&source, archive)?;
    let manifest = serde_json::to_vec(&serde_json::json!({
        "storageMounts": [{
            "mountPath": staging,
            "archiveUrl": format!("file://{}", source.display()),
        }],
    }))
    .map_err(io::Error::other)?;
    if !run_manifest_bytes(&manifest) {
        return Err(io::Error::other("Instruction Storage staging failed"));
    }
    Ok(staging)
}

fn metadata(framework: &str) -> serde_json::Result<Vec<u8>> {
    serde_json::to_vec(&InstructionApplication {
        framework: framework.into(),
    })
}

#[test]
fn storage_delivered_instructions_replace_exact_bytes_and_preserve_native_history() {
    for (framework, root, filename) in [
        ("claude-code", ".claude", "CLAUDE.md"),
        ("codex", ".codex", "AGENTS.md"),
        ("pi", ".pi/agent", "AGENTS.md"),
    ] {
        let home = tempfile::tempdir().unwrap();
        let target = home.path().join(root);
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("native-history"), b"preserved").unwrap();
        for content in ["\u{feff} raw\r\n目录 🦉\n".as_bytes(), b""] {
            fs::write(target.join(filename), b"local edit").unwrap();
            let staging = stage(home.path(), framework, content).unwrap();
            assert!(apply_agent_instructions(
                home.path(),
                &metadata(framework).unwrap()
            ));
            assert_eq!(fs::read(target.join(filename)).unwrap(), content);
            assert_eq!(
                fs::read(target.join("native-history")).unwrap(),
                b"preserved"
            );
            assert!(!staging.exists());
        }
    }
}

#[test]
fn unsafe_or_missing_instruction_source_preserves_the_current_managed_file() {
    for kind in ["missing", "directory", "symlink"] {
        let home = tempfile::tempdir().unwrap();
        let staging = instruction_paths(home.path(), "codex").unwrap().staging;
        fs::create_dir_all(&staging).unwrap();
        let target = home.path().join(".codex/AGENTS.md");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"current instructions").unwrap();
        let source = staging.join(SOURCE_FILENAME);
        if kind == "directory" {
            fs::create_dir(&source).unwrap();
        } else if kind == "symlink" {
            let external = home.path().join("external");
            fs::write(&external, b"external").unwrap();
            std::os::unix::fs::symlink(external, &source).unwrap();
        }
        assert!(!apply_agent_instructions(
            home.path(),
            &metadata("codex").unwrap()
        ));
        assert_eq!(fs::read(target).unwrap(), b"current instructions");
    }
}

#[test]
fn instruction_application_refuses_symlinked_framework_parents() {
    let home = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("AGENTS.md"), b"external").unwrap();
    std::os::unix::fs::symlink(outside.path(), home.path().join(".codex")).unwrap();
    stage(home.path(), "codex", b"replacement").unwrap();
    assert!(!apply_agent_instructions(
        home.path(),
        &metadata("codex").unwrap()
    ));
    assert_eq!(
        fs::read(outside.path().join("AGENTS.md")).unwrap(),
        b"external"
    );
}

#[test]
fn instruction_presence_checks_preserve_local_files_and_do_not_create_missing_paths() {
    for framework in ["claude-code", "codex", "pi"] {
        let home = tempfile::tempdir().unwrap();
        let paths = instruction_paths(home.path(), framework).unwrap();
        let input = metadata(framework).unwrap();
        assert!(!check_agent_instructions(home.path(), &input).unwrap());
        assert!(!paths.target.parent().unwrap().exists());
        fs::create_dir_all(paths.target.parent().unwrap()).unwrap();
        fs::write(&paths.target, b"local edit").unwrap();
        let before = fs::metadata(&paths.target).unwrap().modified().unwrap();
        assert!(check_agent_instructions(home.path(), &input).unwrap());
        assert_eq!(fs::read(&paths.target).unwrap(), b"local edit");
        assert_eq!(
            fs::metadata(&paths.target).unwrap().modified().unwrap(),
            before
        );
        assert!(!paths.staging.exists());
        fs::remove_file(&paths.target).unwrap();
        assert!(!check_agent_instructions(home.path(), &input).unwrap());
    }
}

#[test]
fn instruction_presence_checks_reject_unsafe_targets() {
    for kind in ["parent-symlink", "file-symlink", "directory"] {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let paths = instruction_paths(home.path(), "codex").unwrap();
        fs::write(outside.path().join("AGENTS.md"), b"outside").unwrap();
        if kind == "parent-symlink" {
            std::os::unix::fs::symlink(outside.path(), home.path().join(".codex")).unwrap();
        } else {
            fs::create_dir_all(paths.target.parent().unwrap()).unwrap();
            if kind == "file-symlink" {
                std::os::unix::fs::symlink(outside.path().join("AGENTS.md"), &paths.target)
                    .unwrap();
            } else {
                fs::create_dir(&paths.target).unwrap();
            }
        }
        assert!(check_agent_instructions(home.path(), &metadata("codex").unwrap()).is_err());
        assert_eq!(
            fs::read(outside.path().join("AGENTS.md")).unwrap(),
            b"outside"
        );
    }
}

#[test]
fn instruction_presence_checks_resolve_preserved_mount_aliases_without_writes() {
    let home = tempfile::tempdir().unwrap();
    let paths = instruction_paths(home.path(), "codex").unwrap();
    fs::create_dir_all(paths.target.parent().unwrap()).unwrap();
    fs::write(&paths.target, b"local instruction edit").unwrap();
    let alias = home.path().join("settings-alias");
    std::os::unix::fs::symlink(paths.target.parent().unwrap(), &alias).unwrap();
    for (mount, reusable) in [
        (alias.to_str().unwrap().to_owned(), false),
        ("settings-alias".to_owned(), false),
        ("unrelated/missing/child".to_owned(), true),
    ] {
        let input = serde_json::to_vec(&InstructionCheck {
            framework: "codex".into(),
            preserved_download_mounts: vec![mount],
        })
        .unwrap();
        assert_eq!(
            check_agent_instructions(home.path(), &input).unwrap(),
            reusable
        );
        assert_eq!(fs::read(&paths.target).unwrap(), b"local instruction edit");
        assert!(!home.path().join("unrelated").exists());
        assert!(!paths.staging.exists());
    }
}
