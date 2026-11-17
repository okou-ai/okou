package ai.okou.android.chat

import ai.okou.android.api.generated.SessionOutputDelta
import kotlinx.coroutines.flow.StateFlow

data class RunOutputTarget(val threadId: String, val runId: String, val generation: Long)

sealed interface RunOutputSignal {
    data class Delta(val value: SessionOutputDelta) : RunOutputSignal

    data object Discontinuity : RunOutputSignal
}

enum class RealtimePhase {
    Stopped,
    Connecting,
    Connected,
    Unavailable,
}

/** Attachment is transport readiness, never a claim that HTTP data is fresh. */
data class RealtimeSnapshot(
    val phase: RealtimePhase = RealtimePhase.Connecting,
    val revision: Long = 0,
    val failure: Exception? = null,
    val changes: ChatChanges = ChatChanges(),
)

/** Pending invalidation demand, not an event log or a replacement for canonical HTTP data. */
data class ChatChanges(
    val resync: Boolean = false,
    val list: Boolean = false,
    val indicators: Boolean = false,
    val readCursor: Boolean = false,
    val messageThreads: Set<String> = emptySet(),
    val detailThreads: Set<String> = emptySet(),
) {
    operator fun plus(other: ChatChanges) =
        ChatChanges(
            resync || other.resync,
            list || other.list,
            indicators || other.indicators,
            readCursor || other.readCursor,
            messageThreads + other.messageThreads,
            detailThreads + other.detailThreads,
        )
}

interface RealtimeService {
    /** The observing coroutine owns the SDK, subscriptions and cancellable token renewal. */
    suspend fun observeRealtime(
        target: StateFlow<RunOutputTarget?>,
        output: suspend (RunOutputTarget, RunOutputSignal) -> Unit,
        observe: suspend (RealtimeSnapshot) -> Unit,
    ): Nothing
}

internal fun chatChanges(topic: String?): ChatChanges? {
    when (topic) {
        "threadListChanged" -> return ChatChanges(list = true)
        "chatIndicatorsChanged" -> return ChatChanges(indicators = true)
        "chatThreadReadCursorUpdated" -> return ChatChanges(readCursor = true)
    }
    val name = topic?.substringBefore(':') ?: return null
    val id = topic.substringAfter(':', "")
    if (!Regex("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}").matches(id)) return null
    return when (name) {
        "chatThreadMessageCreated" -> ChatChanges(messageThreads = setOf(id))
        "chatThreadDetailChanged" -> ChatChanges(detailThreads = setOf(id))
        else -> null
    }
}
