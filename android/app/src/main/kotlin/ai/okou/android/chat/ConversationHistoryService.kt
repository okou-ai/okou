package ai.okou.android.chat

import ai.okou.android.api.generated.HistorySnapshot
import ai.okou.android.api.generated.ReadState
import ai.okou.android.api.generated.ThreadDetail

data class HistoryPage(
    val rows: List<HistoryEvent>,
    val cursor: HistoryCursor,
    val hasMore: Boolean,
)

interface ConversationHistoryService {
    suspend fun historySnapshot(threadId: String): HistorySnapshot

    suspend fun historyArchive(url: String): List<HistoryEvent>

    suspend fun historyRows(threadId: String, cursor: HistoryCursor): HistoryPage

    suspend fun threadDetail(threadId: String): ThreadDetail

    suspend fun markRead(threadId: String): ReadState
}
