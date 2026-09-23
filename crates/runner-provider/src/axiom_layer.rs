//! Minimal Axiom ingest harness for provider logging tests.

use std::sync::Mutex;

use serde_json::{Map, Value};
use tokio::sync::mpsc;
use tracing::field::{Field, Visit};
use tracing::{Event, Metadata, Subscriber};
use tracing_subscriber::filter;
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;

enum Message {
    Event(Value),
    Close,
}

pub(crate) struct AxiomGuard {
    tx: mpsc::UnboundedSender<Message>,
    task: tokio::task::JoinHandle<()>,
}

impl AxiomGuard {
    pub(crate) async fn shutdown(self) {
        let _ = self.tx.send(Message::Close);
        let _ = self.task.await;
    }
}

pub(crate) struct AxiomLayer {
    tx: Mutex<mpsc::UnboundedSender<Message>>,
}

pub(crate) fn init_with_base_url(
    base_url: &str,
    token: &str,
    suffix: &str,
) -> Option<(AxiomLayer, AxiomGuard)> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let guard_tx = tx.clone();
    let client = reqwest::Client::new();
    let url = format!(
        "{}/v1/datasets/vm0-web-logs-{suffix}/ingest",
        base_url.trim_end_matches('/')
    );
    let token = token.to_owned();
    let task = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            match message {
                Message::Event(event) => {
                    let _ = client
                        .post(&url)
                        .bearer_auth(&token)
                        .json(&vec![event])
                        .send()
                        .await;
                }
                Message::Close => break,
            }
        }
    });
    Some((
        AxiomLayer { tx: Mutex::new(tx) },
        AxiomGuard { tx: guard_tx, task },
    ))
}

fn should_ingest(metadata: &Metadata<'_>) -> bool {
    *metadata.level() <= tracing::Level::WARN
}

pub(crate) fn with_ingest_filter<S>(layer: AxiomLayer) -> impl Layer<S> + Send + Sync + 'static
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    layer.with_filter(filter::filter_fn(
        should_ingest as fn(&Metadata<'_>) -> bool,
    ))
}

impl<S> Layer<S> for AxiomLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        let _ = self
            .tx
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .send(Message::Event(serialize_event(event)));
    }
}

fn serialize_event(event: &Event<'_>) -> Value {
    struct Visitor(Map<String, Value>);

    impl Visit for Visitor {
        fn record_str(&mut self, field: &Field, value: &str) {
            self.0
                .insert(field.name().into(), Value::String(value.to_owned()));
        }

        fn record_i64(&mut self, field: &Field, value: i64) {
            self.0.insert(field.name().into(), value.into());
        }

        fn record_u64(&mut self, field: &Field, value: u64) {
            self.0.insert(field.name().into(), value.into());
        }

        fn record_bool(&mut self, field: &Field, value: bool) {
            self.0.insert(field.name().into(), value.into());
        }

        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            self.0.insert(
                field.name().into(),
                Value::String(format!("{value:?}").trim_matches('"').to_owned()),
            );
        }
    }

    let mut visitor = Visitor(Map::new());
    event.record(&mut visitor);
    visitor.0.insert(
        "level".into(),
        Value::String(event.metadata().level().to_string().to_ascii_lowercase()),
    );
    Value::Object(visitor.0)
}
