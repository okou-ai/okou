use runner_lifecycle::prefetch::{
    GuardedPrefetchConfig, MemoryPrefetchCandidate, MemoryPrefetchTasks,
};

use super::*;

#[derive(Default)]
struct ReadGate {
    entered: Notify,
    released: std::sync::Mutex<bool>,
    changed: std::sync::Condvar,
}

impl ReadGate {
    fn hold(&self) {
        let mut released = self.released.lock().unwrap();
        self.entered.notify_one();
        while !*released {
            released = self.changed.wait(released).unwrap();
        }
    }

    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.changed.notify_all();
    }
}

struct Releases {
    reads: [Arc<ReadGate>; 2],
    observation: Option<Arc<Notify>>,
}

impl Drop for Releases {
    fn drop(&mut self) {
        for gate in &self.reads {
            gate.release();
        }
        if let Some(observation) = &self.observation {
            observation.notify_one();
        }
    }
}

fn accounting(fixture: &BatchFixture, count: usize) {
    let state = fixture.operations.snapshot().unwrap();
    assert_eq!(state.registered_operations, count);
    assert_eq!(state.started, count);
    assert_eq!(state.ordinary_growth_bytes, count as u64 * 3 * MIB);
    assert_eq!((state.uncertain, state.cleanup_growth_bytes), (0, 0));
    assert!(state.tracked_tasks >= count);
}

#[tokio::test]
async fn joined_pressure_shutdown_keeps_independent_accepted_file_readers_owned() {
    let mut fixture = fixture(64).await;
    let source = held_reader(&mut fixture);
    let owner = IdlePressureOwner::spawn(config(&fixture, 1)).unwrap();
    let control = owner.optional_preparation();
    let mut updates = owner.subscribe();
    snapshot(&mut updates, |state| state.decision.optional_start_ready).await;
    let path = fixture
        .meminfo
        .with_file_name("accepted-pressure-stop-snapshot");
    let bytes = vec![7; MIB as usize + 17];
    tokio::fs::write(&path, &bytes).await.unwrap();
    let gates = [Arc::new(ReadGate::default()), Arc::new(ReadGate::default())];
    let mut readers = Vec::new();
    // Arm unwind-safe read releases before starting any blocking producer.
    let mut releases = Releases {
        reads: gates.clone(),
        observation: None,
    };
    for gate in &gates {
        let held = gate.clone();
        let reader = MemoryPrefetchTasks::spawn_guarded_with_read_checkpoint_for_test(
            [MemoryPrefetchCandidate {
                path: path.clone(),
                memory_mb: 2,
            }],
            2,
            GuardedPrefetchConfig {
                pressure: control.clone(),
                overhead_bytes: MIB,
            },
            Arc::new(move |bytes| {
                if bytes == MIB {
                    held.hold();
                }
                Ok(())
            }),
        )
        .unwrap();
        tokio::time::timeout(WAIT, gate.entered.notified())
            .await
            .unwrap();
        readers.push(reader);
    }
    accounting(&fixture, 2);
    let (entered, release) = source.gate_next();
    releases.observation = Some(release.clone());
    tokio::time::timeout(WAIT, entered.notified())
        .await
        .unwrap();
    let stopping = owner.shutdown();
    tokio::pin!(stopping);
    assert!(futures_util::poll!(stopping.as_mut()).is_pending());
    snapshot(&mut updates, |state| state.stopped).await;
    assert!(matches!(
        control.take_optional_start(),
        Err(MemoryOperationError::Closed)
    ));
    let (mut refused, latest) = MemoryPrefetchTasks::spawn_guarded(
        [MemoryPrefetchCandidate {
            path: path.clone(),
            memory_mb: 2,
        }],
        2,
        GuardedPrefetchConfig {
            pressure: control.clone(),
            overhead_bytes: MIB,
        },
    )
    .unwrap();
    tokio::time::timeout(WAIT, refused.drain()).await.unwrap();
    assert_eq!(
        (latest.borrow().accepted, latest.borrow().read_bytes),
        (0, 0)
    );
    for (reader, _) in &mut readers {
        for _ in 0..2 {
            let drain = reader.drain();
            tokio::pin!(drain);
            assert!(futures_util::poll!(&mut drain).is_pending());
        }
    }
    assert_eq!(tokio::fs::read(&path).await.unwrap(), bytes);
    assert!(futures_util::poll!(stopping.as_mut()).is_pending());
    accounting(&fixture, 2);
    release.notify_one();
    let stopped = tokio::time::timeout(WAIT, stopping).await.unwrap().unwrap();
    assert!(stopped.stopped && !stopped.producer_lost && !stopped.decision.wave_inflight);
    accounting(&fixture, 2);
    assert!(matches!(
        control.take_optional_start(),
        Err(MemoryOperationError::Closed)
    ));
    for (index, (reader, latest)) in readers.iter_mut().enumerate() {
        gates[index].release();
        tokio::time::timeout(WAIT, reader.drain()).await.unwrap();
        let result = latest.borrow();
        assert_eq!(
            (
                result.completed,
                result.cancelled,
                result.failed,
                result.uncertain,
                result.read_bytes
            ),
            (0, 1, 0, 0, MIB)
        );
        assert!(result.finished);
        accounting(&fixture, 1 - index);
    }
    assert_eq!(tokio::fs::read(path).await.unwrap(), bytes);
    fixture.tracker.close_and_wait().await;
    let settled = fixture.operations.close_and_wait().await.unwrap();
    assert_eq!(
        (
            settled.registered_operations,
            settled.tracked_tasks,
            settled.uncertain
        ),
        (0, 0, 0)
    );
}
