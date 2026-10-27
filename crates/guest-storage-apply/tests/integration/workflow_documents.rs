use std::fs;
use std::path::{Path, PathBuf};

use guest_contracts::workflow_documents::WorkflowDocumentSource;
use guest_storage_apply::apply_workflow_skill_documents;

fn source(runtime: &Path, mount: PathBuf, body: &[u8]) -> std::io::Result<WorkflowDocumentSource> {
    let source = runtime.join(format!("workflow-{}", uuid_string()));
    fs::write(&source, body)?;
    let path_error = || {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "test fixture path is not UTF-8",
        )
    };
    Ok(WorkflowDocumentSource {
        mount_path: mount.to_str().ok_or_else(path_error)?.into(),
        source: source.to_str().ok_or_else(path_error)?.into(),
    })
}

fn uuid_string() -> String {
    // UUIDs need uniqueness only within this test's independent directory.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    format!(
        "00000000-0000-0000-0000-{:012x}",
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

#[test]
fn workflow_batch_preserves_all_framework_documents_attachments_and_private_permissions() {
    for root in [".claude", ".codex", ".pi/agent"] {
        let dir = tempfile::tempdir().unwrap();
        let runtime = dir.path().join("private");
        fs::create_dir(&runtime).unwrap();
        let mut entries = Vec::new();
        for index in 0..64 {
            let mount = dir
                .path()
                .join(root)
                .join(format!("skills/workflow-{index}"));
            fs::create_dir_all(mount.join("references")).unwrap();
            fs::write(mount.join("references/keep"), "attachment").unwrap();
            fs::write(mount.join("SKILL.md"), "stale").unwrap();
            let body = if index % 2 == 0 {
                ""
            } else {
                "Unicode 正文 '$(never execute)'\n"
            };
            let entry = source(&runtime, mount, body.as_bytes()).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&entry.source, fs::Permissions::from_mode(0o600)).unwrap();
            }
            entries.push(entry);
        }
        assert!(apply_workflow_skill_documents(
            dir.path(),
            &runtime,
            &serde_json::to_vec(&entries).unwrap()
        ));
        for (index, entry) in entries.iter().enumerate() {
            let mount = Path::new(&entry.mount_path);
            let expected = if index % 2 == 0 {
                ""
            } else {
                "Unicode 正文 '$(never execute)'\n"
            };
            assert_eq!(
                fs::read(mount.join("SKILL.md")).unwrap(),
                expected.as_bytes()
            );
            assert_eq!(
                fs::read(mount.join("references/keep")).unwrap(),
                b"attachment"
            );
            assert!(!Path::new(&entry.source).exists());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(mount.join("SKILL.md"))
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
            }
        }
    }
}

#[test]
fn workflow_batch_validates_all_metadata_before_applying_a_prefix() {
    for invalid_mount in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let runtime = dir.path().join("private");
        fs::create_dir(&runtime).unwrap();
        let first_mount = dir.path().join(".codex/skills/first-workflow");
        fs::create_dir_all(&first_mount).unwrap();
        fs::write(first_mount.join("SKILL.md"), "old").unwrap();
        let first = source(&runtime, first_mount.clone(), b"new").unwrap();
        let mut second = source(
            &runtime,
            dir.path().join(".codex/skills/second-workflow"),
            b"second",
        )
        .unwrap();
        if invalid_mount {
            second.mount_path = dir.path().join("outside").to_str().unwrap().into();
        } else {
            second.source = dir.path().join("outside-source").to_str().unwrap().into();
        }
        let entries = [first, second];
        assert!(!apply_workflow_skill_documents(
            dir.path(),
            &runtime,
            &serde_json::to_vec(&entries).unwrap()
        ));
        assert_eq!(fs::read(first_mount.join("SKILL.md")).unwrap(), b"old");
        assert!(Path::new(&entries[0].source).exists());
    }
}

#[test]
fn workflow_batch_stops_on_missing_source_and_keeps_completed_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = dir.path().join("private");
    fs::create_dir(&runtime).unwrap();
    let entries = (0..3)
        .map(|index| {
            source(
                &runtime,
                dir.path().join(format!(".codex/skills/workflow-{index}")),
                b"new",
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    fs::remove_file(&entries[1].source).unwrap();
    assert!(!apply_workflow_skill_documents(
        dir.path(),
        &runtime,
        &serde_json::to_vec(&entries).unwrap()
    ));
    assert_eq!(
        fs::read(Path::new(&entries[0].mount_path).join("SKILL.md")).unwrap(),
        b"new"
    );
    assert!(!Path::new(&entries[0].source).exists());
    assert!(!Path::new(&entries[1].mount_path).exists());
    assert!(!Path::new(&entries[2].mount_path).exists());
    assert!(Path::new(&entries[2].source).exists());
}

#[cfg(unix)]
#[test]
fn workflow_batch_rejects_symlink_sources_and_parents_and_stops_on_cleanup_failure() {
    for failure in ["source-link", "parent-link", "source-directory"] {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let runtime = dir.path().join("private");
        fs::create_dir(&runtime).unwrap();
        let entries = (0..2)
            .map(|index| {
                source(
                    &runtime,
                    dir.path().join(format!(".codex/skills/workflow-{index}")),
                    b"new",
                )
                .unwrap()
            })
            .collect::<Vec<_>>();
        match failure {
            "source-link" => {
                let external = outside.path().join("secret");
                fs::write(&external, "secret").unwrap();
                fs::remove_file(&entries[0].source).unwrap();
                std::os::unix::fs::symlink(&external, &entries[0].source).unwrap();
            }
            "parent-link" => {
                std::os::unix::fs::symlink(outside.path(), dir.path().join(".codex")).unwrap()
            }
            _ => {
                fs::remove_file(&entries[0].source).unwrap();
                fs::create_dir(&entries[0].source).unwrap();
            }
        }
        assert!(!apply_workflow_skill_documents(
            dir.path(),
            &runtime,
            &serde_json::to_vec(&entries).unwrap()
        ));
        assert!(Path::new(&entries[1].source).exists());
        assert!(!outside.path().join("skills").exists());
        if failure == "source-link" {
            assert_eq!(fs::read(outside.path().join("secret")).unwrap(), b"secret");
        }
    }
}
