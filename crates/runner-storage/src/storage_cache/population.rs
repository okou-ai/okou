use super::*;
use std::future::Future;

pub(super) struct EarlyApplication<'a> {
    pub(super) application: &'a mut GuestApplication,
    pub(super) plan: &'a StoragePlan,
    pub(super) owned_groups: &'a [CacheTargetGroup],
    pub(super) decoded_outcomes: &'a [(CacheTargetGroup, TargetOutcome)],
}

pub(super) struct MixedPreparation {
    pub(super) fresh: Vec<(CacheTargetGroup, TargetOutcome)>,
    pub(super) ordinary: Vec<(CacheTargetGroup, TargetOutcome)>,
}

enum OrdinaryPreparation {
    Staged(Vec<(CacheTargetGroup, TargetOutcome)>),
    Unread {
        groups: Vec<CacheTargetGroup>,
        absent: bool,
    },
}

/// Both futures stay borrowed by the population call. An error cancels the
/// sibling but never drops an accepted Guest write or atomic publication.
pub(super) async fn prepare_mixed(
    delivery: &mut FreshArchiveDelivery,
    home: &HomePaths,
    groups: Vec<CacheTargetGroup>,
    concurrency: usize,
    stage: &mut GuestStageRecorder<'_>,
    early: Option<EarlyApplication<'_>>,
) -> RunnerResult<MixedPreparation> {
    let cancel_ordinary = CancellationToken::new();
    let cancel_fresh = delivery.cancel.clone();
    let mut metrics = CacheProcessMetrics::default();
    let result = {
        let mut ready = Vec::new();
        let mut complete = false;
        let mut early = early;
        let mut warm_archives = PendingGuestArchives::default();
        async {
            let ordinary = async {
                if concurrency > 0 {
                    let retain_warm = early
                        .as_ref()
                        .is_some_and(|early| early.application.can_retain_warm_archives());
                    return prepare_ordinary(
                        groups,
                        home,
                        concurrency,
                        Some(&cancel_ordinary),
                        stage,
                        retain_warm.then_some(&mut warm_archives),
                    )
                    .await
                    .map(OrdinaryPreparation::Staged);
                }

                // All body slots are claimed. Only inspect metadata until
                // the existing owners have staged their archive bodies.
                let absent = ordinary_cache_absent(&groups, home, &cancel_ordinary).await;
                Ok(OrdinaryPreparation::Unread { groups, absent })
            };
            let ordinary = collect_during(
                delivery,
                home,
                &mut metrics,
                &mut ready,
                &mut complete,
                &cancel_ordinary,
                ordinary,
            )
            .await?;
            collect_ready(delivery, home, &mut metrics, &mut ready, &mut complete).await?;
            if matches!(&ordinary, OrdinaryPreparation::Unread { .. })
                && !complete
                && ready.is_empty()
            {
                if let Some(archive) = delivery.next_resolved(home, &mut metrics).await? {
                    ready.push(archive);
                } else {
                    complete = true;
                }
                collect_ready(delivery, home, &mut metrics, &mut ready, &mut complete).await?;
            }
            let mut fresh = Vec::new();
            // Split staging only after observing a slow origin response.
            // Near-simultaneous fast bodies benefit from complete batching.
            let ordinary = match ordinary {
                OrdinaryPreparation::Unread {
                    groups,
                    absent: false,
                } if !ready.is_empty()
                    && !delivery.fetches.is_empty()
                    && delivery.phase_records.has_slow_header_response() =>
                {
                    // A staged body releases its permit. Give those slots to
                    // ordinary readers while the remaining fresh fetches run.
                    let concurrency = ready.len();
                    check_cancel(Some(&cancel_fresh))?;
                    fresh = stage_fresh_archives(std::mem::take(&mut ready), stage).await?;
                    let outcomes = collect_during(
                        delivery,
                        home,
                        &mut metrics,
                        &mut ready,
                        &mut complete,
                        &cancel_fresh,
                        prepare_ordinary(
                            groups,
                            home,
                            concurrency,
                            Some(&cancel_fresh),
                            stage,
                            None,
                        ),
                    )
                    .await?;
                    collect_ready(delivery, home, &mut metrics, &mut ready, &mut complete).await?;
                    OrdinaryPreparation::Staged(outcomes)
                }
                ordinary => ordinary,
            };
            // A saturated delivery uses direct URLs only while there is still
            // a fetch after the first publication. Draining completed bodies
            // avoids an eligibility RPC and extra stage writes for fast origins.
            let early_ordinary = match &ordinary {
                OrdinaryPreparation::Staged(outcomes)
                    if fresh.is_empty() || !delivery.fetches.is_empty() =>
                {
                    Some(outcomes.as_slice())
                }
                OrdinaryPreparation::Unread { absent: true, .. }
                    if !delivery.fetches.is_empty() =>
                {
                    Some(&[][..])
                }
                _ => None,
            };
            let incremental = if !complete
                && let Some(early) = early.as_mut()
                && let Some(outcomes) = early_ordinary
            {
                early
                    .application
                    .start_if_useful(
                        stage,
                        early.plan,
                        early.owned_groups,
                        early.decoded_outcomes,
                        outcomes,
                        &mut warm_archives,
                    )
                    .await?
            } else {
                false
            };
            if !warm_archives.is_empty() {
                check_cancel(Some(&cancel_fresh))?;
                flush_guest_stage_batch(&mut warm_archives.batch, stage).await?;
            }
            if incremental
                && !fresh.is_empty()
                && let Some(early) = early.as_mut()
            {
                check_cancel(Some(&cancel_fresh))?;
                early
                    .application
                    .publish_staged(stage.sandbox, &fresh)
                    .await?;
            }
            // Batch the remaining fresh archives when Guest apply has not
            // started, including when Guest rejects the early plan.
            if !complete && !incremental {
                ready.extend(delivery.resolve_inner(home, &mut metrics).await?);
                complete = true;
            }
            loop {
                collect_ready(delivery, home, &mut metrics, &mut ready, &mut complete).await?;
                // When only atomic cache publications remain, collect them as
                // one batch instead of adding RPCs for ready/tiny downloads.
                if !complete && delivery.fetches.is_empty() {
                    while let Some(archive) = delivery.next_resolved(home, &mut metrics).await? {
                        ready.push(archive);
                    }
                    complete = true;
                }
                check_cancel(Some(&cancel_fresh))?;
                if !ready.is_empty() {
                    if complete
                        && !incremental
                        && fresh.is_empty()
                        && matches!(&ordinary, OrdinaryPreparation::Staged(_))
                        && let Some(early) = early.as_mut()
                        && let Some(outcome) = early
                            .application
                            .retain_small_fresh_artifact(&mut ready, stage.metrics)
                    {
                        fresh.push(outcome);
                    } else {
                        let staged =
                            stage_fresh_archives(std::mem::take(&mut ready), stage).await?;
                        // An accepted staging write settles before cancellation
                        // stops admission of a new readiness publication.
                        check_cancel(Some(&cancel_fresh))?;
                        if let Some(early) = early.as_mut() {
                            early
                                .application
                                .publish_staged(stage.sandbox, &staged)
                                .await?;
                        }
                        fresh.extend(staged);
                    }
                }
                if complete {
                    let ordinary = match ordinary {
                        OrdinaryPreparation::Staged(outcomes) => outcomes,
                        OrdinaryPreparation::Unread { groups, .. } if incremental => groups
                            .into_iter()
                            .map(|group| {
                                (group, TargetOutcome::MissPassthrough { reason: "missing" })
                            })
                            .collect(),
                        OrdinaryPreparation::Unread { groups, .. } => {
                            prepare_ordinary(
                                groups,
                                home,
                                CONCURRENCY,
                                Some(&cancel_fresh),
                                stage,
                                None,
                            )
                            .await?
                        }
                    };
                    return Ok(MixedPreparation { fresh, ordinary });
                }
                match delivery.next_resolved(home, &mut metrics).await? {
                    Some(archive) => ready.push(archive),
                    None => complete = true,
                }
            }
        }
        .await
    };
    if result.is_err() {
        cancel_fresh.cancel();
    }
    metrics.record_to(stage.telemetry);
    delivery.record_phases(stage.telemetry);
    result
}

/// Check for untouched cache slots without acquiring or creating locks. A
/// cache entry, lock, or metadata error leaves the ordinary reader in charge.
async fn ordinary_cache_absent(
    groups: &[CacheTargetGroup],
    home: &HomePaths,
    cancel: &CancellationToken,
) -> bool {
    let paths = groups
        .iter()
        .map(|group| {
            let target = &group.representative;
            let archive = home
                .storage_cache_dir(&target.name, &target.version)
                .join("archive.tar.gz");
            let lock = home.storage_lock(&target.name, &target.version);
            (archive, lock)
        })
        .collect::<Vec<_>>();
    let absent =
        futures_util::stream::iter(paths)
            .map(|(archive, lock)| async move {
                path_missing(&archive).await && path_missing(&lock).await
            })
            .buffer_unordered(CONCURRENCY)
            .all(std::future::ready);
    tokio::select! {
        biased;
        () = cancel.cancelled() => false,
        absent = absent => absent,
    }
}

async fn path_missing(path: &Path) -> bool {
    matches!(
        fs::symlink_metadata(path).await,
        Err(error) if error.kind() == io::ErrorKind::NotFound
    )
}

/// Poll fresh results while the ordinary owner works. On a fresh error, stop
/// both owners and settle any accepted ordinary write before returning.
async fn collect_during<T>(
    delivery: &mut FreshArchiveDelivery,
    home: &HomePaths,
    metrics: &mut CacheProcessMetrics,
    ready: &mut Vec<FreshArchiveResolved>,
    complete: &mut bool,
    cancel_ordinary: &CancellationToken,
    ordinary: impl Future<Output = RunnerResult<T>>,
) -> RunnerResult<T> {
    tokio::pin!(ordinary);
    loop {
        tokio::select! {
            prepared = &mut ordinary => return prepared,
            resolved = delivery.next_resolved(home, metrics), if !*complete => {
                match resolved {
                    Ok(Some(archive)) => ready.push(archive),
                    Ok(None) => *complete = true,
                    Err(error) => {
                        delivery.cancel.cancel();
                        cancel_ordinary.cancel();
                        let _ = ordinary.await;
                        return Err(error);
                    }
                }
            }
        }
    }
}

/// Poll only immediately available progress. Bodies/publications remain in the
/// delivery owner across Pending; at most the existing four admissions collect.
async fn collect_ready(
    delivery: &mut FreshArchiveDelivery,
    home: &HomePaths,
    metrics: &mut CacheProcessMetrics,
    ready: &mut Vec<FreshArchiveResolved>,
    complete: &mut bool,
) -> RunnerResult<()> {
    while !*complete {
        let next = delivery.next_resolved(home, metrics);
        tokio::pin!(next);
        match futures_util::poll!(&mut next) {
            std::task::Poll::Ready(Ok(Some(archive))) => ready.push(archive),
            std::task::Poll::Ready(Ok(None)) => *complete = true,
            std::task::Poll::Ready(Err(error)) => return Err(error),
            std::task::Poll::Pending => break,
        }
    }
    Ok(())
}

pub(super) async fn prepare_ordinary(
    targets: Vec<CacheTargetGroup>,
    home: &HomePaths,
    concurrency: usize,
    cancel: Option<&CancellationToken>,
    stage: &mut GuestStageRecorder<'_>,
    pending_archives: Option<&mut PendingGuestArchives>,
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
        // Only a complete warm batch can replace the sole staging call. Use
        // the sealed receive path for the attachment and leave small writes alone.
        if let Some(pending) = pending_archives
            && !stage.metrics.attempted
            && batch.content_bytes >= 1024 * 1024
        {
            pending.batch = batch;
        } else {
            flush_guest_stage_batch(&mut batch, stage).await?;
        }
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
