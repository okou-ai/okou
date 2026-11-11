use super::*;
use cli_test_support::tar_fixture::{TarEntry, create_tar_gz_entries};
use httpmock::prelude::*;
use serde_json::json;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

mod empty;

const STORAGE: &str = "00000000-0000-4000-8000-000000000001";

fn entries(files: &[(&str, &str)]) -> Vec<FileEntry> {
    files
        .iter()
        .map(|(path, content)| FileEntry {
            path: (*path).to_string(),
            hash: hex::encode(Sha256::digest(content.as_bytes())),
            size: content.len() as u64,
        })
        .collect()
}

fn version(files: &[FileEntry]) -> String {
    compute_content_hash(
        STORAGE,
        files
            .iter()
            .map(|file| (file.path.as_str(), file.hash.as_str())),
    )
}

fn archive_bytes(files: &[(&str, &str)]) -> io::Result<Vec<u8>> {
    let entries: Vec<_> = files
        .iter()
        .map(|(path, content)| TarEntry::File(path, content.as_bytes()))
        .collect();
    create_tar_gz_entries(&entries)
}

fn archive_contents(bytes: &[u8]) -> io::Result<BTreeMap<String, String>> {
    let mut tar = tar::Archive::new(MultiGzDecoder::new(bytes));
    tar.entries()?
        .map(|entry| {
            let mut entry = entry?;
            let path = entry
                .path()?
                .to_str()
                .ok_or_else(|| io::Error::other("test archive path is not UTF-8"))?
                .to_owned();
            let mut content = String::new();
            entry.read_to_string(&mut content)?;
            Ok((path, content))
        })
        .collect()
}

#[tokio::test]
async fn memory_409_replays_original_delta_through_multiple_real_archive_publications() {
    let _log_guard = crate::lock_system_log_test_state_async().await;
    let _ops_guard = crate::SandboxOpsTestGuard::lock().await;
    guest_telemetry::log::clear_system_log_file();
    for existing in [false, true] {
        let server = MockServer::start();
        let mount = tempfile::tempdir().unwrap();
        let base_files = entries(&[
            ("shared.md", "base"),
            ("inherited.md", "base"),
            ("remove.md", "base"),
            ("head-deleted.md", "base"),
            ("restored.md", "base"),
        ]);
        let ours = [
            ("shared.md", "candidate wins"),
            ("inherited.md", "base"),
            ("head-deleted.md", "base"),
            ("restored.md", "candidate restores"),
            ("own/new.md", "candidate addition"),
        ];
        let head_trees = [
            vec![
                ("shared.md", "first head"),
                ("inherited.md", "first head"),
                ("remove.md", "head edited deletion"),
                ("foreign.md", "first head"),
            ],
            vec![
                ("shared.md", "second head"),
                ("inherited.md", "second head"),
                ("remove.md", "newer head edit"),
                ("foreign.md", "second head"),
                ("fresh.md", "new while retrying"),
            ],
        ];
        let base_version = version(&base_files);
        let original_version = version(&entries(&ours));
        let expected = [
            ("shared.md", "candidate wins"),
            ("inherited.md", "second head"),
            ("restored.md", "candidate restores"),
            ("own/new.md", "candidate addition"),
            ("foreign.md", "second head"),
            ("fresh.md", "new while retrying"),
        ];
        let final_version = version(&entries(&expected));
        let base_url = server.base_url();
        let base_descriptor = json!({"versionId": base_version, "empty": false, "manifestUrl": format!("{base_url}/base-manifest")});
        server.mock(|when, then| {
            when.method(GET).path("/base-manifest");
            then.json_body(json!({"files": base_files}));
        });
        let mut heads = Vec::new();
        for (index, tree) in head_trees.iter().enumerate() {
            let files = entries(tree);
            let id = version(&files);
            heads.push(json!({"versionId": id, "empty": false,
                "manifestUrl": format!("{base_url}/head-{index}-manifest"),
                "archiveUrl": format!("{base_url}/head-{index}-archive")}));
            server.mock(|when, then| {
                when.method(GET).path(format!("/head-{index}-manifest"));
                then.json_body(json!({"files": files}));
            });
            server.mock(|when, then| {
                when.method(GET).path(format!("/head-{index}-archive"));
                let bytes = archive_bytes(tree).unwrap();
                then.respond_with(move |request| {
                    let has_credentials = request.headers_vec().iter().any(|(name, _)| {
                        name.eq_ignore_ascii_case("authorization")
                            || name.eq_ignore_ascii_case("x-vercel-protection-bypass")
                    });
                    HttpMockResponse::builder()
                        .status(if has_credentials { 400 } else { 200 })
                        .body(bytes.clone())
                        .build()
                });
            });
        }
        let refreshes = Arc::new(AtomicUsize::new(0));
        let prepare_count = Arc::clone(&refreshes);
        let prepared_original = original_version.clone();
        server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/storages/prepare");
            then.respond_with(move |request| {
                let body: serde_json::Value = serde_json::from_slice(request.body_ref()).unwrap();
                let files: Vec<FileEntry> = serde_json::from_value(body["files"].clone()).unwrap();
                let id = version(&files);
                let response = if body["includeMemoryMerge"] == true {
                    let index = prepare_count.fetch_add(1, Ordering::SeqCst).min(1);
                    json!({"versionId": id, "existing": true, "memoryMerge": {"base": base_descriptor, "head": heads[index]}})
                } else if existing && id == prepared_original {
                    json!({"versionId": id, "existing": true})
                } else {
                    json!({"versionId": id, "existing": false, "uploads": {
                        "archive": {"key": "archive", "presignedUrl": format!("{base_url}/archive/{id}")},
                        "manifest": {"key": "manifest", "presignedUrl": format!("{base_url}/manifest/{id}")}
                    }})
                };
                HttpMockResponse::builder().status(200).body(response.to_string()).build()
            });
        });
        let uploads = Arc::new(Mutex::new(BTreeMap::new()));
        let saved_uploads = Arc::clone(&uploads);
        server.mock(|when, then| {
            when.method(PUT).path_includes("/archive/");
            then.respond_with(move |request| {
                saved_uploads.lock().unwrap().insert(
                    request.uri().path().to_string(),
                    request.body_ref().to_vec(),
                );
                HttpMockResponse::builder().status(200).build()
            });
        });
        server.mock(|when, then| {
            when.method(PUT).path_includes("/manifest/");
            then.status(200);
        });
        let successful_version = final_version.clone();
        let successful_size: usize = expected.iter().map(|(_, content)| content.len()).sum();
        let captured_base = base_version.clone();
        let live_file = mount.path().join("own/new.md");
        let commit = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/storages/commit");
            then.respond_with(move |request| {
                let body: serde_json::Value = serde_json::from_slice(request.body_ref()).unwrap();
                if body["versionId"] == successful_version {
                    HttpMockResponse::builder().status(200).body(json!({"success": true,
                        "versionId": successful_version, "storageName": "memory", "size": successful_size, "fileCount": 6}).to_string()).build()
                } else {
                    if body["parentVersionId"] != captured_base {
                        fs::write(&live_file, "late local modification").unwrap();
                    }
                    HttpMockResponse::builder().status(409).body(json!({"error": {"message": "HEAD moved", "code": "CONFLICT"}}).to_string()).build()
                }
            });
        });
        for (path, content) in ours {
            let output = mount.path().join(path);
            fs::create_dir_all(output.parent().unwrap()).unwrap();
            fs::write(output, content).unwrap();
        }
        let http = HttpClient::with_api_config(
            server.base_url(),
            "private-api-token",
            "private-bypass",
            "merge-run",
            Duration::ZERO,
        )
        .unwrap();
        let result = create_memory_snapshot(
            &http,
            CreateSnapshotRequest {
                mount_path: mount.path().to_str().unwrap(),
                files: entries(&ours),
                storage_id: STORAGE,
                run_id: "merge-run",
                message: "Memory changes",
                parent_version_id: &base_version,
            },
        )
        .await
        .unwrap();
        assert!(matches!(result.publication, SnapshotPublication::Published));
        assert_eq!(result.version_id, final_version);
        assert_eq!(refreshes.load(Ordering::SeqCst), 2);
        commit.assert_calls(3);
        let saved = uploads.lock().unwrap();
        assert_eq!(
            archive_contents(saved.get(&format!("/archive/{final_version}")).unwrap()).unwrap(),
            expected
                .into_iter()
                .map(|(p, c)| (p.to_string(), c.to_string()))
                .collect()
        );
        assert_eq!(
            fs::read_to_string(mount.path().join("inherited.md")).unwrap(),
            "base"
        );
        assert_eq!(
            fs::read_to_string(mount.path().join("own/new.md")).unwrap(),
            "late local modification"
        );
    }
}

#[test]
fn candidate_file_directory_replacements_produce_a_valid_tree() {
    let head = entries(&[
        ("folder/child.md", "head"),
        ("file", "head"),
        ("untouched", "head"),
    ]);
    let delta = Delta {
        writes: entries(&[("folder", "ours"), ("file/child.md", "ours")])
            .into_iter()
            .map(|f| (f.path.clone(), f))
            .collect(),
        deletes: BTreeSet::new(),
    };
    let merged = apply_delta(
        head.into_iter().map(|f| (f.path.clone(), f)).collect(),
        &delta,
    );
    assert_eq!(
        merged.keys().map(String::as_str).collect::<Vec<_>>(),
        ["file/child.md", "folder", "untouched"]
    );
}

#[test]
fn archive_integrity_and_regular_file_membership_are_required() {
    let temp = tempfile::tempdir().unwrap();
    let archive = temp.path().join("archive.tar.gz");
    let root = temp.path().join("tree");
    fs::create_dir(&root).unwrap();
    fs::write(
        &archive,
        archive_bytes(&[("note.md", "untrusted data")]).unwrap(),
    )
    .unwrap();
    let expected = entries(&[("note.md", "verified bytes")])
        .into_iter()
        .map(|f| (f.path.clone(), f))
        .collect();
    assert!(copy_archive_files(&archive, &expected, &root).is_err());

    fs::write(
        &archive,
        create_tar_gz_entries(&[TarEntry::Symlink("note.md", "/etc/passwd")]).unwrap(),
    )
    .unwrap();
    assert!(copy_archive_files(&archive, &expected, &root).is_err());

    let mut truncated = archive_bytes(&[("note.md", "verified bytes")]).unwrap();
    truncated.pop();
    fs::write(&archive, truncated).unwrap();
    assert!(copy_archive_files(&archive, &expected, &root).is_err());
}
