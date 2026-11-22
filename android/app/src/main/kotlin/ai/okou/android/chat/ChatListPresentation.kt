package ai.okou.android.chat

import ai.okou.android.api.generated.IndicatorsThreadsValue

data class ChatListGroup(
    val project: ConfirmedProject?,
    val threads: List<ConfirmedChat>,
    val projectId: String? = project?.id,
)

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
internal fun ChatListGroup.rankScope(state: ChatListUiState): List<ConfirmedChat> =
    state.threads.filter { it.projectId == projectId }

internal data class ChatListSection(
    val group: ChatListGroup,
    val firstRow: Int,
    val collapsed: Boolean,
    val provisionalChats: List<ProvisionalChat>,
) {
    val firstChatRow: Int
        get() = if (group.project == null) firstRow else firstRow + 1

    val pinTail: Int
        get() = group.pinnedTailIndex(hasProvisional = provisionalChats.isNotEmpty())

    val showsEmptyProjectAction: Boolean
        get() =
            group.project != null &&
                !collapsed &&
                group.threads.isEmpty() &&
                provisionalChats.isEmpty()
}

internal fun chatListSections(
    groups: List<ChatListGroup>,
    expandedProjectIds: Set<String>,
    provisionalByProject: Map<String?, List<ProvisionalChat>> = emptyMap(),
): List<ChatListSection> {
    var row = 0
    return groups.map { group ->
        val collapsed = group.project != null && group.project.id !in expandedProjectIds
        val provisional = provisionalByProject[group.projectId].orEmpty()
        val section = ChatListSection(group, row, collapsed, provisional)
        row = section.firstChatRow + if (collapsed) 0 else group.threads.size + provisional.size
        section
    }
}

fun chatListGroups(
    state: ChatListUiState,
    filter: ChatListFilter = state.filter,
    provisionalProjectIds: Set<String?> = emptySet(),
): List<ChatListGroup> =
    chatListGroups(
        state.threads,
        state.projects,
        filter,
        if (filter == ChatListFilter.Unread) state.unreadChatIds() else emptySet(),
        provisionalProjectIds,
    )

/** The chat stream owns membership. Project metadata supplies the header when available. */
internal fun chatListGroups(
    threads: List<ConfirmedChat>,
    projects: List<ConfirmedProject>,
    filter: ChatListFilter,
    unreadChatIds: Set<String>,
    provisionalProjectIds: Set<String?>,
): List<ChatListGroup> {
    val matches: (ConfirmedChat) -> Boolean = { row ->
        when (filter) {
            ChatListFilter.Inbox -> !row.archived
            ChatListFilter.Archived -> row.archived
            ChatListFilter.Muted -> row.muted == true
            ChatListFilter.Unread -> row.muted != true && row.id in unreadChatIds
        }
    }
    val known = projects.mapTo(hashSetOf()) { it.id }
    val byProject = threads.filter { it.hidden != true && matches(it) }.groupBy { it.projectId }
    return buildList {
        for (project in projects) {
            val rows = byProject[project.id].orEmpty()
            if (rows.isNotEmpty() || filter == ChatListFilter.Inbox) {
                add(ChatListGroup(project, rows))
            }
        }
        for (id in byProject.keys + provisionalProjectIds) {
            if (id != null && id !in known) {
                add(ChatListGroup(null, byProject[id].orEmpty(), id))
            }
        }
        add(ChatListGroup(null, byProject[null].orEmpty()))
    }
}
