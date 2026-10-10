//! Owned remote history restoration or advisory retained-image verification.
//!
//! Fresh preparation may carry a generation-bound HomeCacheCandidate. Managed
//! preparation finishes before its live verifier is consumed. A retry without
//! that image discards the candidate before starting normal remote work.
//! Exact-resource SkipVerified keeps the retained metadata reader lifetime.

use std::time::Instant;

use tokio_util::sync::CancellationToken;

use super::cli_framework::effective_cli_framework;
use super::session_history_cpu::SessionHistoryCpuPool;
use super::session_history_download::{SessionHistoryMaterializer, SessionHistoryProbe};
use super::session_restore::restored_session_identity_from_context;
use super::telemetry::{RunnerPreSpawnPhase, RunnerPreSpawnTiming};
use crate::idle_pool::IdleSandboxKind;
use crate::restored_session_identity::{
    RestoredSessionIdentity, RestoredSessionIdentityMismatchReason,
};
use guest_contracts::home_cache_history::HomeCacheHistoryProofBinding;
use runner_provider::http::HttpClient;
use runner_types::types::{ExecutionContext, SandboxReuseResult};

/// Stable telemetry classification for a restore that cannot use verified
/// history already present in an idle sandbox.
///
/// Planning retains this value while the restore strategy changes. The
/// executor records it when consuming a deferred, prestarted, or home-candidate
/// plan. [`SessionHistoryRestoreFallback::StaleIdleIdentity`] is the exception:
/// it is discovered and recorded while consuming a verified-skip plan.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionHistoryRestoreFallback {
    /// No exact-session sandbox was reused; this also includes confirmed blanks.
    NonReuse,
    /// The reused idle sandbox had no parked session-history identity.
    MissingIdleIdentity,
    /// The parked identity matched the request but lacked final-metadata
    /// verification.
    UnverifiedIdleIdentity,
    /// Live verification could no longer confirm a previously verified parked
    /// identity.
    StaleIdleIdentity,
    /// The resume request could not be matched to the reused sandbox's parked
    /// session-history state.
    ///
    /// The payload retains the specific mismatch reason when one is available.
    IdentityMismatch(Option<RestoredSessionIdentityMismatchReason>),
}

impl SessionHistoryRestoreFallback {
    /// Returns the fixed telemetry action type for this fallback class.
    pub(super) const fn action_type(self) -> &'static str {
        match self {
            Self::NonReuse => "session_history_restore_fallback_non_reuse",
            Self::MissingIdleIdentity => "session_history_restore_fallback_missing_idle_identity",
            Self::UnverifiedIdleIdentity => {
                "session_history_restore_fallback_unverified_idle_identity"
            }
            Self::StaleIdleIdentity => "session_history_restore_fallback_stale_idle_identity",
            Self::IdentityMismatch(_) => "session_history_restore_fallback_identity_mismatch",
        }
    }

    /// Returns the detailed identity mismatch reason, when this classification
    /// carries one.
    pub(super) const fn identity_mismatch_reason(
        self,
    ) -> Option<RestoredSessionIdentityMismatchReason> {
        match self {
            Self::IdentityMismatch(reason) => reason,
            _ => None,
        }
    }
}

/// Owned strategy for obtaining resume-session history before agent execution.
///
/// The plan moves from post-reuse discovery through optional fresh-workspace
/// resolution and into executor consumption. Its payload owns any asynchronous
/// materializer work or verified identity needed by
/// the next stage.
#[derive(Default)]
#[must_use = "restore plans decide whether resume history download can be skipped"]
pub enum SessionHistoryRestorePlan {
    /// Use the ordinary executor path.
    ///
    /// No hash-backed restore optimization was selected. The executor creates
    /// the normal materializer when it consumes this plan.
    #[default]
    Default,
    /// Delay remote materialization until fresh-workspace preparation can probe
    /// for a matching cached proof.
    ///
    /// Home preparation replaces this with `HomeCacheCandidate` after a
    /// validated hit or `Prestarted` after a miss. The executor also accepts an
    /// unresolved value as a safety path and starts normal materialization.
    DeferredHashBacked {
        /// Classification retained until the executor consumes the resolved
        /// strategy.
        fallback: Option<SessionHistoryRestoreFallback>,
    },
    /// Use materialization work that has already started and may overlap
    /// sandbox preparation.
    ///
    /// The plan owns the materializer until the executor consumes it. Dropping
    /// an unfinished materializer cancels and aborts its task; finishing it
    /// gives cancellation priority while awaiting the result.
    Prestarted {
        /// Cancellable materializer work owned by this plan.
        materializer: SessionHistoryMaterializer,
        /// Classification recorded when the executor consumes this plan.
        fallback: Option<SessionHistoryRestoreFallback>,
    },
    /// Advisory evidence from the locked home image, not a verified hit.
    HomeCacheCandidate {
        /// Generation-owned bounded proof from image metadata.
        binding: HomeCacheHistoryProofBinding,
        /// Restore attribution retained across a miss.
        fallback: Option<SessionHistoryRestoreFallback>,
    },
    /// Skip restore only if the parked identity still verifies inside the live
    /// reused sandbox.
    ///
    /// The executor consumes the owned identity during final-metadata
    /// verification. Failed verification records the stale-identity fallback
    /// at that point and starts remote materialization.
    SkipVerified(RestoredSessionIdentity),
}

impl SessionHistoryRestorePlan {
    pub(super) async fn cancel_and_drain(self) {
        match self {
            Self::Prestarted { materializer, .. } => {
                let cancel = CancellationToken::new();
                cancel.cancel();
                let _ = materializer.finish(&cancel).await;
            }
            Self::HomeCacheCandidate { .. } => {}
            Self::Default | Self::DeferredHashBacked { .. } | Self::SkipVerified(_) => {}
        }
    }
}

/// Inputs available at the post-reuse restore-planning boundary.
///
/// The caller has already resolved resume validity, sandbox reuse, and any
/// parked identity. The builder borrows the services and request context needed
/// to start early materialization, but leaves fresh-home proof selection
/// and live sandbox verification to later stages.
pub struct SessionHistoryRestorePlanInput<'a> {
    pub http: &'a HttpClient,
    pub cpu: &'a SessionHistoryCpuPool,
    pub context: &'a ExecutionContext,
    pub cancel: CancellationToken,
    pub reuse_result: SandboxReuseResult,
    /// Actual resource kind after selection and successful unpark, not a reservation.
    pub idle_kind: Option<IdleSandboxKind>,
    pub restored_identity: Option<&'a RestoredSessionIdentity>,
    pub pre_spawn_timing: &'a mut RunnerPreSpawnTiming,
    pub probe: Option<&'a SessionHistoryProbe>,
}

/// Builds the initial restore strategy after sandbox reuse is resolved.
///
/// Absent or non-hash-backed resume state uses the ordinary `Default` path. A
/// reused sandbox can select `SkipVerified` or start a `Prestarted`
/// materializer. A confirmed blank also prestarts without changing its non-exact
/// reuse attribution. Fresh preparation produces `DeferredHashBacked` so a
/// matching local home proof gets the first opportunity.
pub fn build_session_history_restore_plan(
    input: SessionHistoryRestorePlanInput<'_>,
) -> SessionHistoryRestorePlan {
    let SessionHistoryRestorePlanInput {
        http,
        cpu,
        context,
        cancel,
        reuse_result,
        idle_kind,
        restored_identity,
        pre_spawn_timing,
        probe,
    } = input;
    let Some(resume_session) = context.resume_session.as_ref() else {
        return SessionHistoryRestorePlan::Default;
    };
    if resume_session.history_ref().is_none() {
        return SessionHistoryRestorePlan::Default;
    }

    let mut prefix_attribution = None;
    let fallback = match reuse_result {
        SandboxReuseResult::Reused => {
            let requested_identity = restored_session_identity_from_context(context);
            if let Some(requested_identity) = requested_identity {
                match restored_identity {
                    Some(restored_identity)
                        if restored_identity.is_verified_match_for_request(&requested_identity) =>
                    {
                        return SessionHistoryRestorePlan::SkipVerified(restored_identity.clone());
                    }
                    Some(restored_identity) if restored_identity == &requested_identity => {
                        if restored_identity.has_final_metadata_verification() {
                            Some(SessionHistoryRestoreFallback::IdentityMismatch(
                                restored_identity.mismatch_reason_for_request(&requested_identity),
                            ))
                        } else {
                            Some(SessionHistoryRestoreFallback::UnverifiedIdleIdentity)
                        }
                    }
                    Some(restored_identity) => {
                        let (mismatch_reason, attribution) = restored_identity
                            .mismatch_reason_and_prefix_attribution(&requested_identity);
                        prefix_attribution = attribution;
                        Some(SessionHistoryRestoreFallback::IdentityMismatch(
                            mismatch_reason,
                        ))
                    }
                    None => Some(SessionHistoryRestoreFallback::MissingIdleIdentity),
                }
            } else {
                Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                    RestoredSessionIdentityMismatchReason::MissingRequestedIdentity,
                )))
            }
        }
        SandboxReuseResult::NoReuseKey
        | SandboxReuseResult::PoolMiss
        | SandboxReuseResult::ProfileMismatch
        | SandboxReuseResult::DeviceLimitMismatch
        | SandboxReuseResult::UnparkFailed => Some(SessionHistoryRestoreFallback::NonReuse),
    };

    if reuse_result != SandboxReuseResult::Reused && idle_kind != Some(IdleSandboxKind::Blank) {
        return SessionHistoryRestorePlan::DeferredHashBacked { fallback };
    }

    let started_at = Instant::now();
    let materializer = match prefix_attribution {
        Some(prefix_attribution) => {
            SessionHistoryMaterializer::start_cancellable_with_prefix_attribution(
                http,
                cpu,
                Some(resume_session),
                effective_cli_framework(&context.cli_agent_type),
                cancel,
                probe,
                prefix_attribution,
            )
        }
        None => SessionHistoryMaterializer::start_cancellable(
            http,
            cpu,
            Some(resume_session),
            effective_cli_framework(&context.cli_agent_type),
            cancel,
            probe,
        ),
    };
    pre_spawn_timing.record_phase_elapsed(
        RunnerPreSpawnPhase::SessionHistoryMaterializerStart,
        started_at,
    );
    SessionHistoryRestorePlan::Prestarted {
        materializer,
        fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use guest_contracts::{
        codex_thread_id::canonical_codex_thread_id,
        session_history_identity::{
            SessionHistoryFramework, SessionHistoryIdentity, SessionHistoryRefKind,
            SessionHistorySourceRef,
        },
    };
    use sha2::{Digest, Sha256};

    use crate::restored_session_identity::RestoredSessionHistoryHashSizeRelationship;
    use crate::test_fixtures::execution_context::execution_context_for_test;
    use runner_provider::http::HttpClientConfig;
    use runner_types::ids::RunId;
    use runner_types::types::{
        ResumeSession, ResumeSessionHistory, ResumeSessionHistoryEncoding, ResumeSessionHistoryRef,
        ResumeSessionHistoryRefKind,
    };

    fn test_http_client() -> HttpClient {
        HttpClient::new(HttpClientConfig {
            api_url: "http://localhost".into(),
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
            runner_version: env!("CARGO_PKG_VERSION"),
        })
        .unwrap()
    }

    fn context_with_history_ref(history_hash: &str) -> ExecutionContext {
        context_with_history_ref_and_size(history_hash, 12)
    }

    fn context_with_history_ref_and_size(history_hash: &str, size: u64) -> ExecutionContext {
        let mut context = execution_context_for_test(RunId::new_v4());
        context.resume_session = Some(ResumeSession {
            cli_agent_session_id: "sess-restore-plan".into(),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: ResumeSessionHistoryRefKind::Blob,
                    hash: history_hash.into(),
                    url: "http://127.0.0.1:9/history.blob".into(),
                    encoding: ResumeSessionHistoryEncoding::Identity,
                    raw_size: size,
                    encoded_size: size,
                    download_source: None,
                },
            },
        });
        context
    }

    fn final_metadata_identity(history_hash: String, size: u64) -> RestoredSessionIdentity {
        let metadata = SessionHistoryIdentity::new(
            SessionHistoryFramework::ClaudeCode,
            hex::encode(Sha256::digest(b"sess-restore-plan")),
            SessionHistoryRefKind::Blob,
            history_hash,
            size,
            SessionHistorySourceRef::ClaudeCode {
                config_dir: "/home/user/.claude".to_string(),
                working_dir: "/home/user/workspace".to_string(),
                session_id: "sess-restore-plan".to_string(),
            },
        )
        .unwrap();
        RestoredSessionIdentity::from_final_metadata(
            metadata,
            "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json",
            "/home/user/.vm0/guest-agent/runs/previous",
        )
        .expect("finalized final identity")
    }

    fn build_plan(
        context: &ExecutionContext,
        reuse_result: SandboxReuseResult,
        restored_identity: Option<&RestoredSessionIdentity>,
    ) -> SessionHistoryRestorePlan {
        let http = test_http_client();
        let cpu = SessionHistoryCpuPool::with_capacity(1);
        let mut pre_spawn_timing = RunnerPreSpawnTiming::start_after_claim();
        build_session_history_restore_plan(SessionHistoryRestorePlanInput {
            http: &http,
            cpu: &cpu,
            context,
            cancel: CancellationToken::new(),
            reuse_result,
            idle_kind: (reuse_result == SandboxReuseResult::Reused)
                .then_some(IdleSandboxKind::Exact),
            restored_identity,
            pre_spawn_timing: &mut pre_spawn_timing,
            probe: None,
        })
    }

    #[test]
    fn restore_plan_defaults_without_hash_backed_history() {
        let mut context_without_resume = execution_context_for_test(RunId::new_v4());
        context_without_resume.resume_session = None;
        let mut context_with_inline_history = execution_context_for_test(RunId::new_v4());
        context_with_inline_history.resume_session = Some(ResumeSession::inline(
            "sess-restore-plan".into(),
            "session history".into(),
        ));

        for context in [&context_without_resume, &context_with_inline_history] {
            let plan = build_plan(context, SandboxReuseResult::Reused, None);

            assert!(matches!(plan, SessionHistoryRestorePlan::Default));
        }
    }

    #[test]
    fn restore_plan_skips_matching_finalized_final_identity() {
        let history_hash = "a".repeat(64);
        let context = context_with_history_ref_and_size(&history_hash, 12);
        let metadata_path =
            "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json";
        let restored_identity = final_metadata_identity(history_hash, 12);

        let plan = build_plan(
            &context,
            SandboxReuseResult::Reused,
            Some(&restored_identity),
        );

        match plan {
            SessionHistoryRestorePlan::SkipVerified(identity) => {
                assert_eq!(identity, restored_identity);
                assert_eq!(identity.history_size_bytes(), Some(12));
                assert_eq!(identity.final_metadata_path(), Some(metadata_path));
            }
            _ => panic!("matching finalized final identity should skip restore"),
        }
    }

    #[test]
    fn restore_plan_skips_matching_codex_finalized_final_identity() {
        let history_hash = "a".repeat(64);
        let mut context = execution_context_for_test(RunId::new_v4());
        context.cli_agent_type = "codex".into();
        context.resume_session = Some(ResumeSession {
            cli_agent_session_id: "019E9154C30470F0ADDE36EFB1BE1701".into(),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: ResumeSessionHistoryRefKind::Blob,
                    hash: history_hash.clone(),
                    url: "http://127.0.0.1:9/history.blob".into(),
                    encoding: ResumeSessionHistoryEncoding::Identity,
                    raw_size: 12,
                    encoded_size: 12,
                    download_source: None,
                },
            },
        });
        let canonical_thread_id =
            canonical_codex_thread_id("019E9154C30470F0ADDE36EFB1BE1701").unwrap();
        let metadata_path =
            "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json";
        let runtime_dir = "/home/user/.vm0/guest-agent/runs/previous";
        let metadata = SessionHistoryIdentity::new(
            SessionHistoryFramework::Codex,
            hex::encode(Sha256::digest(canonical_thread_id.as_bytes())),
            SessionHistoryRefKind::Blob,
            history_hash,
            12,
            SessionHistorySourceRef::Codex {
                sessions_dir: "/home/user/.codex/sessions".to_string(),
                thread_id: canonical_thread_id,
            },
        )
        .unwrap();
        let restored_identity =
            RestoredSessionIdentity::from_final_metadata(metadata, metadata_path, runtime_dir)
                .expect("finalized final identity");

        let plan = build_plan(
            &context,
            SandboxReuseResult::Reused,
            Some(&restored_identity),
        );

        match plan {
            SessionHistoryRestorePlan::SkipVerified(identity) => {
                assert_eq!(identity, restored_identity);
                assert_eq!(identity.history_size_bytes(), Some(12));
                assert_eq!(identity.final_metadata_path(), Some(metadata_path));
            }
            _ => panic!("matching Codex finalized final identity should skip restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_falls_back_when_matching_reused_identity_is_unverified() {
        let context = context_with_history_ref("history-hash-a");
        let restored_identity = restored_session_identity_from_context(&context).unwrap();

        let plan = build_plan(
            &context,
            SandboxReuseResult::Reused,
            Some(&restored_identity),
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::UnverifiedIdleIdentity)
                );
            }
            _ => panic!("unverified reused identity should fall back to restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_falls_back_when_matching_reused_identity_size_mismatches() {
        let history_hash = "a".repeat(64);
        let context = context_with_history_ref(&history_hash);
        let restored_identity = final_metadata_identity(history_hash, 13);

        let plan = build_plan(
            &context,
            SandboxReuseResult::Reused,
            Some(&restored_identity),
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                        RestoredSessionIdentityMismatchReason::HistorySize
                    )))
                );
            }
            _ => panic!("reused identity with mismatched size should fall back to restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_falls_back_when_reused_identity_is_missing() {
        let context = context_with_history_ref("history-hash-a");

        let plan = build_plan(&context, SandboxReuseResult::Reused, None);

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::MissingIdleIdentity)
                );
            }
            _ => panic!("missing reused identity should fall back to restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_classifies_history_hash_size_relationships() {
        let requested_hash = "a".repeat(64);
        let restored_hash = "b".repeat(64);
        let cases = [
            (
                11,
                RestoredSessionHistoryHashSizeRelationship::RequestedSmaller,
            ),
            (
                12,
                RestoredSessionHistoryHashSizeRelationship::RequestedEqual,
            ),
            (
                13,
                RestoredSessionHistoryHashSizeRelationship::RequestedLarger,
            ),
            (0, RestoredSessionHistoryHashSizeRelationship::SizeUnknown),
            (
                api_contracts::generated::constants::runners::RESUME_SESSION_HISTORY_MAX_BYTES + 1,
                RestoredSessionHistoryHashSizeRelationship::SizeUnknown,
            ),
        ];

        for (requested_size, expected_relationship) in cases {
            let context = context_with_history_ref_and_size(&requested_hash, requested_size);
            let restored_identity = final_metadata_identity(restored_hash.clone(), 12);

            let plan = build_plan(
                &context,
                SandboxReuseResult::Reused,
                Some(&restored_identity),
            );

            match plan {
                SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                    assert_eq!(
                        fallback,
                        Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                            RestoredSessionIdentityMismatchReason::HistoryHash(
                                expected_relationship
                            )
                        )))
                    );
                }
                _ => panic!("history hash mismatch should keep the prestarted restore plan"),
            }
        }
    }

    #[tokio::test]
    async fn restore_plan_classifies_unverified_history_hash_size_as_unknown() {
        let context = context_with_history_ref("history-hash-a");
        let restored_identity = RestoredSessionIdentity::claude_code_for_test("history-hash-b");

        let plan = build_plan(
            &context,
            SandboxReuseResult::Reused,
            Some(&restored_identity),
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                        RestoredSessionIdentityMismatchReason::HistoryHash(
                            RestoredSessionHistoryHashSizeRelationship::SizeUnknown
                        )
                    )))
                );
            }
            _ => panic!("unverified history hash mismatch should fall back to restore"),
        }
    }

    #[test]
    fn restore_plan_defers_hash_backed_history_for_non_reuse() {
        let context = context_with_history_ref("history-hash-a");

        let plan = build_plan(&context, SandboxReuseResult::PoolMiss, None);

        match plan {
            SessionHistoryRestorePlan::DeferredHashBacked { fallback } => {
                assert_eq!(fallback, Some(SessionHistoryRestoreFallback::NonReuse));
            }
            _ => panic!("non-reuse hash-backed history should defer materialization"),
        }
    }

    #[tokio::test]
    async fn restore_plan_classifies_session_identity_mismatch() {
        let history_hash = "a".repeat(64);
        let context = context_with_history_ref(&history_hash);
        let restored_identity = RestoredSessionIdentity::new(
            SessionHistoryFramework::ClaudeCode,
            "sess-other",
            SessionHistoryRefKind::Blob,
            history_hash,
            Some(12),
        );

        let plan = build_plan(
            &context,
            SandboxReuseResult::Reused,
            Some(&restored_identity),
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                        RestoredSessionIdentityMismatchReason::SessionIdentity
                    )))
                );
            }
            _ => panic!("mismatched session identity should fall back to restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_classifies_framework_mismatch() {
        let history_hash = "a".repeat(64);
        let context = context_with_history_ref(&history_hash);
        let restored_identity = RestoredSessionIdentity::new(
            SessionHistoryFramework::Codex,
            "sess-restore-plan",
            SessionHistoryRefKind::Blob,
            history_hash,
            Some(12),
        );

        let plan = build_plan(
            &context,
            SandboxReuseResult::Reused,
            Some(&restored_identity),
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                        RestoredSessionIdentityMismatchReason::Framework
                    )))
                );
            }
            _ => panic!("mismatched framework should fall back to restore"),
        }
    }
}
