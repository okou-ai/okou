use std::path::Path;

use guest_contracts::file_write::WRITE_FILES_BATCH_FILE_LIMIT;
use guest_contracts::workflow_documents::{MAX_METADATA_BYTES, WorkflowDocumentSource, decode};

fn entries(count: usize) -> Vec<WorkflowDocumentSource> {
    (0..count)
        .map(|index| WorkflowDocumentSource {
            mount_path: format!("/home/user/.codex/skills/workflow-{index}"),
            source: format!("/private/run/workflow-{}", uuid::Uuid::new_v4()),
        })
        .collect()
}

#[test]
fn workflow_metadata_obeys_exact_count_and_encoded_byte_bounds() {
    for count in [
        0,
        1,
        WRITE_FILES_BATCH_FILE_LIMIT,
        WRITE_FILES_BATCH_FILE_LIMIT + 1,
    ] {
        let bytes = serde_json::to_vec(&entries(count)).unwrap();
        assert_eq!(
            decode(&bytes, Path::new("/private/run")).is_ok(),
            (1..=WRITE_FILES_BATCH_FILE_LIMIT).contains(&count)
        );
    }
    let mut bytes = serde_json::to_vec(&entries(1)).unwrap();
    bytes.resize(MAX_METADATA_BYTES, b' ');
    assert!(decode(&bytes, Path::new("/private/run")).is_ok());
    bytes.push(b' ');
    assert!(decode(&bytes, Path::new("/private/run")).is_err());
}

#[test]
fn workflow_metadata_rejects_ambiguous_or_out_of_run_sources_before_application() {
    for source in [
        "/outside/workflow-00000000-0000-0000-0000-000000000000",
        "/private/run/../run/workflow-00000000-0000-0000-0000-000000000000",
        "/private/run/workflow-invalid",
        "/private/run/workflow-00000000000000000000000000000000",
    ] {
        let mut values = entries(2);
        values[1].source = source.into();
        assert!(
            decode(
                &serde_json::to_vec(&values).unwrap(),
                Path::new("/private/run")
            )
            .is_err()
        );
    }
    for duplicate_source in [false, true] {
        let mut values = entries(2);
        if duplicate_source {
            values[1].source = values[0].source.clone();
        } else {
            values[1].mount_path = values[0].mount_path.clone();
        }
        assert!(
            decode(
                &serde_json::to_vec(&values).unwrap(),
                Path::new("/private/run")
            )
            .is_err()
        );
    }
    for bytes in [
        b"[]".as_slice(),
        b"[{}]",
        b"[] trailing",
        br#"[{"mount_path":"target","source":"source","body":"secret"}]"#,
    ] {
        let error = decode(bytes, Path::new("/private/run")).unwrap_err();
        assert_eq!(error.to_string(), "invalid Workflow document metadata");
    }
}
