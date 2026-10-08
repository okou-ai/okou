//! Best-effort host-local observation of the dedicated WSS ingress service.
//! An active unit is not proof of public DNS, TLS, or per-Runner socket routing.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use crate::bounded_command::{BoundedCommandOutcome, run_bounded};

const SYSTEMCTL: &str = "/usr/bin/systemctl";
const WSS_INGRESS_UNIT: &str = "okou-wss-caddy.service";
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Missing, inactive, failed, unqueryable or timed-out services all fail closed.
/// The Runner and its other heartbeats must continue even if ingress is absent.
pub async fn is_active() -> bool {
    query_active(Path::new(SYSTEMCTL), PROBE_TIMEOUT).await
}

async fn query_active(systemctl: &Path, timeout: Duration) -> bool {
    let mut command = Command::new(systemctl);
    command
        .arg("is-active")
        .arg("--quiet")
        .arg(WSS_INGRESS_UNIT)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    matches!(
        run_bounded(command, SYSTEMCTL, timeout).await,
        Ok(BoundedCommandOutcome::Exited(status)) if status.success()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    async fn scripted_status(script: &str, timeout: Duration) -> bool {
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("systemctl");
        std::fs::write(&executable, script).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        query_active(&executable, timeout).await
    }

    #[tokio::test]
    async fn only_the_dedicated_active_unit_reports_true() {
        let script = "#!/bin/sh\n[ \"$1\" = is-active ] && [ \"$2\" = --quiet ] && [ \"$3\" = okou-wss-caddy.service ]\n";
        assert!(scripted_status(script, Duration::from_secs(1)).await);
        assert!(!scripted_status("#!/bin/sh\nexit 3\n", Duration::from_secs(1)).await);
    }

    #[tokio::test]
    async fn missing_or_stalled_systemctl_is_unavailable() {
        assert!(
            !query_active(
                Path::new("/nonexistent/systemctl"),
                Duration::from_millis(50)
            )
            .await
        );
        assert!(
            !scripted_status(
                "#!/bin/sh\nwhile :; do :; done\n",
                Duration::from_millis(20)
            )
            .await
        );
    }
}
