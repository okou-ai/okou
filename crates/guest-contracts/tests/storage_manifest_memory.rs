//! Isolated public-serializer allocation regression. Fixture construction,
//! complete output comparison and decoding stay outside the observation window.
use guest_contracts::storage_manifest::{
    ArtifactEntry, InstructionCleanupEntry, Manifest, StorageEntry,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

static MEASURING: AtomicBool = AtomicBool::new(false);
static LARGEST: AtomicUsize = AtomicUsize::new(0);

struct AllocationObserver;

fn record_allocation(size: usize) {
    if MEASURING.load(Ordering::Relaxed) {
        LARGEST.fetch_max(size, Ordering::Relaxed);
    }
}

unsafe impl GlobalAlloc for AllocationObserver {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_allocation(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_allocation(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record_allocation(size);
        unsafe { System.realloc(pointer, layout, size) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: AllocationObserver = AllocationObserver;

struct AllocationMeasurement;

impl AllocationMeasurement {
    fn start() -> Self {
        LARGEST.store(0, Ordering::Relaxed);
        MEASURING.store(true, Ordering::Relaxed);
        Self
    }
}

impl Drop for AllocationMeasurement {
    fn drop(&mut self) {
        MEASURING.store(false, Ordering::Relaxed);
    }
}

fn check_wire(manifest: &Manifest, expected: &str) -> Result<(), Box<dyn std::error::Error>> {
    assert_eq!(serde_json::to_vec(manifest)?, expected.as_bytes());
    assert_eq!(
        serde_json::to_value(manifest)?,
        serde_json::from_str::<serde_json::Value>(expected)?
    );
    assert_eq!(serde_json::from_str::<Manifest>(expected)?, *manifest);
    Ok(())
}

fn check_complete_files(mut actual: File, mut expected: File) -> io::Result<()> {
    let mut remaining = actual.metadata()?.len();
    assert_eq!(remaining, expected.metadata()?.len());
    let mut actual_bytes = [0; 8192];
    let mut expected_bytes = [0; 8192];
    while remaining > 0 {
        let length = usize::try_from(remaining.min(8192)).map_err(io::Error::other)?;
        let actual_chunk = actual_bytes
            .get_mut(..length)
            .ok_or_else(|| io::Error::other("actual comparison buffer too small"))?;
        let expected_chunk = expected_bytes
            .get_mut(..length)
            .ok_or_else(|| io::Error::other("expected comparison buffer too small"))?;
        actual.read_exact(actual_chunk)?;
        expected.read_exact(expected_chunk)?;
        assert_eq!(actual_chunk, expected_chunk);
        remaining -= length as u64;
    }
    Ok(())
}

#[test]
fn storage_manifest_preserves_complete_wire_without_input_sized_projection()
-> Result<(), Box<dyn std::error::Error>> {
    check_wire(
        &Manifest {
            storages: vec![],
            artifacts: vec![],
            cleanup_paths: vec![],
            instruction_cleanups: vec![],
        },
        r#"{"storageMounts":[],"cleanupPaths":[]}"#,
    )?;
    check_wire(
        &Manifest {
            storages: vec![StorageEntry {
                mount_path: "/data/引号\"\\\n".into(),
                archive_url: Some("https://example.test/archive?key=\"\\".into()),
                cached: true,
                vas_storage_name: Some("read\"only".into()),
                vas_version_id: Some("version\\one".into()),
            }],
            artifacts: vec![
                ArtifactEntry {
                    mount_path: "/artifact".into(),
                    archive_url: Some("https://example.test/artifact".into()),
                    empty: true,
                    cached: true,
                    vas_storage_name: Some("writeback".into()),
                    vas_storage_id: Some("storage-id".into()),
                    vas_version_id: Some("version-id".into()),
                    missing_root_policy: Some("preserveParentVersion".into()),
                },
                ArtifactEntry {
                    mount_path: "/optional".into(),
                    archive_url: None,
                    empty: false,
                    cached: false,
                    vas_storage_name: None,
                    vas_storage_id: None,
                    vas_version_id: None,
                    missing_root_policy: None,
                },
            ],
            cleanup_paths: vec!["/stale\n路径".into()],
            instruction_cleanups: vec![
                InstructionCleanupEntry {
                    mount_path: "/data".into(),
                    target_filename: Some("AGENTS.md".into()),
                },
                InstructionCleanupEntry {
                    mount_path: "/optional".into(),
                    target_filename: None,
                },
            ],
        },
        concat!(
            r#"{"storageMounts":[{"name":"read\"only","versionId":"version\\one","mountPath":"/data/引号\"\\\n","archiveUrl":"https://example.test/archive?key=\"\\","cached":true,"writeback":false},"#,
            r#"{"name":"writeback","storageId":"storage-id","versionId":"version-id","mountPath":"/artifact","archiveUrl":"https://example.test/artifact","cached":true,"empty":true,"missingRootPolicy":"preserveParentVersion","writeback":true},"#,
            r#"{"mountPath":"/optional","cached":false,"writeback":true}],"cleanupPaths":["/stale\n路径"],"instructionCleanups":[{"mountPath":"/data","targetFilename":"AGENTS.md"},{"mountPath":"/optional"}]}"#,
        ),
    )?;

    // The full input and independent expected file exist before observation.
    // This remains valid ordinary manifest data beyond the dedicated metadata cap.
    let prefix = "https://example.test/archive?key=";
    let mut archive_url = String::with_capacity(prefix.len() + 8 * 1024 * 1024);
    archive_url.push_str(prefix);
    archive_url.extend(std::iter::repeat_n('x', 8 * 1024 * 1024));
    let directory = tempfile::tempdir()?;
    let expected_path = directory.path().join("expected.json");
    let actual_path = directory.path().join("actual.json");
    let mut expected = BufWriter::new(File::create(&expected_path)?);
    expected.write_all(b"{\"storageMounts\":[{\"mountPath\":\"/data\",\"archiveUrl\":")?;
    serde_json::to_writer(&mut expected, &archive_url)?;
    expected.write_all(b",\"cached\":false,\"writeback\":false}],\"cleanupPaths\":[]}")?;
    expected.flush()?;
    drop(expected);
    let manifest = Manifest {
        storages: vec![StorageEntry {
            mount_path: "/data".into(),
            archive_url: Some(archive_url),
            cached: false,
            vas_storage_name: None,
            vas_version_id: None,
        }],
        artifacts: vec![],
        cleanup_paths: vec![],
        instruction_cleanups: vec![],
    };
    let actual = File::create(&actual_path)?;
    let measurement = AllocationMeasurement::start();
    let result = (|| -> io::Result<()> {
        let mut writer = BufWriter::new(actual);
        serde_json::to_writer(&mut writer, &manifest).map_err(io::Error::other)?;
        writer.flush()
    })();
    drop(measurement);
    result?;
    let largest = LARGEST.load(Ordering::Relaxed);

    check_complete_files(File::open(&actual_path)?, File::open(&expected_path)?)?;
    let decoded: Manifest = serde_json::from_reader(BufReader::new(File::open(&actual_path)?))?;
    assert!(
        decoded == manifest,
        "complete large manifest did not round trip"
    );
    eprintln!("storage manifest: largest serialization allocation = {largest} bytes");
    // A test-only regression threshold for the extra projection, not an input
    // limit, process-RSS measurement or bound on caller-owned encoded buffers.
    assert!(largest <= 512 * 1024, "input-sized projection: {largest}");
    Ok(())
}
