package ai.okou.android.chat

import ai.okou.android.ContentReadProgress
import ai.okou.android.R
import ai.okou.android.WithButtonFocusOutline
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FloatingActionButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import kotlinx.coroutines.flow.first

internal val ChatListRowShape = RoundedCornerShape(8.dp)
internal val ChatPaneBottomInset = 16.dp

internal fun Density.chatInlineFeedbackHeight() = maxOf(216.dp, 16.sp.toDp() * 9)

private enum class ListLayer {
    Controls,
    Feedback,
    Rows,
    Sync,
}

@Composable
internal fun ChatListViewport(
    modifier: Modifier,
    listState: LazyListState,
    contentChangeKey: Any?,
    syncing: Boolean,
    filter: ChatListFilter,
    newChatEnabled: Boolean,
    newChat: () -> Unit,
    feedback: @Composable () -> Unit,
    content: @Composable (Dp, (@Composable () -> Unit)?) -> Unit,
) {
    SubcomposeLayout(modifier) { bounds ->
        val height = bounds.maxHeight
        val short = height < chatInlineFeedbackHeight().roundToPx()
        val edge = ChatPaneBottomInset.roundToPx()
        val gap = 8.dp.roundToPx()
        val loose = bounds.copy(minWidth = 0, minHeight = 0)
        val floating =
            if (short) null
            else
                subcompose(ListLayer.Controls) {
                        Box(
                            Modifier.zIndex(1f).fillMaxWidth().padding(horizontal = 16.dp),
                            contentAlignment = Alignment.CenterEnd,
                        ) {
                            NewChatAction(newChatEnabled, newChat)
                        }
                    }
                    .single()
                    .measure(loose)
        val actionTop = bounds.maxHeight - edge - (floating?.height ?: 0)
        val feedbackBottom = (if (short) height - gap else actionTop - gap).coerceAtLeast(0)
        val feedbackLayer =
            subcompose(ListLayer.Feedback) { Box(Modifier.zIndex(2f)) { feedback() } }
                .single()
                .measure(loose.copy(maxHeight = feedbackBottom))
        val feedbackTop = feedbackBottom - feedbackLayer.height
        // Reserve scroll space for the persistent action. Feedback covers the rows independently.
        val reserve = ((floating?.let { edge + it.height } ?: 0) + gap).toDp()
        val inline: (@Composable () -> Unit)? =
            if (short) {
                {
                    Box(
                        Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        contentAlignment = Alignment.CenterEnd,
                    ) {
                        NewChatAction(newChatEnabled, newChat)
                    }
                }
            } else null
        val rows =
            subcompose(ListLayer.Rows) {
                    KeepLazyListEndInView(listState, reserve, height, short, contentChangeKey)
                    content(reserve, inline)
                }
                .single()
                .measure(loose)
        val progress =
            subcompose(ListLayer.Sync) {
                    Box {
                        key(filter) {
                            ContentReadProgress(R.string.chat_syncing, visible = syncing)
                        }
                    }
                }
                .single()
                .measure(loose.copy(maxWidth = rows.width))
        layout(bounds.maxWidth, bounds.maxHeight) {
            val rowsLeft = (bounds.maxWidth - rows.width) / 2
            rows.placeRelative(rowsLeft, 0)
            progress.placeRelative(rowsLeft, 0)
            floating?.placeRelative(0, actionTop)
            feedbackLayer.placeRelative((bounds.maxWidth - feedbackLayer.width) / 2, feedbackTop)
        }
    }
}

@Composable
internal fun KeepLazyListEndInView(
    listState: LazyListState,
    vararg layoutChanges: Any?,
    lastItemIndex: Int? = null,
) {
    // Lazy item keys retain older reading positions. Capture the end before the new layout.
    val followEnd =
        remember(listState, lastItemIndex, *layoutChanges) {
            listState.canScrollBackward && !listState.canScrollForward
        }
    LaunchedEffect(listState, lastItemIndex, *layoutChanges) {
        if (!followEnd) return@LaunchedEffect
        if (lastItemIndex != null) {
            snapshotFlow { listState.layoutInfo.totalItemsCount }.first { it > lastItemIndex }
        }
        val index = lastItemIndex ?: (listState.layoutInfo.totalItemsCount - 1)
        if (!listState.isScrollInProgress && index >= 0) listState.requestScrollToItem(index)
    }
}

@Composable
private fun NewChatAction(enabled: Boolean, onClick: () -> Unit) {
    val icon: @Composable () -> Unit = {
        Icon(painterResource(R.drawable.ic_edit_square), null, Modifier.size(24.dp))
    }
    val title = stringResource(R.string.composer_new)
    val label: @Composable () -> Unit = { Text(title) }
    val colors = MaterialTheme.colorScheme
    if (enabled) {
        WithButtonFocusOutline(colors.onPrimaryContainer) {
            ExtendedFloatingActionButton(
                text = label,
                icon = icon,
                onClick = onClick,
                modifier = Modifier.semantics { text = AnnotatedString(title) },
            )
        }
        return
    }
    Surface(
        onClick = onClick,
        enabled = false,
        modifier = Modifier.alpha(0.4f).semantics { role = Role.Button },
        shape = FloatingActionButtonDefaults.extendedFabShape,
        color = colors.primaryContainer,
        contentColor = colors.onPrimaryContainer,
        shadowElevation = 3.dp,
    ) {
        Row(
            Modifier.widthIn(min = 80.dp).heightIn(min = 56.dp).padding(start = 16.dp, end = 20.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            icon()
            androidx.compose.material3.ProvideTextStyle(MaterialTheme.typography.labelLarge, label)
        }
    }
}

@Composable
internal fun ChatSkeletonBlock(modifier: Modifier, cornerRadius: Dp = 8.dp) {
    Box(
        modifier.background(
            MaterialTheme.colorScheme.surfaceVariant,
            RoundedCornerShape(cornerRadius),
        ),
    )
}

@Composable
internal fun ChatListSkeleton(@StringRes loadingLabel: Int = R.string.chat_loading) {
    val label = stringResource(loadingLabel)
    Column(Modifier.semantics { contentDescription = label }) {
        val widths = listOf(.56f, .70f, .44f)
        repeat(6) { index ->
            ListItem(modifier = Modifier.fillMaxWidth()) {
                ChatSkeletonBlock(Modifier.fillMaxWidth(widths[index % widths.size]).height(14.dp))
            }
        }
    }
}
