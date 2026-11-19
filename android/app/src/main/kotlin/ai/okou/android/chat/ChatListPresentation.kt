package ai.okou.android.chat

import ai.okou.android.api.generated.IndicatorsThreadsValue

data class ChatListGroup(val project: ConfirmedProject?, val threads: List<ConfirmedChat>)

internal enum class ChatRowStatus {
    Running,
    Unread,
    Muted,
    None,
}

internal fun chatRowStatus(indicator: IndicatorsThreadsValue?, muted: Boolean): ChatRowStatus =
    when {
        muted -> ChatRowStatus.Muted
        indicator == IndicatorsThreadsValue.ACTIVE -> ChatRowStatus.Running
        indicator == IndicatorsThreadsValue.UNREAD -> ChatRowStatus.Unread
        else -> ChatRowStatus.None
    }

internal data class ProjectActivity(val unread: Int, val running: Int) {
    val status: ChatRowStatus
        get() =
            when {
                unread > 0 -> ChatRowStatus.Unread
                running > 0 -> ChatRowStatus.Running
                else -> ChatRowStatus.None
            }
}

internal fun collapsedProjectActivity(
    threads: List<ConfirmedChat>,
    indicators: Map<String, IndicatorsThreadsValue>,
): ProjectActivity {
    var unread = 0
    var running = 0
    for (thread in threads) {
        when (chatRowStatus(indicators[thread.id], thread.muted == true)) {
            ChatRowStatus.Unread -> unread++
            ChatRowStatus.Running -> running++
            else -> Unit
        }
    }
    return ProjectActivity(unread, running)
}

/** Replay already orders the pins first. Render a boundary only within the visible scope. */
internal fun ChatListGroup.pinnedTailIndex(): Int {
    val firstOrdinary = threads.indexOfFirst { it.pinnedAt == null }
    return if (firstOrdinary > 0) firstOrdinary - 1 else -1
}

internal fun ChatListGroup.pinNeighbor(index: Int, step: Int): ConfirmedChat? =
    threads.getOrNull(index + step)?.takeIf { it.pinnedAt != null }

private fun ChatListUiState.listProjects() = if (projectsEnabled) projects else emptyList()

private fun ChatListUiState.defaultAgentId() = agents.firstOrNull { it.isDefaultAgent }?.agentId

private fun ConfirmedChat.isOutside(defaultAgentId: String?, knownProjects: Set<String>) =
    agentId == defaultAgentId && projectId !in knownProjects

/** Hidden and archived pins retain their canonical place within the group. */
internal fun ChatListGroup.rankScope(state: ChatListUiState): List<ConfirmedChat> {
    if (project != null) return state.threads.filter { it.projectId == project.id }
    val known = state.listProjects().mapTo(hashSetOf()) { it.id }
    val default = state.defaultAgentId()
    return state.threads.filter { it.isOutside(default, known) }
}

internal data class ChatListSection(
    val group: ChatListGroup,
    val firstRow: Int,
    val foldedActivity: ProjectActivity?,
) {
    val foldedStatus: ChatRowStatus?
        get() = foldedActivity?.status

    val firstChatRow: Int
        get() = if (group.project == null) firstRow else firstRow + 1
}

internal fun chatListSections(
    groups: List<ChatListGroup>,
    collapsed: List<String>,
    indicators: Map<String, IndicatorsThreadsValue>,
): List<ChatListSection> {
    val foldedIds = collapsed.toSet()
    var row = 0
    return groups.map { group ->
        val foldedActivity =
            if (group.project?.id in foldedIds) collapsedProjectActivity(group.threads, indicators)
            else null
        val section = ChatListSection(group, row, foldedActivity)
        row = section.firstChatRow + if (foldedActivity == null) group.threads.size else 0
        section
    }
}

/** Known Projects span agents; the inbox outside them uses the actual default agent. */
fun chatListGroups(
    state: ChatListUiState,
    filter: ChatListFilter = state.filter,
): List<ChatListGroup> {
    val visible = state.threads.filter { it.hidden != true }
    val matches: (ConfirmedChat) -> Boolean = { row ->
        when (filter) {
            ChatListFilter.Inbox -> !row.archived
            ChatListFilter.Archived -> row.archived
            ChatListFilter.Muted -> row.muted == true
            ChatListFilter.Unread ->
                row.muted != true && state.indicators?.unreadAt?.containsKey(row.id) == true
        }
    }
    val projects = state.listProjects()
    val known = projects.mapTo(hashSetOf()) { it.id }
    val byProject = visible.groupBy { it.projectId }
    val groups =
        projects.mapNotNull { project ->
            val rows = byProject[project.id].orEmpty().filter(matches)
            if (rows.isEmpty() && filter != ChatListFilter.Inbox) null
            else ChatListGroup(project, rows)
        }
    val default = state.defaultAgentId()
    val outside = visible.filter { it.isOutside(default, known) && matches(it) }
    return groups + ChatListGroup(null, outside)
}
