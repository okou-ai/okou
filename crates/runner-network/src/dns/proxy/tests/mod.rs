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
    let stderr = "dnsmasq: failed to create listening socket for 127.0.0.1: Address already in use";

    assert_eq!(
        dnsmasq_immediate_exit_error_kind(stderr),
        std::io::ErrorKind::AddrInUse
    );
}

#[test]
fn dnsmasq_immediate_exit_error_kind_keeps_non_port_errors_fatal() {
    let stderr = "dnsmasq: failed to create listening socket for 10.200.52.97: Too many open files";

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

    let error = match try_start_with_grace(command, 5353, NetworkLogManager::new(), move |pid| {
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

#[cfg(target_os = "linux")]
#[tokio::test]
async fn repeated_child_cleanup_start_keeps_stop_joining_the_original_reaper() {
    use runner_host::process::read_process_stat;
    use std::time::Duration;

    let child = tokio::process::Command::new("sleep")
        .arg("60")
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    let starttime = read_process_stat(pid).await.unwrap().starttime;
    let mut proxy = DnsProxy::from_test_child(child, NetworkLogManager::new())
        .await
        .unwrap();
    let gate = crate::test_fixtures::ReapGate::new();
    proxy.set_reap_gate(gate.clone());

    proxy.start_child_cleanup();
    proxy.start_child_cleanup();
    tokio::time::timeout(Duration::from_secs(2), gate.entered.notified())
        .await
        .expect("child cleanup should enter its reap gate");
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(2), proxy.wait())
            .await
            .expect("killed child's monitor should reach EOF")
            .unwrap(),
        DrainableLineReaderExit::Eof {
            during_drain: false,
        },
    ));
    proxy.start_child_cleanup();

    let stop = proxy.stop();
    tokio::pin!(stop);
    assert!(
        futures_util::poll!(&mut stop).is_pending(),
        "stop must still join the original gated reaper after repeated starts",
    );
    gate.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(2), stop)
        .await
        .expect("stop should finish after releasing the original reaper")
        .unwrap();
    assert_ne!(
        read_process_stat(pid).await.map(|stat| stat.starttime),
        Some(starttime),
        "stop should reap the original child",
    );
}
