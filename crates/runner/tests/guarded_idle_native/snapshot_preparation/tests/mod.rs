//! Ordinary external-file evidence tests. These bytes are not a native VM execution.

use super::*;

struct Fixture {
    _directory: tempfile::TempDir,
    config: SnapshotCreateConfig,
    producer: PathBuf,
}

impl Fixture {
    fn new() -> TestResult<Self> {
        let directory = tempfile::tempdir()?;
        for name in ["producer", "vmm", "kernel", "rootfs"] {
            std::fs::write(
                directory.path().join(name),
                format!("ordinary {name} bytes"),
            )?;
        }
        let config = SnapshotCreateConfig {
            id: "ordinary-snapshot-inputs".into(),
            binary_path: directory.path().join("vmm"),
            kernel_path: directory.path().join("kernel"),
            rootfs_path: directory.path().join("rootfs"),
            output_dir: directory.path().join("snapshot"),
            vcpu_count: 2,
            memory_mb: 4096,
            home_disk_mb: fixture::HOME_DISK_MB,
        };
        let producer = directory.path().join("producer");
        Ok(Self {
            _directory: directory,
            config,
            producer,
        })
    }

    fn capture(&self) -> TestResult<Creation> {
        Creation::capture(&self.config, &"a".repeat(40), &self.producer)
    }

    fn output(&self) -> TestResult<()> {
        std::fs::create_dir(&self.config.output_dir)?;
        let output = SnapshotOutputPaths::new(self.config.output_dir.clone());
        for path in output.required_artifacts() {
            std::fs::write(path, b"ordinary snapshot output bytes")?;
        }
        std::fs::write(output.complete_marker(), SNAPSHOT_COMPLETE_MARKER_CONTENT)?;
        Ok(())
    }

    fn artifacts(&self) -> TestResult<Artifacts> {
        let output = SnapshotOutputPaths::new(self.config.output_dir.clone());
        let mut snapshot_files = BTreeMap::new();
        for path in output
            .required_artifacts()
            .into_iter()
            .chain([output.complete_marker()])
        {
            snapshot_files.insert(
                path.file_name().unwrap().to_str().unwrap().to_owned(),
                hex::encode(Sha256::digest(std::fs::read(path)?)),
            );
        }
        Ok(Artifacts {
            source_sha: "a".repeat(40),
            test_binary_sha256: hex::encode(Sha256::digest(b"ordinary producer bytes")),
            firecracker_sha256: hex::encode(Sha256::digest(b"ordinary vmm bytes")),
            kernel_sha256: hex::encode(Sha256::digest(b"ordinary kernel bytes")),
            rootfs_sha256: hex::encode(Sha256::digest(b"ordinary rootfs bytes")),
            snapshot_id: self.config.id.clone(),
            snapshot_files,
            policy_sha256: "0".repeat(64),
            snapshot_preparation_sha256: hex::encode(Sha256::digest(std::fs::read(self.record())?)),
        })
    }

    fn record(&self) -> PathBuf {
        self.config.output_dir.join(RECORD_FILE)
    }
}

#[test]
fn published_record_binds_original_inputs_complete_outputs_and_creator_clocks() -> TestResult<()> {
    let fixture = Fixture::new()?;
    let creation = fixture.capture()?;
    fixture.output()?;
    creation.publish()?;
    let artifacts = fixture.artifacts()?;
    verify_record(&fixture.config.output_dir, &artifacts)?;
    let record: Record = serde_json::from_slice(&std::fs::read(fixture.record())?)?;
    assert_eq!(record.inputs.rootfs_sha256, artifacts.rootfs_sha256);
    assert_eq!(
        record.inputs.producer_test_binary_sha256,
        artifacts.test_binary_sha256
    );
    assert_eq!(record.snapshot_files, artifacts.snapshot_files);
    assert!(record.completed_monotonic_ns > record.started_monotonic_ns);
    assert!(record.started_unix_ns > 0 && record.completed_unix_ns > 0);
    assert!(uuid::Uuid::parse_str(&record.creator_boot_id).is_ok());

    // Consume the Rust writer's actual bytes in the independently implemented
    // Python reader; two separately manufactured fixtures could hide schema drift.
    let manifest = fixture.producer.with_file_name("report-artifacts.json");
    std::fs::write(
        &manifest,
        serde_json::to_vec(&serde_json::json!({
            "source_sha": artifacts.source_sha,
            "test_binary_sha256": artifacts.test_binary_sha256,
            "firecracker_sha256": artifacts.firecracker_sha256,
            "kernel_sha256": artifacts.kernel_sha256,
            "rootfs_sha256": artifacts.rootfs_sha256,
            "snapshot_id": artifacts.snapshot_id,
            "snapshot_files": artifacts.snapshot_files,
            "snapshot_preparation_sha256": artifacts.snapshot_preparation_sha256,
            "profile": {"vcpu": 2, "memory_mib": 4096, "home_mib": fixture::HOME_DISK_MB},
        }))?,
    )?;
    let result = std::process::Command::new("python3")
        .args(["-B", "-c", r#"
import json, pathlib, sys
sys.path.insert(0, sys.argv[1])
import report
report.validate_snapshot_preparation(pathlib.Path(sys.argv[2]), json.loads(pathlib.Path(sys.argv[3]).read_bytes()))
"#])
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/guarded_idle_native"))
        .arg(&fixture.config.output_dir)
        .arg(manifest)
        .output()?;
    assert!(
        result.status.success(),
        "Rust-created record failed Python preflight: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    Ok(())
}

#[test]
fn changed_creation_inputs_cannot_publish_a_record() -> TestResult<()> {
    for name in ["producer", "vmm", "kernel", "rootfs"] {
        let fixture = Fixture::new()?;
        let creation = fixture.capture()?;
        fixture.output()?;
        std::fs::write(
            fixture.producer.with_file_name(name),
            b"changed original bytes",
        )?;
        assert!(
            creation
                .publish()
                .unwrap_err()
                .to_string()
                .contains("input changed")
        );
        assert!(!fixture.record().exists());
    }
    Ok(())
}

#[test]
fn incomplete_invalid_or_symlinked_outputs_do_not_publish() -> TestResult<()> {
    #[derive(Debug)]
    enum InvalidOutput {
        Missing,
        Marker,
        Directory,
        Symlink,
    }
    use InvalidOutput::*;
    for invalid in [Missing, Marker, Directory, Symlink] {
        let fixture = Fixture::new()?;
        let creation = fixture.capture()?;
        fixture.output()?;
        let output = SnapshotOutputPaths::new(fixture.config.output_dir.clone());
        match invalid {
            Missing => std::fs::remove_file(output.memory())?,
            Marker => std::fs::write(output.complete_marker(), b"snapshot-complete-v1\n")?,
            Directory => {
                std::fs::remove_file(output.cow())?;
                std::fs::create_dir(output.cow())?;
            }
            Symlink => {
                std::fs::remove_file(output.memory())?;
                std::os::unix::fs::symlink(output.snapshot(), output.memory())?;
            }
        }
        assert!(creation.publish().is_err(), "{invalid:?}");
        assert!(!fixture.record().exists(), "{invalid:?}");
    }
    Ok(())
}

#[test]
fn record_publication_preserves_an_existing_owners_file() -> TestResult<()> {
    let fixture = Fixture::new()?;
    let creation = fixture.capture()?;
    fixture.output()?;
    std::fs::write(fixture.record(), b"existing owner record")?;
    assert!(creation.publish().is_err());
    assert_eq!(std::fs::read(fixture.record())?, b"existing owner record");
    Ok(())
}

#[test]
fn existing_output_and_invalid_native_profile_are_refused_before_creation() -> TestResult<()> {
    let mut fixture = Fixture::new()?;
    fixture.config.memory_mb = 8192;
    assert!(fixture.capture().is_err());
    fixture.config.memory_mb = 4096;
    fixture.output()?;
    assert!(fixture.capture().is_err());
    Ok(())
}

#[test]
fn record_reader_refuses_mismatched_creation_fields_even_with_matching_record_hash()
-> TestResult<()> {
    for field in [
        "source_sha",
        "producer_test_binary_sha256",
        "firecracker_sha256",
        "kernel_sha256",
        "rootfs_sha256",
        "snapshot_id",
        "profile",
        "snapshot_files",
    ] {
        let fixture = Fixture::new()?;
        let creation = fixture.capture()?;
        fixture.output()?;
        creation.publish()?;
        let mut artifacts = fixture.artifacts()?;
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fixture.record())?)?;
        match field {
            "profile" => value["inputs"]["profile"]["memory_mib"] = 8192.into(),
            "snapshot_files" => value["snapshot_files"]["memory.bin"] = "0".repeat(64).into(),
            "snapshot_id" => value["inputs"][field] = "different-original-snapshot".into(),
            _ => {
                value["inputs"][field] = "0"
                    .repeat(if field == "source_sha" { 40 } else { 64 })
                    .into()
            }
        }
        let raw = serde_json::to_vec(&value)?;
        std::fs::write(fixture.record(), &raw)?;
        artifacts.snapshot_preparation_sha256 = hex::encode(Sha256::digest(&raw));
        assert!(
            verify_record(&fixture.config.output_dir, &artifacts).is_err(),
            "{field}"
        );
    }
    Ok(())
}

#[test]
fn record_reader_enforces_the_64_kib_limit_on_otherwise_valid_records() -> TestResult<()> {
    let fixture = Fixture::new()?;
    let creation = fixture.capture()?;
    fixture.output()?;
    creation.publish()?;
    let mut artifacts = fixture.artifacts()?;
    let mut raw = std::fs::read(fixture.record())?;

    // Pin the contract independently so changing the reader's limit cannot
    // move the test boundary with it.
    const LIMIT: usize = 64 * 1024;
    assert!(raw.len() < LIMIT);
    raw.resize(LIMIT, b' ');
    std::fs::write(fixture.record(), &raw)?;
    artifacts.snapshot_preparation_sha256 = hex::encode(Sha256::digest(&raw));
    verify_record(&fixture.config.output_dir, &artifacts)?;

    raw.push(b' ');
    let _: Record = serde_json::from_slice(&raw)?;
    std::fs::write(fixture.record(), &raw)?;
    artifacts.snapshot_preparation_sha256 = hex::encode(Sha256::digest(&raw));
    assert_eq!(
        verify_record(&fixture.config.output_dir, &artifacts)
            .unwrap_err()
            .to_string(),
        "snapshot preparation evidence exceeds its byte bound"
    );
    Ok(())
}

#[test]
fn record_reader_refuses_tampering_nonregular_and_duplicate_evidence() -> TestResult<()> {
    let fixture = Fixture::new()?;
    let creation = fixture.capture()?;
    fixture.output()?;
    creation.publish()?;
    let mut artifacts = fixture.artifacts()?;
    let original = std::fs::read(fixture.record())?;
    std::fs::write(fixture.record(), [original.as_slice(), b" "].concat())?;
    assert!(verify_record(&fixture.config.output_dir, &artifacts).is_err());
    for raw in [
        b"tampered".to_vec(),
        String::from_utf8(original.clone())?
            .replace("\"format\":", "\"format\":\"duplicate\",\"format\":")
            .into_bytes(),
        String::from_utf8(original.clone())?
            .replace(
                "\"memory.bin\":",
                &format!("\"memory.bin\":\"{}\",\"memory.bin\":", "0".repeat(64)),
            )
            .into_bytes(),
    ] {
        std::fs::write(fixture.record(), &raw)?;
        artifacts.snapshot_preparation_sha256 = hex::encode(Sha256::digest(&raw));
        assert!(verify_record(&fixture.config.output_dir, &artifacts).is_err());
    }
    // Keep valid bytes and the matching digest, so a digest/schema error cannot
    // hide a reader that incorrectly follows the receipt symlink.
    std::fs::write(fixture.record(), &original)?;
    artifacts.snapshot_preparation_sha256 = hex::encode(Sha256::digest(&original));
    verify_record(&fixture.config.output_dir, &artifacts)?;
    let matching_record = fixture.producer.with_file_name("matching-record.json");
    std::fs::rename(fixture.record(), &matching_record)?;
    std::os::unix::fs::symlink(matching_record, fixture.record())?;
    assert!(verify_record(&fixture.config.output_dir, &artifacts).is_err());
    Ok(())
}

#[test]
fn record_reader_requires_a_positive_numeric_start_clock() -> TestResult<()> {
    let fixture = Fixture::new()?;
    let creation = fixture.capture()?;
    fixture.output()?;
    creation.publish()?;
    let mut artifacts = fixture.artifacts()?;
    let mut value: serde_json::Value = serde_json::from_slice(&std::fs::read(fixture.record())?)?;

    // Keep the type and digest valid so only the semantic zero-clock guard
    // distinguishes rejection from the positive control.
    for started_unix_ns in [1_u64, 0] {
        value["started_unix_ns"] = started_unix_ns.into();
        let raw = serde_json::to_vec(&value)?;
        let record: Record = serde_json::from_slice(&raw)?;
        assert_eq!(record.started_unix_ns, u128::from(started_unix_ns));
        std::fs::write(fixture.record(), &raw)?;
        artifacts.snapshot_preparation_sha256 = hex::encode(Sha256::digest(&raw));
        let result = verify_record(&fixture.config.output_dir, &artifacts);
        if started_unix_ns == 0 {
            assert_eq!(
                result.unwrap_err().to_string(),
                "snapshot preparation input/output binding mismatch"
            );
        } else {
            result?;
        }
    }
    Ok(())
}

#[test]
fn record_reader_rejects_invalid_format_boot_and_observation_clocks() -> TestResult<()> {
    for (field, item) in [
        ("format", serde_json::json!("unobserved-v0")),
        ("creator_boot_id", serde_json::json!("invalid-boot")),
        ("started_monotonic_ns", serde_json::json!(0)),
        ("completed_monotonic_ns", serde_json::json!(1)),
        ("started_unix_ns", serde_json::json!(false)),
        ("completed_unix_ns", serde_json::json!(0)),
    ] {
        let fixture = Fixture::new()?;
        let creation = fixture.capture()?;
        fixture.output()?;
        creation.publish()?;
        let mut artifacts = fixture.artifacts()?;
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fixture.record())?)?;
        value[field] = item;
        let raw = serde_json::to_vec(&value)?;
        std::fs::write(fixture.record(), &raw)?;
        artifacts.snapshot_preparation_sha256 = hex::encode(Sha256::digest(&raw));
        assert!(
            verify_record(&fixture.config.output_dir, &artifacts).is_err(),
            "{field}"
        );
    }
    Ok(())
}
