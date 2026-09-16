//! Provider-neutral sandbox traits and shared types.
//!
//! This crate defines the API used by runners and higher-level orchestration
//! code to create, control, snapshot, and tear down isolated execution
//! environments. It does not start a sandbox by itself; concrete providers
//! implement these traits in separate crates.
//!
//! The main extension points are:
//!
//! - [`SandboxRuntime`], which owns provider-wide resources and creates
//!   [`SandboxFactory`] instances.
//! - [`SandboxFactory`], which creates and destroys [`Sandbox`] instances.
//! - [`Sandbox`], which represents a running isolated environment.
//! - [`SandboxControl`], which exposes host-side control operations.
//! - [`SnapshotProvider`], which creates provider-specific snapshots.
//!
//! Configuration, result, and error types are shared here so provider crates
//! can expose a consistent lifecycle and failure model.

mod config;
mod control;
mod dns_readiness;
mod error;
mod factory;
mod guest_rpc;
mod runtime;
mod sandbox;
mod snapshot;
mod types;

pub use config::{
    BlockRateLimits, DeviceRateLimits, FactoryConfig, HostCpuPlacementConfig, HostCpuPlacementMode,
    NetworkRateLimits, ResourceLimits, RuntimeConfig, SandboxConfig, SandboxId, SnapshotRef,
    WorkspaceDriveConfig, WorkspaceDriveSeedImage,
};
pub use control::{
    RemoteExecResult, RemoteKillResult, SandboxControl, SandboxControlError, SandboxControlTarget,
};
pub use dns_readiness::{SandboxDnsReadinessAttempt, SandboxDnsReadinessOutcome};
pub use error::{
    Result, SandboxError, SandboxGuestDnsReadinessReason, SandboxIdleTransition,
    SandboxInitializationPhase, SandboxInvalidStateContext, SandboxOperation,
    SandboxOperationReason, SandboxOperationTimeoutStage, SandboxOperationWriteStage,
};
pub use factory::{
    SandboxCreateObserver, SandboxCreateStage, SandboxFactory, SandboxNbdCowCreateOutcome,
    SandboxNbdCowCreateStage, SandboxNbdNetlinkConnectStage,
};
pub use guest_rpc::{AcceptedGuestRpc, GuestRpcAcceptor, GuestRpcStream};
pub use runtime::{RuntimeProvider, SandboxRuntime};
pub use sandbox::{
    FileCompression, GuestMemorySnapshot, Sandbox, SandboxFinalExecParkHandoff,
    SandboxFinalExecParkHandoffOutcome, SandboxFinalExecParkHandoffPoint,
    SandboxFinalExecParkObserver, SandboxFinalExecParkOutcome, SandboxFinalExecParkStage,
    SandboxFinalExecParkSubstage, SandboxFinalExecParkSubstageOutcome, SandboxGuestConnectionPhase,
    SandboxParkNonReusableReason, SandboxParkOutcome, SandboxStartObserver, SandboxStartStage,
    SevereMemoryRetentionDiagnostics,
};
pub use snapshot::{
    PendingSnapshotPublish, SnapshotCreateConfig, SnapshotError, SnapshotOutput, SnapshotProvider,
};
pub use types::{
    CodexSessionCleanupRequest, CopyFileOptions, CopyFileResult, DEFAULT_PROCESS_START_TIMEOUT,
    EXEC_OUTPUT_LIMIT_1_MIB, EXEC_OUTPUT_LIMIT_7_MIB, EXEC_OUTPUT_LIMIT_64_KIB, ExecOutputLimits,
    ExecRequest, ExecResult, ExecTermination, GuestAgentProcessHandle, GuestAgentStartTiming,
    GuestProcessCancelHandle, GuestProcessControlHandle, GuestProcessControlOutcomeFuture,
    GuestProcessHandle, GuestProcessWaiter, GuestStateRestoreRequest, GuestStateRestoreTimezone,
    ProcessControlAck, ProcessControlFailureKind, ProcessControlGuestStatus, ProcessControlOutcome,
    ProcessControlWriteState, ProcessExit, ProcessOutputChunk, ProcessOutputMode,
    ProcessOutputReceiver, SessionHistoryIdentityVerifyRequest, StartAgentProcessRequest,
    StartProcessRequest, StorageManifestRequest, WriteFileEntry,
};
