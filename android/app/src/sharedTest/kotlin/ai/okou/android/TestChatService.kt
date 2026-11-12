package ai.okou.android

import ai.okou.android.api.generated.Agents
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.ChatSnapshot
import ai.okou.android.api.generated.FeatureSwitches
import ai.okou.android.api.generated.Indicators
import ai.okou.android.api.generated.Projects
import ai.okou.android.chat.ChatListService

/** External API fixture for shell/preferences tests where the new rollout is disabled. */
open class TestChatService : ChatListService {
    override suspend fun featureSwitches() =
        FeatureSwitches(emptyMap(), mapOf("androidChatList" to false))

    override suspend fun chatSnapshot(): ChatSnapshot = error("Unexpected snapshot request")

    override suspend fun chatArchive(url: String): ChatArchive = error("Unexpected archive request")

    override suspend fun chatEvents(since: Long?): ChatEvents = error("Unexpected events request")

    override suspend fun indicators(): Indicators = error("Unexpected indicators request")

    override suspend fun agents(): Agents = error("Unexpected agents request")

    override suspend fun projects(): Projects = error("Unexpected projects request")
}
