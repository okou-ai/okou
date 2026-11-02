use guest_contracts::agent_instructions::{InstructionApplication, SOURCE_FILENAME, STORAGE_DIR};
use guest_storage_apply::{apply_agent_instructions, run_manifest_bytes};
use std::{fs, io, path::Path};

fn stage(home: &Path, content: &[u8]) -> io::Result<std::path::PathBuf> {
    let runtime = home.join("private-run");
    fs::create_dir_all(&runtime)?;
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
            "mountPath": runtime.join(STORAGE_DIR),
            "archiveUrl": format!("file://{}", source.display()),
        }],
    }))
    .map_err(io::Error::other)?;
    if !run_manifest_bytes(&manifest) {
        return Err(io::Error::other("Instruction Storage staging failed"));
    }
    Ok(runtime)
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
            let runtime = stage(home.path(), content).unwrap();
            assert!(apply_agent_instructions(
                home.path(),
                &runtime,
                &metadata(framework).unwrap()
            ));
            assert_eq!(fs::read(target.join(filename)).unwrap(), content);
            assert_eq!(
                fs::read(target.join("native-history")).unwrap(),
                b"preserved"
            );
            assert!(!runtime.join(STORAGE_DIR).exists());
        }
    }
}

#[test]
fn unsafe_or_missing_instruction_source_preserves_the_current_managed_file() {
    for kind in ["missing", "directory", "symlink"] {
        let home = tempfile::tempdir().unwrap();
        let runtime = home.path().join("private-run");
        let staging = runtime.join(STORAGE_DIR);
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
            &runtime,
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
    let runtime = stage(home.path(), b"replacement").unwrap();
    assert!(!apply_agent_instructions(
        home.path(),
        &runtime,
        &metadata("codex").unwrap()
    ));
    assert_eq!(
        fs::read(outside.path().join("AGENTS.md")).unwrap(),
        b"external"
    );
}
