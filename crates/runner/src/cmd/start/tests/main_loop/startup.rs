use super::super::super::*;
use super::super::support::{
    assert_run_exits_within, mock_run_config, mock_run_config_with_runtime, shutdown,
    test_profiles, wait_status_mode,
};
use crate::provider::{ClaimedJob, CompletionAuth, JobCandidate};
use async_trait::async_trait;
use runner_types::types::HeartbeatState;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

struct ShutdownRecordingProvider {
    shutdowns: Arc<AtomicUsize>,
}

#[async_trait]
impl crate::provider::JobProvider for ShutdownRecordingProvider {
    async fn discover(&self) -> Option<JobCandidate> {
        panic!("publish failure cleanup test does not discover jobs")
    }

    async fn claim(&self, _candidate: JobCandidate) -> Option<ClaimedJob> {
        panic!("publish failure cleanup test does not claim jobs")
    }

    async fn complete(
        &self,
        _request: runner_types::types::CompleteRequest,
        _completion_auth: CompletionAuth,
    ) {
        panic!("publish failure cleanup test does not complete jobs")
    }

    async fn heartbeat(&self, _state: &HeartbeatState) {}

    async fn shutdown(&self) {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
    }
}

struct ShutdownRecordingRuntime {
    shutdowns: Arc<AtomicUsize>,
}

#[async_trait]
impl sandbox::SandboxRuntime for ShutdownRecordingRuntime {
    async fn create_factory(
        &self,
        _config: sandbox::FactoryConfig,
    ) -> sandbox::Result<Box<dyn sandbox::SandboxFactory>> {
        panic!("publish failure cleanup test does not create factories")
    }

    async fn shutdown(&mut self) {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
    }
}

struct FactoryFailingRuntime {
    create_calls: Arc<AtomicUsize>,
    shutdowns: Arc<AtomicUsize>,
}

#[async_trait]
impl sandbox::SandboxRuntime for FactoryFailingRuntime {
    async fn create_factory(
        &self,
        _config: sandbox::FactoryConfig,
    ) -> sandbox::Result<Box<dyn sandbox::SandboxFactory>> {
        self.create_calls.fetch_add(1, Ordering::SeqCst);
        Err(sandbox::SandboxError::Initialization {
            phase: sandbox::SandboxInitializationPhase::Factory,
            message: "factory failed".into(),
        })
    }

    async fn shutdown(&mut self) {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
    }
}

struct CountingRuntimeProvider {
    create_calls: Arc<AtomicUsize>,
}

#[async_trait]
impl sandbox::RuntimeProvider for CountingRuntimeProvider {
    async fn create_runtime(
        &self,
        _config: sandbox::RuntimeConfig,
    ) -> sandbox::Result<Box<dyn sandbox::SandboxRuntime>> {
        self.create_calls.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(ShutdownRecordingRuntime {
            shutdowns: Arc::new(AtomicUsize::new(0)),
        }))
    }
}

#[derive(Debug, PartialEq, Eq)]
enum DnsStartupEvent {
    RuntimeCreated {
        id: usize,
        proxy_port: u16,
        dns_port: u16,
    },
    DnsStarted {
        port: u16,
    },
    ReadinessActivated {
        id: usize,
    },
    RuntimeShutdown {
        id: usize,
    },
}

struct DnsStartupRecordingProvider {
    next_id: AtomicUsize,
    events: Arc<Mutex<Vec<DnsStartupEvent>>>,
}

impl DnsStartupRecordingProvider {
    fn new(events: Arc<Mutex<Vec<DnsStartupEvent>>>) -> Self {
        Self {
            next_id: AtomicUsize::new(0),
            events,
        }
    }
}

struct DnsStartupRecordingRuntime {
    id: usize,
    events: Arc<Mutex<Vec<DnsStartupEvent>>>,
}

#[async_trait]
impl sandbox::SandboxRuntime for DnsStartupRecordingRuntime {
    async fn create_factory(
        &self,
        _config: sandbox::FactoryConfig,
    ) -> sandbox::Result<Box<dyn sandbox::SandboxFactory>> {
        panic!("DNS startup tests do not create factories")
    }

    async fn dns_interface_pattern(&self) -> Option<String> {
        Some("vm0-ve-test-*".into())
    }

    async fn activate_dns_readiness(&self) -> sandbox::Result<()> {
        self.events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(DnsStartupEvent::ReadinessActivated { id: self.id });
        Ok(())
    }

    async fn shutdown(&mut self) {
        self.events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(DnsStartupEvent::RuntimeShutdown { id: self.id });
    }
}

#[async_trait]
impl sandbox::RuntimeProvider for DnsStartupRecordingProvider {
    async fn create_runtime(
        &self,
        config: sandbox::RuntimeConfig,
    ) -> sandbox::Result<Box<dyn sandbox::SandboxRuntime>> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let proxy_port = config
            .proxy_port
            .expect("DNS startup should propagate the MITM port");
        let dns_port = config
            .dns_port
            .expect("DNS startup should propagate the reserved port");
        assert!(
            config.host_cpu_placement.is_some(),
            "DNS startup should propagate host CPU placement"
        );
        self.events.lock().unwrap_or_else(|e| e.into_inner()).push(
            DnsStartupEvent::RuntimeCreated {
                id,
                proxy_port,
                dns_port,
            },
        );
        Ok(Box::new(DnsStartupRecordingRuntime {
            id,
            events: Arc::clone(&self.events),
        }))
    }
}

fn scripted_dns_starter(
    outcomes: Vec<Option<std::io::ErrorKind>>,
    events: Arc<Mutex<Vec<DnsStartupEvent>>>,
) -> impl FnMut(
    crate::dns::DnsPortReservation,
    String,
    NetworkLogManager,
) -> std::future::Ready<std::io::Result<crate::dns::DnsProxy>> {
    let mut outcomes = VecDeque::from(outcomes);
    move |reservation, _interface_pattern, _network_log_manager| {
        let port = reservation.port();
        drop(reservation);
        events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(DnsStartupEvent::DnsStarted { port });
        let outcome = outcomes
            .pop_front()
            .expect("DNS startup outcome should be scripted");
        std::future::ready(match outcome {
            Some(kind) => Err(std::io::Error::new(kind, "scripted DNS startup failure")),
            None => Ok(crate::dns::DnsProxy::noop_on_port(port)),
        })
    }
}

fn test_host_cpu_placement() -> sandbox::HostCpuPlacementConfig {
    sandbox::HostCpuPlacementConfig::new(1, 1, sandbox::HostCpuPlacementMode::PreferManaged)
        .unwrap()
}

struct BlockingFactoryRuntime {
    entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    release: tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}

impl BlockingFactoryRuntime {
    fn new(
        entered: tokio::sync::oneshot::Sender<()>,
        release: tokio::sync::oneshot::Receiver<()>,
    ) -> Self {
        Self {
            entered: Mutex::new(Some(entered)),
            release: tokio::sync::Mutex::new(Some(release)),
        }
    }
}

#[async_trait]
impl sandbox::SandboxRuntime for BlockingFactoryRuntime {
    async fn create_factory(
        &self,
        _config: sandbox::FactoryConfig,
    ) -> sandbox::Result<Box<dyn sandbox::SandboxFactory>> {
        if let Some(entered) = self
            .entered
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = entered.send(());
        }
        let release = {
            let mut guard = self.release.lock().await;
            guard.take().expect("factory release should be configured")
        };
        let _ = release.await;
        Ok(Box::new(sandbox_mock::MockSandboxFactory::new()))
    }

    async fn shutdown(&mut self) {}
}

async fn status_mode_if_exists(status_path: &std::path::Path) -> Option<String> {
    let raw = match tokio::fs::read_to_string(status_path).await {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => panic!("failed to read status file {}: {e}", status_path.display()),
    };
    let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
    status
        .get("mode")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

#[tokio::test]
async fn dns_startup_rebuilds_runtime_after_port_race() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let runtime_provider = DnsStartupRecordingProvider::new(Arc::clone(&events));
    let (mut mitm, _mitm_crash_rx) = crate::proxy::MitmProxy::noop();
    let mut memory_prefetch = crate::prefetch::MemoryPrefetchTasks::empty();

    let (mut runtime, dns_handle, kmsg_handle) = start_runtime_with_dns(
        DnsStartupResources {
            runtime_provider: &runtime_provider,
            mitm: &mut mitm,
            kmsg_handle: crate::kmsg_log::KmsgHandle::noop(),
            memory_prefetch: &mut memory_prefetch,
            network_log_manager: NetworkLogManager::new(),
            host_cpu_placement: test_host_cpu_placement(),
        },
        scripted_dns_starter(
            vec![Some(std::io::ErrorKind::AddrInUse), None],
            Arc::clone(&events),
        ),
    )
    .await
    .expect("second DNS startup attempt should succeed");

    let replacement_port = {
        let events = events.lock().unwrap_or_else(|e| e.into_inner());
        let [
            DnsStartupEvent::RuntimeCreated {
                id: first_id,
                proxy_port: first_proxy_port,
                dns_port: first_dns_port,
            },
            DnsStartupEvent::DnsStarted {
                port: first_start_port,
            },
            DnsStartupEvent::RuntimeShutdown {
                id: first_shutdown_id,
            },
            DnsStartupEvent::RuntimeCreated {
                id: second_id,
                proxy_port: second_proxy_port,
                dns_port: second_dns_port,
            },
            DnsStartupEvent::DnsStarted {
                port: second_start_port,
            },
            DnsStartupEvent::ReadinessActivated { id: readiness_id },
        ] = events.as_slice()
        else {
            panic!("unexpected DNS startup event sequence: {events:?}");
        };
        assert_eq!(*first_id, 0);
        assert_eq!(*first_proxy_port, 0);
        assert_eq!(*first_dns_port, *first_start_port);
        assert_eq!(*first_shutdown_id, 0);
        assert_eq!(*second_id, 1);
        assert_eq!(*second_proxy_port, 0);
        assert_eq!(*second_dns_port, *second_start_port);
        assert_eq!(*readiness_id, 1);
        *second_dns_port
    };
    assert_eq!(dns_handle.port(), replacement_port);

    dns_handle.stop().await.unwrap();
    runtime.shutdown().await;
    kmsg_handle.stop().await.unwrap();
    mitm.kill_now().await.unwrap();
    memory_prefetch.cancel();
    memory_prefetch.drain().await;
}

#[tokio::test]
async fn dns_startup_stops_after_three_port_races() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let runtime_provider = DnsStartupRecordingProvider::new(Arc::clone(&events));
    let (mut mitm, _mitm_crash_rx) = crate::proxy::MitmProxy::noop();
    let mut memory_prefetch = crate::prefetch::MemoryPrefetchTasks::empty();

    let error = match start_runtime_with_dns(
        DnsStartupResources {
            runtime_provider: &runtime_provider,
            mitm: &mut mitm,
            kmsg_handle: crate::kmsg_log::KmsgHandle::noop(),
            memory_prefetch: &mut memory_prefetch,
            network_log_manager: NetworkLogManager::new(),
            host_cpu_placement: test_host_cpu_placement(),
        },
        scripted_dns_starter(
            vec![
                Some(std::io::ErrorKind::AddrInUse),
                Some(std::io::ErrorKind::AddrInUse),
                Some(std::io::ErrorKind::AddrInUse),
            ],
            Arc::clone(&events),
        ),
    )
    .await
    {
        Ok(_) => panic!("third DNS port race should be terminal"),
        Err(error) => error,
    };

    assert!(error.to_string().contains("scripted DNS startup failure"));
    let events = events.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(events.len(), 9, "unexpected DNS startup events: {events:?}");
    let (attempts, remainder) = events.as_chunks::<3>();
    assert!(remainder.is_empty());
    for (expected_id, attempt) in attempts.iter().enumerate() {
        let [
            DnsStartupEvent::RuntimeCreated {
                id,
                proxy_port,
                dns_port,
            },
            DnsStartupEvent::DnsStarted { port },
            DnsStartupEvent::RuntimeShutdown { id: shutdown_id },
        ] = attempt
        else {
            panic!("unexpected DNS startup attempt events: {attempt:?}");
        };
        assert_eq!(*id, expected_id);
        assert_eq!(*proxy_port, 0);
        assert_eq!(*dns_port, *port);
        assert_eq!(*shutdown_id, expected_id);
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn non_port_dns_failure_cleans_owned_startup_resources_without_retry() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let runtime_provider = DnsStartupRecordingProvider::new(Arc::clone(&events));

    let mut mitm_child = tokio::process::Command::new("sleep");
    mitm_child.arg("60").kill_on_drop(true);
    let mitm_child = mitm_child.spawn().expect("spawn test MITM child");
    let mitm_pid = mitm_child.id().expect("test MITM child should have pid");
    let mitm_starttime = crate::process::read_process_stat(mitm_pid)
        .await
        .expect("test MITM child should be visible")
        .starttime;
    let (mut mitm, _mitm_crash_rx) = crate::proxy::MitmProxy::noop();
    mitm.set_child_for_test(mitm_child);

    let mut kmsg_child = tokio::process::Command::new("cat");
    kmsg_child
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let kmsg_child = kmsg_child.spawn().expect("spawn test kmsg child");
    let kmsg_pid = kmsg_child.id().expect("test kmsg child should have pid");
    let kmsg_starttime = crate::process::read_process_stat(kmsg_pid)
        .await
        .expect("test kmsg child should be visible")
        .starttime;
    let kmsg_handle =
        crate::kmsg_log::KmsgHandle::from_test_child(kmsg_child, NetworkLogManager::new())
            .expect("create test kmsg handle");

    let prefetch_cancel = CancellationToken::new();
    let task_cancel = prefetch_cancel.clone();
    let (cancelled_tx, cancelled_rx) = tokio::sync::oneshot::channel();
    let prefetch_handle = tokio::spawn(async move {
        task_cancel.cancelled().await;
        let _ = cancelled_tx.send(());
    });
    let mut memory_prefetch =
        crate::prefetch::MemoryPrefetchTasks::from_test_handle(prefetch_cancel, prefetch_handle);

    let error = match start_runtime_with_dns(
        DnsStartupResources {
            runtime_provider: &runtime_provider,
            mitm: &mut mitm,
            kmsg_handle,
            memory_prefetch: &mut memory_prefetch,
            network_log_manager: NetworkLogManager::new(),
            host_cpu_placement: test_host_cpu_placement(),
        },
        scripted_dns_starter(vec![Some(std::io::ErrorKind::Other)], Arc::clone(&events)),
    )
    .await
    {
        Ok(_) => panic!("non-port DNS failure should be terminal"),
        Err(error) => error,
    };

    assert!(error.to_string().contains("scripted DNS startup failure"));
    assert_eq!(
        events.lock().unwrap_or_else(|e| e.into_inner()).len(),
        3,
        "non-port DNS failure should not be retried"
    );
    cancelled_rx
        .await
        .expect("prefetch task should observe cancellation");
    assert_eq!(memory_prefetch.task_count(), 0);
    assert_ne!(
        crate::process::read_process_stat(mitm_pid)
            .await
            .map(|stat| stat.starttime),
        Some(mitm_starttime),
        "terminal DNS failure should reap the MITM child"
    );
    assert_ne!(
        crate::process::read_process_stat(kmsg_pid)
            .await
            .map(|stat| stat.starttime),
        Some(kmsg_starttime),
        "terminal DNS failure should reap the kmsg child"
    );
}

#[tokio::test]
async fn live_runner_instance_publish_failure_shuts_down_startup_resources() {
    use tokio::io::AsyncBufReadExt;

    let dir = tempfile::tempdir().unwrap();
    let home = crate::paths::HomePaths::with_root(dir.path().join("vm0-runner"));
    std::fs::create_dir_all(dir.path().join("vm0-runner")).unwrap();
    std::fs::write(home.live_runner_instances_dir(), b"not a directory").unwrap();

    let provider_shutdowns = Arc::new(AtomicUsize::new(0));
    let provider = ShutdownRecordingProvider {
        shutdowns: Arc::clone(&provider_shutdowns),
    };
    let runtime_shutdowns = Arc::new(AtomicUsize::new(0));
    let mut runtime = ShutdownRecordingRuntime {
        shutdowns: Arc::clone(&runtime_shutdowns),
    };
    let status_path = dir.path().join("status.json");
    let status = StatusTracker::new(status_path.clone(), 4, None, None);
    let (mut mitm, _mitm_crash_rx) = crate::proxy::MitmProxy::noop();
    let ignore_term_fifo = dir.path().join("ignore-term-child.fifo");
    let mut ignore_term_child = tokio::process::Command::new("bash")
        .arg("-c")
        .arg(
            r#"
set -euo pipefail
fifo="$1"
mkfifo "$fifo"
trap '' TERM
exec 3<>"$fifo"
printf 'ready\n'
while true; do
  read -r _ <&3 || true
done
"#,
        )
        .arg("ignore-term-child")
        .arg(&ignore_term_fifo)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let proxy_child_pid = ignore_term_child.id().expect("proxy child should have pid");
    let stdout = ignore_term_child.stdout.take().unwrap();
    let mut ready_lines = tokio::io::BufReader::new(stdout).lines();
    let ready = tokio::time::timeout(Duration::from_secs(5), ready_lines.next_line())
        .await
        .expect("ignore-term child did not become ready")
        .unwrap();
    assert_eq!(ready.as_deref(), Some("ready"));
    let proxy_child_starttime = crate::process::read_process_stat(proxy_child_pid)
        .await
        .expect("proxy child stat should be readable after readiness")
        .starttime;
    mitm.set_child_for_test(ignore_term_child);
    let prefetch_cancel = CancellationToken::new();
    let task_cancel = prefetch_cancel.clone();
    let (cancelled_tx, cancelled_rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        task_cancel.cancelled().await;
        let _ = cancelled_tx.send(());
    });
    let mut memory_prefetch =
        crate::prefetch::MemoryPrefetchTasks::from_test_handle(prefetch_cancel, handle);
    let metadata = crate::live_runner_instances::LiveRunnerInstanceMetadata {
        config_path: dir.path().join("runner.yaml"),
        base_dir: dir.path().join("base"),
        runner_group: "vm0/test".into(),
        subcommand: "start".into(),
    };

    let error = match tokio::time::timeout(
        Duration::from_secs(2),
        publish_live_runner_instance_or_shutdown_startup_resources(
            &home,
            metadata,
            LiveRunnerPublishResources {
                provider: &provider,
                runtime: &mut runtime,
                mitm: &mut mitm,
                kmsg_handle: crate::kmsg_log::KmsgHandle::noop(),
                dns_handle: crate::dns::DnsProxy::noop(),
                memory_prefetch: &mut memory_prefetch,
                status: &status,
            },
        ),
    )
    .await
    .expect("publish failure cleanup should not wait for graceful proxy stop")
    {
        Ok(_) => panic!("live runner instance publish should fail"),
        Err(error) => error,
    };

    assert!(
        error.to_string().contains("ensure live runner instances"),
        "unexpected error: {error}"
    );
    assert_eq!(provider_shutdowns.load(Ordering::SeqCst), 1);
    assert_eq!(runtime_shutdowns.load(Ordering::SeqCst), 1);
    tokio::time::timeout(Duration::from_secs(5), cancelled_rx)
        .await
        .expect("prefetch task should observe cleanup cancellation")
        .expect("prefetch task should report cancellation");
    assert_eq!(memory_prefetch.task_count(), 0);
    let proxy_child_still_exists = matches!(
        crate::process::read_process_stat(proxy_child_pid).await,
        Some(stat) if stat.starttime == proxy_child_starttime
    );
    assert!(
        !proxy_child_still_exists,
        "proxy child should be killed and reaped during cleanup"
    );
    wait_status_mode(&status_path, "stopped", Duration::from_secs(5)).await;
}

#[tokio::test]
async fn startup_does_not_publish_running_before_factories_are_ready() {
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let runtime = BlockingFactoryRuntime::new(entered_tx, release_rx);
    let (config, env) =
        mock_run_config_with_runtime(test_profiles(), 8, 32768, 4, Box::new(runtime));
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    tokio::time::timeout(Duration::from_secs(2), entered_rx)
        .await
        .expect("factory startup should be entered")
        .expect("factory startup should report entry");
    assert_ne!(
        status_mode_if_exists(&status_path).await.as_deref(),
        Some("running"),
        "runner must not publish running before factories are ready",
    );
    assert_eq!(
        status_mode_if_exists(&status_path).await.as_deref(),
        Some("starting"),
        "runner should publish startup progress while factories are not ready",
    );

    release_tx
        .send(())
        .expect("runner should still be waiting for factory release");
    wait_status_mode(&status_path, "running", Duration::from_secs(5)).await;
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn startup_readiness_blocks_running_and_discovery() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    env.handle.block_startup_readiness();
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    assert!(
        env.handle
            .wait_startup_readiness_entered(Duration::from_secs(2))
            .await,
        "startup readiness should be entered",
    );
    assert_eq!(
        status_mode_if_exists(&status_path).await.as_deref(),
        Some("starting"),
        "runner should publish starting while provider readiness is blocked",
    );
    assert_eq!(env.handle.startup_readiness_calls(), 1);
    assert_eq!(
        env.handle.discover_started_count(),
        0,
        "provider discovery must not start before startup readiness completes",
    );

    env.handle.release_startup_readiness();
    wait_status_mode(&status_path, "running", Duration::from_secs(5)).await;
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn stop_during_startup_readiness_exits_without_running() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    env.handle.block_startup_readiness();
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    assert!(
        env.handle
            .wait_startup_readiness_entered(Duration::from_secs(2))
            .await,
        "startup readiness should be entered",
    );
    assert_eq!(
        status_mode_if_exists(&status_path).await.as_deref(),
        Some("starting"),
        "runner should publish starting while provider readiness is blocked",
    );

    env.trigger_stopping().await;
    assert_eq!(
        *env.mode_tx.borrow(),
        RunnerMode::Stopping,
        "startup stop must not be lost while provider readiness is blocked",
    );

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "startup readiness stop should exit without entering Running",
    )
    .await;
    wait_status_mode(&status_path, "stopped", Duration::from_secs(5)).await;
}

#[tokio::test]
async fn startup_readiness_failure_stops_status_and_cleans_startup_resources() {
    let runtime_shutdowns = Arc::new(AtomicUsize::new(0));
    let runtime = ShutdownRecordingRuntime {
        shutdowns: Arc::clone(&runtime_shutdowns),
    };
    let (config, env) =
        mock_run_config_with_runtime(test_profiles(), 8, 32768, 4, Box::new(runtime));
    env.handle
        .fail_startup_readiness("provider readiness failed");
    let status_path = env._temp_dir.path().join("status.json");

    let error = run(config)
        .await
        .expect_err("provider startup readiness should fail");

    assert!(
        error.to_string().contains("provider readiness failed"),
        "unexpected error: {error}"
    );
    assert_eq!(env.handle.startup_readiness_calls(), 1);
    assert_eq!(
        env.handle.discover_started_count(),
        0,
        "provider discovery must not start after startup readiness failure",
    );
    assert_eq!(runtime_shutdowns.load(Ordering::SeqCst), 1);
    wait_status_mode(&status_path, "stopped", Duration::from_secs(5)).await;
}

#[tokio::test]
async fn drain_during_startup_exits_after_readiness_without_running() {
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let runtime = BlockingFactoryRuntime::new(entered_tx, release_rx);
    let (config, env) =
        mock_run_config_with_runtime(test_profiles(), 8, 32768, 4, Box::new(runtime));
    let run_handle = tokio::spawn(run(config));

    tokio::time::timeout(Duration::from_secs(2), entered_rx)
        .await
        .expect("factory startup should be entered")
        .expect("factory startup should report entry");

    env.drain();
    env.resume();
    assert_eq!(
        *env.mode_tx.borrow(),
        RunnerMode::Draining,
        "resume before startup readiness must not open admission",
    );

    release_tx
        .send(())
        .expect("runner should still be waiting for factory release");
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "startup drain should exit without entering Running",
    )
    .await;
}

#[tokio::test]
async fn stop_during_startup_exits_after_readiness_without_running() {
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let runtime = BlockingFactoryRuntime::new(entered_tx, release_rx);
    let (config, env) =
        mock_run_config_with_runtime(test_profiles(), 8, 32768, 4, Box::new(runtime));
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    tokio::time::timeout(Duration::from_secs(2), entered_rx)
        .await
        .expect("factory startup should be entered")
        .expect("factory startup should report entry");

    env.trigger_stopping().await;
    assert_eq!(
        *env.mode_tx.borrow(),
        RunnerMode::Stopping,
        "startup stop must not be lost before factories become ready",
    );

    release_tx
        .send(())
        .expect("runner should still be waiting for factory release");
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "startup stop should exit without entering Running",
    )
    .await;
    wait_status_mode(&status_path, "stopped", Duration::from_secs(5)).await;
}

#[tokio::test]
async fn factory_startup_failure_stops_status_and_cleans_startup_resources() {
    let create_calls = Arc::new(AtomicUsize::new(0));
    let runtime_shutdowns = Arc::new(AtomicUsize::new(0));
    let runtime = FactoryFailingRuntime {
        create_calls: Arc::clone(&create_calls),
        shutdowns: Arc::clone(&runtime_shutdowns),
    };
    let (config, env) =
        mock_run_config_with_runtime(test_profiles(), 8, 32768, 4, Box::new(runtime));
    let status_path = env._temp_dir.path().join("status.json");

    let error = run(config).await.expect_err("factory startup should fail");

    assert!(
        error.to_string().contains("factory failed"),
        "unexpected error: {error}"
    );
    assert_eq!(create_calls.load(Ordering::SeqCst), 1);
    assert_eq!(runtime_shutdowns.load(Ordering::SeqCst), 1);
    wait_status_mode(&status_path, "stopped", Duration::from_secs(5)).await;
}

#[tokio::test]
async fn nameless_config_reaches_local_provider_setup_before_runtime() {
    const ROOTFS_HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const SNAPSHOT_HASH: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let home_parent = home
        .groups_dir()
        .parent()
        .expect("groups dir should have a parent")
        .to_path_buf();
    tokio::fs::create_dir_all(&home_parent).await.unwrap();
    tokio::fs::write(home.groups_dir(), b"not a directory")
        .await
        .unwrap();

    let rootfs = crate::paths::RootfsPaths::new(&home, ROOTFS_HASH);
    let snapshot = rootfs.snapshot(SNAPSHOT_HASH);
    tokio::fs::create_dir_all(snapshot.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();
    for path in snapshot.required_artifacts() {
        tokio::fs::write(path, b"").await.unwrap();
    }
    tokio::fs::write(
        snapshot.complete_marker(),
        sandbox_firecracker::SNAPSHOT_COMPLETE_MARKER_CONTENT,
    )
    .await
    .unwrap();

    let ca_dir = dir.path().join("ca");
    let firecracker = dir.path().join("firecracker");
    let kernel = dir.path().join("vmlinux");
    tokio::fs::create_dir_all(&ca_dir).await.unwrap();
    tokio::fs::write(&firecracker, b"").await.unwrap();
    tokio::fs::write(&kernel, b"").await.unwrap();

    let base_dir = dir.path().join("base");
    let config_path = dir.path().join("runner.yaml");
    tokio::fs::write(
        &config_path,
        format!(
            r#"
group: test/group
base_dir: {base_dir}
ca_dir: {ca_dir}
firecracker:
  binary: {firecracker}
  kernel: {kernel}
sandbox:
  max_concurrent: 1
profiles:
  vm0/default:
    rootfs_hash: {ROOTFS_HASH}
    snapshot_hash: {SNAPSHOT_HASH}
    vcpu: 2
    memory_mb: 4096
    rootfs_disk_mb: 8192
    workspace_disk_mb: 10240
server:
  url: http://localhost:0
  token: token
"#,
            base_dir = base_dir.display(),
            ca_dir = ca_dir.display(),
            firecracker = firecracker.display(),
            kernel = kernel.display(),
        ),
    )
    .await
    .unwrap();

    let create_calls = Arc::new(AtomicUsize::new(0));
    let provider = CountingRuntimeProvider {
        create_calls: Arc::clone(&create_calls),
    };
    let error = run_start_with_home(
        StartArgs {
            config: config_path,
            api_url: None,
            token: None,
            local: true,
        },
        &provider,
        || Ok(home),
    )
    .await
    .expect_err("local provider setup should fail before runtime creation");

    assert!(
        error.to_string().contains("create group dir"),
        "unexpected error: {error}"
    );
    assert_eq!(create_calls.load(Ordering::SeqCst), 0);
}
