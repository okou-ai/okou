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
        let mut text = format!(
            "Failure: {} during {}.\n\nEvidence:\n- Source boundary: {}; detail: {}.\n",
            cause(self.cause)?,
            words(self.operation)?,
            words(self.stage)?,
            words(self.detail)?,
        );
        if let Some(ssh) = &self.ssh {
            text.push_str(&format!(
                "- Route: {}; transport: {}.\n",
                words(ssh.route)?,
                words(ssh.transport)?,
            ));
            if let Some(address) = ssh.selected_address {
                text.push_str(&format!("- Selected address: {address}.\n"));
            }
            if let Some(family) = ssh.address_family {
                text.push_str(&format!("- Address family: {}.\n", words(family)?));
            }
            if let Some(failure) = ssh.access_failure {
                text.push_str(&format!(
                    "- First Cloudflare Access failure: {}.\n",
                    words(failure)?,
                ));
            }
            for step in &ssh.stages {
                text.push_str(&format!(
                    "- {}: {}.\n",
                    words(step.stage)?,
                    words(step.status)?,
                ));
            }
        }
        for dependency in &self.dependencies {
            let failure = match dependency.cause {
                Some(failure) => cause(failure)?,
                None => "not observed".into(),
            };
            text.push_str(&format!(
                "- Dependency ({}): {}; cause: {failure}; configuration created at {}; generation {}.\n",
                words(dependency.protocol)?,
                dependency.connection_id,
                observed(dependency.configuration_created_at.map(timestamp)),
                observed(dependency.configuration_generation),
            ));
        }
        if let Some(native) = &self.native {
            let state = *native
                .evidence
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let terminal = match state.terminal {
                Some(failure) => words(failure)?,
                None => "not observed".into(),
            };
            let cleanup = match state.cleanup_failure {
                Some(failure) => words(failure)?,
                None => "not observed".into(),
            };
            text.push_str(&format!(
                "- Native source: configuration {}; generation {}; resource {}.\n- Native observations: ready {}; first terminal failure {terminal}; cleanup complete {}; cleanup failure {cleanup}.\n",
                native.configuration_id,
                native.generation,
                native.resource_id,
                state.ready,
                state.cleanup_complete,
            ));
        }
        text.push_str(&format!(
            "\nUnknown: Stages marked not reached, unknown or reused do not establish current health. Finer unobserved stages and the remote/network trigger remain unknown. This is retained evidence; current connectivity has not been checked.\n\nNext step: {}\n\nContext:\nRun: {}\nAssignment: {}\nAttempt: {}\nSequence: {}\nConnection: {}\nObserved at: {}\nConfiguration: created at {}; generation {}.\n",
            self.guidance(),
            self.run_id,
            self.assignment_id,
            self.attempt_id,
            self.sequence,
            self.connection_id,
            timestamp(self.observed_at),
            observed(self.configuration_created_at.map(timestamp)),
            observed(self.configuration_generation),
        ));
        if let Some(session) = self.session_id {
            text.push_str(&format!("Session: {session}\n"));
        }
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

// These names come only from finite, internally owned enums, never provider text.
fn words(value: impl Serialize) -> Option<String> {
    match serde_json::to_value(value).ok()? {
        Value::String(name) => Some(name.replace('_', " ")),
        _ => None,
    }
}

fn cause(value: Cause) -> Option<String> {
    let (source, reason) = match value {
        Cause::Ssh(reason) => ("SSH", words(reason)?),
        Cause::File(reason) => ("file", words(reason)?),
        Cause::Vnc(reason) => ("VNC", words(reason)?),
        Cause::Native(reason) => ("Tailscale", words(reason)?),
    };
    Some(format!("{source} {reason}"))
}

fn observed(value: Option<impl std::fmt::Display>) -> String {
    match value {
        Some(value) => value.to_string(),
        None => "not observed".into(),
    }
}

fn timestamp(value: chrono::DateTime<chrono::Utc>) -> String {
    value.to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
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
