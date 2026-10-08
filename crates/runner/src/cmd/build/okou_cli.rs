//! CLI package staged for installation into the rootfs customize layer.
//!
//! When bundled, the Runner uses its embedded `package.tgz` plus validated
//! identity constants from the same build. Local builds may omit it.

use std::path::{Path, PathBuf};

use guest_contracts::okou_cli::InstalledOkouCli;
#[cfg(test)]
use guest_contracts::okou_cli::parse_release_version;
#[cfg(any(test, bundled_okou_cli))]
use guest_contracts::okou_cli::{
    OKOU_CLI_INSTALLED_MANIFEST_SCHEMA_VERSION, OkouCliInstalledPackage,
    OkouCliSessionConstruction, OkouCliVersions,
};
#[cfg(test)]
use serde::Deserialize;
#[cfg(any(test, bundled_okou_cli))]
use sha2::{Digest, Sha256};

#[cfg(any(test, bundled_okou_cli))]
use crate::error::RunnerError;
use crate::error::RunnerResult;

use super::hashes::OkouCliHashInput;

#[cfg(any(test, bundled_okou_cli))]
pub(super) const OKOU_CLI_PACKAGE_FILE: &str = "package.tgz";
#[cfg(test)]
pub(super) const OKOU_CLI_MANIFEST_FILE: &str = "manifest.json";
#[cfg(test)]
const ARTIFACT_MANIFEST_VERSION: u32 = 1;
#[cfg(any(test, bundled_okou_cli))]
const MAX_CLI_PACKAGE_SIZE: usize = 64 * 1024 * 1024;

#[cfg(test)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactManifest {
    version: u32,
    #[allow(dead_code)]
    commit_sha: String,
    package: ArtifactPackage,
    versions: OkouCliVersions,
    session_construction: OkouCliSessionConstruction,
}

#[cfg(test)]
#[derive(Deserialize)]
struct ArtifactPackage {
    path: String,
    sha256: String,
    size: u64,
}

/// A verified CLI artifact staged for one rootfs build.
#[derive(Debug)]
pub(super) struct OkouCliArtifact {
    // Keeps the staged package and installed manifest alive for
    // customize-rootfs.sh execution.
    _temp_dir: tempfile::TempDir,
    package_path: PathBuf,
    installed_manifest_path: PathBuf,
    installed_manifest_bytes: Vec<u8>,
    installed: InstalledOkouCli,
}

impl OkouCliArtifact {
    /// Verify and stage the embedded package, preserving the compiled identity.
    pub(super) async fn resolve_embedded() -> RunnerResult<Option<Self>> {
        #[cfg(bundled_okou_cli)]
        {
            use crate::cmd::embedded_cli;

            let size = env!("BUNDLED_OKOU_CLI_SIZE")
                .parse::<u64>()
                .map_err(|e| RunnerError::Internal(format!("invalid embedded CLI size: {e}")))?;
            let versions = OkouCliVersions {
                cli: env!("BUNDLED_OKOU_CLI_VERSION").to_owned(),
                pi_agent_runtime: env!("BUNDLED_OKOU_PI_RUNTIME_VERSION").to_owned(),
                pi_sdk: env!("BUNDLED_OKOU_PI_SDK_VERSION").to_owned(),
            };
            let session_construction = OkouCliSessionConstruction {
                digest: env!("BUNDLED_OKOU_SESSION_DIGEST").to_owned(),
            };
            return Self::stage_verified(
                embedded_cli::package(),
                env!("BUNDLED_OKOU_CLI_SHA256"),
                size,
                versions,
                session_construction,
            )
            .await
            .map(Some);
        }
        #[cfg(not(bundled_okou_cli))]
        Ok(None)
    }

    /// Test-only manifest fixture for staging and integrity checks.
    #[cfg(test)]
    pub(super) async fn resolve(dir: &Path) -> RunnerResult<Self> {
        let manifest_path = dir.join(OKOU_CLI_MANIFEST_FILE);
        let manifest_bytes = tokio::fs::read(&manifest_path).await.map_err(|e| {
            RunnerError::Internal(format!(
                "read Okou CLI artifact manifest {}: {e}",
                manifest_path.display()
            ))
        })?;
        let manifest: ArtifactManifest = serde_json::from_slice(&manifest_bytes).map_err(|e| {
            RunnerError::Internal(format!(
                "parse Okou CLI artifact manifest {}: {e}",
                manifest_path.display()
            ))
        })?;
        if manifest.version != ARTIFACT_MANIFEST_VERSION {
            return Err(RunnerError::Internal(format!(
                "Okou CLI artifact manifest version {} is unsupported",
                manifest.version
            )));
        }
        if manifest.package.path != OKOU_CLI_PACKAGE_FILE {
            return Err(RunnerError::Internal(format!(
                "Okou CLI artifact manifest names package {:?}, expected {OKOU_CLI_PACKAGE_FILE}",
                manifest.package.path
            )));
        }
        for (field, value) in [
            ("cli", manifest.versions.cli.as_str()),
            (
                "piAgentRuntime",
                manifest.versions.pi_agent_runtime.as_str(),
            ),
        ] {
            if parse_release_version(value).is_none() {
                return Err(RunnerError::Internal(format!(
                    "Okou CLI artifact manifest has an invalid {field} version: {value}"
                )));
            }
        }
        if manifest.versions.pi_sdk.is_empty() {
            return Err(RunnerError::Internal(
                "Okou CLI artifact manifest is missing the piSdk version".into(),
            ));
        }
        if !OkouCliSessionConstruction::is_valid_digest(&manifest.session_construction.digest) {
            return Err(RunnerError::Internal(format!(
                "Okou CLI artifact manifest has an invalid sessionConstruction digest: {}",
                manifest.session_construction.digest
            )));
        }

        let source_package = dir.join(OKOU_CLI_PACKAGE_FILE);
        let package_bytes = tokio::fs::read(&source_package).await.map_err(|e| {
            RunnerError::Internal(format!(
                "read Okou CLI package {}: {e}",
                source_package.display()
            ))
        })?;
        Self::stage_verified(
            &package_bytes,
            &manifest.package.sha256,
            manifest.package.size,
            manifest.versions,
            manifest.session_construction,
        )
        .await
    }

    #[cfg(any(test, bundled_okou_cli))]
    async fn stage_verified(
        package_bytes: &[u8],
        expected_sha256: &str,
        expected_size: u64,
        versions: OkouCliVersions,
        session_construction: OkouCliSessionConstruction,
    ) -> RunnerResult<Self> {
        if package_bytes.is_empty() || package_bytes.len() > MAX_CLI_PACKAGE_SIZE {
            return Err(RunnerError::Internal(
                "Okou CLI package size is out of bounds".into(),
            ));
        }
        let package_sha256 = hex::encode(Sha256::digest(package_bytes));
        if package_sha256 != expected_sha256 {
            return Err(RunnerError::Internal(format!(
                "Okou CLI package digest {package_sha256} does not match manifest {expected_sha256}"
            )));
        }
        let package_size = u64::try_from(package_bytes.len())
            .map_err(|_| RunnerError::Internal("Okou CLI package exceeds u64 length".into()))?;
        if package_size != expected_size {
            return Err(RunnerError::Internal(format!(
                "Okou CLI package size {package_size} does not match manifest {expected_size}"
            )));
        }
        let identity = crate::cli_package::read_identity(package_bytes)
            .map_err(|e| RunnerError::Internal(format!("invalid packed CLI identity: {e}")))?;
        if versions.cli != identity.versions.cli
            || versions.pi_agent_runtime != identity.versions.pi_agent_runtime
            || versions.pi_sdk != identity.versions.pi_sdk
            || session_construction.digest != identity.session_construction.digest
        {
            return Err(RunnerError::Internal(
                "CLI artifact identity does not match packed identity".into(),
            ));
        }
        let installed = InstalledOkouCli {
            schema_version: OKOU_CLI_INSTALLED_MANIFEST_SCHEMA_VERSION,
            entrypoint: InstalledOkouCli::entrypoint_for(&versions.cli),
            versions,
            package: OkouCliInstalledPackage {
                sha256: package_sha256,
                size: package_size,
            },
            session_construction: Some(session_construction),
        };
        let mut installed_manifest_bytes = serde_json::to_vec(&installed).map_err(|e| {
            RunnerError::Internal(format!("encode installed Okou CLI manifest: {e}"))
        })?;
        installed_manifest_bytes.push(b'\n');

        let temp_dir = tempfile::tempdir()
            .map_err(|e| RunnerError::Internal(format!("create Okou CLI temp dir: {e}")))?;
        let package_path = temp_dir.path().join(OKOU_CLI_PACKAGE_FILE);
        tokio::fs::write(&package_path, package_bytes)
            .await
            .map_err(|e| RunnerError::Internal(format!("stage Okou CLI package: {e}")))?;
        let installed_manifest_path = temp_dir.path().join("installed.json");
        tokio::fs::write(&installed_manifest_path, &installed_manifest_bytes)
            .await
            .map_err(|e| {
                RunnerError::Internal(format!("stage installed Okou CLI manifest: {e}"))
            })?;

        Ok(Self {
            _temp_dir: temp_dir,
            package_path,
            installed_manifest_path,
            installed_manifest_bytes,
            installed,
        })
    }

    pub(super) fn cli_version(&self) -> &str {
        &self.installed.versions.cli
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
            package_sha256: &self.installed.package.sha256,
        }
    }
}

#[cfg(test)]
pub(super) mod test_support {
    use std::path::Path;

    use sha2::{Digest, Sha256};

    /// Write a well-formed artifact directory and return the package digest.
    pub(crate) fn write_artifact_dir(
        dir: &Path,
        package_bytes: &[u8],
        cli_version: &str,
        runtime_version: &str,
    ) -> String {
        let package_bytes =
            package_bytes_with_identity(package_bytes, cli_version, runtime_version);
        std::fs::write(dir.join(super::OKOU_CLI_PACKAGE_FILE), &package_bytes).unwrap();
        let sha256 = hex::encode(Sha256::digest(&package_bytes));
        std::fs::write(
            dir.join(super::OKOU_CLI_MANIFEST_FILE),
            format!(
                r#"{{"version":1,"commitSha":"{}","package":{{"path":"package.tgz","sha256":"{sha256}","size":{}}},"versions":{{"cli":"{cli_version}","piAgentRuntime":"{runtime_version}","piSdk":"0.86.1+okou.0123456789ab"}},"sessionConstruction":{{"digest":"{}"}}}}"#,
                "c".repeat(40),
                package_bytes.len(),
                "d".repeat(64)
            ),
        )
        .unwrap();
        sha256
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
    use super::test_support::{package_bytes_with_identity, write_artifact_dir};
    use super::*;

    #[tokio::test]
    async fn resolve_stages_verified_artifact_and_installed_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let sha256 = write_artifact_dir(dir.path(), b"tarball-bytes", "9.353.0", "1.36.0");
        let expected_package = std::fs::read(dir.path().join(OKOU_CLI_PACKAGE_FILE)).unwrap();

        let artifact = OkouCliArtifact::resolve(dir.path()).await.unwrap();

        assert_eq!(artifact.cli_version(), "9.353.0");
        assert!(
            artifact
                .package_path()
                .starts_with(artifact._temp_dir.path())
        );
        assert_eq!(
            std::fs::read(artifact.package_path()).unwrap(),
            expected_package
        );
        let installed = InstalledOkouCli::parse(artifact.installed_manifest_bytes()).unwrap();
        assert_eq!(installed, artifact.installed);
        assert_eq!(installed.versions.pi_agent_runtime, "1.36.0");
        assert_eq!(
            installed.session_construction,
            Some(OkouCliSessionConstruction {
                digest: "d".repeat(64)
            })
        );
        assert_eq!(installed.package.sha256, sha256);
        assert_eq!(installed.package.size, expected_package.len() as u64);
        assert_eq!(
            installed.entrypoint,
            "/usr/local/lib/okou-cli/9.353.0/okou.js"
        );
        assert_eq!(
            std::fs::read(artifact.installed_manifest_path()).unwrap(),
            artifact.installed_manifest_bytes()
        );
        // Later edits to the source directory do not reach the staged bytes.
        std::fs::write(dir.path().join(OKOU_CLI_PACKAGE_FILE), b"changed").unwrap();
        assert_eq!(
            std::fs::read(artifact.package_path()).unwrap(),
            expected_package
        );
    }

    #[tokio::test]
    async fn staged_bytes_must_match_the_compiled_identity() {
        let versions = OkouCliVersions {
            cli: "9.353.0".into(),
            pi_agent_runtime: "1.36.0".into(),
            pi_sdk: "0.86.1+okou.0123456789ab".into(),
        };
        let bytes = package_bytes_with_identity(b"tarball-bytes", "9.353.0", "1.36.0");
        let sha256 = hex::encode(Sha256::digest(&bytes));
        let session = OkouCliSessionConstruction {
            digest: "d".repeat(64),
        };
        let artifact = OkouCliArtifact::stage_verified(
            &bytes,
            &sha256,
            bytes.len() as u64,
            versions.clone(),
            session.clone(),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(artifact.package_path()).unwrap(), bytes);
        assert_eq!(artifact.installed.package.sha256, sha256);
        assert_eq!(artifact.installed.versions, versions);

        let error =
            OkouCliArtifact::stage_verified(&bytes, &sha256, 42, versions.clone(), session.clone())
                .await
                .unwrap_err();
        assert!(error.to_string().contains("size"), "{error}");
        let error = OkouCliArtifact::stage_verified(b"tampered", &sha256, 8, versions, session)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("digest"), "{error}");
    }

    #[cfg(bundled_okou_cli)]
    #[tokio::test]
    async fn embedded_bundle_stages_the_compiled_identity() {
        let artifact = OkouCliArtifact::resolve_embedded().await.unwrap().unwrap();
        assert_eq!(
            artifact.installed.versions.cli,
            env!("BUNDLED_OKOU_CLI_VERSION")
        );
        assert_eq!(
            artifact.installed.package.sha256,
            env!("BUNDLED_OKOU_CLI_SHA256")
        );
        assert_eq!(
            artifact.installed.package.size.to_string(),
            env!("BUNDLED_OKOU_CLI_SIZE")
        );
        assert_eq!(
            artifact
                .installed
                .session_construction
                .as_ref()
                .unwrap()
                .digest,
            env!("BUNDLED_OKOU_SESSION_DIGEST")
        );
    }

    #[cfg(not(bundled_okou_cli))]
    #[tokio::test]
    async fn local_unbundled_runner_has_no_embedded_cli() {
        assert!(OkouCliArtifact::resolve_embedded().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn resolve_rejects_digest_mismatch_and_loose_versions() {
        let dir = tempfile::tempdir().unwrap();
        write_artifact_dir(dir.path(), b"tarball-bytes", "9.353.0", "1.36.0");
        std::fs::write(dir.path().join(OKOU_CLI_PACKAGE_FILE), b"tarball-bytez").unwrap();
        let error = OkouCliArtifact::resolve(dir.path()).await.unwrap_err();
        assert!(error.to_string().contains("digest"), "{error}");

        let dir = tempfile::tempdir().unwrap();
        write_artifact_dir(dir.path(), b"tarball-bytes", "9.353.0", "1.36");
        let error = OkouCliArtifact::resolve(dir.path()).await.unwrap_err();
        assert!(error.to_string().contains("piAgentRuntime"), "{error}");

        let dir = tempfile::tempdir().unwrap();
        write_artifact_dir(dir.path(), b"tarball-bytes", "9.353.0", "1.36.0");
        std::fs::write(
            dir.path().join(OKOU_CLI_MANIFEST_FILE),
            r#"{"version":1,"commitSha":"x","package":{"path":"package.tgz","sha256":"","size":1}}"#,
        )
        .unwrap();
        let error = OkouCliArtifact::resolve(dir.path()).await.unwrap_err();
        assert!(error.to_string().contains("versions"), "{error}");
    }

    #[tokio::test]
    async fn resolve_rejects_external_only_identity_changes() {
        let dir = tempfile::tempdir().unwrap();
        write_artifact_dir(dir.path(), b"tarball-bytes", "9.353.0", "1.36.0");
        let path = dir.path().join(OKOU_CLI_MANIFEST_FILE);
        let baseline: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let other_digest = "e".repeat(64);
        for (field, value) in [
            ("/versions/cli", "9.353.1"),
            ("/versions/piAgentRuntime", "1.36.1"),
            ("/versions/piSdk", "0.86.1+okou.aaaaaaaaaaaa"),
            ("/sessionConstruction/digest", other_digest.as_str()),
        ] {
            let mut changed = baseline.clone();
            *changed.pointer_mut(field).unwrap() = serde_json::json!(value);
            std::fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
            let error = OkouCliArtifact::resolve(dir.path()).await.unwrap_err();
            assert!(
                error.to_string().contains("does not match packed identity"),
                "{field}: {error}"
            );
        }
        let mut missing = baseline;
        missing
            .as_object_mut()
            .unwrap()
            .remove("sessionConstruction");
        std::fs::write(&path, serde_json::to_vec(&missing).unwrap()).unwrap();
        let error = OkouCliArtifact::resolve(dir.path()).await.unwrap_err();
        assert!(error.to_string().contains("sessionConstruction"), "{error}");
    }
}
