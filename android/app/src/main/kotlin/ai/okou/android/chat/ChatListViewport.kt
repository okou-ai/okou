package ai.okou.android.chat

import ai.okou.android.ContentReadProgress
import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.R
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first

internal val ChatListRowHeight = 52.dp
internal val ChatListRowShape = RoundedCornerShape(8.dp)
internal val ChatListRowPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)
internal val ChatPaneBottomInset = 16.dp
internal const val ChatListSkeletonDelayMillis = 250L

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
        val feedbackLayer =
            subcompose(ListLayer.Feedback) { Box(Modifier.zIndex(2f)) { feedback() } }
                .single()
                .measure(loose)
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
        val feedbackBottom = if (short) bounds.maxHeight - gap else actionTop - gap
        val feedbackTop = (feedbackBottom - feedbackLayer.height).coerceAtLeast(0)
        val highestOverlay =
            when {
                feedbackLayer.height > 0 -> feedbackTop
                floating != null -> actionTop
                else -> bounds.maxHeight
            }
        val reserve = (bounds.maxHeight - highestOverlay + gap).toDp()
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
            if (syncing) {
                subcompose(ListLayer.Sync) { ChatReadProgress(R.string.chat_syncing) }
                    .single()
                    .measure(loose.copy(maxWidth = rows.width))
            } else null
        layout(bounds.maxWidth, bounds.maxHeight) {
            val rowsLeft = (bounds.maxWidth - rows.width) / 2
            rows.placeRelative(rowsLeft, 0)
            progress?.placeRelative(rowsLeft, 0)
            floating?.placeRelative(0, actionTop)
            feedbackLayer.placeRelative((bounds.maxWidth - feedbackLayer.width) / 2, feedbackTop)
        }
    }
}

@Composable
internal fun ChatReadProgress(@StringRes label: Int) {
    val color = LocalActivityStatusColor.current
    ContentReadProgress(
        description = stringResource(label),
        color = color,
        trackColor = color.copy(alpha = 0.12f).compositeOver(MaterialTheme.colorScheme.background),
    )
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
    val colors = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.alpha(if (enabled) 1f else 0.4f).semantics { role = Role.Button },
        shape = RoundedCornerShape(16.dp),
        color = colors.inverseSurface,
        contentColor = colors.inverseOnSurface,
        shadowElevation = 3.dp,
    ) {
        Row(
            Modifier.heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(painterResource(R.drawable.ic_edit_square), null, Modifier.size(22.dp))
            Text(
                stringResource(R.string.composer_new),
                style =
                    MaterialTheme.typography.labelLarge.copy(
                        fontSize = 14.sp,
                        lineHeight = 20.sp,
                        letterSpacing = 0.sp,
                    ),
                fontWeight = FontWeight(550),
            )
        }
    }
}

@Composable
internal fun rememberChatWaitIndicator(waiting: Boolean, delayMillis: Long = 100): Boolean {
    var visible by remember(waiting, delayMillis) { mutableStateOf(false) }
    LaunchedEffect(waiting, delayMillis) {
        if (waiting) {
            delay(delayMillis)
            visible = true
        }
    }
    return visible
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
            Box(
                Modifier.fillMaxWidth()
                    .heightIn(min = ChatListRowHeight)
                    .padding(ChatListRowPadding),
                contentAlignment = Alignment.CenterStart,
            ) {
                ChatSkeletonBlock(Modifier.fillMaxWidth(widths[index % widths.size]).height(14.dp))
            }
        }
    }
}
