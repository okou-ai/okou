use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use sandbox::{
    ExecOutputLimits, ExecTermination, GuestProcessCancelHandle, GuestProcessHandle, ProcessExit,
    ProcessOutputMode, Sandbox, SandboxError, SandboxOperation, SandboxOperationTimeoutStage,
    SandboxOperationWriteStage, StartProcessRequest,
};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::cli_framework::EffectiveCliFramework;
use super::effective_cli_framework;
use crate::telemetry::JobTelemetry;
use crate::types::{ExecutionContext, FirewallEntry, SandboxReuseResult};

const PREFETCH_ACTION: &str = "runner_codex_model_catalog_prefetch";
const CODEX_OAUTH_FIREWALL: &str = "model-provider:codex-oauth-token";
pub(super) const PREFETCH_HOST_START_TIMEOUT: Duration = Duration::from_secs(1);
const PREFETCH_GUEST_TIMEOUT: Duration = Duration::from_secs(10);
const PREFETCH_HOST_WAIT_TIMEOUT: Duration = Duration::from_secs(18);
const PREFETCH_CANCEL_WRITE_TIMEOUT: Duration = Duration::from_secs(1);
const PREFETCH_STDERR_LIMIT_BYTES: u32 = 4 * 1024;

const PREFETCH_COMMAND: &str = r#"set -eu
version_output="$(codex --version)"
case "$version_output" in
  "codex-cli "*) client_version="${version_output#codex-cli }" ;;
  *) exit 64 ;;
esac
[ -n "$client_version" ] && [ "${#client_version}" -le 128 ] || exit 64
case "$client_version" in
  *[!0-9A-Za-z.+_-]*) exit 64 ;;
esac
exec curl \
  --fail \
  --silent \
  --show-error \
  --connect-timeout 3 \
  --max-time 8 \
  --max-filesize 1048576 \
  --output /dev/null \
  --header 'X-Okou-Codex-Model-Catalog-Prefetch: 1' \
  --get \
  --data-urlencode "client_version=$client_version" \
  'https://chatgpt.com/backend-api/codex/models'
"#;

type PrefetchWait<'a> = Pin<Box<dyn Future<Output = sandbox::Result<ProcessExit>> + Send + 'a>>;

struct PrefetchOutcome {
    duration: Duration,
    success: bool,
    error: Option<&'static str>,
}

pub(super) enum CodexModelCatalogPrefetchStart {
    Usable(StartedCodexModelCatalogPrefetch),
    SandboxUnusable(UnusableCodexModelCatalogPrefetchStart),
}

pub(super) struct UnusableCodexModelCatalogPrefetchStart {
    error: SandboxError,
    started_at: Instant,
    outcome: &'static str,
}

pub(super) struct StartedCodexModelCatalogPrefetch {
    handle: Option<GuestProcessHandle>,
    cancel: Option<GuestProcessCancelHandle>,
    wait_deadline: Option<Instant>,
    started_at: Instant,
    outcome: Option<PrefetchOutcome>,
    recorded: bool,
}

pub(super) struct CodexModelCatalogPrefetch<'a> {
    wait: Option<PrefetchWait<'a>>,
    cancel: Option<GuestProcessCancelHandle>,
    started_at: Instant,
    outcome: Option<PrefetchOutcome>,
    recorded: bool,
}

impl StartedCodexModelCatalogPrefetch {
    pub(super) async fn start(
        sandbox: &dyn Sandbox,
        context: &ExecutionContext,
        reuse_result: SandboxReuseResult,
        cancel: &CancellationToken,
    ) -> CodexModelCatalogPrefetchStart {
        let started_at = Instant::now();
        if !is_eligible(context, reuse_result) {
            return CodexModelCatalogPrefetchStart::Usable(Self::disabled_at(started_at));
        }
        if cancel.is_cancelled() {
            return CodexModelCatalogPrefetchStart::Usable(Self::without_process(
                started_at,
                Some(PrefetchOutcome {
                    duration: started_at.elapsed(),
                    success: false,
                    error: Some("start_cancelled"),
                }),
            ));
        }

        let request = StartProcessRequest {
            cmd: PREFETCH_COMMAND,
            timeout: PREFETCH_GUEST_TIMEOUT,
            timeout_is_expected: true,
            start_timeout: PREFETCH_HOST_START_TIMEOUT,
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(ExecOutputLimits::separate(
                0,
                PREFETCH_STDERR_LIMIT_BYTES,
            )),
        };
        let result = sandbox.start_process(&request).await;

        match result {
            Ok(mut handle) => {
                let process_cancel = handle.take_cancel_handle();
                let outcome = cancel.is_cancelled().then(|| PrefetchOutcome {
                    duration: started_at.elapsed(),
                    success: false,
                    error: Some("start_cancelled"),
                });
                CodexModelCatalogPrefetchStart::Usable(Self {
                    handle: Some(handle),
                    cancel: process_cancel,
                    wait_deadline: Some(Instant::now() + PREFETCH_HOST_WAIT_TIMEOUT),
                    started_at,
                    outcome,
                    recorded: false,
                })
            }
            Err(error) if is_safe_start_timeout(&error) => {
                warn!("timed out before writing Codex model catalog prefetch start request");
                CodexModelCatalogPrefetchStart::Usable(Self::without_process(
                    started_at,
                    Some(PrefetchOutcome {
                        duration: started_at.elapsed(),
                        success: false,
                        error: Some("start_timed_out"),
                    }),
                ))
            }
            Err(error) if is_unusable_sandbox_start_timeout(&error) => {
                info!(error = %error, "Codex model catalog prefetch start timed out after write boundary");
                CodexModelCatalogPrefetchStart::SandboxUnusable(
                    UnusableCodexModelCatalogPrefetchStart {
                        error,
                        started_at,
                        outcome: "start_timed_out",
                    },
                )
            }
            Err(
                error @ SandboxError::OperationWrite {
                    operation: SandboxOperation::StartProcess,
                    stage: SandboxOperationWriteStage::FrameWrite,
                    ..
                },
            ) => {
                info!(error = %error, "Codex model catalog prefetch start write failed after write boundary");
                CodexModelCatalogPrefetchStart::SandboxUnusable(
                    UnusableCodexModelCatalogPrefetchStart {
                        error,
                        started_at,
                        outcome: "start_failed",
                    },
                )
            }
            Err(error) => {
                warn!(error = %error, "failed to start Codex model catalog prefetch");
                CodexModelCatalogPrefetchStart::Usable(Self::without_process(
                    started_at,
                    Some(PrefetchOutcome {
                        duration: started_at.elapsed(),
                        success: false,
                        error: Some("start_failed"),
                    }),
                ))
            }
        }
    }

    pub(super) fn disabled() -> Self {
        Self::disabled_at(Instant::now())
    }

    pub(super) fn supervise(self, sandbox: &dyn Sandbox) -> CodexModelCatalogPrefetch<'_> {
        let wait = self.handle.map(|handle| {
            let timeout = self
                .wait_deadline
                .map(|deadline| deadline.saturating_duration_since(Instant::now()))
                .unwrap_or(Duration::ZERO);
            Box::pin(sandbox.wait_process(handle, timeout)) as PrefetchWait<'_>
        });
        CodexModelCatalogPrefetch {
            wait,
            cancel: self.cancel,
            started_at: self.started_at,
            outcome: self.outcome,
            recorded: self.recorded,
        }
    }

    pub(super) async fn finish(self, sandbox: &dyn Sandbox, telemetry: &mut JobTelemetry) {
        self.supervise(sandbox).finish(telemetry).await;
    }

    fn without_process(started_at: Instant, outcome: Option<PrefetchOutcome>) -> Self {
        Self {
            handle: None,
            cancel: None,
            wait_deadline: None,
            started_at,
            outcome,
            recorded: false,
        }
    }

    fn disabled_at(started_at: Instant) -> Self {
        Self::without_process(started_at, None)
    }
}

impl UnusableCodexModelCatalogPrefetchStart {
    pub(super) fn record_and_into_error(self, telemetry: &mut JobTelemetry) -> SandboxError {
        telemetry.record(
            PREFETCH_ACTION,
            self.started_at.elapsed(),
            false,
            Some(self.outcome),
        );
        self.error
    }
}

fn is_safe_start_timeout(error: &SandboxError) -> bool {
    matches!(
        error,
        SandboxError::OperationTimeout {
            operation: SandboxOperation::StartProcess,
            stage: SandboxOperationTimeoutStage::BeforeFrameWrite,
            ..
        }
    )
}

fn is_unusable_sandbox_start_timeout(error: &SandboxError) -> bool {
    matches!(
        error,
        SandboxError::OperationTimeout {
            operation: SandboxOperation::StartProcess,
            stage: SandboxOperationTimeoutStage::FrameWrite
                | SandboxOperationTimeoutStage::AwaitingTerminalResponse,
            ..
        }
    )
}

impl<'a> CodexModelCatalogPrefetch<'a> {
    pub(super) async fn race<T>(&mut self, phase: impl Future<Output = T>) -> T {
        let Some(wait) = self.wait.as_mut() else {
            return phase.await;
        };
        tokio::pin!(phase);
        tokio::select! {
            result = wait => {
                self.wait = None;
                self.cancel = None;
                self.complete(result);
                phase.await
            }
            result = &mut phase => result,
        }
    }

    pub(super) fn record_outcome(&mut self, telemetry: &mut JobTelemetry) {
        if self.recorded {
            return;
        }
        let Some(outcome) = self.outcome.as_ref() else {
            return;
        };
        telemetry.record(
            PREFETCH_ACTION,
            outcome.duration,
            outcome.success,
            outcome.error,
        );
        self.recorded = true;
    }

    pub(super) async fn finish(mut self, telemetry: &mut JobTelemetry) {
        if let Some(result) = self
            .wait
            .as_mut()
            .and_then(|wait| wait.as_mut().now_or_never())
        {
            self.wait = None;
            self.cancel = None;
            self.complete(result);
        }
        if self.wait.is_some() {
            if let Some(cancel) = self.cancel.take()
                && let Err(error) = cancel.cancel(PREFETCH_CANCEL_WRITE_TIMEOUT).await
            {
                warn!(error = %error, "failed to cancel Codex model catalog prefetch");
            }
            if let Some(wait) = self.wait.take() {
                self.complete(wait.await);
            }
        }
        self.record_outcome(telemetry);
    }

    fn complete(&mut self, result: sandbox::Result<ProcessExit>) {
        let duration = result
            .as_ref()
            .ok()
            .and_then(|exit| exit.guest_duration_ms)
            .map(|duration_ms| Duration::from_millis(u64::from(duration_ms)))
            .unwrap_or_else(|| self.started_at.elapsed());
        let (success, error) = match result {
            Ok(exit) => match exit.termination {
                ExecTermination::Exited { exit_code: 0 } => (true, None),
                ExecTermination::Exited { .. } => (false, Some("process_exit")),
                ExecTermination::TimedOut => (false, Some("process_timed_out")),
                ExecTermination::Cancelled => (false, Some("process_cancelled")),
                ExecTermination::StartFailed => (false, Some("process_start_failed")),
                ExecTermination::WaitFailed => (false, Some("process_wait_failed")),
            },
            Err(_) => (false, Some("wait_failed")),
        };
        self.outcome = Some(PrefetchOutcome {
            duration,
            success,
            error,
        });
    }
}

pub(super) fn is_eligible(context: &ExecutionContext, reuse_result: SandboxReuseResult) -> bool {
    reuse_result != SandboxReuseResult::Reused
        && effective_cli_framework(&context.cli_agent_type) == EffectiveCliFramework::Codex
        && context.codex_runtime_config.is_none()
        && context
            .encrypted_secrets
            .as_deref()
            .is_some_and(|encrypted| !encrypted.is_empty())
        && has_codex_oauth_firewall(context)
}

fn has_codex_oauth_firewall(context: &ExecutionContext) -> bool {
    context.firewalls.as_ref().is_some_and(|firewalls| {
        firewalls.iter().any(|firewall| {
            matches!(
                firewall,
                FirewallEntry::Builtin { name, .. } if name == CODEX_OAUTH_FIREWALL
            )
        })
    })
}
