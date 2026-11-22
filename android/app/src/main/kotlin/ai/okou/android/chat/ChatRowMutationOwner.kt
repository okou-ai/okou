package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.withContext

/** Runs chat-event mutations in the list model's workspace scope. */
internal class ChatRowMutationOwner(
    private val service: ChatListService,
    private val projection: ChatListProjection,
    private val dispatcher: CoroutineDispatcher,
    private val wallMillis: () -> Long,
    private val requireCurrent: suspend () -> Unit,
    private val onFailure: (Exception) -> Unit,
    private val publishRows: () -> Unit,
    private val awaitListRead: suspend (needsRead: () -> Boolean) -> Unit,
) {
    class Submission(
        val action: ChatRowAction,
        val edits: List<ChatRowEdit>,
        val submittedCount: Int,
        val targetMissing: Boolean,
        val connectionFailed: Boolean,
        val alreadySatisfied: Boolean,
        val recoverByTarget: Boolean,
    )

    class Confirmation(val failure: ChatRowActionFailure?, val ownWriteConfirmed: Boolean)

    enum class Rollback {
        Rejected,
        ConnectionFailed,
        MissingTarget,
        CheckMissingDelete,
    }

    suspend fun prepareEdits(
        threadId: String,
        action: ChatRowAction,
        value: String?,
        pinGroup: ChatListGroup?,
        index: Int,
        state: ChatListUiState,
    ): List<ChatRowEdit> {
        val orders =
            when (action) {
                ChatRowAction.Pin ->
                    withContext(dispatcher) {
                        val order = ChatPinOrder.first(checkNotNull(pinGroup).rankScope(state))
                        listOf(ChatPinOrderUpdate(threadId, order))
                    }
                ChatRowAction.MovePinUp,
                ChatRowAction.MovePinDown ->
                    withContext(dispatcher) {
                        val before = action == ChatRowAction.MovePinUp
                        val group = checkNotNull(pinGroup)
                        val target = checkNotNull(group.pinNeighbor(index, if (before) -1 else 1))
                        ChatPinOrder.move(group.rankScope(state), threadId, target.id, before)
                    }
                ChatRowAction.MoveProject ->
                    return listOf(
                        ChatRowEdit(threadId, newProjectOperationId(wallMillis()), action, value)
                    )
                else -> return listOf(ChatRowEdit(threadId, newEventId(), action, value))
            }
        return orders.map { ChatRowEdit(it.threadId, newEventId(), action, it.pinOrder) }
    }

    suspend fun submit(
        action: ChatRowAction,
        edits: List<ChatRowEdit>,
        optimistic: Boolean,
        acknowledgeRead: suspend () -> Unit,
    ): Submission {
        var submittedCount = 0
        var targetMissing = false
        var connectionFailed = false
        var alreadySatisfied = false
        val retries = if (optimistic && action.recoversInBackground) ChatWriteRetries() else null
        try {
            requireCurrent()
            if (edits.isNotEmpty()) {
                projection.addEdits(edits, optimistic)
                if (optimistic) publishRows()
            }
            if (action == ChatRowAction.Unmute) acknowledgeRead()
            // Submit the tied suffix first so it keeps its order on partial failure.
            for (edit in edits.asReversed()) {
                requireCurrent()
                submittedCount++
                if (retries == null) write(edit)
                else
                    retries.run { retrying ->
                        requireCurrent()
                        if (retrying && projection.matchesConfirmedTarget(edit)) {
                            alreadySatisfied = true
                            if (projection.discardEdits(listOf(edit))) publishRows()
                        } else write(edit)
                    }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            requireCurrent()
            targetMissing = error is ApiFailure.Http && error.status == 404
            connectionFailed = error is ApiFailure.Network && error.connectionFailed
            // The target may have disappeared while the workspace is still authorized.
            if (!targetMissing) onFailure(error)
            requireCurrent()
            if (submittedCount > 0 && (connectionFailed || error.rejectsEdit(action))) {
                submittedCount--
            }
        }
        return Submission(
            action,
            edits,
            submittedCount,
            targetMissing,
            connectionFailed,
            alreadySatisfied,
            retries != null,
        )
    }

    fun discardRejected(submission: Submission): Rollback? {
        val rejected = submission.edits.dropLast(submission.submittedCount)
        val failed =
            !submission.recoverByTarget || rejected.any { !projection.matchesConfirmedTarget(it) }
        if (!projection.discardEdits(rejected)) return null
        if (!failed) {
            publishRows()
            return null
        }
        return when {
            submission.connectionFailed -> Rollback.ConnectionFailed
            !submission.targetMissing -> Rollback.Rejected
            submission.action == ChatRowAction.Delete -> Rollback.CheckMissingDelete
            else -> Rollback.MissingTarget
        }
    }

    suspend fun confirm(
        submission: Submission,
        rollback: Rollback?,
        conversationId: String?,
    ): Confirmation {
        requireCurrent()
        val edits = submission.edits.takeLast(submission.submittedCount)
        val missingDeleteTarget =
            if (rollback == Rollback.CheckMissingDelete) submission.edits.single().threadId
            else null
        val needsRead = {
            projection.hasUnsettledEdits(edits) ||
                missingDeleteTarget?.let(projection::hasConfirmedThread) == true
        }
        val canOfferUndo = edits.isNotEmpty() && !submission.alreadySatisfied
        if (!needsRead()) return Confirmation(null, canOfferUndo)
        // Even when a response is lost, the original event ID can confirm the write.
        awaitListRead(needsRead)
        requireCurrent()
        if (missingDeleteTarget != null) {
            // A concurrent deletion can make the requested result canonical after a 404.
            return Confirmation(
                if (projection.hasConfirmedThread(missingDeleteTarget))
                    ChatRowActionFailure(
                        submission.action,
                        rejected = true,
                        conversationId = conversationId,
                    )
                else null,
                false,
            )
        }
        val confirmedElsewhere =
            submission.recoverByTarget && projection.settleConfirmedTargets(edits)
        if (confirmedElsewhere) publishRows()
        val settled = projection.confirmEdits(edits)
        // A move that never reached its requested rank write already reported failure.
        // Its attempted rank edits still need event reconciliation.
        return if (settled || rollback != null)
            Confirmation(null, settled && canOfferUndo && !confirmedElsewhere)
        else
            Confirmation(
                ChatRowActionFailure(
                    submission.action,
                    edits = edits,
                    conversationId = conversationId,
                ),
                false,
            )
    }

    private suspend fun write(edit: ChatRowEdit) {
        val (threadId, eventId, action, value) = edit
        when (action) {
            ChatRowAction.Mute,
            ChatRowAction.Unmute ->
                service.setMuted(threadId, action == ChatRowAction.Mute, eventId)
            ChatRowAction.Archive,
            ChatRowAction.Unarchive ->
                service.setArchived(threadId, action == ChatRowAction.Archive, eventId)
            ChatRowAction.Rename -> service.renameThread(threadId, checkNotNull(value), eventId)
            ChatRowAction.MoveProject -> service.moveThreadToProject(threadId, value, eventId)
            ChatRowAction.Delete -> service.deleteThread(threadId, eventId)
            ChatRowAction.Pin,
            ChatRowAction.Unpin -> service.setPinned(threadId, value, eventId)
            ChatRowAction.MovePinUp,
            ChatRowAction.MovePinDown ->
                service.reorderPinnedThread(threadId, checkNotNull(value), eventId)
            ChatRowAction.MarkRead,
            ChatRowAction.MarkUnread -> error("Read state is separate")
        }
    }

    private fun newEventId() = UUID.randomUUID().toString()

    private fun Exception.rejectsEdit(action: ChatRowAction): Boolean =
        when (this) {
            is ApiFailure.Unauthenticated -> true
            is ApiFailure.Http ->
                when (status) {
                    // Validation, authorization and unsuccessful target lookup precede the write.
                    400,
                    401,
                    403,
                    404 -> true
                    402 -> action == ChatRowAction.Delete
                    409 -> action == ChatRowAction.MoveProject
                    else -> false
                }
            else -> false
        }
}
