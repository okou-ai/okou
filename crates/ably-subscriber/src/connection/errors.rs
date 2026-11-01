use crate::protocol::{ErrorInfo, error_code};
use crate::types::redact_auth_query_params;

pub(super) fn error_or_unknown(error: Option<ErrorInfo>) -> ErrorInfo {
    error.unwrap_or_else(|| ErrorInfo {
        code: error_code::FAILED,
        status_code: None,
        message: "no error details from server".to_string(),
    })
}

pub(super) fn protocol_disconnect_reason(error: Option<ErrorInfo>) -> String {
    match error {
        Some(error) if !error.message.is_empty() => redact_auth_query_params(&error.message),
        Some(error) => {
            let status = error
                .status_code
                .map(|status_code| format!(" status={status_code}"))
                .unwrap_or_default();
            format!("server sent DISCONNECTED code={}{}", error.code, status)
        }
        None => "server sent DISCONNECTED without error details".to_string(),
    }
}

pub(super) fn protocol_error_message(message: String) -> String {
    redact_auth_query_params(&message)
}

pub(super) fn channel_detached_message(message: &str) -> String {
    format!("Channel detached: {}", redact_auth_query_params(message))
}

#[cfg(test)]
mod tests;
