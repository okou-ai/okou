package ai.okou.android.chat

import ai.okou.android.api.generated.Agents
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.ChatSnapshot
import ai.okou.android.api.generated.FeatureSwitches
import ai.okou.android.api.generated.Indicators
import ai.okou.android.api.generated.Projects

/** A signed-storage rejection does not revoke the first-party workspace session. */
class ChatSnapshotUnavailable(val status: Int) : Exception("Chat snapshot could not be downloaded")

/** The workspace's canonical read boundary. None of these operations marks a thread read. */
interface ChatListService {
    suspend fun chatSnapshot(): ChatSnapshot

    suspend fun chatArchive(url: String): ChatArchive

    suspend fun chatEvents(since: Long?): ChatEvents

    suspend fun indicators(): Indicators

    suspend fun agents(): Agents

    suspend fun projects(): Projects

    suspend fun featureSwitches(): FeatureSwitches
}
