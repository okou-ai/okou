use std::sync::{Arc, mpsc};

use super::*;

const WATCHDOG: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(1);

fn wait_for_finished<T>(handle: &JoinHandle<T>) {
    let deadline = Instant::now() + WATCHDOG;
    while !handle.is_finished() {
        assert!(Instant::now() < deadline, "fixture worker must finish");
        thread::yield_now();
    }
}

#[test]
fn completed_thread_retains_its_value_after_deadline() {
    let handle = thread::spawn(|| vec![1, 2, 3]);
    wait_for_finished(&handle);

    let value = join_until(handle, Instant::now(), POLL_INTERVAL)
        .expect("completed thread must win over its deadline")
        .expect("worker should succeed");

    assert_eq!(value, vec![1, 2, 3]);
}

#[test]
fn completed_thread_retains_original_panic_payload() {
    let original = Arc::new(());
    let thread_payload = Arc::clone(&original);
    let handle: JoinHandle<()> = thread::spawn(move || std::panic::panic_any(thread_payload));
    wait_for_finished(&handle);

    let payload = join_until(handle, Instant::now(), POLL_INTERVAL)
        .expect("panicked thread is complete")
        .expect_err("original worker panic must remain observable");
    let returned = payload
        .downcast::<Arc<()>>()
        .expect("original payload type");

    assert!(Arc::ptr_eq(&original, &returned));
}

#[test]
fn blocked_thread_times_out_without_cancelling_worker() {
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        started_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        finished_tx.send(()).unwrap();
    });
    started_rx.recv_timeout(WATCHDOG).unwrap();

    let (observed_tx, observed_rx) = mpsc::channel();
    let observer = thread::spawn(move || {
        let result = join_until(
            handle,
            Instant::now() + Duration::from_millis(20),
            POLL_INTERVAL,
        );
        observed_tx.send(result).unwrap();
    });

    let observed = observed_rx.recv_timeout(WATCHDOG);
    release_tx.send(()).unwrap();
    finished_rx.recv_timeout(WATCHDOG).unwrap();
    if matches!(&observed, Err(mpsc::RecvTimeoutError::Timeout)) {
        let _ = observed_rx.recv_timeout(WATCHDOG).unwrap();
    }
    observer.join().unwrap();

    assert!(
        observed
            .expect("observer exceeded outer watchdog")
            .is_none()
    );
}
