package ai.okou.android

import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ChatListUiState
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.ChatRowAction
import ai.okou.android.chat.ChatRowUndo
import ai.okou.android.chat.ChatUndoPhase
import ai.okou.android.chat.DeleteProjectDialog
import ai.okou.android.chat.ProjectDeleteStatus
import ai.okou.android.chat.canDeleteProject
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.runtime.key
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalAccessibilityManager
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

private data class UndoContent(
    val undo: ChatRowUndo,
    val message: String,
    val actionLabel: String?,
    val enabled: Boolean,
    val showDismiss: Boolean,
)

private class ChatUndoSnackbar(val content: State<UndoContent>, val onAction: () -> Unit) :
    SnackbarVisuals {
    override val message
        get() = content.value.message

    override val actionLabel
        get() = content.value.actionLabel

    override val withDismissAction
        get() = content.value.showDismiss

    override val duration = SnackbarDuration.Indefinite
}

@Composable
internal fun ChatUndoFeedback(
    chats: ChatListModel,
    list: ChatListUiState,
    snackbar: SnackbarHostState,
) {
    val undo = list.rowUndo ?: return
    val persistent = undo.phase != ChatUndoPhase.Failed
    val message =
        when (undo.phase) {
            ChatUndoPhase.Offered ->
                stringResource(
                    when (undo.action) {
                        ChatRowAction.Archive -> R.string.chat_undo_archived
                        ChatRowAction.Unarchive -> R.string.chat_undo_unarchived
                        else -> R.string.chat_undo_marked_read
                    }
                )
            ChatUndoPhase.Checking -> stringResource(R.string.chat_undo_checking)
            ChatUndoPhase.ConnectionFailed -> stringResource(R.string.chat_undo_connection_failed)
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
        val content =
            rememberUpdatedState(
                UndoContent(
                    undo,
                    message,
                    action,
                    undo.phase != ChatUndoPhase.Checking &&
                        undo.threadId !in list.pendingRowActions,
                    persistent,
                )
            )
        LaunchedEffect(snackbar) {
            snackbar.currentSnackbarData?.dismiss()
            snackbar.showSnackbar(
                ChatUndoSnackbar(content) {
                    val current = content.value.undo
                    if (current.phase == ChatUndoPhase.Unconfirmed) chats.checkRowUndo(current)
                    else chats.undoRowAction(current)
                }
            )
            chats.dismissRowUndo(undo)
        }
    }
}

@Composable
internal fun WorkspaceChatFeedback(
    chats: ChatListModel,
    listState: State<ChatListUiState>,
    snackbar: SnackbarHostState,
    showChatList: Boolean,
    showRowFeedback: Boolean,
    showRowActionFailure: Boolean,
    confirmingProjectDelete: String?,
    dismissProjectDelete: () -> Unit,
) {
    val list = listState.value
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
    LaunchedEffect(chats, showChatList) { if (!showChatList) chats.clearRowUndo() }
    if (showRowFeedback) ChatUndoFeedback(chats, list, snackbar)
    if (showRowFeedback && list.rowUndo == null) {
        list.chatMoveNotice?.let { notice ->
            val message =
                notice.projectName?.let { stringResource(R.string.chat_project_moved_named, it) }
                    ?: stringResource(R.string.chat_project_moved_outside)
            LaunchedEffect(chats, notice, message) {
                snackbar.showSnackbar(message, duration = SnackbarDuration.Short)
                chats.dismissChatMoveNotice(notice)
            }
        }
        deleteFeedback
            ?.takeUnless { it.projectId == deleteProject?.id }
            ?.let { feedback ->
                val unconfirmed = feedback.status == ProjectDeleteStatus.Unconfirmed
                val message =
                    stringResource(
                        when (feedback.status) {
                            ProjectDeleteStatus.Confirmed -> R.string.chat_project_deleted
                            ProjectDeleteStatus.Rejected -> R.string.chat_project_delete_rejected
                            ProjectDeleteStatus.ConnectionFailed ->
                                R.string.chat_action_connection_failed
                            ProjectDeleteStatus.Unconfirmed ->
                                R.string.chat_project_delete_unconfirmed
                        }
                    )
                val retry =
                    if (unconfirmed && list.canDeleteProject) stringResource(R.string.retry)
                    else null
                LaunchedEffect(chats, feedback, message, retry) {
                    val result =
                        snackbar.showSnackbar(
                            message,
                            actionLabel = retry,
                            withDismissAction = unconfirmed,
                            duration =
                                if (unconfirmed) SnackbarDuration.Indefinite
                                else SnackbarDuration.Short,
                        )
                    if (result == SnackbarResult.ActionPerformed) chats.retryProjectDelete(feedback)
                    else chats.dismissProjectDeleteFeedback(feedback)
                }
            }
    }
    list.failedRowAction
        ?.takeIf { list.rowUndo == null }
        ?.let { failure ->
            val action = failure.action
            val message =
                stringResource(
                    when {
                        failure.connectionFailed -> R.string.chat_action_connection_failed
                        failure.rejected -> R.string.chat_row_action_rejected
                        action.updatesChat -> R.string.chat_row_action_failed
                        else -> R.string.chat_read_action_failed
                    }
                )
            val refreshLabel = if (failure.rejected) null else stringResource(R.string.chat_refresh)
            LaunchedEffect(chats, failure, message, showRowActionFailure) {
                if (
                    showRowActionFailure &&
                        snackbar.showSnackbar(
                            message,
                            actionLabel = refreshLabel,
                            withDismissAction = !failure.rejected,
                            duration =
                                if (failure.rejected) SnackbarDuration.Short
                                else SnackbarDuration.Indefinite,
                        ) == SnackbarResult.ActionPerformed
                ) {
                    if (action.updatesChat) chats.reloadAfterRowActionFailure()
                    else chats.retryIndicators()
                }
                chats.dismissRowActionFailure(failure)
            }
        }
    list.markAllReadResult
        ?.takeIf { list.rowUndo == null }
        ?.let { result ->
            val message =
                when {
                    result.connectionFailed ->
                        stringResource(R.string.chat_action_connection_failed)
                    result.confirmed == result.requested ->
                        pluralStringResource(
                            R.plurals.chat_mark_all_read_success,
                            result.confirmed,
                            result.confirmed,
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
            LaunchedEffect(chats, result, message, showChatList) {
                if (showChatList)
                    snackbar.showSnackbar(message, duration = SnackbarDuration.Indefinite)
                chats.dismissMarkAllReadResult(result)
            }
        }
}

@Composable
internal fun WorkspaceFeedbackHost(state: SnackbarHostState, modifier: Modifier) {
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
    SnackbarHost(state) { data ->
        val visuals = data.visuals
        val style = MaterialTheme.typography.bodyMedium.copy(letterSpacing = 0.sp)
        Surface(
            modifier = modifier.padding(horizontal = 12.dp).widthIn(max = 480.dp).fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
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
                actions = { FeedbackActions(data, style) },
            )
        }
    }
}

@Composable
private fun FeedbackActions(data: SnackbarData, style: TextStyle) {
    val visuals = data.visuals
    val undo = visuals as? ChatUndoSnackbar
    val label = visuals.actionLabel
    val dismissible = visuals.withDismissAction
    if (label == null && !dismissible) return
    Row(
        horizontalArrangement = Arrangement.spacedBy(feedbackActionGap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (label != null) {
            TextButton(
                onClick = { if (undo != null) undo.onAction() else data.performAction() },
                modifier =
                    Modifier.weight(1f, fill = false)
                        .sizeIn(minWidth = feedbackTouchTarget, minHeight = feedbackTouchTarget),
                enabled = undo?.content?.value?.enabled ?: true,
                contentPadding = PaddingValues(horizontal = 8.dp),
                colors =
                    ButtonDefaults.textButtonColors(
                        contentColor =
                            if (dismissible) LocalUndoActionColor.current
                            else MaterialTheme.colorScheme.inversePrimary,
                        disabledContentColor =
                            MaterialTheme.colorScheme.inverseOnSurface.copy(alpha = 0.38f),
                    ),
            ) {
                Text(label, style = style.copy(fontWeight = FontWeight.SemiBold))
            }
        }
        if (dismissible) {
            IconButton(data::dismiss, Modifier.size(feedbackTouchTarget)) {
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
                )
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
