package ai.okou.android.workflows

import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.R
import ai.okou.android.api.generated.WorkflowRunHistoryEntry
import ai.okou.android.api.generated.WorkflowRunHistoryEntryEventType
import ai.okou.android.api.generated.WorkflowRunHistoryEntryStatus
import ai.okou.android.api.generated.WorkflowRunHistoryEntryTrigger
import ai.okou.android.chat.ChatSkeletonBlock
import ai.okou.android.chat.rememberChatWaitIndicator
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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

@Composable
internal fun WorkflowHistoryPending(failure: WorkflowReadFailure?) {
    if (failure != null) {
        WorkflowNotice(
            when (failure) {
                WorkflowReadFailure.Unavailable -> R.string.workflow_history_unavailable
                WorkflowReadFailure.Offline -> R.string.workflow_history_offline
                WorkflowReadFailure.CouldNotLoad,
                WorkflowReadFailure.RefreshFailed -> R.string.workflow_history_failed
            }
        )
    } else if (rememberChatWaitIndicator(true)) {
        val label = stringResource(R.string.workflow_history_loading)
        Column(
            Modifier.fillMaxWidth().testTag("workflow_history_loading").semantics {
                contentDescription = label
                progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate
            }
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
    onOpenChat: (String) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val source = run.chatThreadId?.takeIf(sourceChatAvailable)
    val openChatLabel = stringResource(R.string.workflow_history_open_chat)
    val statusColor =
        when (run.status) {
            WorkflowRunHistoryEntryStatus.RUNNING -> LocalActivityStatusColor.current
            WorkflowRunHistoryEntryStatus.FAILED,
            WorkflowRunHistoryEntryStatus.TIMEOUT -> colors.error
            else -> colors.onSurfaceVariant
        }
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 52.dp)
            .clip(RoundedCornerShape(8.dp))
            .testTag("workflow_run_${run.id}")
            .then(
                if (source == null) Modifier.semantics(mergeDescendants = true) {}
                else
                    Modifier.clickable(
                        enabled = sourceNavigationEnabled,
                        onClickLabel = openChatLabel,
                        role = Role.Button,
                        onClick = { onOpenChat(source) },
                    )
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
