//! One isolated test process observes allocation requests across the public
//! uploader and its real file/HTTP workers. Fixture generation is not measured.
use std::alloc::{GlobalAlloc, Layout, System};
use std::io::{self, BufWriter, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use httpmock::prelude::*;
use runner_network::network_log_transport::{
    NetworkLogHttpClient, NetworkLogRequestContext, NetworkLogSendError, PreparedNetworkLogRequest,
};
use runner_network::network_logs::{
    NetworkLogPayload, NetworkLogUploadSessionOutcome, upload_network_logs,
};
use runner_types::ids::RunId;
use serde_json::json;
use sha2::{Digest, Sha256};

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
        assert!(!MEASURING.swap(true, Ordering::Relaxed));
        Self
    }

    fn finish(self) -> usize {
        MEASURING.store(false, Ordering::Relaxed);
        LARGEST.load(Ordering::Relaxed)
    }
}

impl Drop for AllocationMeasurement {
    fn drop(&mut self) {
        MEASURING.store(false, Ordering::Relaxed);
    }
}

struct HttpClient {
    client: reqwest::Client,
    url: String,
}

struct PreparedUpload {
    context: NetworkLogRequestContext,
    request: reqwest::RequestBuilder,
}

impl NetworkLogHttpClient for HttpClient {
    fn prepare_network_log_upload(
        &self,
        sandbox_token: &str,
        payload: &NetworkLogPayload,
    ) -> Result<Box<dyn PreparedNetworkLogRequest>, String> {
        Ok(Box::new(PreparedUpload {
            context: NetworkLogRequestContext {
                client_request_id: "allocation-test-request".into(),
                client_session_id: "allocation-test-session".into(),
                client_version: "allocation-test".into(),
            },
            request: self
                .client
                .post(&self.url)
                .bearer_auth(sandbox_token)
                .json(payload),
        }))
    }
}

#[async_trait::async_trait]
impl PreparedNetworkLogRequest for PreparedUpload {
    fn context(&self) -> &NetworkLogRequestContext {
        &self.context
    }

    async fn send(self: Box<Self>) -> Result<reqwest::Response, NetworkLogSendError> {
        self.request
            .send()
            .await
            .map_err(|error| NetworkLogSendError {
                message: error.to_string(),
                transport: None,
            })
    }
}

#[derive(Clone, Copy, Debug)]
enum Input {
    OversizedTree,
    PaddedSmallRecord,
    InvalidUtf8Suffix,
}

fn write_fixture(path: &Path, input: Input) -> io::Result<()> {
    let mut file = BufWriter::new(std::fs::File::create(path)?);
    writeln!(file, "{{\"sequence\":1}}")?;
    match input {
        Input::OversizedTree => {
            file.write_all(b"{\"discarded\":[")?;
            let chunk = b"0,".repeat(4096);
            for _ in 0..1024 {
                file.write_all(&chunk)?;
            }
            file.write_all(b"0]}\n")?;
        }
        Input::PaddedSmallRecord => {
            io::copy(&mut io::repeat(b' ').take(8 * 1024 * 1024), &mut file)?;
            file.write_all("\u{2003}{\"sequence\":2}\u{2028}".as_bytes())?;
            io::copy(&mut io::repeat(b'\t').take(8 * 1024 * 1024), &mut file)?;
            file.write_all(b"\r\n")?;
        }
        Input::InvalidUtf8Suffix => {
            file.write_all(b"\"")?;
            io::copy(&mut io::repeat(b'x').take(8 * 1024 * 1024), &mut file)?;
            file.write_all(&[0xff, b'"', b'\n'])?;
        }
    }
    // A complete final record without a newline remains uploadable.
    file.write_all(b"{\"sequence\":3}")?;
    file.flush()
}

fn source_digest(path: &Path) -> io::Result<Vec<u8>> {
    let mut file = std::fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut chunk = [0; 8192];
    loop {
        let read = file.read(&mut chunk)?;
        if read == 0 {
            return Ok(digest.finalize().to_vec());
        }
        digest.update(
            chunk
                .get(..read)
                .ok_or_else(|| io::Error::other("file read exceeded its buffer"))?,
        );
    }
}

#[tokio::test]
async fn public_uploader_bounds_discarded_input_and_preserves_admitted_records()
-> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let run_id = RunId::from(uuid::Uuid::nil());
    for input in [
        Input::OversizedTree,
        Input::PaddedSmallRecord,
        Input::InvalidUtf8Suffix,
    ] {
        let path = dir.path().join(format!("{input:?}.jsonl"));
        write_fixture(&path, input)?;
        let original_digest = source_digest(&path)?;
        let server = MockServer::start_async().await;
        let batches = match input {
            Input::OversizedTree => vec![vec![json!({"sequence":1})], vec![json!({"sequence":3})]],
            Input::PaddedSmallRecord => vec![vec![
                json!({"sequence":1}),
                json!({"sequence":2}),
                json!({"sequence":3}),
            ]],
            Input::InvalidUtf8Suffix => vec![vec![json!({"sequence":1}), json!({"sequence":3})]],
        };
        let mut uploads = Vec::new();
        for batch in batches {
            let expected = json!({"runId":run_id.to_string(),"networkLogs":batch});
            uploads.push(
                server
                    .mock_async(move |when, then| {
                        when.method(POST)
                            .path("/api/webhooks/agent/telemetry")
                            .header("authorization", "Bearer allocation-test-token")
                            .json_body(expected);
                        then.status(200);
                    })
                    .await,
            );
        }
        let client = HttpClient {
            client: reqwest::Client::new(),
            url: server.url("/api/webhooks/agent/telemetry"),
        };
        let measurement = AllocationMeasurement::start();
        let outcome = upload_network_logs(&client, run_id, "allocation-test-token", &path).await;
        let largest = measurement.finish();
        for upload in uploads {
            upload.assert_calls_async(1).await;
        }
        let expected_outcome = match input {
            Input::PaddedSmallRecord => NetworkLogUploadSessionOutcome::Success,
            Input::OversizedTree | Input::InvalidUtf8Suffix => {
                NetworkLogUploadSessionOutcome::Excluded
            }
        };
        assert_eq!(outcome, expected_outcome, "{input:?}");
        assert_eq!(source_digest(&path)?, original_digest, "{input:?}");
        eprintln!("{input:?}: largest allocation request = {largest} bytes");
        // These inputs contain only small admitted values. Their large skipped
        // or trimmed content must not allocate a full line or discarded Value.
        // This is not a bound on all admitted JSON shapes or total process RSS.
        assert!(largest <= 4 * 1024 * 1024, "{input:?}: {largest}");
    }
    Ok(())
}
