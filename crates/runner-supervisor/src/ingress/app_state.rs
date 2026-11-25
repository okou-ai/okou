//! A scoped upload ticket never authenticates control requests.
use super::{IngressHandler, response};
use bytes::{Bytes, BytesMut};
use hmac::{Hmac, KeyInit, Mac};
use http_body_util::{BodyExt, Full};
use hyper::{Method, Request, Response, StatusCode, body::Incoming};
use runner_remote::app_state::{MAX_BUNDLE_BYTES, MAX_LIFETIME, UploadError};
use runner_types::ids::RunId;
use sha2::Sha256;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::Instant;
use uuid::Uuid;

pub(super) fn target(runner: Uuid, path: &str) -> Option<(RunId, Uuid)> {
    let rest = path.strip_prefix(&format!("/runners/{runner}/sandbox/runs/"))?;
    let (run, command) = rest.split_once("/app-state/")?;
    let parsed_run: RunId = run.parse().ok()?;
    let parsed_command: Uuid = command.parse().ok()?;
    (parsed_run.to_string() == run && parsed_command.to_string() == command)
        .then_some((parsed_run, parsed_command))
}

fn ticket(
    token: &str,
    secret: &str,
    hostname: &str,
    generation: u64,
    path: &str,
    now: SystemTime,
) -> Option<(Uuid, Duration)> {
    let mut parts = token.split('.');
    let host = parts.next()?;
    let host_id: Uuid = host.parse().ok()?;
    let expiry = parts.next()?;
    let signature = parts.next()?;
    if parts.next().is_some() || signature.len() != 64 {
        return None;
    }
    let valid_for = (UNIX_EPOCH.checked_add(Duration::from_millis(expiry.parse().ok()?))?)
        .duration_since(now)
        .ok()?;
    if valid_for.is_zero() || valid_for > MAX_LIFETIME {
        return None;
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(
        format!("computer-use-app-state-v1\n{hostname}\n{generation}\n{path}\n{host}\n{expiry}")
            .as_bytes(),
    );
    mac.verify_slice(&hex::decode(signature).ok()?).ok()?;
    Some((host_id, valid_for))
}

impl IngressHandler {
    pub(super) async fn handle_app_state(
        &self,
        mut request: Request<Incoming>,
        run_id: RunId,
        command: Uuid,
    ) -> Response<Full<Bytes>> {
        if request.method() != Method::PUT {
            return response(StatusCode::METHOD_NOT_ALLOWED, "");
        }
        let headers = request.headers();
        if headers.get_all("authorization").iter().count() != 1 {
            return response(StatusCode::UNAUTHORIZED, "");
        }
        let ticket = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .and_then(|value| {
                ticket(
                    value,
                    &self.token,
                    &self.hostname,
                    self.identity.heartbeat_generation(),
                    request.uri().path(),
                    SystemTime::now(),
                )
            });
        let Some((host, lifetime)) = ticket else {
            return response(StatusCode::UNAUTHORIZED, "");
        };
        let deadline = Instant::now() + lifetime;
        if headers.contains_key("upgrade")
            || headers.contains_key("content-encoding")
            || headers
                .get("content-type")
                .is_none_or(|v| v != "application/octet-stream")
        {
            return response(StatusCode::BAD_REQUEST, "");
        }
        let Some(length) = headers
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<usize>().ok())
        else {
            return response(StatusCode::LENGTH_REQUIRED, "");
        };
        if length == 0 || length > MAX_BUNDLE_BYTES {
            return response(StatusCode::PAYLOAD_TOO_LARGE, "");
        }
        let Some(digest) = headers
            .get("x-okou-content-sha256")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| <[u8; 32] as hex::FromHex>::from_hex(value).ok())
        else {
            return response(StatusCode::BAD_REQUEST, "");
        };
        let Some(receiver) = self.app_state.get() else {
            return response(StatusCode::NOT_FOUND, "");
        };
        let Some(run) = receiver.run(run_id) else {
            return response(StatusCode::GONE, "");
        };
        let Some(permit) = receiver.reserve_upload() else {
            return response(StatusCode::TOO_MANY_REQUESTS, "");
        };
        let read = async {
            let mut bytes = BytesMut::with_capacity(length);
            while let Some(frame) = request.body_mut().frame().await {
                let data = frame.ok()?.into_data().ok()?;
                if data.len() > length - bytes.len() {
                    return None;
                }
                bytes.extend_from_slice(&data);
            }
            (bytes.len() == length).then(|| bytes.freeze())
        };
        let outcome = tokio::select! {
            biased;
            () = run.cancelled() => return response(StatusCode::GONE, ""),
            result = tokio::time::timeout_at(deadline, read) => result,
        };
        let bytes = match outcome {
            Ok(Some(body)) => body,
            Ok(None) => return response(StatusCode::BAD_REQUEST, ""),
            Err(_) => return response(StatusCode::REQUEST_TIMEOUT, ""),
        };
        match run
            .deliver(command, host, deadline, digest, bytes, permit)
            .await
        {
            Ok(digest) => response(StatusCode::OK, &digest),
            Err(UploadError::InvalidDigest) => response(StatusCode::BAD_REQUEST, ""),
            Err(UploadError::Conflict) => response(StatusCode::CONFLICT, ""),
            Err(UploadError::Busy) => response(StatusCode::TOO_MANY_REQUESTS, ""),
            Err(UploadError::Expired) => response(StatusCode::GONE, ""),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn api_ticket_is_scoped_to_its_exact_destination_and_deadline() {
        // Generated with the API ticket format and a fixed fixture key.
        let runner = Uuid::from_u128(1);
        let run = Uuid::from_u128(2);
        let command = Uuid::from_u128(3);
        let host = Uuid::from_u128(4);
        let path = format!("/runners/{runner}/sandbox/runs/{run}/app-state/{command}");
        let token = format!(
            "{host}.60000.026d486656413c620f0895350d04423e0e298f9ed582b636c6332a158650b43e"
        );
        let now = UNIX_EPOCH + Duration::from_secs(1);
        assert_eq!(
            ticket(
                &token,
                "vm0_official_fixture",
                "runner.example.org",
                7,
                &path,
                now
            ),
            Some((host, Duration::from_secs(59)))
        );
        assert!(
            ticket(
                &token,
                "vm0_official_fixture",
                "runner.example.org",
                8,
                &path,
                now
            )
            .is_none()
        );
        assert!(
            ticket(
                &token,
                "vm0_official_fixture",
                "runner.example.org",
                7,
                &format!("{path}/other"),
                now
            )
            .is_none()
        );
        assert!(
            ticket(
                &token,
                "vm0_official_fixture",
                "runner.example.org",
                7,
                &path,
                UNIX_EPOCH + Duration::from_secs(61)
            )
            .is_none()
        );
    }
}
