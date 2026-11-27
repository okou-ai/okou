package ai.okou.android.workflows

import ai.okou.android.R
import ai.okou.android.WorkspaceToolDirectoryRowSkeleton
import ai.okou.android.chat.ChatSkeletonBlock
import ai.okou.android.rememberContentReadSkeleton
import ai.okou.android.state.WorkflowTab
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun WorkflowDirectorySkeleton(modifier: Modifier) {
    if (!rememberContentReadSkeleton()) return
    Column(modifier.workflowLoading()) {
        repeat(5) {
            WorkspaceToolDirectoryRowSkeleton {
                WorkflowSkeletonLine(.7f, 24.sp)
                WorkflowSkeletonLine(.82f, 20.sp)
                WorkflowSkeletonLine(.5f, 20.sp)
            }
        }
    }
}

@Composable
internal fun WorkflowDetailSkeleton(modifier: Modifier) {
    if (!rememberContentReadSkeleton()) return
    Column(modifier.workflowLoading()) {
        WorkflowSkeletonLine(.52f, 32.sp, barHeight = 24.dp)
        Spacer(Modifier.height(8.dp))
        WorkflowSkeletonLine(.8f, 24.sp, alignment = Alignment.TopStart)
        Spacer(Modifier.height(12.dp))
        // Leave room for the padded command chip and the adjacent scope label.
        WorkflowSkeletonLine(.44f, 16.sp, modifier = Modifier.padding(vertical = 4.dp))
        Spacer(Modifier.height(20.dp))
        val tabsHeight = with(LocalDensity.current) { 20.sp.toDp() + 16.dp }
        Row(
            Modifier.fillMaxWidth()
                .heightIn(min = maxOf(48.dp, tabsHeight))
                .testTag("workflow_loading_tabs"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            repeat(WorkflowTab.entries.size) {
                Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                    ChatSkeletonBlock(Modifier.fillMaxWidth(.64f).height(12.dp))
                }
            }
        }
        WorkflowDivider()
        Spacer(Modifier.height(12.dp))
        WorkflowSkeletonLine(.8f, 24.sp)
        WorkflowSkeletonLine(.64f, 24.sp)
    }
}

@Composable
internal fun WorkflowSkeletonLine(
    width: Float,
    lineHeight: TextUnit,
    modifier: Modifier = Modifier,
    barHeight: Dp = 14.dp,
    alignment: Alignment = Alignment.CenterStart,
) {
    val height = with(LocalDensity.current) { lineHeight.toDp() }
    Box(modifier.fillMaxWidth().heightIn(min = height), contentAlignment = alignment) {
        ChatSkeletonBlock(Modifier.fillMaxWidth(width).height(barHeight))
    }
}

@Composable
private fun Modifier.workflowLoading(): Modifier {
    val label = stringResource(R.string.workspace_workflows)
    return fillMaxWidth().testTag("workflow_loading").semantics {
        contentDescription = label
        progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate
    }
}
