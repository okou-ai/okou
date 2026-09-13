//! A real local shell behind the authenticated test SSH server.

use std::{os::unix::process::ExitStatusExt, process::Stdio};

use russh::{ChannelId, server};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::mpsc,
    task::JoinHandle,
};

pub(super) enum Input {
    Data(Vec<u8>),
    Eof,
}

pub(super) struct Process {
    input: mpsc::Sender<Input>,
    task: JoinHandle<()>,
    pid: u32,
}

impl Drop for Process {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Process {
    pub(super) fn start(
        command: Option<&[u8]>,
        pty: bool,
        channel: ChannelId,
        handle: server::Handle,
    ) -> Self {
        let mut process = if pty {
            // Python's standard-library bridge creates a real PTY without a
            // production dependency or unsafe pre_exec code in the fixture.
            let mut process = Command::new("python3");
            process.args([
                "-u",
                "-c",
                "import pty, sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)",
                "/bin/sh",
            ]);
            process
        } else {
            Command::new("/bin/sh")
        };
        if let Some(command) = command {
            process.arg("-c").arg(std::str::from_utf8(command).unwrap());
        }
        let mut child = process
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let mut stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (input, mut receiver) = mpsc::channel(16);
        let task = tokio::spawn(async move {
            let inputs = async {
                while let Some(input) = receiver.recv().await {
                    match input {
                        Input::Data(bytes) => {
                            if let Some(stdin) = &mut stdin {
                                stdin.write_all(&bytes).await.unwrap();
                            }
                        }
                        Input::Eof => {
                            stdin.take();
                        }
                    }
                }
            };
            let completed = async {
                let (_, _, status) = tokio::join!(
                    forward(stdout, &handle, channel, false),
                    forward(stderr, &handle, channel, true),
                    child.wait()
                );
                let status = status.unwrap();
                if let Some(code) = status.code() {
                    let _ = handle.exit_status_request(channel, code as u32).await;
                } else {
                    let _ = handle
                        .exit_signal_request(
                            channel,
                            remote_signal(status.signal().unwrap()),
                            status.core_dumped(),
                            String::new(),
                            String::new(),
                        )
                        .await;
                }
                let _ = handle.eof(channel).await;
                let _ = handle.close(channel).await;
            };
            tokio::select! { () = inputs => (), () = completed => () }
        });
        Self { input, task, pid }
    }

    pub(super) fn input(&self, input: Input) -> Result<(), russh::Error> {
        self.input
            .try_send(input)
            .map_err(|_| russh::Error::Disconnect)
    }

    pub(super) fn signal(&self, signal: &russh::Sig) {
        use nix::sys::signal::{Signal, kill};
        let signal = match signal {
            russh::Sig::INT => Signal::SIGINT,
            russh::Sig::KILL => Signal::SIGKILL,
            russh::Sig::HUP => Signal::SIGHUP,
            russh::Sig::USR1 => Signal::SIGUSR1,
            russh::Sig::Custom(name) if name == "USR2" => Signal::SIGUSR2,
            _ => Signal::SIGTERM,
        };
        let _ = kill(nix::unistd::Pid::from_raw(self.pid as i32), signal);
    }
}

fn remote_signal(signal: i32) -> russh::Sig {
    match signal {
        libc::SIGINT => russh::Sig::INT,
        libc::SIGKILL => russh::Sig::KILL,
        libc::SIGHUP => russh::Sig::HUP,
        libc::SIGTERM => russh::Sig::TERM,
        libc::SIGUSR1 => russh::Sig::USR1,
        libc::SIGUSR2 => russh::Sig::Custom("USR2".into()),
        _ => russh::Sig::Custom("UNKNOWN".into()),
    }
}

async fn forward(
    mut source: impl AsyncRead + Unpin,
    handle: &server::Handle,
    channel: ChannelId,
    stderr: bool,
) {
    let mut bytes = [0; 4096];
    loop {
        let count = source.read(&mut bytes).await.unwrap();
        if count == 0 {
            return;
        }
        let result = if stderr {
            handle
                .extended_data(channel, 1, bytes[..count].to_vec())
                .await
        } else {
            handle.data(channel, bytes[..count].to_vec()).await
        };
        if result.is_err() {
            return;
        }
    }
}
