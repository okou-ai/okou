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
//! A send timeout or known transient JSON body-read failure with a usable cache is INFO. The
//! next scheduled refresh gets one opportunity to recover; a failed observation
//! at least one refresh interval later warns once per episode. Only a complete
//! successful refresh clears the episode, including an unchanged catalog. Other
//! failures remain warnings. Cache usability includes the consumer's Unix owner
//! and write-permission checks, so an untrusted file is not an unchanged-payload
//! success. This reports refresh health, not cache expiry.
//!
//! # Cross-language compatibility
//!
//! Catalog changes must stay compatible with TypeScript artifact validation in
//! `turbo/apps/api/src/signals/services/connector-catalog-artifacts/firewall.ts`
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
//! and are exercised by TypeScript and Python. Keep individual parser rules in
//! executable validation and tests rather than duplicating them here.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use api_contracts::generated::constants::runners::{
    BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION, BUILTIN_FIREWALL_CATALOG_MAX_BYTES,
};

use super::api::{ApiClient, DegradationEpisodeTracker};
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
    task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
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
        let refresh_handle = inner.handle.lock().await.take();
        if let Some(refresh_handle) = refresh_handle {
            refresh_handle.shutdown().await;
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
                task: StdMutex::new(Some(task)),
            }),
        })
    }

    pub(super) async fn shutdown(&self) {
        self.inner.cancel.cancel();
        let task = self.inner.take_task();
        if let Some(task) = task
            && let Err(error) = task.await
        {
            warn!(error = %error, "builtin firewall catalog refresh task failed during shutdown");
        }
    }
}

impl BuiltinFirewallCatalogRefreshInner {
    fn take_task(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.task
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
    }
}

impl Drop for BuiltinFirewallCatalogRefreshInner {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = self.take_task() {
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
        match result {
            Ok(()) => {
                if cancel.is_cancelled() {
                    return Err(initial_refresh_cancelled_error());
                }
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
                if cancel.is_cancelled() {
                    return Err(initial_refresh_cancelled_error());
                }
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
        match result {
            Ok(()) => {
                if cancel.is_cancelled() {
                    return;
                }
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
                if cancel.is_cancelled() {
                    return;
                }
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
        SendTimeout(&'a ApiTransportError),
        BodyRead(&'a ApiBodyReadError),
    }

    let failure = match error {
        ProviderError::ApiTransport(error) if error.failure_cause == ApiTransportCause::Timeout => {
            TransientFailure::SendTimeout(error)
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
                TransientFailure::SendTimeout(error) => $emit!(
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

    let _guard = match lock::try_acquire_or_busy(lock_path.to_path_buf()).await? {
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
    runner_host::state_file::write_private_atomic(cache_path, &content).await?;
    info!(cache_path = %cache_path.display(), "builtin firewall catalog cache refreshed");
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
mod tests {
    mod send_timeout;

    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::http::{HttpClient, HttpClientConfig};
    use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, json_response};
    use runner_types::types::{FirewallApi, FirewallAuth, FirewallPermission};
    use tracing::{Level, instrument::WithSubscriber};
    use tracing_subscriber::prelude::*;
    use tracing_test_support::{CapturedEvent, CapturedEvents};

    struct RefreshFixture {
        api: ApiClient,
        cache_path: PathBuf,
        lock_path: PathBuf,
        _dir: tempfile::TempDir,
    }

    impl RefreshFixture {
        async fn new(server: &RawHttpTestServer) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
            let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");
            let api = ApiClient::new(
                HttpClient::new(HttpClientConfig {
                    api_url: server.url(),
                    vercel_bypass: None,
                    client_session_id: "catalog-refresh-test".to_string(),
                    runner_version: env!("CARGO_PKG_VERSION"),
                })
                .unwrap(),
                "private-runner-token".to_string(),
            );
            run_initial_refresh(&api, &cache_path, &lock_path, &CancellationToken::new())
                .await
                .unwrap();
            Self {
                api,
                cache_path,
                lock_path,
                _dir: dir,
            }
        }
    }

    fn catalog_response() -> Vec<u8> {
        catalog_response_for(&catalog("github"))
    }

    fn catalog_response_for(catalog: &BuiltinFirewallCatalog) -> Vec<u8> {
        json_response("200 OK", &serde_json::to_string(catalog).unwrap())
    }

    fn truncated_response(content_type: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: 256\r\nConnection: close\r\n\r\nprivate-response-body"
        )
        .into_bytes()
    }

    async fn advance_refresh_interval<F: Future<Output = ()>>(mut refresh: Pin<&mut F>) {
        // Poll the real loop until it registers its next sleep, then advance only
        // that sleep. Keep the clock running for real socket and filesystem I/O.
        tokio::select! {
            biased;
            () = &mut refresh => panic!("refresh loop exited before cancellation"),
            () = tokio::task::yield_now() => {}
        }
        tokio::time::pause();
        tokio::time::advance(BUILTIN_FIREWALL_CATALOG_REFRESH_INTERVAL).await;
        tokio::time::resume();
    }

    async fn next_refresh_event<F: Future<Output = ()>>(
        mut refresh: Pin<&mut F>,
        captured: &CapturedEvents,
    ) -> CapturedEvent {
        captured.clear();
        advance_refresh_interval(refresh.as_mut()).await;
        tokio::time::timeout(Duration::from_secs(5), async {
            tokio::select! {
                biased;
                () = refresh => panic!("refresh loop exited before cancellation"),
                event = async {
                    loop {
                        let events: Vec<_> = captured.entries().into_iter().filter(|event| {
                            event.fields.get("message").is_some_and(|message| {
                                message.starts_with("periodic builtin firewall catalog refresh")
                                    || message.starts_with("builtin firewall catalog refresh ")
                            })
                        }).collect();
                        if !events.is_empty() {
                            assert_eq!(events.len(), 1, "one outcome per refresh: {events:?}");
                            let event = events.into_iter().next().unwrap();
                            return event;
                        }
                        tokio::task::yield_now().await;
                    }
                } => event,
            }
        })
        .await
        .expect("refresh must produce an observable failure or recovery")
    }

    #[tokio::test]
    async fn periodic_body_read_failures_degrade_once_and_recover_unchanged_cache() {
        let truncated = truncated_response("application/json; private=private-header-value");
        let server = RawHttpTestServer::spawn(vec![
            RawHttpAction::Respond(catalog_response()),
            RawHttpAction::Respond(truncated.clone()),
            RawHttpAction::Respond(catalog_response()),
            RawHttpAction::Respond(truncated.clone()),
            RawHttpAction::Respond(truncated.clone()),
            RawHttpAction::Respond(truncated.clone()),
            RawHttpAction::Respond(catalog_response()),
            RawHttpAction::Respond(truncated.clone()),
            RawHttpAction::Respond(truncated),
            RawHttpAction::Respond(catalog_response()),
        ])
        .await;
        let fixture = RefreshFixture::new(&server).await;
        let original = tokio::fs::read(&fixture.cache_path).await.unwrap();
        #[cfg(unix)]
        let original_inode = {
            use std::os::unix::fs::MetadataExt;
            tokio::fs::metadata(&fixture.cache_path)
                .await
                .unwrap()
                .ino()
        };
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let cancel = CancellationToken::new();
        let refresh = run_periodic_refresh(
            fixture.api,
            fixture.cache_path.clone(),
            fixture.lock_path,
            cancel.clone(),
            BUILTIN_FIREWALL_CATALOG_REFRESH_INTERVAL,
        )
        .with_subscriber(subscriber);
        tokio::pin!(refresh);

        for (index, (level, count, degraded)) in [
            (Level::INFO, "1", "false"),
            (Level::INFO, "1", "false"),
            (Level::INFO, "1", "false"),
            (Level::WARN, "2", "true"),
            (Level::INFO, "3", "true"),
            (Level::INFO, "3", "true"),
            (Level::INFO, "1", "false"),
            (Level::WARN, "2", "true"),
            (Level::INFO, "2", "true"),
        ]
        .into_iter()
        .enumerate()
        {
            let event = next_refresh_event(refresh.as_mut(), &captured).await;
            assert_eq!(event.level, level, "{event:?}");
            if matches!(index, 1 | 5 | 8) {
                assert_eq!(
                    event.fields["message"],
                    "builtin firewall catalog refresh recovered"
                );
                assert_eq!(event.fields["recovered_after_failures"], count);
                assert_eq!(event.fields["was_degraded"], degraded);
            } else {
                assert_eq!(event.fields["consecutive_failures"], count);
                assert_eq!(event.fields["degraded"], degraded);
                assert_eq!(event.fields["status"], "200");
                assert_eq!(event.fields["content_type"], "application/json");
                assert_eq!(event.fields["content_length"], "Some(256)");
                assert_eq!(event.fields["failure_cause"], "unexpected_eof");
                assert!(event.fields["received_bytes"].parse::<u64>().unwrap() < 256);
                let diagnostic = format!("{event:?}");
                for private in [
                    "private-response-body",
                    "private-header-value",
                    "private-runner-token",
                ] {
                    assert!(!diagnostic.contains(private), "{diagnostic}");
                }
            }
            assert_eq!(
                tokio::fs::read(&fixture.cache_path).await.unwrap(),
                original
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                assert_eq!(
                    tokio::fs::metadata(&fixture.cache_path)
                        .await
                        .unwrap()
                        .ino(),
                    original_inode
                );
            }
        }
        cancel.cancel();
        refresh.await;
        let requests = server.assert_finished_with_requests().await;
        assert_eq!(requests.len(), 10);
    }

    #[tokio::test]
    async fn periodic_catalog_genuine_failures_warn_without_resetting_body_read_episode() {
        let oversized = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            BUILTIN_FIREWALL_CATALOG_MAX_BYTES + 1
        )
        .into_bytes();
        let invalid_chunks = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nnot-a-chunk-size\r\n".to_vec();
        let failures = [
            json_response("403 Forbidden", r#"{"error":"forbidden"}"#),
            json_response("200 OK", "not JSON"),
            json_response("200 OK", "{}"),
            oversized,
            invalid_chunks,
            truncated_response("text/html; private=private-header-value"),
        ];
        let mut actions = vec![
            RawHttpAction::Respond(catalog_response()),
            RawHttpAction::Respond(truncated_response("application/json")),
        ];
        actions.extend(failures.iter().cloned().map(RawHttpAction::Respond));
        actions.push(RawHttpAction::Respond(catalog_response()));
        let server = RawHttpTestServer::spawn(actions).await;
        let fixture = RefreshFixture::new(&server).await;
        let original = tokio::fs::read(&fixture.cache_path).await.unwrap();
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let cancel = CancellationToken::new();
        let refresh = run_periodic_refresh(
            fixture.api,
            fixture.cache_path.clone(),
            fixture.lock_path,
            cancel.clone(),
            BUILTIN_FIREWALL_CATALOG_REFRESH_INTERVAL,
        )
        .with_subscriber(subscriber);
        tokio::pin!(refresh);

        assert_eq!(
            next_refresh_event(refresh.as_mut(), &captured).await.level,
            Level::INFO
        );
        for _ in failures {
            let event = next_refresh_event(refresh.as_mut(), &captured).await;
            assert_eq!(event.level, Level::WARN, "{event:?}");
            assert_eq!(
                event.fields["message"],
                "periodic builtin firewall catalog refresh failed"
            );
            assert!(!format!("{event:?}").contains("private-header-value"));
            assert_eq!(
                tokio::fs::read(&fixture.cache_path).await.unwrap(),
                original
            );
        }
        let recovery = next_refresh_event(refresh.as_mut(), &captured).await;
        assert_eq!(
            recovery.fields["message"],
            "builtin firewall catalog refresh recovered"
        );
        assert_eq!(recovery.fields["recovered_after_failures"], "1");
        assert_eq!(recovery.fields["was_degraded"], "false");
        cancel.cancel();
        refresh.await;
        server.assert_finished().await;
    }

    #[tokio::test]
    async fn periodic_body_read_failure_with_unusable_cache_warns_immediately() {
        for missing in [true, false] {
            let server = RawHttpTestServer::spawn(vec![
                RawHttpAction::Respond(catalog_response()),
                RawHttpAction::Respond(truncated_response("application/json")),
            ])
            .await;
            let fixture = RefreshFixture::new(&server).await;
            if missing {
                tokio::fs::remove_file(&fixture.cache_path).await.unwrap();
            } else {
                tokio::fs::write(&fixture.cache_path, "invalid cache")
                    .await
                    .unwrap();
            }
            let captured = CapturedEvents::default();
            let subscriber = tracing_subscriber::registry().with(captured.clone());
            let cancel = CancellationToken::new();
            let refresh = run_periodic_refresh(
                fixture.api,
                fixture.cache_path,
                fixture.lock_path,
                cancel.clone(),
                BUILTIN_FIREWALL_CATALOG_REFRESH_INTERVAL,
            )
            .with_subscriber(subscriber);
            tokio::pin!(refresh);

            let event = next_refresh_event(refresh.as_mut(), &captured).await;
            assert_eq!(event.level, Level::WARN);
            assert_eq!(
                event.fields["message"],
                if missing {
                    "periodic builtin firewall catalog refresh failed; cache is missing"
                } else {
                    "periodic builtin firewall catalog refresh failed; cache is unusable"
                }
            );
            cancel.cancel();
            refresh.await;
            server.assert_finished().await;
        }
    }

    #[tokio::test]
    async fn periodic_catalog_publication_failure_preserves_cache_and_warns() {
        let server = RawHttpTestServer::spawn(vec![
            RawHttpAction::Respond(catalog_response()),
            RawHttpAction::Respond(catalog_response()),
        ])
        .await;
        let fixture = RefreshFixture::new(&server).await;
        let original = tokio::fs::read(&fixture.cache_path).await.unwrap();
        let _lock = lock::acquire(fixture.lock_path.clone()).await.unwrap();
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let cancel = CancellationToken::new();
        let refresh = run_periodic_refresh(
            fixture.api,
            fixture.cache_path.clone(),
            fixture.lock_path,
            cancel.clone(),
            BUILTIN_FIREWALL_CATALOG_REFRESH_INTERVAL,
        )
        .with_subscriber(subscriber);
        tokio::pin!(refresh);

        let event = next_refresh_event(refresh.as_mut(), &captured).await;
        assert_eq!(event.level, Level::WARN);
        assert!(event.fields["error"].contains("cache lock is already held"));
        assert_eq!(
            tokio::fs::read(&fixture.cache_path).await.unwrap(),
            original
        );
        cancel.cancel();
        refresh.await;
        server.assert_finished().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn periodic_refresh_rejects_untrusted_cache_and_repairs_unchanged_payload() {
        use std::os::unix::fs::PermissionsExt;

        let server = RawHttpTestServer::spawn(vec![
            RawHttpAction::Respond(catalog_response()),
            RawHttpAction::Respond(truncated_response("application/json")),
            RawHttpAction::Respond(truncated_response("application/json")),
            RawHttpAction::Respond(catalog_response()),
        ])
        .await;
        let fixture = RefreshFixture::new(&server).await;
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let cancel = CancellationToken::new();
        let refresh = run_periodic_refresh(
            fixture.api,
            fixture.cache_path.clone(),
            fixture.lock_path,
            cancel.clone(),
            BUILTIN_FIREWALL_CATALOG_REFRESH_INTERVAL,
        )
        .with_subscriber(subscriber);
        tokio::pin!(refresh);

        assert_eq!(
            next_refresh_event(refresh.as_mut(), &captured).await.level,
            Level::INFO
        );
        tokio::fs::set_permissions(&fixture.cache_path, std::fs::Permissions::from_mode(0o666))
            .await
            .unwrap();
        let failure = next_refresh_event(refresh.as_mut(), &captured).await;
        assert_eq!(failure.level, Level::WARN);
        assert_eq!(
            failure.fields["message"],
            "periodic builtin firewall catalog refresh failed; cache is unusable"
        );
        assert!(failure.fields["cache_error"].contains("group or other users"));

        let recovery = next_refresh_event(refresh.as_mut(), &captured).await;
        assert_eq!(recovery.level, Level::INFO);
        assert_eq!(
            recovery.fields["message"],
            "builtin firewall catalog refresh recovered"
        );
        assert_eq!(recovery.fields["recovered_after_failures"], "1");
        assert_eq!(
            tokio::fs::metadata(&fixture.cache_path)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let cache = read_catalog_cache(&fixture.cache_path)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cache.firewalls, catalog("github").firewalls);
        cancel.cancel();
        refresh.await;
        server.assert_finished().await;
    }

    #[tokio::test]
    async fn periodic_catalog_cancellation_closes_request_without_failure_or_recovery() {
        let mut server = RawHttpTestServer::spawn(vec![
            RawHttpAction::Respond(catalog_response()),
            RawHttpAction::Respond(truncated_response("application/json")),
            RawHttpAction::WaitForDisconnect,
        ])
        .await;
        let fixture = RefreshFixture::new(&server).await;
        server.next_request("initial catalog refresh").await;
        let original = tokio::fs::read(&fixture.cache_path).await.unwrap();
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(
            captured
                .clone()
                .with_filter(tracing_subscriber::filter::LevelFilter::INFO),
        );
        let cancel = CancellationToken::new();
        let refresh = run_periodic_refresh(
            fixture.api,
            fixture.cache_path.clone(),
            fixture.lock_path,
            cancel.clone(),
            BUILTIN_FIREWALL_CATALOG_REFRESH_INTERVAL,
        )
        .with_subscriber(subscriber);
        tokio::pin!(refresh);

        assert_eq!(
            next_refresh_event(refresh.as_mut(), &captured).await.level,
            Level::INFO
        );
        server.next_request("failed catalog body read").await;
        captured.clear();
        advance_refresh_interval(refresh.as_mut()).await;
        tokio::select! {
            biased;
            () = &mut refresh => panic!("refresh exited before cancellation"),
            _ = server.next_request("pending catalog refresh") => {}
        }
        cancel.cancel();
        refresh.await;
        server.assert_finished().await;
        assert!(captured.entries().is_empty(), "{:?}", captured.entries());
        assert_eq!(
            tokio::fs::read(&fixture.cache_path).await.unwrap(),
            original
        );
    }

    fn digest() -> String {
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string()
    }

    fn catalog(name: &str) -> BuiltinFirewallCatalog {
        BuiltinFirewallCatalog {
            catalog_digest: digest(),
            catalog_version: "test-catalog".to_string(),
            firewalls: BTreeMap::from([(
                name.to_string(),
                Firewall {
                    name: name.to_string(),
                    apis: vec![FirewallApi {
                        id: String::new(),
                        base: "https://api.example.com".to_string(),
                        auth: FirewallAuth {
                            headers: BTreeMap::new().into_iter().collect(),
                            base: None,
                            query: None,
                            aws_sigv4: None,
                        },
                        host_policy: None,
                        permissions: Some(vec![FirewallPermission {
                            name: "read".to_string(),
                            description: None,
                            rules: vec!["GET /items".to_string()],
                        }]),
                    }],
                },
            )]),
        }
    }

    fn oversized_catalog() -> BuiltinFirewallCatalog {
        let mut catalog = catalog("github");
        catalog.catalog_version =
            "x".repeat(usize::try_from(BUILTIN_FIREWALL_CATALOG_MAX_BYTES).unwrap());
        catalog
            .validate_for_api_response()
            .expect("oversized catalog should remain schema-valid");
        catalog
    }

    fn catalog_with_auth(auth: serde_json::Value) -> BuiltinFirewallCatalog {
        let mut catalog = catalog("auth-strategy");
        catalog.firewalls.get_mut("auth-strategy").unwrap().apis[0].auth =
            serde_json::from_value(auth).unwrap();
        catalog
    }

    #[tokio::test]
    async fn initial_refresh_accepts_aws_aware_permission_rule() {
        let mut catalog = catalog("aws");
        let api_entry = &mut catalog.firewalls.get_mut("aws").unwrap().apis[0];
        api_entry.base = "https://ec2.us-east-1.amazonaws.com".to_string();
        api_entry.auth = serde_json::from_value(serde_json::json!({
            "awsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}"
            }
        }))
        .unwrap();
        api_entry.permissions.as_mut().unwrap()[0] = FirewallPermission {
            name: "ec2:AcceptAddressTransfer".to_string(),
            description: None,
            rules: vec!["GET / AWS sigv4=ec2 action=AcceptAddressTransfer".to_string()],
        };

        let server =
            RawHttpTestServer::spawn(vec![RawHttpAction::Respond(catalog_response_for(&catalog))])
                .await;
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");
        let api = ApiClient::new(
            HttpClient::new(HttpClientConfig {
                api_url: server.url(),
                vercel_bypass: None,
                client_session_id: "aws-catalog-refresh-test".to_string(),
                runner_version: env!("CARGO_PKG_VERSION"),
            })
            .unwrap(),
            "private-runner-token".to_string(),
        );

        run_initial_refresh(&api, &cache_path, &lock_path, &CancellationToken::new())
            .await
            .unwrap();

        server.assert_finished().await;
        let cached = read_catalog_cache(&cache_path).await.unwrap().unwrap();
        let cached_api = &cached.firewalls["aws"].apis[0];
        assert!(cached_api.auth.aws_sigv4.is_some());
        assert_eq!(
            cached_api.permissions.as_ref().unwrap()[0].rules,
            ["GET / AWS sigv4=ec2 action=AcceptAddressTransfer"]
        );
    }

    #[test]
    fn validates_auth_strategy_combinations_at_catalog_boundary() {
        let aws_sigv4 = serde_json::json!({
            "accessKeyId": "access-key",
            "secretAccessKey": "secret-key"
        });
        let valid = [
            (
                "direct headers",
                serde_json::json!({"headers": {"Authorization": "token"}}),
            ),
            (
                "direct query",
                serde_json::json!({"query": {"api_key": "token"}}),
            ),
            (
                "direct headers and query",
                serde_json::json!({
                    "headers": {"Authorization": "token"},
                    "query": {"api_key": "token"}
                }),
            ),
            (
                "base only",
                serde_json::json!({"base": "https://hooks.example.com/secret"}),
            ),
            (
                "base and headers",
                serde_json::json!({
                    "base": "https://hooks.example.com/secret",
                    "headers": {"Authorization": "token"}
                }),
            ),
            (
                "base and query",
                serde_json::json!({
                    "base": "https://hooks.example.com/secret",
                    "query": {"api_key": "token"}
                }),
            ),
            (
                "base, headers, and query",
                serde_json::json!({
                    "base": "https://hooks.example.com/secret",
                    "headers": {"Authorization": "token"},
                    "query": {"api_key": "token"}
                }),
            ),
            (
                "base with empty maps",
                serde_json::json!({
                    "base": "https://hooks.example.com/secret",
                    "headers": {},
                    "query": {}
                }),
            ),
            ("SigV4", serde_json::json!({"awsSigv4": aws_sigv4.clone()})),
            (
                "SigV4 with empty maps",
                serde_json::json!({
                    "headers": {},
                    "query": {},
                    "awsSigv4": aws_sigv4.clone()
                }),
            ),
        ];

        for (name, auth) in valid {
            catalog_with_auth(auth)
                .validate_for_api_response()
                .unwrap_or_else(|error| panic!("{name} should be valid: {error}"));
        }

        let invalid = [
            (
                "empty base",
                serde_json::json!({"base": ""}),
                "auth.base must be non-empty",
            ),
            (
                "SigV4 and headers",
                serde_json::json!({
                    "headers": {"Authorization": "token"},
                    "awsSigv4": aws_sigv4.clone()
                }),
                "auth.headers cannot be combined",
            ),
            (
                "SigV4 and query",
                serde_json::json!({
                    "query": {"api_key": "token"},
                    "awsSigv4": aws_sigv4.clone()
                }),
                "auth.query cannot be combined",
            ),
            (
                "SigV4 and base",
                serde_json::json!({
                    "base": "https://hooks.example.com/secret",
                    "awsSigv4": aws_sigv4
                }),
                "auth.base cannot be combined",
            ),
        ];

        for (name, auth, expected) in invalid {
            let error = catalog_with_auth(auth)
                .validate_for_api_response()
                .unwrap_err();
            assert!(
                error.contains(expected),
                "{name}: unexpected error: {error}"
            );
        }
    }

    fn catalog_with_base(base: &str) -> BuiltinFirewallCatalog {
        let mut value = catalog("github");
        value
            .firewalls
            .get_mut("github")
            .expect("catalog should contain github")
            .apis[0]
            .base = base.to_string();
        value
    }

    #[tokio::test(start_paused = true)]
    async fn initial_refresh_retries_after_failure() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let cancel = CancellationToken::new();
        let cache_path = PathBuf::from("builtin-firewall-catalog-cache.json");
        let attempts_for_refresh = Arc::clone(&attempts);
        let refresh = move |_cancel: CancellationToken| {
            let attempts = Arc::clone(&attempts_for_refresh);
            async move {
                let attempt = attempts.fetch_add(1, Ordering::SeqCst) + 1;
                if attempt < 3 {
                    Err(ProviderError::Api(format!("attempt {attempt} failed")))
                } else {
                    Ok(())
                }
            }
        };

        let retry_delays = [Duration::from_secs(2), Duration::from_secs(5)];
        let future = run_initial_refresh_with_delays(refresh, &cache_path, &cancel, &retry_delays);
        tokio::pin!(future);

        tokio::select! {
            biased;
            _ = &mut future => panic!("initial refresh should wait before retrying"),
            () = tokio::task::yield_now() => {}
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 1);

        tokio::time::advance(Duration::from_secs(2)).await;
        tokio::select! {
            biased;
            _ = &mut future => panic!("initial refresh should wait before the final retry"),
            () = tokio::task::yield_now() => {}
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 2);

        tokio::time::advance(Duration::from_secs(5)).await;
        future.await.unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn initial_refresh_stops_after_retry_delays_are_exhausted() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let cancel = CancellationToken::new();
        let cache_path = PathBuf::from("builtin-firewall-catalog-cache.json");
        let attempts_for_refresh = Arc::clone(&attempts);
        let refresh = move |_cancel: CancellationToken| {
            let attempts = Arc::clone(&attempts_for_refresh);
            async move {
                let attempt = attempts.fetch_add(1, Ordering::SeqCst) + 1;
                Err(ProviderError::Api(format!("attempt {attempt} failed")))
            }
        };

        let retry_delays = [Duration::from_secs(2), Duration::from_secs(5)];
        let future = run_initial_refresh_with_delays(refresh, &cache_path, &cancel, &retry_delays);
        tokio::pin!(future);

        tokio::select! {
            biased;
            _ = &mut future => panic!("initial refresh should wait before retrying"),
            () = tokio::task::yield_now() => {}
        }
        tokio::time::advance(Duration::from_secs(2)).await;
        tokio::select! {
            biased;
            _ = &mut future => panic!("initial refresh should wait before the final retry"),
            () = tokio::task::yield_now() => {}
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        tokio::time::advance(Duration::from_secs(5)).await;
        let error = future.await.unwrap_err();

        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        assert!(
            error.to_string().contains("attempt 3 failed"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn initial_refresh_stops_retrying_when_cancelled() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let cancel = CancellationToken::new();
        let cache_path = PathBuf::from("builtin-firewall-catalog-cache.json");
        let attempts_for_refresh = Arc::clone(&attempts);
        let refresh = move |_cancel: CancellationToken| {
            let attempts = Arc::clone(&attempts_for_refresh);
            async move {
                let attempt = attempts.fetch_add(1, Ordering::SeqCst) + 1;
                Err(ProviderError::Api(format!("attempt {attempt} failed")))
            }
        };

        let retry_delays = [Duration::from_secs(60)];
        let future = run_initial_refresh_with_delays(refresh, &cache_path, &cancel, &retry_delays);
        tokio::pin!(future);

        tokio::select! {
            biased;
            _ = &mut future => panic!("initial refresh should wait before retrying"),
            () = tokio::task::yield_now() => {}
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 1);

        cancel.cancel();
        let error = future.await.unwrap_err();
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert!(
            error.to_string().contains("refresh cancelled"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn initial_refresh_cancels_in_flight_attempt() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let cancel = CancellationToken::new();
        let cache_path = PathBuf::from("builtin-firewall-catalog-cache.json");
        let attempts_for_refresh = Arc::clone(&attempts);
        let refresh = move |cancel: CancellationToken| {
            let attempts = Arc::clone(&attempts_for_refresh);
            async move {
                attempts.fetch_add(1, Ordering::SeqCst);
                tokio::select! {
                    biased;
                    () = cancel.cancelled() => Err(initial_refresh_cancelled_error()),
                    () = std::future::pending::<()>() => unreachable!(),
                }
            }
        };

        let retry_delays = [Duration::from_secs(60)];
        let future = run_initial_refresh_with_delays(refresh, &cache_path, &cancel, &retry_delays);
        tokio::pin!(future);

        tokio::select! {
            biased;
            _ = &mut future => panic!("initial refresh should wait for the in-flight attempt"),
            () = tokio::task::yield_now() => {}
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 1);

        cancel.cancel();
        let error = tokio::time::timeout(Duration::from_secs(1), future)
            .await
            .expect("initial refresh should stop after cancellation")
            .unwrap_err();
        assert!(
            error.to_string().contains("refresh cancelled"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn periodic_refresh_cancels_in_flight_attempt() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let cancel = CancellationToken::new();
        let cache_path = PathBuf::from("builtin-firewall-catalog-cache.json");
        let attempts_for_refresh = Arc::clone(&attempts);
        let refresh = move |cancel: CancellationToken| {
            let attempts = Arc::clone(&attempts_for_refresh);
            async move {
                attempts.fetch_add(1, Ordering::SeqCst);
                tokio::select! {
                    biased;
                    () = cancel.cancelled() => Err(initial_refresh_cancelled_error()),
                    () = std::future::pending::<()>() => unreachable!(),
                }
            }
        };

        let future = run_periodic_refresh_with_interval(
            refresh,
            &cache_path,
            &cancel,
            Duration::from_secs(60),
        );
        tokio::pin!(future);

        tokio::select! {
            biased;
            _ = &mut future => panic!("periodic refresh should wait for the interval"),
            () = tokio::task::yield_now() => {}
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 0);

        tokio::time::advance(Duration::from_secs(60)).await;
        tokio::select! {
            biased;
            _ = &mut future => panic!("periodic refresh should wait for the in-flight attempt"),
            () = tokio::task::yield_now() => {}
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 1);

        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(1), future)
            .await
            .expect("periodic refresh should stop after cancellation");
    }

    #[tokio::test(start_paused = true)]
    async fn periodic_refresh_recovers_at_next_interval_after_failure() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let cancel = CancellationToken::new();
        let cache_path = PathBuf::from("builtin-firewall-catalog-cache.json");
        let attempts_for_refresh = Arc::clone(&attempts);
        let refresh = move |_cancel: CancellationToken| {
            let attempts = Arc::clone(&attempts_for_refresh);
            async move {
                let attempt = attempts.fetch_add(1, Ordering::SeqCst) + 1;
                if attempt == 1 {
                    Err(ProviderError::Api("periodic refresh failed".to_string()))
                } else {
                    Ok(())
                }
            }
        };

        let interval = Duration::from_secs(60);
        let future = run_periodic_refresh_with_interval(refresh, &cache_path, &cancel, interval);
        tokio::pin!(future);

        tokio::select! {
            biased;
            _ = &mut future => panic!("periodic refresh should wait for the interval"),
            () = tokio::task::yield_now() => {}
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 0);

        tokio::time::advance(interval).await;
        tokio::select! {
            biased;
            _ = &mut future => panic!("periodic refresh should continue after failure"),
            () = tokio::task::yield_now() => {}
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 1);

        tokio::time::advance(interval - Duration::from_nanos(1)).await;
        tokio::select! {
            biased;
            _ = &mut future => panic!("periodic refresh should wait for the next interval"),
            () = tokio::task::yield_now() => {}
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 1);

        tokio::time::advance(Duration::from_nanos(1)).await;
        tokio::select! {
            biased;
            _ = &mut future => panic!("periodic refresh should keep running after recovery"),
            () = tokio::task::yield_now() => {}
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 2);

        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(1), future)
            .await
            .expect("periodic refresh should stop after cancellation");
    }

    #[tokio::test(start_paused = true)]
    async fn periodic_refresh_finishes_in_progress_write_before_cancel_exit() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let entered = Arc::new(tokio::sync::Notify::new());
        let finish = Arc::new(tokio::sync::Notify::new());
        let cancel = CancellationToken::new();
        let cache_path = PathBuf::from("builtin-firewall-catalog-cache.json");
        let attempts_for_refresh = Arc::clone(&attempts);
        let entered_for_refresh = Arc::clone(&entered);
        let finish_for_refresh = Arc::clone(&finish);
        let refresh = move |_cancel: CancellationToken| {
            let attempts = Arc::clone(&attempts_for_refresh);
            let entered = Arc::clone(&entered_for_refresh);
            let finish = Arc::clone(&finish_for_refresh);
            async move {
                attempts.fetch_add(1, Ordering::SeqCst);
                entered.notify_one();
                finish.notified().await;
                Ok(())
            }
        };

        let future = run_periodic_refresh_with_interval(
            refresh,
            &cache_path,
            &cancel,
            Duration::from_secs(60),
        );
        tokio::pin!(future);

        tokio::select! {
            biased;
            _ = &mut future => panic!("periodic refresh should wait for the interval"),
            () = tokio::task::yield_now() => {}
        }
        tokio::time::advance(Duration::from_secs(60)).await;
        tokio::select! {
            biased;
            _ = &mut future => panic!("periodic refresh should wait for the in-progress write"),
            () = entered.notified() => {}
        }

        cancel.cancel();
        tokio::select! {
            biased;
            _ = &mut future => panic!("periodic refresh should finish the in-progress write"),
            () = tokio::task::yield_now() => {}
        }

        finish.notify_one();
        tokio::time::timeout(Duration::from_secs(1), future)
            .await
            .expect("periodic refresh should stop after the write finishes");
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn write_catalog_cache_writes_valid_private_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();

        let cache = read_catalog_cache(&cache_path).await.unwrap().unwrap();
        assert_eq!(
            cache.schema_version,
            BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION
        );
        assert_eq!(cache.catalog_digest, digest());
        assert_eq!(cache.catalog_version, "test-catalog");
        assert_eq!(cache.firewalls["github"].name, "github");
    }

    #[test]
    fn catalog_cache_rejects_unsupported_schema_version() {
        let mut cache = BuiltinFirewallCatalogCache::from_catalog(catalog("github"));
        cache.schema_version = BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION + 1;

        assert_eq!(
            cache.validate().unwrap_err(),
            format!("unsupported schemaVersion {}", cache.schema_version)
        );
    }

    #[tokio::test]
    async fn write_catalog_cache_rejects_oversized_catalog_without_replacing_existing_cache() {
        use std::os::unix::fs::MetadataExt;

        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");
        let expected_error = format!(
            "builtin firewall catalog cache exceeds {} bytes",
            BUILTIN_FIREWALL_CATALOG_MAX_BYTES
        );

        let error = write_catalog_cache(&cache_path, &lock_path, oversized_catalog())
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains(&expected_error),
            "unexpected error: {error}"
        );
        assert!(
            !cache_path.exists(),
            "oversized catalog should not publish a cache file"
        );

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read(&cache_path).await.unwrap();
        let before_ino = std::fs::metadata(&cache_path).unwrap().ino();

        let error = write_catalog_cache(&cache_path, &lock_path, oversized_catalog())
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains(&expected_error),
            "unexpected error: {error}"
        );
        let after = tokio::fs::read(&cache_path).await.unwrap();
        let after_ino = std::fs::metadata(&cache_path).unwrap().ino();
        assert_eq!(after, before);
        assert_eq!(after_ino, before_ino);
    }

    #[tokio::test]
    async fn write_catalog_cache_keeps_existing_file_when_payload_is_unchanged() {
        use std::os::unix::fs::MetadataExt;

        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read_to_string(&cache_path).await.unwrap();
        let before_ino = std::fs::metadata(&cache_path).unwrap().ino();

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();

        let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
        let after_ino = std::fs::metadata(&cache_path).unwrap().ino();
        assert_eq!(after, before);
        assert_eq!(after_ino, before_ino);
    }

    #[tokio::test]
    async fn write_catalog_cache_rewrites_when_payload_changes() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();

        let mut changed = catalog("github");
        changed
            .firewalls
            .get_mut("github")
            .expect("catalog should contain github")
            .apis[0]
            .base = "https://api.github.com".to_string();
        write_catalog_cache(&cache_path, &lock_path, changed)
            .await
            .unwrap();

        let cache = read_catalog_cache(&cache_path).await.unwrap().unwrap();
        assert_eq!(
            cache.firewalls["github"].apis[0].base,
            "https://api.github.com"
        );
    }

    #[tokio::test]
    async fn write_catalog_cache_fails_fast_when_lock_is_busy() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");
        let _guard = lock::acquire(lock_path.clone()).await.unwrap();

        let result = tokio::time::timeout(
            Duration::from_secs(1),
            write_catalog_cache(&cache_path, &lock_path, catalog("github")),
        )
        .await
        .expect("busy catalog cache lock should fail without blocking");
        let error = result.unwrap_err();

        assert!(
            error
                .to_string()
                .contains("builtin firewall catalog cache lock is already held"),
            "unexpected error: {error}"
        );
        assert!(
            !cache_path.exists(),
            "busy lock should not publish a cache file"
        );
    }

    #[tokio::test]
    async fn write_catalog_cache_accepts_valid_parameterized_authorities() {
        let valid_bases = vec![
            "https://{tenant}.example.com:0".to_string(),
            "https://{tenant}.example.com:65535".to_string(),
            "https://{tenant}.example.com/items/{item}".to_string(),
            "https://api-{tenant}.example.com".to_string(),
            "https://{tenant*}.example.com".to_string(),
            format!("https://{}{{tenant}}.example.com", "a".repeat(62)),
        ];

        for base in valid_bases {
            let dir = tempfile::tempdir().unwrap();
            let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
            let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

            write_catalog_cache(&cache_path, &lock_path, catalog_with_base(&base))
                .await
                .unwrap_or_else(|error| panic!("valid base {base:?} was rejected: {error}"));

            let cache = read_catalog_cache(&cache_path).await.unwrap().unwrap();
            assert_eq!(cache.firewalls["github"].apis[0].base, base);
        }
    }

    #[tokio::test]
    async fn write_catalog_cache_accepts_valid_template_bases() {
        let valid_cases =
            crate::test_fixtures::firewall_base_url_contract::catalog_firewall_base_url_validation_cases(
            )
            .into_iter()
            .filter(|test_case| test_case.expected_valid);

        for test_case in valid_cases {
            let dir = tempfile::tempdir().unwrap();
            let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
            let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");
            let mut valid = catalog("github");
            valid
                .firewalls
                .get_mut("github")
                .expect("catalog should contain github")
                .apis[0]
                .base = test_case.base.clone();

            write_catalog_cache(&cache_path, &lock_path, valid)
                .await
                .unwrap_or_else(|error| {
                    panic!(
                        "valid shared template base {:?} failed: {error}",
                        test_case.name
                    )
                });

            let cache = read_catalog_cache(&cache_path).await.unwrap().unwrap();
            assert_eq!(cache.firewalls["github"].apis[0].base, test_case.base);
        }
    }

    #[tokio::test]
    async fn write_catalog_cache_accepts_safe_base_paths() {
        for base in [
            "https://api.example.com/v1/a..b",
            "https://api.example.com/.well-known",
            "https://api.example.com/callback;version=1",
            "https://api.example.com/work%2fflows",
            "https://api.example.com/v1/{org}",
            "https://${{ vars.TENANT }}.example.com/v1/items",
            "${{ vars.API_BASE_URL }}/v1/items",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
            let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

            write_catalog_cache(&cache_path, &lock_path, catalog_with_base(base))
                .await
                .unwrap();

            let cache = read_catalog_cache(&cache_path).await.unwrap().unwrap();
            assert_eq!(cache.firewalls["github"].apis[0].base, base);
        }
    }

    #[tokio::test]
    async fn unsafe_base_catalogs_never_publish() {
        for base in [
            "https://api.example.com/a/../admin",
            "https://api.example.com/a/./admin",
            "https://api.example.com/%2e%2e/admin",
            "https://api.example.com/%252e%252e/admin",
            "https://api.example.com/..;version=1/admin",
            "https://api.example.com/%5cadmin",
            "https://api.example.com/%zz/admin",
            "https://api.example.com/%ff/admin",
            "https://api.example.com/．．/admin",
            "https://api.example.com/v1/../{org}",
            "https://${{ vars.TENANT }}.example.com/v1/../items",
            "${{ vars.API_BASE_URL }}/v1/%2e%2e/items",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
            let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

            let initial_error =
                write_catalog_cache(&cache_path, &lock_path, catalog_with_base(base))
                    .await
                    .unwrap_err();
            assert!(
                initial_error
                    .to_string()
                    .contains("base URL must not contain unsafe path"),
                "unexpected error for {base:?}: {initial_error}"
            );
            assert!(!cache_path.exists(), "unsafe base {base:?} was published");

            write_catalog_cache(&cache_path, &lock_path, catalog("github"))
                .await
                .unwrap();
            let before = tokio::fs::read_to_string(&cache_path).await.unwrap();

            let refresh_error =
                write_catalog_cache(&cache_path, &lock_path, catalog_with_base(base))
                    .await
                    .unwrap_err();
            assert!(
                refresh_error
                    .to_string()
                    .contains("base URL must not contain unsafe path"),
                "unexpected error for {base:?}: {refresh_error}"
            );
            let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
            assert_eq!(after, before, "unsafe base {base:?} replaced the cache");
        }
    }

    #[tokio::test]
    async fn write_catalog_cache_accepts_valid_auth_base_templates() {
        for auth_base in [
            "${{ secrets.WEBHOOK_URL }}",
            "${{ secrets.WEBHOOK_URL }}/api/v1?source=vm0",
            "https://api.example.com/${{ secrets.API_TOKEN }}",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
            let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");
            let mut valid = catalog("github");
            valid
                .firewalls
                .get_mut("github")
                .expect("catalog should contain github")
                .apis[0]
                .auth
                .base = Some(auth_base.to_string());

            write_catalog_cache(&cache_path, &lock_path, valid)
                .await
                .unwrap();

            let cache = read_catalog_cache(&cache_path).await.unwrap().unwrap();
            assert_eq!(
                cache.firewalls["github"].apis[0].auth.base.as_deref(),
                Some(auth_base)
            );
        }
    }

    #[tokio::test]
    async fn invalid_catalog_does_not_overwrite_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read_to_string(&cache_path).await.unwrap();

        let mut invalid = catalog("slack");
        let firewall = invalid.firewalls.remove("slack").unwrap();
        invalid.firewalls.insert("wrong-key".to_string(), firewall);
        let error = write_catalog_cache(&cache_path, &lock_path, invalid)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("does not match firewall.name"),
            "unexpected error: {error}"
        );
        let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn empty_api_catalog_does_not_overwrite_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read_to_string(&cache_path).await.unwrap();

        let mut invalid = catalog("github");
        invalid
            .firewalls
            .get_mut("github")
            .expect("catalog should contain github")
            .apis
            .clear();
        let error = write_catalog_cache(&cache_path, &lock_path, invalid)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("must have at least one api"),
            "unexpected error: {error}"
        );
        let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn catalog_api_id_does_not_overwrite_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read_to_string(&cache_path).await.unwrap();

        let mut invalid = catalog("github");
        invalid
            .firewalls
            .get_mut("github")
            .expect("catalog should contain github")
            .apis[0]
            .id = "catalog-owned-id".to_string();
        let error = write_catalog_cache(&cache_path, &lock_path, invalid)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("runner assigns api ids"),
            "unexpected error: {error}"
        );
        let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn malformed_auth_base_catalog_does_not_overwrite_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read_to_string(&cache_path).await.unwrap();

        let mut invalid = catalog("github");
        invalid
            .firewalls
            .get_mut("github")
            .expect("catalog should contain github")
            .apis[0]
            .auth
            .base = Some("http://example.com".to_string());
        let error = write_catalog_cache(&cache_path, &lock_path, invalid)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("auth.base scheme must be https"),
            "unexpected error: {error}"
        );
        let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn malformed_dynamic_auth_base_path_catalog_does_not_overwrite_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read_to_string(&cache_path).await.unwrap();

        let mut invalid = catalog("github");
        invalid
            .firewalls
            .get_mut("github")
            .expect("catalog should contain github")
            .apis[0]
            .auth
            .base = Some("${{ secrets.WEBHOOK_URL }}/%2e%2e".to_string());
        let error = write_catalog_cache(&cache_path, &lock_path, invalid)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("must not contain unsafe path"),
            "unexpected error: {error}"
        );
        let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn malformed_static_auth_base_path_catalog_does_not_overwrite_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read_to_string(&cache_path).await.unwrap();

        let mut invalid = catalog("github");
        invalid
            .firewalls
            .get_mut("github")
            .expect("catalog should contain github")
            .apis[0]
            .auth
            .base = Some("https://api.example.com/%2e%2e".to_string());
        let error = write_catalog_cache(&cache_path, &lock_path, invalid)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("must not contain unsafe path"),
            "unexpected error: {error}"
        );
        let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn normalized_malformed_static_auth_base_path_catalog_does_not_overwrite_existing_cache()
    {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read_to_string(&cache_path).await.unwrap();

        let mut invalid = catalog("github");
        invalid
            .firewalls
            .get_mut("github")
            .expect("catalog should contain github")
            .apis[0]
            .auth
            .base = Some("https://api.example.com/%EF%BC%8E%EF%BC%8E".to_string());
        let error = write_catalog_cache(&cache_path, &lock_path, invalid)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("must not contain unsafe path"),
            "unexpected error: {error}"
        );
        let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn malformed_host_policy_catalog_does_not_overwrite_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read_to_string(&cache_path).await.unwrap();

        let mut invalid = catalog("github");
        let host_policy = runner_types::types::FirewallBaseHostPolicy::ProviderOwned {
            exact_hosts: vec!["127.0.0.1".to_string()],
            suffixes: Vec::new(),
            allow_non_default_port: false,
        };
        invalid
            .firewalls
            .get_mut("github")
            .expect("catalog should contain github")
            .apis[0]
            .host_policy = Some(host_policy);
        let error = write_catalog_cache(&cache_path, &lock_path, invalid)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("must not be an IP address"),
            "unexpected error: {error}"
        );
        let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn malformed_static_base_catalog_does_not_overwrite_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read_to_string(&cache_path).await.unwrap();

        let mut invalid = catalog("github");
        invalid
            .firewalls
            .get_mut("github")
            .expect("catalog should contain github")
            .apis[0]
            .base = "not-a-url".to_string();
        let error = write_catalog_cache(&cache_path, &lock_path, invalid)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("base URL is invalid"),
            "unexpected error: {error}"
        );
        let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn malformed_parameterized_base_catalog_does_not_overwrite_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read_to_string(&cache_path).await.unwrap();

        let mut invalid = catalog("github");
        invalid
            .firewalls
            .get_mut("github")
            .expect("catalog should contain github")
            .apis[0]
            .base = "https://api.{tenant+}.example.com".to_string();
        let error = write_catalog_cache(&cache_path, &lock_path, invalid)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("must be the first host segment"),
            "unexpected error: {error}"
        );
        let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn invalid_parameterized_authorities_do_not_publish_or_replace_cache() {
        let invalid_bases = vec![
            (
                "non-numeric port",
                "https://{tenant}.example.com:abc".to_string(),
            ),
            (
                "non-ASCII decimal port",
                "https://{tenant}.example.com:\u{ff19}\u{ff19}".to_string(),
            ),
            (
                "port immediately above the valid range",
                "https://{tenant}.example.com:65536".to_string(),
            ),
            (
                "shared-contract out-of-range port",
                "https://{tenant}.example.com:99999".to_string(),
            ),
            (
                "excessively long decimal port",
                format!("https://{{tenant}}.example.com:{}", "9".repeat(100)),
            ),
            (
                "raw wildcard literal",
                "https://*.{tenant}.example.com".to_string(),
            ),
            (
                "literal comma",
                "https://bad,.{tenant}.example.com".to_string(),
            ),
            (
                "literal DNS label above 63 bytes",
                format!("https://{}.{{tenant}}.example.com", "a".repeat(64)),
            ),
            (
                "mixed materialized DNS label above 63 bytes",
                format!("https://{}{{tenant}}.example.com", "a".repeat(63)),
            ),
            (
                "URL-forbidden literal",
                "https://a<b.{tenant}.example.com".to_string(),
            ),
            (
                "extra authority colon",
                "https://{tenant}.example.com:80:90".to_string(),
            ),
        ];

        for (name, base) in invalid_bases {
            let dir = tempfile::tempdir().unwrap();
            let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
            let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

            let initial_error =
                write_catalog_cache(&cache_path, &lock_path, catalog_with_base(&base))
                    .await
                    .unwrap_err();
            assert!(
                !cache_path.exists(),
                "{name} unexpectedly published an initial cache after {initial_error}"
            );

            write_catalog_cache(&cache_path, &lock_path, catalog("github"))
                .await
                .unwrap();
            let before = tokio::fs::read(&cache_path).await.unwrap();

            let refresh_error =
                write_catalog_cache(&cache_path, &lock_path, catalog_with_base(&base))
                    .await
                    .unwrap_err();
            let after = tokio::fs::read(&cache_path).await.unwrap();
            assert_eq!(
                after, before,
                "{name} replaced the valid cache after {refresh_error}"
            );
        }
    }

    #[tokio::test]
    async fn invalid_shared_contract_bases_do_not_publish_or_replace_cache() {
        let invalid_cases =
            crate::test_fixtures::firewall_base_url_contract::firewall_base_url_validation_cases()
                .into_iter()
                .filter(|test_case| !test_case.expected_valid);

        for test_case in invalid_cases {
            let dir = tempfile::tempdir().unwrap();
            let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
            let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

            let initial_error =
                write_catalog_cache(&cache_path, &lock_path, catalog_with_base(&test_case.base))
                    .await
                    .unwrap_err();
            assert!(
                !cache_path.exists(),
                "shared case {:?} unexpectedly published an initial cache after {initial_error}",
                test_case.name
            );

            write_catalog_cache(&cache_path, &lock_path, catalog("github"))
                .await
                .unwrap();
            let before = tokio::fs::read(&cache_path).await.unwrap();

            let refresh_error =
                write_catalog_cache(&cache_path, &lock_path, catalog_with_base(&test_case.base))
                    .await
                    .unwrap_err();
            let after = tokio::fs::read(&cache_path).await.unwrap();
            assert_eq!(
                after, before,
                "shared case {:?} replaced the valid cache after {refresh_error}",
                test_case.name
            );
        }
    }

    #[tokio::test]
    async fn malformed_template_base_catalog_does_not_overwrite_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read_to_string(&cache_path).await.unwrap();

        let mut invalid = catalog("github");
        invalid
            .firewalls
            .get_mut("github")
            .expect("catalog should contain github")
            .apis[0]
            .base = "https://${{ secrets.TENANT }}.example.com".to_string();
        let error = write_catalog_cache(&cache_path, &lock_path, invalid)
            .await
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("template reference must use vars"),
            "unexpected error: {error}"
        );
        let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn malformed_template_parameter_base_catalog_does_not_overwrite_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read_to_string(&cache_path).await.unwrap();

        let mut invalid = catalog("github");
        invalid
            .firewalls
            .get_mut("github")
            .expect("catalog should contain github")
            .apis[0]
            .base = "https://${{ vars.TENANT }}.{tenant+}.example.com".to_string();
        let error = write_catalog_cache(&cache_path, &lock_path, invalid)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("must be the first host segment"),
            "unexpected error: {error}"
        );
        let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn malformed_permission_catalog_does_not_overwrite_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read_to_string(&cache_path).await.unwrap();

        let mut invalid = catalog("github");
        invalid
            .firewalls
            .get_mut("github")
            .expect("catalog should contain github")
            .apis[0]
            .permissions
            .as_mut()
            .expect("catalog api should contain permissions")[0]
            .rules
            .clear();
        let error = write_catalog_cache(&cache_path, &lock_path, invalid)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("must have at least one rule"),
            "unexpected error: {error}"
        );
        let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn malformed_rule_catalog_does_not_overwrite_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read_to_string(&cache_path).await.unwrap();

        let mut invalid = catalog("github");
        invalid
            .firewalls
            .get_mut("github")
            .expect("catalog should contain github")
            .apis[0]
            .permissions
            .as_mut()
            .expect("catalog api should contain permissions")[0]
            .rules = vec!["GET /items/{path+}/tail".to_string()];
        let error = write_catalog_cache(&cache_path, &lock_path, invalid)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("must be the last segment"),
            "unexpected error: {error}"
        );
        let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn read_catalog_cache_rejects_malformed_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        tokio::fs::write(&cache_path, r#"{"schemaVersion":1}"#)
            .await
            .unwrap();

        let error = read_catalog_cache(&cache_path).await.unwrap_err();

        assert!(
            error
                .to_string()
                .contains("parse builtin firewall catalog cache"),
            "unexpected error: {error}"
        );
    }
}
