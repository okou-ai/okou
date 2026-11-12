package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatSnapshotVariant1
import ai.okou.android.api.generated.ChatSnapshotVariant2
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** A refresh publishes only a completely checked tail; expiration can rebuild at most once. */
class ChatListSync(
    private val service: ChatListService,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) {
    suspend fun synchronize(cached: ChatCheckpoint?): ChatCheckpoint =
        withContext(dispatcher) {
            var state =
                if (cached == null || cached.events.size > 200) snapshot()
                else cached.also { it.validate() }
            try {
                tail(state)
            } catch (error: ApiFailure.Http) {
                if (error.status != 410) throw error
                state = snapshot()
                // A second 410 escapes; no retry loop or stale success.
                tail(state)
            }
        }

    private suspend fun snapshot(): ChatCheckpoint {
        val descriptor = service.chatSnapshot()
        val archive: ChatArchive
        val cursor: ChatCursor
        when (descriptor) {
            is ChatSnapshotVariant1 -> {
                cursor = ChatCursor(descriptor.latestEventId, descriptor.latestSeqId ?: 0)
                cursor.validate()
                requireChatWire(descriptor.expiresInSeconds > 0)
                archive = service.chatArchive(descriptor.url)
            }
            is ChatSnapshotVariant2 -> {
                cursor = ChatCursor()
                archive = ChatArchive(emptyList())
            }
        }
        return ChatCheckpoint(archive, cursor, emptyList(), cursor).also { it.validate() }
    }

    private suspend fun tail(initial: ChatCheckpoint): ChatCheckpoint {
        var cursor = initial.cursor
        val events = initial.events.toMutableList()
        val identities = events.mapTo(hashSetOf()) { checkNotNull(it.cursor().eventId) }
        initial.snapshotCursor.eventId?.let { identities.add(it) }
        repeat(100) {
            val page = service.chatEvents(cursor.seqId.takeIf { it > 0 })
            requireChatWire(!page.hasMore || page.events.isNotEmpty())
            for (event in page.events) {
                val next = event.cursor()
                next.validate()
                requireChatWire(
                    next.seqId > cursor.seqId && identities.add(checkNotNull(next.eventId))
                )
                events.add(event)
                requireChatWire(events.size <= MAX_CHAT_EVENTS)
                cursor = next
            }
            if (!page.hasMore)
                return initial.copy(events = events.toList(), cursor = cursor).also {
                    it.validate()
                }
        }
        throw ApiFailure.IncompatibleResponse()
    }
}
