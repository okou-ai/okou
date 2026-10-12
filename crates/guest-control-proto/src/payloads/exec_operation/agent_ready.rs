use crate::error::ProtocolError;
use crate::read::{expect_consumed, read_u32};

/// Guest-reported component timing at the Agent-ready boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecAgentReadyTiming {
    /// Time spent creating the per-exec process-containment hierarchy.
    pub containment_create_us: u32,
    /// Time spent creating the workload and tool placement brokers.
    pub placement_broker_setup_us: u32,
    /// Time spent launching the controlled Guest Agent process.
    ///
    /// The historical `shell_spawn_us` name remains for protocol and timing-series
    /// compatibility; direct Agent launch does not execute a shell.
    pub shell_spawn_us: u32,
    /// Time after controlled Agent process launch until confirmed
    /// runtime-descriptor adoption.
    pub bootstrap_ready_wait_us: u32,
}

/// Encode the fixed-width Agent-ready timing payload.
pub fn encode_exec_agent_ready(timing: ExecAgentReadyTiming) -> Vec<u8> {
    let mut payload = Vec::with_capacity(16);
    payload.extend_from_slice(&timing.containment_create_us.to_be_bytes());
    payload.extend_from_slice(&timing.placement_broker_setup_us.to_be_bytes());
    payload.extend_from_slice(&timing.shell_spawn_us.to_be_bytes());
    payload.extend_from_slice(&timing.bootstrap_ready_wait_us.to_be_bytes());
    payload
}

/// Decode the fixed-width Agent-ready timing payload.
pub fn decode_exec_agent_ready(payload: &[u8]) -> Result<ExecAgentReadyTiming, ProtocolError> {
    let mut offset = 0;
    let containment_create_us = read_u32(
        payload,
        &mut offset,
        "exec agent ready containment timing truncated",
    )?;
    let placement_broker_setup_us = read_u32(
        payload,
        &mut offset,
        "exec agent ready broker timing truncated",
    )?;
    let shell_spawn_us = read_u32(
        payload,
        &mut offset,
        "exec agent ready shell timing truncated",
    )?;
    let bootstrap_ready_wait_us = read_u32(
        payload,
        &mut offset,
        "exec agent ready bootstrap timing truncated",
    )?;
    expect_consumed(payload, offset, "exec agent ready trailing bytes")?;
    Ok(ExecAgentReadyTiming {
        containment_create_us,
        placement_broker_setup_us,
        shell_spawn_us,
        bootstrap_ready_wait_us,
    })
}
