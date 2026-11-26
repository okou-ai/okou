package ai.okou.android.workflows

import ai.okou.android.R
import ai.okou.android.api.generated.WorkflowRunHistoryEntry
import ai.okou.android.api.generated.WorkflowRunHistoryEntryEventType
import ai.okou.android.api.generated.WorkflowRunHistoryEntryStatus
import ai.okou.android.api.generated.WorkflowRunHistoryEntryTrigger
import ai.okou.android.chat.ChatSkeletonBlock
import ai.okou.android.rememberContentReadSkeleton
import ai.okou.android.updates.updateFocusOutline
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

internal class WorkflowHistoryLayout {
    private var listHeight by mutableIntStateOf(0)
    private var detailHeight by mutableIntStateOf(0)
    private var tabsHeight by mutableIntStateOf(0)
    private var headingHeight by mutableIntStateOf(0)

    val list = Modifier.onSizeChanged { listHeight = it.height }
    val detail = Modifier.onSizeChanged { detailHeight = it.height }
    val tabs = Modifier.onSizeChanged { tabsHeight = it.height }
    val heading = Modifier.onSizeChanged { headingHeight = it.height }

    fun body(padding: PaddingValues): Modifier = Modifier.layout { measurable, constraints ->
        val insets =
            padding.calculateTopPadding().roundToPx() + padding.calculateBottomPadding().roundToPx()
        val available = listHeight - detailHeight - tabsHeight - headingHeight - insets
        val minimum = available.coerceIn(constraints.minHeight, constraints.maxHeight)
        val content = measurable.measure(constraints.copy(minHeight = minimum))
        layout(content.width, content.height) { content.placeRelative(0, 0) }
    }
}

@Composable
internal fun WorkflowHistoryPending(failure: WorkflowReadFailure?, modifier: Modifier) {
    if (failure == WorkflowReadFailure.Unavailable) {
        WorkflowInitialReadError(R.string.workflow_history_unavailable)
    } else if (failure is WorkflowReadFailure.Failed) {
        WorkflowReadFailureContent(modifier)
    } else if (rememberContentReadSkeleton()) {
        val label = stringResource(R.string.workflow_history_loading)
        Column(
            Modifier.fillMaxWidth().testTag("workflow_history_loading").semantics {
                contentDescription = label
                progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate
            },
        ) {
            repeat(3) {
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ChatSkeletonBlock(Modifier.size(18.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        ChatSkeletonBlock(Modifier.fillMaxWidth(.56f).height(16.dp))
                        ChatSkeletonBlock(Modifier.fillMaxWidth(.32f).height(12.dp))
                    }
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
    restoreFocus: Boolean,
    onFocusRestored: () -> Unit,
    onOpenChat: (runId: String, threadId: String) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val source = run.chatThreadId?.takeIf(sourceChatAvailable)
    val openChatLabel = stringResource(R.string.workflow_history_open_chat)
    val requester = remember { FocusRequester() }
    LaunchedEffect(restoreFocus, source, sourceNavigationEnabled) {
        if (restoreFocus) {
            if (source != null && sourceNavigationEnabled) requester.requestFocus()
            onFocusRestored()
        }
    }
    val statusColor =
        when (run.status) {
            WorkflowRunHistoryEntryStatus.RUNNING -> MaterialTheme.colorScheme.primary
            WorkflowRunHistoryEntryStatus.FAILED,
            WorkflowRunHistoryEntryStatus.TIMEOUT -> colors.error
            else -> colors.onSurfaceVariant
        }
    val shape = RoundedCornerShape(8.dp)
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 52.dp)
            .clip(shape)
            .testTag("workflow_run_${run.id}")
            .then(
                if (source == null) Modifier.semantics(mergeDescendants = true) {}
                else
                    Modifier.focusRequester(requester)
                        .updateFocusOutline(shape, colors.onBackground)
                        .clickable(
                            enabled = sourceNavigationEnabled,
                            onClickLabel = openChatLabel,
                            role = Role.Button,
                            onClick = { onOpenChat(run.id, source) },
                        ),
            )
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painterResource(R.drawable.ic_schedule),
            null,
            Modifier.size(18.dp),
            tint = colors.onSurfaceVariant,
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                workflowTimestamp(run.createdAt, timezone),
                style = workflowBodyStyle(),
                fontWeight = FontWeight.SemiBold,
            )
            FlowRow(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                WorkflowSecondary(stringResource(run.triggerLabel), small = true)
                Row(
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "·",
                        Modifier.clearAndSetSemantics {},
                        color = colors.onSurfaceVariant,
                        style = workflowSmallStyle(),
                    )
                    WorkflowStatus(stringResource(run.status.label), statusColor)
                }
            }
        }
        if (source != null)
            Icon(painterResource(R.drawable.ic_chevron_right), null, Modifier.size(18.dp))
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
