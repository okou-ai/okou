//! Runner-authored explanations. CLI treats the bounded message as opaque text.

use super::{Cause, Handle, Report};
use serde::Serialize;
use serde_json::{Value, value::RawValue};
mod native;

impl Report {
    pub(crate) fn evidence(&self) -> Option<Value> {
        let mut value = serde_json::to_value(self).ok()?;
        value
            .as_object_mut()?
            .insert("ssh".into(), serde_json::to_value(&self.ssh).ok()?);
        Some(value)
    }

    pub(crate) fn message(&self) -> Option<String> {
        self.message_with_budget(super::MAX_REPORT_BYTES)
    }

    pub(super) fn message_with_budget(&self, budget: usize) -> Option<String> {
        let budget = budget.min(super::MAX_REPORT_BYTES);
        let text = self.render()?;
        if text.len() <= budget {
            return Some(text);
        }
        let mut compact = self.clone();
        for minimal in [false, true] {
            compact.compact(minimal);
            let text = compact.render()?;
            if text.len() <= budget {
                return Some(text);
            }
        }
        None
    }

    fn render(&self) -> Option<String> {
        let summary = match self.cause {
            Some(failure) => format!(
                "Failure: {} during {}.",
                cause(failure)?,
                words(self.operation)?
            ),
            None => format!(
                "Active check: {} connection setup passed.",
                words(self.protocol)?
            ),
        };
        let mut text = format!("{summary}\n");
        if let Some(observation) = self.effects {
            use super::EffectObservation;
            let (scope, effects) = match observation {
                EffectObservation::Command(effects) => ("command", effects),
                EffectObservation::SessionProgram(effects) => ("session program", effects),
                EffectObservation::SessionRequest(effects) => ("session request", effects),
            };
            text.push_str(&format!("Runner-observed {scope} effects: {}. This describes that operation's remote effect, independently of CLI/helper delivery uncertainty.\n", words(effects)?));
            if matches!(observation, EffectObservation::SessionRequest(_)) {
                text.push_str("Session request effects do not describe whether its existing program was started or completed.\n");
            }
        }
        self.native_summary(&mut text)?;
        text.push_str(&format!("\nNext step: {}\n", self.guidance()));
        self.native_path(&mut text)?;
        text.push_str(&format!(
            "\nEvidence:\n- Source boundary: {}; detail: {}.\n",
            words(self.stage)?,
            words(self.detail)?,
        ));
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
                if matches!(ssh.route, super::trace::Route::Tailscale)
                    && matches!(
                        step.stage,
                        super::trace::Stage::Dns
                            | super::trace::Stage::DestinationPolicy
                            | super::trace::Stage::AccessTls
                            | super::trace::Stage::AccessWebsocket
                    )
                {
                    continue;
                }
                text.push_str(&format!(
                    "- {}: {}.\n",
                    if step.stage == super::trace::Stage::Credential {
                        "credential preparation".into()
                    } else {
                        words(step.stage)?
                    },
                    words(step.status)?,
                ));
                if step.timing.elapsed_ms != 0 {
                    text.push_str(&format!("  Elapsed: {} ms.\n", step.timing.elapsed_ms));
                }
            }
        }
        if let Some(vnc) = &self.vnc {
            if let (Some(failure), Some(at)) = (vnc.first_failure, vnc.first_failure_at) {
                text.push_str(&format!("- VNC session first terminal failure: {}; observed at {}. This operation retains that source cause.\n", words(failure)?, timestamp(at)));
            }
            text.push_str(&format!(
                "- VNC RFB route: {}; authentication profile: {}; independent KDC route: {}.\n",
                vnc.route,
                observed(vnc.profile),
                observed(vnc.kdc_route)
            ));
            for (role, carrier) in [("RFB", &vnc.rfb_carrier), ("KDC", &vnc.kdc_carrier)] {
                if let Some(carrier) = carrier {
                    text.push_str(&format!(
                        "- VNC {role} carrier: configuration {}; generation {}; attempt {}; resource {}; private connection {}; stream {}; node setup {}; origin TLS {}.\n",
                        carrier.configuration_id, carrier.generation, carrier.attempt_id,
                        observed(carrier.resource_id), observed(carrier.connection_id), words(carrier.status)?,
                        carrier.node_setup.and_then(words).unwrap_or_else(|| "not observed".into()),
                        carrier.origin_tls.and_then(words).unwrap_or_else(|| "not observed".into()),
                    ));
                    if let Some(access) = &carrier.access {
                        if let Some(failure) = access.access_failure {
                            text.push_str(&format!(
                                "- VNC {role} first Cloudflare Access failure: {}.\n",
                                words(failure)?
                            ));
                        }
                        for step in &access.stages {
                            text.push_str(&format!(
                                "- VNC {role} carrier {}: {}.\n",
                                words(step.stage)?,
                                words(step.status)?
                            ));
                        }
                    }
                }
            }
            for (subject, address) in [("VNC RFB", vnc.address), ("VNC KDC", vnc.kdc_address)] {
                if let Some(address) = address {
                    text.push_str(&format!(
                        "- {subject} selected endpoint: {address}; family: {}.\n",
                        if address.is_ipv4() { "ipv4" } else { "ipv6" }
                    ));
                }
            }
            for step in &vnc.steps {
                text.push_str(&format!(
                    "- VNC {}: {}.\n",
                    words(step.stage)?,
                    words(step.status)?
                ));
                match step.elapsed_ms {
                    Some(elapsed) if step.status == super::trace::Progress::Reused => {
                        text.push_str(&format!("  Elapsed: {elapsed} ms (original setup).\n"));
                    }
                    Some(elapsed) => text.push_str(&format!("  Elapsed: {elapsed} ms.\n")),
                    None if step.status != super::trace::Progress::NotReached => {
                        text.push_str("  Timing unavailable.\n");
                    }
                    None => {}
                }
            }
            if vnc.steps.iter().any(|step| step.elapsed_ms.is_some()) {
                text.push_str("VNC elapsed times are frozen local observations; pending/unknown values cover only the observed interval.\n");
                if vnc.steps.iter().any(|step| {
                    step.status == super::trace::Progress::Reused && step.elapsed_ms.is_some()
                }) {
                    text.push_str("Reused timing describes original setup; those stages were not checked again.\n");
                }
                if vnc.steps.iter().any(|step| {
                    matches!(
                        step.stage,
                        crate::vnc::evidence::Stage::KdcTransport
                            | crate::vnc::evidence::Stage::KdcExchange
                    ) && step.elapsed_ms.is_some()
                }) {
                    text.push_str("Authentication includes nested KDC work; these stage times are not additive.\n");
                }
            }
            text.push_str(&format!("- VNC RFB error: {}; authentication stage: {}; Apple DH check: {}; generator: {}; key bytes: {}.\n",
                observed(vnc.rfb_error_code), observed(vnc.authentication_stage), observed(vnc.dh_check), observed(vnc.dh_generator), observed(vnc.dh_key_bytes)));
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
            text.push_str(&format!("- Native lifecycle first terminal observed at: {}. Node lifecycle and cleanup may complete after this operation; layered stages below are the report's captured facts.\n",
                observed(state.terminal_at.map(timestamp))));
            native_text(&mut text, "Native node", self.native_layers.as_deref())?;
            native_text(
                &mut text,
                "Native connection",
                self.native_connection.as_deref(),
            )?;
        }
        let boundary = if self.operation == super::Operation::ActiveCheck {
            "Passed stages verify check-time setup only, not later command/framebuffer/input health. Helper delivery is unconfirmed. Without an exact Attempt, latest history may identify another check."
        } else {
            "These facts were captured with the operation; no additional connectivity check was performed."
        };
        if self.truncated {
            text.push_str("\nDetail omitted to retain the incident and critical path within the report budget.\n");
            if self.vnc.is_some() {
                text.push_str("Noncritical VNC stages and timing may be omitted.\n");
            }
        }
        text.push_str(&format!(
            "\nUnknown: Pending means still waiting at observation, not a proven remote cause. Stages marked not reached, unknown or reused do not establish current health. Finer unobserved stages and the remote/network trigger remain unknown. {boundary}\n\nContext:\nRun: {}\nAssignment: {}\nAttempt: {}\nSequence: {}\nConnection: {}\nObserved at: {}\nConfiguration: created at {}; generation {}.\n",
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
        Some(text)
    }

    fn guidance(&self) -> &'static str {
        use super::trace::Stage;
        use crate::ssh::FailureReason as S;
        let Some(cause) = self.cause else {
            return "Use an ordinary operation when needed; a completed connection check does not guarantee later business work. No command, screenshot or input was performed by this check.";
        };
        if matches!(cause, Cause::Vnc(_)) {
            if self.dependencies.iter().any(|dependency| {
                matches!(
                    dependency.cause,
                    Some(Cause::Ssh(S::HostKeyMismatch | S::UnsupportedHostKey))
                )
            }) {
                return "Verify the dependency's SSH server host key through a trusted channel before updating trust; VNC credentials cannot fix an SSH trust refusal.";
            }
            if self.vnc.as_ref().is_some_and(|snapshot| {
                snapshot.steps.iter().any(|step| {
                    matches!(
                        step.stage,
                        crate::vnc::evidence::Stage::KdcTransport
                            | crate::vnc::evidence::Stage::KdcExchange
                    ) && matches!(
                        step.status,
                        super::trace::Progress::Failed | super::trace::Progress::Unknown
                    )
                })
            }) {
                return "Inspect the independently routed KDC and its authorization/source evidence. A ticket request may have been delivered; preserve its uncertainty and do not replay automatically.";
            }
        }
        if matches!(
            cause,
            Cause::Native(crate::tailscale::Failure::DomainFailed)
                | Cause::Ssh(S::NetworkFailure | S::Cancelled | S::AuthorityFailure | S::TimedOut)
                | Cause::Vnc(
                    crate::vnc::Failure::Network
                        | crate::vnc::Failure::Cancelled
                        | crate::vnc::Failure::Unavailable
                        | crate::vnc::Failure::TimedOut
                )
        ) && let Some(root) = self.native_layers.as_ref().and_then(|s| s.root)
        {
            return match root {
                crate::tailscale::evidence::Root::Startup => {
                    "Inspect the failed native provisioning/control stage and its configured authorization before any manual retry."
                }
                crate::tailscale::evidence::Root::MapStream => {
                    "Inspect the native control/map stream and its validation evidence; the remote network trigger remains unknown."
                }
                crate::tailscale::evidence::Root::Relay => {
                    "Inspect the selected native relay path and retained region/endpoint evidence; this does not prove target unavailability."
                }
                _ => {
                    "Inspect the retained native work/data-plane evidence before any manual retry; current SSH/VNC health remains unknown."
                }
            };
        }
        if matches!(
            cause,
            Cause::Ssh(S::TimedOut | S::Cancelled | S::NetworkFailure)
                | Cause::Vnc(
                    crate::vnc::Failure::TimedOut
                        | crate::vnc::Failure::Cancelled
                        | crate::vnc::Failure::Network
                )
        ) && let Some(guidance) = self.native_guidance()
        {
            return guidance;
        }
        if matches!(
            cause,
            Cause::Ssh(S::NetworkFailure) | Cause::Vnc(crate::vnc::Failure::Network)
        ) && self.native_connection.as_ref().is_some_and(|snapshot| {
            snapshot.steps.iter().any(|s| {
                matches!(
                    s.stage,
                    crate::tailscale::evidence::Stage::PeerSelection
                        | crate::tailscale::evidence::Stage::PrivateTcp
                ) && s.status == crate::tailscale::evidence::Status::Failed
            })
        }) {
            return "Inspect the selected private TCP peer/region and map authority; prior native readiness does not establish target service health.";
        }
        if let Some(failure) = self
            .ssh
            .as_ref()
            .and_then(|s| s.access_failure)
            .or_else(|| {
                let vnc = self.vnc.as_ref()?;
                [&vnc.kdc_carrier, &vnc.rfb_carrier]
                    .into_iter()
                    .flatten()
                    .find_map(|carrier| carrier.access.as_ref()?.access_failure)
            })
        {
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
        match cause {
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
            Cause::Vnc(
                crate::vnc::Failure::AuthenticationFailed | crate::vnc::Failure::InvalidCredential,
            ) => {
                "Check the configured VNC authentication profile and trusted server identity using the observed RFB stage."
            }
            Cause::Vnc(crate::vnc::Failure::UnsafeDestination) => {
                "Check the configured destination and its complete DNS answer set against the public-address policy."
            }
            Cause::Vnc(
                crate::vnc::Failure::Authority
                | crate::vnc::Failure::Unavailable
                | crate::vnc::Failure::ConfigurationChanged,
            ) => "Check current Run, chat, VNC host and dependency permissions and configuration.",
            Cause::Vnc(crate::vnc::Failure::ResourceExhausted) => {
                "Check Run and host VNC session capacity before starting another connection."
            }
            Cause::Vnc(
                crate::vnc::Failure::TimedOut
                | crate::vnc::Failure::Network
                | crate::vnc::Failure::Disconnected,
            ) => {
                "Inspect the observed VNC transport/RFB stage and server path. A timeout or disconnect alone does not identify an offline host or firewall block."
            }
            Cause::Vnc(crate::vnc::Failure::DeliveryUnknown) => {
                "Preserve the operation's unknown delivery outcome; inspect the session and take a fresh screenshot before considering another action."
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

fn native_text(
    text: &mut String,
    subject: &str,
    snapshot: Option<&crate::tailscale::evidence::Snapshot>,
) -> Option<()> {
    let Some(snapshot) = snapshot else {
        return Some(());
    };
    text.push_str(&format!(
        "- {subject} evidence: {}; terminal root: {}; relay region: {}.\n",
        snapshot.attempt_id,
        match snapshot.root {
            Some(root) => words(root)?,
            None => "not observed".into(),
        },
        observed(snapshot.region)
    ));
    for endpoint in &snapshot.endpoints {
        text.push_str(&format!(
            "- {subject} {} endpoint: {}; family: {}.\n",
            words(endpoint.role)?,
            endpoint.address,
            if endpoint.address.is_ipv4() {
                "ipv4"
            } else {
                "ipv6"
            }
        ));
    }
    for step in &snapshot.steps {
        text.push_str(&format!(
            "- {subject} {}: {}; detail: {}. Elapsed {} ms.{}\n",
            words(step.stage)?,
            words(step.status)?,
            words(step.detail)?,
            step.timing.elapsed_ms,
            native::wait_note(step.stage, step.status, snapshot),
        ));
    }
    Some(())
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
