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
pub(super) mod test_support;

#[cfg(test)]
mod tests;
