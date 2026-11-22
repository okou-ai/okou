package ai.okou.android.chat

import ai.okou.android.api.generated.ChatEventsEventsItemVariant1
import ai.okou.android.api.generated.ChatEventsEventsItemVariant1Kind

/** Main-thread owner of the published chat baseline and its optimistic list overlays. */
internal class ChatListProjection {
    private var confirmedCheckpoint: ChatCheckpoint? = null
    var confirmedRows = ReplayedChats(emptyList(), emptyList())
        private set

    private class PendingRowEdit(val edit: ChatRowEdit, private val optimistic: Boolean) {
        var unconfirmed = false
        var confirmedMembershipChanged = false

        val optimisticEdit: ChatRowEdit?
            get() = edit.takeIf { optimistic && !(unconfirmed && confirmedMembershipChanged) }
    }

    private var rowEdits = emptyList<PendingRowEdit>()

    class OutgoingAttempt(val threadId: String) {
        var sending = true
    }

    private val outgoingActivity = linkedMapOf<String, OutgoingAttempt>()
    var acceptedNewChats = emptyList<ProvisionalChat>()
        private set

    val hasPendingMutations: Boolean
        get() = rowEdits.isNotEmpty() || outgoingActivity.isNotEmpty()

    fun restore(checkpoint: ChatCheckpoint, rows: ReplayedChats) {
        recordMembershipChanges(rows)
        confirmedCheckpoint = checkpoint
        confirmedRows = rows
        acceptedNewChats = unobservedNewChats(acceptedNewChats)
    }

    fun rows(): ReplayedChats {
        val optimisticEdits =
            if (rowEdits.isEmpty()) emptyList() else rowEdits.mapNotNull { it.optimisticEdit }
        val recentThreads = outgoingActivity.values.toList().asReversed().map { it.threadId }
        return confirmedRows.withLocalChanges(optimisticEdits, recentThreads)
    }

    fun addEdits(edits: List<ChatRowEdit>, optimistic: Boolean = true) {
        rowEdits = rowEdits + edits.map { PendingRowEdit(it, optimistic) }
    }

    fun hasUnsettledEdits(edits: List<ChatRowEdit>) = rowEdits.any { it.edit in edits }

    fun discardEdits(edits: List<ChatRowEdit>): Boolean {
        if (!hasUnsettledEdits(edits)) return false
        settleRowEdits(emptySet(), edits.mapTo(hashSetOf()) { it.eventId })
        return true
    }

    fun discardUnconfirmedMovesToMissingProjects(projects: List<ConfirmedProject>): Boolean {
        if (rowEdits.isEmpty()) return false
        // An authoritative Project deletion supersedes a local move into that destination,
        // regardless of whether the original request reached the server.
        val discarded =
            rowEdits
                .filter { pending ->
                    pending.unconfirmed &&
                        pending.edit.action == ChatRowAction.MoveProject &&
                        pending.edit.value != null &&
                        projects.none { it.id == pending.edit.value }
                }
                .map { it.edit }
        return discardEdits(discarded)
    }

    fun hasConfirmedThread(threadId: String) = confirmedRows.byRecency.any { it.id == threadId }

    fun retryEvents(): Set<String> =
        rowEdits.asSequence().filter { it.unconfirmed }.map { it.edit.eventId }.toSet()

    fun confirmEdits(edits: List<ChatRowEdit>): Boolean {
        val unresolved = rowEdits.filter { it.edit in edits }
        unresolved.forEach { it.unconfirmed = true }
        return unresolved.isEmpty()
    }

    private fun recordMembershipChanges(rows: ReplayedChats) {
        if (rowEdits.isEmpty()) return
        val moves =
            rowEdits.filter {
                it.edit.action == ChatRowAction.MoveProject && !it.confirmedMembershipChanged
            }
        if (moves.isEmpty()) return
        val threadIds = moves.mapTo(hashSetOf()) { it.edit.threadId }
        val previous = confirmedRows.membershipFor(threadIds)
        val current = rows.membershipFor(threadIds)
        for (move in moves) {
            val threadId = move.edit.threadId
            // After a confirmed change, an unconfirmed move keeps its receipt identity
            // and yields the displayed grouping to subsequent server state.
            if (threadId !in current || previous[threadId] != current[threadId]) {
                move.confirmedMembershipChanged = true
            }
        }
    }

    private fun ReplayedChats.membershipFor(threadIds: Set<String>): Map<String, String?> =
        buildMap {
            for (row in byRecency) {
                if (row.id in threadIds) put(row.id, row.projectId)
            }
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
                if (editsBefore.any { it.edit.action == ChatRowAction.Delete }) {
                    val present = rows.byRecency.mapTo(hashSetOf()) { it.id }
                    for (pending in editsBefore) {
                        val edit = pending.edit
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
        rowEdits.forEachIndexed { index, pending ->
            val edit = pending.edit
            if (edit.eventId in observed) settledThrough[edit.threadId to edit.field] = index
        }
        if (settledThrough.isEmpty() && discarded.isEmpty()) return
        rowEdits =
            rowEdits.filterIndexed { index, pending ->
                val edit = pending.edit
                edit.eventId !in discarded &&
                    index > (settledThrough[edit.threadId to edit.field] ?: -1)
            }
    }
}
