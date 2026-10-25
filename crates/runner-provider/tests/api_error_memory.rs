//! One isolated public-provider test observes allocations during real HTTP
//! failures. Fixtures, expected text and peer cleanup stay outside observation.
use raw_http_test_support::raw_http::{join_raw_http_task, read_http_request};
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_provider::{
    ApiProvider, ApiProviderConfig, ApiStatusError, BuiltinFirewallCatalogCachePaths, HttpClient,
    HttpClientConfig, JobProvider, ProviderError, RunCancellationRegistry,
};
use runner_types::types::HeartbeatState;
use std::alloc::{GlobalAlloc, Layout, System};
use std::io;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

const DIAGNOSTIC_BYTES: usize = 64 * 1024;
const TRUNCATED: &str = "\n[response body truncated]";
static MEASURING: AtomicBool = AtomicBool::new(false);
static LARGEST: AtomicUsize = AtomicUsize::new(0);

struct AllocationObserver;

fn record_allocation(size: usize) {
    if MEASURING.load(Ordering::Relaxed) {
        LARGEST.fetch_max(size, Ordering::Relaxed);
    }
}

unsafe impl GlobalAlloc for AllocationObserver {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_allocation(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_allocation(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record_allocation(size);
        unsafe { System.realloc(pointer, layout, size) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: AllocationObserver = AllocationObserver;

struct AllocationMeasurement;

impl AllocationMeasurement {
    fn start() -> Self {
        LARGEST.store(0, Ordering::Relaxed);
        MEASURING.store(true, Ordering::Relaxed);
        Self
    }
}

impl Drop for AllocationMeasurement {
    fn drop(&mut self) {
        MEASURING.store(false, Ordering::Relaxed);
    }
}

#[derive(Clone, Copy, Debug)]
enum Framing {
    Length,
    Chunked,
    WithheldTail,
    BrokenBody,
}

struct ErrorPeer {
    task: Option<JoinHandle<io::Result<String>>>,
}

impl ErrorPeer {
    async fn spawn(body: Vec<u8>, framing: Framing) -> io::Result<(String, Self)> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let length_header = match framing {
            Framing::Length => format!("Content-Length: {}\r\n", body.len()),
            Framing::Chunked => format!("Transfer-Encoding: chunked\r\n\r\n{:x}\r\n", body.len()),
            // The client must not reserve this untrusted length or wait for EOF.
            Framing::WithheldTail => format!("Content-Length: {}\r\n", 16 * 1024 * 1024),
            Framing::BrokenBody => format!("Content-Length: {}\r\n", body.len() + 1),
        };
        let mut headers =
            b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\n"
                .to_vec();
        // Exercise ordinary keep-alive retirement for the unfinished response.
        if !matches!(framing, Framing::WithheldTail) {
            headers.extend_from_slice(b"Connection: close\r\n");
        }
        headers.extend_from_slice(length_header.as_bytes());
        if !matches!(framing, Framing::Chunked) {
            headers.extend_from_slice(b"\r\n");
        }
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await?;
            let request = read_http_request(&mut socket).await?;
            if !write_until_closed(&mut socket, &headers).await? {
                return Ok(request);
            }
            for part in body.chunks(8192) {
                if !write_until_closed(&mut socket, part).await? {
                    return Ok(request);
                }
            }
            if matches!(framing, Framing::Chunked) {
                write_until_closed(&mut socket, b"\r\n0\r\n\r\n").await?;
            }
            if matches!(framing, Framing::WithheldTail) {
                let mut byte = [0];
                match socket.read(&mut byte).await {
                    Ok(0) => {}
                    Err(error) if connection_closed(&error) => {}
                    Ok(_) => return Err(io::Error::other("expected client retirement")),
                    Err(error) => return Err(error),
                }
            }
            Ok(request)
        });
        Ok((url, Self { task: Some(task) }))
    }

    async fn finish(mut self) -> io::Result<String> {
        let task = self
            .task
            .take()
            .ok_or_else(|| io::Error::other("missing error peer task"))?;
        join_raw_http_task(task, "API error peer").await
    }
}

impl Drop for ErrorPeer {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

fn connection_closed(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
    )
}

async fn write_until_closed(socket: &mut TcpStream, bytes: &[u8]) -> io::Result<bool> {
    match socket.write_all(bytes).await {
        Ok(()) => Ok(true),
        Err(error) if connection_closed(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

async fn heartbeat_failure(
    body: Vec<u8>,
    framing: Framing,
) -> TestResult<(Box<ApiStatusError>, usize)> {
    let directory = tempfile::tempdir()?;
    let (api_url, peer) = ErrorPeer::spawn(body, framing).await?;
    let identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1)?;
    let http = HttpClient::new(HttpClientConfig {
        api_url,
        vercel_bypass: None,
        client_session_id: "api-error-memory-test".into(),
        runner_version: env!("CARGO_PKG_VERSION"),
    })?;
    let provider = ApiProvider::new(
        http,
        "synthetic-runner-token".into(),
        ApiProviderConfig {
            ably_side_message_handler: None,
            runner_identity: identity,
            runner_hostname: None,
            group: "test".into(),
            supported_profiles: vec![],
            installed_okou_cli: None,
        },
        BuiltinFirewallCatalogCachePaths {
            cache_path: directory.path().join("catalog.json"),
            lock_path: directory.path().join("catalog.lock"),
        },
        CancellationToken::new(),
        RunCancellationRegistry::new(),
    );
    let state = HeartbeatState {
        runner_id: identity.runner_id().to_string(),
        runner_hostname: None,
        group: "test".into(),
        snapshot_generation: 1,
        snapshot_sequence: 1,
        total_vcpu: 1,
        total_memory_mb: 1024,
        max_concurrent: 1,
        allocated_vcpu: 0,
        allocated_memory_mb: 0,
        running_count: 0,
        admittable_profiles: vec![],
        held_sandbox_states: vec![],
        held_home_states: vec![],
        active_reuse_producers: vec![],
        mode: "running".into(),
    };
    let measurement = AllocationMeasurement::start();
    let result = tokio::time::timeout(Duration::from_secs(5), provider.heartbeat(&state)).await;
    drop(measurement);
    let largest = LARGEST.load(Ordering::Relaxed);
    provider.shutdown().await;
    let request = peer.finish().await?;
    assert_eq!(
        request.lines().next(),
        Some("POST /api/runners/heartbeat HTTP/1.1")
    );
    let error = match result? {
        Err(ProviderError::ApiStatus(error)) => error,
        Err(error) => {
            return Err(io::Error::other(format!("expected HTTP status error: {error}")).into());
        }
        Ok(()) => return Err(io::Error::other("expected HTTP status error").into()),
    };
    assert_eq!(error.endpoint_label, "heartbeat");
    assert_eq!(error.status, reqwest::StatusCode::SERVICE_UNAVAILABLE);
    Ok((error, largest))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn api_error_diagnostics_bound_allocations_and_retire_unused_tails() -> TestResult {
    let mut exact = vec![b'x'; DIAGNOSTIC_BYTES - 2];
    exact.extend_from_slice("é".as_bytes());
    let mut unicode_overflow = vec![b'x'; DIAGNOSTIC_BYTES - 1];
    unicode_overflow.extend_from_slice("界".as_bytes());
    for (name, body, framing) in [
        (
            "large declared",
            vec![b'x'; 8 * 1024 * 1024],
            Framing::Length,
        ),
        (
            "large chunked",
            vec![0xff; 8 * 1024 * 1024],
            Framing::Chunked,
        ),
        (
            "withheld tail",
            vec![b'x'; DIAGNOSTIC_BYTES + 1],
            Framing::WithheldTail,
        ),
        ("small", b"ordinary failure".to_vec(), Framing::Length),
        ("exact limit", exact, Framing::Chunked),
        ("Unicode boundary", unicode_overflow, Framing::Length),
        ("invalid UTF8", vec![b'a', 0xff, b'b'], Framing::Length),
        (
            "interrupted body",
            b"partial diagnostic".to_vec(),
            Framing::BrokenBody,
        ),
    ] {
        let prefix = body
            .get(..body.len().min(DIAGNOSTIC_BYTES))
            .ok_or_else(|| io::Error::other("missing expected diagnostic prefix"))?;
        let mut expected = String::from_utf8_lossy(prefix).into_owned();
        if body.len() > DIAGNOSTIC_BYTES {
            expected.push_str(TRUNCATED);
        }
        if matches!(framing, Framing::BrokenBody) {
            expected.clear();
        }
        let (error, largest) = heartbeat_failure(body, framing).await?;
        eprintln!(
            "{name}: largest allocation = {largest}, diagnostic bytes = {}",
            error.body.len()
        );
        // A test-only envelope around client/transport/prefix work. This is not
        // process RSS, aggregate memory or a production admission threshold.
        assert!(
            largest <= 1024 * 1024,
            "{name}: input-sized allocation {largest}"
        );
        assert!(
            error.body == expected,
            "{name}: complete diagnostic text mismatch"
        );
    }
    Ok(())
}
