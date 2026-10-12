use async_trait::async_trait;
use sandbox::{BackingProcessIdentity, SandboxBackingProcess};
use sandbox_mock::MockBackingProcess;

use super::*;

/// External receipt destruction needs the caller's aggregate read interface.
/// A last-provider-payload Drop under accounting would deadlock this boundary.
struct ReentrantReceipt {
    identity: BackingProcessIdentity,
    operations: HostMemoryOperations,
    dropped: Option<oneshot::Sender<super::super::MemoryOperationSnapshot>>,
}

#[async_trait]
impl SandboxBackingProcess for ReentrantReceipt {
    fn identity(&self) -> BackingProcessIdentity {
        self.identity
    }
    async fn exit_confirmed(&self) -> bool {
        false
    }
}

impl Drop for ReentrantReceipt {
    fn drop(&mut self) {
        let snapshot = self.operations.snapshot().unwrap();
        self.dropped.take().unwrap().send(snapshot).unwrap();
    }
}

fn receipt(
    operations: &HostMemoryOperations,
) -> (
    Arc<dyn SandboxBackingProcess>,
    oneshot::Receiver<super::super::MemoryOperationSnapshot>,
) {
    let (dropped, observed) = oneshot::channel();
    (
        Arc::new(ReentrantReceipt {
            identity: BackingProcessIdentity::new_generation(),
            operations: operations.clone(),
            dropped: Some(dropped),
        }),
        observed,
    )
}

#[tokio::test]
async fn unused_release_rejection_and_rebind_drop_provider_payloads_outside_accounting() {
    let env = Env::new(64).await;
    let (backing, observed) = receipt(&env.operations);
    let request = env
        .operations
        .request(Plan::Retire {
            growth_bytes: MIB,
            backing,
        })
        .unwrap();
    let worker = std::thread::spawn(move || drop(request));
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), observed)
            .await
            .unwrap()
            .unwrap()
            .registered_operations,
        0
    );
    worker.join().unwrap();

    let (backing, observed) = receipt(&env.operations);
    let mut permit = grant(
        &env.operations,
        Plan::Retire {
            growth_bytes: MIB,
            backing,
        },
    )
    .await;
    let (_, replacement) = MockBackingProcess::channel();
    permit
        .rebind(Plan::Retire {
            growth_bytes: MIB,
            backing: replacement,
        })
        .await
        .unwrap();
    assert_eq!(observed.await.unwrap().registered_operations, 1);
    drop(permit);

    let env = Env::with_policy(
        64,
        MemoryOperationPolicy {
            max_operations: 1,
            max_cleanup_inflight: 1,
            ..policy()
        },
    )
    .await;
    let held = env.operations.request(fresh(1)).unwrap();
    let (backing, observed) = receipt(&env.operations);
    assert!(matches!(
        env.operations.request(Plan::Retire {
            growth_bytes: MIB,
            backing
        }),
        Err(Error::OperationLimit)
    ));
    assert_eq!(observed.await.unwrap().registered_operations, 1);
    drop(held);
}

#[tokio::test]
async fn settled_phase_tails_cannot_bypass_the_bound_on_required_work_owners() {
    let env = Env::with_policy(
        14,
        MemoryOperationPolicy {
            max_operations: 1,
            max_cleanup_inflight: 1,
            ..policy()
        },
    )
    .await;
    let permit = grant(&env.operations, Plan::HostIo { growth_bytes: MIB }).await;
    let staged = env.dir.path().join("required-staged");
    let published = env.dir.path().join("required-published");
    let (settled, observed) = oneshot::channel();
    let (publish, publishing) = oneshot::channel();
    let task = permit
        .spawn(move |mut operation| async move {
            tokio::fs::write(&staged, b"required data retained")
                .await
                .unwrap();
            complete(&mut operation).await;
            settled.send(()).unwrap();
            publishing.await.unwrap();
            tokio::fs::rename(staged, published).await.unwrap();
        })
        .unwrap();
    observed.await.unwrap();
    let additional = grant(&env.operations, Plan::HostIo { growth_bytes: MIB }).await;
    let unexpected = env.dir.path().join("must-not-start");
    assert_eq!(
        additional
            .spawn(move |_operation| async move {
                std::fs::write(unexpected, b"unbounded work").unwrap();
            })
            .err()
            .unwrap(),
        Error::TaskLimit
    );
    assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
    let shutdown = pending_shutdown(env.operations.clone()).await;
    publish.send(()).unwrap();
    task.join().await.unwrap();
    let report = shutdown.await.unwrap().unwrap();
    assert_eq!(report.tracked_tasks, 0);
    assert_eq!(
        tokio::fs::read(env.dir.path().join("required-published"))
            .await
            .unwrap(),
        b"required data retained"
    );
    assert!(!env.dir.path().join("must-not-start").exists());
}

#[tokio::test]
async fn stopped_runtime_rejection_never_drops_a_started_guard_under_accounting() {
    let env = Env::new(14).await;
    let permit = grant(&env.operations, fresh(8)).await;
    let path = env.dir.path().join("must-not-start");
    let (spawned, observed) = oneshot::channel();
    let worker = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let handle = runtime.handle().clone();
        runtime.shutdown_background();
        let _entered = handle.enter();
        let task = permit
            .spawn(move |_operation| async move {
                std::fs::write(path, b"unexpected work").unwrap();
            })
            .unwrap();
        spawned
            .send(task)
            .unwrap_or_else(|_| panic!("observer lost"));
    });
    let task = tokio::time::timeout(Duration::from_secs(5), observed)
        .await
        .unwrap()
        .unwrap();
    worker.join().unwrap();
    assert_eq!(task.join().await.err().unwrap(), Error::ProducerLost);
    let report = env.operations.close_and_wait().await.unwrap();
    assert_eq!(report.uncertain, 1);
    assert_eq!(report.tracked_tasks, 0);
    assert_eq!(report.ordinary_growth_bytes, 8 * MIB);
    assert!(!env.dir.path().join("must-not-start").exists());
}
