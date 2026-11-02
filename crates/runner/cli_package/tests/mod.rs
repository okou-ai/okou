use super::*;
use flate2::{Compression, write::GzEncoder};

fn metadata() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "name": "@okouai/cli", "version": "9.353.0",
        "okouBuildIdentity": {
            "schemaVersion": 1, "piAgentRuntime": "1.36.0",
            "piSdk": "0.86.1+okou.0123456789ab"
        }
    }))
    .unwrap()
}

fn archive(entries: &[(&[u8], tar::EntryType)]) -> Vec<u8> {
    let encoder = GzEncoder::new(Vec::new(), Compression::fast());
    let mut archive = tar::Builder::new(encoder);
    for (bytes, kind) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(*kind);
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        if kind.is_symlink() {
            header.set_link_name("elsewhere.json").unwrap();
        }
        header.set_cksum();
        archive
            .append_data(&mut header, "package/package.json", *bytes)
            .unwrap();
    }
    archive.into_inner().unwrap().finish().unwrap()
}

fn manifest(package: &[u8]) -> serde_json::Value {
    serde_json::json!({
        "version": 1, "commitSha": "a".repeat(40),
        "package": {"path": "package.tgz", "sha256": hex::encode(Sha256::digest(package)), "size": package.len()},
        "versions": {"cli": "9.353.0", "piAgentRuntime": "1.36.0", "piSdk": "0.86.1+okou.0123456789ab"}
    })
}

#[test]
fn reads_package_bound_identity() {
    let bytes = metadata();
    let identity = read_identity(&archive(&[(&bytes, tar::EntryType::Regular)])).unwrap();
    assert_eq!(identity.cli, "9.353.0");
    assert_eq!(identity.pi_agent_runtime, "1.36.0");
    assert_eq!(identity.pi_sdk, "0.86.1+okou.0123456789ab");
}

#[test]
fn rejects_duplicate_nonregular_and_missing_metadata() {
    let bytes = metadata();
    assert!(
        read_identity(&archive(&[
            (&bytes, tar::EntryType::Regular),
            (&bytes, tar::EntryType::Regular)
        ]))
        .is_err()
    );
    assert!(read_identity(&archive(&[(&[], tar::EntryType::Symlink)])).is_err());
    assert!(read_identity(&archive(&[])).is_err());
}

#[test]
fn compilation_enforces_packed_metadata_size_boundary() {
    for size in [16_384, 16_385] {
        let mut bytes = metadata();
        // Legal trailing JSON whitespace prevents parsing errors from masking
        // a missing metadata-size check.
        bytes.resize(size, b' ');
        let package = archive(&[(&bytes, tar::EntryType::Regular)]);
        let external = serde_json::to_vec(&manifest(&package)).unwrap();
        let result = prepare(package, &external);
        if size == 16_384 {
            result.unwrap();
        } else {
            assert_eq!(
                result.unwrap_err(),
                "CLI package metadata size exceeds limit"
            );
        }
    }
}

#[test]
fn rejects_malformed_or_unbound_json_identity() {
    let good = String::from_utf8(metadata()).unwrap();
    let variants = [
        good.replace("\"schemaVersion\":1", "\"schemaVersion\":1.0"),
        good.replace(
            "\"schemaVersion\":1",
            "\"schemaVersion\":1,\"schemaVersion\":1",
        ),
        good.replace("1.36.0", "01.36.0"),
        "{\"name\":\"@okouai/cli\",\"version\":\"9.353.0\"}".into(),
    ];
    for variant in variants {
        assert!(
            read_identity(&archive(&[(variant.as_bytes(), tar::EntryType::Regular)])).is_err(),
            "{variant}"
        );
    }
    let mut invalid_utf8 = metadata();
    invalid_utf8.push(0xff);
    assert!(read_identity(&archive(&[(&invalid_utf8, tar::EntryType::Regular)])).is_err());
}

#[test]
fn compilation_rejects_logical_metadata_aliases() {
    let canonical = metadata();
    let valid_package = archive(&[(&canonical, tar::EntryType::Regular)]);
    assert!(
        prepare(
            valid_package.clone(),
            &serde_json::to_vec(&manifest(&valid_package)).unwrap()
        )
        .is_ok()
    );
    let aliased = String::from_utf8(canonical.clone())
        .unwrap()
        .replace("9.353.0", "9.353.1")
        .into_bytes();
    for alias in [
        "./package/package.json",
        "././package/package.json",
        "package/./package.json",
        "package//package.json",
    ] {
        let encoder = GzEncoder::new(Vec::new(), Compression::fast());
        let mut archive = tar::Builder::new(encoder);
        for (name, bytes) in [
            ("package/package.json", canonical.as_slice()),
            (alias, aliased.as_slice()),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            // Write raw names because append_data may normalize path aliases.
            header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
            header.set_cksum();
            archive.append(&header, bytes).unwrap();
        }
        let package = archive.into_inner().unwrap().finish().unwrap();
        let external = serde_json::to_vec(&manifest(&package)).unwrap();
        assert!(
            prepare(package, &external).is_err(),
            "accepted alias {alias}"
        );
    }
}

#[test]
fn rejects_decompression_beyond_the_archive_budget() {
    let package_with_padding = |padding_size| {
        let encoder = GzEncoder::new(Vec::new(), Compression::fast());
        let mut archive = tar::Builder::new(encoder);
        let metadata = metadata();
        let mut header = tar::Header::new_gnu();
        header.set_size(metadata.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive
            .append_data(&mut header, "package/package.json", metadata.as_slice())
            .unwrap();
        header.set_size(padding_size);
        header.set_cksum();
        archive
            .append_data(
                &mut header,
                "package/padding",
                io::repeat(0).take(padding_size),
            )
            .unwrap();
        archive.into_inner().unwrap().finish().unwrap()
    };
    // The same valid metadata must succeed without oversized padding, so
    // missing identity cannot mask a decompression-budget regression.
    assert!(read_identity(&package_with_padding(1)).is_ok());
    let bytes = package_with_padding(MAX_ARCHIVE_BYTES + 1);
    assert!(bytes.len() < MAX_PACKAGE_BYTES);
    assert!(read_identity(&bytes).is_err());
}

#[test]
fn prepares_exact_package_and_installed_bytes_without_provenance() {
    let bytes = archive(&[(&metadata(), tar::EntryType::Regular)]);
    let baseline = manifest(&bytes);
    let prepared = prepare(bytes.clone(), &serde_json::to_vec(&baseline).unwrap()).unwrap();
    assert_eq!(prepared.package, bytes);
    assert_eq!(
        prepared.installed.package.sha256,
        hex::encode(Sha256::digest(&bytes))
    );
    assert_eq!(prepared.installed.package.size, bytes.len() as u64);
    assert_eq!(
        prepared.installed.entrypoint,
        "/usr/local/lib/okou-cli/9.353.0/okou.js"
    );
    assert_eq!(
        InstalledOkouCli::parse(&prepared.installed_manifest).unwrap(),
        prepared.installed
    );
    assert!(prepared.installed_manifest.ends_with(b"\n"));
    let mut provenance = baseline;
    provenance["commitSha"] = serde_json::json!("b".repeat(40));
    let other = prepare(bytes, &serde_json::to_vec(&provenance).unwrap()).unwrap();
    assert_eq!(prepared.installed_manifest, other.installed_manifest);
    assert_eq!(prepared.package, other.package);
}

#[test]
fn compilation_rejects_external_only_identity_mutations() {
    let bytes = archive(&[(&metadata(), tar::EntryType::Regular)]);
    let baseline = manifest(&bytes);
    for (field, value, expected) in [
        ("/versions/cli", "9.353.1", "CLI identity mismatch"),
        (
            "/versions/piAgentRuntime",
            "1.36.1",
            "CLI identity mismatch",
        ),
        (
            "/versions/piSdk",
            "0.86.1+okou.aaaaaaaaaaaa",
            "CLI identity mismatch",
        ),
    ] {
        let mut changed = baseline.clone();
        *changed.pointer_mut(field).unwrap() = serde_json::json!(value);
        assert_eq!(
            prepare(bytes.clone(), &serde_json::to_vec(&changed).unwrap()).unwrap_err(),
            expected
        );
    }
}

#[test]
fn compilation_rejects_wrong_integrity() {
    let bytes = archive(&[(&metadata(), tar::EntryType::Regular)]);
    let baseline = manifest(&bytes);
    for (field, value, expected) in [
        (
            "/package/size",
            serde_json::json!(42),
            "CLI package size mismatch",
        ),
        (
            "/package/sha256",
            serde_json::json!("a".repeat(64)),
            "CLI package digest mismatch",
        ),
    ] {
        let mut changed = baseline.clone();
        *changed.pointer_mut(field).unwrap() = value;
        assert_eq!(
            prepare(bytes.clone(), &serde_json::to_vec(&changed).unwrap()).unwrap_err(),
            expected
        );
    }
}

#[test]
fn rejects_corrupt_and_truncated_gzip_even_with_matching_outer_integrity() {
    let bytes = archive(&[(&metadata(), tar::EntryType::Regular)]);
    let mut corrupt = bytes.clone();
    let crc = corrupt.len() - 8;
    corrupt[crc] ^= 1;
    for invalid in [corrupt, bytes[..bytes.len() - 4].to_vec()] {
        let external = manifest(&invalid);
        assert!(prepare(invalid, &serde_json::to_vec(&external).unwrap()).is_err());
    }
}
