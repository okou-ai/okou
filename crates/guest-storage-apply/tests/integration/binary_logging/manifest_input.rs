use super::{
    BinaryLoggingFixture, assert_default_zero_task_attribution,
    assert_single_download_total_success, process,
};
use crate::support::{assert_does_not_contain_any, manifest_json, write_manifest};

const SIGNED_URL: &str = "https://example.invalid/archive?X-Amz-Signature=parse-secret-signature";

fn type_invalid_manifest() -> serde_json::Result<Vec<u8>> {
    let mounts = serde_json::to_string(&serde_json::json!([{
        "mountPath": "/workspace",
        "archiveUrl": SIGNED_URL,
    }]))?;
    serde_json::to_vec(&serde_json::json!({"storageMounts": mounts}))
}

fn assert_parse_failure(
    fixture: &BinaryLoggingFixture,
    output: &std::process::Output,
    category: &str,
) -> std::io::Result<()> {
    assert_eq!(output.status.code(), Some(1));
    let ops = fixture.ops_entries().map_err(std::io::Error::other)?;
    assert_single_download_total_success(&ops, false);

    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log = fixture.read_system_log()?;
    let ops_log = fixture.read_ops_log()?;
    let forbidden = [
        SIGNED_URL,
        "X-Amz-Signature",
        "parse-secret-signature",
        "super-secret-body",
    ];
    for (name, content) in [
        ("stderr", stderr.as_ref()),
        ("system log", system_log.as_str()),
        ("sandbox ops log", ops_log.as_str()),
    ] {
        assert_does_not_contain_any(name, content, &forbidden);
    }
    for content in [stderr.as_ref(), system_log.as_str()] {
        let diagnostic = content
            .lines()
            .find_map(|line| {
                line.split_once("[ERROR] [sandbox:guest-storage-apply] Failed to parse manifest: ")
                    .map(|(_, diagnostic)| diagnostic)
            })
            .ok_or_else(|| std::io::Error::other(format!("missing parse diagnostic: {content}")))?;
        let (line, column) = diagnostic
            .strip_prefix(&format!("category={category} line="))
            .and_then(|location| location.split_once(" column="))
            .ok_or_else(|| {
                std::io::Error::other(format!("unexpected parse diagnostic: {diagnostic}"))
            })?;
        assert!(line.parse::<usize>().is_ok_and(|line| line > 0));
        assert!(column.parse::<usize>().is_ok_and(|column| column > 0));
    }
    Ok(())
}

#[test]
fn binary_applies_decoded_files_without_remote_attribution() {
    use guest_contracts::storage_files::{self, StorageFile};
    let fixture = BinaryLoggingFixture::new("decoded-files").unwrap();
    let target = fixture.dir.path().join("mount");
    let json = serde_json::to_vec(&serde_json::json!({"storageMounts":[{
        "mountPath":target,"archiveUrl":"https://must-not-fetch.invalid/archive"
    }]}))
    .unwrap();
    let files = vec![StorageFile {
        path: "file".into(),
        mode: 0o644,
        mtime: 100,
        content: vec![23; 200_000],
    }];
    let input = storage_files::encode_input(&json, &[(target.to_str().unwrap(), &files)]).unwrap();
    let output = process::CommandExecution::spawn(
        fixture.command().arg("--storage-files-stdin"),
        Some(&input),
    )
    .unwrap()
    .wait()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read(target.join("file")).unwrap(),
        files[0].content
    );
    let ops = fixture.ops_entries().unwrap();
    let payload_rows: Vec<_> = ops
        .iter()
        .filter(|op| {
            op["action_type"].as_str().is_some_and(|action| {
                action.starts_with("guest_storage_apply_input_payload_bytes_")
            })
        })
        .collect();
    assert_eq!(payload_rows.len(), 1);
    assert_eq!(
        payload_rows[0]["action_type"],
        "guest_storage_apply_input_payload_bytes_64_kib_to_256_kib"
    );
    let total = ops
        .iter()
        .find(|op| op["action_type"] == "storage_download")
        .unwrap();
    assert_eq!(total["outcome"], "decoded_files");
    assert!(!ops.iter().any(|op| {
        op["action_type"]
            .as_str()
            .unwrap()
            .starts_with("storage_download_remote_")
    }));
    assert_single_download_total_success(&ops, true);
}

#[test]
fn binary_reads_manifest_from_stdin() {
    let fixture = BinaryLoggingFixture::new("stdin-success").unwrap();
    let json = manifest_json(&[], None).unwrap();

    let output = fixture.run_manifest_stdin(&json).unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let content = fixture.read_system_log().unwrap();
    assert!(
        content.contains("[INFO] [sandbox:guest-storage-apply] Download completed"),
        "unexpected system log: {content:?}"
    );
    let actions = fixture.action_types().unwrap();
    assert_default_zero_task_attribution(&actions);
    let ops = fixture.ops_entries().unwrap();
    assert_single_download_total_success(&ops, true);
}

#[test]
fn binary_reads_manifest_from_path() {
    let fixture = BinaryLoggingFixture::new("path-success").unwrap();
    let manifest_path = write_manifest(&fixture.dir, &[], None).unwrap();

    let output = fixture.run_manifest_path(&manifest_path).unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let content = fixture.read_system_log().unwrap();
    assert!(
        content.contains("[INFO] [sandbox:guest-storage-apply] Download completed"),
        "unexpected system log: {content:?}"
    );
    let actions = fixture.action_types().unwrap();
    assert_default_zero_task_attribution(&actions);
    let ops = fixture.ops_entries().unwrap();
    assert_single_download_total_success(&ops, true);
}

#[test]
fn binary_path_mode_rejects_extra_args_before_telemetry() {
    let fixture = BinaryLoggingFixture::new("path-extra-arg").unwrap();
    let manifest_path = write_manifest(&fixture.dir, &[], None).unwrap();

    let output = process::run(fixture.command().arg(&manifest_path).arg("--ignored")).unwrap();

    assert!(!output.status.success());
    let content = fixture.read_system_log().unwrap();
    assert!(
        content.contains("[ERROR] [sandbox:guest-storage-apply] Usage: guest-storage-apply"),
        "unexpected system log: {content:?}"
    );
    assert!(!fixture.logs.ops_log.exists());
}

#[test]
fn binary_manifest_stdin_rejects_extra_args_before_telemetry() {
    let fixture = BinaryLoggingFixture::new("stdin-extra-arg").unwrap();

    let output = process::run(fixture.command().arg("--manifest-stdin").arg("--ignored")).unwrap();

    assert!(!output.status.success());
    let content = fixture.read_system_log().unwrap();
    assert!(
        content.contains("[ERROR] [sandbox:guest-storage-apply] Usage: guest-storage-apply"),
        "unexpected system log: {content:?}"
    );
    assert!(!fixture.logs.ops_log.exists());
}

#[test]
fn binary_syntax_invalid_manifest_logs_parse_failure_without_body() {
    let body = b"{{not valid json super-secret-body";
    for mode in ["path", "stdin"] {
        let fixture = BinaryLoggingFixture::new(&format!("{mode}-invalid")).unwrap();
        let output = if mode == "stdin" {
            fixture.run_manifest_stdin(body).unwrap()
        } else {
            let path = fixture.dir.path().join("manifest.json");
            std::fs::write(&path, body).unwrap();
            fixture.run_manifest_path(&path).unwrap()
        };
        assert_parse_failure(&fixture, &output, "Syntax").unwrap();
    }
}

#[test]
fn binary_type_invalid_stdin_manifest_does_not_log_signed_url() {
    let fixture = BinaryLoggingFixture::new("stdin-type-invalid").unwrap();
    let output = fixture
        .run_manifest_stdin(&type_invalid_manifest().unwrap())
        .unwrap();
    assert_parse_failure(&fixture, &output, "Data").unwrap();
}

#[test]
fn binary_type_invalid_file_manifest_does_not_log_signed_url() {
    let fixture = BinaryLoggingFixture::new("file-type-invalid").unwrap();
    let path = fixture.dir.path().join("manifest.json");
    std::fs::write(&path, type_invalid_manifest().unwrap()).unwrap();
    let output = fixture.run_manifest_path(&path).unwrap();
    assert_parse_failure(&fixture, &output, "Data").unwrap();
}

#[test]
fn binary_writes_system_log_on_manifest_read_failure() {
    let fixture = BinaryLoggingFixture::new("missing-manifest").unwrap();
    let manifest_path = fixture.dir.path().join("missing-manifest.json");

    let output = fixture.run_manifest_path(&manifest_path).unwrap();

    assert!(!output.status.success());

    let content = fixture.read_system_log().unwrap();
    assert!(
        content.contains("[ERROR] [sandbox:guest-storage-apply] Failed to read manifest"),
        "unexpected system log: {content:?}"
    );
    assert!(
        content.contains("[ERROR] [sandbox:guest-storage-apply] Download failed"),
        "unexpected system log: {content:?}"
    );
    let ops = fixture.ops_entries().unwrap();
    assert_single_download_total_success(&ops, false);
}

#[test]
fn binary_without_manifest_path_logs_usage() {
    let fixture = BinaryLoggingFixture::new("missing-arg").unwrap();

    let output = process::run(&mut fixture.command()).unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(
            "[ERROR] [sandbox:guest-storage-apply] Usage: guest-storage-apply <manifest_path>"
        ),
        "unexpected stderr: {stderr}"
    );
    let content = fixture.read_system_log().unwrap();
    assert!(
        content.contains(
            "[ERROR] [sandbox:guest-storage-apply] Usage: guest-storage-apply <manifest_path>"
        ),
        "unexpected system log: {content:?}"
    );
    assert!(
        !fixture.logs.ops_log.exists(),
        "usage failure should not record download_total before a run starts"
    );
}
