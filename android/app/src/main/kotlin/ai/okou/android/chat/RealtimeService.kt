package ai.okou.android.chat

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
)

interface RealtimeService {
    /** The observing coroutine owns the SDK, subscriptions and cancellable token renewal. */
    suspend fun observeRealtime(observe: suspend (RealtimeSnapshot) -> Unit): Nothing
}

internal fun isChatInvalidation(topic: String?): Boolean {
    if (topic in setOf("threadListChanged", "chatIndicatorsChanged", "chatThreadReadCursorUpdated"))
        return true
    val prefix =
        listOf("chatThreadMessageCreated:", "chatThreadDetailChanged:").firstOrNull {
            topic?.startsWith(it) == true
        } ?: return false
    return Regex("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
        .matches(checkNotNull(topic).removePrefix(prefix))
}
