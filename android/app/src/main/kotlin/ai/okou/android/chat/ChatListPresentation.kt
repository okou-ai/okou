package ai.okou.android.chat

import ai.okou.android.api.generated.IndicatorsThreadsValue

data class ChatListGroup(val project: ConfirmedProject?, val threads: List<ConfirmedChat>)

/** Known Projects span agents; the inbox outside them uses the actual default agent. */
fun chatListGroups(state: ChatListUiState): List<ChatListGroup> {
    val visible = state.threads.filter { it.hidden != true }
    val matches: (ConfirmedChat) -> Boolean = { row ->
        when (state.filter) {
            ChatListFilter.Recent -> !row.archived
            ChatListFilter.Archived -> row.archived
            ChatListFilter.Muted -> row.muted == true
            ChatListFilter.Unread ->
                row.muted != true &&
                    state.indicators?.threads?.get(row.id) == IndicatorsThreadsValue.UNREAD
        }
    }
    val projects = if (state.projectsEnabled) state.projects else emptyList()
    val known = projects.mapTo(hashSetOf()) { it.id }
    val byProject = visible.groupBy { it.projectId }
    val groups =
        projects.mapNotNull { project ->
            val rows = byProject[project.id].orEmpty().filter(matches)
            if (rows.isEmpty() && state.filter != ChatListFilter.Recent) null
            else ChatListGroup(project, rows)
        }
    val default = state.agents.firstOrNull { it.isDefaultAgent }?.agentId
    val outside = visible.filter { it.agentId == default && it.projectId !in known && matches(it) }
    return groups + ChatListGroup(null, outside)
}
