//! Versioned Okou CLI artifact installed into the rootfs customize layer.
//!
//! `runner build --okou-cli-artifact DIR` points at a directory holding the
//! published `package.tgz` and its `manifest.json`. The manifest's `versions`
//! field is the identity the rootfs advertises: the runner never inspects the
//! bundle to discover versions, so an artifact without versions is rejected.

use std::path::{Path, PathBuf};

use guest_contracts::okou_cli::{
    InstalledOkouCli, OKOU_CLI_INSTALLED_MANIFEST_SCHEMA_VERSION, OkouCliInstalledPackage,
    OkouCliVersions, parse_release_version,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::error::{RunnerError, RunnerResult};

use super::hashes::OkouCliHashInput;

pub(super) const OKOU_CLI_PACKAGE_FILE: &str = "package.tgz";
pub(super) const OKOU_CLI_MANIFEST_FILE: &str = "manifest.json";
const ARTIFACT_MANIFEST_VERSION: u32 = 1;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactManifest {
    version: u32,
    #[allow(dead_code)]
    commit_sha: String,
    package: ArtifactPackage,
    versions: OkouCliVersions,
}

#[derive(Deserialize)]
struct ArtifactPackage {
    path: String,
    sha256: String,
    size: u64,
}

/// A verified CLI artifact staged for one rootfs build.
#[derive(Debug)]
pub(super) struct OkouCliArtifact {
    // Keeps the staged package and installed manifest alive for hashing and
    // customize-rootfs.sh execution.
    _temp_dir: tempfile::TempDir,
    package_path: PathBuf,
    installed_manifest_path: PathBuf,
    installed_manifest_bytes: Vec<u8>,
    installed: InstalledOkouCli,
}

impl OkouCliArtifact {
    /// Load, verify, and stage the artifact found in `dir`.
    ///
    /// The package bytes are copied into a private temp dir so hashing and
    /// customization consume the same bytes even if `dir` changes mid-build.
    pub(super) async fn resolve(dir: &Path) -> RunnerResult<Self> {
        let manifest_path = dir.join(OKOU_CLI_MANIFEST_FILE);
        let manifest_bytes = tokio::fs::read(&manifest_path).await.map_err(|e| {
            RunnerError::Internal(format!(
                "read Okou CLI artifact manifest {}: {e}",
                manifest_path.display()
            ))
        })?;
        let manifest: ArtifactManifest =
            serde_json::from_slice(&manifest_bytes).map_err(|e| {
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
            ("piAgentRuntime", manifest.versions.pi_agent_runtime.as_str()),
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

        let source_package = dir.join(OKOU_CLI_PACKAGE_FILE);
        let package_bytes = tokio::fs::read(&source_package).await.map_err(|e| {
            RunnerError::Internal(format!(
                "read Okou CLI package {}: {e}",
                source_package.display()
            ))
        })?;
        let package_sha256 = hex::encode(Sha256::digest(&package_bytes));
        if package_sha256 != manifest.package.sha256 {
            return Err(RunnerError::Internal(format!(
                "Okou CLI package digest {package_sha256} does not match manifest {}",
                manifest.package.sha256
            )));
        }
        let package_size = u64::try_from(package_bytes.len())
            .map_err(|_| RunnerError::Internal("Okou CLI package exceeds u64 length".into()))?;
        if package_size != manifest.package.size {
            return Err(RunnerError::Internal(format!(
                "Okou CLI package size {package_size} does not match manifest {}",
                manifest.package.size
            )));
        }

        let installed = InstalledOkouCli {
            schema_version: OKOU_CLI_INSTALLED_MANIFEST_SCHEMA_VERSION,
            entrypoint: InstalledOkouCli::entrypoint_for(&manifest.versions.cli),
            versions: manifest.versions,
            package: OkouCliInstalledPackage {
                sha256: package_sha256,
                size: package_size,
            },
        };
        let mut installed_manifest_bytes = serde_json::to_vec(&installed)
            .map_err(|e| RunnerError::Internal(format!("encode installed Okou CLI manifest: {e}")))?;
        installed_manifest_bytes.push(b'\n');

        let temp_dir = tempfile::tempdir()
            .map_err(|e| RunnerError::Internal(format!("create Okou CLI temp dir: {e}")))?;
        let package_path = temp_dir.path().join(OKOU_CLI_PACKAGE_FILE);
        tokio::fs::write(&package_path, &package_bytes)
            .await
            .map_err(|e| RunnerError::Internal(format!("stage Okou CLI package: {e}")))?;
        let installed_manifest_path = temp_dir.path().join("installed.json");
        tokio::fs::write(&installed_manifest_path, &installed_manifest_bytes)
            .await
            .map_err(|e| RunnerError::Internal(format!("stage installed Okou CLI manifest: {e}")))?;

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

    pub(super) fn installed(&self) -> &InstalledOkouCli {
        &self.installed
    }

    pub(super) fn hash_input(&self) -> OkouCliHashInput<'_> {
        OkouCliHashInput {
            package_path: &self.package_path,
            installed_manifest: &self.installed_manifest_bytes,
        }
    }
}

#[cfg(test)]
pub(super) mod test_support {
    use std::path::Path;

    use sha2::{Digest, Sha256};

    /// Write a well-formed artifact directory and return the package digest.
    pub(super) fn write_artifact_dir(
        dir: &Path,
        package_bytes: &[u8],
        cli_version: &str,
        runtime_version: &str,
    ) -> String {
        std::fs::write(dir.join(super::OKOU_CLI_PACKAGE_FILE), package_bytes).unwrap();
        let sha256 = hex::encode(Sha256::digest(package_bytes));
        std::fs::write(
            dir.join(super::OKOU_CLI_MANIFEST_FILE),
            format!(
                r#"{{"version":1,"commitSha":"{}","package":{{"path":"package.tgz","sha256":"{sha256}","size":{}}},"versions":{{"cli":"{cli_version}","piAgentRuntime":"{runtime_version}","piSdk":"0.86.1+okou.0123456789ab"}}}}"#,
                "c".repeat(40),
                package_bytes.len()
            ),
        )
        .unwrap();
        sha256
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::write_artifact_dir;
    use super::*;

    #[tokio::test]
    async fn resolve_stages_verified_artifact_and_installed_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let sha256 = write_artifact_dir(dir.path(), b"tarball-bytes", "9.353.0", "1.36.0");

        let artifact = OkouCliArtifact::resolve(dir.path()).await.unwrap();

        assert_eq!(artifact.cli_version(), "9.353.0");
        assert!(artifact.package_path().starts_with(artifact._temp_dir.path()));
        assert_eq!(
            std::fs::read(artifact.package_path()).unwrap(),
            b"tarball-bytes"
        );
        let installed = InstalledOkouCli::parse(artifact.installed_manifest_bytes()).unwrap();
        assert_eq!(installed, *artifact.installed());
        assert_eq!(installed.versions.pi_agent_runtime, "1.36.0");
        assert_eq!(installed.package.sha256, sha256);
        assert_eq!(installed.package.size, 13);
        assert_eq!(installed.entrypoint, "/usr/local/lib/okou-cli/9.353.0/okou.js");
        assert_eq!(
            std::fs::read(artifact.installed_manifest_path()).unwrap(),
            artifact.installed_manifest_bytes()
        );
        // Later edits to the source directory do not reach the staged bytes.
        std::fs::write(dir.path().join(OKOU_CLI_PACKAGE_FILE), b"changed").unwrap();
        assert_eq!(
            std::fs::read(artifact.package_path()).unwrap(),
            b"tarball-bytes"
        );
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
}
