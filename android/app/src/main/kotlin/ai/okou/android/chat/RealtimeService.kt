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
    val changes: ChatChanges = ChatChanges(),
)

/** Pending invalidation demand, not an event log or a replacement for canonical HTTP data. */
data class ChatChanges(
    val resync: Boolean = false,
    val list: Boolean = false,
    val indicators: Boolean = false,
    val readCursor: Boolean = false,
    val threads: Set<String> = emptySet(),
) {
    operator fun plus(other: ChatChanges) =
        ChatChanges(
            resync || other.resync,
            list || other.list,
            indicators || other.indicators,
            readCursor || other.readCursor,
            threads + other.threads,
        )
}

interface RealtimeService {
    /** The observing coroutine owns the SDK, subscriptions and cancellable token renewal. */
    suspend fun observeRealtime(observe: suspend (RealtimeSnapshot) -> Unit): Nothing
}

internal fun chatChanges(topic: String?): ChatChanges? {
    when (topic) {
        "threadListChanged" -> return ChatChanges(list = true)
        "chatIndicatorsChanged" -> return ChatChanges(indicators = true)
        "chatThreadReadCursorUpdated" -> return ChatChanges(readCursor = true)
    }
    val prefix =
        listOf("chatThreadMessageCreated:", "chatThreadDetailChanged:").firstOrNull {
            topic?.startsWith(it) == true
        } ?: return null
    val id = checkNotNull(topic).removePrefix(prefix)
    return if (Regex("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}").matches(id))
        ChatChanges(threads = setOf(id))
    else null
}
