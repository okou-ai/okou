//! Independent control and retained process ownership inside real Runner prepare.

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sandbox::{ProcessOutputMode, Sandbox, StartProcessRequest};
use sandbox_firecracker::{RuntimePaths, SockPaths};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

use super::*;

const PORT: u32 = 52010;
const DEADLINE: Duration = Duration::from_secs(20);
const ASSETS: [(&str, &str); 3] = [
    ("file_residency.py", include_str!("file_residency.py")),
    (
        "file_open_permission.py",
        include_str!("file_open_permission.py"),
    ),
    (
        "guest_permission_control.py",
        include_str!("guest_permission_control.py"),
    ),
];

pub(super) fn with_control(mut value: Value, control: Option<Value>) -> Value {
    if let Some(control) = control
        && let Some(fields) = value.as_object_mut()
    {
        fields.insert("running_control".into(), control);
    }
    value
}

pub(super) fn field<'a>(value: &'a Value, path: &[&str]) -> TestResult<&'a Value> {
    let mut value = value;
    for key in path {
        value = value
            .get(key)
            .ok_or_else(|| io::Error::other(format!("missing control field {path:?}")))?;
    }
    Ok(value)
}

pub(super) struct Owner {
    stream: UnixStream,
    _listener: UnixListener,
    nonce: String,
    sequence: u32,
    frames: BTreeMap<String, String>,
    process: futures_util::future::BoxFuture<'static, io::Result<sandbox::ProcessExit>>,
    guest_pid: u32,
    terminal: Option<Value>,
    directory: PathBuf,
}

fn write_new(path: &Path, data: &[u8]) -> io::Result<()> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?
        .write_all(data)
}

impl Owner {
    pub async fn start(sandbox: &dyn Sandbox) -> TestResult<Self> {
        let output = std::env::current_dir()?.join("permission-control");
        fs::create_dir(&output)?;
        let paths = SockPaths::new(RuntimePaths::new().sock_dir(sandbox.id()));
        let listener = UnixListener::bind(format!("{}_{PORT}", paths.vsock().display()))?;
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let directory = format!("/tmp/permission-{nonce}");
        fixture::exec(
            sandbox,
            &format!("mkdir -m 700 {directory} && chown user:user {directory}"),
        )
        .await?;
        for (name, source) in ASSETS {
            sandbox
                .write_file(&format!("{directory}/{name}"), source.as_bytes())
                .await?;
        }
        let command = format!(
            "exec python3 -B {directory}/guest_permission_control.py --port {PORT} --nonce {nonce}"
        );
        let mut handle = sandbox
            .start_process(&StartProcessRequest {
                cmd: &command,
                timeout: Duration::from_secs(120),
                timeout_is_expected: false,
                start_timeout: DEADLINE,
                env: &[],
                sudo: true,
                output: ProcessOutputMode::Buffered {
                    output_limits: sandbox::EXEC_OUTPUT_LIMIT_64_KIB,
                },
            })
            .await?;
        let guest_pid = handle.guest_pid;
        // Retain this already-started backend exit operation without borrowing
        // the Sandbox that the cancelled prepare future must release.
        let process = handle
            .take_waiter()
            .ok_or_else(|| io::Error::other("controller process waiter missing"))?
            .wait(Duration::from_secs(120));
        let (stream, _) = tokio::time::timeout(DEADLINE, listener.accept()).await??;
        let mut owner = Self {
            stream,
            _listener: listener,
            nonce,
            sequence: 0,
            frames: BTreeMap::new(),
            process,
            guest_pid,
            terminal: None,
            directory: output,
        };
        let hello = owner.receive(0).await?;
        if field(&hello, &["ready"])? != &json!(true) || field(&hello, &["uid"])? != &json!(0) {
            return Err(io::Error::other("actual Guest controller did not arm as root").into());
        }
        Ok(owner)
    }

    async fn receive(&mut self, sequence: u32) -> TestResult<Value> {
        let deadline = tokio::time::Instant::now() + DEADLINE;
        let size = tokio::time::timeout_at(deadline, self.stream.read_u32()).await??;
        if !(1..=16384).contains(&size) {
            return Err(io::Error::other("invalid control response length").into());
        }
        let mut data = vec![0; size as usize];
        tokio::time::timeout_at(deadline, self.stream.read_exact(&mut data)).await??;
        let mut raw = size.to_be_bytes().to_vec();
        raw.extend(&data);
        write_new(
            &self.directory.join(format!("response-{sequence}.bin")),
            &raw,
        )?;
        if self
            .frames
            .insert(format!("response-{sequence}"), hex::encode(raw))
            .is_some()
        {
            return Err(io::Error::other("control response repeated").into());
        }
        let value: Value = serde_json::from_slice(&data)?;
        if field(&value, &["nonce"])? != &json!(self.nonce)
            || field(&value, &["id"])? != &json!(sequence)
        {
            return Err(io::Error::other("foreign control response").into());
        }
        Ok(value)
    }

    pub async fn command(&mut self, command: Value) -> TestResult<Value> {
        self.sequence += 1;
        let data =
            serde_json::to_vec(&json!({"nonce":self.nonce,"id":self.sequence,"command":command}))?;
        if data.is_empty() || data.len() > 16384 {
            return Err(io::Error::other("control command too large").into());
        }
        let mut raw = u32::try_from(data.len())?.to_be_bytes().to_vec();
        raw.extend(data);
        write_new(
            &self
                .directory
                .join(format!("request-{}.bin", self.sequence)),
            &raw,
        )?;
        self.frames
            .insert(format!("request-{}", self.sequence), hex::encode(&raw));
        tokio::time::timeout(DEADLINE, self.stream.write_all(&raw)).await??;
        Ok(field(&self.receive(self.sequence).await?, &["result"])?.clone())
    }

    pub fn record(&self) -> Value {
        json!({"nonce":self.nonce,"frames":self.frames,"guest_pid":self.guest_pid,"process_terminal":self.terminal})
    }

    pub fn check_event(&self, event: &Value) -> TestResult<()> {
        let raw = self
            .frames
            .get("response-0")
            .ok_or_else(|| io::Error::other("controller hello missing"))?;
        let raw = hex::decode(raw)?;
        let hello: Value = serde_json::from_slice(
            raw.get(4..)
                .ok_or_else(|| io::Error::other("hello frame truncated"))?,
        )?;
        for key in ["device", "inode"] {
            if field(event, &["event", key])? != field(&hello, &["original", key])? {
                return Err(io::Error::other("running event changed the original inode").into());
            }
        }
        if field(event, &["executable"])? != field(&hello, &["executable"])? {
            return Err(io::Error::other("running event executable is not canonical").into());
        }
        Ok(())
    }

    pub async fn retire(&mut self) -> TestResult<()> {
        let result = self.command(json!({"op":"retire"})).await?;
        for key in ["mark_removed", "group_closed", "original_duplicate_closed"] {
            if field(&result, &[key])? != &json!(true) {
                return Err(io::Error::other("controller retirement incomplete").into());
            }
        }
        if field(&result, &["denied"])? != &json!([]) {
            return Err(io::Error::other("unexpected queued producer").into());
        }
        let terminal = tokio::time::timeout(DEADLINE, &mut self.process).await??;
        self.terminal = Some(
            json!({"guest_pid":terminal.guest_pid,"termination":format!("{:?}",terminal.termination),
            "stdout_hex":hex::encode(&terminal.stdout),"stderr_hex":hex::encode(&terminal.stderr),
            "stdout_truncated":terminal.stdout_truncated,"stderr_truncated":terminal.stderr_truncated,
            "stream_overflowed":terminal.stream_overflowed,"diagnostic":terminal.diagnostic}),
        );
        write_new(
            &self.directory.join("controller-terminal.json"),
            &serde_json::to_vec(&self.terminal)?,
        )?;
        if terminal.guest_pid != self.guest_pid
            || terminal.termination != (sandbox::ExecTermination::Exited { exit_code: 0 })
            || terminal.stdout_truncated
            || terminal.stderr_truncated
            || terminal.stream_overflowed
            || !terminal.diagnostic.is_empty()
        {
            return Err(
                io::Error::other("actual controller terminal failed or lost output").into(),
            );
        }
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires exact committed Host/current Guests, KVM/NBD, new matching snapshot and unchanged P1"]
async fn native_running_restore_loss_retains_original_uncertainty() -> TestResult<()> {
    let allow = match std::env::var("OKOU_TEST_RUNNING_RESTORE_DECISION")?.as_str() {
        "allow" => true,
        "deny" => false,
        _ => return Err(io::Error::other("invalid running restore decision").into()),
    };
    guest_preparation::selected(
        guest_preparation::Kind::RunningRestore(allow),
        "OKOU_TEST_RUNNING_RESTORE",
    )
    .await
}

#[test]
fn running_restore_reader_checks_original_files_and_cli() -> TestResult<()> {
    guest_preparation::reader_test("running_restore_report_test.py")
}
