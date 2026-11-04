//! Build-only preparation of the CLI package and its compiled installation metadata.

use std::io::{self, Read};
use std::path::{Component, Path};

use flate2::read::MultiGzDecoder;
use guest_contracts::okou_cli::{
    InstalledOkouCli, OKOU_CLI_INSTALLED_MANIFEST_SCHEMA_VERSION, OkouCliInstalledPackage,
    OkouCliVersions,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const MAX_PACKAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 16 * 1024;

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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliManifest {
    version: u32,
    package: CliPackage,
    versions: OkouCliVersions,
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
    if manifest.versions != identity {
        return Err("CLI identity mismatch".into());
    }
    // Use the actual packed identity and integrity, not the external declarations.
    let installed = InstalledOkouCli {
        schema_version: OKOU_CLI_INSTALLED_MANIFEST_SCHEMA_VERSION,
        entrypoint: InstalledOkouCli::entrypoint_for(&identity.cli),
        versions: identity,
        package: OkouCliInstalledPackage {
            sha256: package_sha256,
            size: package_size,
        },
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
fn read_identity(package: &[u8]) -> Result<OkouCliVersions, String> {
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
            // Match the logical destination before enforcing its canonical raw name;
            // leading `./` must not hide another package.json from identity checks.
            if !path
                .components()
                .filter(|part| *part != Component::CurDir)
                .eq(Path::new("package/package.json").components())
            {
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
    Ok(OkouCliVersions {
        cli: packed.version,
        pi_agent_runtime: build.pi_agent_runtime,
        pi_sdk: build.pi_sdk,
    })
}

#[cfg(test)]
mod tests;
