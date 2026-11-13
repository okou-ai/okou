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

/** A signed-storage rejection does not revoke the first-party workspace session. */
class ChatSnapshotUnavailable(val status: Int) : Exception("Chat snapshot could not be downloaded")

/** The workspace's canonical read boundary. None of these operations marks a thread read. */
interface ChatListService {
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
