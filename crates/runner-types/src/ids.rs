//! Newtype wrapper for the per-job identifier used by the runner.
//!
//! Normal API jobs receive their `RunId` from the control plane, while
//! `runner local submit` allocates one locally.
//!
//! `RunId` is the server/API-facing job handle — visible on dashboards,
//! used in claim/complete/cancel. It is distinct from [`sandbox::SandboxId`]
//! which identifies the Firecracker VM workspace and survives sandbox reuse.
//!
//! `SandboxId` lives in the `sandbox` crate (not here) because sandbox
//! creation, socket paths, and workspace dirs are sandbox-crate concepts.
//! `RunId` lives here because it is purely a runner/API concept — the
//! sandbox crate has no notion of "jobs" or "runs".

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Per-job identifier supplied by the server or allocated by `runner local submit`.
/// This is what the user sees on dashboards and what API claim/complete use.
///
/// A fresh sandbox receives an independently allocated [`sandbox::SandboxId`].
/// On reuse, the sandbox keeps its existing `SandboxId` while the new job has
/// its own `RunId`. The two identifiers are not interchangeable.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RunId(Uuid);

impl RunId {
    /// Allocate a random v4 identifier for runner-local use.
    ///
    /// Normal API jobs receive their `RunId` from the control plane instead.
    pub fn new_v4() -> Self {
        Self(Uuid::new_v4())
    }

    #[cfg(test)]
    pub fn nil() -> Self {
        Self(Uuid::nil())
    }
}

impl fmt::Display for RunId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl FromStr for RunId {
    type Err = uuid::Error;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(s).map(Self)
    }
}

impl From<Uuid> for RunId {
    fn from(u: Uuid) -> Self {
        Self(u)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_transparent_roundtrip() {
        let id = RunId::new_v4();
        let json = serde_json::to_string(&id).unwrap();
        // Must serialize as a bare UUID string, not {"0":"..."}
        assert!(json.starts_with('"'), "expected bare string: {json}");
        let parsed: RunId = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, id);
    }

    #[test]
    fn display_matches_uuid() {
        let uuid = Uuid::new_v4();
        let id = RunId::from(uuid);
        assert_eq!(id.to_string(), uuid.to_string());
    }

    #[test]
    fn from_str_roundtrip() {
        let id = RunId::new_v4();
        let parsed: RunId = id.to_string().parse().unwrap();
        assert_eq!(parsed, id);
    }

    #[test]
    fn from_str_invalid() {
        assert!("not-a-uuid".parse::<RunId>().is_err());
    }
}
