use rfb_client::InputOutcome;
use runner_rpc_proto::{
    Delivery, ErrorCode, Response,
    stream::{Frame, MAX_DATA_BYTES, Reader, Writer},
};
use sandbox::GuestRpcStream;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, UNIX_EPOCH},
};
use tokio::{sync::MutexGuard, time::Instant};
use tokio_util::sync::CancellationToken;

use super::{
    Failure, Scope,
    protocol::{self, Info},
    sessions::{Engine, Run, Session, StartFailure},
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

async fn lock<'a>(
    session: &'a Session,
    scope: &Scope,
    operation: crate::diagnostics::Operation,
    started: Option<Instant>,
    report: &mut Option<crate::diagnostics::Report>,
) -> Result<MutexGuard<'a, Engine>, Failure> {
    match scope.wait(session.engine.lock()).await {
        Ok(engine) if !engine.is_closed() => Ok(engine),
        Ok(_) => Err(Failure::Disconnected),
        Err(error) => {
            // Commit the observed failure before cancellation wakes other callers.
            if !session.cancel.is_cancelled() {
                *report = session.failed_since(operation, error, started);
            }
            session.retire();
            Err(error)
        }
    }
}

fn session_scope(scope: &Scope, session: &Session) -> Scope {
    Scope {
        session: session.cancel.clone(),
        native: session.native.iter().cloned().collect(),
        ..scope.clone()
    }
}

impl Run {
    fn diagnosed(&self, mut data: Value, report: Option<crate::diagnostics::Report>) -> Value {
        if let Some(message) = self.explanation(report.as_ref())
            && let Some(object) = data.as_object_mut()
        {
            object.insert("diagnostic_text".into(), message.into());
        }
        data
    }
    pub(crate) async fn dispatch(&self, request: crate::guest_rpc::Request) {
        let crate::guest_rpc::Request {
            mut input,
            lease,
            run: _,
            started,
            deadline,
            cancelled,
            sandbox_cancelled,
            request,
        } = request;
        let Some(remaining) = request.remaining_ms.filter(|ms| *ms > 1000) else {
            let mut writer = Writer::responses(input);
            let scope = Scope {
                cancelled,
                sandbox: sandbox_cancelled,
                session: CancellationToken::new(),
                native: Vec::new(),
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
            native: Vec::new(),
            deadline: deadline.min(started + Duration::from_millis(remaining.min(60_000)))
                - Duration::from_secs(1),
        };
        // Every VNC command has an empty input stream. Consume its explicit
        // End before a fast terminal closes the socket with unread input and
        // turns a valid result into a reset at the bundled streaming helper.
        let end = scope.wait(Reader::input(&mut input).next()).await;
        let mut writer = Writer::responses(input);
        if !matches!(end, Ok(Ok(Some(Frame::End)))) {
            let code = match end {
                Err(Failure::TimedOut) => ErrorCode::TimedOut,
                Err(_) => ErrorCode::Unavailable,
                Ok(_) => ErrorCode::InvalidRequest,
            };
            let _ = scope
                .terminal()
                .wait(writer.send(&Frame::Control(Response::error(
                    code,
                    Delivery::NotDispatched,
                ))))
                .await;
            return;
        }
        let raw = request.params.get();
        match request.method.as_str() {
            "vnc.session.start" => {
                let result = match parse::<protocol::Start>(raw) {
                    Ok(params) => self.start(params, &scope, Arc::clone(&lease)).await,
                    Err(reason) => Err(StartFailure {
                        reason,
                        report: None,
                    }),
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
                            session.retire();
                        }
                    }
                    Err(error) => {
                        terminal(
                            &mut writer,
                            &scope,
                            self.diagnosed(
                                failed(error.reason),
                                error.report.map(|report| *report),
                            ),
                        )
                        .await;
                    }
                }
            }
            "vnc.session.list" => {
                let mut report = None;
                let result = async {
                    parse::<protocol::Empty>(raw)?;
                    let mut admitted = Vec::<Arc<Session>>::new();
                    for session in self.snapshot()? {
                        let started = session.diagnostic_started();
                        let operation = session_scope(&scope, &session);
                        let mut operation_report = None;
                        let result = async {
                            let engine = lock(
                                &session,
                                &operation,
                                crate::diagnostics::Operation::Session,
                                started,
                                &mut operation_report,
                            );
                            #[cfg(test)]
                            let engine = self
                                .runtime
                                .list_observer
                                .locking(session.info.session_id, engine);
                            let _engine = engine.await?;
                            self.authorize(&session, &operation)
                        }
                        .await;
                        // Closing a snapshot member must not cancel the list,
                        // but cancellation/deadline of the request still wins.
                        if let Err(error) = scope.check() {
                            report = operation_report.or_else(|| {
                                session.failed_since(
                                    crate::diagnostics::Operation::Session,
                                    error,
                                    started,
                                )
                            });
                            return Err(error);
                        }
                        match result {
                            Ok(()) => {
                                admitted.push(Arc::clone(&session));
                                #[cfg(test)]
                                self.runtime.list_observer.admitted(session.info.session_id);
                            }
                            // A revoked or expired member cannot hide siblings.
                            Err(Failure::Cancelled | Failure::Disconnected | Failure::TimedOut)
                                if session.cancel.is_cancelled() => {}
                            Err(error) => {
                                report = operation_report.or_else(|| {
                                    session.failed_since(
                                        crate::diagnostics::Operation::Session,
                                        error,
                                        started,
                                    )
                                });
                                return Err(error);
                            }
                        }
                    }
                    scope.check()?;
                    // A sibling may close while another engine is locked by
                    // capture. Recheck local lifetime/cancellation after waits.
                    let infos = admitted
                        .into_iter()
                        .filter(|session| {
                            !session.cancel.is_cancelled()
                                && session
                                    .native
                                    .as_ref()
                                    .is_none_or(crate::tailscale::StreamGuard::is_live)
                                && tokio::time::Instant::now() < session.expires
                        })
                        .map(|session| session.info.clone())
                        .collect::<Vec<Info>>();
                    Ok::<_, Failure>(infos)
                }
                .await;
                let data = match result {
                    Ok(sessions) => json!({"outcome":"listed","sessions":sessions}),
                    Err(error) => self.diagnosed(failed(error), report),
                };
                terminal(&mut writer, &scope, data).await;
            }
            "vnc.session.status" | "vnc.session.close" => {
                let mut subject = None;
                let mut report = None;
                let result = async {
                    let params = parse::<protocol::SessionId>(raw)?;
                    let session = self.lookup(params.session_id)?;
                    let started = session.diagnostic_started();
                    subject = Some((Arc::clone(&session), started));
                    if request.method == "vnc.session.close" {
                        session.close();
                        scope.wait(session.closed.cancelled()).await?;
                        Ok(json!({"outcome":"closed"}))
                    } else {
                        let scope = session_scope(&scope, &session);
                        let _engine = lock(
                            &session,
                            &scope,
                            crate::diagnostics::Operation::Session,
                            started,
                            &mut report,
                        )
                        .await?;
                        self.authorize(&session, &scope)?;
                        Ok(json!({"outcome":"status","session":session.info}))
                    }
                }
                .await;
                let data = result.unwrap_or_else(|error| {
                    let report = report.or_else(|| {
                        subject.and_then(|(session, started)| {
                            session.failed_since(
                                crate::diagnostics::Operation::Session,
                                error,
                                started,
                            )
                        })
                    });
                    self.diagnosed(failed(error), report)
                });
                terminal(&mut writer, &scope, data).await;
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
        let mut subject = None;
        let mut report = None;
        let result = async {
            let params = parse::<protocol::SessionId>(raw)?;
            let session = self.lookup(params.session_id)?;
            let started = session.diagnostic_started();
            subject = Some((Arc::clone(&session), started));
            let operation = session_scope(scope, &session);
            let mut engine = lock(
                &session, &operation, crate::diagnostics::Operation::Capture, started, &mut report
            ).await?;
            self.authorize(&session, &operation)?;
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
            if let Err(error) = result {
                report = session.failed_since(crate::diagnostics::Operation::Capture, error, started);
                session.retire();
                engine.close();
            }
            result
        }.await;
        if let Err(error) = result {
            let report = report.or_else(|| {
                subject.and_then(|(session, started)| {
                    session.failed_since(crate::diagnostics::Operation::Capture, error, started)
                })
            });
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
                        .wait(writer.send(&Frame::Control(Response::error_with_diagnostic(
                            code,
                            Delivery::Unknown,
                            self.explanation(report.as_ref()),
                        ))))
                        .await;
                }
            } else {
                terminal(writer, scope, self.diagnosed(failed(error), report)).await;
            }
        }
    }

    async fn input(&self, raw: &str, scope: &Scope, writer: &mut Output) {
        let mut outcome = InputOutcome::NotStarted;
        let mut subject = None;
        let mut report = None;
        let result = async {
            let params = parse::<protocol::InputRequest>(raw)?;
            let keys = params.input.keys()?;
            let session = self.lookup(params.session_id)?;
            let started = session.diagnostic_started();
            subject = Some((Arc::clone(&session), started));
            let operation = session_scope(scope, &session);
            let mut engine = lock(
                &session,
                &operation,
                crate::diagnostics::Operation::Input,
                started,
                &mut report,
            )
            .await?;
            self.authorize(&session, &operation)?;
            let result = operation
                .wait(engine.input(
                    params.input.as_input(&keys),
                    &mut outcome,
                    operation.deadline,
                ))
                .await
                .and_then(|r| r.map_err(Failure::from));
            let report = result.as_ref().err().and_then(|error| {
                session.failed_since(crate::diagnostics::Operation::Input, *error, started)
            });
            if result.is_err()
                && (engine.is_closed()
                    || !matches!(result, Err(Failure::InvalidInput | Failure::StaleGeometry)))
            {
                session.retire();
                engine.close();
            }
            // Retain session and serialization until the terminal is attempted.
            let delivered = terminal(
                writer,
                &operation,
                self.diagnosed(
                    input_result(outcome, result.as_ref().err().copied()),
                    report,
                ),
            )
            .await;
            if !delivered {
                session.retire();
                engine.close();
            }
            Ok::<_, Failure>(())
        }
        .await;
        if let Err(error) = result {
            let report = report.or_else(|| {
                subject.and_then(|(session, started)| {
                    session.failed_since(crate::diagnostics::Operation::Input, error, started)
                })
            });
            terminal(
                writer,
                scope,
                self.diagnosed(input_result(outcome, Some(error)), report),
            )
            .await;
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
