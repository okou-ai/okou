use super::*;

struct Release(Arc<Gate>);

impl Drop for Release {
    fn drop(&mut self) {
        self.0.release();
    }
}

fn checkpoint(gate: Arc<Gate>) -> PrefetchReadCheckpoint {
    Arc::new(move |bytes| {
        if bytes == MIB {
            gate.hold();
        }
        Ok(())
    })
}

fn accounting(fixture: &Fixture, readers: usize, growth: u64) {
    let value = fixture.operations.snapshot().unwrap();
    assert_eq!(value.registered_operations, readers);
    assert_eq!(value.started, readers);
    assert_eq!(value.ordinary_growth_bytes, readers as u64 * growth);
    assert_eq!((value.uncertain, value.cleanup_growth_bytes), (0, 0));
    if readers == 0 {
        assert_eq!(value.tracked_tasks, 0);
    } else {
        assert!(value.tracked_tasks >= readers);
    }
}

async fn settled(fixture: &Fixture, growth: u64) {
    // Physical drain precedes this wait. P2's callback tracking can drop just
    // after delivering its result; observe completion rather than sample that gap.
    tokio::time::timeout(WAIT, async {
        while fixture.operations.snapshot().unwrap().tracked_tasks != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    accounting(fixture, 0, growth);
}

#[tokio::test]
async fn concurrent_actual_reads_keep_independent_custody_after_one_cancelled_drain() {
    let fixture = Fixture::new(48).await;
    let bytes = vec![7; MEMORY_PREFETCH_CHUNK_BYTES + 17];
    let candidate = fixture.file("shared-snapshot", &bytes, 2).await;
    let path = candidate.path;
    let gates = [Arc::new(Gate::default()), Arc::new(Gate::default())];
    let _releases = gates.each_ref().map(|gate| Release(gate.clone()));
    let mut readers = Vec::new();
    for gate in &gates {
        let mut reader = MemoryPrefetchTasks::spawn_guarded_with_read_checkpoint_for_test(
            [MemoryPrefetchCandidate {
                path: path.clone(),
                memory_mb: 2,
            }],
            2,
            fixture.config(),
            checkpoint(gate.clone()),
        )
        .unwrap();
        gate.entered().await;
        report(&mut reader.1, |value| value.accepted == 1).await;
        readers.push(reader);
    }
    accounting(&fixture, 2, 3 * MIB);
    let mut first = readers.remove(0);
    let mut second = readers.remove(0);
    first.0.cancel();
    {
        let drain = first.0.drain();
        tokio::pin!(drain);
        assert!(futures_util::poll!(&mut drain).is_pending());
    }
    {
        let drain = first.0.drain();
        tokio::pin!(drain);
        assert!(futures_util::poll!(&mut drain).is_pending());
        accounting(&fixture, 2, 3 * MIB);
        assert!(!second.1.borrow().finished);
        gates[0].release();
        tokio::time::timeout(WAIT, drain).await.unwrap();
    }
    let cancelled = report(&mut first.1, |value| value.finished).await;
    assert_eq!((cancelled.cancelled, cancelled.read_bytes), (1, MIB));
    assert_eq!(
        (cancelled.completed, cancelled.failed, cancelled.uncertain),
        (0, 0, 0)
    );
    accounting(&fixture, 1, 3 * MIB);
    assert!(!second.1.borrow().finished);
    gates[1].release();
    tokio::time::timeout(WAIT, second.0.drain()).await.unwrap();
    let complete = report(&mut second.1, |value| value.finished).await;
    assert_eq!(
        (complete.completed, complete.read_bytes),
        (1, bytes.len() as u64)
    );
    assert_eq!(
        (complete.cancelled, complete.failed, complete.uncertain),
        (0, 0, 0)
    );
    settled(&fixture, 3 * MIB).await;
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    fixture.stop().await;
}

#[tokio::test]
async fn separate_selection_budgets_cannot_bypass_shared_read_headroom() {
    let fixture = Fixture::new(48).await;
    let bytes = vec![7; MEMORY_PREFETCH_CHUNK_BYTES + 17];
    let first = fixture.file("first", &bytes, 24).await;
    let second = fixture.file("second", &bytes, 24).await;
    let gate = Arc::new(Gate::default());
    let _release = Release(gate.clone());
    let (mut held, mut held_report) =
        MemoryPrefetchTasks::spawn_guarded_with_read_checkpoint_for_test(
            [first],
            24,
            fixture.config(),
            checkpoint(gate.clone()),
        )
        .unwrap();
    gate.entered().await;
    report(&mut held_report, |value| value.accepted == 1).await;
    let (mut waiting, mut latest) =
        MemoryPrefetchTasks::spawn_guarded([second], 24, fixture.config()).unwrap();
    let deferred = report(&mut latest, |value| value.deferred > 0).await;
    assert_eq!((deferred.accepted, deferred.read_bytes), (0, 0));
    assert!(
        deferred
            .last_error
            .unwrap()
            .contains("do not cover required")
    );
    waiting.cancel();
    tokio::time::timeout(WAIT, waiting.drain()).await.unwrap();
    accounting(&fixture, 1, 25 * MIB);
    gate.release();
    tokio::time::timeout(WAIT, held.drain()).await.unwrap();
    let complete = report(&mut held_report, |value| value.finished).await;
    assert_eq!(
        (complete.completed, complete.read_bytes, complete.uncertain),
        (1, bytes.len() as u64, 0)
    );
    settled(&fixture, 25 * MIB).await;
    fixture.stop().await;
}
