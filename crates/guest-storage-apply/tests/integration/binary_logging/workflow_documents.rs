use super::{BinaryLoggingFixture, assert_single_download_total_success};
use crate::process;

#[test]
fn workflow_stdin_binary_rejects_unbounded_or_invalid_metadata_without_consuming_sources() {
    for oversized in [false, true] {
        let fixture = BinaryLoggingFixture::new("workflow-stdin-rejection").unwrap();
        std::fs::create_dir_all(&fixture.logs.runtime_dir).unwrap();
        let source = fixture
            .logs
            .runtime_dir
            .join("workflow-00000000-0000-0000-0000-000000000001");
        std::fs::write(&source, "private document must remain").unwrap();
        let input = if oversized {
            vec![b' '; guest_contracts::workflow_documents::MAX_METADATA_BYTES + 1]
        } else {
            serde_json::to_vec(&serde_json::json!([{
                "mount_path": fixture.dir.path().join("outside-framework"),
                "source": source,
            }]))
            .unwrap()
        };
        let output =
            process::CommandExecution::spawn(fixture.command().arg("--skills-stdin"), Some(&input))
                .unwrap()
                .wait()
                .unwrap();
        assert!(!output.status.success());
        assert_eq!(
            std::fs::read(&source).unwrap(),
            b"private document must remain"
        );
        assert!(!String::from_utf8_lossy(&output.stderr).contains("private document must remain"));
        assert_single_download_total_success(&fixture.ops_entries().unwrap(), false);
    }
}
