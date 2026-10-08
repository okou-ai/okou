use super::{BinaryLoggingFixture, process};
use guest_contracts::storage_files::{self, StorageFile};
use serde_json::Value;

const PREFIX: &str = "guest_storage_apply_input_";

fn run_decoded(
    fixture: &BinaryLoggingFixture,
    input: &[u8],
) -> std::io::Result<std::process::Output> {
    process::CommandExecution::spawn(fixture.command().arg("--storage-files-stdin"), Some(input))?
        .wait()
}

fn input_actions(ops: &[Value]) -> Vec<(&str, bool)> {
    ops.iter()
        .filter_map(|entry| {
            let action = entry["action_type"].as_str()?;
            action
                .starts_with(PREFIX)
                .then(|| entry["success"].as_bool().map(|success| (action, success)))
                .flatten()
        })
        .collect()
}

fn input_with_files(fixture: &BinaryLoggingFixture, manifest: &[u8]) -> std::io::Result<Vec<u8>> {
    let mount = fixture.dir.path().join("mount");
    let files = vec![StorageFile {
        path: "private-filename".into(),
        mode: 0o644,
        mtime: 123,
        content: b"private-content".to_vec(),
    }];
    let mount = mount
        .to_str()
        .ok_or_else(|| std::io::Error::other("non-UTF-8 fixture path"))?;
    storage_files::encode_input(manifest, &[(mount, &files)])
}

fn valid_manifest(fixture: &BinaryLoggingFixture) -> serde_json::Result<Vec<u8>> {
    serde_json::to_vec(&serde_json::json!({"storageMounts":[{
        "mountPath": fixture.dir.path().join("mount"),
        "archiveUrl": "https://should-not-fetch.invalid/private-url"
    }]}))
}

#[test]
fn decoded_input_records_one_size_and_ordered_phases_without_private_data() {
    let fixture = BinaryLoggingFixture::new("input-attribution-success").unwrap();
    let input = input_with_files(&fixture, &valid_manifest(&fixture).unwrap()).unwrap();
    let (_, payload) = storage_files::split_input(&input).unwrap();
    assert!(payload.len() < 65_536);

    assert!(run_decoded(&fixture, &input).unwrap().status.success());
    let ops = fixture.ops_entries().unwrap();
    assert_eq!(
        input_actions(&ops),
        [
            ("guest_storage_apply_input_stale_cleanup", true),
            ("guest_storage_apply_input_read", true),
            ("guest_storage_apply_input_frame", true),
            ("guest_storage_apply_input_payload_bytes_lt_64_kib", true),
            ("guest_storage_apply_input_parse", true),
            ("guest_storage_apply_input_decode_validate", true),
            ("guest_storage_apply_input_bindings", true),
        ]
    );
    for entry in ops
        .iter()
        .filter(|entry| entry["action_type"].as_str().unwrap().starts_with(PREFIX))
    {
        assert!(entry.get("error").is_none());
        assert!(entry.get("outcome").is_none());
        assert!(entry.get("reason").is_none());
    }
    let serialized = serde_json::to_string(&ops).unwrap();
    for private in ["private-filename", "private-content", "private-url"] {
        assert!(
            !serialized.contains(private),
            "leaked {private} in {serialized}"
        );
    }
    assert!(!serialized.contains(fixture.dir.path().to_str().unwrap()));
    assert_eq!(
        std::fs::read(fixture.dir.path().join("mount/private-filename")).unwrap(),
        b"private-content"
    );
}

#[test]
fn invalid_frame_reports_unavailable_size_and_no_parse_or_write() {
    let fixture = BinaryLoggingFixture::new("input-attribution-invalid-frame").unwrap();
    let mut input = input_with_files(&fixture, &valid_manifest(&fixture).unwrap()).unwrap();
    input.pop(); // Declared payload length no longer matches the envelope.

    assert!(!run_decoded(&fixture, &input).unwrap().status.success());
    assert_eq!(
        input_actions(&fixture.ops_entries().unwrap()),
        [
            ("guest_storage_apply_input_stale_cleanup", true),
            ("guest_storage_apply_input_read", true),
            ("guest_storage_apply_input_frame", false),
            (
                "guest_storage_apply_input_payload_bytes_unavailable_or_inconsistent",
                true
            ),
        ]
    );
    assert!(!fixture.dir.path().join("mount/private-filename").exists());
}

#[test]
fn invalid_json_and_decode_and_binding_fail_at_their_own_phase() {
    for case in ["parse", "decode", "bindings"] {
        let fixture = BinaryLoggingFixture::new(case).unwrap();
        let manifest = if case == "parse" {
            b"{private-manifest".to_vec()
        } else if case == "bindings" {
            serde_json::to_vec(&serde_json::json!({"storageMounts":[{
                "mountPath": fixture.dir.path().join("other"),
                "archiveUrl": "https://should-not-fetch.invalid/private-url"
            }]}))
            .unwrap()
        } else {
            valid_manifest(&fixture).unwrap()
        };
        let mut input = input_with_files(&fixture, &manifest).unwrap();
        if case == "decode" {
            // The framed payload remains valid, but the mount UTF-8 does not.
            input[16 + manifest.len() + 8] = 0xff;
        }
        assert!(
            !run_decoded(&fixture, &input).unwrap().status.success(),
            "{case}"
        );
        let ops = fixture.ops_entries().unwrap();
        let phases = input_actions(&ops);
        let failed = format!("{PREFIX}{case}");
        let failed = if case == "decode" {
            format!("{failed}_validate")
        } else {
            failed
        };
        assert_eq!(
            phases.last(),
            Some(&(failed.as_str(), false)),
            "{case}: {phases:?}"
        );
        assert_eq!(
            phases
                .iter()
                .filter(|(action, _)| action.contains("payload_bytes_"))
                .count(),
            1
        );
        assert!(
            phases
                .iter()
                .any(|(action, _)| *action == "guest_storage_apply_input_frame")
        );
        assert!(!fixture.dir.path().join("mount/private-filename").exists());
        let logs = fixture.read_ops_log().unwrap();
        for private in [
            "private-manifest",
            "private-filename",
            "private-content",
            "private-url",
        ] {
            assert!(!logs.contains(private), "{case}: leaked {private}");
        }
    }
}

#[test]
fn oversized_decoded_stdin_records_failed_read_and_unavailable_size() {
    let fixture = BinaryLoggingFixture::new("input-attribution-too-large").unwrap();
    let oversized = vec![0; storage_files::MAX_INPUT_BYTES + 1];
    assert!(!run_decoded(&fixture, &oversized).unwrap().status.success());
    assert_eq!(
        input_actions(&fixture.ops_entries().unwrap()),
        [
            ("guest_storage_apply_input_stale_cleanup", true),
            ("guest_storage_apply_input_read", false),
            (
                "guest_storage_apply_input_payload_bytes_unavailable_or_inconsistent",
                true
            ),
        ]
    );
}

#[test]
fn ordinary_manifest_modes_do_not_emit_decoded_input_phases() {
    let fixture = BinaryLoggingFixture::new("input-attribution-legacy-stdin").unwrap();
    assert!(
        fixture
            .run_manifest_stdin(br#"{"storageMounts":[]}"#)
            .unwrap()
            .status
            .success()
    );
    assert!(input_actions(&fixture.ops_entries().unwrap()).is_empty());

    let fixture = BinaryLoggingFixture::new("input-attribution-legacy-path").unwrap();
    let manifest_path = fixture.dir.path().join("manifest.json");
    std::fs::write(&manifest_path, br#"{"storageMounts":[]}"#).unwrap();
    assert!(
        fixture
            .run_manifest_path(&manifest_path)
            .unwrap()
            .status
            .success()
    );
    assert!(input_actions(&fixture.ops_entries().unwrap()).is_empty());
}
