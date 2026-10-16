//! Runner-authored explanations. CLI treats the bounded message as opaque text.

use super::{Cause, Handle, Report};
use serde::Serialize;
use serde_json::{Value, value::RawValue};

impl Report {
    pub(crate) fn evidence(&self) -> Option<Value> {
        let mut value = serde_json::to_value(self).ok()?;
        value
            .as_object_mut()?
            .insert("ssh".into(), serde_json::to_value(&self.ssh).ok()?);
        Some(value)
    }

    pub(crate) fn message(&self) -> Option<String> {
        let text = format!(
            "Remote failure evidence: {}. {} This is retained evidence; current connectivity has not been checked. Finer unobserved stages and the remote/network trigger remain unknown.",
            self.evidence()?,
            self.guidance()
        );
        (text.len() <= super::MAX_REPORT_BYTES).then_some(text)
    }

    fn guidance(&self) -> &'static str {
        use super::trace::Stage;
        use crate::ssh::FailureReason as S;
        if let Some(failure) = self.ssh.as_ref().and_then(|s| s.access_failure) {
            return match failure {
                crate::cloudflare::Failure::Tls => {
                    "Check the Access gateway certificate and TLS trust."
                }
                crate::cloudflare::Failure::Rejected => {
                    "Check the Cloudflare Access service token and application policy."
                }
                crate::cloudflare::Failure::Protocol => {
                    "Check the Access WebSocket upgrade and binary carrier."
                }
                crate::cloudflare::Failure::Network => {
                    "Check the Cloudflare Access gateway route and availability."
                }
            };
        }
        match self.cause {
            Cause::Ssh(S::HostKeyMismatch | S::UnsupportedHostKey) => {
                "Verify the server host key through a trusted channel before updating trust."
            }
            Cause::Ssh(
                S::AuthenticationFailed | S::InvalidCredential | S::UnsupportedCredential,
            ) => "Check the configured SSH credential and allowed authentication method.",
            Cause::Ssh(S::Unavailable | S::AuthorityFailure | S::ConfigurationChanged) => {
                "Check current Run, chat and host access and configuration."
            }
            Cause::Ssh(S::ResourceExhausted | S::CredentialResourceLimit) => {
                "Check Run and host connection capacity."
            }
            Cause::Ssh(S::UnsafeDestination) => {
                "Check that the configured destination resolves only to permitted addresses."
            }
            Cause::File(
                crate::ssh::FileFailure::FileTooLarge | crate::ssh::FileFailure::TransferLimit,
            ) => "Check file size and concurrent transfer limits.",
            Cause::File(_) => "Check the remote path, permissions and file-operation outcome.",
            Cause::Native(_) => {
                "Inspect the retained native source before starting another operation."
            }
            _ if self.ssh.as_ref().is_some_and(|s| s.failed_at(Stage::Dns)) => {
                "Check destination DNS resolution."
            }
            _ if self.ssh.as_ref().is_some_and(|s| s.failed_at(Stage::Tcp)) => {
                "Check the selected address, route and SSH port."
            }
            _ => "Inspect the operation and its effects before any manual retry.",
        }
    }
}

pub(crate) fn result(
    data: &impl Serialize,
    report: Option<&Report>,
    handle: &Handle,
) -> Result<Box<RawValue>, serde_json::Error> {
    if !handle.enabled() || !handle.current() {
        return serde_json::value::to_raw_value(data);
    }
    let mut value = serde_json::to_value(data)?;
    let failed = value.get("type").and_then(Value::as_str) == Some("failed")
        || value.pointer("/session/state/type").and_then(Value::as_str) == Some("failed");
    if failed {
        let message = report.and_then(Report::message).unwrap_or_else(|| {
            "Diagnostic explanation unavailable: exact evidence for this operation was not retained. Current connectivity has not been checked.".into()
        });
        let object = value.as_object_mut().ok_or_else(|| {
            <serde_json::Error as serde::ser::Error>::custom("SSH result must be an object")
        })?;
        object.insert("diagnostic_text".into(), message.into());
    }
    serde_json::value::to_raw_value(&value)
}
