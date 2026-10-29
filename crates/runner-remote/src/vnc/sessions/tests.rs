use super::{Capacity, NativeWork};
use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Wake, Waker},
};
use tokio::sync::{Semaphore, oneshot};

struct Completion {
    permits: [Arc<Semaphore>; 3],
    available: AtomicUsize,
    wakes: AtomicUsize,
}

impl Wake for Completion {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.available.store(
            self.permits.iter().map(|s| s.available_permits()).sum(),
            Ordering::SeqCst,
        );
        self.wakes.fetch_add(1, Ordering::SeqCst);
    }
}

#[test]
fn native_work_completion_follows_last_owner_and_physical_permit_release() {
    let permits = std::array::from_fn(|_| Arc::new(Semaphore::new(1)));
    let completed = Arc::new(Completion {
        permits,
        available: AtomicUsize::new(0),
        wakes: AtomicUsize::new(0),
    });
    let (completion, done) = oneshot::channel();
    let root = tempfile::tempdir().unwrap();
    let path = root.path().to_owned();
    let work = Arc::new(NativeWork {
        root: Some(root),
        _capacity: Arc::new(Capacity {
            _host: Arc::clone(&completed.permits[0])
                .try_acquire_owned()
                .unwrap(),
            _run: Arc::clone(&completed.permits[1])
                .try_acquire_owned()
                .unwrap(),
        }),
        _operation: Arc::new(
            Arc::clone(&completed.permits[2])
                .try_acquire_owned()
                .unwrap(),
        ),
        completion: Some(completion),
    });
    let native_owner = Arc::clone(&work);
    let waker = Waker::from(Arc::clone(&completed));
    let mut context = Context::from_waker(&waker);
    let mut done = std::pin::pin!(done);
    assert!(done.as_mut().poll(&mut context).is_pending());
    drop(work);
    assert!(path.exists());
    assert_eq!(completed.wakes.load(Ordering::SeqCst), 0);
    assert!(completed.permits.iter().all(|s| s.available_permits() == 0));

    // The receiver may run on another thread as soon as its waker is called.
    // Inspect release at notification, not merely after Drop returns.
    drop(native_owner);
    assert!(completed.wakes.load(Ordering::SeqCst) > 0);
    assert_eq!(completed.available.load(Ordering::SeqCst), 3);
    assert!(!path.exists());
    assert!(done.as_mut().poll(&mut context).is_ready());
}
