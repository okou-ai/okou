//! Monitor kernel log for iptables LOG entries from non-TCP VM traffic
//! and write matching entries to per-run network JSONL files.
//!
//! The iptables rule added by `sandbox-firecracker` logs non-TCP packets with prefix
//! `VM0:<peer_ip>:`. This module tails `dmesg -w`, parses those entries,
//! and submits JSON rows through `NetworkLogManager` for per-run attribution
//! and flushable file writes.

use std::process::Stdio;

use chrono::{DateTime, Utc};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;
use tracing::{info, warn};

use crate::network_log_drain::{
    DrainableLineReaderExit, NetworkLogDrainProducer, NetworkLogDrainRequest,
    run_drainable_line_reader,
};
use crate::network_log_manager::NetworkLogManager;
use crate::network_log_process::NetworkLogProcess;

/// Prefix used in iptables `--log-prefix` to identify our log lines.
const LOG_PREFIX: &str = "VM0:";

/// Handle to the background kmsg monitor. Call [`KmsgHandle::stop`] during
/// shutdown to cancel the async task and kill the `dmesg -w` child process.
pub struct KmsgHandle {
    process: NetworkLogProcess,
    stderr_task: Option<AbortOnDropHandle<()>>,
}

impl KmsgHandle {
    /// Await the monitor task, or pend forever after its completion has already
    /// been consumed.
    ///
    /// Keeping the task in the handle lets the runner reactor select on it
    /// without taking ownership unless it actually completes.
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

    /// Stop the kmsg monitor and wait for child and diagnostic-reader cleanup.
    pub async fn stop(self) -> crate::error::RunnerResult<()> {
        let Self {
            process,
            stderr_task,
        } = self;
        let result = process.stop().await;
        if let Some(task) = stderr_task {
            // Optional diagnostics must retire even when required cleanup fails,
            // but their result must not replace the required process result.
            let _ = task.await;
        }
        result?;
        info!("kmsg monitor stopped");
        Ok(())
    }

    /// Create a noop handle for testing. No `dmesg` process is spawned.
    #[cfg(any(test, feature = "test-support"))]
    pub fn noop() -> Self {
        Self {
            process: NetworkLogProcess::noop("dmesg", "kmsg"),
            stderr_task: None,
        }
    }

    /// Return a clone of the kmsg network-log drain producer.
    ///
    /// `NetworkLogDrainCoordinator` uses this to ask the `dmesg -w` reader
    /// task to drain complete log rows already visible to that task.
    pub fn drain_producer(&self) -> NetworkLogDrainProducer {
        self.process.drain_producer()
    }
}

/// Spawn a background async task that tails `dmesg -w` and writes
/// network log entries. Returns a handle; call [`KmsgHandle::stop`] during
/// shutdown so the tokio runtime can exit cleanly.
pub fn spawn(network_log_manager: NetworkLogManager) -> std::io::Result<KmsgHandle> {
    let mut command = tokio::process::Command::new("dmesg");
    configure_command(&mut command);
    let child = command.spawn()?;

    KmsgHandle::from_child(child, network_log_manager)
}

fn configure_command(command: &mut tokio::process::Command) {
    command
        .args(["-w"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    runner_host::parent_death::configure_parent_death_signal(command);
}

impl KmsgHandle {
    fn from_child(
        mut child: tokio::process::Child,
        network_log_manager: NetworkLogManager,
    ) -> std::io::Result<Self> {
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::other("failed to capture dmesg stdout"))?;

        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let (drain, drain_rx) = NetworkLogDrainProducer::channel("kmsg");

        // Keep diagnostics owned through stop, owner Drop and cancelled stop.
        // The shared token lets normal stop join the reader cooperatively.
        let stderr_task = child.stderr.take().map(|stderr| {
            let stderr_cancel = cancel.clone();
            AbortOnDropHandle::new(tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                loop {
                    tokio::select! {
                        _ = stderr_cancel.cancelled() => break,
                        result = lines.next_line() => {
                            match result {
                                Ok(Some(line)) if !line.is_empty() => {
                                    warn!(target: "dmesg", "stderr: {line}");
                                }
                                Ok(None) | Err(_) => break,
                                _ => {}
                            }
                        }
                    }
                }
            }))
        });

        let task = tokio::spawn(run_loop(network_log_manager, token, stdout, drain_rx));
        Ok(Self {
            process: NetworkLogProcess::new("dmesg", cancel, task, child, drain),
            stderr_task,
        })
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn from_test_child(
        child: tokio::process::Child,
        network_log_manager: NetworkLogManager,
    ) -> std::io::Result<Self> {
        Self::from_child(child, network_log_manager)
    }
}

/// Read kernel log lines from `dmesg -w` stdout, parse iptables LOG
/// entries, and write matching entries to per-run network JSONL files.
async fn run_loop(
    network_log_manager: NetworkLogManager,
    cancel: CancellationToken,
    stdout: tokio::process::ChildStdout,
    drain_rx: mpsc::Receiver<NetworkLogDrainRequest>,
) -> DrainableLineReaderExit {
    run_reader(
        network_log_manager,
        cancel,
        tokio::io::BufReader::new(stdout),
        drain_rx,
    )
    .await
}

async fn run_reader<R>(
    network_log_manager: NetworkLogManager,
    cancel: CancellationToken,
    reader: R,
    drain_rx: mpsc::Receiver<NetworkLogDrainRequest>,
) -> DrainableLineReaderExit
where
    R: AsyncBufRead + Unpin,
{
    run_drainable_line_reader(reader, cancel, drain_rx, move |line| {
        let network_log_manager = network_log_manager.clone();
        async move {
            handle_kmsg_line(&network_log_manager, &line).await;
        }
    })
    .await
}

async fn handle_kmsg_line(network_log_manager: &NetworkLogManager, line: &str) {
    // Fast check before acquiring lock.
    if !line.contains(LOG_PREFIX) {
        return;
    }

    if let Some(entry) = parse_log_message(line) {
        // Capture the timestamp before handing the row to the manager so
        // it reflects observation time, not delayed write time.
        let timestamp = Utc::now();
        append_log_entry(network_log_manager, &entry, timestamp).await;
    }
}

/// Parsed fields from a single iptables LOG line.
struct LogEntry {
    source_ip: String,
    dst_ip: String,
    dst_port: u16,
    protocol: String,
    packet_size: u16,
}

/// Parse an iptables LOG message from a `dmesg -w` output line.
///
/// `dmesg -w` outputs lines like:
/// ```text
/// [12345.678901] VM0:10.200.0.2:IN=vm0-ve-00-00 OUT=ens5 SRC=10.200.0.2 DST=8.8.8.8 LEN=64 ... PROTO=UDP SPT=12345 DPT=53
/// ```
/// The parser finds `VM0:` anywhere in the line, so the `[timestamp]` prefix is ignored.
fn parse_log_message(message: &str) -> Option<LogEntry> {
    // Find our prefix
    let prefix_pos = message.find(LOG_PREFIX)?;
    let after_prefix = &message[prefix_pos + LOG_PREFIX.len()..];

    // Extract the source IP from the prefix (VM0:<ip>:...)
    let colon_pos = after_prefix.find(':')?;
    let source_ip = &after_prefix[..colon_pos];

    // Parse key=value fields from the rest of the line
    let fields = &after_prefix[colon_pos + 1..];
    let src = extract_field(fields, "SRC=")?;
    let dst = extract_field(fields, "DST=")?;
    let len = extract_field(fields, "LEN=")?;
    let proto = extract_field(fields, "PROTO=")?;

    // DPT may not exist for ICMP
    let dst_port = extract_field(fields, "DPT=")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let packet_size = len.parse().unwrap_or(0);

    // Sanity check: SRC from fields should match prefix IP
    if src != source_ip {
        return None;
    }

    Some(LogEntry {
        source_ip: source_ip.to_string(),
        dst_ip: dst.to_string(),
        dst_port,
        protocol: proto.to_ascii_lowercase(),
        packet_size,
    })
}

/// Extract a value for a `KEY=value` field from an iptables log line.
///
/// Matches `KEY=` only at a whitespace-delimited token boundary, preventing
/// false matches on suffixes (e.g. `DSCP=` matching `SCP=`).
fn extract_field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    line.split_whitespace()
        .find_map(|tok| tok.strip_prefix(key))
}

async fn append_log_entry(
    network_log_manager: &NetworkLogManager,
    entry: &LogEntry,
    timestamp: DateTime<Utc>,
) -> bool {
    network_log_manager
        .append_for_ip(&entry.source_ip, network_log_row(entry, timestamp))
        .await
}

fn network_log_row(entry: &LogEntry, timestamp: DateTime<Utc>) -> serde_json::Value {
    // [NETWORK_LOG_FIELDS] — shared schema consumed by api-contracts.
    serde_json::json!({
        "timestamp": timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "type": entry.protocol,
        "host": entry.dst_ip,
        "port": entry.dst_port,
        "request_size": entry.packet_size,
    })
}

#[cfg(test)]
mod tests;
