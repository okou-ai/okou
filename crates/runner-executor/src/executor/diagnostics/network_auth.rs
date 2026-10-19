//! Restore API-confirmed Codex reconnect guidance lost by workspace discovery.

use std::path::Path;

use guest_contracts::diagnostics::{AgentFramework, FailureClass, FailureReason};
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::executor::{ExecutionFailure, ExecutionFailureKind};

const MAX_NETWORK_LOG_TAIL_BYTES: u64 = 128 * 1024;

#[derive(Deserialize)]
#[serde(tag = "type")]
enum NetworkLogEntry {
    #[serde(rename = "http")]
    Http(NetworkHttpEntry),
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct NetworkHttpEntry {
    method: String,
    url: String,
    status: u16,
    firewall_name: Option<String>,
    firewall_error: Option<String>,
}

impl NetworkHttpEntry {
    fn is_codex_workspace_discovery(&self, url: &url::Url) -> bool {
        self.method == "GET"
            && url.scheme() == "https"
            && url.host_str() == Some("chatgpt.com")
            && url.port_or_known_default() == Some(443)
            && url.path() == "/backend-api/wham/accounts/check"
    }

    fn requires_codex_reconnect(&self) -> bool {
        self.status == 502
            && self.firewall_name.as_deref() == Some("model-provider:codex-oauth-token")
            && self.firewall_error.as_deref() == Some("codex_oauth_reconnect_required")
    }
}

/// Only supplement an otherwise unclassified discovery failure from this Run's
/// host-owned network log. Missing or incomplete evidence preserves the failure.
pub(in crate::executor) async fn enrich_codex_workspace_reconnect(
    failure: &mut ExecutionFailure,
    network_log_path: &Path,
) {
    let Some(diagnostic) = failure.diagnostic.as_mut() else {
        return;
    };
    if failure.kind != ExecutionFailureKind::Generic
        || diagnostic.framework != AgentFramework::Codex
        || diagnostic.failure_class != FailureClass::CliNonzero
        || diagnostic.failure_reason.is_some()
        || failure.error.trim() != "workspace routing discovery failed"
    {
        return;
    }

    if read_codex_workspace_reconnect(network_log_path)
        .await
        .unwrap_or(false)
    {
        diagnostic.failure_reason = Some(FailureReason::ReconnectRequired);
        // The guest supplied the generic error text, but did not classify this
        // reason. Do not attribute the host's API evidence to guest JSONL.
        diagnostic.failure_detail_source = None;
    }
}

async fn read_codex_workspace_reconnect(path: &Path) -> std::io::Result<bool> {
    let mut file = tokio::fs::File::open(path).await?;
    let start = file
        .metadata()
        .await?
        .len()
        .saturating_sub(MAX_NETWORK_LOG_TAIL_BYTES);
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let mut bytes = Vec::new();
    file.take(MAX_NETWORK_LOG_TAIL_BYTES)
        .read_to_end(&mut bytes)
        .await?;
    if !bytes.ends_with(b"\n") {
        return Ok(false);
    }

    // A bounded suffix may start inside a row. Only complete JSONL rows written
    // by the proxy can supply evidence; an unfinished suffix cannot establish
    // the latest outcome, and captured bodies are never interpreted.
    let mut reconnect_required = false;
    for line in bytes
        .split_inclusive(|byte| *byte == b'\n')
        .skip(usize::from(start != 0))
    {
        match serde_json::from_slice::<NetworkLogEntry>(line) {
            Ok(NetworkLogEntry::Http(entry)) => {
                let Ok(url) = url::Url::parse(&entry.url) else {
                    reconnect_required = false;
                    continue;
                };
                if entry.is_codex_workspace_discovery(&url) {
                    reconnect_required = entry.requires_codex_reconnect();
                }
            }
            Ok(NetworkLogEntry::Other) => {}
            // A damaged row can be a later discovery response. It breaks the
            // earlier evidence until a new confirmed discovery row arrives.
            Err(_) => reconnect_required = false,
        }
    }
    Ok(reconnect_required)
}
