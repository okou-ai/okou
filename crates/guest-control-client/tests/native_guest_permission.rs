#![cfg(all(target_os = "linux", feature = "test-support"))]

//! Opt-in capability proof; VM containment is never Runner saving/lease proof.

use std::error::Error;
use std::fs::{self, File, OpenOptions};
use std::future::{Future, poll_fn};
use std::io::{self, Write};
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use guest_control_client::test_support::ConnectionScope;
use guest_control_client::test_support::request_gate::{
    RequestKind, ResponseDisposition, gate_connection,
};
use guest_control_client::{
    ExecOperationRequest, ExecOwnedCapturedOutput, GuestControlClient,
    NormalOperationFenceRejection,
};
use guest_control_proto::{
    Decoder, ExecCapturedOutput, ExecOutputPolicy, ExecTermination, GuestStateRestoreTimezone,
    MSG_GUEST_STATE_RESTORE_RESULT, decode_guest_state_restore_request,
    decode_guest_state_restore_result,
};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;
const DEADLINE: Duration = Duration::from_secs(20);
const PORT: u32 = 52010;
const ASSETS: [(&str, &str); 3] = [
    (
        "file_residency.py",
        include_str!("../../runner/tests/guarded_idle_native/file_residency.py"),
    ),
    (
        "file_open_permission.py",
        include_str!("../../runner/tests/guarded_idle_native/file_open_permission.py"),
    ),
    (
        "guest_permission_control.py",
        include_str!("../../runner/tests/guarded_idle_native/guest_permission_control.py"),
    ),
];

async fn bounded<F: Future>(future: F) -> TestResult<F::Output> {
    Ok(tokio::time::timeout(DEADLINE, future).await?)
}

fn field<'a>(value: &'a Value, path: &[&str]) -> TestResult<&'a Value> {
    let mut current = value;
    for key in path {
        current = current
            .get(key)
            .ok_or_else(|| io::Error::other(format!("missing control field {path:?}")))?;
    }
    Ok(current)
}

fn write_new(path: &Path, data: &[u8]) -> io::Result<()> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?
        .write_all(data)
}

struct Vm(Option<Child>);

impl Vm {
    fn contain(&mut self) -> io::Result<()> {
        let Some(mut child) = self.0.take() else {
            return Ok(());
        };
        if child.try_wait()?.is_none() {
            let killed = child.kill();
            child.wait()?;
            killed?;
        } else {
            child.wait()?;
        }
        Ok(())
    }
}

impl Drop for Vm {
    fn drop(&mut self) {
        // Failure containment only. A failed kill/wait never passes the test.
        let _ = self.contain();
    }
}

struct Control {
    stream: UnixStream,
    nonce: String,
    sequence: u32,
    directory: PathBuf,
}

impl Control {
    async fn receive(&mut self, sequence: u32) -> TestResult<Value> {
        let size = bounded(self.stream.read_u32()).await??;
        assert!((1..=16384).contains(&size));
        let mut raw = vec![0; size as usize];
        bounded(self.stream.read_exact(&mut raw)).await??;
        let mut frame = size.to_be_bytes().to_vec();
        frame.extend_from_slice(&raw);
        write_new(
            &self
                .directory
                .join(format!("control-{sequence}-response.bin")),
            &frame,
        )?;
        let value: Value = serde_json::from_slice(&raw)?;
        assert_eq!(field(&value, &["nonce"])?, &json!(self.nonce));
        assert_eq!(field(&value, &["id"])?, &json!(sequence));
        Ok(value)
    }

    async fn command(&mut self, command: Value) -> TestResult<Value> {
        self.sequence += 1;
        let data = serde_json::to_vec(
            &json!({"nonce": self.nonce, "id": self.sequence, "command": command}),
        )?;
        assert!(data.len() <= 16384);
        let mut raw = u32::try_from(data.len())?.to_be_bytes().to_vec();
        raw.extend(data);
        write_new(
            &self
                .directory
                .join(format!("control-{}-request.bin", self.sequence)),
            &raw,
        )?;
        bounded(self.stream.write_all(&raw)).await??;
        Ok(field(&self.receive(self.sequence).await?, &["result"])?.clone())
    }
}

fn not_parkable(client: &GuestControlClient) {
    assert!(matches!(
        client.try_fence_normal_operations(),
        Err(NormalOperationFenceRejection::NotParkable)
    ));
    assert!(
        matches!(client.reserve_external_operation(), Err(error) if error.kind() == io::ErrorKind::ConnectionReset)
    );
}

async fn qualify(directory: &Path, allow: bool) -> TestResult<()> {
    fs::DirBuilder::new().mode(0o700).create(directory)?;
    let rootfs = directory.join("rootfs.ext4");
    let input = std::env::var("OKOU_TEST_RPC_ROOTFS")?;
    let copied = Command::new("cp")
        .args([
            "--reflink=auto",
            "--sparse=always",
            "--no-clobber",
            "--",
            &input,
        ])
        .arg(&rootfs)
        .status()?;
    assert!(copied.success());
    let vsock = directory.join("v.sock");
    let socket = vsock
        .to_str()
        .ok_or_else(|| io::Error::other("invalid vsock path"))?;
    let control_listener = UnixListener::bind(format!("{socket}_{PORT}"))?;
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
    let scope = ConnectionScope::new("native-permission".into(), move |guest| {
        let (client, host) = UnixStream::pair()?;
        assert!(
            owner
                .lock()
                .map_err(|_| io::Error::other("gate owner poisoned"))?
                .replace(gate_connection(host, guest))
                .is_none()
        );
        Ok(client)
    })?;
    let mut listening = Box::pin(
        scope.scope(GuestControlClient::wait_for_connection_for_sandbox(
            socket,
            DEADLINE,
            "native-permission",
        )),
    );
    // This production listener binds synchronously before its first accept
    // wait. Establish that causal boundary before starting the owned VM.
    poll_fn(|cx| match listening.as_mut().poll(cx) {
        Poll::Pending => Poll::Ready(Ok(())),
        Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
        Poll::Ready(Ok(_)) => Poll::Ready(Err(io::Error::other("Guest connected before VM spawn"))),
    })
    .await?;
    let log = File::create(directory.join("guest-console.log"))?;
    let mut vm = Command::new(std::env::var("OKOU_TEST_RPC_FIRECRACKER")?)
        .arg("--no-api")
        .arg("--config-file")
        .arg(config_file)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .spawn()
        .map(|child| Vm(Some(child)))?;
    let client = listening.await?;
    let (mut controls, mut exchange, mut connection) = retained
        .lock()
        .map_err(|_| io::Error::other("gate owner poisoned"))?
        .take()
        .ok_or_else(|| io::Error::other("missing real connection owner"))?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let guest_dir = format!("/tmp/permission-{nonce}");
    let mkdir = client
        .exec_operation_capture_default(
            &format!("mkdir -m 700 {guest_dir}"),
            5000,
            &[],
            true,
            "permission fixture setup",
            DEADLINE,
        )
        .await?;
    assert_eq!(mkdir.termination, ExecTermination::Exited { exit_code: 0 });
    for (name, source) in ASSETS {
        client
            .write_file(&format!("{guest_dir}/{name}"), source.as_bytes(), true)
            .await?;
    }
    let command = format!(
        "exec python3 -B {guest_dir}/guest_permission_control.py --port {PORT} --nonce {nonce}"
    );
    let controller = client
        .start_exec_operation(ExecOperationRequest {
            timeout_ms: 90000,
            command: &command,
            env: &[],
            sudo: true,
            label: "owned Guest permission controller",
            stdout: ExecOutputPolicy::Capture { limit_bytes: 4096 },
            stderr: ExecOutputPolicy::Capture { limit_bytes: 8192 },
            expected_exit_codes: &[0],
            stdin_bytes: None,
            stream_queue_capacity: None,
            start_write_timeout: DEADLINE,
        })
        .await?;
    let (stream, _) = bounded(control_listener.accept()).await??;
    let mut control = Control {
        stream,
        nonce,
        sequence: 0,
        directory: directory.to_owned(),
    };
    let hello = control.receive(0).await?;
    assert_eq!(field(&hello, &["ready"])?, &json!(true));
    assert_eq!(field(&hello, &["uid"])?, &json!(0));
    controls.arm(RequestKind::GuestStateRestore)?;
    let seconds = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let entropy = [23; 256];
    let mut restore = Box::pin(client.guest_state_restore(
        seconds,
        0,
        &entropy,
        GuestStateRestoreTimezone::Required("UTC"),
        60000,
        Duration::from_secs(70),
    ));
    let request = tokio::select! {
        result = restore.as_mut() => return Err(io::Error::other(format!("restore completed before actual capture: {result:?}")).into()),
        result = bounded(&mut controls.captured) => result??,
    };
    write_new(&directory.join("restore-request.bin"), request.raw())?;
    let messages = Decoder::new().decode(request.raw())?;
    assert_eq!(messages.len(), 1);
    let message = messages
        .first()
        .ok_or_else(|| io::Error::other("missing restore request"))?;
    let decoded = decode_guest_state_restore_request(&message.payload)?;
    assert_eq!(decoded.entropy, entropy);
    assert_eq!(decoded.unix_seconds, seconds);
    assert_eq!(decoded.unix_nanoseconds, 0);
    assert_eq!(decoded.timezone, GuestStateRestoreTimezone::Required("UTC"));
    controls
        .dispatch
        .send(())
        .map_err(|_| io::Error::other("request owner lost"))?;
    let event = tokio::select! {
        result = restore.as_mut() => return Err(io::Error::other(format!("restore completed before permission event: {result:?}")).into()),
        result = control.command(json!({"op": "observe"})) => result?,
    };
    assert_eq!(
        field(&event, &["executable"])?,
        field(&hello, &["executable"])?
    );
    assert_eq!(
        field(&event, &["argv"])?,
        &json!([
            guest_contracts::guest_binary::STATE_RESTORE_PATH,
            "--restore-state",
            seconds.to_string(),
            "0",
            "required",
            "UTC"
        ])
    );
    assert_eq!(
        field(&event, &["event", "device"])?,
        field(&hello, &["original", "device"])?
    );
    assert_eq!(
        field(&event, &["event", "inode"])?,
        field(&hello, &["original", "inode"])?
    );
    assert!(matches!(
        controls.response.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    drop(restore);
    not_parkable(&client);
    assert!(matches!(client
            .guest_state_restore(
                seconds,
                0,
                &entropy,
                GuestStateRestoreTimezone::Required("UTC"),
                1000,
                DEADLINE
            )
            .await, Err(error) if error.kind() == io::ErrorKind::ConnectionReset));
    let status = control.command(json!({"op": "status"})).await?;
    assert_eq!(field(&status, &["held"])?, &json!(true));
    assert_eq!(
        field(&status, &["original"])?,
        field(&hello, &["original"])?
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
    let terminal = bounded(&mut controls.response).await??;
    assert_eq!(terminal.message_type(), MSG_GUEST_STATE_RESTORE_RESULT);
    assert_eq!(terminal.sequence(), request.sequence());
    write_new(&directory.join("restore-terminal.bin"), terminal.raw())?;
    let messages = Decoder::new().decode(terminal.raw())?;
    assert_eq!(messages.len(), 1);
    let message = messages
        .first()
        .ok_or_else(|| io::Error::other("missing restore terminal"))?;
    let result = decode_guest_state_restore_result(&message.payload)?;
    assert_eq!(
        result.termination,
        ExecTermination::Exited {
            exit_code: if allow { 0 } else { 1 }
        }
    );
    let ExecCapturedOutput::Captured {
        bytes,
        truncated: false,
    } = result.stderr
    else {
        return Err(io::Error::other("canonical helper stderr was lost or truncated").into());
    };
    if allow {
        assert!(bytes.is_empty());
    } else {
        let diagnostic = std::str::from_utf8(bytes)?;
        assert!(diagnostic.contains("guest timezone sync failed"));
        assert!(diagnostic.contains("os error 1"));
    }
    controls
        .delivery
        .send(ResponseDisposition::Deliver)
        .map_err(|_| io::Error::other("terminal owner lost"))?;
    let joined = bounded(exchange.join()).await??;
    assert_eq!(joined.request, request);
    assert_eq!(joined.response, terminal);
    let retired = control.command(json!({"op": "retire"})).await?;
    assert_eq!(field(&retired, &["group_closed"])?, &json!(true));
    assert_eq!(
        field(&retired, &["original_duplicate_closed"])?,
        &json!(true)
    );
    assert_eq!(field(&retired, &["denied"])?, &json!([]));
    let result = controller.wait(DEADLINE).await?;
    let controller_terminal = format!("{result:?}");
    write_new(
        &directory.join("controller-terminal.txt"),
        controller_terminal.as_bytes(),
    )?;
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert!(!result.stream_overflowed, "controller output was lost");
    for output in [&result.stdout, &result.stderr] {
        // Ordinary root exec can include shell-startup diagnostics. Preserve
        // the complete terminal instead of requiring an undocumented silence
        // contract; the independent control protocol has its own acknowledgments.
        assert!(
            matches!(
                output,
                ExecOwnedCapturedOutput::Captured {
                    truncated: false,
                    ..
                }
            ),
            "{output:?}"
        );
    }
    not_parkable(&client);
    drop(control);
    drop(control_listener);
    drop(client);
    vm.contain()?;
    bounded(connection.join()).await??;
    let record = json!({"schema": "native-guest-permission-v1", "allow": allow,
        "source_commit": option_env!("OKOU_TEST_BUILD_SOURCE_SHA"), "event": event,
        "request_sequence": request.sequence(), "controller_joined": true, "controller_terminal": controller_terminal, "wire_exchange_joined": true,
        "connection_joined": true, "not_parkable_retained": true, "vm_containment_only": true,
        "runner_saving_established": false, "full_lease_cleanup_established": false,
        "snapshot_matrix_established": false, "contention_io_established": false});
    write_new(
        &directory.join("qualification.json"),
        &serde_json::to_vec_pretty(&record)?,
    )?;
    fs::remove_file(rootfs)?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires root/KVM, current packaged Guest inputs, exact build source and an exclusive short output path"]
async fn native_guest_permission_survives_restore_observer_cancellation() -> TestResult<()> {
    let credentials = fs::read_to_string("/proc/self/status")?;
    let uid = credentials
        .lines()
        .find(|line| line.starts_with("Uid:"))
        .ok_or_else(|| io::Error::other("missing root credentials"))?;
    assert_eq!(uid.split_whitespace().skip(1).collect::<Vec<_>>(), ["0"; 4]);
    let source = option_env!("OKOU_TEST_BUILD_SOURCE_SHA")
        .ok_or_else(|| io::Error::other("exact build source missing"))?;
    assert_eq!(source.len(), 40);
    assert!(source.bytes().all(|c| c.is_ascii_hexdigit()));
    let directory = PathBuf::from(std::env::var("OKOU_TEST_GUEST_PERMISSION_DIR")?);
    assert!(directory.is_absolute());
    fs::DirBuilder::new().mode(0o700).create(&directory)?;
    qualify(&directory.join("allow"), true).await?;
    qualify(&directory.join("deny"), false).await?;
    Ok(())
}
