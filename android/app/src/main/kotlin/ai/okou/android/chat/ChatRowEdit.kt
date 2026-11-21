package ai.okou.android.chat

internal enum class ChatRowField {
    Pin,
    Title,
    Archive,
    Mute,
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
}

internal fun ReplayedChats.withRowEdits(edits: Collection<ChatRowEdit>): ReplayedChats {
    if (edits.isEmpty()) return this
    val byThread = edits.groupBy { it.threadId }
    val recency =
        byRecency.map { row ->
            byThread[row.id].orEmpty().fold(row) { current, edit -> edit.apply(current) }
        }
    if (edits.any { it.field == ChatRowField.Pin })
        return ReplayedChats(orderChatPins(recency), recency)
    val editedRows = recency.filter { it.id in byThread }.associateBy { it.id }
    return ReplayedChats(threads.map { editedRows[it.id] ?: it }, recency)
}
