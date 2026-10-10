//! Bounded version-one managed task protocol on a separate placement endpoint.

use std::io::{self, Read, Write};

use guest_contracts::managed_task::{TaskHandle, TaskStartup};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

const VERSION: u8 = 1;
const MAX_FRAME: usize = 4096;

/// Derive a companion endpoint without changing the existing tool wire ABI.
pub fn endpoint(tool_endpoint: &str) -> String {
    format!("{tool_endpoint}-tasks")
}

/// One authenticated task request. No caller-selected cgroup or resource policy.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum TaskRequest {
    /// Allocate and place the connecting launcher before target execution.
    Launch {},
    /// Fence and empty only the domain identified by this operation-owned handle.
    Stop {
        /// Opaque task identity returned at launch.
        handle: TaskHandle,
    },
}

/// Admission/stop response. A launch record precedes descriptor transfer and ACK.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum TaskReply {
    /// Allocated identity, not application readiness; placement still follows.
    Ready {
        /// Private startup metadata.
        task: TaskStartup,
    },
    /// The owned subtree is empty and removed.
    Stopped {},
    /// No successful target launch/stop may be inferred from this response.
    Rejected {
        /// Bounded error text, never the abstract endpoint capability.
        diagnostic: String,
    },
}

/// Write a bounded task request.
pub fn write_request(stream: &mut impl Write, request: &TaskRequest) -> io::Result<()> {
    write_frame(stream, request)
}

/// Read and validate a bounded task request.
pub fn read_request(stream: &mut impl Read) -> io::Result<TaskRequest> {
    read_frame(stream)
}

/// Write a bounded task response.
pub fn write_reply(stream: &mut impl Write, reply: &TaskReply) -> io::Result<()> {
    write_frame(stream, reply)
}

/// Read and validate a bounded task response.
pub fn read_reply(stream: &mut impl Read) -> io::Result<TaskReply> {
    read_frame(stream)
}

fn write_frame(stream: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    let payload = serde_json::to_vec(value).map_err(io::Error::other)?;
    if payload.len() >= MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "task frame too large",
        ));
    }
    stream.write_all(&((payload.len() + 1) as u32).to_be_bytes())?;
    stream.write_all(&[VERSION])?;
    stream.write_all(&payload)
}

fn read_frame<T: DeserializeOwned>(stream: &mut impl Read) -> io::Result<T> {
    let mut length = [0; 4];
    stream.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if !(2..=MAX_FRAME).contains(&length) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid task frame size",
        ));
    }
    let mut version = [0; 1];
    stream.read_exact(&mut version)?;
    if version != [VERSION] {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported task protocol version",
        ));
    }
    let mut payload = vec![0; length - 1];
    stream.read_exact(&mut payload)?;
    serde_json::from_slice(&payload)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_keeps_launch_stop_and_private_metadata_separate() {
        let handle = TaskHandle::generate();
        let mut bytes = Vec::new();
        write_request(&mut bytes, &TaskRequest::Launch {}).unwrap();
        assert!(matches!(
            read_request(&mut bytes.as_slice()).unwrap(),
            TaskRequest::Launch {}
        ));
        bytes.clear();
        write_request(
            &mut bytes,
            &TaskRequest::Stop {
                handle: handle.clone(),
            },
        )
        .unwrap();
        assert!(
            matches!(read_request(&mut bytes.as_slice()).unwrap(), TaskRequest::Stop { handle: actual } if actual == handle)
        );
        bytes.clear();
        let task = TaskStartup { handle, pid: 123 };
        write_reply(&mut bytes, &TaskReply::Ready { task: task.clone() }).unwrap();
        assert!(
            matches!(read_reply(&mut bytes.as_slice()).unwrap(), TaskReply::Ready { task: actual } if actual == task)
        );
        bytes.clear();
        write_reply(&mut bytes, &TaskReply::Stopped {}).unwrap();
        assert!(matches!(
            read_reply(&mut bytes.as_slice()).unwrap(),
            TaskReply::Stopped {}
        ));
    }

    #[test]
    fn invalid_frames_fail_before_allocation_or_payload_read() {
        for size in [0_u32, 1, MAX_FRAME as u32 + 1, u32::MAX] {
            assert_eq!(
                read_request(&mut size.to_be_bytes().as_slice())
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidData
            );
        }
        assert!(read_request(&mut b"\0\0\0\x02\x02{}".as_slice()).is_err());
        for payload in [
            r#"{"op":"launch","path":"/runtime"}"#,
            r#"{"op":"stop","handle":"1"}"#,
            r#"{"op":"unknown"}"#,
        ] {
            let mut frame = ((payload.len() + 1) as u32).to_be_bytes().to_vec();
            frame.push(VERSION);
            frame.extend_from_slice(payload.as_bytes());
            assert!(read_request(&mut frame.as_slice()).is_err());
        }
        assert!(
            write_reply(
                &mut Vec::new(),
                &TaskReply::Rejected {
                    diagnostic: "x".repeat(MAX_FRAME)
                }
            )
            .is_err()
        );
    }
}
