use std::io::{Read, Write};
use std::process::{Child, Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

use runner_rpc_proto::{
    Delivery, ErrorCode, Response,
    stream::{Frame, MAX_DURATION_MS, Reader},
};

const CHILD_ENV: &str = "OKOU_RPC_STDIN_SHUTDOWN_CHILD";
const OUTPUT_START: &[u8] = b"\nRPC protocol output:\n";
const CHILD_TIMEOUT: Duration = Duration::from_secs(10);

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn read_output(mut pipe: impl Read) -> Vec<u8> {
    let mut bytes = Vec::new();
    pipe.read_to_end(&mut bytes).unwrap();
    bytes
}

fn output_with_stdin_held_open(mode: &str) -> Vec<u8> {
    std::thread::scope(|scope| {
        let deadline = Instant::now() + CHILD_TIMEOUT;
        // On any panic this owner kills/reaps before scope joins the readers.
        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tests::stdin_deadline_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env(CHILD_ENV, mode)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let stdout = child.0.stdout.take().unwrap();
        let stderr = child.0.stderr.take().unwrap();
        let stdout = scope.spawn(move || read_output(stdout));
        let stderr = scope.spawn(move || read_output(stderr));

        // try_wait leaves stdin open. Keep its producer in the child owner until
        // after the exit assertion, including while timeout cancellation runs.
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "{mode} did not exit with stdin open");
            std::thread::sleep(remaining.min(Duration::from_millis(1)));
        };
        assert_eq!(
            status.code(),
            Some(1),
            "{mode} timeout must exit unsuccessfully"
        );
        let stdout = stdout.join().unwrap();
        let stderr = stderr.join().unwrap();
        assert!(stderr.is_empty(), "unexpected stderr: {stderr:?}");

        // libtest prints a preamble before entering the guarded child. The child
        // exits directly, so everything after this boundary is production output.
        let start = stdout
            .windows(OUTPUT_START.len())
            .position(|bytes| bytes == OUTPUT_START)
            .expect("child entered the production runtime owner")
            + OUTPUT_START.len();
        stdout[start..].to_vec()
    })
}

#[test]
fn one_shot_deadline_exits_with_stdin_held_open() {
    let output = output_with_stdin_held_open("one-shot");
    assert_eq!(
        output,
        Response::error(ErrorCode::TimedOut, Delivery::NotDispatched)
            .to_ndjson()
            .unwrap()
    );
}

#[tokio::test]
async fn streaming_deadline_exits_with_stdin_held_open() {
    let output = output_with_stdin_held_open("stream");
    let mut responses = Reader::responses(output.as_slice());
    assert!(matches!(
        responses.next().await.unwrap(),
        Some(Frame::Control(Response::Error {
            code: ErrorCode::TimedOut,
            delivery: Delivery::NotDispatched,
            diagnostic_text: None,
        }))
    ));
    assert!(responses.next().await.unwrap().is_none());
}

#[test]
#[ignore = "isolated child invoked by the open-stdin process tests"]
fn stdin_deadline_child() {
    let (streaming, budget) = match std::env::var(CHILD_ENV).as_deref() {
        Ok("one-shot") => (false, Duration::from_secs(60)),
        Ok("stream") => (true, Duration::from_millis(MAX_DURATION_MS)),
        _ => panic!("this child must be invoked by its owning parent"),
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .unwrap();
    runtime.spawn(async move {
        // A current-thread runtime first polls block_on's production request,
        // scheduling its real blocking stdin read, before running this task.
        // Advance only the exchange budget, retaining the 100 ms output reserve.
        tokio::time::advance(budget - Duration::from_millis(100)).await;
        tokio::time::resume();
    });
    std::io::stdout().write_all(OUTPUT_START).unwrap();
    std::io::stdout().flush().unwrap();
    let status = super::run(runtime, streaming);
    std::process::exit(if status == ExitCode::SUCCESS { 0 } else { 1 });
}
