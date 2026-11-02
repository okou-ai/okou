//! Addon process-event parsing and mitmdump stderr re-emission.

use serde_json::{Map, Value};
use tracing::{error, info, warn};

const ADDON_PROCESS_EVENT_PREFIX: &str = "VM0_ADDON_EVENT ";
const ADDON_PROCESS_EVENT_VERSION: u8 = 1;
const MAX_ADDON_PROCESS_EVENT_BYTES: usize = 4096;
const NON_POSITIVE_PEER_CERTIFICATE_SERIAL_DEPRECATION: &str = concat!(
    "CryptographyDeprecationWarning: Parsed a serial number which wasn't positive ",
    "(i.e., it was negative or zero), which is disallowed by RFC 5280. Loading this ",
    "certificate will cause an exception in a future release of cryptography."
);

#[derive(Debug, PartialEq, Eq)]
enum AddonProcessEventLevel {
    Warn,
    Error,
}

#[derive(Debug, PartialEq, Eq)]
struct AddonProcessEvent {
    level: AddonProcessEventLevel,
    fields: Map<String, Value>,
}

fn parse_addon_process_event(line: &str) -> Option<AddonProcessEvent> {
    if line.len() > MAX_ADDON_PROCESS_EVENT_BYTES {
        return None;
    }
    let payload = line.strip_prefix(ADDON_PROCESS_EVENT_PREFIX)?;
    let mut fields = serde_json::from_str::<Map<String, Value>>(payload).ok()?;
    let version = fields.remove("version")?.as_u64()?;
    if version != u64::from(ADDON_PROCESS_EVENT_VERSION) {
        return None;
    }

    let level = match fields.get("level")?.as_str()? {
        "warn" => AddonProcessEventLevel::Warn,
        "error" => AddonProcessEventLevel::Error,
        _ => return None,
    };
    fields.get("message")?.as_str()?;
    Some(AddonProcessEvent { level, fields })
}

fn log_addon_process_event(event: AddonProcessEvent) {
    let encoded = Value::Object(event.fields).to_string();
    match event.level {
        AddonProcessEventLevel::Warn => warn!(
            target: "mitmdump_addon",
            message = encoded.as_str(),
        ),
        AddonProcessEventLevel::Error => error!(
            target: "mitmdump_addon",
            message = encoded.as_str(),
        ),
    }
}

fn is_non_positive_peer_certificate_serial_deprecation(line: &str) -> bool {
    !line.starts_with(ADDON_PROCESS_EVENT_PREFIX)
        && line
            .strip_suffix(NON_POSITIVE_PEER_CERTIFICATE_SERIAL_DEPRECATION)
            .and_then(|source| source.strip_suffix(": "))
            .is_some_and(|source| !source.is_empty())
}

pub(super) fn log_mitmdump_stderr_line(line: &str) {
    if let Some(event) = parse_addon_process_event(line) {
        log_addon_process_event(event);
        return;
    }

    if is_non_positive_peer_certificate_serial_deprecation(line) {
        info!(
            target: "mitmdump",
            reason = "non_positive_peer_certificate_serial_deprecation",
            mitmdump_stderr = %line,
            "mitmdump peer certificate serial deprecation"
        );
        return;
    }

    warn!(target: "mitmdump", "stderr: {line}");
}

#[cfg(test)]
mod tests;
