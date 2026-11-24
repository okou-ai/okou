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
import ai.okou.android.chat.DeleteProjectDialog
import ai.okou.android.chat.ProjectDeleteFeedback
import ai.okou.android.chat.ProjectDeleteStatus
import ai.okou.android.chat.ProjectNameLimit
import ai.okou.android.chat.RenameListItemSheet
import ai.okou.android.chat.RenameStatus
import ai.okou.android.chat.WorkspaceRenameTarget
import ai.okou.android.chat.canDeleteProject
import ai.okou.android.chat.canRenameProject
import ai.okou.android.chat.label
import ai.okou.android.chat.nextChatFeedbackOrder
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarData
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalAccessibilityManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

private val feedbackActionGap = 4.dp
private val feedbackTouchTarget = 48.dp
private val feedbackActionShape = RoundedCornerShape(8.dp)

private data class ChatFeedbackContent(
    val message: String,
    val actionLabel: String?,
    val enabled: Boolean,
    val showDismiss: Boolean,
)

private class ChatFeedbackSnackbar(
    val content: State<ChatFeedbackContent>,
    val onAction: (() -> Unit)? = null,
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
) {
    val persistent = undo.phase != ChatUndoPhase.Failed
    val message =
        when (undo.phase) {
            ChatUndoPhase.Offered ->
                stringResource(
                    when (undo.action) {
                        ChatRowAction.Archive -> R.string.chat_undo_archived
                        ChatRowAction.Unarchive -> R.string.chat_undo_unarchived
                        else -> R.string.chat_undo_marked_read
                    },
                )
            ChatUndoPhase.Checking -> stringResource(R.string.chat_undo_checking)
            ChatUndoPhase.Failed -> stringResource(R.string.chat_undo_failed)
            ChatUndoPhase.Unconfirmed -> stringResource(R.string.chat_undo_unconfirmed)
        }
    val action =
        when {
            undo.phase == ChatUndoPhase.Unconfirmed -> stringResource(R.string.chat_refresh)
            persistent -> stringResource(R.string.chat_undo)
            else -> null
        }
    key(chats, undo.sequence) {
        val currentUndo = rememberUpdatedState(undo)
        val content =
            rememberUpdatedState(
                ChatFeedbackContent(
                    message,
                    action,
                    undo.phase != ChatUndoPhase.Checking && !actionPending,
                    persistent,
                ),
            )
        LaunchedEffect(snackbar) {
            snackbar.currentSnackbarData?.dismiss()
            snackbar.showSnackbar(
                ChatFeedbackSnackbar(content) {
                    val current = currentUndo.value
                    if (current.phase == ChatUndoPhase.Unconfirmed) chats.checkRowUndo(current)
                    else chats.undoRowAction(current)
                },
            )
            chats.dismissRowUndo(undo)
        }
    }
}

internal class ConversationNavigationError(val threadId: String, val message: String) {
    val feedbackOrder = nextChatFeedbackOrder()
}

@Composable
internal fun WorkspaceChatFeedback(
    chats: ChatListModel,
    listState: State<ChatListUiState>,
    listSnackbar: SnackbarHostState,
    conversationSnackbar: SnackbarHostState,
    showChatList: Boolean,
    visibleConversationId: String?,
    navigationError: ConversationNavigationError?,
    dismissNavigationError: (ConversationNavigationError) -> Unit,
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
    val deleteFeedback = list.projectDeleteFeedback
    val deleteProject = list.projects.firstOrNull { it.id == confirmingProjectDelete }
    if (deleteProject != null && showChatList) {
        val feedback = deleteFeedback?.takeIf { it.projectId == deleteProject.id }
        DeleteProjectDialog(
            projectName = deleteProject.name,
            pending = list.projectList.deletingId == deleteProject.id,
            status = feedback?.status,
            enabled = list.canDeleteProject,
            dismiss = {
                dismissProjectDelete()
                if (
                    feedback?.status == ProjectDeleteStatus.Rejected ||
                        feedback?.status == ProjectDeleteStatus.ConnectionFailed
                )
                    chats.dismissProjectDeleteFeedback(feedback)
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
    val conversationNotice = conversationFailures.firstOrNull()
    val firstConversationError =
        minOf(
            conversationError?.feedbackOrder ?: Long.MAX_VALUE,
            navigationError?.feedbackOrder ?: Long.MAX_VALUE,
            conversationUndo?.failureOrder ?: Long.MAX_VALUE,
        )
    when {
        conversationError != null && conversationError.feedbackOrder == firstConversationError ->
            ChatRowFailureFeedback(chats, list, conversationError, conversationSnackbar)
        navigationError != null && navigationError.feedbackOrder == firstConversationError ->
            LaunchedEffect(conversationSnackbar, navigationError) {
                conversationSnackbar.currentSnackbarData?.dismiss()
                conversationSnackbar.showSnackbar(
                    navigationError.message,
                    duration = SnackbarDuration.Indefinite,
                )
                dismissNavigationError(navigationError)
            }
        conversationUndo != null ->
            ChatUndoFeedback(
                chats,
                conversationUndo,
                conversationUndo.threadId in list.pendingRowActions,
                conversationSnackbar,
            )
        conversationNotice != null ->
            ChatRowFailureFeedback(chats, list, conversationNotice, conversationSnackbar)
    }

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
    val projectNotice = deleteFeedback?.takeIf { showChatList && it.projectId != deleteProject?.id }
    val projectError = projectNotice?.takeIf {
        it.status == ProjectDeleteStatus.Rejected ||
            it.status == ProjectDeleteStatus.ConnectionFailed
    }
    val batchError = if (showChatList) batchResults.firstOrNull { it.rejected > 0 } else null
    val listUndo = list.rowUndo?.takeIf { showChatList }
    val firstError =
        listOfNotNull(
                rowError?.feedbackOrder,
                projectError?.feedbackOrder,
                batchError?.feedbackOrder,
                listUndo?.failureOrder,
            )
            .minOrNull()
    val rowNotice = listFailures.firstOrNull()
    val batchNotice = batchResults.firstOrNull()?.takeIf { showChatList }
    val moveNotice = list.chatMoveNotice?.takeIf { showChatList }
    when {
        rowError != null && rowError.feedbackOrder == firstError ->
            ChatRowFailureFeedback(chats, list, rowError, listSnackbar)
        projectError != null && projectError.feedbackOrder == firstError ->
            ProjectDeleteSnackbar(chats, projectError, list.canDeleteProject, listSnackbar)
        batchError != null && batchError.feedbackOrder == firstError ->
            MarkAllReadSnackbar(chats, batchError, listSnackbar)
        listUndo != null ->
            ChatUndoFeedback(
                chats,
                listUndo,
                listUndo.threadId in list.pendingRowActions,
                listSnackbar,
            )
        rowNotice != null -> ChatRowFailureFeedback(chats, list, rowNotice, listSnackbar)
        projectNotice != null ->
            ProjectDeleteSnackbar(chats, projectNotice, list.canDeleteProject, listSnackbar)
        batchNotice != null -> MarkAllReadSnackbar(chats, batchNotice, listSnackbar)
        moveNotice != null -> {
            val message =
                moveNotice.projectName?.let {
                    stringResource(R.string.chat_project_moved_named, it)
                } ?: stringResource(R.string.chat_project_moved_outside)
            LaunchedEffect(chats, listSnackbar, moveNotice, message) {
                listSnackbar.showSnackbar(message, duration = SnackbarDuration.Indefinite)
                chats.dismissChatMoveNotice(moveNotice)
            }
        }
    }

    savedRename?.let { target ->
        val origin = (target as? WorkspaceRenameTarget.Chat)?.takeIf { it.fromConversation }?.id
        val visible = if (origin == null) showChatList else origin == visibleConversationId
        val snackbar = if (origin == null) listSnackbar else conversationSnackbar
        val pendingUndo = if (origin == null) listUndo else conversationUndo
        val message =
            stringResource(
                when (target) {
                    is WorkspaceRenameTarget.Chat -> R.string.chat_title_saved
                    is WorkspaceRenameTarget.Project -> R.string.chat_project_name_saved
                },
            )
        LaunchedEffect(target, visible) {
            if (visible && pendingUndo == null && snackbar.currentSnackbarData == null)
                snackbar.showSnackbar(message, duration = SnackbarDuration.Indefinite)
            if (savedRename == target) savedRename = null
        }
    }
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
        val error =
            feedback.status == ProjectDeleteStatus.Rejected ||
                feedback.status == ProjectDeleteStatus.ConnectionFailed
        if (error) snackbar.currentSnackbarData?.dismiss()
        val result =
            snackbar.showSnackbar(
                message,
                actionLabel = retry,
                withDismissAction = unconfirmed,
                duration = SnackbarDuration.Indefinite,
            )
        if (result == SnackbarResult.ActionPerformed) chats.retryProjectDelete(feedback)
        else chats.dismissProjectDeleteFeedback(feedback)
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
            result.rejected == result.requested ->
                stringResource(R.string.chat_mark_all_read_failed)
            result.confirmed == result.requested ->
                pluralStringResource(
                    R.plurals.chat_mark_all_read_success,
                    result.confirmed,
                    result.confirmed,
                )
            result.rejected > 0 && result.confirmed + result.rejected == result.requested ->
                stringResource(
                    R.string.chat_mark_all_read_partial_failed,
                    result.confirmed,
                    result.rejected,
                )
            result.rejected > 0 ->
                stringResource(
                    R.string.chat_mark_all_read_mixed,
                    result.confirmed,
                    result.rejected,
                    result.requested - result.confirmed - result.rejected,
                )
            result.confirmed > 0 ->
                pluralStringResource(
                    R.plurals.chat_mark_all_read_partial,
                    result.confirmed,
                    result.confirmed,
                    result.requested,
                )
            else -> stringResource(R.string.chat_mark_all_read_unconfirmed)
        }
    LaunchedEffect(chats, snackbar, result.feedbackOrder, message) {
        if (result.rejected > 0) snackbar.currentSnackbarData?.dismiss()
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
                confirmedName = thread.title.orEmpty(),
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
                titleRes = R.string.chat_rename_project,
                labelRes = R.string.chat_project_name,
                maxLength = ProjectNameLimit,
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
                        action.updatesChat || failure.readIntent != null ->
                            R.string.chat_row_action_failed
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
        if (failure.rejected) snackbar.currentSnackbarData?.dismiss()
        try {
            val check = { chats.checkRowActionFailure(failure) }
            val result =
                snackbar.showSnackbar(
                    ChatFeedbackSnackbar(
                        content,
                        onAction = check.takeIf { retainOnRefresh },
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
internal fun WorkspaceFeedbackHost(
    state: SnackbarHostState,
    modifier: Modifier,
    manageTimeout: Boolean = true,
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
        val style = MaterialTheme.typography.bodyMedium.copy(letterSpacing = 0.sp)
        Surface(
            modifier = modifier.padding(horizontal = 12.dp).widthIn(max = 480.dp).fillMaxWidth(),
            shape = RoundedCornerShape(12.dp),
            color = MaterialTheme.colorScheme.inverseSurface,
            contentColor = MaterialTheme.colorScheme.inverseOnSurface,
            shadowElevation = 4.dp,
        ) {
            FeedbackLayout(
                modifier = Modifier.animateContentSize(alignment = Alignment.BottomCenter),
                textSize = style.fontSize,
                message = {
                    Text(visuals.message, Modifier.padding(vertical = 12.dp), style = style)
                },
                actions = {
                    FeedbackActions(
                        data,
                        style,
                        Modifier.onFocusChanged {
                            if (it.hasFocus) focused.value = data
                            else if (focused.value === data) focused.value = null
                        },
                    )
                },
            )
        }
    }
}

@Composable
private fun FeedbackActions(data: SnackbarData, style: TextStyle, modifier: Modifier) {
    val visuals = data.visuals
    val action = visuals as? ChatFeedbackSnackbar
    val label = visuals.actionLabel
    val dismissible = visuals.withDismissAction
    if (label == null && !dismissible) return
    val accent = MaterialTheme.colorScheme.inversePrimary
    Row(
        modifier = modifier.focusGroup(),
        horizontalArrangement = Arrangement.spacedBy(feedbackActionGap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (label != null) {
            TextButton(
                onClick = { action?.onAction?.invoke() ?: data.performAction() },
                modifier =
                    Modifier.weight(1f, fill = false)
                        .sizeIn(minWidth = feedbackTouchTarget, minHeight = feedbackTouchTarget)
                        .updateFocusOutline(feedbackActionShape, accent),
                enabled = action?.content?.value?.enabled ?: true,
                contentPadding = PaddingValues(horizontal = 8.dp),
                shape = feedbackActionShape,
                colors =
                    ButtonDefaults.textButtonColors(
                        contentColor = accent,
                        disabledContentColor =
                            MaterialTheme.colorScheme.inverseOnSurface.copy(alpha = 0.38f),
                    ),
            ) {
                Text(label, style = style.copy(fontWeight = FontWeight.SemiBold))
            }
        }
        if (dismissible) {
            IconButton(
                data::dismiss,
                Modifier.size(feedbackTouchTarget)
                    .clip(feedbackActionShape)
                    .updateFocusOutline(feedbackActionShape, accent),
            ) {
                Icon(
                    painterResource(R.drawable.ic_close),
                    stringResource(R.string.chat_feedback_dismiss),
                    Modifier.size(20.dp),
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
        modifier = modifier.heightIn(min = 48.dp).padding(horizontal = 12.dp),
    ) { children, bounds ->
        val loose = bounds.copy(minWidth = 0, minHeight = 0)
        val buttons = children.getOrNull(1)?.measure(loose)
        val width = bounds.maxWidth
        val maxTextWidth = width - (buttons?.width ?: 0) - feedbackActionGap.roundToPx()
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
