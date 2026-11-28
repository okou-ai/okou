package ai.okou.android.chat

import ai.okou.android.api.generated.ChatEventsEventsItemVariant1
import ai.okou.android.api.generated.ChatEventsEventsItemVariant1Kind

/** Main-thread owner of the published chat baseline and its optimistic list overlays. */
internal class ChatListProjection {
    private var confirmedCheckpoint: ChatCheckpoint? = null
    var confirmedRows = ReplayedChats(emptyList(), emptyList())
        private set

    var confirmedRenameIds = emptyMap<String, String>()
        private set

    private enum class RenameAcknowledgement {
        ShowSubmittedName,
        KeepCanonicalName,
    }

    private class PendingRowEdit(
        val edit: ChatRowEdit,
        private val optimistic: Boolean,
        var waitingForTargetChange: Boolean,
        private val renameBaseline: Pair<String?, String?>?,
        val renameSnapshotCursor: ChatCursor?,
    ) {
        var unconfirmed = false
        var confirmedMembershipChanged = false
        var renameAcknowledgement: RenameAcknowledgement? = null

        val visibleEdit: ChatRowEdit?
            get() = edit.takeIf {
                renameAcknowledgement == RenameAcknowledgement.ShowSubmittedName ||
                    optimistic && !(unconfirmed && confirmedMembershipChanged)
            }

        fun keepsRenameBaseline(row: ConfirmedChat?): Boolean =
            row != null && row.hidden != true && (row.title to row.renamedAt) == renameBaseline

        val canRecoverByTarget: Boolean
            get() = optimistic && edit.action.recoversInBackground

        fun matchesTarget(row: ConfirmedChat): Boolean =
            !waitingForTargetChange && edit.matchesRecoveryTarget(row)
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
        for (pending in rowEdits) {
            if (!pending.waitingForTargetChange) continue
            val row = rows.byRecency.firstOrNull { it.id == pending.edit.threadId }
            if (row != null && !pending.edit.matchesRecoveryTarget(row)) {
                pending.waitingForTargetChange = false
            }
        }
        confirmedCheckpoint = checkpoint
        confirmedRows = rows
        acceptedNewChats = unobservedNewChats(acceptedNewChats)
    }

    fun rows(): ReplayedChats {
        val visibleEdits =
            if (rowEdits.isEmpty()) emptyList() else rowEdits.mapNotNull { it.visibleEdit }
        val recentThreads = outgoingActivity.values.toList().asReversed().map { it.threadId }
        return confirmedRows.withLocalChanges(visibleEdits, recentThreads)
    }

    fun addEdits(edits: List<ChatRowEdit>, optimistic: Boolean = true) {
        rowEdits =
            rowEdits +
                edits.map { edit ->
                    // An inverse can match the baseline while an older write is still unconfirmed.
                    // Only a changed baseline or the inverse's receipt can confirm that newer
                    // write.
                    val targetAlreadyMatches =
                        optimistic &&
                            edit.action.recoversInBackground &&
                            confirmedRows.byRecency.any {
                                it.id == edit.threadId && edit.matchesRecoveryTarget(it)
                            }
                    val renameBaseline =
                        if (edit.action == ChatRowAction.Rename)
                            confirmedRows.threads
                                .firstOrNull { it.id == edit.threadId }
                                ?.let {
                                    it.title to it.renamedAt
                                }
                        else null
                    val renameSnapshotCursor =
                        confirmedCheckpoint?.snapshotCursor.takeIf { renameBaseline != null }
                    PendingRowEdit(
                        edit,
                        optimistic,
                        targetAlreadyMatches,
                        renameBaseline,
                        renameSnapshotCursor,
                    )
                }
    }

    fun acknowledgeRename(edit: ChatRowEdit): Boolean {
        val pending = rowEdits.firstOrNull { it.edit == edit } ?: return false
        recordConfirmedRename(edit)
        val row = confirmedRows.threads.firstOrNull { it.id == edit.threadId && it.hidden != true }
        // On the same snapshot, a later rename in the feed would already have settled
        // this edit by ID. A replacement snapshot may have compacted that receipt.
        val showSubmittedName =
            row != null &&
                (pending.renameSnapshotCursor == confirmedCheckpoint?.snapshotCursor ||
                    pending.keepsRenameBaseline(row))
        pending.renameAcknowledgement =
            if (showSubmittedName) RenameAcknowledgement.ShowSubmittedName
            else RenameAcknowledgement.KeepCanonicalName
        // A later acknowledged rename supersedes older receipt overlays on this row.
        rowEdits = rowEdits.filterNot {
            it !== pending && it.edit.threadId == edit.threadId && it.renameAcknowledgement != null
        }
        return true
    }

    fun acknowledgedRenameIds(): Set<String> =
        if (rowEdits.isEmpty()) emptySet()
        else
            buildSet {
                for (pending in rowEdits) {
                    if (pending.renameAcknowledgement != null) add(pending.edit.eventId)
                }
            }

    fun hasUnsettledEdits(edits: List<ChatRowEdit>) = rowEdits.any { it.edit in edits }

    fun settleConfirmedTargets(edits: List<ChatRowEdit>): Boolean {
        if (edits.isEmpty() || rowEdits.isEmpty()) return false
        val matched = buildSet {
            for (pending in rowEdits) {
                val edit = pending.edit
                if (
                    edit in edits &&
                        confirmedRows.byRecency.any {
                            it.id == edit.threadId && pending.matchesTarget(it)
                        }
                )
                    add(edit.eventId)
            }
        }
        if (matched.isEmpty()) return false
        settleRowEdits(matched, emptySet())
        return true
    }

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
        rowEdits
            .asSequence()
            .filter { it.unconfirmed && !it.canRecoverByTarget }
            .map { it.edit.eventId }
            .toSet()

    fun confirmEdits(edits: List<ChatRowEdit>): Boolean {
        val unresolved = rowEdits.filter { it.edit in edits }
        unresolved.forEach { it.unconfirmed = true }
        return unresolved.isEmpty()
    }

    private fun recordMembershipChanges(rows: ReplayedChats) {
        if (rowEdits.isEmpty()) return
        val moves = rowEdits.filter {
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

    fun completedOutgoingAttempts(): Map<String, OutgoingAttempt> = outgoingActivity.filterValues {
        !it.sending
    }

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
        renamesAcknowledgedBeforeRead: Set<String>,
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
                if (editsBefore.any { it.unconfirmed && it.canRecoverByTarget }) {
                    val byId = rows.byRecency.associateBy { it.id }
                    for (pending in editsBefore) {
                        if (!pending.unconfirmed || !pending.canRecoverByTarget) continue
                        val edit = pending.edit
                        val row = byId[edit.threadId]
                        if (row?.let(pending::matchesTarget) == true) add(edit.eventId)
                    }
                }
            }
            settleRowEdits(
                observed,
                discarded +
                    supersededRenames(checkpoint, rows, observed, renamesAcknowledgedBeforeRead),
            )
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

    private fun supersededRenames(
        checkpoint: ChatCheckpoint,
        rows: ReplayedChats,
        observed: Set<String>,
        acknowledgedBeforeRead: Set<String>,
    ): Set<String> {
        if (
            rowEdits.none {
                it.renameAcknowledgement != null && it.edit.eventId !in observed
            }
        )
            return emptySet()
        val byId = rows.threads.associateBy { it.id }
        return buildSet {
            for (pending in rowEdits) {
                val (threadId, eventId) = pending.edit
                if (pending.renameAcknowledgement == null || eventId in observed) continue
                val row = byId[threadId]
                // An older incremental page can omit this event. A full read started
                // after acknowledgement can also settle it through an advancing snapshot.
                val coveredBySnapshot =
                    eventId in acknowledgedBeforeRead &&
                        checkpoint.snapshotCursor.seqId >
                            checkNotNull(pending.renameSnapshotCursor).seqId
                if (row == null || row.hidden == true || coveredBySnapshot) add(eventId)
            }
        }
    }

    private fun recordConfirmedRename(edit: ChatRowEdit) {
        val latest = rowEdits.lastOrNull {
            it.edit.threadId == edit.threadId && it.edit.action == ChatRowAction.Rename
        }
        if (latest?.edit == edit) {
            confirmedRenameIds = confirmedRenameIds + (edit.threadId to edit.eventId)
        }
    }

    private fun settleRowEdits(observed: Set<String>, discarded: Set<String>) {
        val settledThrough = mutableMapOf<Pair<String, ChatRowField>, Int>()
        rowEdits.forEachIndexed { index, pending ->
            val edit = pending.edit
            if (edit.eventId in observed) settledThrough[edit.threadId to edit.field] = index
        }
        if (settledThrough.isEmpty() && discarded.isEmpty()) return
        for (index in settledThrough.values) {
            val edit = rowEdits[index].edit
            if (edit.action == ChatRowAction.Rename) recordConfirmedRename(edit)
        }
        rowEdits = rowEdits.filterIndexed { index, pending ->
            val edit = pending.edit
            edit.eventId !in discarded &&
                index > (settledThrough[edit.threadId to edit.field] ?: -1)
        }
    }
}
