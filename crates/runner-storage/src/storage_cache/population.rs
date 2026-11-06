use super::*;

/// Both futures stay borrowed by the population call. An error cancels the
/// sibling but never drops an accepted Guest write or atomic publication.
pub(super) async fn prepare_mixed(
    delivery: &mut FreshArchiveDelivery,
    home: &HomePaths,
    groups: Vec<CacheTargetGroup>,
    concurrency: usize,
    stage: &mut GuestStageRecorder<'_>,
) -> RunnerResult<(
    Vec<FreshArchiveResolved>,
    Vec<(CacheTargetGroup, TargetOutcome)>,
)> {
    let cancel_ordinary = CancellationToken::new();
    let cancel_fresh = delivery.cancel.clone();
    let mut metrics = CacheProcessMetrics::default();
    let result = {
        let fresh = delivery.resolve_inner(home, &mut metrics);
        let ordinary = prepare_ordinary(groups, home, concurrency, Some(&cancel_ordinary), stage);
        tokio::pin!(fresh, ordinary);
        tokio::select! {
            resolved = &mut fresh => match resolved {
                Ok(resolved) => ordinary.await.map(|ordinary| (resolved, ordinary)),
                Err(error) => {
                    cancel_fresh.cancel();
                    cancel_ordinary.cancel();
                    let _ = ordinary.await;
                    Err(error)
                }
            },
            prepared = &mut ordinary => match prepared {
                Ok(prepared) => fresh.await.map(|resolved| (resolved, prepared)),
                Err(error) => {
                    cancel_fresh.cancel();
                    let _ = fresh.await;
                    Err(error)
                }
            },
        }
    };
    metrics.record_to(stage.telemetry);
    delivery.phase_records.record_to(stage.telemetry);
    result
}

pub(super) async fn prepare_ordinary(
    targets: Vec<CacheTargetGroup>,
    home: &HomePaths,
    concurrency: usize,
    cancel: Option<&CancellationToken>,
    stage: &mut GuestStageRecorder<'_>,
) -> RunnerResult<Vec<(CacheTargetGroup, TargetOutcome)>> {
    let mut groups = JoinSet::new();
    let mut outcomes = Vec::new();
    let mut batch = GuestStageBatch::default();
    let result = async {
        for group in targets {
            check_cancel(cancel)?;
            while groups.len() >= concurrency {
                let Some(task) = next_group(&mut groups, cancel).await? else {
                    break;
                };
                stage_joined_processed_group(&mut groups, task, &mut outcomes, &mut batch, stage)
                    .await?;
                check_cancel(cancel)?;
            }
            let home = home.clone();
            groups.spawn(async move {
                let mut metrics = CacheProcessMetrics::default();
                let started = Instant::now();
                let processed = process_group_hit_or_passthrough(&group, &home, &mut metrics).await;
                let success = processed.is_ok();
                metrics.record(
                    STORAGE_CACHE_PROCESS_GROUP,
                    started.elapsed(),
                    success,
                    (!success).then_some(STORAGE_CACHE_PROCESS_GROUP_FAILED),
                );
                ProcessedGroupTask {
                    group,
                    metrics,
                    processed,
                }
            });
        }
        while let Some(task) = next_group(&mut groups, cancel).await? {
            stage_joined_processed_group(&mut groups, task, &mut outcomes, &mut batch, stage)
                .await?;
        }
        check_cancel(cancel)?;
        // A ready partial batch belongs to this owner, not the cold response.
        flush_guest_stage_batch(&mut batch, stage).await?;
        Ok(outcomes)
    }
    .await;
    abort_pending_processed_groups(&mut groups).await;
    result
}

fn check_cancel(cancel: Option<&CancellationToken>) -> RunnerResult<()> {
    if cancel.is_some_and(CancellationToken::is_cancelled) {
        Err(RunnerError::Cancelled)
    } else {
        Ok(())
    }
}

async fn next_group(
    groups: &mut JoinSet<ProcessedGroupTaskResult>,
    cancel: Option<&CancellationToken>,
) -> RunnerResult<Option<ProcessedGroupTaskResult>> {
    let Some(cancel) = cancel else {
        return join_next_processed_group(groups).await;
    };
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(RunnerError::Cancelled),
        next = join_next_processed_group(groups) => next,
    }
}
