//! Compiled CLI resources staged for installation into the rootfs customize layer.
//!
//! Compilation validates the external inputs and generates installed metadata.
//! Runtime releases those trusted embedded bytes without revalidating them.
//! Local builds may omit the bundle.

use std::path::{Path, PathBuf};

#[cfg(any(test, bundled_okou_cli))]
use crate::error::RunnerError;
use crate::error::RunnerResult;

use super::hashes::OkouCliHashInput;

#[cfg(any(test, bundled_okou_cli))]
const OKOU_CLI_PACKAGE_FILE: &str = "package.tgz";

/// Build-validated CLI resources staged for one rootfs build.
#[derive(Debug)]
pub(super) struct OkouCliArtifact {
    // Own the staging directory through customize-rootfs.sh execution.
    _temp_dir: tempfile::TempDir,
    package_path: PathBuf,
    installed_manifest_path: PathBuf,
    installed_manifest_bytes: Vec<u8>,
    cli_version: String,
    package_sha256: String,
}

impl OkouCliArtifact {
    /// Stage the compiled package and installed metadata without self-validation.
    pub(super) async fn resolve_embedded() -> RunnerResult<Option<Self>> {
        #[cfg(bundled_okou_cli)]
        {
            use crate::cmd::embedded_cli;

            return Self::stage_compiled(
                embedded_cli::package(),
                embedded_cli::installed_manifest(),
                env!("BUNDLED_OKOU_CLI_VERSION"),
                env!("BUNDLED_OKOU_CLI_SHA256"),
            )
            .await
            .map(Some);
        }
        #[cfg(not(bundled_okou_cli))]
        Ok(None)
    }

    #[cfg(any(test, bundled_okou_cli))]
    async fn stage_compiled(
        package_bytes: &[u8],
        installed_manifest_bytes: &[u8],
        cli_version: &str,
        package_sha256: &str,
    ) -> RunnerResult<Self> {
        let temp_dir = tempfile::tempdir()
            .map_err(|e| RunnerError::Internal(format!("stage Okou CLI resources: {e}")))?;
        let package_path = temp_dir.path().join(OKOU_CLI_PACKAGE_FILE);
        tokio::fs::write(&package_path, package_bytes)
            .await
            .map_err(|e| RunnerError::Internal(format!("stage Okou CLI package: {e}")))?;
        let installed_manifest_path = temp_dir.path().join("installed.json");
        tokio::fs::write(&installed_manifest_path, installed_manifest_bytes)
            .await
            .map_err(|e| {
                RunnerError::Internal(format!("stage installed Okou CLI manifest: {e}"))
            })?;

        Ok(Self {
            _temp_dir: temp_dir,
            package_path,
            installed_manifest_path,
            installed_manifest_bytes: installed_manifest_bytes.to_vec(),
            cli_version: cli_version.to_owned(),
            package_sha256: package_sha256.to_owned(),
        })
    }

    pub(super) fn cli_version(&self) -> &str {
        &self.cli_version
    }

    pub(super) fn package_path(&self) -> &Path {
        &self.package_path
    }

    pub(super) fn installed_manifest_path(&self) -> &Path {
        &self.installed_manifest_path
    }

    pub(super) fn installed_manifest_bytes(&self) -> &[u8] {
        &self.installed_manifest_bytes
    }

    pub(super) fn hash_input(&self) -> OkouCliHashInput<'_> {
        OkouCliHashInput {
            package_sha256: &self.package_sha256,
        }
    }
}

#[cfg(test)]
pub(super) mod test_support {
    use guest_contracts::okou_cli::{
        InstalledOkouCli, OKOU_CLI_INSTALLED_MANIFEST_SCHEMA_VERSION, OkouCliInstalledPackage,
        OkouCliSessionConstruction, OkouCliVersions,
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
            session_construction: Some(OkouCliSessionConstruction {
                digest: "d".repeat(64),
            }),
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
                "piSdk": "0.86.1+okou.0123456789ab",
                "sessionConstruction": {"digest": "d".repeat(64)}
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
}

#[cfg(test)]
mod tests {
    use guest_contracts::okou_cli::{InstalledOkouCli, OkouCliSessionConstruction};
    use sha2::{Digest, Sha256};

    use super::test_support::{package_bytes_with_identity, stage_fixture};
    use super::*;

    #[tokio::test]
    async fn staging_preserves_compiled_resources_and_owns_their_lifetime() {
        let expected_package = package_bytes_with_identity(b"tarball-bytes", "9.353.0", "1.36.0");
        let artifact = stage_fixture(b"tarball-bytes", "9.353.0", "1.36.0").await;
        let stage_path = artifact._temp_dir.path().to_path_buf();
        assert_eq!(artifact.cli_version(), "9.353.0");
        assert!(artifact.package_path().starts_with(&stage_path));
        assert_eq!(
            std::fs::read(artifact.package_path()).unwrap(),
            expected_package
        );
        assert_eq!(
            std::fs::read(artifact.installed_manifest_path()).unwrap(),
            artifact.installed_manifest_bytes()
        );
        let installed = InstalledOkouCli::parse(artifact.installed_manifest_bytes()).unwrap();
        assert_eq!(installed.versions.pi_agent_runtime, "1.36.0");
        assert_eq!(
            installed.session_construction,
            Some(OkouCliSessionConstruction {
                digest: "d".repeat(64)
            })
        );
        assert_eq!(
            installed.package.sha256,
            hex::encode(Sha256::digest(&expected_package))
        );
        assert_eq!(
            installed.package.sha256,
            artifact.hash_input().package_sha256
        );
        assert_eq!(installed.package.size, expected_package.len() as u64);
        assert_eq!(
            installed.entrypoint,
            "/usr/local/lib/okou-cli/9.353.0/okou.js"
        );
        drop(artifact);
        assert!(
            !stage_path.exists(),
            "owned staging resources must be cleaned up"
        );
    }

    #[cfg(bundled_okou_cli)]
    #[tokio::test]
    async fn embedded_bundle_stages_exact_compiled_resources() {
        use crate::cmd::embedded_cli;

        let artifact = OkouCliArtifact::resolve_embedded().await.unwrap().unwrap();
        assert_eq!(
            std::fs::read(artifact.package_path()).unwrap(),
            embedded_cli::package()
        );
        assert_eq!(
            artifact.installed_manifest_bytes(),
            embedded_cli::installed_manifest()
        );
        assert_eq!(
            std::fs::read(artifact.installed_manifest_path()).unwrap(),
            embedded_cli::installed_manifest()
        );
        let installed = InstalledOkouCli::parse(embedded_cli::installed_manifest()).unwrap();
        assert_eq!(installed.versions.cli, artifact.cli_version());
        assert_eq!(
            installed.package.sha256,
            artifact.hash_input().package_sha256
        );
        assert_eq!(
            installed.package.sha256,
            hex::encode(Sha256::digest(embedded_cli::package()))
        );
        assert_eq!(installed.package.size, embedded_cli::package().len() as u64);
    }

    #[cfg(not(bundled_okou_cli))]
    #[tokio::test]
    async fn local_unbundled_runner_has_no_embedded_cli() {
        assert!(OkouCliArtifact::resolve_embedded().await.unwrap().is_none());
    }
}
