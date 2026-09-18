use rfb_client::InputOutcome;
use runner_rpc_proto::{
    Delivery, ErrorCode, Response,
    stream::{Frame, MAX_DATA_BYTES, Writer},
};
use sandbox::GuestRpcStream;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, UNIX_EPOCH},
};
use tokio::sync::MutexGuard;
use tokio_util::sync::CancellationToken;

use super::{
    Failure, Scope,
    protocol::{self, Info},
    sessions::{Engine, Run, Session},
};

type Output = Writer<Box<dyn GuestRpcStream>>;

fn parse<T: DeserializeOwned>(raw: &str) -> Result<T, Failure> {
    serde_json::from_str(raw).map_err(|_| Failure::InvalidInput)
}

fn failed(reason: Failure) -> Value {
    json!({"outcome":"failed","reason":reason})
}

async fn terminal(writer: &mut Output, scope: &Scope, data: Value) -> bool {
    let Ok(data) = serde_json::value::to_raw_value(&data) else {
        return false;
    };
    scope
        .terminal()
        .wait(writer.send(&Frame::Control(Response::Result { data })))
        .await
        .is_ok_and(|r| r.is_ok())
}

async fn lock<'a>(session: &'a Session, scope: &Scope) -> Result<MutexGuard<'a, Engine>, Failure> {
    match scope.wait(session.engine.lock()).await {
        Ok(engine) if !engine.is_closed() => Ok(engine),
        Ok(_) => Err(Failure::Disconnected),
        Err(error) => {
            session.cancel.cancel();
            Err(error)
        }
    }
}

fn session_scope(scope: &Scope, session: &Session) -> Scope {
    Scope {
        session: session.cancel.clone(),
        ..scope.clone()
    }
}

impl Run {
    pub(crate) async fn dispatch(&self, request: crate::guest_rpc::Request) {
        let crate::guest_rpc::Request {
            input,
            lease,
            run: _,
            started,
            deadline,
            cancelled,
            sandbox_cancelled,
            request,
        } = request;
        let mut writer = Writer::responses(input);
        let Some(remaining) = request.remaining_ms.filter(|ms| *ms > 1000) else {
            let scope = Scope {
                cancelled,
                sandbox: sandbox_cancelled,
                session: CancellationToken::new(),
                deadline,
            };
            let _ = scope
                .wait(writer.send(&Frame::Control(Response::error(
                    ErrorCode::InvalidRequest,
                    Delivery::NotDispatched,
                ))))
                .await;
            return;
        };
        let scope = Scope {
            cancelled,
            sandbox: sandbox_cancelled,
            session: CancellationToken::new(),
            deadline: deadline.min(started + Duration::from_millis(remaining.min(60_000)))
                - Duration::from_secs(1),
        };
        let raw = request.params.get();
        match request.method.as_str() {
            "vnc.session.start" => {
                let result = match parse::<protocol::Start>(raw) {
                    Ok(params) => self.start(params, &scope, Arc::clone(&lease)).await,
                    Err(error) => Err(error),
                };
                match result {
                    Ok(session) => {
                        let delivered = terminal(
                            &mut writer,
                            &scope,
                            json!({"outcome":"started","session":session.info}),
                        )
                        .await;
                        if !delivered {
                            session.cancel.cancel();
                        }
                    }
                    Err(error) => {
                        terminal(&mut writer, &scope, failed(error)).await;
                    }
                }
            }
            "vnc.session.list" => {
                let result = async {
                    parse::<protocol::Empty>(raw)?;
                    let mut infos = Vec::<Info>::new();
                    for session in self.snapshot()? {
                        let operation = session_scope(&scope, &session);
                        let result = async {
                            let _engine = lock(&session, &operation).await?;
                            self.authorize(&session, &operation).await
                        }
                        .await;
                        // Closing a snapshot member must not cancel the list,
                        // but cancellation/deadline of the request still wins.
                        scope.check()?;
                        match result {
                            Ok(()) => infos.push(session.info.clone()),
                            // The authority owns saved connections. An expected
                            // removal or change closes only that stale session;
                            // it must not hide independently authorized siblings.
                            Err(Failure::Unavailable | Failure::ConfigurationChanged) => {}
                            Err(Failure::Cancelled | Failure::Disconnected)
                                if session.cancel.is_cancelled() => {}
                            Err(error) => return Err(error),
                        }
                    }
                    scope.check()?;
                    Ok::<_, Failure>(infos)
                }
                .await;
                let data = match result {
                    Ok(sessions) => json!({"outcome":"listed","sessions":sessions}),
                    Err(error) => failed(error),
                };
                terminal(&mut writer, &scope, data).await;
            }
            "vnc.session.status" | "vnc.session.close" => {
                let result = async {
                    let params = parse::<protocol::SessionId>(raw)?;
                    let session = self.lookup(params.session_id)?;
                    if request.method == "vnc.session.close" {
                        session.cancel.cancel();
                        scope.wait(session.closed.cancelled()).await?;
                        Ok(json!({"outcome":"closed"}))
                    } else {
                        let scope = session_scope(&scope, &session);
                        let _engine = lock(&session, &scope).await?;
                        self.authorize(&session, &scope).await?;
                        Ok(json!({"outcome":"status","session":session.info}))
                    }
                }
                .await;
                terminal(&mut writer, &scope, result.unwrap_or_else(failed)).await;
            }
            "vnc.capture" => self.capture(raw, &scope, &mut writer).await,
            "vnc.input" => self.input(raw, &scope, &mut writer).await,
            _ => {
                let _ = scope
                    .wait(writer.send(&Frame::Control(Response::error(
                        ErrorCode::UnknownMethod,
                        Delivery::NotDispatched,
                    ))))
                    .await;
            }
        }
    }

    async fn capture(&self, raw: &str, scope: &Scope, writer: &mut Output) {
        let mut streaming = false;
        let result = async {
            let params = parse::<protocol::SessionId>(raw)?;
            let session = self.lookup(params.session_id)?;
            let operation = session_scope(scope, &session);
            let mut engine = lock(&session, &operation).await?;
            self.authorize(&session, &operation).await?;
            let result = async {
                let capture = operation
                    .wait(engine.capture(operation.deadline))
                    .await?
                    .map_err(Failure::from)?;
                let metadata = capture.metadata();
                let captured_at = metadata.captured_at
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| Failure::Protocol)?
                    .as_millis();
                let captured_at = u64::try_from(captured_at).map_err(|_| Failure::Protocol)?;
                let data = serde_json::value::to_raw_value(&json!({
                    "kind":"capture","mimeType":"image/png","bytes":capture.png().len(),
                    "width":metadata.width,"height":metadata.height,
                    "geometry":{"sessionId":metadata.geometry.session_id,"epoch":metadata.geometry.epoch},
                    "updateSequence":metadata.update_sequence,"capturedAt":captured_at
                })).map_err(|_| Failure::Protocol)?;
                operation
                    .wait(writer.send(&Frame::Control(Response::Event { data })))
                    .await?
                    .map_err(|_| Failure::Disconnected)?;
                streaming = true;
                for bytes in capture.png().chunks(MAX_DATA_BYTES) {
                    operation
                        .wait(writer.send(&Frame::Data(bytes.to_vec())))
                        .await?
                        .map_err(|_| Failure::Disconnected)?;
                }
                operation.wait(writer.send(&Frame::End))
                    .await?
                    .map_err(|_| Failure::Disconnected)?;
                if !terminal(writer, &operation, json!({"outcome":"captured","bytes":capture.png().len()})).await {
                    return Err(Failure::Disconnected);
                }
                Ok::<_, Failure>(())
            }.await;
            if result.is_err() {
                session.cancel.cancel();
                engine.close();
            }
            result
        }.await;
        if let Err(error) = result {
            if streaming {
                // A Result requires End after binary data. Error is the explicit
                // incomplete-stream terminal, including cancellation between
                // complete frames. A partially written frame is never retried.
                let code = match error {
                    Failure::TimedOut => ErrorCode::TimedOut,
                    Failure::Cancelled | Failure::Disconnected => ErrorCode::Transport,
                    _ => ErrorCode::Protocol,
                };
                if writer.is_usable() {
                    let _ = scope
                        .terminal()
                        .wait(
                            writer.send(&Frame::Control(Response::error(code, Delivery::Unknown))),
                        )
                        .await;
                }
            } else {
                terminal(writer, scope, failed(error)).await;
            }
        }
    }

    async fn input(&self, raw: &str, scope: &Scope, writer: &mut Output) {
        let mut outcome = InputOutcome::NotStarted;
        let result = async {
            let params = parse::<protocol::InputRequest>(raw)?;
            let keys = params.input.keys()?;
            let session = self.lookup(params.session_id)?;
            let operation = session_scope(scope, &session);
            let mut engine = lock(&session, &operation).await?;
            self.authorize(&session, &operation).await?;
            let result = operation
                .wait(engine.input(
                    params.input.as_input(&keys),
                    &mut outcome,
                    operation.deadline,
                ))
                .await
                .and_then(|r| r.map_err(Failure::from));
            if result.is_err()
                && (engine.is_closed()
                    || !matches!(result, Err(Failure::InvalidInput | Failure::StaleGeometry)))
            {
                session.cancel.cancel();
                engine.close();
            }
            // Retain session and serialization until the terminal is attempted.
            let delivered = terminal(
                writer,
                &operation,
                input_result(outcome, result.as_ref().err().copied()),
            )
            .await;
            if !delivered {
                session.cancel.cancel();
                engine.close();
            }
            Ok::<_, Failure>(())
        }
        .await;
        if let Err(error) = result {
            terminal(writer, scope, input_result(outcome, Some(error))).await;
        }
    }
}

fn input_result(outcome: InputOutcome, reason: Option<Failure>) -> Value {
    let outcome = match outcome {
        InputOutcome::Sent => "sent",
        InputOutcome::NotStarted => "not_started",
        InputOutcome::Unknown => "unknown",
    };
    match reason {
        Some(reason) => json!({"outcome":outcome,"reason":reason}),
        None => json!({"outcome":outcome}),
    }
}
