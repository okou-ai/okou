use super::*;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;

use crate::network_log_drain::{
    NetworkLogDrainContext, NetworkLogDrainOutcome, run_drainable_line_reader,
};
use crate::network_log_manager::{NetworkLogManager, NetworkLogSession};
use runner_host::process::read_process_stat;
use runner_types::ids::RunId;
use serde_json::{Value, json};
use tokio::sync::{Notify, Semaphore};
use tokio::task::AbortHandle;

const TEST_WAIT: Duration = Duration::from_secs(2);
const SOURCE_IP: &str = "10.200.0.2";

struct BlockedWriter {
    manager: NetworkLogManager,
    release: Arc<Semaphore>,
    monitor: AbortHandle,
    drain: NetworkLogDrainProducer,
    path: PathBuf,
    queued_rows: usize,
    _session: NetworkLogSession,
    _directory: tempfile::TempDir,
}

impl BlockedWriter {
    async fn start() -> (Self, NetworkLogProcess) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("network.jsonl");
        let started = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let manager = NetworkLogManager::new_with_write_gate(started.clone(), release.clone());
        let session = manager.register_source_ip(SOURCE_IP, path.clone()).await;
        assert!(
            manager
                .append_for_ip(SOURCE_IP, json!({"seed": true}))
                .await
        );
        tokio::time::timeout(TEST_WAIT, started.notified())
            .await
            .unwrap();

        // Fill the actual bounded queue while its writer owns the first batch.
        // Drop only the first unaccepted reservation, keeping accepted rows owned.
        let mut queued_rows = 1;
        loop {
            let append = manager.append_for_ip(SOURCE_IP, json!({"queued": queued_rows}));
            tokio::pin!(append);
            match futures_util::poll!(&mut append) {
                Poll::Ready(accepted) => {
                    assert!(accepted);
                    queued_rows += 1;
                    assert!(queued_rows < 4096, "writer queue should exert backpressure");
                }
                Poll::Pending => break,
            }
        }

        let mut child = tokio::process::Command::new("sh")
            .args(["-c", "printf 'pending\\n' >&2; exec sleep 60"])
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stderr = child.stderr.take().unwrap();
        let cancel = CancellationToken::new();
        let (drain, drain_rx) = NetworkLogDrainProducer::channel("blocked-monitor");
        let entered = Arc::new(Notify::new());
        let callback_entered = entered.clone();
        let callback_manager = manager.clone();
        let task = tokio::spawn(run_drainable_line_reader(
            tokio::io::BufReader::new(stderr),
            cancel.clone(),
            drain_rx,
            move |line| {
                let entered = callback_entered.clone();
                let manager = callback_manager.clone();
                async move {
                    entered.notify_one();
                    manager
                        .append_for_ip(SOURCE_IP, json!({"observed": line}))
                        .await;
                }
            },
        ));
        let monitor = task.abort_handle();
        let process = NetworkLogProcess::new("blocked-monitor", cancel, task, child, drain.clone());
        // The callback has no yield between this notification and its full-queue
        // reservation, so the monitor is pending in the real append boundary.
        tokio::time::timeout(TEST_WAIT, entered.notified())
            .await
            .unwrap();
        (
            Self {
                manager,
                release,
                monitor,
                drain,
                path,
                queued_rows,
                _session: session,
                _directory: directory,
            },
            process,
        )
    }

    async fn drain(&self) -> NetworkLogDrainOutcome {
        self.drain
            .drain(
                NetworkLogDrainContext {
                    run_id: RunId::new_v4(),
                    source_ip: SOURCE_IP,
                    path: &self.path,
                    generation: 0,
                },
                Duration::from_millis(250),
            )
            .await
    }

    fn release_writer(&self) {
        self.release.add_permits(4096);
    }

    async fn rows_after_monitor_exit(&self) -> Vec<Value> {
        wait_finished(&self.monitor).await;
        tokio::time::timeout(TEST_WAIT, self.manager.flush_path(&self.path))
            .await
            .unwrap();
        std::fs::read_to_string(&self.path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

async fn wait_finished(task: &AbortHandle) {
    tokio::time::timeout(TEST_WAIT, async {
        while !task.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("owned task must retire");
}

async fn finish_child_cleanup(process: &mut NetworkLogProcess) {
    let (pid, starttime) = match &process.child_custody {
        ChildCustody::Owned(child) => {
            let pid = child.id().unwrap();
            (pid, read_process_stat(pid).await.unwrap().starttime)
        }
        _ => panic!("fixture must still own its child"),
    };
    process.start_child_cleanup();
    let cleanup = match &process.child_custody {
        ChildCustody::Reaping(task) => task.abort_handle(),
        _ => panic!("cleanup must own physical child retirement"),
    };
    wait_finished(&cleanup).await;
    assert_ne!(
        read_process_stat(pid).await.map(|stat| stat.starttime),
        Some(starttime)
    );
}

#[tokio::test]
async fn cancelled_monitor_join_retires_reader_before_writer_release() {
    let (fixture, mut process) = BlockedWriter::start().await;
    finish_child_cleanup(&mut process).await;
    let mut stop = Box::pin(process.stop());
    assert!(
        futures_util::poll!(&mut stop).is_pending(),
        "stop must join the monitor blocked in writer admission"
    );
    drop(stop);

    let outcome = fixture.drain().await;
    fixture.release_writer();
    let rows = fixture.rows_after_monitor_exit().await;

    assert!(
        matches!(
            outcome,
            NetworkLogDrainOutcome::ProducerUnavailable | NetworkLogDrainOutcome::AckDropped
        ),
        "cancelled terminal wait must retire the reader before capacity returns: {outcome:?}"
    );
    assert_eq!(
        rows.len(),
        fixture.queued_rows,
        "accepted writes must still settle"
    );
    assert!(
        !rows.iter().any(|row| row.get("observed").is_some()),
        "a cancelled monitor must not admit its pending row later"
    );
}

#[tokio::test]
async fn ordinary_stop_preserves_pending_row_after_writer_release() {
    let (fixture, mut process) = BlockedWriter::start().await;
    finish_child_cleanup(&mut process).await;
    let mut stop = Box::pin(process.stop());
    assert!(futures_util::poll!(&mut stop).is_pending());

    fixture.release_writer();
    tokio::time::timeout(TEST_WAIT, stop)
        .await
        .unwrap()
        .unwrap();
    let rows = fixture.rows_after_monitor_exit().await;

    assert_eq!(rows.len(), fixture.queued_rows + 1);
    assert_eq!(rows.last().unwrap()["observed"], "pending");
}

#[tokio::test]
async fn cancelled_reactor_wait_keeps_reader_owned_and_drainable() {
    let (fixture, mut process) = BlockedWriter::start().await;
    {
        let wait = process.wait();
        tokio::pin!(wait);
        assert!(futures_util::poll!(&mut wait).is_pending());
    }

    fixture.release_writer();
    assert_eq!(fixture.drain().await, NetworkLogDrainOutcome::Acknowledged);
    tokio::time::timeout(TEST_WAIT, process.stop())
        .await
        .unwrap()
        .unwrap();
    let rows = fixture.rows_after_monitor_exit().await;
    assert_eq!(rows.len(), fixture.queued_rows + 1);
    assert_eq!(rows.last().unwrap()["observed"], "pending");
}

#[tokio::test]
async fn drop_reaps_owned_child() {
    let child = tokio::process::Command::new("sleep")
        .arg("60")
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    let starttime = read_process_stat(pid).await.unwrap().starttime;
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move {
        task_cancel.cancelled().await;
        DrainableLineReaderExit::Cancelled
    });
    let (drain, _drain_rx) = NetworkLogDrainProducer::channel("drop-test");
    let process = NetworkLogProcess::new("drop-test", cancel, task, child, drain);

    drop(process);

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let observed_starttime = read_process_stat(pid).await.map(|stat| stat.starttime);
            if observed_starttime != Some(starttime) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("dropped network-log process should reap its child");
}
