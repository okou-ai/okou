//! Mock implementations of all sandbox traits for testing.
//!
//! All mocks succeed by default with ordinary exit code 0 and empty output.
//! Use [`MockSandbox::push_exec_result`], [`MockSandbox::push_write_file_result`],
//! [`MockSandbox::push_private_write_file_result`],
//! [`MockSandboxControl::push_exec_remote_result`], or
//! [`MockSandboxControl::push_kill_remote_result`] to queue custom responses
//! consumed in FIFO order.
//! Results queued with [`MockSandbox::push_write_file_result`] also apply to
//! batched writes; see the method docs for details.
//!
//! For advanced control, create [`MockSandboxOverrides`] and pass it via
//! [`MockSandboxRuntime::with_overrides`]. This enables pattern-matched exec
//! results, shared read-file results, shared lifecycle behavior queues, custom
//! `wait_process` exits, and durable [`MockLifecycleGate`] gates for exec,
//! lifecycle, and cancellation testing.
//!
//! ```toml
//! [dev-dependencies]
//! sandbox-mock = { workspace = true }
//! ```

mod call_records;
mod control;
mod factory_runtime;
mod lifecycle;
mod overrides;
mod sandbox;
mod snapshot;
mod support;

pub use call_records::{
    CodexSessionCleanupCall, CopyFileCall, ExecCall, ExecMatcher, FinalizeStagedFileCall,
    GuestStateRestoreCall, GuestStateRestoreTimezoneCall, ProcessCancelCall, ProcessControlCall,
    ReadFileCall, RemoteExecCall, SessionHistoryIdentityVerifyCall, StagedFileDispositionCall,
    StartAgentProcessCall, StartProcessCall, StorageManifestCall, WaitProcessCall, WriteFileCall,
    WriteFilesCall,
};
pub use control::MockSandboxControl;
pub use factory_runtime::{MockRuntimeProvider, MockSandboxFactory, MockSandboxRuntime};
pub use lifecycle::{MockLifecycleGate, MockLifecycleGateTimeout};
pub use overrides::MockSandboxOverrides;
pub use sandbox::MockSandbox;
pub use snapshot::MockSnapshotProvider;

#[cfg(test)]
mod tests;
