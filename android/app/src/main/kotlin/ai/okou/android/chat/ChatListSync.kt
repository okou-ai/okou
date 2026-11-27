package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatSnapshot
import ai.okou.android.api.generated.ChatSnapshotVariant1
import ai.okou.android.api.generated.ChatSnapshotVariant2
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

// Matches Web's signals/chat-database/event-log-policy.ts, independently of disk capacity.
private const val CHAT_THREAD_SNAPSHOT_REBASE_THRESHOLD = 100

/** A refresh publishes only a completely checked tail, with Web's forward-progress rules. */
class ChatListSync(
    private val service: ChatListService,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) {
    data class Result(
        val checkpoint: ChatCheckpoint,
        val changed: Boolean,
        val shouldRebase: Boolean = false,
        val eventIdsBeforeRebase: Set<String> = emptySet(),
        val replacedSnapshot: Boolean = false,
    )

    suspend fun synchronize(cached: ChatCheckpoint?): Result =
        withContext(dispatcher) {
            // Like Web, an empty cursor needs a fresh snapshot: the server may have
            // compacted creations since an earlier empty cache was written.
            val useCache = cached != null && cached.cursor.seqId > 0
            val confirmed =
                tail(if (useCache) checkNotNull(cached) else snapshot(), fromSnapshot = !useCache)
            Result(
                confirmed.checkpoint,
                confirmed.changed,
                shouldRebase =
                    !confirmed.replacement &&
                        confirmed.checkpoint.events.size > CHAT_THREAD_SNAPSHOT_REBASE_THRESHOLD,
                replacedSnapshot = confirmed.replacement,
            )
        }

    /** Optional maintenance after publishing the confirmed tail. */
    suspend fun rebase(confirmed: ChatCheckpoint): Result? =
        withContext(dispatcher) {
            val snapshot =
                try {
                    val descriptor = service.chatSnapshot()
                    // Only an advancing snapshot can compact this tail.
                    if (
                        descriptor !is ChatSnapshotVariant1 ||
                            (descriptor.latestSeqId ?: 0) <= confirmed.snapshotCursor.seqId
                    )
                        return@withContext null
                    snapshot(descriptor)
                } catch (error: ApiFailure.Http) {
                    if (error.status >= 500) return@withContext null
                    throw error
                } catch (error: ChatSnapshotUnavailable) {
                    if (error.status >= 500) return@withContext null
                    throw error
                }
            val rebased = tail(snapshot, fromSnapshot = true).checkpoint
            // A lagging snapshot must not roll back a tail already confirmed in this refresh.
            if (rebased.cursor.seqId < confirmed.cursor.seqId) null
            else
                Result(
                    rebased,
                    changed = true,
                    eventIdsBeforeRebase =
                        confirmed.events.mapNotNullTo(hashSetOf()) { it.cursor().eventId },
                    replacedSnapshot = true,
                )
        }

    private suspend fun snapshot(): ChatCheckpoint = snapshot(service.chatSnapshot())

    private suspend fun snapshot(descriptor: ChatSnapshot): ChatCheckpoint {
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

    private data class SynchronizedChats(
        val checkpoint: ChatCheckpoint,
        val replacement: Boolean,
        val changed: Boolean,
    )

    private suspend fun tail(initial: ChatCheckpoint, fromSnapshot: Boolean): SynchronizedChats {
        initial.validate()
        var state = initial
        var cursor = state.cursor
        val events = state.events.toMutableList()
        val identities = events.mapTo(hashSetOf()) { checkNotNull(it.cursor().eventId) }
        state.snapshotCursor.eventId?.let { identities.add(it) }
        var replacement = fromSnapshot
        var cursorFromSnapshot = fromSnapshot
        var hasMore = true
        while (hasMore) {
            val page =
                try {
                    service.chatEvents(cursor.seqId.takeIf { it > 0 })
                } catch (error: ApiFailure.Http) {
                    if (error.status != 410 || cursorFromSnapshot) throw error
                    state = snapshot()
                    cursor = state.cursor
                    events.clear()
                    identities.clear()
                    state.snapshotCursor.eventId?.let { identities.add(it) }
                    replacement = true
                    cursorFromSnapshot = true
                    continue
                }
            // Web ignores already covered rows; hasMore still requires actual forward progress.
            val incoming = page.events.filter { it.cursor().seqId > cursor.seqId }
            requireChatWire(!page.hasMore || incoming.isNotEmpty())
            for (event in incoming) {
                val next = event.cursor()
                next.validate()
                requireChatWire(
                    next.seqId > cursor.seqId && identities.add(checkNotNull(next.eventId)),
                )
                events.add(event)
                cursor = next
            }
            if (incoming.isNotEmpty()) cursorFromSnapshot = false
            hasMore = page.hasMore
        }
        val changed = replacement || cursor != initial.cursor
        val checkpoint =
            if (changed)
                state.copy(events = events.toList(), cursor = cursor).also { it.validate() }
            else initial
        return SynchronizedChats(checkpoint, replacement, changed)
    }
}
