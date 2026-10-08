//! Build-only preparation of the CLI package and its compiled installation metadata.

use std::io::{self, Read};
use std::path::{Component, Path};

use flate2::read::MultiGzDecoder;
use guest_contracts::okou_cli::{
    InstalledOkouCli, OKOU_CLI_INSTALLED_MANIFEST_SCHEMA_VERSION, OkouCliInstalledPackage,
    OkouCliSessionConstruction, OkouCliVersions,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const MAX_PACKAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 16 * 1024;

/// Identity decoded from the mandatory packed metadata.
#[derive(Debug, PartialEq, Eq)]
struct CliIdentity {
    versions: OkouCliVersions,
    session_construction: OkouCliSessionConstruction,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackedPackage {
    name: String,
    version: String,
    okou_build_identity: BuildIdentity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildIdentity {
    schema_version: u32,
    pi_agent_runtime: String,
    pi_sdk: String,
    session_construction: OkouCliSessionConstruction,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliManifest {
    version: u32,
    package: CliPackage,
    versions: OkouCliVersions,
    session_construction: OkouCliSessionConstruction,
}

#[derive(Deserialize)]
struct CliPackage {
    path: String,
    sha256: String,
    size: u64,
}

/// Resources derived from one validated buffer, ready for compilation.
#[derive(Debug)]
pub(crate) struct PreparedCli {
    /// Exact verified package bytes, not a path to a mutable external input.
    pub(crate) package: Vec<u8>,
    /// Installed identity determined by those bytes and fixed installation rules.
    pub(crate) installed: InstalledOkouCli,
    /// Serialized installed metadata embedded with the package.
    pub(crate) installed_manifest: Vec<u8>,
}

/// Validate external build inputs and prepare both immutable compiled resources.
pub(crate) fn prepare(package: Vec<u8>, manifest: &[u8]) -> Result<PreparedCli, String> {
    if manifest.is_empty() || manifest.len() > MAX_METADATA_BYTES as usize {
        return Err("CLI manifest size is out of bounds".into());
    }
    let manifest: CliManifest = serde_json::from_slice(manifest).map_err(|e| e.to_string())?;
    if manifest.version != 1 || manifest.package.path != "package.tgz" {
        return Err("unexpected CLI manifest version or package path".into());
    }
    if !valid_lower_hex(&manifest.package.sha256, 64) {
        return Err("invalid CLI package SHA-256".into());
    }
    if package.is_empty() || package.len() > MAX_PACKAGE_BYTES {
        return Err("CLI package size is out of bounds".into());
    }
    let package_size = package.len() as u64;
    if manifest.package.size != package_size {
        return Err("CLI package size mismatch".into());
    }
    let package_sha256 = hex::encode(Sha256::digest(&package));
    if manifest.package.sha256 != package_sha256 {
        return Err("CLI package digest mismatch".into());
    }
    let identity = read_identity(&package)?;
    if manifest.versions != identity.versions {
        return Err("CLI identity mismatch".into());
    }
    if manifest.session_construction != identity.session_construction {
        return Err("CLI session-construction identity mismatch".into());
    }
    // Use the actual packed identity and integrity, not the external declarations.
    let installed = InstalledOkouCli {
        schema_version: OKOU_CLI_INSTALLED_MANIFEST_SCHEMA_VERSION,
        entrypoint: InstalledOkouCli::entrypoint_for(&identity.versions.cli),
        versions: identity.versions,
        package: OkouCliInstalledPackage {
            sha256: package_sha256,
            size: package_size,
        },
        session_construction: Some(identity.session_construction),
    };
    let mut installed_manifest = serde_json::to_vec(&installed).map_err(|e| e.to_string())?;
    installed_manifest.push(b'\n');
    Ok(PreparedCli {
        package,
        installed,
        installed_manifest,
    })
}

fn valid_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_release_version(value: &str) -> bool {
    let parts: Vec<_> = value.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 10
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))
        })
}

/// Decode exactly one regular metadata entry without extracting or running code.
/// Bound the entire decompressed stream, including skipped entries and gzip EOF.
fn read_identity(package: &[u8]) -> Result<CliIdentity, String> {
    if package.is_empty() || package.len() > MAX_PACKAGE_BYTES {
        return Err("CLI package size is out of bounds".into());
    }
    let mut decoded = MultiGzDecoder::new(package).take(MAX_ARCHIVE_BYTES + 1);
    let mut metadata = None;
    {
        let mut archive = tar::Archive::new(&mut decoded);
        for entry in archive.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path().map_err(|e| e.to_string())?;
            if path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
                return Err("unsafe CLI package path".into());
            }
            if path.as_ref() != Path::new("package/package.json") {
                continue;
            }
            if entry.path_bytes().as_ref() != b"package/package.json"
                || metadata.is_some()
                || !entry.header().entry_type().is_file()
            {
                return Err("CLI package requires one regular package.json".into());
            }
            if entry.size() == 0 || entry.size() > MAX_METADATA_BYTES {
                return Err("CLI package metadata size exceeds limit".into());
            }
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            metadata = Some(bytes);
        }
    }
    io::copy(&mut decoded, &mut io::sink()).map_err(|e| e.to_string())?;
    if decoded.limit() == 0 {
        return Err("CLI package decompressed size exceeds limit".into());
    }
    let bytes = metadata.ok_or("CLI package is missing package.json")?;
    let packed: PackedPackage = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let build = packed.okou_build_identity;
    if packed.name != "@okouai/cli" || build.schema_version != 1 {
        return Err("unexpected CLI package name or identity schema".into());
    }
    if !valid_release_version(&packed.version) || !valid_release_version(&build.pi_agent_runtime) {
        return Err("invalid CLI package release version".into());
    }
    let (sdk, patch) = build
        .pi_sdk
        .split_once("+okou.")
        .ok_or("invalid Pi SDK identity")?;
    if !valid_release_version(sdk) || !valid_lower_hex(patch, 12) {
        return Err("invalid Pi SDK identity".into());
    }
    if !valid_lower_hex(&build.session_construction.digest, 64) {
        return Err("invalid CLI package session digest".into());
    }
    Ok(CliIdentity {
        versions: OkouCliVersions {
            cli: packed.version,
            pi_agent_runtime: build.pi_agent_runtime,
            pi_sdk: build.pi_sdk,
        },
        session_construction: build.session_construction,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};

    fn metadata() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "name": "@okouai/cli", "version": "9.353.0",
            "okouBuildIdentity": {
                "schemaVersion": 1, "piAgentRuntime": "1.36.0",
                "piSdk": "0.86.1+okou.0123456789ab",
                "sessionConstruction": {"digest": "d".repeat(64)}
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
            "versions": {"cli": "9.353.0", "piAgentRuntime": "1.36.0", "piSdk": "0.86.1+okou.0123456789ab"},
            "sessionConstruction": {"digest": "d".repeat(64)}
        })
    }

    #[test]
    fn reads_package_bound_identity() {
        let bytes = metadata();
        let identity = read_identity(&archive(&[(&bytes, tar::EntryType::Regular)])).unwrap();
        assert_eq!(identity.versions.cli, "9.353.0");
        assert_eq!(identity.versions.pi_agent_runtime, "1.36.0");
        assert_eq!(identity.versions.pi_sdk, "0.86.1+okou.0123456789ab");
        assert_eq!(identity.session_construction.digest, "d".repeat(64));
    }

    #[test]
    fn rejects_duplicate_nonregular_missing_and_oversized_metadata() {
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
        let oversized = vec![b' '; MAX_METADATA_BYTES as usize + 1];
        assert!(read_identity(&archive(&[(&oversized, tar::EntryType::Regular)])).is_err());
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
    fn rejects_decompression_beyond_the_archive_budget() {
        let encoder = GzEncoder::new(Vec::new(), Compression::fast());
        let mut archive = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_size(MAX_ARCHIVE_BYTES + 1);
        header.set_mode(0o644);
        header.set_cksum();
        archive
            .append_data(
                &mut header,
                "package/padding",
                io::repeat(0).take(MAX_ARCHIVE_BYTES + 1),
            )
            .unwrap();
        let bytes = archive.into_inner().unwrap().finish().unwrap();
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
        let other_digest = "e".repeat(64);
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
            (
                "/sessionConstruction/digest",
                other_digest.as_str(),
                "CLI session-construction identity mismatch",
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
    fn compilation_rejects_wrong_integrity_and_missing_identity() {
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
        let mut missing = baseline;
        missing
            .as_object_mut()
            .unwrap()
            .remove("sessionConstruction");
        assert!(prepare(bytes, &serde_json::to_vec(&missing).unwrap()).is_err());
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
}
