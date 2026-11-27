package ai.okou.android.workflows

import ai.okou.android.R
import ai.okou.android.api.generated.WorkflowRunHistoryEntry
import ai.okou.android.api.generated.WorkflowRunHistoryEntryEventType
import ai.okou.android.api.generated.WorkflowRunHistoryEntryStatus
import ai.okou.android.api.generated.WorkflowRunHistoryEntryTrigger
import ai.okou.android.chat.ChatSkeletonBlock
import ai.okou.android.updates.updateFocusOutline
import ai.okou.android.workspaceToolListItemShapes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val historyIconSize = 18.dp

internal class WorkflowHistoryLayout(padding: PaddingValues) {
    private var listHeight by mutableIntStateOf(0)
    private var detailHeight by mutableIntStateOf(0)
    private var tabsHeight by mutableIntStateOf(0)
    private var headingHeight by mutableIntStateOf(0)

    val list = Modifier.onSizeChanged { listHeight = it.height }
    val detail = Modifier.onSizeChanged { detailHeight = it.height }
    val tabs = Modifier.onSizeChanged { tabsHeight = it.height }
    val heading = Modifier.onSizeChanged { headingHeight = it.height }

    val body = Modifier.layout { measurable, constraints ->
        val insets =
            padding.calculateTopPadding().roundToPx() + padding.calculateBottomPadding().roundToPx()
        val available = listHeight - detailHeight - tabsHeight - headingHeight - insets
        val minimum = available.coerceIn(constraints.minHeight, constraints.maxHeight)
        val content = measurable.measure(constraints.copy(minHeight = minimum))
        layout(content.width, content.height) { content.placeRelative(0, 0) }
    }
}

@Composable
internal fun WorkflowHistoryPending(
    failure: WorkflowReadFailure?,
    showSkeleton: Boolean,
    modifier: Modifier,
) {
    if (failure == WorkflowReadFailure.Unavailable) {
        WorkflowInitialReadError(R.string.workflow_history_unavailable)
    } else if (failure is WorkflowReadFailure.Failed) {
        WorkflowReadFailureContent(modifier)
    } else if (showSkeleton) {
        val label = stringResource(R.string.workflow_history_loading)
        Column(
            Modifier.fillMaxWidth().testTag("workflow_history_loading").semantics {
                contentDescription = label
                progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate
            },
        ) {
            repeat(3) {
                ListItem(
                    modifier = Modifier.fillMaxWidth().testTag("workflow_history_loading_row"),
                    leadingContent = { ChatSkeletonBlock(Modifier.size(historyIconSize)) },
                    trailingContent = { Spacer(Modifier.size(historyIconSize)) },
                    supportingContent = { WorkflowSkeletonLine(.32f, 20.sp) },
                ) {
                    WorkflowSkeletonLine(.56f, 24.sp)
                }
            }
        }
    }
}

@Composable
internal fun WorkflowHistoryRow(
    run: WorkflowRunHistoryEntry,
    timezone: String,
    sourceChatAvailable: (String) -> Boolean,
    sourceNavigationEnabled: Boolean,
    onOpenChat: (runId: String, threadId: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val source = run.chatThreadId?.takeIf(sourceChatAvailable)
    val statusColor =
        when (run.status) {
            WorkflowRunHistoryEntryStatus.RUNNING -> MaterialTheme.colorScheme.primary
            WorkflowRunHistoryEntryStatus.FAILED,
            WorkflowRunHistoryEntryStatus.TIMEOUT -> colors.error
            else -> colors.onSurfaceVariant
        }
    val row = modifier.fillMaxWidth().testTag("workflow_run_${run.id}")
    val leading: @Composable () -> Unit = {
        Icon(
            painterResource(R.drawable.ic_schedule),
            null,
            Modifier.size(historyIconSize),
        )
    }
    val title: @Composable () -> Unit = { Text(workflowTimestamp(run.createdAt, timezone)) }
    val supporting: @Composable () -> Unit = {
        val trigger = stringResource(run.triggerLabel)
        val status = stringResource(run.status.label)
        val indicator =
            with(LocalDensity.current) {
                Placeholder(12.dp.toSp(), 7.dp.toSp(), PlaceholderVerticalAlign.TextCenter)
            }
        // One text layout gives ListItem the real supporting line count at every font scale.
        Text(
            buildAnnotatedString {
                append(trigger)
                append(" · ")
                appendInlineContent("statusIndicator", "\u2060")
                withStyle(SpanStyle(fontSize = 12.sp, color = colors.onSurfaceVariant)) {
                    append(status)
                }
            },
            inlineContent =
                mapOf(
                    "statusIndicator" to
                        InlineTextContent(indicator) {
                            Box(Modifier.size(7.dp).background(statusColor, CircleShape))
                        },
                ),
        )
    }
    if (source == null) {
        ListItem(
            modifier = row.semantics(mergeDescendants = true) {},
            leadingContent = leading,
            supportingContent = supporting,
            content = title,
        )
    } else {
        val openChatLabel = stringResource(R.string.workflow_history_open_chat)
        val shapes = workspaceToolListItemShapes()
        ListItem(
            onClick = { onOpenChat(run.id, source) },
            modifier =
                row.updateFocusOutline(shapes.focusedShape, colors.onBackground).semantics {
                    role = Role.Button
                    onClick(label = openChatLabel, action = null)
                },
            enabled = sourceNavigationEnabled,
            leadingContent = leading,
            trailingContent = {
                Icon(
                    painterResource(R.drawable.ic_chevron_right),
                    null,
                    Modifier.size(historyIconSize),
                )
            },
            supportingContent = supporting,
            shapes = shapes,
            content = title,
        )
    }
}

private val WorkflowRunHistoryEntryStatus.label: Int
    get() =
        when (this) {
            WorkflowRunHistoryEntryStatus.QUEUED -> R.string.history_queued
            WorkflowRunHistoryEntryStatus.PENDING -> R.string.workflow_run_pending
            WorkflowRunHistoryEntryStatus.RUNNING -> R.string.workflow_run_running
            WorkflowRunHistoryEntryStatus.COMPLETED -> R.string.history_completed
            WorkflowRunHistoryEntryStatus.FAILED -> R.string.history_run_failed
            WorkflowRunHistoryEntryStatus.TIMEOUT -> R.string.workflow_run_timeout
            WorkflowRunHistoryEntryStatus.CANCELLED -> R.string.history_cancelled
        }

private val WorkflowRunHistoryEntry.triggerLabel: Int
    get() =
        when (trigger) {
            WorkflowRunHistoryEntryTrigger.SCHEDULE -> R.string.workflow_history_scheduled
            WorkflowRunHistoryEntryTrigger.MANUAL -> R.string.workflow_history_manual
            null -> R.string.workflow_history_trigger_unavailable
            WorkflowRunHistoryEntryTrigger.EVENT ->
                when (eventType) {
                    WorkflowRunHistoryEntryEventType.CHAT_RUN_FINISHED ->
                        R.string.workflow_chat_finished
                    WorkflowRunHistoryEntryEventType.GMAIL_NEW_MESSAGE ->
                        R.string.workflow_mail_received
                    WorkflowRunHistoryEntryEventType.GMAIL_LABEL_APPLIED ->
                        R.string.workflow_mail_labeled
                    WorkflowRunHistoryEntryEventType.GITHUB_DEPLOYMENT_STATUS_CREATED ->
                        R.string.workflow_github_deployed
                    WorkflowRunHistoryEntryEventType.GITHUB_ISSUE_COMMENT_CREATED ->
                        R.string.workflow_github_commented
                    WorkflowRunHistoryEntryEventType.GITHUB_PULL_REQUEST ->
                        R.string.workflow_github_pr
                    WorkflowRunHistoryEntryEventType.GITHUB_PULL_REQUEST_REVIEW_SUBMITTED ->
                        R.string.workflow_github_reviewed
                    WorkflowRunHistoryEntryEventType.GITHUB_WORKFLOW_JOB_COMPLETED ->
                        R.string.workflow_github_job
                    WorkflowRunHistoryEntryEventType.GITHUB_WORKFLOW_RUN_COMPLETED ->
                        R.string.workflow_github_run
                    WorkflowRunHistoryEntryEventType.GOOGLE_CALENDAR_EVENT_CREATED ->
                        R.string.workflow_event_created
                    WorkflowRunHistoryEntryEventType.GOOGLE_CALENDAR_EVENT_UPDATED ->
                        R.string.workflow_event_updated
                    WorkflowRunHistoryEntryEventType.GOOGLE_CALENDAR_EVENT_CANCELLED ->
                        R.string.workflow_event_cancelled
                    WorkflowRunHistoryEntryEventType.GOOGLE_FORMS_RESPONSE_SUBMITTED ->
                        R.string.workflow_form_submitted
                    WorkflowRunHistoryEntryEventType.GOOGLE_MEET_TRANSCRIPT_GENERATED ->
                        R.string.workflow_transcript
                    WorkflowRunHistoryEntryEventType.NOTION_CHILD_PAGE_CREATED ->
                        R.string.workflow_notion_child
                    WorkflowRunHistoryEntryEventType.NOTION_DATABASE_ITEM_CREATED ->
                        R.string.workflow_notion_item
                    WorkflowRunHistoryEntryEventType.NOTION_PAGE_CONTENT_UPDATED ->
                        R.string.workflow_notion_updated
                    WorkflowRunHistoryEntryEventType.WEBHOOK_RECEIVED -> R.string.workflow_webhook
                    null -> R.string.workflow_history_event
                }
        }
