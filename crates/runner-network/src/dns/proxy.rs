use std::future::Future;
use std::process::Stdio;

use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;
use tracing::info;

use sandbox_firecracker::{DNS_READINESS_HOSTNAME, DNS_READINESS_IPV4};

use super::log::tail_stderr;
use super::port::DnsPortReservation;
use crate::network_log_drain::{DrainableLineReaderExit, NetworkLogDrainProducer};
use crate::network_log_manager::NetworkLogManager;
use crate::network_log_process::NetworkLogProcess;

/// Handle to the dnsmasq process and its log monitor.
pub struct DnsProxy {
    process: NetworkLogProcess,
    port: u16,
}

impl DnsProxy {
    /// Await the log monitor task, or pend forever after its completion has
    /// already been consumed.
    pub async fn wait(&mut self) -> Result<DrainableLineReaderExit, tokio::task::JoinError> {
        self.process.wait().await
    }

    /// Start owned child cleanup without waiting for its completion.
    pub fn start_child_cleanup(&mut self) {
        self.process.start_child_cleanup();
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn set_reap_gate(&mut self, gate: crate::test_fixtures::ReapGate) {
        self.process.set_reap_gate(gate);
    }

    /// Stop the DNS proxy and wait for cleanup.
    pub async fn stop(self) -> crate::error::RunnerResult<()> {
        self.process.stop().await?;
        info!("dns proxy stopped");
        Ok(())
    }

    /// Return the port dnsmasq is listening on.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Return a clone of the DNS network-log drain producer.
    ///
    /// `NetworkLogDrainCoordinator` uses this to ask the dnsmasq stderr reader
    /// task to drain complete log rows already visible to that task.
    pub fn drain_producer(&self) -> NetworkLogDrainProducer {
        self.process.drain_producer()
    }

    /// Create a noop handle for testing. No `dnsmasq` process is spawned.
    #[cfg(any(test, feature = "test-support"))]
    pub fn noop() -> Self {
        Self::noop_on_port(0)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn noop_on_port(port: u16) -> Self {
        Self {
            process: NetworkLogProcess::noop("dnsmasq", "dns"),
            port,
        }
    }

    async fn from_started_child(
        mut child: tokio::process::Child,
        port: u16,
        network_log_manager: NetworkLogManager,
    ) -> std::io::Result<Self> {
        let Some(stderr) = child.stderr.take() else {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(std::io::Error::other("failed to capture dnsmasq stderr"));
        };

        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let (drain, drain_rx) = NetworkLogDrainProducer::channel("dns");
        let task = tokio::spawn(tail_stderr(stderr, network_log_manager, token, drain_rx));

        Ok(Self {
            process: NetworkLogProcess::new("dnsmasq", cancel, task, child, drain),
            port,
        })
    }

    #[cfg(any(test, feature = "test-support"))]
    pub async fn from_test_child(
        child: tokio::process::Child,
        network_log_manager: NetworkLogManager,
    ) -> std::io::Result<Self> {
        Self::from_started_child(child, 0, network_log_manager).await
    }

    /// Replace the stderr monitor with a task that panics when triggered.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn replace_monitor_with_panic_trigger_for_test(
        &mut self,
    ) -> std::sync::Arc<tokio::sync::Notify> {
        self.process
            .replace_monitor_with_panic_trigger_for_test("dns")
            .await
    }
}

/// Start dnsmasq and spawn a background task to parse its query log.
///
/// dnsmasq listens on a dynamically allocated port and forwards to upstream DNS.
/// The port is reserved before netns setup so iptables can redirect to a stable
/// value, then released immediately before spawning dnsmasq.
pub async fn start_on_reserved_port(
    reservation: DnsPortReservation,
    interface_pattern: String,
    network_log_manager: NetworkLogManager,
) -> std::io::Result<DnsProxy> {
    let port = reservation.port();
    drop(reservation);
    try_start(port, &interface_pattern, network_log_manager).await
}

/// Try to start dnsmasq on the given port. Returns the proxy handle on success.
async fn try_start(
    port: u16,
    interface_pattern: &str,
    network_log_manager: NetworkLogManager,
) -> std::io::Result<DnsProxy> {
    let mut command = tokio::process::Command::new("dnsmasq");
    command
        .args(dnsmasq_args(port, interface_pattern))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Prevent dnsmasq from creating an unowned wildcard listener if the runner
    // exits during spawn.
    runner_host::parent_death::configure_parent_death_signal(&mut command);

    // Give dnsmasq a moment to bind, then verify it's still running.
    // Catches port-already-in-use, missing binary (spawn itself errors),
    // and bad config that causes immediate exit.
    try_start_with_grace(command, port, network_log_manager, |_| async {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    })
    .await
}

async fn try_start_with_grace<F, Fut>(
    mut command: tokio::process::Command,
    port: u16,
    network_log_manager: NetworkLogManager,
    startup_grace: F,
) -> std::io::Result<DnsProxy>
where
    F: FnOnce(Option<u32>) -> Fut,
    Fut: Future<Output = ()>,
{
    let mut child = command.spawn()?;

    startup_grace(child.id()).await;
    match child.try_wait() {
        Ok(Some(status)) => {
            let stderr = read_child_stderr(&mut child).await;
            return Err(dnsmasq_immediate_exit_error(status, &stderr));
        }
        Err(e) => {
            let _ = child.kill().await;
            return Err(std::io::Error::other(format!(
                "dnsmasq process check failed: {e}"
            )));
        }
        Ok(None) => {} // still running — good
    }

    let proxy = DnsProxy::from_started_child(child, port, network_log_manager).await?;
    info!(port, "dns proxy started");
    Ok(proxy)
}

fn dnsmasq_immediate_exit_error(status: std::process::ExitStatus, stderr: &str) -> std::io::Error {
    let trimmed = stderr.trim();
    let message = if trimmed.is_empty() {
        format!("dnsmasq exited immediately with {status}")
    } else {
        format!("dnsmasq exited immediately with {status}: {trimmed}")
    };
    std::io::Error::new(dnsmasq_immediate_exit_error_kind(trimmed), message)
}

fn dnsmasq_immediate_exit_error_kind(stderr: &str) -> std::io::ErrorKind {
    if stderr
        .to_ascii_lowercase()
        .contains("address already in use")
    {
        std::io::ErrorKind::AddrInUse
    } else {
        std::io::ErrorKind::Other
    }
}

async fn read_child_stderr(child: &mut tokio::process::Child) -> String {
    let Some(mut stderr) = child.stderr.take() else {
        return String::new();
    };
    let mut output = String::new();
    if stderr.read_to_string(&mut output).await.is_err() {
        return String::new();
    }
    output
}

fn dnsmasq_args(port: u16, interface_pattern: &str) -> Vec<String> {
    vec![
        "--no-daemon".into(),
        "--no-resolv".into(),
        "--port".into(),
        port.to_string(),
        // Keep dnsmasq's default wildcard sockets so VM host-side veth churn
        // cannot rebuild a per-address listener set in its query event loop.
        // --interface still validates the arrival interface for every request.
        format!("--interface={interface_pattern}"),
        format!("--address=/{DNS_READINESS_HOSTNAME}/{DNS_READINESS_IPV4}"),
        format!("--local=/{DNS_READINESS_HOSTNAME}/"),
        "--server".into(),
        "8.8.8.8".into(),
        "--server".into(),
        "8.8.4.4".into(),
        "--log-queries=extra".into(),
        "--log-facility=-".into(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dnsmasq_args_use_wildcard_sockets_with_sandbox_interface_access_control() {
        let args = dnsmasq_args(5353, "vm0-ve-0a-*");

        assert!(args.contains(&"--interface=vm0-ve-0a-*".to_string()));
        assert!(!args.contains(&"--bind-dynamic".to_string()));
        assert!(!args.contains(&"--bind-interfaces".to_string()));
    }

    #[test]
    fn dnsmasq_args_preserve_port_upstream_and_logging_config() {
        let args = dnsmasq_args(5353, "vm0-ve-0a-*");

        assert_eq!(
            args,
            vec![
                "--no-daemon",
                "--no-resolv",
                "--port",
                "5353",
                "--interface=vm0-ve-0a-*",
                "--address=/vm0-readiness.invalid/192.0.2.1",
                "--local=/vm0-readiness.invalid/",
                "--server",
                "8.8.8.8",
                "--server",
                "8.8.4.4",
                "--log-queries=extra",
                "--log-facility=-",
            ]
        );
    }

    #[test]
    fn dnsmasq_immediate_exit_error_kind_detects_port_race() {
        let stderr =
            "dnsmasq: failed to create listening socket for 127.0.0.1: Address already in use";

        assert_eq!(
            dnsmasq_immediate_exit_error_kind(stderr),
            std::io::ErrorKind::AddrInUse
        );
    }

    #[test]
    fn dnsmasq_immediate_exit_error_kind_keeps_non_port_errors_fatal() {
        let stderr =
            "dnsmasq: failed to create listening socket for 10.200.52.97: Too many open files";

        assert_eq!(
            dnsmasq_immediate_exit_error_kind(stderr),
            std::io::ErrorKind::Other
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn early_child_failure_is_reaped_before_returning() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU32, Ordering};

        let mut command = tokio::process::Command::new("sh");
        command
            .args([
                "-c",
                "printf 'dnsmasq: Address already in use\\n' >&2; exit 1",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let observed_pid = Arc::new(AtomicU32::new(0));
        let grace_pid = Arc::clone(&observed_pid);

        let error =
            match try_start_with_grace(command, 5353, NetworkLogManager::new(), move |pid| {
                let pid = pid.expect("test child should have a process id");
                grace_pid.store(pid, Ordering::SeqCst);
                async move {
                    tokio::time::timeout(std::time::Duration::from_secs(2), async {
                        loop {
                            if runner_host::process::read_process_stat(pid)
                                .await
                                .is_some_and(|stat| stat.state == 'Z')
                            {
                                break;
                            }
                            tokio::task::yield_now().await;
                        }
                    })
                    .await
                    .expect("test child should exit before the startup probe");
                }
            })
            .await
            {
                Ok(_) => panic!("early child failure should not produce a DNS proxy"),
                Err(error) => error,
            };

        assert_eq!(error.kind(), std::io::ErrorKind::AddrInUse);
        assert!(error.to_string().contains("Address already in use"));
        let pid = observed_pid.load(Ordering::SeqCst);
        assert!(
            runner_host::process::read_process_stat(pid).await.is_none(),
            "failed startup child should be reaped before returning"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn running_child_is_transferred_to_proxy_ownership() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU32, Ordering};

        let mut command = tokio::process::Command::new("sh");
        command
            .args(["-c", "exec cat >&2"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let observed_pid = Arc::new(AtomicU32::new(0));
        let grace_pid = Arc::clone(&observed_pid);

        let proxy = try_start_with_grace(command, 5353, NetworkLogManager::new(), move |pid| {
            grace_pid.store(
                pid.expect("test child should have a process id"),
                Ordering::SeqCst,
            );
            async {}
        })
        .await
        .expect("running child should produce a DNS proxy");
        let pid = observed_pid.load(Ordering::SeqCst);
        let starttime = runner_host::process::read_process_stat(pid)
            .await
            .expect("running child should remain owned by the DNS proxy")
            .starttime;

        assert_eq!(proxy.port(), 5353);
        proxy.stop().await.unwrap();
        assert_ne!(
            runner_host::process::read_process_stat(pid)
                .await
                .map(|stat| stat.starttime),
            Some(starttime),
            "stopped DNS proxy should reap its child"
        );
    }
}
