use guest_contracts::content_bundle::{BundleApplication, BundleFileSource};
use guest_storage_apply::apply_content_bundle;
use std::fs;

#[test]
fn legacy_archive_application_preserves_complete_bundle_and_separately_applied_body() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let mount = home.join(".codex/skills/example");
    let archive =
        include_bytes!("../../../runner-executor/tests/fixtures/content-bundle-v1.tar.gz");
    let staged = home.join("archive.tar.gz");
    fs::write(&staged, archive).unwrap();
    let manifest = serde_json::json!({"storageMounts":[{
        "mountPath":mount,
        "archiveUrl":format!("file://{}", staged.display()),
        "name":"workflow:7feae200-7a26-46f5-9dcb-12eaa0804414",
        "versionId":"d1467f9f02022e04ad66f2e983158c80ea58a152e8eec1ea7d07b0f51d3b3c67",
    }]});
    assert!(guest_storage_apply::run_manifest_bytes(
        &serde_json::to_vec(&manifest).unwrap()
    ));
    let body = "---\nname: example\n---\n\n正文\n";
    let source = home.join("private-body");
    fs::write(&source, body).unwrap();
    assert!(guest_storage_apply::apply_workflow_skill(
        home, &mount, &source
    ));
    assert_eq!(fs::read_to_string(mount.join("SKILL.md")).unwrap(), body);
    let attachment = format!("references/{0}/{0}/{0}/raw.bin", "目录".repeat(30));
    assert_eq!(fs::read(mount.join(attachment)).unwrap(), [0, 255, 128, 1]);
    let mut invalid = manifest;
    invalid["storageMounts"][0]["versionId"] = "0".repeat(64).into();
    assert!(!guest_storage_apply::run_manifest_bytes(
        &serde_json::to_vec(&invalid).unwrap()
    ));
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
            let source = runtime.join("bundle-0-0");
            fs::write(&source, content).unwrap();
            let input = BundleApplication::Instructions {
                framework: framework.into(),
                source: source.to_str().unwrap().into(),
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
        let source = runtime.join("bundle-1-0");
        fs::write(&source, "new complete skill").unwrap();
        let binary = runtime.join("bundle-1-1");
        fs::write(&binary, [0, 255, 128, 1]).unwrap();
        let attachment_path = format!("references/{0}/{0}/{0}/raw.bin", "目录".repeat(30));
        let input = BundleApplication::Skill {
            mount: mount.to_str().unwrap().into(),
            files: vec![
                BundleFileSource {
                    path: "SKILL.md".into(),
                    source: source.to_str().unwrap().into(),
                },
                BundleFileSource {
                    path: attachment_path.clone(),
                    source: binary.to_str().unwrap().into(),
                },
            ],
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
    let source = runtime.join("bundle-0-0");
    fs::write(&source, "untrusted").unwrap();
    let input = BundleApplication::Skill {
        mount: home.join(".codex/skills/example").to_str().unwrap().into(),
        files: vec![BundleFileSource {
            path: "SKILL.md".into(),
            source: source.to_str().unwrap().into(),
        }],
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
