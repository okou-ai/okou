//! Okou CLI installed in the runner rootfs at build time.
//!
//! The runner build writes the installed manifest into the rootfs and keeps a
//! sidecar copy next to the rootfs image. Pi launches the installed executable;
//! the runner reads the sidecar to advertise its versions when it claims a job.

use serde::{Deserialize, Serialize};

/// Root directory that holds one subdirectory per installed CLI version.
pub const OKOU_CLI_LIB_ROOT: &str = "/usr/local/lib/okou-cli";
/// Manifest describing the CLI version installed into the rootfs.
pub const OKOU_CLI_INSTALLED_MANIFEST_PATH: &str = "/usr/local/lib/okou-cli/installed.json";
/// Launcher the guest execs for the installed CLI.
pub const OKOU_CLI_LAUNCHER_PATH: &str = "/usr/local/bin/okou";
/// Schema version of [`InstalledOkouCli`].
pub const OKOU_CLI_INSTALLED_MANIFEST_SCHEMA_VERSION: u32 = 1;

/// Versions carried by one Okou CLI bundle.
///
/// `cli` and `pi_agent_runtime` are release versions in `MAJOR.MINOR.PATCH`
/// form. `pi_sdk` identifies the pinned upstream Pi SDK plus the first-party
/// patch set it was built with; it is informational and never compared.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OkouCliVersions {
    /// `@okouai/cli` release version.
    pub cli: String,
    /// `@okouai/pi-agent-runtime` release version bundled into the CLI.
    pub pi_agent_runtime: String,
    /// Pinned Pi SDK version plus patch-set identity.
    pub pi_sdk: String,
}

/// Identity of the installed package tarball.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OkouCliInstalledPackage {
    /// Lowercase hex SHA-256 of the published `package.tgz`.
    pub sha256: String,
    /// Byte size of the published `package.tgz`.
    pub size: u64,
}

/// Manifest written to [`OKOU_CLI_INSTALLED_MANIFEST_PATH`] by the runner build.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledOkouCli {
    /// Always [`OKOU_CLI_INSTALLED_MANIFEST_SCHEMA_VERSION`].
    pub schema_version: u32,
    /// Versions of the installed bundle.
    pub versions: OkouCliVersions,
    /// Identity of the installed tarball.
    pub package: OkouCliInstalledPackage,
    /// Absolute path of the bundle entrypoint inside the rootfs.
    pub entrypoint: String,
}

/// Failure to accept an installed manifest.
#[derive(Debug)]
pub enum InstalledOkouCliError {
    /// The manifest is not valid JSON for [`InstalledOkouCli`].
    Json(serde_json::Error),
    /// The manifest carries an unsupported schema version.
    SchemaVersion(u32),
    /// A release version is not `MAJOR.MINOR.PATCH`.
    Version {
        /// Which version field failed validation.
        field: &'static str,
        /// The rejected value.
        value: String,
    },
}

impl std::fmt::Display for InstalledOkouCliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Json(error) => write!(f, "installed Okou CLI manifest is invalid: {error}"),
            Self::SchemaVersion(version) => write!(
                f,
                "installed Okou CLI manifest schema version {version} is unsupported"
            ),
            Self::Version { field, value } => write!(
                f,
                "installed Okou CLI manifest has an invalid {field} version: {value}"
            ),
        }
    }
}

impl std::error::Error for InstalledOkouCliError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Json(error) => Some(error),
            Self::SchemaVersion(_) | Self::Version { .. } => None,
        }
    }
}

impl From<serde_json::Error> for InstalledOkouCliError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl InstalledOkouCli {
    /// Directory holding the bundle for `cli_version`.
    pub fn install_dir(cli_version: &str) -> String {
        format!("{OKOU_CLI_LIB_ROOT}/{cli_version}")
    }

    /// Bundle entrypoint for `cli_version`.
    pub fn entrypoint_for(cli_version: &str) -> String {
        format!("{}/okou.js", Self::install_dir(cli_version))
    }

    /// Parse and validate manifest bytes.
    pub fn parse(bytes: &[u8]) -> Result<Self, InstalledOkouCliError> {
        let manifest: Self = serde_json::from_slice(bytes)?;
        if manifest.schema_version != OKOU_CLI_INSTALLED_MANIFEST_SCHEMA_VERSION {
            return Err(InstalledOkouCliError::SchemaVersion(
                manifest.schema_version,
            ));
        }
        for (field, value) in [
            ("cli", manifest.versions.cli.as_str()),
            (
                "piAgentRuntime",
                manifest.versions.pi_agent_runtime.as_str(),
            ),
        ] {
            if parse_release_version(value).is_none() {
                return Err(InstalledOkouCliError::Version {
                    field,
                    value: value.to_string(),
                });
            }
        }
        Ok(manifest)
    }
}

/// Parse a strict `MAJOR.MINOR.PATCH` release version.
///
/// Release-please never emits prerelease or build metadata for the CLI or the
/// runtime, so anything else is rejected rather than approximated.
pub fn parse_release_version(value: &str) -> Option<[u64; 3]> {
    let mut parts = value.split('.');
    let mut version = [0u64; 3];
    for slot in &mut version {
        let part = parts.next()?;
        if part.is_empty()
            || part.len() > 10
            || !part.bytes().all(|byte| byte.is_ascii_digit())
            || (part.len() > 1 && part.starts_with('0'))
        {
            return None;
        }
        *slot = part.parse().ok()?;
    }
    if parts.next().is_some() {
        return None;
    }
    Some(version)
}

#[cfg(test)]
mod tests;
