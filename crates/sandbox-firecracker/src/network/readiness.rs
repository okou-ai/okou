use std::fmt;
use std::fs::File;
use std::future::Future;
use std::io;
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::{Duration, Instant};

use nix::sched::{CloneFlags, setns};
use tokio::sync::oneshot;
use tracing::{info, warn};

use crate::duration::duration_ms;
use crate::guest_dns_probe::{
    DNS_PROBE_DESTINATION_PORT, DNS_READINESS_HOSTNAME, DNS_READINESS_IPV4,
};

/// Maximum time allowed for the complete asynchronous namespace readiness operation.
///
/// The production probe's two-second `PROBE_TIMEOUT` plus its
/// `PROBE_THREAD_GRACE` totals 2.25 seconds. This outer three-second bound
/// must remain longer than that inner wait. Each socket read is separately
/// bounded by `PROBE_ATTEMPT_TIMEOUT`, capped by the remaining probe deadline.
pub(super) const DNS_READINESS_OPERATION_TIMEOUT: Duration = Duration::from_secs(3);

pub(super) type DnsReadinessFuture =
    Pin<Box<dyn Future<Output = Result<u16, DnsReadinessError>> + Send>>;
pub(super) type DnsReadinessProbe = Arc<dyn Fn(String) -> DnsReadinessFuture + Send + Sync>;

const DNS_RESPONSE_MAX_BYTES: usize = 512;
const DNS_QUERY_FLAGS_RECURSION_DESIRED: u16 = 0x0100;
const DNS_RESPONSE_FLAG: u16 = 0x8000;
const DNS_RESPONSE_OPCODE_MASK: u16 = 0x7800;
const DNS_RESPONSE_TRUNCATED_FLAG: u16 = 0x0200;
const DNS_RESPONSE_CODE_MASK: u16 = 0x000f;
const DNS_TYPE_A: u16 = 1;
const DNS_CLASS_IN: u16 = 1;
const DNS_NAME_MAX_BYTES: usize = 255;
/// Deadline for the blocking UDP probe on the candidate namespace.
///
/// The async wait adds `PROBE_THREAD_GRACE` so the one-shot thread can publish
/// a result after the blocking deadline. The endpoint caps each socket read
/// at `PROBE_ATTEMPT_TIMEOUT` and retries until this deadline.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
/// Grace period for receiving the one-shot thread's result after `PROBE_TIMEOUT`.
const PROBE_THREAD_GRACE: Duration = Duration::from_millis(250);
/// Maximum read wait for one UDP probe attempt; the remaining probe deadline can make it shorter.
const PROBE_ATTEMPT_TIMEOUT: Duration = Duration::from_millis(200);
/// Delay between probe attempts, capped by the remaining probe deadline.
const PROBE_RETRY_DELAY: Duration = Duration::from_millis(25);
const NETNS_DIR: &str = "/var/run/netns";

static NEXT_TRANSACTION_ID: AtomicU16 = AtomicU16::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DnsReadinessStage {
    SpawnThread,
    OpenCurrentNamespace,
    OpenTargetNamespace,
    EnterNamespace,
    BindSocket,
    ConnectSocket,
    ConfigureSocket,
    BuildQuery,
    SendQuery,
    ReceiveResponse,
    ValidateResponse,
    RestoreNamespace,
    WaitForThread,
    Timeout,
}

impl DnsReadinessStage {
    fn as_str(self) -> &'static str {
        match self {
            Self::SpawnThread => "spawn_thread",
            Self::OpenCurrentNamespace => "open_current_namespace",
            Self::OpenTargetNamespace => "open_target_namespace",
            Self::EnterNamespace => "enter_namespace",
            Self::BindSocket => "bind_socket",
            Self::ConnectSocket => "connect_socket",
            Self::ConfigureSocket => "configure_socket",
            Self::BuildQuery => "build_query",
            Self::SendQuery => "send_query",
            Self::ReceiveResponse => "receive_response",
            Self::ValidateResponse => "validate_response",
            Self::RestoreNamespace => "restore_namespace",
            Self::WaitForThread => "wait_for_thread",
            Self::Timeout => "timeout",
        }
    }
}

impl fmt::Display for DnsReadinessStage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Bounded failure from the runner-owned namespace DNS readiness probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DnsReadinessError {
    stage: DnsReadinessStage,
    io_kind: Option<io::ErrorKind>,
    attempts: u16,
}

impl DnsReadinessError {
    fn stage(stage: DnsReadinessStage) -> Self {
        Self {
            stage,
            io_kind: None,
            attempts: 0,
        }
    }

    fn io(stage: DnsReadinessStage, error: &io::Error) -> Self {
        Self {
            stage,
            io_kind: Some(error.kind()),
            attempts: 0,
        }
    }

    fn errno(stage: DnsReadinessStage, errno: nix::errno::Errno) -> Self {
        let error = io::Error::from_raw_os_error(errno as i32);
        Self::io(stage, &error)
    }

    fn stage_name(&self) -> DnsReadinessStage {
        self.stage
    }

    pub(crate) fn io_kind(&self) -> Option<io::ErrorKind> {
        self.io_kind
    }

    pub(crate) fn attempts(&self) -> u16 {
        self.attempts
    }

    pub(super) fn timeout() -> Self {
        Self::stage(DnsReadinessStage::Timeout)
    }

    fn with_attempts(mut self, attempts: u16) -> Self {
        self.attempts = attempts;
        self
    }
}

impl fmt::Display for DnsReadinessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DNS readiness failed at stage={}", self.stage)?;
        if let Some(kind) = self.io_kind {
            write!(f, " io_kind={kind:?}")?;
        }
        write!(f, " attempts={}", self.attempts)?;
        Ok(())
    }
}

impl std::error::Error for DnsReadinessError {}

pub(super) fn production_dns_readiness_probe() -> DnsReadinessProbe {
    Arc::new(|namespace| Box::pin(probe_namespace_dns(namespace)))
}

/// Runs a namespace DNS probe under the caller-facing readiness timeout.
///
/// The outer timeout bounds the async wait. If it expires, dropping that wait
/// does not cancel a blocking probe that is already running on its one-shot OS
/// thread. The inner probe deadline and per-attempt socket timeout keep that
/// detached operation bounded; thread grace only extends the async wait for
/// the thread's result.
pub(super) async fn run_dns_readiness_probe(
    namespace: String,
    probe: DnsReadinessProbe,
    timeout: Duration,
) -> Result<u16, DnsReadinessError> {
    let started = Instant::now();
    let result = match tokio::time::timeout(timeout, probe(namespace.clone())).await {
        Ok(result) => result,
        Err(_) => Err(DnsReadinessError::timeout()),
    };
    match &result {
        Ok(attempts) => info!(
            name = %namespace,
            attempts,
            elapsed_ms = duration_ms(started.elapsed()),
            "namespace DNS readiness probe succeeded"
        ),
        Err(error) => warn!(
            name = %namespace,
            stage = %error.stage_name(),
            io_kind = ?error.io_kind(),
            attempts = error.attempts(),
            elapsed_ms = duration_ms(started.elapsed()),
            "namespace DNS readiness probe failed"
        ),
    }
    result
}

pub(super) async fn probe_namespace_dns(namespace: String) -> Result<u16, DnsReadinessError> {
    probe_namespace_dns_for_hostname(namespace, PROBE_TIMEOUT, DNS_READINESS_HOSTNAME).await
}

/// Waits for a blocking DNS probe performed by a fresh one-shot OS thread.
///
/// Linux network namespace membership is thread-local: `setns` changes the
/// namespace of the calling thread. This operation therefore cannot use a
/// Tokio task or a reusable blocking-pool worker. If namespace restoration
/// fails, a reusable worker could return to its pool while still attached to
/// the target namespace; a fresh thread can exit instead.
///
/// The oneshot channel transports the result but does not own the blocking
/// operation. Timing out or dropping the receiver stops waiting for the result,
/// not the OS thread. The blocking probe remains bounded by its deadline and
/// per-attempt socket timeout, and this wait allows `PROBE_THREAD_GRACE` for
/// the thread to publish its result.
async fn probe_namespace_dns_for_hostname(
    namespace: String,
    probe_timeout: Duration,
    hostname: &'static str,
) -> Result<u16, DnsReadinessError> {
    let (tx, rx) = oneshot::channel();
    std::thread::Builder::new()
        .name("vm0-dns-readiness".into())
        .spawn(move || {
            let result = probe_namespace_dns_blocking(&namespace, probe_timeout, hostname);
            let _ = tx.send(result);
        })
        .map_err(|error| DnsReadinessError::io(DnsReadinessStage::SpawnThread, &error))?;

    match tokio::time::timeout(probe_timeout + PROBE_THREAD_GRACE, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(DnsReadinessError::stage(DnsReadinessStage::WaitForThread)),
        Err(_) => Err(DnsReadinessError::stage(DnsReadinessStage::Timeout)),
    }
}

/// Enters the target namespace, performs the blocking probe, and restores the
/// original namespace before returning its result.
///
/// The current namespace descriptor is opened before `setns` changes this
/// one-shot thread's namespace. Restoration is attempted after the DNS probe
/// regardless of the probe result. A restoration failure is returned before
/// the probe result can be published, after which the one-shot thread exits.
fn probe_namespace_dns_blocking(
    namespace: &str,
    probe_timeout: Duration,
    hostname: &str,
) -> Result<u16, DnsReadinessError> {
    let current = File::open("/proc/self/ns/net")
        .map_err(|error| DnsReadinessError::io(DnsReadinessStage::OpenCurrentNamespace, &error))?;
    let target = File::open(Path::new(NETNS_DIR).join(namespace))
        .map_err(|error| DnsReadinessError::io(DnsReadinessStage::OpenTargetNamespace, &error))?;
    setns(&target, CloneFlags::CLONE_NEWNET)
        .map_err(|errno| DnsReadinessError::errno(DnsReadinessStage::EnterNamespace, errno))?;

    let result = probe_dns_endpoint(
        SocketAddrV4::new(DNS_READINESS_IPV4, DNS_PROBE_DESTINATION_PORT),
        probe_timeout,
        hostname,
    );
    let restore = setns(&current, CloneFlags::CLONE_NEWNET)
        .map_err(|errno| DnsReadinessError::errno(DnsReadinessStage::RestoreNamespace, errno));

    restore?;
    result
}

fn probe_dns_endpoint(
    destination: SocketAddrV4,
    timeout: Duration,
    hostname: &str,
) -> Result<u16, DnsReadinessError> {
    let socket = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| DnsReadinessError::io(DnsReadinessStage::BindSocket, &error))?;
    socket
        .connect(destination)
        .map_err(|error| DnsReadinessError::io(DnsReadinessStage::ConnectSocket, &error))?;

    let started = Instant::now();
    let deadline = started + timeout;
    let mut attempts = 0_u16;
    let mut last_error = DnsReadinessError::timeout();
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(last_error);
        }
        let attempt_timeout = PROBE_ATTEMPT_TIMEOUT.min(deadline.saturating_duration_since(now));
        socket
            .set_read_timeout(Some(attempt_timeout))
            .map_err(|error| DnsReadinessError::io(DnsReadinessStage::ConfigureSocket, &error))?;

        attempts = attempts.saturating_add(1);
        let transaction_id = NEXT_TRANSACTION_ID.fetch_add(1, Ordering::Relaxed);
        let query = build_dns_query(transaction_id, hostname)
            .map_err(|error| error.with_attempts(attempts))?;
        if let Err(error) = socket.send(&query) {
            last_error =
                DnsReadinessError::io(DnsReadinessStage::SendQuery, &error).with_attempts(attempts);
            sleep_before_retry(deadline);
            continue;
        }

        let mut response = [0_u8; DNS_RESPONSE_MAX_BYTES];
        match socket.recv(&mut response) {
            Ok(size) => {
                let Some(response) = response.get(..size) else {
                    last_error = invalid_response().with_attempts(attempts);
                    sleep_before_retry(deadline);
                    continue;
                };
                match validate_dns_response(response, transaction_id, hostname, DNS_READINESS_IPV4)
                {
                    Ok(()) => return Ok(attempts),
                    Err(error) => last_error = error.with_attempts(attempts),
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                last_error = DnsReadinessError::timeout().with_attempts(attempts);
            }
            Err(error) => {
                last_error = DnsReadinessError::io(DnsReadinessStage::ReceiveResponse, &error)
                    .with_attempts(attempts);
            }
        }
        sleep_before_retry(deadline);
    }
}

fn sleep_before_retry(deadline: Instant) {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if !remaining.is_zero() {
        std::thread::sleep(PROBE_RETRY_DELAY.min(remaining));
    }
}

fn build_dns_query(transaction_id: u16, hostname: &str) -> Result<Vec<u8>, DnsReadinessError> {
    let mut query = Vec::with_capacity(64);
    query.extend_from_slice(&transaction_id.to_be_bytes());
    query.extend_from_slice(&DNS_QUERY_FLAGS_RECURSION_DESIRED.to_be_bytes());
    query.extend_from_slice(&1_u16.to_be_bytes());
    query.extend_from_slice(&0_u16.to_be_bytes());
    query.extend_from_slice(&0_u16.to_be_bytes());
    query.extend_from_slice(&0_u16.to_be_bytes());
    for label in hostname.split('.') {
        let length = u8::try_from(label.len())
            .map_err(|_| DnsReadinessError::stage(DnsReadinessStage::BuildQuery))?;
        query.push(length);
        query.extend_from_slice(label.as_bytes());
    }
    query.push(0);
    query.extend_from_slice(&DNS_TYPE_A.to_be_bytes());
    query.extend_from_slice(&DNS_CLASS_IN.to_be_bytes());
    Ok(query)
}

fn validate_dns_response(
    response: &[u8],
    transaction_id: u16,
    expected_hostname: &str,
    expected_ip: Ipv4Addr,
) -> Result<(), DnsReadinessError> {
    let mut cursor = 0;
    let response_id = read_u16(response, &mut cursor)?;
    let flags = read_u16(response, &mut cursor)?;
    let question_count = read_u16(response, &mut cursor)?;
    let answer_count = read_u16(response, &mut cursor)?;
    let _authority_count = read_u16(response, &mut cursor)?;
    let _additional_count = read_u16(response, &mut cursor)?;

    if response_id != transaction_id
        || flags & DNS_RESPONSE_FLAG == 0
        || flags & DNS_RESPONSE_OPCODE_MASK != 0
        || flags & DNS_RESPONSE_TRUNCATED_FLAG != 0
        || flags & DNS_RESPONSE_CODE_MASK != 0
        || question_count != 1
        || answer_count == 0
    {
        return Err(DnsReadinessError::stage(
            DnsReadinessStage::ValidateResponse,
        ));
    }

    let question_name = read_dns_name(response, &mut cursor)?;
    let question_type = read_u16(response, &mut cursor)?;
    let question_class = read_u16(response, &mut cursor)?;
    if !dns_name_matches(&question_name, expected_hostname)
        || question_type != DNS_TYPE_A
        || question_class != DNS_CLASS_IN
    {
        return Err(invalid_response());
    }

    let mut found_expected_answer = false;
    for _ in 0..answer_count {
        let owner_name = read_dns_name(response, &mut cursor)?;
        let record_type = read_u16(response, &mut cursor)?;
        let class = read_u16(response, &mut cursor)?;
        skip_bytes(response, &mut cursor, 4)?;
        let data_len = usize::from(read_u16(response, &mut cursor)?);
        let data_start = cursor;
        skip_bytes(response, &mut cursor, data_len)?;
        let expected_octets = expected_ip.octets();
        if record_type == DNS_TYPE_A
            && class == DNS_CLASS_IN
            && data_len == 4
            && dns_name_matches(&owner_name, expected_hostname)
            && response.get(data_start..cursor) == Some(expected_octets.as_ref())
        {
            found_expected_answer = true;
        }
    }

    if found_expected_answer {
        Ok(())
    } else {
        Err(invalid_response())
    }
}

fn read_u16(response: &[u8], cursor: &mut usize) -> Result<u16, DnsReadinessError> {
    let end = cursor.checked_add(2).ok_or_else(invalid_response)?;
    let bytes = response
        .get(*cursor..end)
        .and_then(|bytes| <[u8; 2]>::try_from(bytes).ok())
        .ok_or_else(invalid_response)?;
    *cursor = end;
    Ok(u16::from_be_bytes(bytes))
}

fn skip_bytes(response: &[u8], cursor: &mut usize, count: usize) -> Result<(), DnsReadinessError> {
    *cursor = cursor.checked_add(count).ok_or_else(invalid_response)?;
    if *cursor > response.len() {
        return Err(invalid_response());
    }
    Ok(())
}

fn read_dns_name<'a>(
    response: &'a [u8],
    cursor: &mut usize,
) -> Result<Vec<&'a [u8]>, DnsReadinessError> {
    let mut labels = Vec::new();
    let mut position = *cursor;
    let mut encoded_end = None;
    let mut pointer_limit = position;
    let mut expanded_len = 1_usize;

    loop {
        let length = *response.get(position).ok_or_else(invalid_response)?;
        if length == 0 {
            let end = position.checked_add(1).ok_or_else(invalid_response)?;
            *cursor = encoded_end.unwrap_or(end);
            return Ok(labels);
        }
        if length & 0xc0 == 0xc0 {
            let pointer = read_u16(response, &mut position)?;
            let target = usize::from(pointer & 0x3fff);
            if target >= pointer_limit {
                return Err(invalid_response());
            }
            pointer_limit = target;
            if encoded_end.is_none() {
                encoded_end = Some(position);
            }
            position = target;
            continue;
        }
        if length & 0xc0 != 0 {
            return Err(invalid_response());
        }

        let label_start = position.checked_add(1).ok_or_else(invalid_response)?;
        let label_end = label_start
            .checked_add(usize::from(length))
            .ok_or_else(invalid_response)?;
        let label = response
            .get(label_start..label_end)
            .ok_or_else(invalid_response)?;
        expanded_len = expanded_len
            .checked_add(1 + label.len())
            .ok_or_else(invalid_response)?;
        if expanded_len > DNS_NAME_MAX_BYTES {
            return Err(invalid_response());
        }
        labels.push(label);
        position = label_end;
    }
}

fn dns_name_matches(labels: &[&[u8]], expected_name: &str) -> bool {
    let mut expected_labels = expected_name.split('.');
    labels.iter().all(|label| {
        expected_labels
            .next()
            .is_some_and(|expected| label.eq_ignore_ascii_case(expected.as_bytes()))
    }) && expected_labels.next().is_none()
}

fn invalid_response() -> DnsReadinessError {
    DnsReadinessError::stage(DnsReadinessStage::ValidateResponse)
}

#[cfg(test)]
mod tests;
