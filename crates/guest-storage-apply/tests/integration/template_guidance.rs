use crate::support::{
    TarEntry, create_tar_gz, create_tar_gz_entries, run_guest_storage_apply_manifest_json,
};
use httpmock::prelude::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

fn manifest(mount: &Path, url: &str, archive: &[u8]) -> Value {
    let digest = hex::encode(Sha256::digest(archive));
    json!({"storageMounts":[{
        "name":"template-guidance", "versionId":digest,
        "mountPath":mount,"archiveUrl":url,
        "templateGuidance":{"sha256":digest,"archiveBytes":archive.len()}
    }]})
}

fn apply(value: &Value) -> bool {
    run_guest_storage_apply_manifest_json(value.to_string().as_bytes())
}

#[test]
fn template_guidance_remote_and_staged_archives_preserve_long_paths_and_modes() {
    let server = MockServer::start();
    let path = format!(
        "{}/asset.bin",
        std::iter::repeat_n("reference-materials", 16)
            .collect::<Vec<_>>()
            .join("/")
    );
    assert!(path.len() > 256);
    let archive = create_tar_gz(&[("SKILL.md", b"template"), (&path, &[0, 255, 128, 1])]).unwrap();
    let request = server.mock(|when, then| {
        when.method(GET).path("/template");
        then.status(200).body(&archive);
    });
    let dir = tempfile::tempdir().unwrap();
    let staged = dir.path().join("cached.tar.gz");
    fs::write(&staged, &archive).unwrap();
    for (name, url) in [
        ("remote", server.url("/template")),
        ("cached", format!("file://{}", staged.display())),
    ] {
        let mount = dir.path().join(name);
        assert!(apply(&manifest(&mount, &url, &archive)));
        assert_eq!(fs::read(mount.join(&path)).unwrap(), [0, 255, 128, 1]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(mount.join("SKILL.md"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o644
            );
        }
    }
    request.assert_calls(1);
    assert_eq!(fs::read(staged).unwrap(), archive);
}

#[test]
fn template_guidance_bad_compressed_identity_never_materializes_files() {
    let archive = create_tar_gz(&[("SKILL.md", b"template")]).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let staged = dir.path().join("archive.tar.gz");
    fs::write(&staged, &archive).unwrap();
    for case in ["hash", "short", "long"] {
        let mount = dir.path().join(case);
        let mut value = manifest(&mount, &format!("file://{}", staged.display()), &archive);
        match case {
            "hash" => {
                value["storageMounts"][0]["templateGuidance"]["sha256"] = json!("0".repeat(64))
            }
            "short" => {
                value["storageMounts"][0]["templateGuidance"]["archiveBytes"] =
                    json!(archive.len() - 1)
            }
            _ => {
                value["storageMounts"][0]["templateGuidance"]["archiveBytes"] =
                    json!(archive.len() + 1)
            }
        }
        assert!(!apply(&value));
        assert!(!mount.join("SKILL.md").exists());
    }
}

#[test]
fn template_guidance_rejects_links_unsafe_paths_and_executable_modes() {
    let cases = [
        TarEntry::Symlink("link", "SKILL.md"),
        TarEntry::Raw {
            path: b"../escape",
            entry_type: b'0',
            mode: b"0000644\0",
            content: b"escape",
        },
        TarEntry::Raw {
            path: b"execute.sh",
            entry_type: b'0',
            mode: b"0000755\0",
            content: b"exec",
        },
    ];
    for entry in cases {
        let archive = create_tar_gz_entries(&[entry]).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("archive.tar.gz");
        fs::write(&staged, &archive).unwrap();
        assert!(!apply(&manifest(
            &dir.path().join("mount"),
            &format!("file://{}", staged.display()),
            &archive
        )));
        assert!(!dir.path().join("escape").exists());
    }
}

#[test]
fn template_guidance_replacement_clears_files_removed_from_the_complete_package() {
    let dir = tempfile::tempdir().unwrap();
    let staged = dir.path().join("archive.tar.gz");
    let mount = dir.path().join("mount");
    let url = format!("file://{}", staged.display());
    let old = create_tar_gz(&[("SKILL.md", b"old"), ("removed.txt", b"old asset")]).unwrap();
    fs::write(&staged, &old).unwrap();
    assert!(apply(&manifest(&mount, &url, &old)));
    let new = create_tar_gz(&[("SKILL.md", b"new")]).unwrap();
    fs::write(&staged, &new).unwrap();
    let mut value = manifest(&mount, &url, &new);
    value["cleanupPaths"] = json!([mount]);
    assert!(apply(&value));
    assert_eq!(fs::read(mount.join("SKILL.md")).unwrap(), b"new");
    assert!(!mount.join("removed.txt").exists());
}

#[test]
fn template_guidance_remote_archive_above_skill_and_host_cache_limits_is_verified() {
    let mut state = 0xd1b5_4a32_d192_ed03_u64;
    let data = (0..17 * 1024 * 1024)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state as u8
        })
        .collect::<Vec<_>>();
    let archive = create_tar_gz(&[("first.bin", &data), ("second.bin", &data)]).unwrap();
    assert!(archive.len() > 32 * 1024 * 1024);
    let server = MockServer::start();
    let request = server.mock(|when, then| {
        when.method(GET).path("/large");
        then.status(200).body(&archive);
    });
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    assert!(apply(&manifest(&mount, &server.url("/large"), &archive)));
    for name in ["first.bin", "second.bin"] {
        assert_eq!(fs::read(mount.join(name)).unwrap(), data);
    }
    request.assert_calls(1);
}

#[test]
fn template_guidance_decodes_the_typescript_canonical_pax_fixture() {
    let archive = include_bytes!("../fixtures/template-guidance-v1.tar.gz");
    let reference: Value =
        serde_json::from_str(include_str!("../fixtures/template-guidance-v1.json")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let staged = dir.path().join("typescript.tar.gz");
    fs::write(&staged, archive).unwrap();
    let mount = dir.path().join("mount");
    let mut value = manifest(&mount, &format!("file://{}", staged.display()), archive);
    value["storageMounts"][0]["templateGuidance"] = reference;
    assert!(apply(&value));
    let path = format!(
        "references/{}/sample.bin",
        std::iter::repeat_n("template-reference-assets", 14)
            .collect::<Vec<_>>()
            .join("/")
    );
    assert_eq!(fs::read(mount.join(path)).unwrap(), [0, 255, 128, 1]);
    assert_eq!(
        fs::read(mount.join("SKILL.md")).unwrap(),
        b"# Use the selected template\n"
    );
}

#[test]
fn template_guidance_preserves_parent_overlay_and_reapplies_selected_files() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("workspace");
    let child = parent.join("selected");
    let parent_bytes = create_tar_gz(&[
        ("selected/SKILL.md", b"stale"),
        ("selected/stale.txt", b"parent-owned"),
        ("other.txt", b"retain"),
    ])
    .unwrap();
    let child_bytes = create_tar_gz(&[("SKILL.md", b"selected package")]).unwrap();
    let parent_source = dir.path().join("parent.tar.gz");
    let child_source = dir.path().join("child.tar.gz");
    fs::write(&parent_source, &parent_bytes).unwrap();
    fs::write(&child_source, &child_bytes).unwrap();
    let child_entry = manifest(
        &child,
        &format!("file://{}", child_source.display()),
        &child_bytes,
    )["storageMounts"][0]
        .clone();
    let value = json!({"storageMounts":[{"name":"workspace","mountPath":parent,"archiveUrl":format!("file://{}", parent_source.display())},child_entry]});
    assert!(apply(&value));
    assert_eq!(
        fs::read(child.join("SKILL.md")).unwrap(),
        b"selected package"
    );
    let mut second = manifest(
        &child,
        &format!("file://{}", child_source.display()),
        &child_bytes,
    );
    second["storageMounts"].as_array_mut().unwrap().insert(
        0,
        json!({"name":"workspace","mountPath":parent,"cached":true}),
    );
    second["cleanupPaths"] = json!([child]);
    assert!(apply(&second));
    assert_eq!(
        fs::read(child.join("SKILL.md")).unwrap(),
        b"selected package"
    );
    assert_eq!(fs::read(child.join("stale.txt")).unwrap(), b"parent-owned");
    assert_eq!(fs::read(parent.join("other.txt")).unwrap(), b"retain");
}

#[test]
fn template_guidance_rejects_empty_archives() {
    let archive = create_tar_gz(&[]).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let staged = dir.path().join("archive.tar.gz");
    fs::write(&staged, &archive).unwrap();
    assert!(!apply(&manifest(
        &dir.path().join("mount"),
        &format!("file://{}", staged.display()),
        &archive
    )));
}

#[test]
fn template_guidance_enforces_file_count_and_payload_limits() {
    let oversized = vec![0_u8; 25 * 1024 * 1024 + 1];
    let payload = vec![0_u8; 25 * 1024 * 1024];
    let count = (0..201)
        .map(|index| format!("{index}.txt"))
        .collect::<Vec<_>>();
    let archives = [
        create_tar_gz(&[("too-large.bin", &oversized)]).unwrap(),
        create_tar_gz(
            &count
                .iter()
                .map(|path| (path.as_str(), b"".as_slice()))
                .collect::<Vec<_>>(),
        )
        .unwrap(),
        create_tar_gz(&[
            ("a.bin", &payload),
            ("b.bin", &payload),
            ("c.bin", &payload),
            ("d.bin", &payload),
            ("overflow.bin", b"x"),
        ])
        .unwrap(),
    ];
    for archive in archives {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("archive.tar.gz");
        fs::write(&staged, &archive).unwrap();
        assert!(!apply(&manifest(
            &dir.path().join("mount"),
            &format!("file://{}", staged.display()),
            &archive
        )));
    }
}

#[cfg(unix)]
#[test]
fn template_guidance_fails_when_an_existing_parent_escapes_its_directory() {
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let outside = dir.path().join("outside");
    fs::create_dir_all(&mount).unwrap();
    fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, mount.join("references")).unwrap();
    let archive = create_tar_gz(&[("references/guide.md", b"must not escape")]).unwrap();
    let staged = dir.path().join("archive.tar.gz");
    fs::write(&staged, &archive).unwrap();
    assert!(!apply(&manifest(
        &mount,
        &format!("file://{}", staged.display()),
        &archive
    )));
    assert!(!outside.join("guide.md").exists());
}
