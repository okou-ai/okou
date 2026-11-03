//! Assignment-bound acknowledgment of ordinary connector runtime publication.
use crate::guest_rpc;
use runner_provider::ConnectorRuntimeSyncHandle;
use runner_rpc_proto::{Delivery, ErrorCode, Response, ResponseWriter};
use runner_types::types::ConnectorRuntimeTarget;
use serde::{Deserialize, Serialize};
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
