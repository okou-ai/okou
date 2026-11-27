package ai.okou.android

import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ChatListUiState
import ai.okou.android.chat.ChatMarkAllReadResult
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.ChatRenameEditor
import ai.okou.android.chat.ChatRowAction
import ai.okou.android.chat.ChatRowActionFailure
import ai.okou.android.chat.ChatRowUndo
import ai.okou.android.chat.ChatUndoPhase
import ai.okou.android.chat.ConversationRunControls
import ai.okou.android.chat.DeleteProjectDialog
import ai.okou.android.chat.ProjectDeleteFeedback
import ai.okou.android.chat.ProjectDeleteStatus
import ai.okou.android.chat.ProvisionalChat
import ai.okou.android.chat.RenameListItemSheet
import ai.okou.android.chat.RenameStatus
import ai.okou.android.chat.RunControlIntent
import ai.okou.android.chat.RunControlKind
import ai.okou.android.chat.WorkspaceRenameTarget
import ai.okou.android.chat.canDeleteProject
import ai.okou.android.chat.canRenameProject
import ai.okou.android.chat.hasUsableList
import ai.okou.android.chat.label
import ai.okou.android.chat.needsProjectsToConfirmEmptyInbox
import ai.okou.android.chat.recoversInBackground
import ai.okou.android.chat.rowActions
import ai.okou.android.updates.updateFocusOutline
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarData
import androidx.compose.material3.SnackbarDefaults
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.SnackbarVisuals
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalAccessibilityManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

private val feedbackActionGap = 4.dp
private val feedbackTouchTarget = 48.dp
private val feedbackSideInset = 12.dp
private val feedbackMaxWidth = 480.dp
private val feedbackStartPadding = 16.dp
private val feedbackEndPadding = 8.dp
private val feedbackVerticalPadding = 14.dp

private data class ChatFeedbackContent(
    val message: String,
    val actionLabel: String?,
    val enabled: Boolean,
    val showDismiss: Boolean,
)

private class ChatFeedbackSnackbar(
    val content: State<ChatFeedbackContent>,
    val onAction: ((keyboardFocused: Boolean) -> Unit)? = null,
) : SnackbarVisuals {
    override val duration = SnackbarDuration.Indefinite

    override val message
        get() = content.value.message

    override val actionLabel
        get() = content.value.actionLabel

    override val withDismissAction
        get() = content.value.showDismiss
}

@Composable
private fun ChatUndoFeedback(
    chats: ChatListModel,
    undo: ChatRowUndo,
    actionPending: Boolean,
    snackbar: SnackbarHostState,
    onFocusedUndo: (String) -> Unit,
) {
    val message =
        when (undo.phase) {
            ChatUndoPhase.Applying -> return
            ChatUndoPhase.Offered ->
                stringResource(
                    when (undo.action) {
                        ChatRowAction.Archive -> R.string.chat_undo_archived
                        ChatRowAction.Unarchive -> R.string.chat_undo_unarchived
                        else -> R.string.chat_undo_marked_read
                    },
                )
        }
    val action = stringResource(R.string.chat_undo)
    key(chats, undo.sequence) {
        val currentUndo = rememberUpdatedState(undo)
        val returnFocus = rememberUpdatedState(onFocusedUndo)
        val content =
            rememberUpdatedState(
                ChatFeedbackContent(
                    message,
                    action,
                    !actionPending,
                    showDismiss = true,
                ),
            )
        LaunchedEffect(snackbar) {
            snackbar.showSnackbar(
                ChatFeedbackSnackbar(content) { keyboardFocused ->
                    val current = currentUndo.value
                    if (chats.undoRowAction(current) && keyboardFocused)
                        returnFocus.value(current.threadId)
                },
            )
            chats.dismissRowUndo(undo)
        }
    }
}

internal class ConversationNavigationError(val threadId: String, val message: String) {
    val feedbackOrder = nextPaneFeedbackOrder()
}

internal class ControlFailureSnackbar(override val message: String, val kind: RunControlKind) :
    SnackbarVisuals {
    override val actionLabel: String? = null
    override val withDismissAction = false
    override val duration = SnackbarDuration.Indefinite
}

private fun ConversationRunControls.failureMessage(intent: RunControlIntent): Int? =
    when (intent.kind) {
        RunControlKind.Interrupt ->
            R.string.controls_stop_failed.takeIf { intent.targetId == currentRunId }
        RunControlKind.Revoke ->
            presentation.queue
                .firstOrNull { it.message.id == intent.targetId }
                ?.let {
                    if (it.message.queuedWorkflow == null) R.string.conversation_withdraw_failed
                    else R.string.conversation_skip_failed
                }
    }

@Composable
internal fun WorkspaceChatFeedback(
    chats: ChatListModel,
    listState: State<ChatListUiState>,
    listSnackbar: SnackbarHostState,
    conversationSnackbar: SnackbarHostState,
    showChatList: Boolean,
    listNavigationError: FeedbackReceipt<String>?,
    dismissListNavigationError: (FeedbackReceipt<String>) -> Unit,
    onFocusedListUndo: (String) -> Unit,
    onFocusedConversationUndo: () -> Unit,
    provisionalChats: List<ProvisionalChat>,
    visibleConversationId: String?,
    navigationError: ConversationNavigationError?,
    dismissNavigationError: (ConversationNavigationError) -> Unit,
    runControls: ConversationRunControls?,
    codeFeedback: List<FeedbackReceipt<Int>>,
    dismissCodeFeedback: (FeedbackReceipt<Int>) -> Unit,
    showWorkflowFeedback: Boolean,
    confirmingProjectDelete: String?,
    dismissProjectDelete: () -> Unit,
    renameEditor: ChatRenameEditor?,
    dismissRename: (ChatRenameEditor) -> Unit,
) {
    val list = listState.value
    var savedRename by remember(chats) { mutableStateOf<WorkspaceRenameTarget?>(null) }
    if (renameEditor != null)
        key(renameEditor) {
            WorkspaceRenameForm(chats, list, renameEditor, { dismissRename(renameEditor) }) {
                dismissRename(renameEditor)
                savedRename = renameEditor.target
            }
        }
    val deleteFeedback = if (showChatList) list.projectDeleteFeedback else emptyList()
    val deleteProject = list.projects.firstOrNull { it.id == confirmingProjectDelete }
    if (deleteProject != null && showChatList) {
        val feedback = deleteFeedback.lastOrNull { it.projectId == deleteProject.id }
        DeleteProjectDialog(
            projectName = deleteProject.name,
            pending = list.projectList.deletingId == deleteProject.id,
            status = feedback?.status,
            enabled = list.canDeleteProject,
            dismiss = {
                dismissProjectDelete()
                if (feedback?.rejected == true) chats.dismissProjectDeleteFeedback(feedback)
            },
            confirm = {
                if (feedback?.status == ProjectDeleteStatus.Unconfirmed)
                    chats.retryProjectDelete(feedback)
                else chats.deleteProject(deleteProject.id)
            },
        )
    } else if (confirmingProjectDelete != null && list.projectsPhase == ChatReadPhase.Ready) {
        LaunchedEffect(confirmingProjectDelete) { dismissProjectDelete() }
    }

    val conversationUndo = list.conversationUndo?.takeIf { it.threadId == visibleConversationId }
    LaunchedEffect(chats, showChatList) { if (!showChatList) chats.clearListRowUndo() }
    val hiddenConversationUndo = list.conversationUndo?.takeUnless { it === conversationUndo }
    LaunchedEffect(chats, hiddenConversationUndo) {
        hiddenConversationUndo?.let(chats::dismissRowUndo)
    }
    val openRenameId = (renameEditor?.target as? WorkspaceRenameTarget.Chat)?.id
    val failures = list.rowActionFailures
    fun ChatRowActionFailure.isVisible(): Boolean =
        when {
            deleteFromWorkflow -> showWorkflowFeedback
            feedbackConversationId != null -> feedbackConversationId == visibleConversationId
            else -> showChatList
        }
    LaunchedEffect(chats, failures, showChatList, visibleConversationId, showWorkflowFeedback) {
        failures.forEach {
            // A rejected delete can arrive after navigation has already left the deleted chat.
            val returnsToList = it.action == ChatRowAction.Delete && !it.deleteFromWorkflow
            if (it.rejected && !it.isVisible() && !returnsToList) chats.dismissRowActionFailure(it)
        }
    }

    val conversationFailures = failures.filter {
        visibleConversationId != null &&
            it.feedbackConversationId == visibleConversationId &&
            (it.renameThreadId == null || it.renameThreadId != openRenameId)
    }
    val conversationError = conversationFailures.firstOrNull { it.rejected }
    val conversationNotice = conversationFailures.firstOrNull { !it.rejected }
    val controlErrors =
        if (runControls != null && visibleConversationId == runControls.threadId) {
            runControls.state.actionFailures
                .filter { it.value.threadId == visibleConversationId }
                .map { it to runControls.failureMessage(it.value) }
        } else emptyList()
    val obsoleteControls = controlErrors.filter { it.second == null }
    LaunchedEffect(runControls?.model, obsoleteControls) {
        if (runControls != null)
            obsoleteControls.forEach { (receipt, _) ->
                runControls.model.consumeActionFailure(receipt)
            }
    }
    val controlError = controlErrors.firstNotNullOfOrNull { (receipt, message) ->
        message?.let { receipt to it }
    }
    val modelError = visibleConversationId?.let { id ->
        list.conversationModelEdits[id]?.failures?.firstOrNull()?.let { id to it }
    }
    val hiddenModelErrors =
        list.conversationModelEdits.filter { (id, edits) ->
            id != visibleConversationId && edits.failures.isNotEmpty()
        }
    LaunchedEffect(chats, hiddenModelErrors) {
        hiddenModelErrors.forEach { (id, edits) ->
            edits.failures.forEach { chats.dismissConversationModelFailure(id, it) }
        }
    }
    val codeError = codeFeedback.firstOrNull { it.value == R.string.conversation_code_copy_failed }
    val codeResult = codeFeedback.firstOrNull { it.value == R.string.conversation_code_copied }
    val renameTarget = savedRename
    val renameOrigin =
        (renameTarget as? WorkspaceRenameTarget.Chat)?.takeIf { it.fromConversation }?.id
    val renameVisible =
        if (renameOrigin == null) showChatList else renameOrigin == visibleConversationId
    LaunchedEffect(renameTarget, renameVisible) {
        if (!renameVisible && savedRename == renameTarget) savedRename = null
    }
    PaneFeedback(
        errors =
            listOf(
                conversationError?.let { error ->
                    PaneFeedbackError(error.feedbackOrder) {
                        ChatRowFailureFeedback(chats, list, error, conversationSnackbar)
                    }
                },
                navigationError?.let { error ->
                    PaneFeedbackError(error.feedbackOrder) {
                        PaneFeedbackMessage(conversationSnackbar, error, error.message) {
                            dismissNavigationError(error)
                        }
                    }
                },
                controlError?.let { (receipt, messageId) ->
                    PaneFeedbackError(receipt.order) {
                        val message = stringResource(messageId)
                        val model = checkNotNull(runControls).model
                        LaunchedEffect(model, conversationSnackbar, receipt, message) {
                            conversationSnackbar.showSnackbar(
                                ControlFailureSnackbar(message, receipt.value.kind),
                            )
                            model.consumeActionFailure(receipt)
                        }
                    }
                },
                modelError?.let { (id, receipt) ->
                    PaneFeedbackError(receipt.order) {
                        PaneFeedbackMessage(
                            conversationSnackbar,
                            receipt,
                            stringResource(receipt.value),
                        ) {
                            chats.dismissConversationModelFailure(id, receipt)
                        }
                    }
                },
                codeError?.let { error ->
                    PaneFeedbackError(error.order) {
                        PaneFeedbackMessage(
                            conversationSnackbar,
                            error,
                            stringResource(error.value),
                        ) {
                            dismissCodeFeedback(error)
                        }
                    }
                },
            ),
        undo =
            if (conversationUndo != null && conversationUndo.phase != ChatUndoPhase.Applying) {
                {
                    ChatUndoFeedback(
                        chats,
                        conversationUndo,
                        conversationUndo.threadId in list.pendingRowActions,
                        conversationSnackbar,
                        onFocusedUndo = { onFocusedConversationUndo() },
                    )
                }
            } else null,
        result = {
            when {
                conversationNotice != null ->
                    ChatRowFailureFeedback(chats, list, conversationNotice, conversationSnackbar)
                codeResult != null ->
                    PaneFeedbackMessage(
                        conversationSnackbar,
                        codeResult,
                        stringResource(codeResult.value),
                    ) {
                        dismissCodeFeedback(codeResult)
                    }
                renameTarget != null && renameOrigin != null && renameVisible ->
                    RenameSavedSnackbar(renameTarget, conversationSnackbar) {
                        if (savedRename == renameTarget) savedRename = null
                    }
            }
        },
    )

    val batchResults = list.markAllReadResults
    LaunchedEffect(chats, showChatList, batchResults) {
        if (!showChatList) batchResults.forEach(chats::dismissMarkAllReadResult)
    }
    val listFailures = failures.filter {
        it.feedbackConversationId == null &&
            it.isVisible() &&
            (it.renameThreadId == null || it.renameThreadId != openRenameId)
    }
    val rowError = listFailures.firstOrNull { it.rejected }
    val projectError = deleteFeedback.firstOrNull {
        it.rejected && it.projectId != deleteProject?.id
    }
    val projectNotice = deleteFeedback.lastOrNull {
        !it.rejected && it.projectId != deleteProject?.id
    }
    val batchError = if (showChatList) batchResults.firstOrNull { it.hasFailures } else null
    val refreshError =
        if (showChatList) {
            val hasUsableContent =
                list.hasUsableList && !list.needsProjectsToConfirmEmptyInbox(provisionalChats)
            listOfNotNull(
                    list.listRefreshFailureOrder
                        ?.takeIf { hasUsableContent }
                        ?.let { it to R.string.chat_list_sync_failed },
                    list.indicatorsRefreshFailureOrder
                        ?.takeIf { hasUsableContent }
                        ?.let { it to R.string.chat_refresh_failed },
                    list.projectList.refreshFailureOrder
                        ?.takeIf { hasUsableContent || list.projectsSource != null }
                        ?.let { it to R.string.chat_metadata_unavailable },
                )
                .minByOrNull { it.first }
        } else null
    val listUndo = list.rowUndo?.takeIf { showChatList && it.phase != ChatUndoPhase.Applying }
    val rowNotice = listFailures.firstOrNull { !it.rejected }
    val batchNotice = batchResults.firstOrNull { !it.hasFailures }?.takeIf { showChatList }
    val moveNotice = list.chatMoveNotice?.takeIf { showChatList }
    PaneFeedback(
        errors =
            listOf(
                listNavigationError?.let { error ->
                    PaneFeedbackError(error.order) {
                        PaneFeedbackMessage(listSnackbar, error, error.value) {
                            dismissListNavigationError(error)
                        }
                    }
                },
                rowError?.let { error ->
                    PaneFeedbackError(error.feedbackOrder) {
                        ChatRowFailureFeedback(chats, list, error, listSnackbar)
                    }
                },
                projectError?.let { error ->
                    PaneFeedbackError(error.feedbackOrder) {
                        ProjectDeleteSnackbar(chats, error, list.canDeleteProject, listSnackbar)
                    }
                },
                batchError?.let { error ->
                    PaneFeedbackError(error.feedbackOrder) {
                        MarkAllReadSnackbar(chats, error, listSnackbar)
                    }
                },
                refreshError?.let { (order, messageId) ->
                    PaneFeedbackError(order) {
                        val message = stringResource(messageId)
                        LaunchedEffect(chats, listSnackbar, order, message) {
                            try {
                                listSnackbar.showSnackbar(
                                    message,
                                    duration = SnackbarDuration.Indefinite,
                                )
                            } finally {
                                chats.dismissListRefreshFailure(order)
                            }
                        }
                    }
                },
            ),
        undo =
            if (listUndo != null) {
                {
                    ChatUndoFeedback(
                        chats,
                        listUndo,
                        listUndo.threadId in list.pendingRowActions,
                        listSnackbar,
                        onFocusedUndo = onFocusedListUndo,
                    )
                }
            } else null,
        result = {
            when {
                rowNotice != null -> ChatRowFailureFeedback(chats, list, rowNotice, listSnackbar)
                projectNotice != null ->
                    ProjectDeleteSnackbar(chats, projectNotice, list.canDeleteProject, listSnackbar)
                batchNotice != null -> MarkAllReadSnackbar(chats, batchNotice, listSnackbar)
                moveNotice != null -> {
                    val message =
                        moveNotice.projectName?.let {
                            stringResource(R.string.chat_project_moved_named, it)
                        } ?: stringResource(R.string.chat_project_moved_outside)
                    PaneFeedbackMessage(listSnackbar, moveNotice, message) {
                        chats.dismissChatMoveNotice(moveNotice)
                    }
                }
                renameTarget != null && renameOrigin == null && renameVisible ->
                    RenameSavedSnackbar(renameTarget, listSnackbar) {
                        if (savedRename == renameTarget) savedRename = null
                    }
            }
        },
    )
}

@Composable
private fun RenameSavedSnackbar(
    target: WorkspaceRenameTarget,
    snackbar: SnackbarHostState,
    onDismissed: () -> Unit,
) {
    val message =
        stringResource(
            when (target) {
                is WorkspaceRenameTarget.Chat -> R.string.chat_title_saved
                is WorkspaceRenameTarget.Project -> R.string.chat_project_name_saved
            },
        )
    PaneFeedbackMessage(snackbar, target, message, onDismissed)
}

@Composable
private fun ProjectDeleteSnackbar(
    chats: ChatListModel,
    feedback: ProjectDeleteFeedback,
    canDeleteProject: Boolean,
    snackbar: SnackbarHostState,
) {
    val unconfirmed = feedback.status == ProjectDeleteStatus.Unconfirmed
    val message =
        stringResource(
            when (feedback.status) {
                ProjectDeleteStatus.Confirmed -> R.string.chat_project_deleted
                ProjectDeleteStatus.Rejected -> R.string.chat_project_delete_rejected
                ProjectDeleteStatus.ConnectionFailed -> R.string.chat_action_connection_failed
                ProjectDeleteStatus.Unconfirmed -> R.string.chat_project_delete_unconfirmed
            },
        )
    val retry = if (unconfirmed && canDeleteProject) stringResource(R.string.retry) else null
    LaunchedEffect(chats, snackbar, feedback, message, retry) {
        val result =
            try {
                snackbar.showSnackbar(
                    message,
                    actionLabel = retry,
                    withDismissAction = unconfirmed,
                    duration = SnackbarDuration.Indefinite,
                )
            } finally {
                if (feedback.rejected) chats.dismissProjectDeleteFeedback(feedback)
            }
        if (result == SnackbarResult.ActionPerformed) chats.retryProjectDelete(feedback)
        else if (!feedback.rejected) chats.dismissProjectDeleteFeedback(feedback)
    }
}

@Composable
private fun MarkAllReadSnackbar(
    chats: ChatListModel,
    result: ChatMarkAllReadResult,
    snackbar: SnackbarHostState,
) {
    val message =
        when {
            result.confirmed == 0 -> stringResource(R.string.chat_mark_all_read_failed)
            result.confirmed == result.requested ->
                pluralStringResource(
                    R.plurals.chat_mark_all_read_success,
                    result.confirmed,
                    result.confirmed,
                )
            else ->
                stringResource(
                    R.string.chat_mark_all_read_partial_failed,
                    result.confirmed,
                    result.requested - result.confirmed,
                )
        }
    LaunchedEffect(chats, snackbar, result.feedbackOrder, message) {
        snackbar.showSnackbar(message, duration = SnackbarDuration.Indefinite)
        chats.dismissMarkAllReadResult(result)
    }
}

@Composable
private fun WorkspaceRenameForm(
    chats: ChatListModel,
    list: ChatListUiState,
    editor: ChatRenameEditor,
    dismiss: () -> Unit,
    saved: () -> Unit,
) {
    val target = editor.target
    val id = target.id
    when (target) {
        is WorkspaceRenameTarget.Chat -> {
            val thread = list.confirmedThreads.firstOrNull { it.id == id && it.hidden != true }
            if (thread == null) {
                if (list.listPhase == ChatReadPhase.Ready) LaunchedEffect(Unit) { dismiss() }
                return
            }
            val failure = list.rowActionFailures.lastOrNull { it.renameThreadId == id }
            val status =
                when {
                    list.pendingRowActions[id] == ChatRowAction.Rename -> RenameStatus.Saving
                    id in list.unconfirmedRenames ->
                        if (list.listPhase == ChatReadPhase.Loading) RenameStatus.Checking
                        else RenameStatus.Unconfirmed
                    failure?.rejected == true -> RenameStatus.Rejected
                    else -> RenameStatus.Editing
                }
            RenameListItemSheet(
                editor = editor,
                confirmedName =
                    (list.threads.firstOrNull { it.id == id } ?: thread).title.orEmpty(),
                confirmedEventId = list.confirmedRenameIds[id],
                titleRes = R.string.chat_rename,
                labelRes = R.string.chat_title_field,
                enabled =
                    ChatRowAction.Rename in list.rowActions(thread) &&
                        id !in list.pendingRowActions,
                status = status,
                check = { chats.checkChatRename(id) },
                dismiss = {
                    if (failure?.rejected == true) chats.dismissRowActionFailure(failure)
                    dismiss()
                },
                saved = saved,
                save = { chats.renameThread(id, it, target.fromConversation) },
            )
        }
        is WorkspaceRenameTarget.Project -> {
            val project = list.projects.firstOrNull { it.id == id }
            if (project == null) {
                if (list.projectsPhase == ChatReadPhase.Ready) LaunchedEffect(Unit) { dismiss() }
                return
            }
            val rejection = list.projectRenameRejection?.takeIf { it.projectId == id }
            val connectionFailed = id in list.projectList.connectionFailedRenames
            val status =
                when {
                    list.renamingProjectId == id -> RenameStatus.Saving
                    rejection != null || connectionFailed -> RenameStatus.Rejected
                    id in list.unconfirmedProjectRenames ->
                        if (list.projectsPhase == ChatReadPhase.Loading) RenameStatus.Checking
                        else RenameStatus.Unconfirmed
                    else -> RenameStatus.Editing
                }
            RenameListItemSheet(
                editor = editor,
                confirmedName = project.name,
                confirmedEventId = list.projectList.confirmedRenameIds[id],
                titleRes = R.string.chat_rename_project,
                labelRes = R.string.chat_project_name,
                projectName = true,
                enabled = list.canRenameProject,
                status = status,
                check = { chats.checkProjectRename(id) },
                dismiss = {
                    rejection?.let(chats::dismissProjectRenameRejection)
                    dismiss()
                },
                saved = saved,
                save = { chats.renameProject(id, it) },
            )
        }
    }
}

@Composable
private fun ChatRowFailureFeedback(
    chats: ChatListModel,
    list: ChatListUiState,
    failure: ChatRowActionFailure,
    snackbar: SnackbarHostState,
) {
    val action = failure.action
    val message =
        when {
            failure.fromUndo -> stringResource(R.string.chat_undo_failed)
            failure.rejected && !action.updatesChat && !failure.connectionFailed ->
                stringResource(R.string.chat_read_action_failed)
            action == ChatRowAction.Delete && failure.rejected && !failure.deleteFromWorkflow ->
                stringResource(R.string.chat_delete_rejected)
            failure.rejected && action.recoversInBackground ->
                stringResource(
                    if (failure.connectionFailed) R.string.chat_row_action_offline_named
                    else R.string.chat_row_action_rejected_named,
                    stringResource(action.label()),
                )
            else ->
                stringResource(
                    when {
                        failure.connectionFailed -> R.string.chat_action_connection_failed
                        failure.rejected -> R.string.chat_row_action_rejected
                        action.updatesChat -> R.string.chat_row_action_failed
                        else -> R.string.chat_read_action_failed
                    },
                )
        }
    val refreshLabel = if (failure.rejected) null else stringResource(R.string.chat_refresh)
    val retainOnRefresh = !failure.rejected && action.recoversInBackground
    val readPhase = if (action.updatesChat) list.listPhase else list.indicatorsPhase
    val content =
        rememberUpdatedState(
            ChatFeedbackContent(
                message,
                refreshLabel,
                enabled = !retainOnRefresh || readPhase != ChatReadPhase.Loading,
                showDismiss = !failure.rejected,
            ),
        )
    LaunchedEffect(chats, snackbar, failure) {
        try {
            val check = { chats.checkRowActionFailure(failure) }
            val result =
                snackbar.showSnackbar(
                    ChatFeedbackSnackbar(
                        content,
                        onAction = if (retainOnRefresh) ({ check() }) else null,
                    ),
                )
            if (result == SnackbarResult.ActionPerformed) check()
        } finally {
            if (failure.rejected) chats.dismissRowActionFailure(failure)
        }
        if (!failure.rejected) chats.dismissRowActionFailure(failure)
    }
}

@Composable
internal fun WorkspaceFeedbackTimeout(state: SnackbarHostState) {
    val accessibility = LocalAccessibilityManager.current
    val current = state.currentSnackbarData
    val timed = current?.visuals?.withDismissAction == false
    LaunchedEffect(current, timed, accessibility) {
        if (current != null && timed) {
            val duration =
                accessibility?.calculateRecommendedTimeoutMillis(
                    5_000L,
                    containsText = true,
                    containsControls = current.visuals.actionLabel != null,
                ) ?: 5_000L
            delay(duration)
            current.dismiss()
        }
    }
}

@Composable
internal fun workspaceFeedbackMessageHeight(message: String, availableWidth: Dp): Dp {
    val measurer = rememberTextMeasurer()
    val style = MaterialTheme.typography.bodyMedium
    return with(LocalDensity.current) {
        val surfaceWidth =
            minOf(
                availableWidth.roundToPx() - 2 * feedbackSideInset.roundToPx(),
                feedbackMaxWidth.roundToPx(),
            )
        val textWidth =
            (surfaceWidth - feedbackStartPadding.roundToPx() - feedbackEndPadding.roundToPx())
                .coerceAtLeast(0)
        val textHeight =
            measurer
                .measure(
                    message,
                    style,
                    constraints = Constraints(maxWidth = textWidth),
                )
                .size
                .height
        maxOf(feedbackTouchTarget, (textHeight + 2 * feedbackVerticalPadding.roundToPx()).toDp())
    }
}

@Composable
internal fun WorkspaceFeedbackHost(
    state: SnackbarHostState,
    modifier: Modifier,
    manageTimeout: Boolean = true,
    surfaceModifier: Modifier = Modifier,
    restorePaneFocus: (() -> Unit)? = null,
) {
    if (manageTimeout) WorkspaceFeedbackTimeout(state)
    val input = LocalInputModeManager.current
    val focused = remember(state) { mutableStateOf<SnackbarData?>(null) }
    val current = state.currentSnackbarData
    LaunchedEffect(current) {
        if (
            current != null &&
                focused.value != null &&
                focused.value !== current &&
                !current.visuals.withDismissAction &&
                input.inputMode == InputMode.Keyboard
        )
            restorePaneFocus?.invoke()
    }
    SnackbarHost(state) { data ->
        val visuals = data.visuals
        val style = MaterialTheme.typography.bodyMedium
        Surface(
            modifier =
                modifier
                    .padding(horizontal = feedbackSideInset)
                    .widthIn(max = feedbackMaxWidth)
                    .fillMaxWidth()
                    .then(surfaceModifier),
            shape = SnackbarDefaults.shape,
            color = SnackbarDefaults.color,
            contentColor = SnackbarDefaults.contentColor,
            shadowElevation = 6.dp,
        ) {
            FeedbackLayout(
                modifier =
                    Modifier.animateContentSize(alignment = Alignment.BottomCenter)
                        .padding(
                            start = feedbackStartPadding,
                            end = if (visuals.withDismissAction) 0.dp else feedbackEndPadding,
                        ),
                textSize = style.fontSize,
                message = {
                    Text(
                        visuals.message,
                        Modifier.padding(vertical = feedbackVerticalPadding),
                        style = style,
                    )
                },
                actions = {
                    FeedbackActions(
                        data,
                        Modifier.onFocusChanged {
                            if (it.hasFocus) focused.value = data
                            else if (focused.value === data) focused.value = null
                        },
                    ) {
                        focused.value === data && input.inputMode == InputMode.Keyboard
                    }
                },
            )
        }
    }
}

@Composable
private fun FeedbackActions(
    data: SnackbarData,
    modifier: Modifier,
    keyboardFocused: () -> Boolean,
) {
    val visuals = data.visuals
    val action = visuals as? ChatFeedbackSnackbar
    val label = visuals.actionLabel
    val dismissible = visuals.withDismissAction
    if (label == null && !dismissible) return
    val accent = SnackbarDefaults.actionContentColor
    Row(
        modifier = modifier.focusGroup(),
        horizontalArrangement = Arrangement.spacedBy(feedbackActionGap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (label != null) {
            TextButton(
                onClick = { action?.onAction?.invoke(keyboardFocused()) ?: data.performAction() },
                modifier =
                    Modifier.weight(1f, fill = false)
                        .sizeIn(minWidth = feedbackTouchTarget, minHeight = feedbackTouchTarget)
                        .updateFocusOutline(ButtonDefaults.textShape, accent),
                enabled = action?.content?.value?.enabled ?: true,
                contentPadding = PaddingValues(horizontal = 8.dp),
                colors =
                    ButtonDefaults.textButtonColors(
                        contentColor = accent,
                        disabledContentColor =
                            MaterialTheme.colorScheme.inverseOnSurface.copy(alpha = 0.38f),
                    ),
            ) {
                Text(label)
            }
        }
        if (dismissible) {
            IconButton(
                data::dismiss,
                Modifier.size(feedbackTouchTarget).updateFocusOutline(CircleShape, accent),
            ) {
                Icon(
                    painterResource(R.drawable.ic_close),
                    stringResource(R.string.chat_feedback_dismiss),
                    Modifier.size(24.dp),
                    tint = SnackbarDefaults.dismissActionContentColor,
                )
            }
        }
    }
}

@Composable
private fun FeedbackLayout(
    modifier: Modifier,
    textSize: TextUnit,
    message: @Composable () -> Unit,
    actions: @Composable () -> Unit,
) {
    Layout(
        content = {
            message()
            actions()
        },
        modifier = modifier.heightIn(min = feedbackTouchTarget),
    ) { children, bounds ->
        val loose = bounds.copy(minWidth = 0, minHeight = 0)
        val buttons = children.getOrNull(1)?.measure(loose)
        val width = bounds.maxWidth
        val maxTextWidth = width - (buttons?.width ?: 0) - 8.dp.roundToPx()
        val inline = buttons != null && maxTextWidth >= (textSize.toDp() * 8).roundToPx()
        val stackedHeight = if (inline) 0 else buttons?.height ?: 0
        val text =
            children[0].measure(
                loose.copy(
                    maxWidth = if (inline) maxTextWidth else width,
                    maxHeight = (bounds.maxHeight - stackedHeight).coerceAtLeast(0),
                ),
            )
        val height =
            bounds.constrainHeight(maxOf(text.height + stackedHeight, buttons?.height ?: 0))
        layout(width, height) {
            text.placeRelative(0, if (inline || buttons == null) (height - text.height) / 2 else 0)
            if (buttons != null) {
                val top = if (inline) (height - buttons.height) / 2 else height - buttons.height
                buttons.placeRelative(width - buttons.width, top)
            }
        }
    }
}
