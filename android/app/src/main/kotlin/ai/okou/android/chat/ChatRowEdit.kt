package ai.okou.android.chat

internal enum class ChatRowField {
    Pin,
    Title,
    Archive,
    Mute,
    Membership,
    Deletion,
}

internal data class ChatRowEdit(
    val threadId: String,
    val eventId: String,
    val action: ChatRowAction,
    val value: String? = null,
) {
    val field: ChatRowField
        get() =
            when (action) {
                ChatRowAction.Rename -> ChatRowField.Title
                ChatRowAction.MoveProject -> ChatRowField.Membership
                ChatRowAction.Delete -> ChatRowField.Deletion
                ChatRowAction.Archive,
                ChatRowAction.Unarchive -> ChatRowField.Archive
                ChatRowAction.Mute,
                ChatRowAction.Unmute -> ChatRowField.Mute
                ChatRowAction.Pin,
                ChatRowAction.Unpin,
                ChatRowAction.MovePinUp,
                ChatRowAction.MovePinDown -> ChatRowField.Pin
                ChatRowAction.MarkRead,
                ChatRowAction.MarkUnread -> error("Read state is separate")
            }

    fun apply(row: ConfirmedChat): ConfirmedChat =
        when (action) {
            ChatRowAction.Rename -> row.copy(title = value, renamedAt = row.updatedAt)
            ChatRowAction.MoveProject -> row.copy(projectId = value)
            ChatRowAction.Delete -> row.copy(hidden = true)
            ChatRowAction.Archive,
            ChatRowAction.Unarchive -> row.copy(archived = action == ChatRowAction.Archive)
            ChatRowAction.Mute,
            ChatRowAction.Unmute -> row.copy(muted = action == ChatRowAction.Mute)
            ChatRowAction.Pin -> row.copy(pinnedAt = row.pinnedAt ?: row.sortAt, pinOrder = value)
            ChatRowAction.Unpin -> row.copy(pinnedAt = null, pinOrder = null)
            ChatRowAction.MovePinUp,
            ChatRowAction.MovePinDown ->
                if (row.pinnedAt == null) row else row.copy(pinOrder = value)
            ChatRowAction.MarkRead,
            ChatRowAction.MarkUnread -> error("Read state is separate")
        }

    fun matchesRecoveryTarget(row: ConfirmedChat): Boolean =
        row.hidden != true &&
            when (action) {
                ChatRowAction.Archive -> row.archived
                ChatRowAction.Unarchive -> !row.archived
                ChatRowAction.Mute -> row.muted == true
                ChatRowAction.Unmute -> row.muted != true
                ChatRowAction.Pin -> row.pinnedAt != null
                ChatRowAction.Unpin -> row.pinnedAt == null
                ChatRowAction.MovePinUp,
                ChatRowAction.MovePinDown -> row.pinnedAt != null && row.pinOrder == value
                ChatRowAction.MoveProject -> row.projectId == value
                else -> false
            }
}

internal fun ReplayedChats.withLocalChanges(
    edits: Collection<ChatRowEdit>,
    recentThreads: List<String>,
): ReplayedChats {
    if (edits.isEmpty() && recentThreads.isEmpty()) return this
    val byThread = edits.groupBy { it.threadId }
    var recency = byRecency.map { row ->
        byThread[row.id].orEmpty().fold(row) { current, edit -> edit.apply(current) }
    }
    if (recentThreads.isNotEmpty()) {
        val rows = recency.associateBy { it.id }
        val touched = recentThreads.toSet()
        recency = touched.mapNotNull(rows::get) + recency.filterNot { it.id in touched }
    }
    if (recentThreads.isNotEmpty() || edits.any { it.field == ChatRowField.Pin })
        return ReplayedChats(orderChatPins(recency), recency)
    val editedRows = recency.filter { it.id in byThread }.associateBy { it.id }
    return ReplayedChats(threads.map { editedRows[it.id] ?: it }, recency)
}
