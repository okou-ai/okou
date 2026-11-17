package ai.okou.android.chat

/** A complete canonical batch partition; missing cursors require individual snapshot recovery. */
data class HistoryBatch(
    val events: Map<String, List<HistoryEvent>>,
    val notFoundThreads: List<String>,
) {
    fun validate(requested: Map<String, HistoryCursor>) {
        val missing = notFoundThreads.toSet()
        requireChatWire(missing.size == notFoundThreads.size)
        requireChatWire(events.keys.intersect(missing).isEmpty())
        requireChatWire(events.keys + missing == requested.keys)
        for ((threadId, rows) in events) {
            var cursor = requested.getValue(threadId).seqId
            val ids = hashSetOf<String>()
            for (row in rows) {
                requireChatWire(row.threadId == threadId && row.seqId > cursor && ids.add(row.id))
                cursor = row.seqId
            }
        }
    }
}
