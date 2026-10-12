//! Generic, operation-owned runtime tasks below the aggregate tools domain.

use std::io;

use serde::{Deserialize, Serialize};

/// Prefix for an empty, independently owned task domain.
pub const TASK_CGROUP_PREFIX: &str = "task-";

/// Opaque operation-local task identity. Never a PID or a consumer task number.
#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct TaskHandle(String);

impl TaskHandle {
    /// Allocate a fresh identity that cannot address a previously stopped task.
    pub fn generate() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }

    /// Parse only the canonical lowercase UUID representation.
    pub fn parse(value: String) -> io::Result<Self> {
        let parsed = uuid::Uuid::parse_str(&value).map_err(io::Error::other)?;
        if parsed.to_string() != value {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid task handle",
            ));
        }
        Ok(Self(value))
    }

    /// Return the canonical opaque identity, without a cgroup path.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for TaskHandle {
    type Error = io::Error;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

impl From<TaskHandle> for String {
    fn from(value: TaskHandle) -> Self {
        value.0
    }
}

/// Private startup record emitted after placement acknowledgement, before exec.
/// It does not assert application readiness or transfer waitpid ownership.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskStartup {
    /// The broker-owned stop handle.
    pub handle: TaskHandle,
    /// The launcher's PID, unchanged by its target exec.
    pub pid: u32,
}

/// Recognize exact canonical nested runtime paths, not arbitrary runtime leaves.
pub fn is_task_runtime_path(path: &str) -> bool {
    let Some((workload, _)) = path.split_once("/tools/task-") else {
        return false;
    };
    let components: Vec<_> = workload.split('/').collect();
    matches!(components.as_slice(), ["", "vm0-exec", operation, "workload"] if operation.starts_with("exec-") && operation.len() > 5)
        && owned_task_path(path, workload)
        && path.ends_with("/runtime")
}

/// Recognize an exact task node/runtime/tools/tool path owned by this workload.
/// Reject aliases, traversal and malformed identities at every nesting level.
pub fn owned_task_path(path: &str, workload: &str) -> bool {
    let prefix = format!("{workload}/tools/{TASK_CGROUP_PREFIX}");
    let Some(suffix) = path.strip_prefix(&prefix) else {
        return false;
    };
    let mut parts = suffix.split('/');
    let mut handle = parts.next();
    loop {
        if !handle.is_some_and(|handle| TaskHandle::parse(handle.to_owned()).is_ok()) {
            return false;
        }
        match parts.next() {
            None => return true,
            Some("runtime") => return parts.next().is_none(),
            Some("tools") => match parts.next() {
                None => return true,
                Some(node) if node.starts_with(TASK_CGROUP_PREFIX) => {
                    handle = node.strip_prefix(TASK_CGROUP_PREFIX);
                }
                Some(tool) => {
                    return parts.next().is_none()
                        && tool.strip_prefix("tool-").is_some_and(|id| {
                            !id.is_empty()
                                && id.len() <= 20
                                && id.bytes().all(|b| b.is_ascii_digit())
                        });
                }
            },
            _ => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_are_canonical_and_never_consumer_numbers() {
        let a = TaskHandle::generate();
        let b = TaskHandle::generate();
        assert_ne!(a, b);
        assert_eq!(TaskHandle::parse(a.as_str().into()).unwrap(), a);
        for invalid in [
            "1",
            "../runtime",
            "00000000-0000-0000-0000-00000000000A",
            "{00000000-0000-0000-0000-000000000000}",
        ] {
            assert!(TaskHandle::parse(invalid.into()).is_err());
        }
    }

    #[test]
    fn nested_paths_are_exact_and_operation_owned() {
        let w = "/vm0-exec/exec-1-2/workload";
        let task = format!("{w}/tools/task-{}", TaskHandle::generate().as_str());
        for suffix in ["", "/runtime", "/tools", "/tools/tool-1"] {
            assert!(owned_task_path(&format!("{task}{suffix}"), w));
        }
        assert!(is_task_runtime_path(&format!("{task}/runtime")));
        let child = format!("{task}/tools/task-{}", TaskHandle::generate().as_str());
        let grandchild = format!("{child}/tools/task-{}", TaskHandle::generate().as_str());
        for parent in [&child, &grandchild] {
            for suffix in ["", "/runtime", "/tools", "/tools/tool-18446744073709551615"] {
                assert!(owned_task_path(&format!("{parent}{suffix}"), w));
            }
            assert!(is_task_runtime_path(&format!("{parent}/runtime")));
            assert!(!owned_task_path(&format!("{parent}/runtime/../tools"), w));
        }
        for suffix in [
            "/",
            "/runtime/",
            "/runtime/nested",
            "/tools/tool-1/../runtime",
            "/tools/tool-",
            "/tools/task-1/runtime",
            "/tools/tool-1-2",
        ] {
            assert!(!owned_task_path(&format!("{task}{suffix}"), w));
        }
        assert!(!owned_task_path(
            &format!("{task}/runtime"),
            "/vm0-exec/exec-1-20/workload"
        ));
        assert!(!is_task_runtime_path(
            "/vm0-exec/exec-1/workload/tools/tool-1/runtime"
        ));
        assert!(!is_task_runtime_path(&format!("{task}/tools/tool-1")));
    }
}
