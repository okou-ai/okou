package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatSnapshotVariant1
import ai.okou.android.api.generated.ChatSnapshotVariant2
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

// Matches Web's shared-database/event-log-policy.ts, independently of disk capacity.
private const val CHAT_THREAD_SNAPSHOT_REBASE_THRESHOLD = 100

/** A refresh publishes only a completely checked tail; expiration can rebuild at most once. */
class ChatListSync(
    private val service: ChatListService,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) {
    suspend fun synchronize(cached: ChatCheckpoint?): ChatCheckpoint =
        withContext(dispatcher) {
            val confirmed = tail(cached ?: snapshot(), fromSnapshot = cached == null)
            if (
                confirmed.replacement ||
                    confirmed.checkpoint.events.size <= CHAT_THREAD_SNAPSHOT_REBASE_THRESHOLD
            )
                return@withContext confirmed.checkpoint
            // Catch up first. Rebase is optional maintenance, as in Web's metadata event source.
            val snapshot =
                try {
                    snapshot()
                } catch (error: ApiFailure.Http) {
                    if (error.status >= 500) return@withContext confirmed.checkpoint
                    throw error
                } catch (error: ChatSnapshotUnavailable) {
                    if (error.status >= 500) return@withContext confirmed.checkpoint
                    throw error
                }
            val rebased = tail(snapshot, fromSnapshot = true).checkpoint
            // A lagging snapshot must not roll back a tail already confirmed in this refresh.
            if (rebased.cursor.seqId < confirmed.checkpoint.cursor.seqId) confirmed.checkpoint
            else rebased
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

    private data class SynchronizedChats(val checkpoint: ChatCheckpoint, val replacement: Boolean)

    private suspend fun tail(initial: ChatCheckpoint, fromSnapshot: Boolean): SynchronizedChats {
        initial.validate()
        var state = initial
        var cursor = state.cursor
        val events = state.events.toMutableList()
        val identities = events.mapTo(hashSetOf()) { checkNotNull(it.cursor().eventId) }
        state.snapshotCursor.eventId?.let { identities.add(it) }
        var replacement = fromSnapshot
        var cursorFromSnapshot = fromSnapshot
        var rebuilt = false
        repeat(100) {
            val page =
                try {
                    service.chatEvents(cursor.seqId.takeIf { it > 0 })
                } catch (error: ApiFailure.Http) {
                    if (error.status != 410 || cursorFromSnapshot || rebuilt) throw error
                    state = snapshot()
                    cursor = state.cursor
                    events.clear()
                    identities.clear()
                    state.snapshotCursor.eventId?.let { identities.add(it) }
                    replacement = true
                    cursorFromSnapshot = true
                    rebuilt = true
                    return@repeat
                }
            // Web ignores already covered rows; hasMore still requires actual forward progress.
            val incoming = page.events.filter { it.cursor().seqId > cursor.seqId }
            requireChatWire(!page.hasMore || incoming.isNotEmpty())
            for (event in incoming) {
                val next = event.cursor()
                next.validate()
                requireChatWire(
                    next.seqId > cursor.seqId && identities.add(checkNotNull(next.eventId))
                )
                events.add(event)
                requireChatWire(events.size <= MAX_CHAT_EVENTS)
                cursor = next
            }
            if (incoming.isNotEmpty()) cursorFromSnapshot = false
            if (!page.hasMore)
                return SynchronizedChats(
                    state.copy(events = events.toList(), cursor = cursor).also { it.validate() },
                    replacement,
                )
        }
        throw ApiFailure.IncompatibleResponse()
    }
}
