use std::path::PathBuf;

use crate::error::{HostError, HostResult};
use crate::paths::HomePaths;

const UNIT_PREFIX: &str = "vm0-runner-";
const LOCK_PREFIX: &str = "service-";
const LOCK_SUFFIX: &str = ".lock";

/// A validated identity for one runner systemd service.
///
/// The suffix `pr-123` maps to five forms belonging to the same identity:
///
/// - suffix: `pr-123`
/// - unit name: `vm0-runner-pr-123`
/// - service name: `vm0-runner-pr-123.service`
/// - unit-file path: `/etc/systemd/system/vm0-runner-pr-123.service`
/// - lock filename: `service-vm0-runner-pr-123.lock`
///
/// Construction validates the suffix before deriving the other forms, so an
/// instance cannot contain names or a path for an invalid suffix.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunnerServiceUnit {
    suffix: String,
    unit_name: String,
    service_name: String,
    unit_file_path: PathBuf,
    lock_file_name: String,
}

impl RunnerServiceUnit {
    /// Build a validated runner systemd unit identity from a suffix.
    ///
    /// Validates the suffix with [`crate::runner_dirname::validate_name`] so
    /// that runner directory names and service name suffixes follow the same
    /// rules (bounded length, lowercase alphanumeric, hyphens, dots; no
    /// leading `.` or `-`).
    pub fn from_suffix(suffix: &str) -> HostResult<Self> {
        if !crate::runner_dirname::validate_name(suffix) {
            let diagnostic = crate::runner_dirname::invalid_name_diagnostic(suffix);
            let rules = crate::runner_dirname::validation_rules();
            return Err(HostError::Config(format!(
                "invalid service name suffix {diagnostic}: {rules}"
            )));
        }

        let unit_name = format!("{UNIT_PREFIX}{suffix}");
        let service_name = format!("{unit_name}.service");
        let unit_file_path = PathBuf::from(format!("/etc/systemd/system/{service_name}"));
        let lock_file_name = format!("{LOCK_PREFIX}{unit_name}{LOCK_SUFFIX}");
        Ok(Self {
            suffix: suffix.to_string(),
            unit_name,
            service_name,
            unit_file_path,
            lock_file_name,
        })
    }

    /// Parse a runner service identity from a bare unit-file name.
    ///
    /// Accepts `vm0-runner-<suffix>.service` only when `<suffix>` passes the
    /// same validation as [`Self::from_suffix`]. Returns `None` when the
    /// expected prefix or `.service` suffix is absent, or when the extracted
    /// suffix is invalid.
    pub fn from_file_name(file_name: &str) -> Option<Self> {
        let suffix = file_name
            .strip_prefix(UNIT_PREFIX)?
            .strip_suffix(".service")?;
        Self::from_suffix(suffix).ok()
    }

    /// Parse a current runner service identity from a lifecycle-lock filename.
    ///
    /// Accepts `service-vm0-runner-<suffix>.lock` only when `<suffix>` passes
    /// the same validation as [`Self::from_suffix`]. Historical lock names
    /// that fail current validation are rejected.
    pub fn from_lock_file_name(file_name: &str) -> Option<Self> {
        let unit_name = file_name
            .strip_prefix(LOCK_PREFIX)?
            .strip_suffix(LOCK_SUFFIX)?;
        let suffix = unit_name.strip_prefix(UNIT_PREFIX)?;
        Self::from_suffix(suffix).ok()
    }

    /// Return the validated suffix before adding the `vm0-runner-` prefix or
    /// final `.service` extension.
    pub fn suffix(&self) -> &str {
        &self.suffix
    }

    /// Return the unit name `vm0-runner-<suffix>`, before adding the final
    /// `.service` extension.
    pub fn unit_name(&self) -> &str {
        &self.unit_name
    }

    /// Return the service name `vm0-runner-<suffix>.service`.
    pub fn service_name(&self) -> &str {
        &self.service_name
    }

    /// Return the absolute `/etc/systemd/system/<service-name>` unit-file path.
    pub fn unit_file_path(&self) -> &std::path::Path {
        &self.unit_file_path
    }

    /// Return the lifecycle-lock filename `service-vm0-runner-<suffix>.lock`.
    pub fn lock_file_name(&self) -> &str {
        &self.lock_file_name
    }

    /// Return this service's lifecycle-lock path under the runner home.
    pub fn lock_path(&self, home: &HomePaths) -> PathBuf {
        home.locks_dir().join(self.lock_file_name())
    }
}

/// Return the runner service-name pattern `vm0-runner-*.service`.
///
/// Validated service names use the same fixed prefix and `.service` suffix,
/// but this pattern does not validate the suffix matched by `*`.
pub fn all_units_pattern() -> String {
    format!("{UNIT_PREFIX}*.service")
}

#[cfg(test)]
mod tests;
