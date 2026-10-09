use super::super::super::*;
use async_trait::async_trait;
use runner_provider::{ClaimedJob, CompletionAuth, JobCandidate};
use runner_supervisor::test_support::ShutdownRecordingRuntime;
use runner_types::types::HeartbeatState;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

struct ShutdownRecordingProvider {
    shutdowns: Arc<AtomicUsize>,
}

#[async_trait]
impl runner_provider::JobProvider for ShutdownRecordingProvider {
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
        Ok(Box::new(ShutdownRecordingRuntime::new(
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
        )))
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
    let mitm_starttime = runner_host::process::read_process_stat(mitm_pid)
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
    let kmsg_starttime = runner_host::process::read_process_stat(kmsg_pid)
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
        runner_host::process::read_process_stat(mitm_pid)
            .await
            .map(|stat| stat.starttime),
        Some(mitm_starttime),
        "terminal DNS failure should reap the MITM child"
    );
    assert_ne!(
        runner_host::process::read_process_stat(kmsg_pid)
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
    let home = runner_host::paths::HomePaths::with_root(dir.path().join("vm0-runner"));
    std::fs::create_dir_all(dir.path().join("vm0-runner")).unwrap();
    std::fs::write(home.live_runner_instances_dir(), b"not a directory").unwrap();

    let provider_shutdowns = Arc::new(AtomicUsize::new(0));
    let provider = ShutdownRecordingProvider {
        shutdowns: Arc::clone(&provider_shutdowns),
    };
    let runtime_shutdowns = Arc::new(AtomicUsize::new(0));
    let factory_creates = Arc::new(AtomicUsize::new(0));
    let mut runtime =
        ShutdownRecordingRuntime::new(Arc::clone(&runtime_shutdowns), Arc::clone(&factory_creates));
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
    let proxy_child_starttime = runner_host::process::read_process_stat(proxy_child_pid)
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
    assert_eq!(factory_creates.load(Ordering::SeqCst), 0);
    tokio::time::timeout(Duration::from_secs(5), cancelled_rx)
        .await
        .expect("prefetch task should observe cleanup cancellation")
        .expect("prefetch task should report cancellation");
    assert_eq!(memory_prefetch.task_count(), 0);
    let proxy_child_still_exists = matches!(
        runner_host::process::read_process_stat(proxy_child_pid).await,
        Some(stat) if stat.starttime == proxy_child_starttime
    );
    assert!(
        !proxy_child_still_exists,
        "proxy child should be killed and reaped during cleanup"
    );
    // Cleanup awaits persistence; no independent publication task may outlive it.
    let status: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(&status_path).await.unwrap()).unwrap();
    assert_eq!(
        status.get("mode").and_then(serde_json::Value::as_str),
        Some("stopped")
    );
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

    let rootfs = runner_host::paths::RootfsPaths::new(&home, ROOTFS_HASH);
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
    // The composition root allocates the host-owned identity under the base-dir
    // lock before later local-provider setup, even when that setup fails.
    uuid::Uuid::parse_str(
        &tokio::fs::read_to_string(base_dir.join("runner_id"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        tokio::fs::read_to_string(base_dir.join("heartbeat_generation"))
            .await
            .unwrap(),
        "1"
    );
}
