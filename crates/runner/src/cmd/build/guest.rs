use std::path::{Path, PathBuf};

use crate::error::{RunnerError, RunnerResult};

use super::BuildArgs;

#[derive(Clone, Copy)]
pub(super) struct GuestDefinition {
    pub(super) name: &'static str,
    pub(super) destination: &'static str,
}

include!(concat!(env!("OUT_DIR"), "/guest_binaries.rs"));

pub(super) fn guest_definitions() -> &'static [GuestDefinition] {
    GUEST_DEFINITIONS
}

pub(super) struct ResolvedGuest {
    pub(super) definition: &'static GuestDefinition,
    pub(super) path: PathBuf,
}

pub(super) struct GuestBinaries {
    // Keeps extracted bundled guest binaries alive for hash computation and
    // customize-rootfs.sh execution.
    pub(super) _temp_dir: tempfile::TempDir,
    pub(super) entries: Vec<ResolvedGuest>,
}

impl GuestBinaries {
    pub(super) async fn resolve(args: &mut BuildArgs) -> RunnerResult<Self> {
        let temp_dir = tempfile::tempdir()
            .map_err(|e| RunnerError::Internal(format!("create temp dir: {e}")))?;
        let temp_path = temp_dir.path();
        let mut entries = Vec::with_capacity(GUEST_DEFINITIONS.len());
        for definition in GUEST_DEFINITIONS {
            let path = resolve_guest(
                args.take_guest_path(definition.name),
                definition.name,
                temp_path,
            )
            .await?;
            entries.push(ResolvedGuest { definition, path });
        }

        Ok(Self {
            _temp_dir: temp_dir,
            entries,
        })
    }

    pub(super) fn hash_inputs(&self) -> Vec<(&Path, &str)> {
        self.entries
            .iter()
            .map(|guest| (guest.path.as_path(), guest.definition.destination))
            .collect()
    }

    pub(super) fn iter(&self) -> impl Iterator<Item = &ResolvedGuest> {
        self.entries.iter()
    }
}

/// Resolve a guest binary path: CLI arg takes priority, then bundled binary.
///
/// The returned path always points into `tmp_dir`, so hash computation and
/// rootfs customization consumes the same bytes even if the original CLI
/// path is replaced while the build is running.
async fn resolve_guest(
    cli_path: Option<PathBuf>,
    name: &str,
    tmp_dir: &Path,
) -> RunnerResult<PathBuf> {
    let dest = tmp_dir.join(name);
    if let Some(p) = cli_path {
        tokio::fs::copy(&p, &dest).await.map_err(|e| {
            RunnerError::Internal(format!(
                "copy {name} {} → {}: {e}",
                p.display(),
                dest.display()
            ))
        })?;
    } else if let Some(bytes) = bundled_guest(name) {
        tokio::fs::write(&dest, bytes)
            .await
            .map_err(|e| RunnerError::Internal(format!("write bundled {name}: {e}")))?;
    } else {
        return Err(RunnerError::Internal(format!(
            "missing --{} and no bundled binary available",
            name
        )));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
            .await
            .map_err(|e| RunnerError::Internal(format!("chmod {name}: {e}")))?;
    }
    Ok(dest)
}

runner_test_group!(cmd_gc_build; #[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resolve_guest_snapshots_cli_binary_into_temp_dir() {
        let temp_dir = tempfile::tempdir().unwrap();
        let source = temp_dir.path().join("source-guest");
        tokio::fs::write(&source, b"v1").await.unwrap();

        let tmp_dir = tempfile::tempdir().unwrap();
        let resolved = resolve_guest(Some(source.clone()), "guest-agent", tmp_dir.path())
            .await
            .unwrap();

        tokio::fs::write(&source, b"v2").await.unwrap();
        assert_eq!(tokio::fs::read(&resolved).await.unwrap(), b"v1");
        assert!(resolved.starts_with(tmp_dir.path()));
        assert_ne!(resolved, source);
    }
});
