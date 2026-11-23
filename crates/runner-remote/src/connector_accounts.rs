//! Assignment-bound connector account switching and MCP resolution.
use crate::guest_rpc;
use base64::{Engine, engine::general_purpose::STANDARD};
use runner_provider::ConnectorRuntimeSyncHandle;
use runner_rpc_proto::{Delivery, ErrorCode, MAX_RESPONSE_STREAM_BYTES, Response, ResponseWriter};
use runner_types::types::ConnectorRuntimeTarget;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    target: ConnectorRuntimeTarget,
    connection_id: Uuid,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultDto {
    connection_id: Uuid,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct McpParams {
    authorization: String,
    request: Value,
}

pub(crate) async fn dispatch(sync: ConnectorRuntimeSyncHandle, request: guest_rpc::Request) {
    let guest_rpc::Request {
        input,
        lease,
        run,
        started,
        deadline,
        cancelled,
        sandbox_cancelled,
        request,
    } = request;
    let _lease = lease;
    let scope = guest_rpc::Scope {
        deadline,
        cancelled,
        sandbox_cancelled,
    };
    if request.method == "connector.mcp.resolve" {
        let Ok(params) = serde_json::from_str::<McpParams>(request.params.get()) else {
            scope.error(input, ErrorCode::InvalidRequest).await;
            return;
        };
        let Some(result) = scope
            .wait(sync.resolve_published_mcp(run, &params.authorization, &params.request))
            .await
        else {
            return;
        };
        let _ = scope.wait(write_mcp_result(input, result)).await;
        return;
    }
    let Ok(params) = serde_json::from_str::<Params>(request.params.get()) else {
        scope.error(input, ErrorCode::InvalidRequest).await;
        return;
    };
    let Some(remaining) = request.remaining_ms.filter(|ms| *ms > 1000) else {
        scope.error(input, ErrorCode::InvalidRequest).await;
        return;
    };
    let scope = guest_rpc::Scope {
        deadline: deadline.min(started + Duration::from_millis(remaining.min(60_000))),
        ..scope
    };
    let binding = params.connection_id.to_string();
    let Some(published) = scope
        .wait(sync.sync_account_binding(run, params.target, &binding))
        .await
    else {
        return;
    };
    let response = if published {
        let Ok(data) = serde_json::value::to_raw_value(&ResultDto {
            connection_id: params.connection_id,
        }) else {
            return;
        };
        Response::Result { data }
    } else {
        Response::error(ErrorCode::Unavailable, Delivery::Unknown)
    };
    let mut writer = ResponseWriter::new(input);
    let _ = scope.wait(writer.send(&response)).await;
}

async fn write_mcp_result(
    input: Box<dyn sandbox::GuestRpcStream>,
    result: Option<Value>,
) -> std::io::Result<()> {
    let mut writer = ResponseWriter::new(input);
    // Leave room for base64, the framing envelopes, and the terminal frame.
    const MAX_JSON_BYTES: usize = MAX_RESPONSE_STREAM_BYTES / 4 * 3 - 64 * 1024;
    let Some(result) = result else {
        return writer
            .send(&Response::error(ErrorCode::Unavailable, Delivery::Unknown))
            .await;
    };
    let data = serde_json::to_vec(&result)?;
    if data.len() > MAX_JSON_BYTES {
        return writer
            .send(&Response::error(ErrorCode::Unavailable, Delivery::Unknown))
            .await;
    }
    for bytes in data.chunks(16 * 1024) {
        let data = serde_json::value::to_raw_value(&STANDARD.encode(bytes))?;
        writer.send(&Response::Event { data }).await?;
    }
    let data = serde_json::value::to_raw_value(&())?;
    writer.send(&Response::Result { data }).await
}
