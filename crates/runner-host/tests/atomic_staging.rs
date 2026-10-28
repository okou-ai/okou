#![cfg(unix)]

use std::future::Future;
use std::io;
use std::path::Path;
use std::pin::Pin;
use std::sync::mpsc;
use std::time::Duration;

use futures_util::poll;
use tokio::runtime::Runtime;
use tokio::task::JoinHandle;

const DEADLINE: Duration = Duration::from_secs(10);
type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;
type WorkerGate = (mpsc::Sender<()>, mpsc::Receiver<()>, JoinHandle<TestResult>);

fn runtime() -> io::Result<Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
}

fn block_worker(runtime: &Runtime) -> WorkerGate {
    let (started, observed) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let task = runtime.spawn_blocking(move || -> TestResult {
        started.send(())?;
        released.recv_timeout(DEADLINE)?;
        Ok(())
    });
    (release, observed, task)
}

fn poll_pending<F: Future>(runtime: &Runtime, write: Pin<&mut F>) {
    runtime.block_on(async {
        assert!(poll!(write).is_pending());
    });
}

fn finish_accepted_work(runtime: &Runtime, worker: JoinHandle<TestResult>) -> TestResult {
    runtime.block_on(async {
        worker.await??;
        // With one worker, this completes after the earlier accepted file I/O
        // and disposal of any result whose observer has disappeared.
        tokio::task::spawn_blocking(|| {}).await?;
        Ok(())
    })
}

fn assert_original_target_only(root: &Path, path: &Path) -> TestResult {
    assert_eq!(std::fs::read(path)?, b"original target");
    let entries = std::fs::read_dir(root)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<io::Result<Vec<_>>>()?;
    assert_eq!(entries, [path.to_path_buf()], "residual files: {entries:?}");
    Ok(())
}

#[test]
fn cancelled_queued_state_open_retires_its_staging_file() -> TestResult {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("state.json");
    std::fs::write(&path, b"original target")?;
    let runtime = runtime()?;
    let (release, started, worker) = block_worker(&runtime);
    started.recv_timeout(DEADLINE)?;

    let mut write = Box::pin(runner_host::state_file::write_private_atomic(
        &path,
        b"replacement",
    ));
    poll_pending(&runtime, write.as_mut());
    drop(write);
    release.send(())?;
    finish_accepted_work(&runtime, worker)?;

    assert_original_target_only(dir.path(), &path)
}

#[test]
fn cancelled_queued_private_write_retires_its_staging_file() -> TestResult {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("private.json");
    std::fs::write(&path, b"original target")?;
    let runtime = runtime()?;
    let (release_open, open_started, open_worker) = block_worker(&runtime);
    open_started.recv_timeout(DEADLINE)?;

    let mut write = Box::pin(runner_host::private_fs::write_private_file(
        &path,
        b"replacement",
    ));
    poll_pending(&runtime, write.as_mut());

    // Queue this gate after the physical open, before releasing the first
    // worker. Once it starts, the open result is ready but write I/O must queue.
    let (release_write, write_started, write_worker) = block_worker(&runtime);
    release_open.send(())?;
    write_started.recv_timeout(DEADLINE)?;
    runtime.block_on(open_worker)??;
    poll_pending(&runtime, write.as_mut());
    drop(write);
    release_write.send(())?;
    finish_accepted_work(&runtime, write_worker)?;

    assert_original_target_only(dir.path(), &path)
}
