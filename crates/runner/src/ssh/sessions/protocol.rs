use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::super::{FailureReason, output::RemoteExit};
use super::buffer;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Start {
    #[serde(deserialize_with = "hyphenated_uuid")]
    pub(super) ssh_connection_id: Uuid,
    pub(super) program: Program,
    #[serde(default)]
    pub(super) pty: bool,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Program {
    Exec { command: String },
    Shell {},
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Id {
    #[serde(deserialize_with = "hyphenated_uuid")]
    pub(super) session_id: Uuid,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Read {
    #[serde(deserialize_with = "hyphenated_uuid")]
    pub(super) session_id: Uuid,
    pub(super) cursor: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Write {
    #[serde(deserialize_with = "hyphenated_uuid")]
    pub(super) session_id: Uuid,
    #[serde(default)]
    pub(super) data_base64: String,
    #[serde(default)]
    pub(super) eof: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Signal {
    #[serde(deserialize_with = "hyphenated_uuid")]
    pub(super) session_id: Uuid,
    pub(super) signal: SignalName,
}

fn hyphenated_uuid<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Uuid, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.len() != 36 {
        return Err(serde::de::Error::custom("expected hyphenated UUID"));
    }
    value.parse().map_err(serde::de::Error::custom)
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub(super) enum SignalName {
    Int,
    Term,
    Kill,
    Hup,
    Usr1,
    Usr2,
}

impl SignalName {
    pub(super) fn remote(self) -> russh::Sig {
        match self {
            Self::Int => russh::Sig::INT,
            Self::Term => russh::Sig::TERM,
            Self::Kill => russh::Sig::KILL,
            Self::Hup => russh::Sig::HUP,
            Self::Usr1 => russh::Sig::USR1,
            Self::Usr2 => russh::Sig::Custom("USR2".into()),
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Effects {
    NotStarted,
    Unknown,
    Completed,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum State {
    Starting,
    Running,
    Finished { exit: RemoteExit },
    Failed { failure_reason: FailureReason },
}

#[derive(Serialize)]
pub(super) struct Info {
    pub(super) session_id: Uuid,
    pub(super) ssh_connection_id: Uuid,
    pub(super) generation: Option<i64>,
    pub(super) state: State,
    pub(super) effects: Effects,
    pub(super) stdin_closed: bool,
    pub(super) oldest_cursor: u64,
    pub(super) end_cursor: u64,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Response {
    Started {
        session_id: Uuid,
    },
    Sessions {
        sessions: Vec<Info>,
    },
    Status {
        session: Info,
    },
    Read {
        session: Info,
        #[serde(flatten)]
        output: buffer::Read,
    },
    Submitted {
        session_id: Uuid,
        effects: Effects,
    },
    Closed {
        session_id: Uuid,
        effects: Effects,
    },
    Rejected {
        reason: Rejection,
    },
    Failed {
        failure_reason: FailureReason,
        effects: Effects,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Rejection {
    NotRunning,
    StdinClosed,
}

impl Response {
    pub(super) fn failed(failure_reason: FailureReason, effects: Effects) -> Self {
        Self::Failed {
            failure_reason,
            effects,
        }
    }
}
