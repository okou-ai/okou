package ai.okou.android.chat

import ai.okou.android.api.generated.Agents
import ai.okou.android.api.generated.ProjectsProjectsItem

data class CachedChatNavigation(
    val agents: Agents? = null,
    val projects: List<ProjectsProjectsItem>? = null,
    val projectsEnabled: Boolean = false,
) {
    fun validate() {
        agents?.let { records ->
            requireChatWire(
                records.size <= MAX_CHAT_THREADS &&
                    records.map { it.agentId }.distinct().size == records.size &&
                    records.count { it.isDefaultAgent } <= 1
            )
            records.forEach { requireChatId(it.agentId) }
        }
        projects?.let { records ->
            requireChatWire(
                records.size <= MAX_CHAT_THREADS &&
                    records.map { it.id }.distinct().size == records.size
            )
            records.forEach {
                requireChatId(it.id)
                chatTime(it.createdAt)
            }
        }
    }
}
