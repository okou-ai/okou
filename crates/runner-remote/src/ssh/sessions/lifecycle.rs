//! A retained terminal result owns the state, evidence and age read by callers.

use tokio::time::Instant;

use super::{
    RETENTION,
    protocol::{Effects, State},
};
use crate::{
    diagnostics::Report,
    ssh::{FailureReason, output::RemoteExit},
};

pub(super) enum Lifecycle {
    Starting { effects: Effects },
    Running,
    Terminal(Box<TerminalReceipt>),
}

pub(super) struct TerminalReceipt {
    outcome: Result<RemoteExit, FailureReason>,
    completed_at: Instant,
    effects: Effects,
    diagnostic: Option<Report>,
}

impl Lifecycle {
    pub(super) fn state(&self) -> State {
        match self {
            Self::Starting { .. } => State::Starting,
            Self::Running => State::Running,
            Self::Terminal(receipt) => match &receipt.outcome {
                Ok(exit) => State::Finished { exit: exit.clone() },
                Err(reason) => State::Failed {
                    failure_reason: *reason,
                },
            },
        }
    }

    pub(super) fn effects(&self) -> Effects {
        match self {
            Self::Starting { effects } => *effects,
            Self::Running => Effects::Unknown,
            Self::Terminal(receipt) => receipt.effects,
        }
    }

    pub(super) fn is_running(&self) -> bool {
        matches!(self, Self::Running)
    }

    pub(super) fn is_terminal(&self) -> bool {
        matches!(self, Self::Terminal(_))
    }

    pub(super) fn expired(&self, now: Instant) -> bool {
        matches!(self, Self::Terminal(receipt) if now.duration_since(receipt.completed_at) >= RETENTION)
    }

    pub(super) fn diagnostic(&self) -> Option<&Report> {
        match self {
            Self::Terminal(receipt) => receipt.diagnostic.as_ref(),
            Self::Starting { .. } | Self::Running => None,
        }
    }

    pub(super) fn complete(
        &mut self,
        outcome: &Result<RemoteExit, FailureReason>,
        diagnostic: Option<Report>,
    ) {
        let effects = self.effects_for(outcome);
        *self = Self::Terminal(Box::new(TerminalReceipt {
            outcome: outcome.clone(),
            completed_at: Instant::now(),
            effects,
            diagnostic,
        }));
    }

    pub(super) fn effects_for(&self, outcome: &Result<RemoteExit, FailureReason>) -> Effects {
        if outcome.is_ok() {
            Effects::Completed
        } else {
            self.effects()
        }
    }
}
