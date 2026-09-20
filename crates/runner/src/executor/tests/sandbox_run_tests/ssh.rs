use super::*;
use async_trait::async_trait;
use std::{
    io,
    os::unix::fs::PermissionsExt,
    path::Path,
    pin::Pin,
    sync::Mutex,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf};
use tokio_util::sync::CancellationToken;

struct RpcStream(DuplexStream);
impl sandbox::GuestRpcStream for RpcStream {}
impl AsyncRead for RpcStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}
impl AsyncWrite for RpcStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().0).poll_write(cx, bytes)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_shutdown(cx)
    }
}
struct Acceptor {
    incoming: tokio::sync::Mutex<tokio::sync::mpsc::Receiver<sandbox::AcceptedGuestRpc>>,
    admitted: AtomicUsize,
}
#[async_trait]
impl sandbox::GuestRpcAcceptor for Acceptor {
    async fn accept(&self) -> io::Result<sandbox::AcceptedGuestRpc> {
        let accepted = self
            .incoming
            .lock()
            .await
            .recv()
            .await
            .ok_or_else(|| io::Error::other("test sender closed"))?;
        self.admitted.fetch_add(1, Ordering::SeqCst);
        Ok(accepted)
    }
}
struct RpcSandbox {
    inner: MockSandbox,
    run: String,
    acceptor: Arc<Acceptor>,
    pending: tokio::sync::mpsc::Sender<sandbox::AcceptedGuestRpc>,
    guest: Mutex<Option<DuplexStream>>,
    observed: Arc<AtomicUsize>,
    enabled: bool,
}
#[async_trait]
impl Sandbox for RpcSandbox {
    async fn apply_storage_manifest(
        &self,
        request: &sandbox::StorageManifestRequest<'_>,
    ) -> sandbox::Result<ExecResult> {
        self.inner.apply_storage_manifest(request).await
    }
    async fn restore_guest_state(
        &self,
        request: &sandbox::GuestStateRestoreRequest<'_>,
    ) -> sandbox::Result<ExecResult> {
        self.inner.restore_guest_state(request).await
    }
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn source_ip(&self) -> &str {
        self.inner.source_ip()
    }
    fn guest_rpc(&self, expected_run: &str) -> Option<Arc<dyn sandbox::GuestRpcAcceptor>> {
        assert_eq!(expected_run, self.run);
        self.observed.fetch_add(1, Ordering::SeqCst);
        Some(self.acceptor.clone())
    }
    async fn start(&mut self) -> sandbox::Result<()> {
        self.inner.start().await
    }
    async fn stop(&mut self) -> sandbox::Result<()> {
        self.inner.stop().await
    }
    async fn kill(&mut self) -> sandbox::Result<()> {
        self.inner.kill().await
    }
    async fn park(&mut self) -> sandbox::Result<sandbox::SandboxParkOutcome> {
        self.inner.park().await
    }
    async fn unpark(&mut self) -> sandbox::Result<()> {
        self.inner.unpark().await
    }
    async fn exec(&self, request: &sandbox::ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        self.inner.exec(request).await
    }
    async fn read_file(&self, path: &str, max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
        self.inner.read_file(path, max_bytes).await
    }
    async fn copy_file(
        &self,
        path: &str,
        host: &Path,
        options: sandbox::CopyFileOptions,
    ) -> sandbox::Result<sandbox::CopyFileResult> {
        let guest = if self.enabled {
            self.guest.lock().unwrap().take()
        } else {
            None
        };
        if let Some(mut guest) = guest {
            let mut bytes = Vec::new();
            tokio::time::timeout(Duration::from_secs(1), guest.read_to_end(&mut bytes))
                .await
                .unwrap()
                .unwrap();
            assert!(
                bytes.is_empty(),
                "unfinished input must be cancelled before cleanup"
            );
            self.observed.fetch_add(1, Ordering::SeqCst);
        }
        self.inner.copy_file(path, host, options).await
    }
    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        self.inner.write_file(path, content).await
    }
    async fn write_file_with_compression(
        &self,
        path: &str,
        content: &[u8],
        compression: sandbox::FileCompression,
    ) -> sandbox::Result<Option<sandbox::FileWriteMeasurements>> {
        self.inner
            .write_file_with_compression(path, content, compression)
            .await
    }

    async fn write_private_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        self.inner.write_private_file(path, content).await
    }
    async fn start_process(
        &self,
        request: &sandbox::StartProcessRequest<'_>,
    ) -> sandbox::Result<sandbox::GuestProcessHandle> {
        self.inner.start_process(request).await
    }
    async fn start_agent_process(
        &self,
        request: &sandbox::StartAgentProcessRequest<'_>,
    ) -> sandbox::Result<sandbox::GuestAgentProcessHandle> {
        if self.enabled {
            // The actual prepared-run entry point must install before Agent work.
            let mut guest = self.guest.lock().unwrap().take().unwrap();
            let request =
                runner_rpc_proto::parse_request(br#"{"version":1,"method":"unknown","params":{}}"#)
                    .unwrap();
            runner_rpc_proto::write_request(&mut guest, &request)
                .await
                .unwrap();
            guest.shutdown().await.unwrap();
            let mut responses = runner_rpc_proto::ResponseReader::new(guest);
            assert!(matches!(
                responses.next().await.unwrap(),
                Some(runner_rpc_proto::Response::Error {
                    code: runner_rpc_proto::ErrorCode::UnknownMethod,
                    delivery: runner_rpc_proto::Delivery::NotDispatched
                })
            ));
            assert!(responses.next().await.unwrap().is_none());
            self.observed.fetch_add(1, Ordering::SeqCst);
            // Queue an unfinished request which must be cancelled on Run exit.
            let (guest, stream) = tokio::io::duplex(1024);
            self.pending
                .send(sandbox::AcceptedGuestRpc {
                    sandbox_id: self.id().into(),
                    stream: Box::new(RpcStream(stream)),
                    cancelled: CancellationToken::new(),
                })
                .await
                .unwrap();
            *self.guest.lock().unwrap() = Some(guest);
            while self.acceptor.admitted.load(Ordering::SeqCst) < 2 {
                tokio::task::yield_now().await;
            }
        }
        self.inner.start_agent_process(request).await
    }
    async fn wait_process(
        &self,
        handle: sandbox::GuestProcessHandle,
        timeout: Duration,
    ) -> sandbox::Result<ProcessExit> {
        self.inner.wait_process(handle, timeout).await
    }
}

#[tokio::test]
async fn fresh_and_reused_runs_install_before_agent_work_and_cancel_before_cleanup() {
    for reused in [false, true] {
        for enabled in [false, true] {
            let dir = tempfile::Builder::new()
                .permissions(std::fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap();
            let mut config = test_executor_config(dir.path()).await;
            crate::log_file::ensure_log_dir(config.log_paths.dir()).unwrap();
            let identity =
                crate::runner_process_identity::RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1)
                    .unwrap();
            config.guest_rpc = crate::ssh::SshRuntime::official(
                config.http.clone(),
                if enabled {
                    "vm0_official_test"
                } else {
                    "pat-test"
                },
                identity,
            )
            .unwrap()
            .map(|ssh| crate::guest_rpc::Runtime {
                ssh: Some(ssh),
                vnc: None,
                usage: None,
            });
            assert_eq!(config.guest_rpc.is_some(), enabled);
            let ctx = minimal_context();
            let (pending, incoming) = tokio::sync::mpsc::channel(2);
            let acceptor = Arc::new(Acceptor {
                incoming: tokio::sync::Mutex::new(incoming),
                admitted: AtomicUsize::new(0),
            });
            let observed = Arc::new(AtomicUsize::new(0));
            let inner = MockSandbox::new("ssh-entrypoint");
            let (guest, stream) = tokio::io::duplex(1024);
            if enabled {
                pending
                    .send(sandbox::AcceptedGuestRpc {
                        sandbox_id: inner.id().into(),
                        stream: Box::new(RpcStream(stream)),
                        cancelled: CancellationToken::new(),
                    })
                    .await
                    .unwrap();
            }
            let sandbox = RpcSandbox {
                inner,
                run: ctx.run_id.to_string(),
                acceptor,
                pending,
                guest: Mutex::new(Some(guest)),
                observed: Arc::clone(&observed),
                enabled,
            };
            let source_ip = sandbox.source_ip().to_owned();
            let network_log_session = register_proxy(&config, &ctx, &source_ip).await.unwrap();
            let mut telemetry = test_telemetry(&config, &ctx);
            let outcome = tokio::time::timeout(
                Duration::from_secs(10),
                execute_prepared_sandbox_run(
                    PreparedSandboxRun {
                        sandbox: Box::new(sandbox),
                        source_ip,
                        network_log_session,
                        prepared_guest_runtime: None,
                    },
                    &ctx,
                    &config,
                    RunStart {
                        restore_guest_state: reused,
                        reuse_result: if reused {
                            SandboxReuseResult::Reused
                        } else {
                            SandboxReuseResult::PoolMiss
                        },
                        workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                        prev_storage: None,
                    },
                    &mut telemetry,
                    PreparedRunInputs::new(
                        RunControls::new(CancellationToken::new(), None),
                        prepare_run_payload_for_run(&ctx).unwrap(),
                    ),
                ),
            )
            .await
            .unwrap();
            assert_eq!(outcome.exit_code(), 0);
            assert_eq!(observed.load(Ordering::SeqCst), if enabled { 3 } else { 0 });
            assert_proxy_registry_empty(dir.path()).await;
        }
    }
}
