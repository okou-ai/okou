use std::fs;
use std::future::{Future, pending, poll_fn};
use std::io;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::Ordering;
use std::task::Poll;
use std::time::Duration;

use super::{ControlTicker, TestResult, sample};
use crate::cgroup_usage_usec;

// Process exit includes ordinary Tokio runtime destruction, where a leaked
// blocking task would hang after the async test body has already returned.
async fn in_child(test_name: &str) -> TestResult<bool> {
    const CHILD_TEST: &str = "OKOU_HOST_CPU_MEASUREMENT_CHILD_TEST";
    if std::env::var(CHILD_TEST).as_deref() == Ok(test_name) {
        return Ok(true);
    }
    let mut child = tokio::process::Command::new(std::env::current_exe()?)
        .args(["--exact", test_name, "--nocapture"])
        .env(CHILD_TEST, test_name)
        .kill_on_drop(true)
        .spawn()?;
    match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(status) => {
            if !status?.success() {
                return Err(io::Error::other(format!("child test failed: {test_name}")).into());
            }
        }
        Err(_) => {
            child.kill().await?;
            child.wait().await?;
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("measurement or runtime shutdown hung: {test_name}"),
            )
            .into());
        }
    }
    Ok(false)
}

#[tokio::test]
async fn second_read_error_stops_ticker_and_runtime() -> TestResult<()> {
    if !in_child("measurement::tests::second_read_error_stops_ticker_and_runtime").await? {
        return Ok(());
    }
    let fixture = tempfile::tempdir()?;
    let stat = fixture.path().join("cpu.stat");
    fs::write(&stat, "usage_usec 100\n")?;
    let result = sample(
        || {
            let usage = cgroup_usage_usec(fixture.path())?;
            // Remove the real file only after the first successful sample.
            fs::remove_file(&stat)?;
            Ok(vec![usage])
        },
        Duration::from_millis(10),
    )
    .await;
    let error = result.unwrap_err();
    let error = error.downcast_ref::<io::Error>().unwrap();
    assert_eq!(error.kind(), io::ErrorKind::NotFound);
    assert_eq!(error.raw_os_error(), Some(libc::ENOENT));
    Ok(())
}

#[tokio::test]
async fn successful_sample_stops_ticker_and_runtime() -> TestResult<()> {
    if !in_child("measurement::tests::successful_sample_stops_ticker_and_runtime").await? {
        return Ok(());
    }
    let fixture = tempfile::tempdir()?;
    let stat = fixture.path().join("cpu.stat");
    fs::write(&stat, "usage_usec 100\n")?;
    let measurement = sample(
        || {
            let usage = cgroup_usage_usec(fixture.path())?;
            fs::write(&stat, "usage_usec 400\n")?;
            Ok(vec![usage])
        },
        Duration::from_millis(10),
    )
    .await?;
    assert_eq!(measurement.usage, vec![300]);
    Ok(())
}

#[tokio::test]
async fn cancelling_ticker_owner_stops_ticker_and_runtime() -> TestResult<()> {
    if !in_child("measurement::tests::cancelling_ticker_owner_stops_ticker_and_runtime").await? {
        return Ok(());
    }
    let ticker = ControlTicker::start();
    while ticker.ticks.load(Ordering::Relaxed) == 0 {
        tokio::task::yield_now().await;
    }
    let mut owner = Box::pin(async move {
        let _ticker = ticker;
        pending::<()>().await;
    });
    poll_fn(|cx| {
        assert!(owner.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    drop(owner);
    Ok(())
}

#[tokio::test]
async fn unwinding_ticker_owner_stops_ticker_and_runtime() -> TestResult<()> {
    if !in_child("measurement::tests::unwinding_ticker_owner_stops_ticker_and_runtime").await? {
        return Ok(());
    }
    let ticker = ControlTicker::start();
    while ticker.ticks.load(Ordering::Relaxed) == 0 {
        tokio::task::yield_now().await;
    }
    let result = catch_unwind(AssertUnwindSafe(move || {
        let _ticker = ticker;
        panic!("injected ticker owner panic");
    }));
    assert!(result.is_err());
    Ok(())
}
