//! A process receipt belongs to that exact session, never to a host-latest lookup.
use super::{Manager, Response, protocol::State};
use crate::diagnostics::{Operation, Report};
use serde::Deserialize;
use uuid::Uuid;

impl Manager {
    pub(super) fn diagnostic_report(&self, raw: &str, response: &Response) -> Option<Report> {
        match response {
            Response::Status { session } | Response::Read { session, .. }
                if matches!(session.state, State::Failed { .. }) =>
            {
                self.get(session.session_id)?
                    .data
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .lifecycle
                    .diagnostic()
                    .cloned()
            }
            Response::Failed {
                failure_reason,
                effects,
                ..
            } => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Subject {
                    ssh_connection_id: Option<Uuid>,
                    session_id: Option<Uuid>,
                }
                let subject: Subject = serde_json::from_str(raw).ok()?;
                let mut observation =
                    super::super::observation::Attempt::new(&self.registration.diagnostics());
                observation.effects = Some(crate::diagnostics::EffectObservation::SessionRequest(
                    *effects,
                ));
                let connection = if let Some(id) = subject.session_id {
                    let entry = self.get(id)?;
                    let identity = entry.access.diagnostic_identity();
                    observation.created_at = identity.created_at;
                    observation.generation = identity.generation;
                    observation.native = entry.access.native_source();
                    // An independent request must not finalize the process trace.
                    observation.trace = entry.trace.fork();
                    entry.connection
                } else {
                    subject.ssh_connection_id?
                };
                observation.record(
                    &self.registration.diagnostics(),
                    connection,
                    Operation::Session,
                    subject.session_id,
                    Some(*failure_reason),
                )
            }
            _ => None,
        }
    }
}
