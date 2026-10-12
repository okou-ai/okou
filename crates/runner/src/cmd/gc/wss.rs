use crate::error::{RunnerError, RunnerResult};
use runner_host::paths::HomePaths;

use super::report::GcReport;

pub(super) async fn gc_wss_sockets(home: &HomePaths, dry_run: bool) -> RunnerResult<GcReport> {
    let home = home.clone();
    let retired =
        tokio::task::spawn_blocking(move || runner_host::gc::gc_wss_sockets(&home, dry_run))
            .await
            .map_err(|error| RunnerError::Internal(format!("WSS GC task failed: {error}")))??;
    Ok(GcReport::cleanup(retired, 0))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[tokio::test]
    async fn phase_preserves_dry_run_and_reports_retired_ids() {
        let root = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(root.path().to_owned());
        let directory = home.wss_dir();
        std::fs::create_dir(&directory).unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o710)).unwrap();
        let path = directory.join(format!("{}.lock", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            gc_wss_sockets(&home, true).await.unwrap(),
            GcReport::cleanup(1, 0)
        );
        assert!(path.exists());
        assert_eq!(
            gc_wss_sockets(&home, false).await.unwrap(),
            GcReport::cleanup(1, 0)
        );
        assert!(!path.exists());
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(gc_wss_sockets(&home, false).await.is_err());
    }
}
