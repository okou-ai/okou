package ai.okou.android.chat

import ai.okou.android.api.generated.ChatEventsEventsItemVariant1
import ai.okou.android.api.generated.ChatEventsEventsItemVariant1Kind

/** Main-thread owner of the published chat baseline and its optimistic list overlays. */
internal class ChatListProjection {
    private var confirmedCheckpoint: ChatCheckpoint? = null
    var confirmedRows = ReplayedChats(emptyList(), emptyList())
        private set

    private var rowEdits = emptyList<ChatRowEdit>()
    private val unconfirmedRowEvents = mutableSetOf<String>()

    class OutgoingAttempt(val threadId: String) {
        var sending = true
    }

    private val outgoingActivity = linkedMapOf<String, OutgoingAttempt>()
    var acceptedNewChats = emptyList<ProvisionalChat>()
        private set

    val hasPendingMutations: Boolean
        get() = rowEdits.isNotEmpty() || outgoingActivity.isNotEmpty()

    fun restore(checkpoint: ChatCheckpoint, rows: ReplayedChats) {
        confirmedCheckpoint = checkpoint
        confirmedRows = rows
        acceptedNewChats = unobservedNewChats(acceptedNewChats)
    }

    fun rows(): ReplayedChats {
        val recentThreads = outgoingActivity.values.toList().asReversed().map { it.threadId }
        return confirmedRows.withLocalChanges(rowEdits, recentThreads)
    }

    fun addEdits(edits: List<ChatRowEdit>) {
        rowEdits = rowEdits + edits
    }

    fun hasUnsettledEdits(edits: List<ChatRowEdit>) = edits.any { it in rowEdits }

    fun discardEdits(edits: List<ChatRowEdit>): Boolean {
        if (!hasUnsettledEdits(edits)) return false
        settleRowEdits(emptySet(), edits.mapTo(hashSetOf()) { it.eventId })
        return true
    }

    fun hasConfirmedThread(threadId: String) = confirmedRows.byRecency.any { it.id == threadId }

    fun retryEvents(): Set<String> = unconfirmedRowEvents.toSet()

    fun confirmEdits(edits: List<ChatRowEdit>): Boolean {
        val unresolved = edits.filter { it in rowEdits }
        unresolved.mapTo(unconfirmedRowEvents) { it.eventId }
        return unresolved.isEmpty()
    }

    fun showOutgoing(eventId: String, threadId: String): Boolean {
        val checkpoint = confirmedCheckpoint
        if (
            checkpoint?.snapshotCursor?.eventId == eventId ||
                checkpoint?.events?.any { it.cursor().eventId == eventId } == true
        )
            return false
        val existing = outgoingActivity[eventId]
        if (existing?.sending == true) return false
        outgoingActivity[eventId] = OutgoingAttempt(threadId)
        return existing == null
    }

    fun completeOutgoing(eventId: String?, rejected: Boolean = false): Boolean {
        if (rejected) return outgoingActivity.remove(eventId) != null
        outgoingActivity[eventId]?.sending = false
        return false
    }

    fun completedOutgoingAttempts(): Map<String, OutgoingAttempt> =
        outgoingActivity.filterValues { !it.sending }

    fun retainAcceptedNewChats(chats: List<ProvisionalChat>) {
        acceptedNewChats = unobservedNewChats((chats + acceptedNewChats).distinctBy { it.threadId })
    }

    fun removeMissingAcceptedChat(threadId: String): Boolean {
        val remaining = acceptedNewChats.filterNot { it.threadId == threadId }
        if (remaining.size == acceptedNewChats.size) return false
        acceptedNewChats = remaining
        return true
    }

    private fun unobservedNewChats(chats: List<ProvisionalChat>): List<ProvisionalChat> {
        if (chats.isEmpty()) return chats
        val observed = confirmedRows.threads.mapTo(hashSetOf()) { it.id }
        confirmedCheckpoint?.events?.forEach { event ->
            if (
                event is ChatEventsEventsItemVariant1 &&
                    event.kind == ChatEventsEventsItemVariant1Kind.DELETED
            )
                observed.add(event.chatThreadId)
        }
        return chats.filterNot { it.threadId in observed }
    }

    /** Returns whether the rows or previews need to be published with the read status. */
    fun reconcile(
        read: ChatListSync.Result,
        checkpoint: ChatCheckpoint,
        rows: ReplayedChats,
        discarded: Set<String>,
        completedAttempts: Map<String, OutgoingAttempt>,
    ): Boolean {
        val checkpointChanged = confirmedCheckpoint !== checkpoint
        val editsBefore = rowEdits
        val activityCount = outgoingActivity.size
        if (hasPendingMutations) {
            val observed = buildSet {
                read.checkpoint.snapshotCursor.eventId?.let(::add)
                read.checkpoint.events.forEach { it.cursor().eventId?.let(::add) }
                if (checkpoint !== read.checkpoint) {
                    checkpoint.snapshotCursor.eventId?.let(::add)
                    checkpoint.events.forEach { it.cursor().eventId?.let(::add) }
                }
                addAll(read.eventIdsBeforeRebase)
                if (editsBefore.any { it.action == ChatRowAction.Delete }) {
                    val present = rows.byRecency.mapTo(hashSetOf()) { it.id }
                    for (edit in editsBefore) {
                        if (edit.action == ChatRowAction.Delete && edit.threadId !in present)
                            add(edit.eventId)
                    }
                }
            }
            settleRowEdits(observed, discarded)
            val settledThreads = mutableSetOf<String>()
            for ((id, attempt) in outgoingActivity.entries.toList().asReversed()) {
                if (id in observed || completedAttempts[id] === attempt)
                    settledThreads.add(attempt.threadId)
                if (attempt.threadId in settledThreads) outgoingActivity.remove(id)
            }
        }
        if (checkpointChanged) restore(checkpoint, rows)
        return checkpointChanged ||
            rowEdits !== editsBefore ||
            outgoingActivity.size != activityCount
    }

    private fun settleRowEdits(observed: Set<String>, discarded: Set<String>) {
        val settledThrough = mutableMapOf<Pair<String, ChatRowField>, Int>()
        rowEdits.forEachIndexed { index, edit ->
            if (edit.eventId in observed) settledThrough[edit.threadId to edit.field] = index
        }
        if (settledThrough.isEmpty() && discarded.isEmpty()) return
        rowEdits =
            rowEdits.filterIndexed { index, edit ->
                val settled =
                    edit.eventId in discarded ||
                        index <= (settledThrough[edit.threadId to edit.field] ?: -1)
                if (settled) unconfirmedRowEvents.remove(edit.eventId)
                !settled
            }
    }
}
