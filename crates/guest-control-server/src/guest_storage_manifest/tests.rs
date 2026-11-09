use super::*;
use serde_json::json;

fn query(
    root: &Path,
    manifest: serde_json::Value,
    timeout_ms: u32,
    cancelled: bool,
) -> io::Result<(GuestStorageManifestOutput, Option<StorageResourceUsage>)> {
    let runtime = root.join("runtime");
    let mut resources = None;
    let output = run_manifest(RunManifestInput {
        instruction_operation: None,
        seq: 1,
        program: &GuestStorageManifestProgram::Production,
        timeout_ms,
        run_id: "direct-query",
        runtime_dir: runtime
            .to_str()
            .ok_or_else(|| io::Error::other("runtime encoding"))?,
        manifest_json: serde_json::to_vec(&manifest)?,
        connection_cancel: &AtomicBool::new(cancelled),
        process_containment_mode: ProcessContainmentMode::BuildConfigured,
        drain_deadline: Duration::from_secs(2),
        resources: &mut resources,
        notifications: &NotificationOwner::default(),
    });
    Ok((output, resources))
}

fn manifest(root: &Path) -> serde_json::Value {
    json!({
        "storageMounts":[{"mountPath":root.join("input"),"archiveUrl":"file:///tmp/pending.tar.gz"}],
        "archiveReadiness":{"id":"5d342f8e-4a56-4b67-b890-4561c2d3e456","sources":["file:///tmp/pending.tar.gz"],"checkOnly":true}
    })
}

#[test]
fn direct_production_query_preserves_read_only_admission_and_failures() {
    for case in [
        "eligible",
        "input-alias",
        "runtime-alias",
        "invalid-binding",
    ] {
        let root = tempfile::tempdir().unwrap();
        let sentinel = root.path().join("sentinel");
        std::fs::write(&sentinel, b"unchanged").unwrap();
        let mut input = manifest(root.path());
        if case == "input-alias" {
            std::os::unix::fs::symlink(root.path().join("runtime"), root.path().join("alias"))
                .unwrap();
            input["storageMounts"][0]["mountPath"] = json!(root.path().join("alias/value"));
        }
        if case == "runtime-alias" {
            std::os::unix::fs::symlink(root.path().join("sentinel"), root.path().join("runtime"))
                .unwrap();
        }
        if case == "invalid-binding" {
            input["archiveReadiness"]["sources"] = json!(["file:///tmp/unbound.tar.gz"]);
        }
        let (output, resources) = query(root.path(), input, 1000, false).unwrap();
        assert!(
            resources.is_none(),
            "a direct query has no child cgroup snapshot"
        );
        if matches!(case, "eligible" | "input-alias") {
            assert_eq!(output.termination, ExecTermination::Exited { exit_code: 0 });
            assert_eq!(
                serde_json::from_slice::<bool>(output.stdout.captured.as_ref().unwrap()).unwrap(),
                case == "eligible"
            );
        } else {
            assert_eq!(output.termination, ExecTermination::Exited { exit_code: 1 });
            assert!(!output.diagnostic.is_empty());
        }
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"unchanged");
        assert!(!root.path().join("input").exists());
        assert!(!root.path().join("runtime/archive-readiness").exists());
    }
}

#[test]
fn direct_production_query_observes_cancellation_and_existing_deadline() {
    for cancelled in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let (output, resources) = query(
            root.path(),
            manifest(root.path()),
            if cancelled { 1000 } else { 0 },
            cancelled,
        )
        .unwrap();
        assert_eq!(
            output.termination,
            if cancelled {
                ExecTermination::Cancelled
            } else {
                ExecTermination::TimedOut
            }
        );
        assert!(resources.is_none());
        assert!(!root.path().join("runtime").exists());
    }
}
