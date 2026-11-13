package ai.okou.android

import ai.okou.android.api.generated.Agents
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.ChatSnapshot
import ai.okou.android.api.generated.FeatureSwitches
import ai.okou.android.api.generated.Indicators
import ai.okou.android.api.generated.ProjectArchive
import ai.okou.android.api.generated.ProjectEvents
import ai.okou.android.api.generated.ProjectSnapshot
import ai.okou.android.chat.ChatListService
import kotlinx.serialization.json.Json

/** Empty external workspace data for shell/preferences tests. */
open class TestChatService : ChatListService {
    override suspend fun historySnapshot(
        threadId: String
    ): ai.okou.android.api.generated.HistorySnapshot = error("Unexpected history request")

    override suspend fun historyArchive(url: String): List<ai.okou.android.chat.HistoryEvent> =
        error("Unexpected history archive")

    override suspend fun historyRows(
        threadId: String,
        cursor: ai.okou.android.chat.HistoryCursor,
    ): ai.okou.android.chat.HistoryPage = error("Unexpected history tail")

    override suspend fun threadDetail(
        threadId: String
    ): ai.okou.android.api.generated.ThreadDetail = error("Unexpected thread detail")

    override suspend fun markRead(threadId: String): ai.okou.android.api.generated.ReadState =
        error("Unexpected mark read")

    override suspend fun featureSwitches() = FeatureSwitches(emptyMap(), emptyMap())

    override suspend fun chatSnapshot() =
        Json.decodeFromString<ChatSnapshot>(
            """{"chatThreads":[],"latestEventId":null,"latestSeqId":null}"""
        )

    override suspend fun chatArchive(url: String): ChatArchive = error("Unexpected archive request")

    override suspend fun chatEvents(since: Long?) = ChatEvents(emptyList(), false)

    override suspend fun indicators() = Indicators(emptyMap(), emptyMap(), emptyMap())

    override suspend fun agents(): Agents = emptyList()

    override suspend fun projectSnapshot() =
        Json.decodeFromString<ProjectSnapshot>(
            """{"projects":[],"latestEventId":null,"latestSeqId":0}"""
        )

    override suspend fun projectArchive(url: String): ProjectArchive =
        error("Unexpected archive request")

    override suspend fun projectEvents(since: Long) = ProjectEvents(emptyList(), false)
}
