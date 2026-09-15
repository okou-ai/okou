use crate::binary_logging::BinaryLoggingFixture;
use crate::process::CommandExecution;
use guest_contracts::storage_files::{self, StorageFile};
use serde_json::json;
use std::fs;

#[test]
fn parent_cleanup_preserves_instruction_inputs_and_cached_roots() {
    for (home_name, target, alternate) in [
        (".claude", "CLAUDE.md", "AGENTS.md"),
        (".codex", "AGENTS.md", "CLAUDE.md"),
        (".pi/agent", "AGENTS.md", "CLAUDE.md"),
    ] {
        for source in [target, alternate] {
            let fixture = BinaryLoggingFixture::new("cached-instructions").unwrap();
            let home = fixture.dir.path().join(home_name);
            let cached_skill = home.join("skills/retained");
            let cached_storage = fixture.dir.path().join("data");
            let cached_artifact = fixture.dir.path().join("workspace");
            for root in [&cached_skill, &cached_storage, &cached_artifact] {
                fs::create_dir_all(root.join("nested")).unwrap();
                fs::write(root.join("nested/keep"), b"cached content").unwrap();
            }
            fs::write(home.join(source), b"cached instructions").unwrap();
            fs::write(home.join("stale"), b"remove").unwrap();
            let removed_skill = home.join("skills/removed");
            fs::create_dir_all(&removed_skill).unwrap();
            fs::write(removed_skill.join("SKILL.md"), b"removed skill").unwrap();
            let manifest = serde_json::to_vec(&json!({
                "storageMounts": [
                    {"mountPath": home, "cached": true, "instructionsTargetFilename": target},
                    {"mountPath": cached_skill, "cached": true},
                    {"mountPath": cached_storage, "cached": true},
                    {"mountPath": cached_artifact, "cached": true, "writeback": true}
                ],
                "cleanupPaths": [home, removed_skill, cached_storage, cached_storage.join("nested"), cached_artifact, cached_artifact.join("nested")]
            })).unwrap();
            let manifest_path = fixture.dir.path().join("manifest.json");
            fs::write(&manifest_path, manifest).unwrap();

            let output = fixture.run_manifest_path(&manifest_path).unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(fs::read(home.join(target)).unwrap(), b"cached instructions");
            assert!(!home.join(alternate).exists());
            assert!(!home.join("stale").exists());
            assert!(!removed_skill.exists());
            for root in [&cached_skill, &cached_storage, &cached_artifact] {
                assert_eq!(
                    fs::read(root.join("nested/keep")).unwrap(),
                    b"cached content"
                );
            }
        }
    }
}

#[test]
fn decoded_input_cleans_removed_skills_beside_cached_instructions() {
    for (home_name, target) in [
        (".claude", "CLAUDE.md"),
        (".codex", "AGENTS.md"),
        (".pi/agent", "AGENTS.md"),
    ] {
        let fixture = BinaryLoggingFixture::new("decoded-cached-instructions").unwrap();
        let home = fixture.dir.path().join(home_name);
        let removed = home.join("skills/removed");
        let retained = home.join("skills/retained");
        let decoded = fixture.dir.path().join("decoded");
        for root in [&removed, &retained, &decoded] {
            fs::create_dir_all(root).unwrap();
        }
        fs::write(home.join(target), b"instructions").unwrap();
        fs::write(removed.join("SKILL.md"), b"removed").unwrap();
        fs::write(retained.join("SKILL.md"), b"retained").unwrap();
        fs::write(decoded.join("stale"), b"old version").unwrap();
        let manifest = serde_json::to_vec(&json!({
            "storageMounts": [
                {"mountPath": home, "cached": true, "instructionsTargetFilename": target},
                {"mountPath": retained, "cached": true},
                {"mountPath": decoded, "archiveUrl": "file:///not-staged.tar.gz"}
            ],
            "cleanupPaths": [removed, decoded]
        }))
        .unwrap();
        let files = vec![StorageFile {
            path: "current".into(),
            mode: 0o644,
            mtime: 1234567890,
            content: b"new version".to_vec(),
        }];
        let input =
            storage_files::encode_input(&manifest, &[(decoded.to_str().unwrap(), &files)]).unwrap();
        let output =
            CommandExecution::spawn(fixture.command().arg("--storage-files-stdin"), Some(&input))
                .unwrap()
                .wait()
                .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!removed.exists());
        assert!(!decoded.join("stale").exists());
        assert_eq!(fs::read(decoded.join("current")).unwrap(), b"new version");
        assert_eq!(fs::read(retained.join("SKILL.md")).unwrap(), b"retained");
        assert_eq!(fs::read(home.join(target)).unwrap(), b"instructions");
    }
}
