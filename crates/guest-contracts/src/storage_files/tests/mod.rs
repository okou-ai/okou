use super::*;
use crate::storage_manifest::{ArtifactEntry, Manifest, StorageEntry};

fn storage_entry(mount_path: &str) -> StorageEntry {
    StorageEntry {
        mount_path: mount_path.into(),
        archive_url: Some("file:///storage.tar.gz".into()),
        cached: false,
        vas_storage_name: Some("storage".into()),
        vas_version_id: Some("v1".into()),
    }
}

fn artifact_entry(mount_path: &str) -> ArtifactEntry {
    ArtifactEntry {
        mount_path: mount_path.into(),
        archive_url: Some("file:///artifact.tar.gz".into()),
        empty: false,
        cached: false,
        vas_storage_name: Some("artifact".into()),
        vas_storage_id: Some("artifact-id".into()),
        vas_version_id: Some("v1".into()),
        missing_root_policy: Some("preserveParentVersion".into()),
    }
}

fn manifest(storages: Vec<StorageEntry>, artifacts: Vec<ArtifactEntry>) -> Manifest {
    Manifest {
        storages,
        artifacts,
        cleanup_paths: Vec::new(),
        instruction_cleanups: Vec::new(),
    }
}

#[test]
fn validates_sizes_before_encoding_and_rejects_truncated_and_extra_input() {
    let mut files = vec![StorageFile {
        path: "file".into(),
        mode: 0o644,
        mtime: 1,
        content: vec![0; MAX_FILE_BYTES],
    }];
    let encoded = encode_input(b"{}", &[("/mount", &files)]).unwrap();
    let (manifest, payload) = split_input(&encoded).unwrap();
    assert_eq!(manifest, b"{}");
    assert_eq!(decode(payload).unwrap()[0].files, files);
    files[0].content.push(0);
    assert!(encode_input(b"{}", &[("/mount", &files)]).is_err());
    assert!(PreparedInput::new(b"{}".to_vec(), vec![("/mount", &files)]).is_err());
    for end in [0, 7, 8, 12, encoded.len() - 1] {
        assert!(split_input(&encoded[..end]).is_err());
    }
    let mut trailing = encoded.clone();
    trailing.push(0);
    assert!(split_input(&trailing).is_err());
    let mut payload = payload.to_vec();
    payload[0..4].copy_from_slice(&u32::MAX.to_be_bytes());
    assert!(decode(&payload).is_err());
}

#[test]
fn final_input_matches_existing_payload_framing_for_multiple_groups() {
    let first = [StorageFile {
        path: "a".into(),
        mode: 0o644,
        mtime: 7,
        content: vec![42],
    }];
    let second = [StorageFile {
        path: "b".into(),
        mode: 0o755,
        mtime: 8,
        content: vec![1, 2],
    }];
    let groups = [("/first", first.as_slice()), ("/second", second.as_slice())];
    let payload = encode(&groups).unwrap();
    let mut expected = Vec::new();
    expected.extend_from_slice(INPUT_MAGIC);
    expected.extend_from_slice(&2_u32.to_be_bytes());
    expected.extend_from_slice(b"{}");
    expected.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    expected.extend_from_slice(&payload);
    assert_eq!(encode_input(b"{}", &groups).unwrap(), expected);
    assert_eq!(split_input(&expected).unwrap().1, payload);

    // Pin a simple wire fixture independently of either payload writer.
    let one = [("/m", first.as_slice())];
    let mut fixture = Vec::new();
    fixture.extend_from_slice(INPUT_MAGIC);
    fixture.extend_from_slice(&2_u32.to_be_bytes());
    fixture.extend_from_slice(b"{}");
    fixture.extend_from_slice(&36_u32.to_be_bytes());
    fixture.extend_from_slice(&1_u32.to_be_bytes());
    fixture.extend_from_slice(&2_u32.to_be_bytes());
    fixture.extend_from_slice(b"/m");
    fixture.extend_from_slice(&1_u32.to_be_bytes());
    fixture.extend_from_slice(&1_u32.to_be_bytes());
    fixture.extend_from_slice(b"a");
    fixture.extend_from_slice(&0o644_u32.to_be_bytes());
    fixture.extend_from_slice(&7_u64.to_be_bytes());
    fixture.extend_from_slice(&1_u32.to_be_bytes());
    fixture.push(42);
    assert_eq!(encode_input(b"{}", &one).unwrap(), fixture);
    let prepared = PreparedInput::new(b"{}".to_vec(), one.to_vec()).unwrap();
    assert_eq!(prepared.manifest_len(), 2);
    assert_eq!(prepared.payload_len(), 36);
    assert_eq!(prepared.into_bytes(), fixture);
}

#[test]
fn final_input_accepts_exact_payload_cap_and_rejects_one_extra_byte() {
    let mounts: Vec<_> = (0..15).map(|i| format!("/mount-{i}")).collect();
    let mut files: Vec<Vec<StorageFile>> = (0..15)
        .map(|_| {
            (0..4)
                .map(|index| StorageFile {
                    path: format!("file-{index}"),
                    mode: 0o644,
                    mtime: 1,
                    content: vec![0; MAX_FILE_BYTES],
                })
                .collect()
        })
        .collect();
    files[14][3].content.clear();
    let groups: Vec<_> = mounts
        .iter()
        .zip(&files)
        .map(|(mount, files)| (mount.as_str(), files.as_slice()))
        .collect();
    let remaining = MAX_PAYLOAD_BYTES - encoded_payload_len(&groups).unwrap();
    assert!(remaining < MAX_FILE_BYTES);
    files[14][3].content.resize(remaining, 0);
    let groups: Vec<_> = mounts
        .iter()
        .zip(&files)
        .map(|(mount, files)| (mount.as_str(), files.as_slice()))
        .collect();
    assert_eq!(encoded_payload_len(&groups).unwrap(), MAX_PAYLOAD_BYTES);
    let prepared = PreparedInput::new(vec![b' '; MAX_MANIFEST_BYTES], groups).unwrap();
    assert_eq!(prepared.manifest_len(), MAX_MANIFEST_BYTES);
    assert_eq!(prepared.payload_len(), MAX_PAYLOAD_BYTES);
    let encoded = prepared.into_bytes();
    assert_eq!(encoded.len(), MAX_INPUT_BYTES);
    let (manifest, payload) = split_input(&encoded).unwrap();
    assert_eq!(manifest.len(), MAX_MANIFEST_BYTES);
    assert_eq!(payload.len(), MAX_PAYLOAD_BYTES);

    files[14][3].content.push(0);
    let groups: Vec<_> = mounts
        .iter()
        .zip(&files)
        .map(|(mount, files)| (mount.as_str(), files.as_slice()))
        .collect();
    assert!(PreparedInput::new(b"{}".to_vec(), groups).is_err());
    assert_eq!(files[14][3].content.len(), remaining + 1);
}

#[test]
fn enforces_storage_count_path_metadata_and_manifest_bounds() {
    let mut files: Vec<_> = (0..MAX_FILES)
        .map(|index| StorageFile {
            path: format!("file-{index}"),
            mode: 0o777,
            mtime: i64::MAX as u64,
            content: vec![0; MAX_STORAGE_BYTES / MAX_FILES],
        })
        .collect();
    assert!(validate_files(&files).is_ok());
    files[0].content.push(0);
    assert!(validate_files(&files).is_err());
    files[0].content.pop();
    files.push(StorageFile {
        path: "extra".into(),
        mode: 0o644,
        mtime: 0,
        content: vec![],
    });
    assert!(validate_files(&files).is_err());
    files.pop();
    files[0].path = "a".repeat(MAX_PATH_BYTES);
    assert!(validate_files(&files).is_ok());
    files[0].path.push('a');
    assert!(validate_files(&files).is_err());
    files[0].path = "file-0".into();
    files[0].mode = 0o4755;
    assert!(validate_files(&files).is_err());
    files[0].mode = 0o644;
    files[0].mtime = i64::MAX as u64 + 1;
    assert!(validate_files(&files).is_err());
    files[0].mtime = 1;
    assert!(encode_input(&vec![b' '; MAX_MANIFEST_BYTES], &[("/mount", &files)]).is_ok());
    assert!(encode_input(&vec![b' '; MAX_MANIFEST_BYTES + 1], &[("/mount", &files)]).is_err());
    assert!(
        PreparedInput::new(vec![b' '; MAX_MANIFEST_BYTES + 1], vec![("/mount", &files)]).is_err()
    );
}

#[test]
fn aggregate_paths_remain_bounded_and_sorted_checks_preserve_order() {
    let make = |path: String| StorageFile {
        path,
        mode: 0o640,
        mtime: 1,
        content: Vec::new(),
    };
    let mut files: Vec<_> = (0..MAX_FILES)
        .map(|index| make(format!("{index:04}-{}", "a".repeat(123))))
        .collect();
    assert_eq!(
        files.iter().map(|f| f.path.len()).sum::<usize>(),
        MAX_TOTAL_PATH_BYTES
    );
    validate_files(&files).unwrap();
    files[0].path.push('a');
    assert!(validate_files(&files).is_err());

    for paths in [
        vec!["a/b", "a-b", "a"],
        vec!["a", "a-b", "a/b"],
        vec!["a/b", "a/b"],
    ] {
        let entries: Vec<_> = paths.iter().map(|path| make((*path).into())).collect();
        assert!(validate_files(&entries).is_err(), "{paths:?}");
    }
    let entries: Vec<_> = ["z", "a/b", "a-b"]
        .into_iter()
        .map(|p| make(p.into()))
        .collect();
    validate_files(&entries).unwrap();
    assert_eq!(
        entries.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
        ["z", "a/b", "a-b"]
    );
}

#[test]
fn whole_input_file_count_retains_original_allocation_envelope() {
    let files: Vec<_> = (0..MAX_FILES)
        .map(|index| StorageFile {
            path: format!("file-{index}"),
            mode: 0o640,
            mtime: 1,
            content: Vec::new(),
        })
        .collect();
    let fitting_groups = MAX_TOTAL_FILES / MAX_FILES;
    let mounts: Vec<_> = (0..=fitting_groups)
        .map(|index| format!("/mount-{index}"))
        .collect();
    let groups: Vec<_> = mounts
        .iter()
        .map(|mount| (mount.as_str(), files.as_slice()))
        .collect();
    let encoded = encode(&groups[..fitting_groups]).unwrap();
    assert_eq!(
        decode(&encoded)
            .unwrap()
            .iter()
            .map(|g| g.files.len())
            .sum::<usize>(),
        MAX_TOTAL_FILES
    );
    assert!(encoded_payload_len(&groups).is_err());
    let mut unchecked = Vec::new();
    encode_groups_into(&mut unchecked, &groups);
    assert!(unchecked.len() < MAX_PAYLOAD_BYTES);
    assert!(decode(&unchecked).is_err());
}

#[test]
fn decoding_enforces_each_groups_content_and_path_envelopes() {
    let mut files: Vec<_> = (0..MAX_STORAGE_BYTES / MAX_FILE_BYTES)
        .map(|index| StorageFile {
            path: format!("file-{index}"),
            mode: 0o640,
            mtime: 1,
            content: vec![0; MAX_FILE_BYTES],
        })
        .collect();
    let encoded = encode(&[("/mount", &files)]).unwrap();
    assert_eq!(decode(&encoded).unwrap().remove(0).files, files);
    files.push(StorageFile {
        path: "overflow".into(),
        mode: 0o640,
        mtime: 1,
        content: vec![0],
    });
    let mut unchecked = Vec::new();
    encode_groups_into(&mut unchecked, &[("/mount", &files)]);
    assert!(unchecked.len() < MAX_PAYLOAD_BYTES);
    assert_eq!(
        decode(&unchecked).unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );

    let mut files: Vec<_> = (0..MAX_FILES)
        .map(|index| StorageFile {
            path: format!("{index:04}-{}", "a".repeat(123)),
            mode: 0o640,
            mtime: 1,
            content: Vec::new(),
        })
        .collect();
    let encoded = encode(&[("/mount", &files)]).unwrap();
    assert_eq!(decode(&encoded).unwrap().remove(0).files, files);
    files[0].path.push('a');
    let mut unchecked = Vec::new();
    encode_groups_into(&mut unchecked, &[("/mount", &files)]);
    assert!(unchecked.len() < MAX_PAYLOAD_BYTES);
    assert_eq!(
        decode(&unchecked).unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
}

#[test]
fn aggregate_payload_limit_counts_content_and_framing() {
    let files: Vec<_> = (0..4)
        .map(|index| StorageFile {
            path: format!("file-{index}"),
            mode: 0o644,
            mtime: 1,
            content: vec![0; MAX_FILE_BYTES],
        })
        .collect();
    let mounts: Vec<_> = (0..15).map(|index| format!("/mount-{index}")).collect();
    let groups: Vec<_> = mounts
        .iter()
        .map(|mount| (mount.as_str(), files.as_slice()))
        .collect();
    let size = encoded_payload_len(&groups[..14]).unwrap();
    assert_eq!(encode(&groups[..14]).unwrap().len(), size);
    assert!(encoded_payload_len(&groups).is_err());
    assert!(encode(&groups).is_err());
    let duplicate = [("/mount", files.as_slice()), ("/mount", files.as_slice())];
    assert!(encoded_payload_len(&duplicate).is_err());
    assert!(encode_input(b"{}", &duplicate).is_err());
    assert!(encode_input(b"{}", &[]).is_err());
}

#[test]
fn bindings_accept_complete_fresh_artifacts_and_reject_other_artifact_states() {
    let valid = manifest(Vec::new(), vec![artifact_entry("/artifact")]);
    validate_bindings(&valid, ["/artifact"]).unwrap();

    for invalid in ["empty", "cached", "source", "name", "storage-id", "version"] {
        let mut entry = artifact_entry("/artifact");
        if invalid == "empty" {
            entry.empty = true;
        } else if invalid == "cached" {
            entry.cached = true;
        } else if invalid == "source" {
            entry.archive_url = None;
        } else if invalid == "name" {
            entry.vas_storage_name = None;
        } else if invalid == "storage-id" {
            entry.vas_storage_id = Some(String::new());
        } else {
            entry.vas_version_id = None;
        }
        assert!(
            validate_bindings(&manifest(Vec::new(), vec![entry]), ["/artifact"]).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn bindings_reject_artifact_overlap_before_transport_splitting() {
    for other in ["/artifact", "/artifact/child", "/"] {
        let source = manifest(
            vec![storage_entry(other)],
            vec![artifact_entry("/artifact")],
        );
        assert!(
            validate_bindings(&source, ["/artifact"]).is_err(),
            "{other}"
        );
    }
}
