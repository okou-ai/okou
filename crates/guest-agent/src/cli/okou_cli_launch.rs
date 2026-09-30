//! Choose how the guest launches the Okou CLI for Pi execution.
//!
//! The runner rootfs may carry a versioned CLI bundle installed at build time
//! (see `guest_contracts::okou_cli`). It is used only when the launch config
//! the API captured proves parity with the installed bundle and names a CLI
//! floor the bundle satisfies. Parity is the session-construction digest when
//! the launch config carries one (it moves only when code feeding the
//! constructed session changes), and the exact `pi-agent-runtime` version
//! otherwise. Every other case keeps the commit-addressed `npx` launch,
//! using the package URL captured by the API. The requirements travel in the execution
//! context (`piInstalledCliRequirement`).

use std::path::Path;

use guest_contracts::okou_cli::{InstalledOkouCli, parse_release_version};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PiCliLaunchSource {
    /// Exec the bundle installed in the rootfs.
    Installed,
    /// Install and run the task's commit-addressed package through `npx`.
    Npx,
}

impl PiCliLaunchSource {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Installed => "installed",
            Self::Npx => "npx",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PiCliLaunchDecision {
    pub(super) source: PiCliLaunchSource,
    /// Bounded, content-free label recorded with the decision.
    pub(super) reason: &'static str,
}

impl PiCliLaunchDecision {
    fn npx(reason: &'static str) -> Self {
        Self {
            source: PiCliLaunchSource::Npx,
            reason,
        }
    }
}

/// Installed-CLI launch requirements the API captured for the run.
///
/// Every field is absent when the execution context carries no requirement;
/// such runs launch through `npx`. The session-construction
/// digest, when present, replaces the runtime version as the parity key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PiRuntimeRequirement<'a> {
    pub(super) required_pi_agent_runtime_version: Option<&'a str>,
    pub(super) min_cli_version: Option<&'a str>,
    pub(super) required_pi_session_construction_digest: Option<&'a str>,
}

impl<'a> PiRuntimeRequirement<'a> {
    /// Read the execution-context `piInstalledCliRequirement`, if any.
    pub(super) fn from_value(installed_cli_requirement: Option<&'a serde_json::Value>) -> Self {
        let field = |name: &str| {
            installed_cli_requirement
                .and_then(|source| source.get(name))
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
        };
        Self {
            required_pi_agent_runtime_version: field("requiredPiAgentRuntimeVersion"),
            min_cli_version: field("minCliVersion"),
            required_pi_session_construction_digest: field("requiredPiSessionConstructionDigest"),
        }
    }
}

/// Read the manifest the runner build installed, if any.
///
/// A missing or invalid manifest disables the installed fast path; the caller
/// uses the task's package URL through `npx` instead.
pub(super) fn load_installed_okou_cli() -> Option<InstalledOkouCli> {
    let path = installed_cli_manifest_path();
    match load_installed_okou_cli_from(Path::new(path)) {
        Ok(installed) => installed,
        Err(error) => {
            guest_telemetry::log_warn!(
                super::LOG_TAG,
                "Ignoring installed Okou CLI manifest at {path}: {error}"
            );
            None
        }
    }
}

// A compiled test fixture stands in for rootfs absolute paths in integration
// tests. The release profile has debug assertions disabled, so this override
// cannot be used in the deployed Guest, even with all Cargo features enabled.
fn installed_cli_manifest_path() -> &'static str {
    #[cfg(all(feature = "cli-test-fixtures", debug_assertions))]
    {
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/installed-okou-cli.json"
        )
    }
    #[cfg(not(all(feature = "cli-test-fixtures", debug_assertions)))]
    guest_contracts::okou_cli::OKOU_CLI_INSTALLED_MANIFEST_PATH
}

pub(super) fn installed_cli_launcher_path() -> &'static str {
    #[cfg(all(feature = "cli-test-fixtures", debug_assertions))]
    {
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/mock-pi-cli-launcher.sh"
        )
    }
    #[cfg(not(all(feature = "cli-test-fixtures", debug_assertions)))]
    guest_contracts::okou_cli::OKOU_CLI_LAUNCHER_PATH
}

pub(super) fn load_installed_okou_cli_from(
    path: &Path,
) -> Result<Option<InstalledOkouCli>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    InstalledOkouCli::parse(&bytes)
        .map(Some)
        .map_err(|error| error.to_string())
}

pub(super) fn select_pi_cli_launch(
    requirement: &PiRuntimeRequirement<'_>,
    installed: Option<&InstalledOkouCli>,
) -> PiCliLaunchDecision {
    let Some(installed) = installed else {
        return PiCliLaunchDecision::npx("no_installed_cli");
    };
    let parity = match requirement.required_pi_session_construction_digest {
        Some(required_digest) => {
            let Some(session_construction) = installed.session_construction.as_ref() else {
                return PiCliLaunchDecision::npx("installed_cli_without_session_construction");
            };
            if required_digest != session_construction.digest {
                return PiCliLaunchDecision::npx("session_construction_mismatch");
            }
            "session_construction_match"
        }
        None => {
            let Some(required_runtime) = requirement.required_pi_agent_runtime_version else {
                return PiCliLaunchDecision::npx("launch_config_without_runtime_version");
            };
            if required_runtime != installed.versions.pi_agent_runtime {
                return PiCliLaunchDecision::npx("runtime_version_mismatch");
            }
            "runtime_version_match"
        }
    };
    let Some(min_cli) = requirement.min_cli_version else {
        return PiCliLaunchDecision::npx("launch_config_without_cli_floor");
    };
    match (
        parse_release_version(min_cli),
        parse_release_version(&installed.versions.cli),
    ) {
        (Some(floor), Some(cli)) if cli >= floor => PiCliLaunchDecision {
            source: PiCliLaunchSource::Installed,
            reason: parity,
        },
        (Some(_), Some(_)) => PiCliLaunchDecision::npx("cli_below_floor"),
        _ => PiCliLaunchDecision::npx("invalid_version"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use guest_contracts::okou_cli::{
        OkouCliInstalledPackage, OkouCliSessionConstruction, OkouCliVersions,
    };

    #[cfg(not(all(feature = "cli-test-fixtures", debug_assertions)))]
    #[test]
    fn production_cli_paths_are_canonical() {
        assert_eq!(
            installed_cli_manifest_path(),
            guest_contracts::okou_cli::OKOU_CLI_INSTALLED_MANIFEST_PATH
        );
        assert_eq!(
            installed_cli_launcher_path(),
            guest_contracts::okou_cli::OKOU_CLI_LAUNCHER_PATH
        );
    }

    fn installed(cli: &str, runtime: &str) -> InstalledOkouCli {
        InstalledOkouCli {
            schema_version: 1,
            versions: OkouCliVersions {
                cli: cli.to_string(),
                pi_agent_runtime: runtime.to_string(),
                pi_sdk: "0.86.1+okou.0123456789ab".to_string(),
            },
            package: OkouCliInstalledPackage {
                sha256: "a".repeat(64),
                size: 1,
            },
            entrypoint: InstalledOkouCli::entrypoint_for(cli),
            session_construction: None,
        }
    }

    fn installed_with_digest(cli: &str, runtime: &str, digest: &str) -> InstalledOkouCli {
        InstalledOkouCli {
            session_construction: Some(OkouCliSessionConstruction {
                digest: digest.to_string(),
            }),
            ..installed(cli, runtime)
        }
    }

    fn requirement<'a>(
        runtime: Option<&'a str>,
        floor: Option<&'a str>,
    ) -> PiRuntimeRequirement<'a> {
        requirement_with_digest(runtime, floor, None)
    }

    fn requirement_with_digest<'a>(
        runtime: Option<&'a str>,
        floor: Option<&'a str>,
        digest: Option<&'a str>,
    ) -> PiRuntimeRequirement<'a> {
        PiRuntimeRequirement {
            required_pi_agent_runtime_version: runtime,
            min_cli_version: floor,
            required_pi_session_construction_digest: digest,
        }
    }

    #[test]
    fn execution_context_requirement_selects_the_installed_cli() {
        let digest = "d".repeat(64);
        let requirement_value = serde_json::json!({
            "requiredPiAgentRuntimeVersion": "1.36.0",
            "minCliVersion": "9.352.7",
            "requiredPiSessionConstructionDigest": digest
        });
        let requirement = PiRuntimeRequirement::from_value(Some(&requirement_value));

        assert_eq!(
            requirement,
            requirement_with_digest(Some("1.36.0"), Some("9.352.7"), Some(&digest))
        );
        assert_eq!(
            select_pi_cli_launch(
                &requirement,
                Some(&installed_with_digest("9.352.7", "1.36.0", &digest))
            ),
            PiCliLaunchDecision {
                source: PiCliLaunchSource::Installed,
                reason: "session_construction_match",
            }
        );
    }

    #[test]
    fn missing_execution_context_requirement_uses_npx() {
        let absent = PiRuntimeRequirement::from_value(None);
        assert_eq!(absent, requirement(None, None));
        let decision = select_pi_cli_launch(&absent, Some(&installed("9.353.0", "1.36.0")));
        assert_eq!(decision.source, PiCliLaunchSource::Npx);
        assert_eq!(decision.reason, "launch_config_without_runtime_version");

        assert_eq!(
            PiRuntimeRequirement::from_value(Some(&serde_json::json!({}))),
            requirement(None, None)
        );
    }

    #[test]
    fn installed_cli_is_used_only_on_exact_runtime_match_at_or_above_floor() {
        let cli = installed("9.353.0", "1.36.0");
        let decision =
            select_pi_cli_launch(&requirement(Some("1.36.0"), Some("9.352.7")), Some(&cli));
        assert_eq!(decision.source, PiCliLaunchSource::Installed);
        assert_eq!(decision.reason, "runtime_version_match");

        let same_floor =
            select_pi_cli_launch(&requirement(Some("1.36.0"), Some("9.353.0")), Some(&cli));
        assert_eq!(same_floor.source, PiCliLaunchSource::Installed);
    }

    #[test]
    fn session_construction_digest_replaces_the_runtime_version_as_parity_key() {
        let digest = "d".repeat(64);
        let cli = installed_with_digest("9.353.0", "1.36.0", &digest);
        // A dependency-only runtime bump remains compatible by digest.
        let decision = select_pi_cli_launch(
            &requirement_with_digest(Some("1.36.1"), Some("9.352.7"), Some(&digest)),
            Some(&cli),
        );
        assert_eq!(decision.source, PiCliLaunchSource::Installed);
        assert_eq!(decision.reason, "session_construction_match");

        let other = "e".repeat(64);
        let legacy = installed("9.353.0", "1.36.0");
        let cases = [
            (
                requirement_with_digest(Some("1.36.0"), Some("9.352.7"), Some(&other)),
                &cli,
                "session_construction_mismatch",
            ),
            (
                requirement_with_digest(Some("1.36.0"), Some("9.352.7"), Some(&digest)),
                &legacy,
                "installed_cli_without_session_construction",
            ),
            (
                requirement_with_digest(Some("1.36.0"), Some("9.353.1"), Some(&digest)),
                &cli,
                "cli_below_floor",
            ),
            (
                requirement_with_digest(Some("1.36.0"), None, Some(&digest)),
                &cli,
                "launch_config_without_cli_floor",
            ),
        ];
        for (requirement, installed, reason) in cases {
            let decision = select_pi_cli_launch(&requirement, Some(installed));
            assert_eq!(decision.source, PiCliLaunchSource::Npx, "{reason}");
            assert_eq!(decision.reason, reason);
        }
    }

    #[test]
    fn every_other_case_uses_npx_with_a_bounded_reason() {
        let cli = installed("9.353.0", "1.36.0");
        let cases = [
            (
                requirement(Some("1.36.0"), Some("9.352.7")),
                None,
                "no_installed_cli",
            ),
            (
                requirement(None, Some("9.352.7")),
                Some(&cli),
                "launch_config_without_runtime_version",
            ),
            (
                requirement(Some("1.36.1"), Some("9.352.7")),
                Some(&cli),
                "runtime_version_mismatch",
            ),
            (
                requirement(Some("1.36.0"), None),
                Some(&cli),
                "launch_config_without_cli_floor",
            ),
            (
                requirement(Some("1.36.0"), Some("9.353.1")),
                Some(&cli),
                "cli_below_floor",
            ),
            (
                requirement(Some("1.36.0"), Some("v9")),
                Some(&cli),
                "invalid_version",
            ),
        ];
        for (requirement, installed, reason) in cases {
            let decision = select_pi_cli_launch(&requirement, installed);
            assert_eq!(decision.source, PiCliLaunchSource::Npx, "{reason}");
            assert_eq!(decision.reason, reason);
        }
    }

    #[test]
    fn missing_or_invalid_manifest_cannot_launch_cli() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("installed.json");
        assert_eq!(load_installed_okou_cli_from(&path).unwrap(), None);

        std::fs::write(&path, b"{not json").unwrap();
        assert!(load_installed_okou_cli_from(&path).is_err());

        std::fs::write(
            &path,
            serde_json::to_vec(&installed("9.353.0", "1.36.0")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            load_installed_okou_cli_from(&path).unwrap(),
            Some(installed("9.353.0", "1.36.0"))
        );
    }
}
