package ai.okou.android.chat

import ai.okou.android.R
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex

internal enum class ChatListStatus {
    Offline,
    RefreshFailed,
}

private enum class ListLayer {
    Controls,
    Feedback,
    Rows,
}

@Composable
internal fun ChatListViewport(
    modifier: Modifier,
    listState: LazyListState,
    status: ChatListStatus?,
    newChatEnabled: Boolean,
    newChat: () -> Unit,
    feedback: @Composable () -> Unit,
    content: @Composable (Dp, (@Composable () -> Unit)?) -> Unit,
) {
    SubcomposeLayout(modifier) { bounds ->
        val height = bounds.maxHeight
        val short = height < maxOf(216.dp, 16.sp.toDp() * 9).roundToPx()
        val edge = 16.dp.roundToPx()
        val gap = 8.dp.roundToPx()
        val loose = bounds.copy(minWidth = 0, minHeight = 0)
        val feedbackLayer =
            subcompose(ListLayer.Feedback) { Box(Modifier.zIndex(2f)) { feedback() } }
                .single()
                .measure(loose)
        val visibleStatus =
            status.takeUnless { it == ChatListStatus.RefreshFailed && feedbackLayer.height > 0 }
        val floating =
            if (short) null
            else
                subcompose(ListLayer.Controls) {
                        ListControls(
                            Modifier.zIndex(1f).fillMaxWidth().padding(horizontal = 16.dp),
                            visibleStatus,
                            newChatEnabled,
                            newChat,
                            inline = false,
                        )
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
                    ListControls(
                        Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        visibleStatus,
                        newChatEnabled,
                        newChat,
                        inline = true,
                    )
                }
            } else null
        val rows =
            subcompose(ListLayer.Rows) {
                    // Lazy item keys preserve the visible row. Keep the final row in view
                    // when the reader is already at the end.
                    val followEnd =
                        remember(listState, reserve, height, short) {
                            listState.canScrollBackward && !listState.canScrollForward
                        }
                    LaunchedEffect(listState, reserve, height, short) {
                        val lastIndex = listState.layoutInfo.totalItemsCount - 1
                        if (followEnd && !listState.isScrollInProgress && lastIndex >= 0)
                            listState.requestScrollToItem(lastIndex)
                    }
                    content(reserve, inline)
                }
                .single()
                .measure(loose)
        layout(bounds.maxWidth, bounds.maxHeight) {
            rows.placeRelative((bounds.maxWidth - rows.width) / 2, 0)
            floating?.placeRelative(0, actionTop)
            feedbackLayer.placeRelative((bounds.maxWidth - feedbackLayer.width) / 2, feedbackTop)
        }
    }
}

@Composable
private fun ListControls(
    modifier: Modifier,
    status: ChatListStatus?,
    newChatEnabled: Boolean,
    newChat: () -> Unit,
    inline: Boolean,
) {
    Layout(
        modifier = modifier,
        content = {
            NewChatAction(newChatEnabled, newChat)
            if (status != null) ListStatus(status)
        },
    ) { measurables, constraints ->
        val loose = constraints.copy(minWidth = 0, minHeight = 0)
        val action = measurables[0].measure(loose)
        val notice = measurables.getOrNull(1)?.measure(loose)
        val gap = 8.dp.roundToPx()
        val stacked = notice != null && action.width + notice.width + gap > constraints.maxWidth
        val height =
            if (stacked) action.height + gap + checkNotNull(notice).height
            else maxOf(action.height, notice?.height ?: 0)
        layout(constraints.maxWidth, height) {
            notice?.placeRelative(0, if (stacked && !inline) 0 else height - notice.height)
            action.placeRelative(
                constraints.maxWidth - action.width,
                if (stacked && inline) 0 else height - action.height,
                zIndex = 1f,
            )
        }
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
private fun ListStatus(status: ChatListStatus) {
    val colors = MaterialTheme.colorScheme
    val (label, icon) =
        when (status) {
            ChatListStatus.Offline -> R.string.chat_list_offline to R.drawable.ic_wifi_off
            ChatListStatus.RefreshFailed -> R.string.chat_list_refresh_failed to R.drawable.ic_info
        }
    Surface(
        modifier = Modifier.testTag("chat_list_bottom_status"),
        shape = RoundedCornerShape(12.dp),
        color = colors.surface,
        contentColor = colors.onSurfaceVariant,
        border = BorderStroke(1.dp, colors.outline),
        shadowElevation = 2.dp,
    ) {
        Row(
            Modifier.heightIn(min = 40.dp).padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(painterResource(icon), null, Modifier.size(16.dp))
            Text(
                stringResource(label),
                Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                style =
                    MaterialTheme.typography.labelMedium.copy(
                        fontSize = 13.sp,
                        lineHeight = 20.sp,
                        letterSpacing = 0.sp,
                    ),
            )
        }
    }
}

@Composable
internal fun ChatListSkeleton() {
    val label = stringResource(R.string.chat_loading)
    val fill = MaterialTheme.colorScheme.surfaceVariant
    Column(Modifier.semantics { this.contentDescription = label }) {
        for (width in listOf(.45f, .62f, .51f, .39f, .55f, .47f)) {
            Box(
                Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 12.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                Box(
                    Modifier.fillMaxWidth(width)
                        .height(14.dp)
                        .background(fill, RoundedCornerShape(8.dp))
                )
            }
        }
    }
}
