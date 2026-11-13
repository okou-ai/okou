package ai.okou.android

import ai.okou.android.api.generated.Agents
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.ChatSnapshot
import ai.okou.android.api.generated.FeatureSwitches
import ai.okou.android.api.generated.Indicators
import ai.okou.android.api.generated.Projects
import ai.okou.android.chat.ChatListService
import kotlinx.serialization.json.Json

/** Empty external workspace data for shell/preferences tests. */
open class TestChatService : ChatListService {
    override suspend fun featureSwitches() = FeatureSwitches(emptyMap(), emptyMap())

    override suspend fun chatSnapshot() =
        Json.decodeFromString<ChatSnapshot>(
            """{"chatThreads":[],"latestEventId":null,"latestSeqId":null}"""
        )

    override suspend fun chatArchive(url: String): ChatArchive = error("Unexpected archive request")

    override suspend fun chatEvents(since: Long?) = ChatEvents(emptyList(), false)

    override suspend fun indicators() = Indicators(emptyMap(), emptyMap(), emptyMap())

    override suspend fun agents(): Agents = emptyList()

    override suspend fun projects(): Projects = error("Unexpected projects request")
}
