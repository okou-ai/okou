use super::*;
use api_contracts::generated::routes::runners::runs::by_run_id::computer_use::commands::by_command_id::check;
use runner_rpc_proto::{Delivery, ErrorCode, Response, ResponseWriter, stream::{Frame, Reader, Writer, MAX_DATA_BYTES}};
use serde::Deserialize;
use serde_json::value::to_raw_value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receive {
    command_id: Uuid,
    resume_sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    host_id: Uuid,
    claimed: bool,
}

impl Run {
    fn acknowledge(&self, command: Uuid, host: Uuid, digest: [u8; 32]) -> Result<(), ErrorCode> {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        let entry = entries.get_mut(&command).ok_or(ErrorCode::Unavailable)?;
        if self.cancel.is_cancelled()
            || matches!(entry.state, State::Revoked)
            || entry.host != host
            || entry.digest != digest
            || Instant::now() >= entry.deadline
        {
            return Err(ErrorCode::Unavailable);
        }
        entry.state = State::Received;
        self.changed.send_replace(());
        Ok(())
    }

    fn revoke(&self, command: Uuid) {
        if let Some(entry) = self
            .entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(&command)
            && matches!(entry.state, State::Pending(_))
        {
            entry.state = State::Revoked;
            self.changed.send_replace(());
        }
    }

    async fn require_claim(&self, command: Uuid, host: Uuid) -> Result<(), ErrorCode> {
        match self.grant(command).await {
            Ok(grant) if grant.claimed && grant.host_id == host => Ok(()),
            Err(ErrorCode::Transport) => Err(ErrorCode::Transport),
            _ => {
                self.revoke(command);
                Err(ErrorCode::Unavailable)
            }
        }
    }

    async fn grant(&self, command: Uuid) -> Result<Grant, ErrorCode> {
        let registry = &self.runtime.0;
        let route = check::route(check::Params {
            run_id: &self.id.to_string(),
            command_id: &command.to_string(),
        });
        let response = registry
            .http
            .request_resolved_route(route, &registry.token)
            .json(&registry.identity)
            .timeout(Duration::from_secs(4))
            .send("computer_use_app_state_check")
            .await
            .map_err(|_| ErrorCode::Transport)?;
        if response.status().is_server_error() || matches!(response.status().as_u16(), 408 | 429) {
            return Err(ErrorCode::Transport);
        }
        crate::authority_response::decode(response, "date")
            .await
            .map(|(grant, _)| grant)
            .map_err(|_| ErrorCode::Unavailable)
    }

    pub(crate) async fn dispatch(&self, request: crate::guest_rpc::Request) {
        if request.request.method == "computer.appState.info" {
            let Ok(data) = to_raw_value(&self.runtime.0.identity) else {
                return;
            };
            let mut writer = ResponseWriter::new(request.input);
            let _ =
                tokio::time::timeout_at(request.deadline, writer.send(&Response::Result { data }))
                    .await;
            return;
        }
        let (input, output) = tokio::io::split(request.input);
        let mut reader = Reader::input(input);
        let mut writer = Writer::responses(output);
        let deadline = request.started
            + Duration::from_millis(request.request.remaining_ms.unwrap_or(30_000).min(120_000));
        let mut streamed = false;
        let receive = async {
            let Receive {
                command_id,
                resume_sha256,
            } = serde_json::from_str(request.request.params.get())
                .map_err(|_| ErrorCode::InvalidRequest)?;
            if let Some(checksum) = resume_sha256 {
                let digest = <[u8; 32] as hex::FromHex>::from_hex(&checksum)
                    .map_err(|_| ErrorCode::InvalidRequest)?;
                let host = {
                    let entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
                    let entry = entries.get(&command_id).ok_or(ErrorCode::Unavailable)?;
                    if entry.digest != digest
                        || entry.deadline <= Instant::now()
                        || matches!(entry.state, State::Revoked)
                    {
                        return Err(ErrorCode::Unavailable);
                    }
                    if matches!(entry.state, State::Received) {
                        return Ok(());
                    }
                    entry.host
                };
                self.require_claim(command_id, host).await?;
                return self.acknowledge(command_id, host, digest);
            }
            let mut changes = self.changed.subscribe();
            let (host, digest, upload, expires) = loop {
                // Subscribe before inspecting the slot, so an upload can precede or follow the reader.
                changes.borrow_and_update();
                let pending = self
                    .entries
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(&command_id)
                    .and_then(|entry| match &entry.state {
                        State::Pending(upload) => {
                            Some((entry.host, entry.digest, Arc::clone(upload), entry.deadline))
                        }
                        _ => None,
                    });
                let grant = match self.grant(command_id).await {
                    Ok(grant) => grant,
                    Err(ErrorCode::Transport) => {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        continue;
                    }
                    Err(error) => {
                        self.revoke(command_id);
                        return Err(error);
                    }
                };
                if let Some((host, digest, upload, expires)) = pending {
                    if !grant.claimed || grant.host_id != host || expires <= Instant::now() {
                        return Err(ErrorCode::Unavailable);
                    }
                    break (host, digest, upload, expires);
                }
                tokio::select! {
                    _ = changes.changed() => {},
                    () = tokio::time::sleep(Duration::from_secs(2)) => {},
                }
            };
            let exchange = async {
                let data = to_raw_value(&serde_json::json!({ "bytes": upload.body.len(), "sha256": hex::encode(digest) })).map_err(|_| ErrorCode::Protocol)?;
                writer
                    .send(&Frame::Control(Response::Event { data }))
                    .await
                    .map_err(|_| ErrorCode::Transport)?;
                streamed = true;
                for chunk in upload.body.chunks(MAX_DATA_BYTES) {
                    writer
                        .send(&Frame::Data(chunk.to_vec()))
                        .await
                        .map_err(|_| ErrorCode::Transport)?;
                }
                writer
                    .send(&Frame::End)
                    .await
                    .map_err(|_| ErrorCode::Transport)?;
                let ack = reader.next().await.map_err(|_| ErrorCode::Transport)?;
                if !matches!(ack, Some(Frame::Data(ref bytes)) if bytes.as_slice() == digest)
                    || !matches!(reader.next().await, Ok(Some(Frame::End)))
                {
                    return Err(ErrorCode::Protocol);
                }
                self.require_claim(command_id, host).await?;
                self.acknowledge(command_id, host, digest)?;
                tracing::info!(run_id = %self.id, command_id = %command_id, bytes = upload.body.len(),
                    elapsed_ms = request.started.elapsed().as_millis() as u64,
                    "Computer Use app state acknowledged by sandbox");
                Ok(())
            };
            let revalidate = async {
                loop {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    self.require_claim(command_id, host).await?;
                }
            };
            tokio::select! {
                result = exchange => result,
                result = revalidate => result,
                () = tokio::time::sleep_until(expires) => Err(ErrorCode::TimedOut),
            }
        };
        let outcome = tokio::select! {
            biased;
            () = request.cancelled.cancelled() => Err(ErrorCode::Unavailable),
            () = request.sandbox_cancelled.cancelled() => Err(ErrorCode::Unavailable),
            () = tokio::time::sleep_until(deadline) => Err(ErrorCode::TimedOut),
            result = receive => result,
        };
        let response = match outcome {
            Ok(()) => match to_raw_value(&true) {
                Ok(data) => Response::Result { data },
                Err(_) => Response::error(ErrorCode::Protocol, Delivery::Unknown),
            },
            Err(code) => Response::error(
                code,
                if streamed {
                    Delivery::Unknown
                } else {
                    Delivery::NotDispatched
                },
            ),
        };
        if writer.is_usable() {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                writer.send(&Frame::Control(response)),
            )
            .await;
        }
    }
}
