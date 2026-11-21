package ai.okou.android.chat

import ai.okou.android.api.generated.IndicatorsThreadsValue

data class ChatListGroup(val project: ConfirmedProject?, val threads: List<ConfirmedChat>)

data class ProvisionalChat(val threadId: String, val projectId: String?)

internal enum class ChatRowStatus {
    Running,
    Unread,
    Muted,
    None,
}

internal fun chatRowStatus(
    indicator: IndicatorsThreadsValue?,
    muted: Boolean,
    unread: Boolean,
): ChatRowStatus =
    when {
        muted -> ChatRowStatus.Muted
        indicator == IndicatorsThreadsValue.ACTIVE -> ChatRowStatus.Running
        unread -> ChatRowStatus.Unread
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
    unreadChatIds: Set<String>,
): ProjectActivity {
    var unread = 0
    var running = 0
    for (thread in threads) {
        if (thread.muted == true) continue
        if (thread.id in unreadChatIds) unread++
        if (indicators[thread.id] == IndicatorsThreadsValue.ACTIVE) running++
    }
    return ProjectActivity(unread, running)
}

/** Replay already orders the pins first. Render a boundary only within the visible scope. */
internal fun ChatListGroup.pinnedTailIndex(hasProvisional: Boolean = false): Int {
    val firstOrdinary = threads.indexOfFirst { it.pinnedAt == null }
    return when {
        firstOrdinary > 0 -> firstOrdinary - 1
        firstOrdinary == -1 && hasProvisional -> threads.lastIndex
        else -> -1
    }
}

internal fun ChatListGroup.pinNeighbor(index: Int, step: Int): ConfirmedChat? =
    threads.getOrNull(index + step)?.takeIf { it.pinnedAt != null }

/** Hidden and archived pins retain their canonical place within the group. */
internal fun ChatListGroup.rankScope(state: ChatListUiState): List<ConfirmedChat> {
    if (project != null) return state.threads.filter { it.projectId == project.id }
    val known = state.projects.mapTo(hashSetOf()) { it.id }
    return state.threads.filter { it.projectId !in known }
}

internal data class ChatListSection(
    val group: ChatListGroup,
    val firstRow: Int,
    val foldedActivity: ProjectActivity?,
    val provisionalChats: List<ProvisionalChat>,
) {
    val foldedStatus: ChatRowStatus?
        get() = foldedActivity?.status

    val firstChatRow: Int
        get() = if (group.project == null) firstRow else firstRow + 1
}

internal fun chatListSections(
    groups: List<ChatListGroup>,
    expandedProjectIds: Set<String>,
    indicators: Map<String, IndicatorsThreadsValue>,
    unreadChatIds: Set<String>,
    provisionalByProject: Map<String?, List<ProvisionalChat>> = emptyMap(),
): List<ChatListSection> {
    var row = 0
    return groups.map { group ->
        val foldedActivity =
            if (group.project != null && group.project.id !in expandedProjectIds) {
                collapsedProjectActivity(group.threads, indicators, unreadChatIds)
            } else null
        val provisional = provisionalByProject[group.project?.id].orEmpty()
        val section = ChatListSection(group, row, foldedActivity, provisional)
        row =
            section.firstChatRow +
                if (foldedActivity == null) group.threads.size + provisional.size else 0
        section
    }
}

/** Known Projects group member threads; other threads share the workspace inbox. */
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
            ChatListFilter.Unread -> row.muted != true && state.isUnread(row.id)
        }
    }
    val projects = state.projects
    val known = projects.mapTo(hashSetOf()) { it.id }
    val byProject = visible.groupBy { it.projectId }
    val groups =
        projects.mapNotNull { project ->
            val rows = byProject[project.id].orEmpty().filter(matches)
            if (rows.isEmpty() && filter != ChatListFilter.Inbox) null
            else ChatListGroup(project, rows)
        }
    val outside = visible.filter { it.projectId !in known && matches(it) }
    return groups + ChatListGroup(null, outside)
}
