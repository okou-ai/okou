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
fn bundles_restore_exact_instructions_and_preserve_native_history() {
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
        fs::create_dir_all(&target).unwrap();
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
            assert_eq!(
                fs::read(target.join("native-history")).unwrap(),
                b"preserved"
            );
        }
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
    let extra_file = archive_bytes(&[
        ("instructions.md", b"replacement"),
        ("extra", b"unexpected"),
    ])
    .unwrap();
    for archive in [
        wrong_hash,
        wrong_size,
        stage_archive(&runtime, &extra_file).unwrap(),
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
fn instruction_bundle_refuses_symlinked_managed_parents_without_touching_external_files() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let outside = temp.path().join("outside");
    let runtime = home.join("private");
    fs::create_dir_all(&runtime).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("AGENTS.md"), "external").unwrap();
    std::os::unix::fs::symlink(&outside, home.join(".codex")).unwrap();
    let bytes = archive_bytes(&[("instructions.md", b"untrusted")]).unwrap();
    let input = BundleApplication::Instructions {
        framework: "codex".into(),
        archive: stage_archive(&runtime, &bytes).unwrap(),
    };
    assert!(!apply_content_bundle(
        &home,
        &runtime,
        &serde_json::to_vec(&input).unwrap()
    ));
    assert_eq!(
        fs::read_to_string(outside.join("AGENTS.md")).unwrap(),
        "external"
    );
}
