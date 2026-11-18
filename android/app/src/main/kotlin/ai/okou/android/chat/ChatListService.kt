package ai.okou.android.chat

import ai.okou.android.api.generated.Agents
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.ChatSnapshot
import ai.okou.android.api.generated.FeatureSwitches
import ai.okou.android.api.generated.Indicators
import ai.okou.android.api.generated.ProjectArchive
import ai.okou.android.api.generated.ProjectEvents
import ai.okou.android.api.generated.ProjectSnapshot
import ai.okou.android.api.generated.ReadState

/** A signed-storage rejection does not revoke the first-party workspace session. */
class ChatSnapshotUnavailable(val status: Int) : Exception("Chat snapshot could not be downloaded")

/** The workspace list reads and explicit read cursor commands. */
interface ChatListService : ConversationHistoryService {
    suspend fun markUnread(threadId: String): ReadState

    suspend fun historyCatchUp(cursors: Map<String, HistoryCursor>): HistoryBatch

    suspend fun chatSnapshot(): ChatSnapshot

    suspend fun chatArchive(url: String): ChatArchive

    suspend fun chatEvents(since: Long?): ChatEvents

    suspend fun indicators(): Indicators

    suspend fun agents(): Agents

    suspend fun projectSnapshot(): ProjectSnapshot

    suspend fun projectArchive(url: String): ProjectArchive

    suspend fun projectEvents(since: Long): ProjectEvents

    suspend fun featureSwitches(): FeatureSwitches
}
