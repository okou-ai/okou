//! Bounded passive snapshot for terminal guest DNS readiness failures.

use std::time::Duration;

use guest_control_client::{
    ExecCaptureRequest, ExecOperationResult, ExecOwnedCapturedOutput, GuestControlClient,
};
use tracing::warn;

use crate::command::{CommandError, exec_with_timeout};

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(2);
const HOST_COMMAND_TIMEOUT: Duration = Duration::from_millis(1_500);
const GUEST_PROCESS_TIMEOUT_MS: u32 = 1_500;
const GUEST_WAIT_TIMEOUT: Duration = Duration::from_millis(1_750);
const GUEST_OUTPUT_LIMIT_BYTES: u32 = 4 * 1024;
const LOG_OUTPUT_LIMIT_BYTES: usize = 4 * 1024;
const GUEST_DIAGNOSTIC_LABEL: &str = "guest-dns-failure-diagnostics";

const GUEST_STATE_COMMAND: &str = r#"set +e
/usr/sbin/ip -details -statistics link show dev eth0 2>&1
/usr/sbin/ip -4 address show dev eth0 2>&1
/usr/sbin/ip -4 route show table all 2>&1
/usr/sbin/ip neighbor show dev eth0 2>&1
/usr/bin/cat /etc/resolv.conf 2>&1
/usr/bin/grep '^hosts:' /etc/nsswitch.conf 2>&1
true
"#;

#[derive(Clone, Copy)]
pub(crate) struct GuestDnsFailureDiagnosticContext<'a> {
    pub(crate) sandbox_id: &'a str,
    pub(crate) profile: &'a str,
    pub(crate) namespace: &'a str,
    pub(crate) host_device: &'a str,
    pub(crate) peer_ip: &'a str,
    pub(crate) dns_port: u16,
    pub(crate) readiness_attempts: u16,
    pub(crate) startup_mode: &'static str,
}

pub(crate) async fn capture_guest_dns_failure_diagnostics(
    guest: &GuestControlClient,
    context: GuestDnsFailureDiagnosticContext<'_>,
) {
    if tokio::time::timeout(SNAPSHOT_TIMEOUT, capture_snapshot(guest, context))
        .await
        .is_err()
    {
        warn!(
            id = context.sandbox_id,
            profile = context.profile,
            namespace = context.namespace,
            host_device = context.host_device,
            peer_ip = context.peer_ip,
            dns_port = context.dns_port,
            readiness_attempts = context.readiness_attempts,
            startup_mode = context.startup_mode,
            timeout_ms = SNAPSHOT_TIMEOUT.as_millis() as u64,
            "guest DNS failure diagnostic snapshot timed out"
        );
    }
}

async fn capture_snapshot(
    guest: &GuestControlClient,
    context: GuestDnsFailureDiagnosticContext<'_>,
) {
    let namespace = context.namespace;
    let peer_ip = context.peer_ip;
    let namespace_link_args = [
        "-n",
        namespace,
        "-details",
        "-statistics",
        "link",
        "show",
        "dev",
        "veth0",
    ];
    let root_link_args = [
        "-details",
        "-statistics",
        "link",
        "show",
        "dev",
        context.host_device,
    ];
    let namespace_nat_args = [
        "netns",
        "exec",
        namespace,
        "iptables-save",
        "-c",
        "-t",
        "nat",
    ];
    let conntrack_source_args = ["-L", "-s", peer_ip];
    let conntrack_destination_args = ["-L", "-d", peer_ip];
    let namespace_conntrack_args = [
        "netns",
        "exec",
        namespace,
        "conntrack",
        "-L",
        "-p",
        "udp",
        "--dport",
        "53",
    ];
    let (
        guest_state,
        namespace_link,
        root_link,
        namespace_nat,
        conntrack_source,
        conntrack_destination,
        namespace_dns_conntrack,
    ) = tokio::join!(
        capture_guest_state(guest),
        exec_with_timeout("ip", &namespace_link_args, HOST_COMMAND_TIMEOUT),
        exec_with_timeout("ip", &root_link_args, HOST_COMMAND_TIMEOUT),
        exec_with_timeout("ip", &namespace_nat_args, HOST_COMMAND_TIMEOUT),
        exec_with_timeout("conntrack", &conntrack_source_args, HOST_COMMAND_TIMEOUT),
        exec_with_timeout(
            "conntrack",
            &conntrack_destination_args,
            HOST_COMMAND_TIMEOUT,
        ),
        exec_with_timeout("ip", &namespace_conntrack_args, HOST_COMMAND_TIMEOUT),
    );

    log_component(context, "guest_state", guest_state);
    log_component(context, "namespace_link", command_output(namespace_link));
    log_component(context, "root_link", command_output(root_link));
    log_component(context, "namespace_nat", command_output(namespace_nat));
    log_component(
        context,
        "conntrack_source",
        command_output(conntrack_source),
    );
    log_component(
        context,
        "conntrack_destination",
        command_output(conntrack_destination),
    );
    log_component(
        context,
        "namespace_dns_conntrack",
        command_output(namespace_dns_conntrack),
    );
}

async fn capture_guest_state(guest: &GuestControlClient) -> String {
    let request = ExecCaptureRequest {
        timeout_ms: GUEST_PROCESS_TIMEOUT_MS,
        command: GUEST_STATE_COMMAND,
        env: &[],
        sudo: false,
        label: GUEST_DIAGNOSTIC_LABEL,
        stdout_limit_bytes: GUEST_OUTPUT_LIMIT_BYTES,
        stderr_limit_bytes: GUEST_OUTPUT_LIMIT_BYTES,
        expected_exit_codes: &[],
        stdin_bytes: None,
        wait_timeout: GUEST_WAIT_TIMEOUT,
    };

    match guest.exec_operation_capture(request).await {
        Ok(result) => format_guest_result(result),
        Err(error) => bounded_output(format!("transport_error={:?}", error.kind())),
    }
}

fn format_guest_result(result: ExecOperationResult) -> String {
    let (stdout, stdout_truncated) = captured_output(result.stdout);
    let (stderr, stderr_truncated) = captured_output(result.stderr);
    bounded_output(format!(
        "termination={:?} duration_ms={} stream_overflowed={} stdout_truncated={} stderr_truncated={}\nstdout:\n{}\nstderr:\n{}",
        result.termination,
        result.duration_ms,
        result.stream_overflowed,
        stdout_truncated,
        stderr_truncated,
        stdout,
        stderr,
    ))
}

fn captured_output(output: ExecOwnedCapturedOutput) -> (String, bool) {
    match output {
        ExecOwnedCapturedOutput::Discarded => ("[discarded]".to_string(), false),
        ExecOwnedCapturedOutput::Captured { bytes, truncated } => {
            (String::from_utf8_lossy(&bytes).into_owned(), truncated)
        }
    }
}

fn command_output(result: Result<String, CommandError>) -> String {
    match result {
        Ok(output) if output.is_empty() => "[no output]".to_string(),
        Ok(output) => bounded_output(output),
        Err(error) => bounded_output(format!("command_error={error}")),
    }
}

fn bounded_output(output: String) -> String {
    if output.len() <= LOG_OUTPUT_LIMIT_BYTES {
        return output;
    }
    let end = output.floor_char_boundary(LOG_OUTPUT_LIMIT_BYTES);
    format!("{}\n[output truncated]", &output[..end])
}

fn log_component(
    context: GuestDnsFailureDiagnosticContext<'_>,
    component: &'static str,
    output: String,
) {
    warn!(
        id = context.sandbox_id,
        profile = context.profile,
        namespace = context.namespace,
        host_device = context.host_device,
        peer_ip = context.peer_ip,
        dns_port = context.dns_port,
        readiness_attempts = context.readiness_attempts,
        startup_mode = context.startup_mode,
        component,
        output,
        "guest DNS failure diagnostic component"
    );
}

#[cfg(test)]
mod tests;
