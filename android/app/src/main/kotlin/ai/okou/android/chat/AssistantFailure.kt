package ai.okou.android.chat

import ai.okou.android.api.generated.KnownRunFailureReason
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonIgnoreUnknownKeys
import kotlinx.serialization.json.JsonObject

sealed interface AssistantFailure {
    val id: String

    data class Run(override val id: String, val reason: String?) : AssistantFailure

    data class Output(override val id: String, val error: String) : AssistantFailure
}

enum class FailureKind {
    Unknown,
    Subscription,
    Usage,
    Capacity,
    Unavailable,
    Retryable,
    Settings,
    NewChat,
    InputTooLarge,
    Terms,
    Billing,
    OutputLimit,
    Safety,
    Timeout,
    Autonomy,
}

enum class RecoveryFramework {
    Codex,
    Claude,
}

enum class RecoveryLimit {
    FiveHour,
    Weekly,
    Model,
    Unknown,
}

data class FailureClassification(
    val kind: FailureKind,
    val framework: RecoveryFramework? = null,
    val limit: RecoveryLimit? = null,
) {
    val canContinue
        get() =
            kind !in
                setOf(
                    FailureKind.Unknown,
                    FailureKind.Settings,
                    FailureKind.NewChat,
                    FailureKind.InputTooLarge,
                    FailureKind.Safety,
                    FailureKind.Terms,
                    FailureKind.Billing,
                )
}

/** Use the existing canonical turn order, excluding automation that has not entered a turn. */
fun latestAssistantFailure(
    checkpoint: HistoryCheckpoint,
    transcript: HistoryTranscript = projectHistory(checkpoint),
): AssistantFailure? {
    val byId = checkpoint.rows.associateBy { it.id }
    val last =
        transcript.messages.lastOrNull { message ->
            if (message.queued) false
            else {
                val row = byId[message.id]
                row != null &&
                    when (row.type) {
                        "input.prompt",
                        "input.automation",
                        "input.rejected",
                        "output.error",
                        "run.failed",
                        "run.cancelled",
                        "control.interrupt" -> true
                        "output.message",
                        "run.completed" -> row.content?.isNotEmpty() == true
                        else -> false
                    }
            }
        } ?: return null
    val row = byId.getValue(last.id)
    return when (row.type) {
        "run.failed" -> AssistantFailure.Run(row.id, row.failureReason)
        "output.error" ->
            row.outputError?.takeIf { it.isNotEmpty() }?.let { AssistantFailure.Output(row.id, it) }
        else -> null
    }
}

fun classifyFailure(
    failure: AssistantFailure,
    personal: RecoveryFramework?,
): FailureClassification =
    when (failure) {
        is AssistantFailure.Run -> classifyRunFailure(failure.reason, personal)
        is AssistantFailure.Output -> classifyOutputFailure(failure.error, personal)
    }

private fun classifyRunFailure(
    reason: String?,
    personal: RecoveryFramework?,
): FailureClassification =
    when (KnownRunFailureReason.fromWireValue(reason) ?: KnownRunFailureReason.UNKNOWN) {
        KnownRunFailureReason.SESSION_HISTORY_LIMIT,
        KnownRunFailureReason.CONTEXT_WINDOW_EXCEEDED -> FailureClassification(FailureKind.NewChat)
        KnownRunFailureReason.GUEST_ROOT_FILESYSTEM_FULL,
        KnownRunFailureReason.GUEST_HOME_FILESYSTEM_FULL,
        KnownRunFailureReason.GUEST_MEMORY_OOM_KILLED,
        KnownRunFailureReason.PROVIDER_RATE_LIMITED,
        KnownRunFailureReason.PROVIDER_STREAM_TIMEOUT,
        KnownRunFailureReason.PROVIDER_REQUEST_TIMEOUT,
        KnownRunFailureReason.PROVIDER_QUEUE_TIMEOUT,
        KnownRunFailureReason.PROVIDER_SERVER_ERROR,
        KnownRunFailureReason.RESPONSE_CONNECTION_LOST,
        KnownRunFailureReason.CODEX_ACCESS_PROGRAM_UNAVAILABLE,
        KnownRunFailureReason.PROVIDER_BAD_REQUEST -> FailureClassification(FailureKind.Retryable)
        KnownRunFailureReason.EXECUTION_TIMEOUT -> FailureClassification(FailureKind.Timeout)
        KnownRunFailureReason.INSUFFICIENT_CREDITS -> FailureClassification(FailureKind.Billing)
        KnownRunFailureReason.PROVIDER_INSUFFICIENT_CREDITS,
        KnownRunFailureReason.INVALID_API_KEY,
        KnownRunFailureReason.INVALID_CREDENTIALS,
        KnownRunFailureReason.RECONNECT_REQUIRED -> FailureClassification(FailureKind.Settings)
        KnownRunFailureReason.TERMS_ACCEPTANCE_REQUIRED -> FailureClassification(FailureKind.Terms)
        KnownRunFailureReason.INPUT_TOO_LARGE,
        KnownRunFailureReason.PROVIDER_IMAGE_TOO_LARGE ->
            FailureClassification(FailureKind.InputTooLarge)
        KnownRunFailureReason.OUTPUT_TOKEN_LIMIT -> FailureClassification(FailureKind.OutputLimit)
        KnownRunFailureReason.PROVIDER_OVERLOADED -> FailureClassification(FailureKind.Capacity)
        KnownRunFailureReason.SAFETY_POLICY_REFUSAL -> FailureClassification(FailureKind.Safety)
        KnownRunFailureReason.UNSUPPORTED_MODEL,
        KnownRunFailureReason.PROVIDER_MODEL_RESTRICTED ->
            FailureClassification(FailureKind.Unavailable)
        KnownRunFailureReason.USAGE_LIMIT ->
            FailureClassification(FailureKind.Usage, personal, RecoveryLimit.Unknown)
        KnownRunFailureReason.UNKNOWN,
        KnownRunFailureReason.ACCOUNT_VERIFICATION_REQUIRED,
        KnownRunFailureReason.FIREWALL_AUTH_FAILED -> FailureClassification(FailureKind.Unknown)
    }

private fun classifyOutputFailure(
    error: String,
    personal: RecoveryFramework?,
): FailureClassification {
    // Match ECMAScript whitespace used by Web, including Unicode separators and BOM.
    val text = error.replace(Regex("[\\s\\p{Z}\\uFEFF]+"), " ").trim(' ')
    fun matches(pattern: String) = Regex(pattern, RegexOption.IGNORE_CASE).containsMatchIn(text)
    return when {
        text.lowercase() in setOf("insufficient_credits", "pro_required") ->
            FailureClassification(FailureKind.Billing)
        text == "This run reached its execution time limit." ||
            Regex("^Agent execution timed out after [1-9]\\d* seconds$").matches(text) ->
            FailureClassification(FailureKind.Timeout)
        text.uppercase() == "AUTONOMY_BUDGET_EXHAUSTED" ->
            FailureClassification(FailureKind.Autonomy)
        unsupportedCodexModel(error) ->
            FailureClassification(FailureKind.Unavailable, RecoveryFramework.Codex)
        matches("selected model is at capacity\\.? please try a different model") ->
            FailureClassification(FailureKind.Capacity, RecoveryFramework.Codex)
        matches(
            "\\bclaude\\b.*\\b(?:is overloaded|overloaded|at capacity)\\b|\\b529\\b.*\\boverload|\\boverloaded_error\\b",
        ) -> FailureClassification(FailureKind.Capacity, RecoveryFramework.Claude)
        matches("you(?:'|’)ve hit your usage limit\\b") ->
            FailureClassification(
                FailureKind.Usage,
                RecoveryFramework.Codex,
                if (matches("\\busage limit for\\b")) RecoveryLimit.Model
                else RecoveryLimit.Unknown,
            )
        matches(
            "you(?:'|’)ve hit your (?:session|weekly|5[- ]hour|opus(?:\\s+[\\w.-]+)?|sonnet(?:\\s+[\\w.-]+)?|haiku(?:\\s+[\\w.-]+)?) limit\\b|\\bclaude(?: code)? (?:rate|usage) limit reached\\b",
        ) ->
            FailureClassification(
                FailureKind.Usage,
                RecoveryFramework.Claude,
                when {
                    matches("\\bweekly\\b") -> RecoveryLimit.Weekly
                    matches("\\b(?:session|5[- ]hour)\\b") -> RecoveryLimit.FiveHour
                    matches("\\b(?:opus|sonnet|haiku)\\b") -> RecoveryLimit.Model
                    else -> RecoveryLimit.Unknown
                },
            )
        personal != null -> FailureClassification(FailureKind.Subscription, personal)
        text.contains("No model provider is available for this run", true) ->
            FailureClassification(FailureKind.Settings)
        text.contains("Provider not compatible", true) ||
            text.contains("Cannot continue session") ||
            text.contains("Invalid signature in thinking block") ->
            FailureClassification(FailureKind.NewChat)
        else -> FailureClassification(FailureKind.Unknown)
    }
}

private fun unsupportedCodexModel(text: String): Boolean {
    var start = -1
    var depth = 0
    var quoted = false
    var escaped = false
    for ((index, char) in text.withIndex()) {
        if (depth == 0) {
            if (char == '{') {
                start = index
                depth = 1
            }
            continue
        }
        if (quoted) {
            if (escaped) escaped = false
            else if (char == '\\') escaped = true else if (char == '"') quoted = false
        } else
            when (char) {
                '"' -> quoted = true
                '{' -> depth++
                '}' -> {
                    depth--
                    if (depth == 0) {
                        val objectValue =
                            try {
                                Json.parseToJsonElement(text.substring(start, index + 1))
                                    as? JsonObject
                            } catch (_: kotlinx.serialization.SerializationException) {
                                null
                            }
                        val error = objectValue?.get("error") as? JsonObject
                        if (
                            error?.text("type") == "invalid_request_error" &&
                                Regex(
                                        "^The '[^']+' model is not supported when using Codex with a ChatGPT account\\.$",
                                    )
                                    .matches(error.text("message").orEmpty())
                        )
                            return true
                    }
                }
            }
    }
    return false
}

@OptIn(ExperimentalSerializationApi::class)
@JsonIgnoreUnknownKeys
@Serializable
data class RecoverySelection(
    val threadId: String,
    val failureId: String,
    val model: String?,
    val priority: Boolean,
)
