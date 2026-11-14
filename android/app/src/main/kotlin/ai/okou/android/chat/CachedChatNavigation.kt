package ai.okou.android.chat

import ai.okou.android.api.generated.Agents

data class CachedChatNavigation(val agents: Agents? = null, val projectsEnabled: Boolean = false) {
    fun validate() {
        agents?.let { records ->
            requireChatWire(
                records.map { it.agentId }.distinct().size == records.size &&
                    records.count { it.isDefaultAgent } <= 1
            )
            records.forEach { requireChatId(it.agentId) }
        }
    }
}
