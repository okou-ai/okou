package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.api.generated.KnownRunFailureReason
import androidx.annotation.StringRes

internal data class AssistantRunFailureCopy(
    @get:StringRes val title: Int,
    @get:StringRes val description: Int,
)

/** Every known case needs copy; only missing or future wire tokens normalize to unknown. */
internal fun assistantRunFailureCopy(reason: String?): AssistantRunFailureCopy =
    when (KnownRunFailureReason.fromWireValue(reason) ?: KnownRunFailureReason.UNKNOWN) {
        KnownRunFailureReason.SESSION_HISTORY_LIMIT ->
            AssistantRunFailureCopy(
                R.string.run_failure_session_history_limit_title,
                R.string.run_failure_session_history_limit_description,
            )
        KnownRunFailureReason.GUEST_ROOT_FILESYSTEM_FULL,
        KnownRunFailureReason.GUEST_HOME_FILESYSTEM_FULL ->
            AssistantRunFailureCopy(
                R.string.run_failure_guest_root_filesystem_full_title,
                R.string.run_failure_guest_root_filesystem_full_description,
            )
        KnownRunFailureReason.EXECUTION_TIMEOUT ->
            AssistantRunFailureCopy(
                R.string.run_failure_execution_timeout_title,
                R.string.run_failure_execution_timeout_description,
            )
        KnownRunFailureReason.PROVIDER_INSUFFICIENT_CREDITS ->
            AssistantRunFailureCopy(
                R.string.run_failure_provider_insufficient_credits_title,
                R.string.run_failure_provider_insufficient_credits_description,
            )
        KnownRunFailureReason.INVALID_API_KEY ->
            AssistantRunFailureCopy(
                R.string.run_failure_invalid_api_key_title,
                R.string.run_failure_invalid_api_key_description,
            )
        KnownRunFailureReason.INVALID_CREDENTIALS ->
            AssistantRunFailureCopy(
                R.string.run_failure_invalid_credentials_title,
                R.string.run_failure_invalid_credentials_description,
            )
        KnownRunFailureReason.TERMS_ACCEPTANCE_REQUIRED ->
            AssistantRunFailureCopy(
                R.string.run_failure_terms_acceptance_required_title,
                R.string.run_failure_terms_acceptance_required_description,
            )
        KnownRunFailureReason.CONTEXT_WINDOW_EXCEEDED ->
            AssistantRunFailureCopy(
                R.string.run_failure_context_window_exceeded_title,
                R.string.run_failure_context_window_exceeded_description,
            )
        KnownRunFailureReason.INPUT_TOO_LARGE ->
            AssistantRunFailureCopy(
                R.string.run_failure_input_too_large_title,
                R.string.run_failure_input_too_large_description,
            )
        KnownRunFailureReason.PROVIDER_IMAGE_TOO_LARGE ->
            AssistantRunFailureCopy(
                R.string.run_failure_provider_image_too_large_title,
                R.string.run_failure_provider_image_too_large_description,
            )
        KnownRunFailureReason.OUTPUT_TOKEN_LIMIT ->
            AssistantRunFailureCopy(
                R.string.run_failure_output_token_limit_title,
                R.string.run_failure_output_token_limit_description,
            )
        KnownRunFailureReason.PROVIDER_RATE_LIMITED ->
            AssistantRunFailureCopy(
                R.string.run_failure_provider_rate_limited_title,
                R.string.run_failure_provider_rate_limited_description,
            )
        KnownRunFailureReason.PROVIDER_OVERLOADED ->
            AssistantRunFailureCopy(
                R.string.run_failure_provider_overloaded_title,
                R.string.run_failure_provider_overloaded_description,
            )
        KnownRunFailureReason.PROVIDER_STREAM_TIMEOUT,
        KnownRunFailureReason.PROVIDER_REQUEST_TIMEOUT ->
            AssistantRunFailureCopy(
                R.string.run_failure_provider_stream_timeout_title,
                R.string.run_failure_provider_stream_timeout_description,
            )
        KnownRunFailureReason.PROVIDER_QUEUE_TIMEOUT ->
            AssistantRunFailureCopy(
                R.string.run_failure_provider_queue_timeout_title,
                R.string.run_failure_provider_queue_timeout_description,
            )
        KnownRunFailureReason.CODEX_ACCESS_PROGRAM_UNAVAILABLE ->
            AssistantRunFailureCopy(
                R.string.run_failure_codex_access_program_unavailable_title,
                R.string.run_failure_codex_access_program_unavailable_description,
            )
        KnownRunFailureReason.PROVIDER_SERVER_ERROR ->
            AssistantRunFailureCopy(
                R.string.run_failure_provider_server_error_title,
                R.string.run_failure_provider_server_error_description,
            )
        KnownRunFailureReason.RESPONSE_CONNECTION_LOST ->
            AssistantRunFailureCopy(
                R.string.run_failure_response_connection_lost_title,
                R.string.run_failure_response_connection_lost_description,
            )
        KnownRunFailureReason.SAFETY_POLICY_REFUSAL ->
            AssistantRunFailureCopy(
                R.string.run_failure_safety_policy_refusal_title,
                R.string.run_failure_safety_policy_refusal_description,
            )
        KnownRunFailureReason.RECONNECT_REQUIRED ->
            AssistantRunFailureCopy(
                R.string.run_failure_reconnect_required_title,
                R.string.run_failure_reconnect_required_description,
            )
        KnownRunFailureReason.UNSUPPORTED_MODEL ->
            AssistantRunFailureCopy(
                R.string.run_failure_unsupported_model_title,
                R.string.run_failure_unsupported_model_description,
            )
        KnownRunFailureReason.USAGE_LIMIT ->
            AssistantRunFailureCopy(
                R.string.run_failure_usage_limit_title,
                R.string.run_failure_usage_limit_description,
            )
        KnownRunFailureReason.UNKNOWN,
        KnownRunFailureReason.FIREWALL_AUTH_FAILED ->
            AssistantRunFailureCopy(
                R.string.run_failure_unknown_title,
                R.string.run_failure_unknown_description,
            )
        KnownRunFailureReason.GUEST_MEMORY_OOM_KILLED ->
            AssistantRunFailureCopy(
                R.string.run_failure_guest_memory_oom_killed_title,
                R.string.run_failure_guest_memory_oom_killed_description,
            )
        KnownRunFailureReason.INSUFFICIENT_CREDITS ->
            AssistantRunFailureCopy(
                R.string.run_failure_insufficient_credits_title,
                R.string.run_failure_insufficient_credits_description,
            )
        KnownRunFailureReason.ACCOUNT_VERIFICATION_REQUIRED ->
            AssistantRunFailureCopy(
                R.string.run_failure_account_verification_required_title,
                R.string.run_failure_account_verification_required_description,
            )
        KnownRunFailureReason.PROVIDER_BAD_REQUEST ->
            AssistantRunFailureCopy(
                R.string.run_failure_provider_bad_request_title,
                R.string.run_failure_provider_bad_request_description,
            )
        KnownRunFailureReason.PROVIDER_MODEL_RESTRICTED ->
            AssistantRunFailureCopy(
                R.string.run_failure_provider_model_restricted_title,
                R.string.run_failure_provider_model_restricted_description,
            )
    }
