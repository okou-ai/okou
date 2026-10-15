//! Explicit versioned business opt-in; legacy envelopes and methods stay opaque.

use super::{Cause, Handle, Report};
use serde::Serialize;
use serde_json::{Value, value::RawValue};

pub(crate) const CAPABILITIES: &str = "ssh.diagnostics.capabilities";
pub(crate) const QUERY: &str = "ssh.diagnostics.query.v2";
pub(crate) const METHODS: [(&str, &str); 9] = [
    ("ssh.exec.diagnostics.v2", "ssh.exec"),
    ("ssh.file.upload.diagnostics.v2", "ssh.file.upload"),
    ("ssh.file.download.diagnostics.v2", "ssh.file.download"),
    ("ssh.session.start.diagnostics.v2", "ssh.session.start"),
    ("ssh.session.status.diagnostics.v2", "ssh.session.status"),
    ("ssh.session.read.diagnostics.v2", "ssh.session.read"),
    ("ssh.session.write.diagnostics.v2", "ssh.session.write"),
    ("ssh.session.signal.diagnostics.v2", "ssh.session.signal"),
    ("ssh.session.close.diagnostics.v2", "ssh.session.close"),
];
pub(crate) fn canonical(method: &str) -> Option<&'static str> {
    METHODS
        .iter()
        .find_map(|(versioned, canonical)| (*versioned == method).then_some(*canonical))
}
pub(crate) fn capabilities(handle: &Handle, ssh_available: bool) -> Value {
    let enabled = handle.enabled() && handle.current();
    serde_json::json!({"schema_version":2,"passive_query":enabled,
        "automatic_methods": if enabled && ssh_available {METHODS.iter().map(|(name,_)| *name).collect::<Vec<_>>()} else {Vec::new()},
        "query_method": QUERY})
}
impl Report {
    pub(crate) fn version2(&self) -> Option<Value> {
        let mut value = serde_json::to_value(self).ok()?;
        let object = value.as_object_mut()?;
        object.insert("schema_version".into(), 2.into());
        object.insert(
            "detail".into(),
            if self.ssh.is_some() {
                "partial"
            } else {
                "not_observed"
            }
            .into(),
        );
        object.insert("ssh".into(), serde_json::to_value(&self.ssh).ok()?);
        object.insert("next_action".into(), self.next_action().into());
        Some(value)
    }
    fn next_action(&self) -> &'static str {
        use super::trace::Stage;
        use crate::ssh::FailureReason as S;
        if let Some(failure) = self.ssh.as_ref().and_then(|s| s.access_failure) {
            return match failure {
                crate::cloudflare::Failure::Tls => "check_access_certificate",
                crate::cloudflare::Failure::Rejected => "check_access_policy",
                crate::cloudflare::Failure::Protocol => "check_access_websocket",
                crate::cloudflare::Failure::Network => "check_access_route",
            };
        }
        match self.cause {
            Cause::Ssh(S::HostKeyMismatch | S::UnsupportedHostKey) => "verify_host_key",
            Cause::Ssh(
                S::AuthenticationFailed | S::InvalidCredential | S::UnsupportedCredential,
            ) => "check_credential",
            Cause::Ssh(S::Unavailable | S::AuthorityFailure | S::ConfigurationChanged) => {
                "check_authority"
            }
            Cause::Ssh(S::ResourceExhausted | S::CredentialResourceLimit) => "check_capacity",
            Cause::Ssh(S::UnsafeDestination) => "check_destination_policy",
            Cause::File(
                crate::ssh::FileFailure::FileTooLarge | crate::ssh::FileFailure::TransferLimit,
            ) => "check_transfer_limits",
            Cause::File(_) => "check_remote_file",
            Cause::Native(_) => "inspect_native_source",
            _ if self.ssh.as_ref().is_some_and(|s| s.failed_at(Stage::Dns)) => "check_dns",
            _ if self.ssh.as_ref().is_some_and(|s| s.failed_at(Stage::Tcp)) => {
                "check_route_and_port"
            }
            _ => "inspect_operation_without_replay",
        }
    }
    pub(crate) fn legacy(&self) -> Option<Value> {
        if matches!(self.cause, Cause::File(_)) {
            return None;
        }
        serde_json::to_value(self).ok()
    }
}

pub(crate) fn failure(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some("failed")
        || value.pointer("/session/state/type").and_then(Value::as_str) == Some("failed")
}
pub(crate) fn result(
    data: &impl Serialize,
    requested: bool,
    report: Option<&Report>,
    handle: &Handle,
) -> Result<Box<RawValue>, serde_json::Error> {
    if !requested {
        return serde_json::value::to_raw_value(data);
    }
    let mut value = serde_json::to_value(data)?;
    if failure(&value) {
        let diagnostic = if handle.enabled() && handle.current() {
            match report.and_then(Report::version2) {
                Some(report) => serde_json::json!({"status":"found","report":report}),
                None => serde_json::json!({"status":"unavailable","reason":"not_recorded"}),
            }
        } else {
            serde_json::json!({"status":"unavailable","reason":"disabled"})
        };
        let object = value.as_object_mut().ok_or_else(|| {
            <serde_json::Error as serde::ser::Error>::custom("SSH result must be an object")
        })?;
        object.insert("diagnostics".into(), diagnostic);
    }
    serde_json::value::to_raw_value(&value)
}
