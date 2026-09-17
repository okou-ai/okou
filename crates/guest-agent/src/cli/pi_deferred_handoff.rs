//! Authenticated deferred Pi handoff transport owned by the Guest.

use super::CliRuntimeConfig;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::paths;
use api_contracts::generated::types::runners::runs::PiDeferredLaunchConfig;
use base64::Engine as _;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const HANDOFF_CHUNK_MAX_BYTES: usize = 1024 * 1024;
const HANDOFF_ENCODED_CHUNK_MAX_BYTES: usize = 1_400_000;
const HANDOFF_MAX_BYTES: usize = 32 * 1024 * 1024;
const HANDOFF_REQUEST_MAX_TIMEOUT: Duration = Duration::from_secs(30);

fn deferred_launch_config(
    runtime: &CliRuntimeConfig<'_>,
) -> Result<Option<PiDeferredLaunchConfig>, AgentError> {
    let value: serde_json::Value = serde_json::from_str(runtime.pi_launch_config.as_ref())
        .map_err(|_| AgentError::Execution("Pi launch config is invalid".to_string()))?;
    if value
        .pointer("/apiFirstTurn/schemaVersion")
        .and_then(serde_json::Value::as_i64)
        != Some(2)
    {
        return Ok(None);
    }
    let config: PiDeferredLaunchConfig = serde_json::from_value(value)
        .map_err(|_| AgentError::Execution("Deferred Pi launch identity is invalid".to_string()))?;
    if config.schema_version != 2 || config.api_first_turn.schema_version != 2 {
        return Err(AgentError::Execution(
            "Deferred Pi launch identity is invalid".to_string(),
        ));
    }
    Ok(Some(config))
}

fn request_timeout(deadline_at: i64) -> Result<Duration, AgentError> {
    let deadline_at = u64::try_from(deadline_at).map_err(|_| {
        AgentError::Execution("Deferred Pi handoff deadline is invalid".to_string())
    })?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AgentError::Execution("System clock is before Unix epoch".to_string()))?;
    let now_ms = u64::try_from(now.as_millis()).unwrap_or(u64::MAX);
    let remaining_ms = deadline_at
        .checked_sub(now_ms)
        .filter(|value| *value > 0)
        .ok_or_else(|| AgentError::Execution("Pi durable handoff deadline expired".to_string()))?;
    Ok(Duration::from_millis(remaining_ms).min(HANDOFF_REQUEST_MAX_TIMEOUT))
}

/// Fetch and persist authenticated deferred handoff bytes before child spawn.
///
/// The HTTP client owns `OKOU_API_TOKEN`. The child receives only the path to
/// the resulting 0600 file, so ordinary user/agent tokens cannot be confused
/// with the Sandbox control credential and the private credential never enters
/// the child's environment.
pub(super) async fn prepare_for_cli(
    runtime: &CliRuntimeConfig<'_>,
    http: &HttpClient,
) -> Result<(), AgentError> {
    let Some(config) = deferred_launch_config(runtime)? else {
        return Ok(());
    };
    if config.api_first_turn.run_id.as_str() != runtime.run_id.as_ref() {
        return Err(AgentError::Execution(
            "Deferred Pi handoff run identity mismatch".to_string(),
        ));
    }

    let mut payload = Vec::new();
    let mut offset = 0_u64;
    loop {
        let response = http
            .get_deferred_pi_handoff_chunk(
                runtime.run_id.as_ref(),
                offset,
                request_timeout(config.api_first_turn.deadline_at)?,
            )
            .await?;
        if response.chunk.len() > HANDOFF_ENCODED_CHUNK_MAX_BYTES {
            return Err(AgentError::Execution(
                "Pi durable handoff chunk exceeds its encoded size limit".to_string(),
            ));
        }
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(response.chunk)
            .map_err(|_| {
                AgentError::Execution("Pi durable handoff chunk is not valid base64".to_string())
            })?;
        let next_size = payload.len().checked_add(decoded.len()).ok_or_else(|| {
            AgentError::Execution("Pi durable handoff exceeds its size limit".to_string())
        })?;
        if decoded.is_empty()
            || decoded.len() > HANDOFF_CHUNK_MAX_BYTES
            || next_size > HANDOFF_MAX_BYTES
        {
            return Err(AgentError::Execution(
                "Pi durable handoff chunk bounds mismatch".to_string(),
            ));
        }

        let next_offset = response.next_offset;
        if let Some(next_offset) = next_offset {
            let decoded_len = u64::try_from(decoded.len()).map_err(|_| {
                AgentError::Execution("Pi durable handoff offset overflow".to_string())
            })?;
            let expected = offset.checked_add(decoded_len).ok_or_else(|| {
                AgentError::Execution("Pi durable handoff offset overflow".to_string())
            })?;
            if decoded.len() != HANDOFF_CHUNK_MAX_BYTES || next_offset != expected {
                return Err(AgentError::Execution(
                    "Pi durable handoff chunk bounds mismatch".to_string(),
                ));
            }
        }
        payload.extend_from_slice(&decoded);
        match next_offset {
            Some(next_offset) => offset = next_offset,
            None => break,
        }
    }

    let path = runtime.pi_deferred_handoff_file.as_ref();
    paths::ensure_parent_dir(path)?;
    paths::write_private(path, &payload)?;
    Ok(())
}
