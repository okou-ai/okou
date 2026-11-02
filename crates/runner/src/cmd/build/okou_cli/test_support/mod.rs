use guest_contracts::okou_cli::{
    InstalledOkouCli, OKOU_CLI_INSTALLED_MANIFEST_SCHEMA_VERSION, OkouCliInstalledPackage,
    OkouCliVersions,
};
use sha2::{Digest, Sha256};

use super::OkouCliArtifact;

/// Model already-compiled resources for runtime staging, hash and sidecar tests.
/// External artifact validation is covered by the build-only Cargo test target.
pub(crate) async fn stage_fixture(
    content: &[u8],
    cli_version: &str,
    runtime_version: &str,
) -> OkouCliArtifact {
    let package = package_bytes_with_identity(content, cli_version, runtime_version);
    let sha256 = hex::encode(Sha256::digest(&package));
    let installed = InstalledOkouCli {
        schema_version: OKOU_CLI_INSTALLED_MANIFEST_SCHEMA_VERSION,
        entrypoint: InstalledOkouCli::entrypoint_for(cli_version),
        versions: OkouCliVersions {
            cli: cli_version.into(),
            pi_agent_runtime: runtime_version.into(),
            pi_sdk: "0.86.1+okou.0123456789ab".into(),
        },
        package: OkouCliInstalledPackage {
            sha256: sha256.clone(),
            size: package.len() as u64,
        },
    };
    let mut metadata = serde_json::to_vec(&installed).unwrap();
    metadata.push(b'\n');
    OkouCliArtifact::stage_compiled(&package, &metadata, cli_version, &sha256)
        .await
        .unwrap()
}

pub(super) fn package_bytes_with_identity(content: &[u8], cli: &str, runtime: &str) -> Vec<u8> {
    let metadata = serde_json::to_vec(&serde_json::json!({
        "name": "@okouai/cli", "version": cli,
        "okouBuildIdentity": {
            "schemaVersion": 1, "piAgentRuntime": runtime,
            "piSdk": "0.86.1+okou.0123456789ab"
        }
    }))
    .unwrap();
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut archive = tar::Builder::new(encoder);
    for (path, bytes) in [
        ("package/package.json", metadata.as_slice()),
        ("package/okou.js", content),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive.append_data(&mut header, path, bytes).unwrap();
    }
    archive.into_inner().unwrap().finish().unwrap()
}
