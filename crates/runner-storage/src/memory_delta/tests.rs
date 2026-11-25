use super::*;
use flate2::{Compression, write::GzEncoder};

struct TestFile {
    path: String,
    mode: u32,
    mtime: u64,
    content: Vec<u8>,
}

fn archive(files: &[TestFile]) -> (Vec<u8>, String) {
    let mut tar = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
    let mut hashes = Vec::new();
    for file in files {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(file.content.len() as u64);
        header.set_mode(file.mode);
        header.set_mtime(file.mtime);
        tar.append_data(&mut header, &file.path, file.content.as_slice())
            .unwrap();
        hashes.push((
            file.path.as_str(),
            hex::encode(Sha256::digest(&file.content)),
        ));
    }
    let version =
        compute_content_hash("owner-memory", hashes.iter().map(|(p, h)| (*p, h.as_str())));
    (tar.into_inner().unwrap().finish().unwrap(), version)
}

fn memory_files() -> Vec<TestFile> {
    // Use deterministic incompressible bytes so this fixture exceeds the
    // compressed-size floor without requiring any external archives.
    let mut state = 17u64;
    let mut files = (0..5)
        .map(|index| TestFile {
            path: format!("notes/{index}.bin"),
            mode: 0o644,
            mtime: 19,
            content: (0..240_000)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    state as u8
                })
                .collect(),
        })
        .collect::<Vec<_>>();
    files.push(TestFile {
        path: format!("notes/{}.txt", "a".repeat(120)),
        mode: 0o644,
        mtime: 19,
        content: b"change me".to_vec(),
    });
    files.push(TestFile {
        path: "notes/delete.md".into(),
        mode: 0o644,
        mtime: 19,
        content: b"delete me".to_vec(),
    });
    files
}

#[test]
fn a_ready_delta_is_bound_to_its_owner_target_and_parent_tree() {
    let mut files = memory_files();
    let (parent, parent_version_id) = archive(&files);
    let base = MemoryDeltaBase {
        memory_id: "owner-memory".into(),
        parent_version_id,
    };
    files.pop().unwrap();
    let changed = files.last_mut().unwrap();
    changed.content = b"replacement".to_vec();
    changed.mode = 0o600;
    changed.mtime = 73;
    let path = changed.path.clone();
    files.push(TestFile {
        path: "notes/new.md".into(),
        mode: 0o640,
        mtime: 11,
        content: b"add me".to_vec(),
    });
    let (target, version) = archive(&files);
    let patch = build_memory_delta(&base, &version, &parent, &target)
        .unwrap()
        .unwrap();
    assert_eq!(patch.remove, ["notes/delete.md".to_owned()]);
    assert_eq!(
        patch.files[0],
        StorageFile {
            path,
            mode: 0o600,
            mtime: 73,
            content: b"replacement".to_vec(),
        }
    );
    assert_eq!(patch.files[1].path, "notes/new.md");
    let digest = patch.base_digest;
    let ready = ReadyMemoryDeltas::default();
    assert!(ready.ready("owner-memory", &version, &digest).is_none());
    ready.insert(patch);
    assert!(ready.ready("owner-memory", &version, &digest).is_some());
    assert!(ready.ready("other-memory", &version, &digest).is_none());
    assert!(
        ready
            .ready("owner-memory", &base.parent_version_id, &digest)
            .is_none()
    );
    assert!(ready.ready("owner-memory", &version, &[1; 32]).is_none());
}

#[test]
fn mismatched_lineage_corruption_and_directory_changes_leave_full_restore_available() {
    let mut files = memory_files();
    let (parent, parent_version_id) = archive(&files);
    let base = MemoryDeltaBase {
        memory_id: "owner-memory".into(),
        parent_version_id,
    };
    files.last_mut().unwrap().content = b"replace".to_vec();
    let (mut target, version) = archive(&files);
    assert!(
        build_memory_delta(&base, &"f".repeat(64), &parent, &target)
            .unwrap()
            .is_none()
    );
    target.pop();
    assert!(build_memory_delta(&base, &version, &parent, &target).is_err());
    files.last_mut().unwrap().path = "new-directory/delete.md".into();
    let (target, version) = archive(&files);
    assert!(
        build_memory_delta(&base, &version, &parent, &target)
            .unwrap()
            .is_none()
    );
}
