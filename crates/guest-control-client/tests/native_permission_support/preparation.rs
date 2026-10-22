//! Component proof of actual helper admission; not Runner final-exec custody.

use super::*;

const NAME: &str = "native-guest-preparation";
const SOURCE: &str =
    include_str!("../../../runner/tests/guarded_idle_native/guest_preparation_control.py");

fn hex_bytes(value: &Value) -> TestResult<Vec<u8>> {
    let value = value
        .as_str()
        .ok_or_else(|| io::Error::other("missing hex bytes"))?;
    assert!(value.len().is_multiple_of(2));
    assert!(value.bytes().all(|byte| byte.is_ascii_hexdigit()));
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|part| {
            u8::from_str_radix(std::str::from_utf8(part)?, 16)
                .map_err(Box::<dyn Error + Send + Sync>::from)
        })
        .collect::<TestResult<Vec<_>>>()
}

async fn qualify_preparation(directory: &Path, allow: bool) -> TestResult<()> {
    fs::DirBuilder::new().mode(0o700).create(directory)?;
    let rootfs = directory.join("rootfs.ext4");
    assert!(
        Command::new("cp")
            .args(["--reflink=auto", "--sparse=always", "--no-clobber", "--"])
            .arg(std::env::var("OKOU_TEST_RPC_ROOTFS")?)
            .arg(&rootfs)
            .status()?
            .success()
    );
    let vsock = directory.join("v.sock");
    let socket = vsock
        .to_str()
        .ok_or_else(|| io::Error::other("invalid socket path"))?;
    let listener = UnixListener::bind(format!("{socket}_{PORT}"))?;
    let config = json!({
        "boot-source": {"kernel_image_path": std::env::var("OKOU_TEST_RPC_KERNEL")?,
            "boot_args": "console=ttyS0 reboot=k panic=1 pci=off nomodules random.trust_cpu=on quiet loglevel=0 root=/dev/vda rootfstype=ext4 rw init=/sbin/guest-init"},
        "drives": [{"drive_id": "rootfs", "path_on_host": rootfs, "is_root_device": true, "is_read_only": false}],
        "machine-config": {"vcpu_count": 2, "mem_size_mib": 1024},
        "vsock": {"guest_cid": 3, "uds_path": vsock}
    });
    let config_file = directory.join("firecracker.json");
    write_new(&config_file, &serde_json::to_vec_pretty(&config)?)?;
    let retained = Arc::new(Mutex::new(None));
    let owner = retained.clone();
    let scope = ConnectionScope::new(NAME.into(), move |guest| {
        let (client, host) = UnixStream::pair()?;
        assert!(
            owner
                .lock()
                .map_err(|_| io::Error::other("owner poisoned"))?
                .replace(gate_connection(host, guest))
                .is_none()
        );
        Ok(client)
    })?;
    let mut listening = Box::pin(
        scope.scope(GuestControlClient::wait_for_connection_for_sandbox(
            socket, DEADLINE, NAME,
        )),
    );
    poll_fn(|cx| match listening.as_mut().poll(cx) {
        Poll::Pending => Poll::Ready(Ok(())),
        Poll::Ready(_) => Poll::Ready(Err(io::Error::other("listener ended before VM spawn"))),
    })
    .await?;
    let log = File::create(directory.join("guest-console.log"))?;
    let mut vm = Vm(Some(
        Command::new(std::env::var("OKOU_TEST_RPC_FIRECRACKER")?)
            .args(["--no-api", "--config-file"])
            .arg(config_file)
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .spawn()?,
    ));
    let client = listening.await?;
    let (mut controls, mut exchange, mut connection) = retained
        .lock()
        .map_err(|_| io::Error::other("owner poisoned"))?
        .take()
        .ok_or_else(|| io::Error::other("missing connection owner"))?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let guest_dir = format!("/tmp/preparation-{nonce}");
    let result = client
        .exec_operation_capture_default(
            &format!("mkdir -m 700 {guest_dir} {guest_dir}/runtime"),
            5000,
            &[],
            true,
            "preparation fixture setup",
            DEADLINE,
        )
        .await?;
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    for (name, source) in ASSETS
        .into_iter()
        .chain([("guest_preparation_control.py", SOURCE)])
    {
        client
            .write_file(&format!("{guest_dir}/{name}"), source.as_bytes(), true)
            .await?;
    }
    let command = format!(
        "exec python3 -B {guest_dir}/guest_preparation_control.py --port {PORT} --nonce {nonce} --parent {guest_dir}/runtime"
    );
    controls.arm(RequestKind::Exec)?;
    let controller = client
        .start_exec_operation(ExecOperationRequest {
            timeout_ms: 90000,
            command: &command,
            env: &[],
            sudo: true,
            label: NAME,
            stdout: ExecOutputPolicy::Capture { limit_bytes: 4096 },
            stderr: ExecOutputPolicy::Capture { limit_bytes: 8192 },
            expected_exit_codes: &[0],
            stdin_bytes: None,
            stream_queue_capacity: None,
            start_write_timeout: DEADLINE,
        })
        .await?;
    let request = bounded(&mut controls.captured).await??;
    write_new(&directory.join("exec-request.bin"), request.raw())?;
    controls
        .dispatch
        .send(())
        .map_err(|_| io::Error::other("lost dispatch"))?;
    let (stream, _) = bounded(listener.accept()).await??;
    let mut control = Control {
        stream,
        nonce: nonce.clone(),
        sequence: 0,
        directory: directory.to_owned(),
    };
    let hello = control.receive(0).await?;
    assert_eq!(field(&hello, &["ready"])?, &json!(true));
    assert_eq!(field(&hello, &["uid"])?, &json!(0));
    assert_eq!(field(&hello, &["original", "file_type"])?, &json!(0o40000));
    let started = control.command(json!({"op": "start"})).await?;
    let event = control.command(json!({"op": "observe"})).await?;
    assert_eq!(
        field(&event, &["child_pid"])?,
        field(&started, &["child_pid"])?
    );
    assert_eq!(
        field(&event, &["executable"])?,
        field(&hello, &["executable"])?
    );
    assert_eq!(
        field(&event, &["argv"])?,
        &json!([
            guest_contracts::guest_binary::AGENT_PATH,
            "prepare-for-reuse"
        ])
    );
    for key in ["device", "inode"] {
        assert_eq!(
            field(&event, &["event", key])?,
            field(&hello, &["original", key])?
        );
    }
    let status = control.command(json!({"op": "status"})).await?;
    assert_eq!(field(&status, &["held"])?, &json!(true));
    assert_eq!(
        field(&status, &["original"])?,
        field(&hello, &["original"])?
    );
    assert_eq!(
        field(&event, &["workload"])?,
        field(&status, &["workload"])?
    );
    assert!(matches!(
        controls.response.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    let decision = control
        .command(json!({"op": "decide", "event_id": 1, "allow": allow}))
        .await?;
    assert_eq!(
        field(&decision, &["event_descriptors_closed"])?,
        &json!(true)
    );
    assert_eq!(
        field(&decision, &["retirement", "group_closed"])?,
        &json!(true)
    );
    assert_eq!(field(&decision, &["retirement", "denied"])?, &json!([]));
    let joined = control.command(json!({"op": "join"})).await?;
    assert_eq!(field(&joined, &["helper_joined"])?, &json!(true));
    assert_eq!(
        field(&joined, &["returncode"])?,
        &json!(if allow {
            0
        } else {
            guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_CLEANUP_FAILED
        })
    );
    assert_eq!(
        field(&joined, &["request_hex"])?,
        field(&started, &["request_hex"])?
    );
    assert_eq!(
        field(&joined, &["child_pid"])?,
        field(&started, &["child_pid"])?
    );
    let stdout = hex_bytes(field(&joined, &["stdout_hex"])?)?;
    let stderr = hex_bytes(field(&joined, &["stderr_hex"])?)?;
    let stdin = hex_bytes(field(&joined, &["request_hex"])?)?;
    let decoded: guest_contracts::reuse_preparation::ReusePreparationRequest =
        serde_json::from_slice(&stdin)?;
    assert_eq!(
        decoded.current_runtime_dir,
        format!("{guest_dir}/runtime/current")
    );
    assert_eq!(
        decoded.retained_runtime_dir,
        Some(format!("{guest_dir}/runtime/retained"))
    );
    for name in ["current", "retained", "stale"] {
        if allow && name == "stale" {
            assert!(field(&joined, &["payloads"])?.get(name).is_none());
        } else {
            assert_eq!(
                hex_bytes(field(&joined, &["payloads", name])?)?,
                format!("original {name}\n").as_bytes()
            );
        }
    }
    if allow {
        let report: guest_contracts::reuse_preparation::ReusePreparationReport =
            serde_json::from_slice(&stdout)?;
        assert_eq!(report.removed_entries, 1);
        assert!(stderr.is_empty());
    } else {
        assert!(stdout.is_empty());
        assert!(std::str::from_utf8(&stderr)?.contains("runtime cleanup failed"));
        assert!(std::str::from_utf8(&stderr)?.contains("os error 1"));
    }
    write_new(&directory.join("helper-stdin.json"), &stdin)?;
    write_new(&directory.join("helper-stdout.bin"), &stdout)?;
    write_new(&directory.join("helper-stderr.bin"), &stderr)?;
    let retired = control.command(json!({"op": "retire"})).await?;
    assert_eq!(field(&retired, &["helper_joined"])?, &json!(true));
    assert_eq!(field(&retired, &["originals_closed"])?, &json!(true));
    let terminal = bounded(&mut controls.response).await??;
    write_new(&directory.join("exec-terminal.bin"), terminal.raw())?;
    controls
        .delivery
        .send(ResponseDisposition::Deliver)
        .map_err(|_| io::Error::other("lost delivery"))?;
    let actual = bounded(exchange.join()).await??;
    assert_eq!(actual.request, request);
    assert_eq!(actual.response, terminal);
    let result = controller.wait(DEADLINE).await?;
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert!(!result.stream_overflowed);
    for output in [&result.stdout, &result.stderr] {
        assert!(matches!(
            output,
            ExecOwnedCapturedOutput::Captured {
                truncated: false,
                ..
            }
        ));
    }
    write_new(
        &directory.join("controller-terminal.txt"),
        format!("{result:?}").as_bytes(),
    )?;
    drop(control);
    drop(listener);
    drop(client);
    vm.contain()?;
    bounded(connection.join()).await??;
    write_new(
        &directory.join("qualification.json"),
        &serde_json::to_vec_pretty(&json!({
            "schema": "native-guest-preparation-component-v1", "source_commit": option_env!("OKOU_TEST_BUILD_SOURCE_SHA"),
            "allow": allow, "nonce": nonce, "controller_joined": true, "exchange_joined": true,
            "connection_joined": true, "vm_containment_only": true,
            "runner_final_exec_established": false, "cancellation_custody_established": false,
            "saving_lease_cleanup_established": false,
        }))?,
    )?;
    fs::remove_file(rootfs)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires root/KVM, exact current packaged Guests and an exclusive short output path"]
async fn native_same_operation_preparation_allow_and_deny() -> TestResult<()> {
    let source = option_env!("OKOU_TEST_BUILD_SOURCE_SHA")
        .ok_or_else(|| io::Error::other("missing build source"))?;
    assert_eq!(source.len(), 40);
    assert!(source.bytes().all(|value| value.is_ascii_hexdigit()));
    let directory = PathBuf::from(std::env::var("OKOU_TEST_GUEST_PREPARATION_DIR")?);
    assert!(directory.is_absolute());
    fs::DirBuilder::new().mode(0o700).create(&directory)?;
    qualify_preparation(&directory.join("allow"), true).await?;
    qualify_preparation(&directory.join("deny"), false).await?;
    Ok(())
}
