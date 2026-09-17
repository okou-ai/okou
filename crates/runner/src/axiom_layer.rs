//! Tracing layer that ships WARN+ events and scoped storage latency to Axiom.
//!
//! Disabled at construction when `AXIOM_TOKEN_TELEMETRY` or
//! `AXIOM_DATASET_SUFFIX` is unset. Dual-write: the existing fmt subscriber
//! keeps writing to stderr + file; this layer adds Axiom as an extra sink.
//!
//! Uses the workspace reqwest client directly (no axiom-rs) so we don't pull
//! a second reqwest major into the musl binary. Ingest endpoint:
//! `POST /v1/datasets/{name}/ingest` with Bearer auth and a JSON-array body —
//! see <https://axiom.co/docs/restapi/ingest>.

use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use reqwest::Client;
use serde_json::{Map, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::field::{Field, Visit};
use tracing::{Event, Metadata, Subscriber};
use tracing_subscriber::filter::{self, FilterFn};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;

/// Bounded-channel capacity between tracing callers and the dispatcher task.
/// WARN+ events are low-volume, so 1024 absorbs realistic bursts; overflow is
/// counted + surfaced via stderr rather than blocking the tracing hot path.
const CHANNEL_CAP: usize = 1024;
/// Max events per ingest POST. Axiom accepts thousands per batch, but a small
/// cap keeps POST body size and peak dispatcher memory predictable.
const BATCH_SIZE: usize = 50;
/// Time-based flush trigger for batches that stay below `BATCH_SIZE`. Keeps
/// events from sitting in the buffer indefinitely when traffic is sparse.
const BATCH_INTERVAL: Duration = Duration::from_secs(5);
/// The current 15-second upper bound on how long `AxiomGuard::shutdown` waits
/// for the dispatcher. It covers both sending the `Close` marker and waiting
/// for the dispatcher to finish, so shutdown is a bounded, best-effort drain:
/// queued or in-flight events may remain undelivered when it expires. Must
/// stay `>= HTTP_TIMEOUT` with enough slack for queued events to reach the
/// `Close` marker — otherwise the final batch (errors emitted right before
/// shutdown) may be aborted mid-request and never reach Axiom.
const FLUSH_DEADLINE: Duration = Duration::from_secs(15);
/// Per-request HTTP timeout on the reqwest client — bounds the time a single
/// stuck ingest call can hold up the dispatcher's batch loop. Must stay
/// `<= FLUSH_DEADLINE` (see above).
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
// Compile-time enforcement of the full-precision FLUSH_DEADLINE >=
// HTTP_TIMEOUT invariant — without this, a slow flush gets aborted
// mid-request during shutdown and the final batch (usually the most valuable
// one) never reaches Axiom.
const _: () = assert!(
    FLUSH_DEADLINE.as_nanos() >= HTTP_TIMEOUT.as_nanos(),
    "FLUSH_DEADLINE must be >= HTTP_TIMEOUT; see FLUSH_DEADLINE doc comment",
);
/// Max content bytes we'll retain from a single textual field.
///
/// Covers typical legitimate strings and formatted values while flagging
/// accidental huge fields. Oversized values are truncated on a UTF-8
/// boundary with a visible marker. The marker is appended after this content
/// cap, matching the existing bounded Debug-field behavior.
const TEXT_FIELD_MAX_BYTES: usize = 4 * 1024;

/// Preserve the causal suffix of an already-materialized error independently
/// of the Axiom field's bounded prefix. Do not format arbitrary Debug values to
/// obtain a tail: their formatting must still stop at the normal field limit.
pub(crate) fn error_tail(error: &str) -> Option<&str> {
    if error.len() <= TEXT_FIELD_MAX_BYTES {
        return None;
    }
    let mut start = error.len() - TEXT_FIELD_MAX_BYTES;
    while !error.is_char_boundary(start) {
        start += 1;
    }
    Some(&error[start..])
}

/// Max native error sources retained after the top-level error message.
const ERROR_SOURCE_MAX_DEPTH: usize = 8;
const TRUNCATION_MARKER: &str = "…[truncated]";
const DEFAULT_AXIOM_URL: &str = "https://api.axiom.co";
const SERVICE_NAME: &str = "runner";
const AXIOM_TOKEN_ENV: &str = "AXIOM_TOKEN_TELEMETRY";
const AXIOM_SUFFIX_ENV: &str = "AXIOM_DATASET_SUFFIX";
const ADDON_LOG_TARGET: &str = "mitmdump_addon";
/// Target used for this layer's own diagnostics. Dispatcher diagnostics
/// (non-success ingest responses, HTTP errors) remain visible to local
/// logging, while the Axiom per-layer filter keeps any observed diagnostics
/// from looping back into this layer and re-flooding the dispatcher.
const INTERNAL_TARGET: &str = "runner::axiom_layer::internal";

#[derive(Default)]
struct BoundedTextOutput {
    value: String,
    truncated: bool,
}

impl BoundedTextOutput {
    fn finish(mut self) -> String {
        if self.truncated {
            self.value.push_str(TRUNCATION_MARKER);
        }
        self.value
    }
}

impl std::fmt::Write for BoundedTextOutput {
    fn write_str(&mut self, value: &str) -> std::fmt::Result {
        if self.truncated {
            return Err(std::fmt::Error);
        }

        let remaining = TEXT_FIELD_MAX_BYTES - self.value.len();
        if value.len() <= remaining {
            self.value.push_str(value);
            return Ok(());
        }

        let mut end = remaining;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        self.value.push_str(&value[..end]);
        self.truncated = true;
        Err(std::fmt::Error)
    }
}

fn format_bounded(arguments: std::fmt::Arguments<'_>) -> String {
    let mut output = BoundedTextOutput::default();
    let _ = output.write_fmt(arguments);
    output.finish()
}

/// Holds the dispatcher task.
///
/// `shutdown().await` attempts a best-effort drain bounded by the current
/// 15-second `FLUSH_DEADLINE`. The bound covers sending `Msg::Close` and
/// waiting for the dispatcher to finish; if it expires, queued or in-flight
/// events may remain undelivered and shutdown returns without guaranteeing
/// that the queue was fully drained. Dropping without calling `shutdown`
/// leaves the Tokio runtime to abort the task without waiting for this bound.
///
/// **Abnormal-exit caveat**: on `panic!`, `std::process::exit`, or
/// `std::process::abort`, `shutdown` does not run — the Tokio runtime tears
/// down mid-flight without even attempting this bounded drain. Events buffered
/// at that moment (often the most valuable batch, since they include whatever
/// triggered the exit) are lost. Sentry's panic integration still captures
/// the panic itself; Axiom just does not receive the corresponding structured
/// log.
pub(crate) struct AxiomGuard {
    tx: mpsc::Sender<Msg>,
    handle: Option<JoinHandle<()>>,
}

impl AxiomGuard {
    pub(crate) async fn shutdown(mut self) {
        // Single deadline covers both `send(Close)` (may wait for a slot if
        // the channel is full) and `handle.await` (may wait for in-flight
        // HTTP flushes). Without wrapping both, a full backlog could stall
        // shutdown for many seconds before the handle timeout even started.
        let _ = tokio::time::timeout(FLUSH_DEADLINE, async move {
            let _ = self.tx.send(Msg::Close).await;
            if let Some(h) = self.handle.take() {
                let _ = h.await;
            }
        })
        .await;
    }
}

/// Initialize the Axiom layer. Returns `None` when required env is missing —
/// caller should install a `None` layer in that case (no-op). Production
/// entry point; always targets `DEFAULT_AXIOM_URL`.
pub(crate) fn init(runner_hostname: Option<String>) -> Option<(AxiomLayer, AxiomGuard)> {
    init_from_env_values(
        DEFAULT_AXIOM_URL,
        std::env::var(AXIOM_TOKEN_ENV).ok(),
        std::env::var(AXIOM_SUFFIX_ENV).ok(),
        runner_hostname,
    )
}

fn init_from_env_values(
    base_url: &str,
    token: Option<String>,
    suffix: Option<String>,
    runner_hostname: Option<String>,
) -> Option<(AxiomLayer, AxiomGuard)> {
    let token = token.filter(|s| !s.is_empty())?;
    let suffix = suffix.filter(|s| !s.is_empty())?;
    init_with_base_url_and_hostname(base_url, &token, &suffix, runner_hostname)
}

/// Core init with an explicit base URL. Exists so module tests can point
/// at an `httpmock` server without leaking an `AXIOM_URL` override into the
/// runner's production env surface — production code should always call
/// [`init`], which hard-codes [`DEFAULT_AXIOM_URL`].
#[cfg(test)]
pub(crate) fn init_with_base_url(
    base_url: &str,
    token: &str,
    suffix: &str,
) -> Option<(AxiomLayer, AxiomGuard)> {
    init_with_base_url_and_hostname(base_url, token, suffix, None)
}

fn init_with_base_url_and_hostname(
    base_url: &str,
    token: &str,
    suffix: &str,
    runner_hostname: Option<String>,
) -> Option<(AxiomLayer, AxiomGuard)> {
    // Shared dataset with TS: turbo/apps/web/src/lib/shared/axiom/datasets.ts
    // DATASETS.WEB_LOGS. APL queries filter by `service == "runner"`.
    let dataset = format!("vm0-web-logs-{suffix}");
    let ingest_url = format!(
        "{}/v1/datasets/{}/ingest",
        base_url.trim_end_matches('/'),
        dataset,
    );

    let client = match Client::builder().timeout(HTTP_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("warn: axiom http client build failed: {e}");
            return None;
        }
    };

    let (tx, rx) = mpsc::channel(CHANNEL_CAP);
    let handle = tokio::spawn(dispatcher(client, ingest_url, token.to_string(), rx));

    Some((
        AxiomLayer {
            tx: tx.clone(),
            dropped: AtomicU64::new(0),
            runner_hostname,
        },
        AxiomGuard {
            tx,
            handle: Some(handle),
        },
    ))
}

pub(crate) struct AxiomLayer {
    tx: mpsc::Sender<Msg>,
    dropped: AtomicU64,
    runner_hostname: Option<String>,
}

fn should_ingest(metadata: &Metadata<'_>) -> bool {
    metadata.target() != INTERNAL_TARGET
        && (*metadata.level() <= tracing::Level::WARN
            || (*metadata.level() == tracing::Level::INFO
                && metadata.target() == "guest_control_client::exec_operation::diagnostics"
                && metadata
                    .fields()
                    .field("storage_download_latency")
                    .is_some()))
}

fn ingest_filter() -> FilterFn<fn(&Metadata<'_>) -> bool> {
    filter::filter_fn(should_ingest as fn(&Metadata<'_>) -> bool)
}

pub(crate) fn with_ingest_filter<S>(layer: AxiomLayer) -> impl Layer<S> + Send + Sync + 'static
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    layer.with_filter(ingest_filter())
}

enum Msg {
    Event(Value),
    Close,
}

impl<S> Layer<S> for AxiomLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        let Ok(permit) = self.tx.try_reserve() else {
            // Bounded-channel full or dispatcher gone. Emit a periodic
            // best-effort diagnostic under `INTERNAL_TARGET`; if tracing
            // observes it, the Axiom per-layer filter keeps it out of remote
            // ingest.
            let prev = self.dropped.fetch_add(1, Ordering::Relaxed);
            if prev.is_multiple_of(1000) {
                tracing::warn!(
                    target: INTERNAL_TARGET,
                    dropped = prev + 1,
                    "axiom channel full",
                );
            }
            return;
        };

        permit.send(Msg::Event(serialize_event(
            event,
            self.runner_hostname.as_deref(),
        )));
    }
}

async fn dispatcher(
    client: Client,
    ingest_url: String,
    token: String,
    mut rx: mpsc::Receiver<Msg>,
) {
    let mut batch: Vec<Value> = Vec::with_capacity(BATCH_SIZE);
    let mut interval = tokio::time::interval(BATCH_INTERVAL);
    // `Delay` prevents the default `Burst` from firing a run of catch-up
    // ticks after a slow flush — each tick is only useful if it wakes us
    // up with a non-empty batch, and missed ticks during a flush would
    // just re-fire as empty no-ops.
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Some(Msg::Event(v)) => {
                    batch.push(v);
                    if batch.len() >= BATCH_SIZE {
                        flush(&client, &ingest_url, &token, &mut batch).await;
                    }
                }
                Some(Msg::Close) | None => {
                    flush(&client, &ingest_url, &token, &mut batch).await;
                    return;
                }
            },
            _ = interval.tick() => {
                if !batch.is_empty() {
                    flush(&client, &ingest_url, &token, &mut batch).await;
                }
            }
        }
    }
}

async fn flush(client: &Client, ingest_url: &str, token: &str, batch: &mut Vec<Value>) {
    if batch.is_empty() {
        return;
    }
    let drained = std::mem::replace(batch, Vec::with_capacity(BATCH_SIZE));
    match client
        .post(ingest_url)
        .bearer_auth(token)
        .json(&drained)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => {
            // Drop events on non-success. Retry-from-inside-tracing risks
            // feedback loops; if 429s become routine, add a real backoff
            // wrapper then. Diagnostics go under INTERNAL_TARGET so they
            // reach stderr + the rolling file via the fmt layer but don't
            // get re-ingested here.
            tracing::warn!(
                target: INTERNAL_TARGET,
                status = %resp.status(),
                "axiom ingest returned non-success",
            );
        }
        Err(e) => {
            tracing::warn!(
                target: INTERNAL_TARGET,
                error = %e,
                "axiom ingest failed",
            );
        }
    }
}

/// Serialize a tracing event to match the TS logger payload shape in
/// `turbo/apps/web/src/lib/shared/logger.ts`: flat top-level `_time`, `level`
/// (lowercase), `message`, `context`, plus any user-supplied fields —
/// augmented with a Rust-only `service` discriminator.
fn serialize_event(event: &Event<'_>, runner_hostname: Option<&str>) -> Value {
    struct V(Map<String, Value>);
    impl Visit for V {
        fn record_str(&mut self, f: &Field, v: &str) {
            self.0.insert(
                f.name().into(),
                Value::String(format_bounded(format_args!("{v}"))),
            );
        }
        fn record_i64(&mut self, f: &Field, v: i64) {
            self.0.insert(f.name().into(), v.into());
        }
        fn record_u64(&mut self, f: &Field, v: u64) {
            self.0.insert(f.name().into(), v.into());
        }
        fn record_u128(&mut self, f: &Field, v: u128) {
            if let Ok(v) = u64::try_from(v) {
                self.0.insert(f.name().into(), v.into());
            } else {
                self.0.insert(f.name().into(), Value::String(v.to_string()));
            }
        }
        fn record_f64(&mut self, f: &Field, v: f64) {
            self.0.insert(f.name().into(), v.into());
        }
        fn record_bool(&mut self, f: &Field, v: bool) {
            self.0.insert(f.name().into(), v.into());
        }
        fn record_error(&mut self, f: &Field, err: &(dyn std::error::Error + 'static)) {
            // Mirror TS `serializeError` shape: an object with `message` and a
            // `chain`. Rust has no stable `.name` / `.stack`; `chain` walks
            // `.source()`, the closest analog to JS `cause`.
            let mut chain: Vec<Value> = Vec::new();
            let mut cur = err.source();
            for _ in 0..ERROR_SOURCE_MAX_DEPTH {
                let Some(e) = cur else {
                    break;
                };
                chain.push(Value::String(format_bounded(format_args!("{e}"))));
                cur = e.source();
            }
            if cur.is_some() {
                chain.push(Value::String(TRUNCATION_MARKER.into()));
            }
            let mut obj = Map::new();
            obj.insert(
                "message".into(),
                Value::String(format_bounded(format_args!("{err}"))),
            );
            if !chain.is_empty() {
                obj.insert("chain".into(), Value::Array(chain));
            }
            self.0.insert(f.name().into(), Value::Object(obj));
        }
        fn record_debug(&mut self, f: &Field, v: &dyn std::fmt::Debug) {
            // Cap per-field size so a user who logs a huge struct via `?v`
            // can't blow past Axiom's body limit or starve the dispatcher.
            self.0.insert(
                f.name().into(),
                Value::String(format_bounded(format_args!("{v:?}"))),
            );
        }
    }

    let meta = event.metadata();
    let mut v = V(Map::new());
    event.record(&mut v);

    let mut out = v.0;
    if meta.target() == ADDON_LOG_TARGET
        && let Some(encoded) = out.get("message").and_then(Value::as_str)
        && let Ok(addon_log) = serde_json::from_str::<Map<String, Value>>(encoded)
    {
        out = addon_log;
        out.remove("runner_hostname");
    }
    out.insert(
        "_time".into(),
        Value::String(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    out.insert(
        "level".into(),
        Value::String(meta.level().to_string().to_ascii_lowercase()),
    );
    out.insert("context".into(), Value::String(meta.target().into()));
    out.insert("service".into(), Value::String(SERVICE_NAME.into()));
    if let Some(runner_hostname) = runner_hostname {
        out.insert(
            "runner_hostname".into(),
            Value::String(runner_hostname.to_string()),
        );
    }
    out.insert(
        "runner_version".into(),
        Value::String(env!("CARGO_PKG_VERSION").into()),
    );
    Value::Object(out)
}

#[cfg(test)]
mod tests;
