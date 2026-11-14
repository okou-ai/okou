package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

class ConversationHistorySync(
    private val service: ConversationHistoryService,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) {
    suspend fun synchronize(threadId: String, cached: HistoryCheckpoint?): HistoryCheckpoint =
        withContext(dispatcher) {
            // Verify this thread itself. A missing archive is a different protocol outcome.
            service.threadDetail(threadId)
            var state =
                cached?.also {
                    it.validate()
                    requireChatWire(it.threadId == threadId)
                } ?: snapshot(threadId)
            var fromSnapshot = cached == null
            var confirmColdTail = fromSnapshot
            var rebuilt = false
            val ids = state.rows.mapTo(hashSetOf()) { it.id }
            val rows = state.rows.toMutableList()
            var more = true
            while (more) {
                val page =
                    try {
                        service.historyRows(threadId, state.cursor)
                    } catch (error: ApiFailure.Http) {
                        if (error.status != 410) throw error
                        // Match Web's rejection of immediately stale snapshots, with a bounded
                        // rebuild.
                        requireChatWire(!fromSnapshot && !rebuilt)
                        state = snapshot(threadId)
                        rows.clear()
                        rows.addAll(state.rows)
                        ids.clear()
                        ids.addAll(rows.map { it.id })
                        fromSnapshot = true
                        confirmColdTail = true
                        rebuilt = true
                        continue
                    }
                var cursor = state.cursor
                for (row in page.rows) {
                    requireChatWire(
                        row.threadId == threadId && row.seqId > cursor.seqId && ids.add(row.id)
                    )
                    rows.add(row)
                    cursor = HistoryCursor(row.id, row.seqId)
                }
                page.cursor.validate()
                requireChatWire(page.cursor == cursor && (!page.hasMore || page.rows.isNotEmpty()))
                state = state.copy(cursor = cursor)
                // Web keeps cursorFromServer until this catch-up finishes.
                more = page.hasMore || confirmColdTail
                confirmColdTail = false
            }
            state.copy(rows = rows.toList()).also { it.validate() }
        }

    private suspend fun snapshot(threadId: String): HistoryCheckpoint {
        val descriptor =
            try {
                service.historySnapshot(threadId)
            } catch (error: ApiFailure.Http) {
                if (error.status != 404 || error.code != "CHAT_EVENT_SNAPSHOT_NOT_FOUND")
                    throw error
                return HistoryCheckpoint(threadId, emptyList(), HistoryCursor(), replaced = true)
            }
        val wire = historyJson.encodeToJsonElement(descriptor).jsonObject
        val cursor =
            HistoryCursor(
                wire.getValue("lastEventId").jsonPrimitive.contentOrNull,
                wire.getValue("lastSeqId").jsonPrimitive.long,
            )
        val rows = service.historyArchive(wire.getValue("url").jsonPrimitive.content)
        return HistoryCheckpoint(threadId, rows, cursor, replaced = true).also { it.validate() }
    }
}
