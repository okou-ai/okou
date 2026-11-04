use super::*;
use crate::process::read_process_stat;
use std::time::Duration;

async fn process_identity(pid: u32) -> Option<(char, u64)> {
    read_process_stat(pid)
        .await
        .map(|stat| (stat.state, stat.starttime))
}

async fn wait_for_process_starttime(pid: u32) -> u64 {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some((_, starttime)) = process_identity(pid).await {
                return starttime;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for pid {pid} to appear"))
}

async fn wait_for_process_exit(pid: u32, starttime: u64) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match process_identity(pid).await {
                Some((_, observed_starttime)) if observed_starttime == starttime => {}
                _ => break,
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for pid {pid} to be reaped"));
}

async fn wait_for_process_state(pid: u32, starttime: u64, expected_state: char) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if process_identity(pid).await == Some((expected_state, starttime)) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for pid {pid} to enter state {expected_state}"));
}

#[tokio::test]
async fn drop_cleanup_kills_and_reaps_running_child() {
    let child = tokio::process::Command::new("sleep")
        .arg("60")
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    let starttime = wait_for_process_starttime(pid).await;
    let mut child = Some(child);

    kill_and_reap_child_on_drop("test-running-child", &mut child);

    assert!(child.is_none());
    wait_for_process_exit(pid, starttime).await;
}

#[tokio::test]
async fn drop_cleanup_reaps_already_exited_child() {
    let child = tokio::process::Command::new("true").spawn().unwrap();
    let pid = child.id().unwrap();
    let starttime = wait_for_process_starttime(pid).await;
    let mut child = Some(child);

    wait_for_process_state(pid, starttime, 'Z').await;
    kill_and_reap_child_on_drop("test-exited-child", &mut child);

    assert!(child.is_none());
    wait_for_process_exit(pid, starttime).await;
}

#[tokio::test]
async fn child_reaper_can_signal_before_awaiting_reap() {
    let child = tokio::process::Command::new("sleep")
        .arg("60")
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    let starttime = wait_for_process_starttime(pid).await;
    let mut reaper = ChildReaper::new("test-signaled-child", child);

    reaper.start_kill();
    reaper.start_kill();

    wait_for_process_state(pid, starttime, 'Z').await;
    reaper.reap().await.unwrap();
    wait_for_process_exit(pid, starttime).await;
}
