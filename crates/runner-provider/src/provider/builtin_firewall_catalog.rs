//! Runner-owned builtin firewall catalog publication boundary.
//!
//! # Lifecycle
//!
//! The catalog returned by the API is untrusted. The API client validates its
//! envelope and firewall payload before an initial or periodic refresh can
//! reach `write_catalog_cache`. The writer validates the schema-tagged cache
//! again, bounds its serialized size, and, on Unix runner hosts, publishes it
//! through a private atomic target-path replacement. The Python addon then
//! opens that file as a separate trust boundary and independently validates its
//! ownership, permissions, schema, and firewall payload.
//!
//! Cache publication contains unresolved builtin definitions. For each sandbox, the
//! Python registry path substitutes base URL variables, validates the resolved
//! credentialed destination and host policy, assigns run-scoped API IDs, and
//! compiles matchers before request enforcement.
//!
//! # Failure behavior
//!
//! A catalog that remains unavailable or invalid after the initial refresh
//! retries prevents provider startup readiness. A rejected periodic refresh
//! never replaces the published file, so any previously published valid cache
//! remains available. If the Python consumer rejects a new file identity, it
//! exposes no catalog for that identity and marks builtin-dependent sandbox entries
//! invalid until a usable cache is loaded.
//!
//! A send timeout or connection reset, or known transient JSON body-read failure,
//! with a usable cache is INFO. The next scheduled refresh gets one opportunity
//! to recover; a failed observation
//! at least one refresh interval later warns once per episode. Only a complete
//! successful refresh clears the episode, including an unchanged catalog. Other
//! failures remain warnings. Cache usability includes the consumer's Unix owner
//! and write-permission checks, so an untrusted file is not an unchanged-payload
//! success. This reports refresh health, not cache expiry.
//!
//! # Cross-language compatibility
//!
//! Catalog changes must stay compatible with TypeScript artifact validation in
//! `turbo/packages/connectors/src/connector-catalog/artifacts/firewall.ts`
//! and `turbo/packages/connectors/src/firewall-types.ts`, the runtime projection
//! in
//! `turbo/packages/connectors/src/firewall-metadata/runner-runtime-catalog.ts`,
//! and the Python cache and resolver boundaries in
//! `crates/runner/mitm-addon/src/builtin_firewall_cache.py` and
//! `crates/runner/mitm-addon/src/registry_firewalls.py`. Changes to base URL,
//! auth, `hostPolicy`, permission, or serialized firewall semantics must be
//! reconciled across all three owners. Cache format constants are generated
//! from `turbo/packages/api-contracts/src/contracts/runners.ts` for both Rust
//! and Python. The shared base URL cases live in
//! `turbo/packages/connectors/src/__tests__/firewall-base-url-validation-contract.json`
//! and are exercised by TypeScript, Python, and Rust. Keep individual parser
//! rules in executable validation and tests rather than duplicating them here.

use std::collections::BTreeMap;
use std::fs::File;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use nix::fcntl::Flock;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use api_contracts::generated::constants::runners::{
    BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION, BUILTIN_FIREWALL_CATALOG_MAX_BYTES,
};

use super::api::{ApiClient, DegradationEpisodeTracker};
use super::worker_join::join_retained_worker;
use crate::duration::duration_ms;
use crate::error::{
    ApiBodyReadError, ApiTransportCause, ApiTransportError, ProviderError, ProviderResult,
};
use runner_host::lock;
use runner_types::types::Firewall;

pub(super) const BUILTIN_FIREWALL_CATALOG_REFRESH_INTERVAL: Duration = Duration::from_secs(5 * 60);
const BUILTIN_FIREWALL_CATALOG_INITIAL_RETRY_DELAYS: [Duration; 2] =
    [Duration::from_secs(2), Duration::from_secs(5)];
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BuiltinFirewallCatalog {
    pub(super) catalog_digest: String,
    pub(super) catalog_version: String,
    pub(super) firewalls: BTreeMap<String, Firewall>,
}

impl BuiltinFirewallCatalog {
    pub(super) fn validate_for_api_response(&self) -> Result<(), String> {
        validate_catalog_digest(&self.catalog_digest)?;
        if self.catalog_version.is_empty() {
            return Err("catalogVersion must be non-empty".to_string());
        }
        validate_firewall_map(&self.firewalls)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BuiltinFirewallCatalogCache {
    schema_version: u32,
    catalog_digest: String,
    catalog_version: String,
    updated_at: String,
    firewalls: BTreeMap<String, Firewall>,
}

impl BuiltinFirewallCatalogCache {
    fn from_catalog(catalog: BuiltinFirewallCatalog) -> Self {
        Self {
            schema_version: BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION,
            catalog_digest: catalog.catalog_digest,
            catalog_version: catalog.catalog_version,
            updated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            firewalls: catalog.firewalls,
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema_version != BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION {
            return Err(format!("unsupported schemaVersion {}", self.schema_version));
        }
        validate_catalog_digest(&self.catalog_digest)?;
        if self.catalog_version.is_empty() {
            return Err("catalogVersion must be non-empty".to_string());
        }
        if self.updated_at.is_empty() {
            return Err("updatedAt must be non-empty".to_string());
        }
        validate_firewall_map(&self.firewalls)
    }

    fn has_same_catalog_payload(&self, other: &Self) -> bool {
        self.schema_version == other.schema_version
            && self.catalog_digest == other.catalog_digest
            && self.catalog_version == other.catalog_version
            && self.firewalls == other.firewalls
    }
}

pub(super) struct BuiltinFirewallCatalogRefreshHandle {
    inner: Arc<BuiltinFirewallCatalogRefreshInner>,
}

pub(super) struct BuiltinFirewallCatalogRefreshController {
    inner: Option<Arc<BuiltinFirewallCatalogRefreshControllerInner>>,
}

struct BuiltinFirewallCatalogRefreshControllerInner {
    api: ApiClient,
    cache_path: PathBuf,
    lock_path: PathBuf,
    provider_cancel: CancellationToken,
    handle: Mutex<Option<BuiltinFirewallCatalogRefreshHandle>>,
}

struct BuiltinFirewallCatalogRefreshInner {
    cancel: CancellationToken,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl BuiltinFirewallCatalogRefreshController {
    pub(super) fn new(
        api: ApiClient,
        cache_path: PathBuf,
        lock_path: PathBuf,
        provider_cancel: CancellationToken,
    ) -> Self {
        Self {
            inner: Some(Arc::new(BuiltinFirewallCatalogRefreshControllerInner {
                api,
                cache_path,
                lock_path,
                provider_cancel,
                handle: Mutex::new(None),
            })),
        }
    }

    #[cfg(test)]
    pub(super) fn disabled() -> Self {
        Self { inner: None }
    }

    pub(super) async fn prepare_startup_readiness(&self) -> ProviderResult<()> {
        let Some(inner) = &self.inner else {
            return Ok(());
        };

        let mut handle = inner.handle.lock().await;
        if handle.is_some() {
            return Ok(());
        }

        let refresh_handle = BuiltinFirewallCatalogRefreshHandle::start(
            inner.api.clone(),
            inner.cache_path.clone(),
            inner.lock_path.clone(),
            inner.provider_cancel.clone(),
        )
        .await?;
        *handle = Some(refresh_handle);
        Ok(())
    }

    pub(super) async fn shutdown(&self) {
        let Some(inner) = &self.inner else {
            return;
        };
        let mut owner = inner.handle.lock().await;
        if let Some(handle) = owner.as_ref() {
            handle.shutdown().await;
            *owner = None;
        }
    }
}

impl BuiltinFirewallCatalogRefreshHandle {
    pub(super) async fn start(
        api: ApiClient,
        cache_path: PathBuf,
        lock_path: PathBuf,
        provider_cancel: CancellationToken,
    ) -> ProviderResult<Self> {
        run_initial_refresh(&api, &cache_path, &lock_path, &provider_cancel).await?;

        let cancel = provider_cancel.child_token();
        let task = tokio::spawn(run_periodic_refresh(
            api,
            cache_path,
            lock_path,
            cancel.clone(),
            BUILTIN_FIREWALL_CATALOG_REFRESH_INTERVAL,
        ));
        Ok(Self {
            inner: Arc::new(BuiltinFirewallCatalogRefreshInner {
                cancel,
                task: Mutex::new(Some(task)),
            }),
        })
    }

    pub(super) async fn shutdown(&self) {
        self.inner.cancel.cancel();
        if let Err(error) = join_retained_worker(&self.inner.task).await {
            warn!(error = %error, "builtin firewall catalog refresh task failed during shutdown");
        }
    }
}

impl Drop for BuiltinFirewallCatalogRefreshInner {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = self.task.get_mut().take() {
            task.abort();
        }
    }
}

async fn run_initial_refresh(
    api: &ApiClient,
    cache_path: &Path,
    lock_path: &Path,
    cancel: &CancellationToken,
) -> ProviderResult<()> {
    run_initial_refresh_with_delays(
        |cancel| refresh_once(api, cache_path, lock_path, cancel),
        cache_path,
        cancel,
        &BUILTIN_FIREWALL_CATALOG_INITIAL_RETRY_DELAYS,
    )
    .await
}

async fn run_initial_refresh_with_delays<F, Fut>(
    mut refresh: F,
    cache_path: &Path,
    cancel: &CancellationToken,
    retry_delays: &[Duration],
) -> ProviderResult<()>
where
    F: FnMut(CancellationToken) -> Fut,
    Fut: Future<Output = ProviderResult<()>>,
{
    let max_attempts = retry_delays.len() + 1;
    for attempt_index in 0..max_attempts {
        if cancel.is_cancelled() {
            return Err(initial_refresh_cancelled_error());
        }

        let attempt = attempt_index + 1;
        let result = refresh(cancel.clone()).await;
        if cancel.is_cancelled() {
            return Err(initial_refresh_cancelled_error());
        }
        match result {
            Ok(()) => {
                if attempt > 1 {
                    info!(
                        attempt,
                        attempts = max_attempts,
                        cache_path = %cache_path.display(),
                        "initial builtin firewall catalog refresh succeeded after retry"
                    );
                }
                return Ok(());
            }
            Err(error) => {
                let Some(retry_delay) = retry_delays.get(attempt_index) else {
                    error!(
                        error = %error,
                        attempt,
                        attempts = max_attempts,
                        cache_path = %cache_path.display(),
                        "initial builtin firewall catalog refresh failed after retries"
                    );
                    return Err(error);
                };

                warn!(
                    error = %error,
                    attempt,
                    attempts = max_attempts,
                    retry_after_ms = retry_delay.as_millis(),
                    cache_path = %cache_path.display(),
                    "initial builtin firewall catalog refresh failed; retrying"
                );
                tokio::select! {
                    biased;
                    () = cancel.cancelled() => return Err(initial_refresh_cancelled_error()),
                    () = tokio::time::sleep(*retry_delay) => {}
                }
            }
        }
    }
    Err(ProviderError::Internal(
        "initial builtin firewall catalog refresh did not run".to_string(),
    ))
}

fn initial_refresh_cancelled_error() -> ProviderError {
    ProviderError::Internal("initial builtin firewall catalog refresh cancelled".to_string())
}

async fn run_periodic_refresh(
    api: ApiClient,
    cache_path: PathBuf,
    lock_path: PathBuf,
    cancel: CancellationToken,
    interval: Duration,
) {
    run_periodic_refresh_with_interval(
        |cancel| refresh_once(&api, &cache_path, &lock_path, cancel),
        &cache_path,
        &cancel,
        interval,
    )
    .await
}

async fn run_periodic_refresh_with_interval<F, Fut>(
    mut refresh: F,
    cache_path: &Path,
    cancel: &CancellationToken,
    interval: Duration,
) where
    F: FnMut(CancellationToken) -> Fut,
    Fut: Future<Output = ProviderResult<()>>,
{
    let degradation = DegradationEpisodeTracker::new();
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => return,
            () = tokio::time::sleep(interval) => {}
        }

        if cancel.is_cancelled() {
            return;
        }
        let result = refresh(cancel.clone()).await;
        if cancel.is_cancelled() {
            return;
        }
        match result {
            Ok(()) => {
                if let Some(recovery) = degradation
                    .recover(tokio::time::Instant::now().into_std())
                    .await
                {
                    info!(
                        cache_path = %cache_path.display(),
                        recovered_after_failures = recovery.recovered_after_failures,
                        failure_elapsed_ms = duration_ms(recovery.failure_elapsed),
                        was_degraded = recovery.was_degraded,
                        "builtin firewall catalog refresh recovered"
                    );
                }
            }
            Err(error) => {
                log_periodic_refresh_failure(&error, cache_path, cancel, &degradation, interval)
                    .await;
            }
        }
    }
}

async fn log_periodic_refresh_failure(
    error: &ProviderError,
    cache_path: &Path,
    cancel: &CancellationToken,
    degradation: &DegradationEpisodeTracker,
    interval: Duration,
) {
    enum TransientFailure<'a> {
        Send(&'a ApiTransportError),
        BodyRead(&'a ApiBodyReadError),
    }

    let failure = match error {
        ProviderError::ApiTransport(error)
            if matches!(
                error.failure_cause,
                ApiTransportCause::Timeout | ApiTransportCause::ConnectionReset
            ) =>
        {
            TransientFailure::Send(error)
        }
        ProviderError::ApiBodyRead(error)
            if error.content_type == "application/json"
                && matches!(
                    error.failure_cause,
                    ApiTransportCause::Timeout
                        | ApiTransportCause::ConnectionReset
                        | ApiTransportCause::ConnectionAborted
                        | ApiTransportCause::BrokenPipe
                        | ApiTransportCause::UnexpectedEof
                        | ApiTransportCause::HttpIncompleteMessage
                        | ApiTransportCause::HttpClosed
                ) =>
        {
            TransientFailure::BodyRead(error)
        }
        _ => {
            warn!(
                error = %error,
                cache_path = %cache_path.display(),
                "periodic builtin firewall catalog refresh failed"
            );
            return;
        }
    };

    let cache = tokio::select! {
        biased;
        () = cancel.cancelled() => return,
        result = read_catalog_cache(cache_path) => result,
    };
    if cancel.is_cancelled() {
        return;
    }
    match cache {
        Ok(Some(_)) => {}
        Ok(None) => {
            warn!(
                error = %error,
                cache_path = %cache_path.display(),
                "periodic builtin firewall catalog refresh failed; cache is missing"
            );
            return;
        }
        Err(cache_error) => {
            warn!(
                error = %error,
                cache_error = %cache_error,
                cache_path = %cache_path.display(),
                "periodic builtin firewall catalog refresh failed; cache is unusable"
            );
            return;
        }
    }

    // Allow the existing scheduled retry to recover. The threshold is one full
    // refresh interval (five minutes), not the heartbeat/poll freshness budget.
    let observation = degradation
        .observe_failure(tokio::time::Instant::now().into_std(), interval)
        .await;
    macro_rules! emit_failure {
        ($emit:ident, $message:literal) => {
            match failure {
                TransientFailure::Send(error) => $emit!(
                    cache_path = %cache_path.display(),
                    endpoint = error.request.endpoint_label,
                    method = %error.request.method,
                    host = %error.request.host,
                    path = %error.request.path,
                    client_request_id = %error.request.client_request_id,
                    client_session_id = %error.request.client_session_id,
                    client_version = %error.request.client_version,
                    failure_stage = "send",
                    failure_kind = error.failure_kind.as_str(),
                    failure_cause = error.failure_cause.as_str(),
                    consecutive_failures = observation.consecutive_failures,
                    failure_elapsed_ms = duration_ms(observation.failure_elapsed),
                    degraded = observation.degraded,
                    will_retry = true,
                    $message
                ),
                TransientFailure::BodyRead(error) => $emit!(
                    cache_path = %cache_path.display(),
                    endpoint = error.endpoint_label,
                    status = error.status.as_u16(),
                    content_type = error.content_type,
                    content_length = ?error.content_length,
                    received_bytes = error.received_bytes,
                    failure_cause = error.failure_cause.as_str(),
                    consecutive_failures = observation.consecutive_failures,
                    failure_elapsed_ms = duration_ms(observation.failure_elapsed),
                    degraded = observation.degraded,
                    will_retry = true,
                    $message
                ),
            }
        };
    }
    if observation.emit_degradation {
        emit_failure!(warn, "builtin firewall catalog refresh degraded");
    } else {
        emit_failure!(
            info,
            "periodic builtin firewall catalog refresh failed; will retry"
        );
    }
}

async fn refresh_once(
    api: &ApiClient,
    cache_path: &Path,
    lock_path: &Path,
    cancel: CancellationToken,
) -> ProviderResult<()> {
    let catalog = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(initial_refresh_cancelled_error()),
        result = api.resolve_builtin_firewall_catalog() => result?,
    };
    if cancel.is_cancelled() {
        return Err(initial_refresh_cancelled_error());
    }
    write_catalog_cache(cache_path, lock_path, catalog).await
}

async fn write_catalog_cache(
    cache_path: &Path,
    lock_path: &Path,
    catalog: BuiltinFirewallCatalog,
) -> ProviderResult<()> {
    let cache = BuiltinFirewallCatalogCache::from_catalog(catalog);
    cache.validate().map_err(|e| {
        ProviderError::Internal(format!("validate builtin firewall catalog cache: {e}"))
    })?;
    let content = serde_json::to_vec(&cache).map_err(|e| {
        ProviderError::Internal(format!("serialize builtin firewall catalog cache: {e}"))
    })?;
    if content.len() as u64 > BUILTIN_FIREWALL_CATALOG_MAX_BYTES {
        return Err(ProviderError::Internal(format!(
            "builtin firewall catalog cache exceeds {} bytes",
            BUILTIN_FIREWALL_CATALOG_MAX_BYTES
        )));
    }

    let guard = match lock::try_acquire_or_busy(lock_path.to_path_buf()).await? {
        lock::TryLock::Acquired(guard) => guard,
        lock::TryLock::Busy => {
            return Err(ProviderError::Internal(format!(
                "builtin firewall catalog cache lock is already held: {}",
                lock_path.display()
            )));
        }
    };
    if let Some(existing) = read_existing_catalog_cache_for_skip(cache_path).await
        && existing.has_same_catalog_payload(&cache)
    {
        return Ok(());
    }
    publish_catalog_cache(cache_path.to_path_buf(), content, guard).await?;
    info!(cache_path = %cache_path.display(), "builtin firewall catalog cache refreshed");
    Ok(())
}

async fn publish_catalog_cache(
    cache_path: PathBuf,
    content: Vec<u8>,
    guard: Flock<File>,
) -> ProviderResult<()> {
    runner_host::state_file::spawn_locked_private_atomic_write(cache_path, content, guard)
        .await
        .map_err(|error| {
            ProviderError::Internal(format!(
                "builtin firewall catalog cache publication task failed: {error}"
            ))
        })??;
    Ok(())
}

async fn read_existing_catalog_cache_for_skip(
    cache_path: &Path,
) -> Option<BuiltinFirewallCatalogCache> {
    match read_catalog_cache(cache_path).await {
        Ok(cache) => cache,
        Err(error) => {
            warn!(
                error = %error,
                cache_path = %cache_path.display(),
                "existing builtin firewall catalog cache is invalid; overwriting"
            );
            None
        }
    }
}

async fn read_catalog_cache(
    cache_path: &Path,
) -> ProviderResult<Option<BuiltinFirewallCatalogCache>> {
    let Some(content) = runner_host::state_file::read_to_string(
        cache_path,
        BUILTIN_FIREWALL_CATALOG_MAX_BYTES,
        runner_host::state_file::OwnerCheck::CurrentEuidNoUntrustedWrites,
    )
    .await?
    else {
        return Ok(None);
    };
    let cache: BuiltinFirewallCatalogCache = serde_json::from_str(&content).map_err(|e| {
        ProviderError::Internal(format!("parse builtin firewall catalog cache: {e}"))
    })?;
    cache.validate().map_err(|e| {
        ProviderError::Internal(format!("validate builtin firewall catalog cache: {e}"))
    })?;
    Ok(Some(cache))
}

fn validate_firewall_map(firewalls: &BTreeMap<String, Firewall>) -> Result<(), String> {
    if firewalls.is_empty() {
        return Err("firewalls must be non-empty".to_string());
    }
    for (key, firewall) in firewalls {
        if key != &firewall.name {
            return Err(format!(
                "firewalls key {key:?} does not match firewall.name {:?}",
                firewall.name
            ));
        }
        firewall.validate_for_cache()?;
    }
    Ok(())
}

fn validate_catalog_digest(value: &str) -> Result<(), String> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err("catalogDigest must start with sha256:".to_string());
    };
    if hex.len() != 64
        || !hex
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
    {
        return Err("catalogDigest must be a lowercase sha256 digest".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
