use guest_contracts::content_bundle::{BundleApplication, BundleArchiveSource};
use guest_storage_apply::apply_content_bundle;
use sha2::{Digest, Sha256};
use std::{fs, io};

fn archive_bytes(files: &[(&str, &[u8])]) -> io::Result<Vec<u8>> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut tar = tar::Builder::new(encoder);
    for (path, content) in files {
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o600);
        header.set_size(content.len() as u64);
        header.set_cksum();
        tar.append_data(&mut header, path, *content)?;
    }
    tar.into_inner()?.finish()
}

fn stage_archive(runtime: &std::path::Path, bytes: &[u8]) -> io::Result<BundleArchiveSource> {
    let sha256 = hex::encode(Sha256::digest(bytes));
    let source = runtime.join(format!("bundle-{sha256}.tar.gz"));
    fs::write(&source, bytes)?;
    Ok(BundleArchiveSource {
        source: source
            .to_str()
            .ok_or_else(|| io::Error::other("fixture path is not UTF-8"))?
            .into(),
        sha256,
        archive_bytes: bytes.len() as u64,
    })
}

#[test]
fn bundles_restore_exact_instructions_and_replace_complete_skill_directories() {
    for (framework, root, filename) in [
        ("claude-code", ".claude", "CLAUDE.md"),
        ("codex", ".codex", "AGENTS.md"),
        ("pi", ".pi/agent", "AGENTS.md"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let runtime = home.join(".private-run");
        fs::create_dir(&runtime).unwrap();
        let target = home.join(root);
        fs::create_dir_all(target.join("skills/example/references")).unwrap();
        fs::write(target.join("native-history"), "preserved").unwrap();
        for content in [b"\xef\xbb\xbf raw\r\n".as_slice(), b""] {
            let bytes = archive_bytes(&[("instructions.md", content)]).unwrap();
            let input = BundleApplication::Instructions {
                framework: framework.into(),
                archive: stage_archive(&runtime, &bytes).unwrap(),
            };
            assert!(apply_content_bundle(
                home,
                &runtime,
                &serde_json::to_vec(&input).unwrap()
            ));
            assert_eq!(fs::read(target.join(filename)).unwrap(), content);
        }
        let mount = target.join("skills/example");
        fs::write(mount.join("references/removed"), "old attachment").unwrap();
        fs::write(mount.join("SKILL.md"), "agent modified this").unwrap();
        let attachment_path = format!("references/{0}/{0}/{0}/raw.bin", "目录".repeat(30));
        let bytes = archive_bytes(&[
            ("SKILL.md", b"new complete skill"),
            (&attachment_path, &[0, 255, 128, 1]),
        ])
        .unwrap();
        let input = BundleApplication::Skill {
            mount: mount.to_str().unwrap().into(),
            archive: stage_archive(&runtime, &bytes).unwrap(),
        };
        assert!(apply_content_bundle(
            home,
            &runtime,
            &serde_json::to_vec(&input).unwrap()
        ));
        assert_eq!(
            fs::read_to_string(mount.join("SKILL.md")).unwrap(),
            "new complete skill"
        );
        assert!(!mount.join("references/removed").exists());
        assert_eq!(
            fs::read(mount.join(attachment_path)).unwrap(),
            [0, 255, 128, 1]
        );
        assert_eq!(
            fs::read_to_string(target.join("native-history")).unwrap(),
            "preserved"
        );
    }
}

#[test]
fn bundle_application_refuses_symlinked_managed_parents_without_touching_external_files() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let outside = temp.path().join("outside");
    let runtime = home.join("private");
    fs::create_dir_all(&runtime).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("SKILL.md"), "external").unwrap();
    std::os::unix::fs::symlink(&outside, home.join(".codex")).unwrap();
    let bytes = archive_bytes(&[("SKILL.md", b"untrusted")]).unwrap();
    let input = BundleApplication::Skill {
        mount: home.join(".codex/skills/example").to_str().unwrap().into(),
        archive: stage_archive(&runtime, &bytes).unwrap(),
    };
    assert!(!apply_content_bundle(
        &home,
        &runtime,
        &serde_json::to_vec(&input).unwrap()
    ));
    assert_eq!(
        fs::read_to_string(outside.join("SKILL.md")).unwrap(),
        "external"
    );
}

#[test]
fn complete_archive_installs_501_long_paths_with_bounded_control_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let runtime = home.join("private");
    fs::create_dir(&runtime).unwrap();
    let paths = (0..500)
        .map(|index| format!("references/{0}/{0}/{0}/{index:03}.bin", "目录".repeat(30)))
        .collect::<Vec<_>>();
    let mut files = vec![("SKILL.md", b"complete skill".as_slice())];
    files.extend(
        paths
            .iter()
            .map(|path| (path.as_str(), b"\0\xffbinary".as_slice())),
    );
    let bytes = archive_bytes(&files).unwrap();
    let mount = home.join(".pi/agent/skills/example");
    let input = serde_json::to_vec(&BundleApplication::Skill {
        mount: mount.to_str().unwrap().into(),
        archive: stage_archive(&runtime, &bytes).unwrap(),
    })
    .unwrap();
    assert!(input.len() < guest_contracts::content_bundle::MAX_METADATA_BYTES);
    assert!(apply_content_bundle(home, &runtime, &input));
    for (path, content) in files {
        assert_eq!(fs::read(mount.join(path)).unwrap(), content);
    }
}

#[test]
fn invalid_archive_identity_or_instruction_contents_preserve_existing_instructions() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let runtime = home.join("private");
    fs::create_dir(&runtime).unwrap();
    fs::create_dir(home.join(".codex")).unwrap();
    let target = home.join(".codex/AGENTS.md");
    fs::write(&target, "current instructions").unwrap();
    let bytes = archive_bytes(&[("instructions.md", b"replacement")]).unwrap();
    let mut wrong_hash = stage_archive(&runtime, &bytes).unwrap();
    wrong_hash.sha256 = "0".repeat(64);
    let mut wrong_size = stage_archive(&runtime, &bytes).unwrap();
    wrong_size.archive_bytes += 1;
    let skill_bytes = archive_bytes(&[("SKILL.md", b"not instructions")]).unwrap();
    for archive in [
        wrong_hash,
        wrong_size,
        stage_archive(&runtime, &skill_bytes).unwrap(),
    ] {
        let input = serde_json::to_vec(&BundleApplication::Instructions {
            framework: "codex".into(),
            archive,
        })
        .unwrap();
        assert!(!apply_content_bundle(home, &runtime, &input));
        assert_eq!(fs::read_to_string(&target).unwrap(), "current instructions");
    }
}

#[test]
fn archive_links_and_conflicting_paths_cannot_replace_a_managed_skill() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let runtime = home.join("private");
    let mount = home.join(".claude/skills/example");
    fs::create_dir(&runtime).unwrap();
    fs::create_dir_all(&mount).unwrap();
    fs::write(mount.join("SKILL.md"), "current skill").unwrap();
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut tar = tar::Builder::new(encoder);
    let mut header = tar::Header::new_gnu();
    header.set_mode(0o600);
    header.set_size(0);
    header.set_entry_type(tar::EntryType::Symlink);
    header.set_cksum();
    tar.append_link(&mut header, "SKILL.md", "/etc/passwd")
        .unwrap();
    let link = tar.into_inner().unwrap().finish().unwrap();
    for bytes in [
        link,
        archive_bytes(&[("SKILL.md", b"first"), ("SKILL.md", b"second")]).unwrap(),
        archive_bytes(&[
            ("SKILL.md", b"replacement"),
            ("assets", b"file"),
            ("assets/nested", b"conflict"),
        ])
        .unwrap(),
    ] {
        let input = serde_json::to_vec(&BundleApplication::Skill {
            mount: mount.to_str().unwrap().into(),
            archive: stage_archive(&runtime, &bytes).unwrap(),
        })
        .unwrap();
        assert!(!apply_content_bundle(home, &runtime, &input));
        assert_eq!(
            fs::read_to_string(mount.join("SKILL.md")).unwrap(),
            "current skill"
        );
    }
}

#[test]
fn bundle_expansion_limit_preserves_the_current_skill_even_with_valid_archive_hash() {
    use std::io::Write;
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let runtime = home.join("private");
    let mount = home.join(".codex/skills/example");
    fs::create_dir(&runtime).unwrap();
    fs::create_dir_all(&mount).unwrap();
    fs::write(mount.join("SKILL.md"), "current skill").unwrap();
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut tar = tar::Builder::new(encoder);
    let mut header = tar::Header::new_gnu();
    header.set_mode(0o600);
    header.set_size(3);
    header.set_cksum();
    tar.append_data(&mut header, "SKILL.md", b"new".as_slice())
        .unwrap();
    let mut encoder = tar.into_inner().unwrap();
    // Valid gzip data after tar's end marker must still respect the total bound.
    for _ in 0..35 {
        encoder.write_all(&vec![0; 1024 * 1024]).unwrap();
    }
    let bytes = encoder.finish().unwrap();
    let input = serde_json::to_vec(&BundleApplication::Skill {
        mount: mount.to_str().unwrap().into(),
        archive: stage_archive(&runtime, &bytes).unwrap(),
    })
    .unwrap();
    assert!(!apply_content_bundle(home, &runtime, &input));
    assert_eq!(
        fs::read_to_string(mount.join("SKILL.md")).unwrap(),
        "current skill"
    );
}
