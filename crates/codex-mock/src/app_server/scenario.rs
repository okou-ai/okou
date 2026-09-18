use std::io;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Scenario {
    Success,
    DisconnectAfterInitialize,
    ExitOnTurnStart,
    ExitOnTurnStartWithStderrHolder,
    HangOnTurnStart,
    ThreadStartInputTooLarge,
    TurnStartRpcError(TurnStartRpcError),
    InterleavedNotification,
    InvalidResponseId,
    MalformedErrorResponse,
    MalformedInitializeResult,
    LargeNotificationBeforeResponse,
    HangAfterInitializeResponse,
    HangOnThreadStart,
    MalformedStdout,
    HangOnStdinEof,
    SigtermDeafOnStdinEof,
    NullIdServerRequestBeforeResponse,
    NotificationOverflow,
    OversizedStdout,
    ServerRequestBeforeResponse,
    StderrHolderOnStdinEof,
    SplitNotificationAfterThreadStart,
    UnknownResponseBeforeResponse,
    StaleTurn,
    NoActiveTurn,
    ExitOnTurnSteer,
    RuntimeTurnComplete,
    RuntimeTurnCompleteBeforeHeartbeat,
    RuntimeTurnFailed,
    RuntimeTurnFailedContextWindowExceeded,
    RuntimeTurnFailedInternalServerError,
    RuntimeTurnFailedResponseStreamConnectionFailed,
    RuntimeTurnFailedResponseStreamDisconnected,
    RuntimeTurnFailedResponseTooManyFailedAttempts,
    RuntimeTurnFailedUnauthorized,
    RuntimeTurnFailedUnknown,
    RuntimeTurnFailedContentPolicyRejection,
    RuntimeTurnFailedBiologicalRiskRejection,
    RuntimeTurnFailedBiologicalRiskInternalServerError,
    RuntimeTurnFailedInvalidRequestFormat,
    RuntimeTurnCompleteAfterSteer,
    RuntimeTurnCompleteBeforeSteerResponse,
    RuntimeTurnStartedBeforeSteer,
    WaitOnTurnSteerResponse,
    WaitForTurnInterrupt,
    HangOnTurnInterrupt,
    CompleteBeforeTurnInterrupt,
    RuntimeTurnCompleteWithoutThreadStarted,
    RuntimeTurnUsageResumeNoReplay,
    RuntimeTurnUsageResumeReplay,
    RuntimeEventFlood,
    RuntimeLargeEventFlood,
    RuntimeOversizedDelivery,
    RuntimeThreadItems,
    RuntimeMalformedThreadItem,
    ResumeDifferentThreadId,
    ResumeRpcErrorWithThreadId,
    ThreadStartInvalidThreadId,
    UnexpectedThreadOutputItemStarted,
    UnexpectedTurnOutputItemStarted,
    SecondaryThreadNotifications,
}

impl Scenario {
    pub(super) fn from_env() -> io::Result<Self> {
        match std::env::var("MOCK_CODEX_APP_SERVER_SCENARIO") {
            Ok(value) if value.is_empty() => Ok(Self::Success),
            Ok(value) => match value.as_str() {
                "disconnect-after-initialize" => Ok(Self::DisconnectAfterInitialize),
                "exit-on-turn-start" => Ok(Self::ExitOnTurnStart),
                "exit-on-turn-start-with-stderr-holder" => {
                    Ok(Self::ExitOnTurnStartWithStderrHolder)
                }
                "hang-on-turn-start" => Ok(Self::HangOnTurnStart),
                "thread-start-input-too-large" => Ok(Self::ThreadStartInputTooLarge),
                "turn-start-input-too-large" => {
                    Ok(Self::TurnStartRpcError(TurnStartRpcError::InputTooLarge))
                }
                "turn-start-input-too-large-wrong-code" => {
                    Ok(Self::TurnStartRpcError(TurnStartRpcError::WrongRpcCode))
                }
                "turn-start-input-too-large-wrong-discriminator" => Ok(Self::TurnStartRpcError(
                    TurnStartRpcError::WrongDiscriminator,
                )),
                "turn-start-input-too-large-missing-data" => {
                    Ok(Self::TurnStartRpcError(TurnStartRpcError::MissingData))
                }
                "turn-start-input-too-large-missing-max-chars" => {
                    Ok(Self::TurnStartRpcError(TurnStartRpcError::MissingMaxChars))
                }
                "turn-start-input-too-large-missing-actual-chars" => Ok(Self::TurnStartRpcError(
                    TurnStartRpcError::MissingActualChars,
                )),
                "turn-start-input-too-large-string-actual-chars" => Ok(Self::TurnStartRpcError(
                    TurnStartRpcError::StringActualChars,
                )),
                "turn-start-input-too-large-fractional-actual-chars" => Ok(
                    Self::TurnStartRpcError(TurnStartRpcError::FractionalActualChars),
                ),
                "turn-start-input-too-large-negative-max-chars" => {
                    Ok(Self::TurnStartRpcError(TurnStartRpcError::NegativeMaxChars))
                }
                "turn-start-input-too-large-zero-max-chars" => {
                    Ok(Self::TurnStartRpcError(TurnStartRpcError::ZeroMaxChars))
                }
                "turn-start-input-too-large-not-exceeded" => {
                    Ok(Self::TurnStartRpcError(TurnStartRpcError::NotExceeded))
                }
                "interleaved-notification" => Ok(Self::InterleavedNotification),
                "invalid-response-id" => Ok(Self::InvalidResponseId),
                "malformed-error-response" => Ok(Self::MalformedErrorResponse),
                "malformed-initialize-result" => Ok(Self::MalformedInitializeResult),
                "large-notification-before-response" => Ok(Self::LargeNotificationBeforeResponse),
                "hang-after-initialize-response" => Ok(Self::HangAfterInitializeResponse),
                "hang-on-thread-start" => Ok(Self::HangOnThreadStart),
                "malformed-stdout" => Ok(Self::MalformedStdout),
                "hang-on-stdin-eof" => Ok(Self::HangOnStdinEof),
                "sigterm-deaf-on-stdin-eof" => Ok(Self::SigtermDeafOnStdinEof),
                "null-id-server-request-before-response" => {
                    Ok(Self::NullIdServerRequestBeforeResponse)
                }
                "notification-overflow" => Ok(Self::NotificationOverflow),
                "oversized-stdout" => Ok(Self::OversizedStdout),
                "server-request-before-response" => Ok(Self::ServerRequestBeforeResponse),
                "stderr-holder-on-stdin-eof" => Ok(Self::StderrHolderOnStdinEof),
                "split-notification-after-thread-start" => {
                    Ok(Self::SplitNotificationAfterThreadStart)
                }
                "unknown-response-before-response" => Ok(Self::UnknownResponseBeforeResponse),
                "stale-turn" => Ok(Self::StaleTurn),
                "no-active-turn" => Ok(Self::NoActiveTurn),
                "exit-on-turn-steer" => Ok(Self::ExitOnTurnSteer),
                "runtime-turn-complete" => Ok(Self::RuntimeTurnComplete),
                "runtime-turn-complete-before-heartbeat" => {
                    Ok(Self::RuntimeTurnCompleteBeforeHeartbeat)
                }
                "runtime-turn-failed" => Ok(Self::RuntimeTurnFailed),
                "runtime-turn-failed-context-window-exceeded" => {
                    Ok(Self::RuntimeTurnFailedContextWindowExceeded)
                }
                "runtime-turn-failed-internal-server-error" => {
                    Ok(Self::RuntimeTurnFailedInternalServerError)
                }
                "runtime-turn-failed-response-stream-connection-failed" => {
                    Ok(Self::RuntimeTurnFailedResponseStreamConnectionFailed)
                }
                "runtime-turn-failed-response-stream-disconnected" => {
                    Ok(Self::RuntimeTurnFailedResponseStreamDisconnected)
                }
                "runtime-turn-failed-response-too-many-failed-attempts" => {
                    Ok(Self::RuntimeTurnFailedResponseTooManyFailedAttempts)
                }
                "runtime-turn-failed-unauthorized" => Ok(Self::RuntimeTurnFailedUnauthorized),
                "runtime-turn-failed-unknown" => Ok(Self::RuntimeTurnFailedUnknown),
                "runtime-turn-failed-content-policy-rejection" => {
                    Ok(Self::RuntimeTurnFailedContentPolicyRejection)
                }
                "runtime-turn-failed-biological-risk-rejection" => {
                    Ok(Self::RuntimeTurnFailedBiologicalRiskRejection)
                }
                "runtime-turn-failed-biological-risk-internal-server-error" => {
                    Ok(Self::RuntimeTurnFailedBiologicalRiskInternalServerError)
                }
                "runtime-turn-failed-invalid-request-format" => {
                    Ok(Self::RuntimeTurnFailedInvalidRequestFormat)
                }
                "runtime-turn-complete-after-steer" => Ok(Self::RuntimeTurnCompleteAfterSteer),
                "runtime-turn-complete-before-steer-response" => {
                    Ok(Self::RuntimeTurnCompleteBeforeSteerResponse)
                }
                "runtime-turn-started-before-steer" => Ok(Self::RuntimeTurnStartedBeforeSteer),
                "wait-on-turn-steer-response" => Ok(Self::WaitOnTurnSteerResponse),
                "wait-for-turn-interrupt" => Ok(Self::WaitForTurnInterrupt),
                "hang-on-turn-interrupt" => Ok(Self::HangOnTurnInterrupt),
                "complete-before-turn-interrupt" => Ok(Self::CompleteBeforeTurnInterrupt),
                "runtime-turn-complete-without-thread-started" => {
                    Ok(Self::RuntimeTurnCompleteWithoutThreadStarted)
                }
                "runtime-turn-usage-resume-no-replay" => Ok(Self::RuntimeTurnUsageResumeNoReplay),
                "runtime-turn-usage-resume-replay" => Ok(Self::RuntimeTurnUsageResumeReplay),
                "runtime-event-flood" => Ok(Self::RuntimeEventFlood),
                "runtime-large-event-flood" => Ok(Self::RuntimeLargeEventFlood),
                "runtime-oversized-delivery" => Ok(Self::RuntimeOversizedDelivery),
                "runtime-thread-items" => Ok(Self::RuntimeThreadItems),
                "runtime-malformed-thread-item" => Ok(Self::RuntimeMalformedThreadItem),
                "resume-different-thread-id" => Ok(Self::ResumeDifferentThreadId),
                "resume-rpc-error-with-thread-id" => Ok(Self::ResumeRpcErrorWithThreadId),
                "thread-start-invalid-thread-id" => Ok(Self::ThreadStartInvalidThreadId),
                "unexpected-thread-output-item-started" => {
                    Ok(Self::UnexpectedThreadOutputItemStarted)
                }
                "unexpected-turn-output-item-started" => Ok(Self::UnexpectedTurnOutputItemStarted),
                "secondary-thread-notifications" => Ok(Self::SecondaryThreadNotifications),
                _ => Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("unsupported MOCK_CODEX_APP_SERVER_SCENARIO={value:?}"),
                )),
            },
            Err(_) => Ok(Self::Success),
        }
    }

    pub(super) fn accepts_client_response(self) -> bool {
        matches!(
            self,
            Self::ServerRequestBeforeResponse
                | Self::NullIdServerRequestBeforeResponse
                | Self::WaitForTurnInterrupt
                | Self::HangOnTurnInterrupt
                | Self::CompleteBeforeTurnInterrupt
        )
    }

    pub(super) fn writes_turn_started_before_control(self) -> bool {
        matches!(
            self,
            Self::ExitOnTurnSteer
                | Self::NoActiveTurn
                | Self::RuntimeTurnCompleteBeforeSteerResponse
                | Self::RuntimeTurnStartedBeforeSteer
                | Self::WaitOnTurnSteerResponse
                | Self::WaitForTurnInterrupt
                | Self::HangOnTurnInterrupt
                | Self::CompleteBeforeTurnInterrupt
                | Self::StaleTurn
        )
    }

    pub(super) fn waits_for_turn_interrupt(self) -> bool {
        matches!(
            self,
            Self::WaitForTurnInterrupt
                | Self::HangOnTurnInterrupt
                | Self::CompleteBeforeTurnInterrupt
        )
    }

    pub(super) const fn turn_start_rpc_error(self) -> Option<TurnStartRpcError> {
        match self {
            Self::TurnStartRpcError(error) => Some(error),
            _ => None,
        }
    }

    pub(super) const fn turn_failure(self) -> Option<TurnFailure> {
        match self {
            Self::RuntimeTurnFailed => Some(TurnFailure::Generic),
            Self::RuntimeTurnFailedContextWindowExceeded => {
                Some(TurnFailure::ContextWindowExceeded)
            }
            Self::RuntimeTurnFailedInternalServerError => Some(TurnFailure::InternalServerError),
            Self::RuntimeTurnFailedResponseStreamConnectionFailed => {
                Some(TurnFailure::ResponseStreamConnectionFailed)
            }
            Self::RuntimeTurnFailedResponseStreamDisconnected => {
                Some(TurnFailure::ResponseStreamDisconnected)
            }
            Self::RuntimeTurnFailedResponseTooManyFailedAttempts => {
                Some(TurnFailure::ResponseTooManyFailedAttempts)
            }
            Self::RuntimeTurnFailedUnauthorized => Some(TurnFailure::Unauthorized),
            Self::RuntimeTurnFailedUnknown => Some(TurnFailure::Unknown),
            Self::RuntimeTurnFailedContentPolicyRejection => {
                Some(TurnFailure::ContentPolicyRejection)
            }
            Self::RuntimeTurnFailedBiologicalRiskRejection => {
                Some(TurnFailure::BiologicalRiskRejection)
            }
            Self::RuntimeTurnFailedBiologicalRiskInternalServerError => {
                Some(TurnFailure::BiologicalRiskInternalServerError)
            }
            Self::RuntimeTurnFailedInvalidRequestFormat => Some(TurnFailure::InvalidRequestFormat),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TurnStartRpcError {
    InputTooLarge,
    WrongRpcCode,
    WrongDiscriminator,
    MissingData,
    MissingMaxChars,
    MissingActualChars,
    StringActualChars,
    FractionalActualChars,
    NegativeMaxChars,
    ZeroMaxChars,
    NotExceeded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TurnFailure {
    Generic,
    ContextWindowExceeded,
    InternalServerError,
    ResponseStreamConnectionFailed,
    ResponseStreamDisconnected,
    ResponseTooManyFailedAttempts,
    Unauthorized,
    Unknown,
    /// Upstream content-safety rejection passed through as a raw provider
    /// envelope, with no structured `codexErrorInfo` to classify from.
    ContentPolicyRejection,
    /// Same error type and code as the rejection above, but a genuine
    /// request-shape complaint that must stay unclassified.
    InvalidRequestFormat,
    /// Provider refusal text with the generic `other` error discriminator.
    BiologicalRiskRejection,
    /// The same refusal text must not override a structured server error.
    BiologicalRiskInternalServerError,
}
