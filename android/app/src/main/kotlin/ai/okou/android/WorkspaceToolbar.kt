package ai.okou.android

import ai.okou.android.chat.ChatListFilter
import ai.okou.android.chat.ChatListUiState
import ai.okou.android.chat.label
import ai.okou.android.chat.markAllReadTargets
import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties

@Composable
internal fun AppliedChatFilter(filter: ChatListFilter, clear: () -> Unit) {
    val clearLabel = stringResource(R.string.chat_clear_filter)
    val colors = MaterialTheme.colorScheme
    Box(
        Modifier.widthIn(max = 720.dp)
            .fillMaxWidth()
            .padding(start = 24.dp, end = 24.dp, bottom = 4.dp)
    ) {
        Surface(
            selected = true,
            onClick = clear,
            shape = RoundedCornerShape(12.dp),
            color = colors.onBackground.copy(alpha = 0.05f).compositeOver(colors.background),
            contentColor = colors.onSurface,
            modifier = Modifier.semantics { onClick(label = clearLabel, action = null) },
        ) {
            Row(
                Modifier.heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(filter.label()),
                    style = filterLabelStyle(),
                    fontWeight = FontWeight.Medium,
                )
                Icon(painterResource(R.drawable.ic_close), null, Modifier.size(16.dp))
            }
        }
    }
}

@Composable
internal fun WorkspaceListToolbar(
    widthDp: Int,
    listWidth: Int?,
    title: @Composable () -> Unit,
    actions: @Composable () -> Unit,
) {
    val inset =
        when {
            listWidth == 320 -> 10.dp
            listWidth == null && widthDp >= 600 -> 16.dp
            else -> 12.dp
        }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = inset),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) { title() }
        Row(
            Modifier.width(156.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            actions()
        }
    }
}

@Composable
internal fun WorkspaceToolbarActions(
    showFilter: Boolean,
    list: ChatListUiState,
    selectFilter: (ChatListFilter) -> Unit,
    markAllRead: () -> Unit,
    openSearch: (() -> Unit)? = null,
    openUpdate: (() -> Unit)?,
    settingsFocus: FocusRequester,
    openSettings: (restoreFocus: Boolean) -> Unit,
) {
    var filterOpen by remember(showFilter, openUpdate != null) { mutableStateOf(false) }
    var anchorFocused by remember { mutableStateOf(false) }
    val settingsAnchor =
        Modifier.focusRequester(settingsFocus).onFocusChanged { anchorFocused = it.isFocused }
    val colors = MaterialTheme.colorScheme
    val filterMenu =
        @Composable {
            ChatFilterMenu(
                expanded = filterOpen,
                close = { filterOpen = false },
                filter = list.filter,
                selectFilter = selectFilter,
                canMarkAllRead =
                    filterOpen && remember(list) { list.markAllReadTargets().isNotEmpty() },
                markAllRead = markAllRead,
            )
        }
    if (openUpdate == null) {
        if (showFilter) {
            Box {
                val currentFilter = stringResource(list.filter.label())
                IconButton(
                    onClick = { filterOpen = true },
                    modifier = Modifier.semantics { stateDescription = currentFilter },
                ) {
                    Icon(
                        painterResource(R.drawable.ic_filter_list),
                        stringResource(R.string.chat_filter),
                    )
                }
                filterMenu()
            }
        }
        if (openSearch != null) {
            IconButton(onClick = openSearch) {
                Icon(painterResource(R.drawable.ic_search), stringResource(R.string.chat_search))
            }
        }
        IconButton(modifier = settingsAnchor, onClick = { openSettings(anchorFocused) }) {
            Icon(painterResource(R.drawable.ic_settings), stringResource(R.string.settings))
        }
    } else {
        TextButton(
            onClick = openUpdate,
            modifier = Modifier.width(104.dp).heightIn(min = 48.dp),
            shape = RoundedCornerShape(14.dp),
            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
            colors =
                ButtonDefaults.textButtonColors(
                    containerColor = colors.inverseSurface,
                    contentColor = colors.inverseOnSurface,
                ),
        ) {
            Icon(
                painterResource(R.drawable.ic_download),
                contentDescription = null,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(4.dp))
            Text(
                stringResource(R.string.updates_toolbar),
                style = filterLabelStyle(),
                fontWeight = FontWeight(550),
            )
        }
        Box {
            var expanded by remember(showFilter) { mutableStateOf(false) }
            var restoreAnchor by remember { mutableStateOf(false) }
            IconButton(
                modifier = settingsAnchor,
                onClick = {
                    restoreAnchor = anchorFocused
                    expanded = true
                },
            ) {
                Icon(
                    painterResource(R.drawable.ic_more_horiz),
                    stringResource(R.string.chat_more_actions),
                )
            }
            WorkspaceMenu(expanded = expanded, close = { expanded = false }) {
                if (showFilter) {
                    WorkspaceMenuRow(
                        label = stringResource(R.string.chat_filter),
                        icon = R.drawable.ic_filter_list,
                        onClick = {
                            expanded = false
                            filterOpen = true
                        },
                    )
                }
                if (openSearch != null) {
                    WorkspaceMenuRow(
                        label = stringResource(R.string.chat_search),
                        icon = R.drawable.ic_search,
                        onClick = {
                            expanded = false
                            openSearch()
                        },
                    )
                }
                WorkspaceMenuRow(
                    label = stringResource(R.string.settings),
                    icon = R.drawable.ic_settings,
                    onClick = {
                        expanded = false
                        openSettings(restoreAnchor)
                    },
                )
            }
            filterMenu()
        }
    }
}

@Composable
private fun ChatFilterMenu(
    expanded: Boolean,
    close: () -> Unit,
    filter: ChatListFilter,
    selectFilter: (ChatListFilter) -> Unit,
    canMarkAllRead: Boolean,
    markAllRead: () -> Unit,
) {
    WorkspaceMenu(expanded, close) {
        WorkspaceMenuRow(
            label = stringResource(R.string.chat_mark_all_read),
            icon = R.drawable.ic_done_all,
            enabled = canMarkAllRead,
            onClick = {
                close()
                markAllRead()
            },
        )
        HorizontalDivider(Modifier.padding(horizontal = 6.dp, vertical = 5.dp))
        Column(Modifier.selectableGroup()) {
            ChatListFilter.entries.forEach { choice ->
                WorkspaceMenuRow(
                    label = stringResource(choice.label()),
                    selected = filter == choice,
                    onClick = {
                        selectFilter(choice)
                        close()
                    },
                )
            }
        }
    }
}

@Composable
private fun WorkspaceMenu(
    expanded: Boolean,
    close: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    if (!expanded) return
    val colors = MaterialTheme.colorScheme
    val window = LocalConfiguration.current
    val density = LocalDensity.current
    val position =
        remember(density) {
            with(density) {
                WorkspaceMenuPosition(12.dp.roundToPx(), 8.dp.roundToPx(), 4.dp.roundToPx())
            }
        }
    Popup(
        popupPositionProvider = position,
        onDismissRequest = close,
        properties = PopupProperties(focusable = true),
    ) {
        Surface(
            modifier =
                Modifier.width((window.screenWidthDp - 24).coerceIn(1, 244).dp)
                    .heightIn(max = (window.screenHeightDp - 80).coerceAtLeast(48).dp)
                    .testTag("workspace_popup"),
            shape = RoundedCornerShape(16.dp),
            color = colors.surface,
            shadowElevation = 6.dp,
            border = BorderStroke(1.dp, colors.outline),
        ) {
            Column(Modifier.verticalScroll(rememberScrollState()).padding(7.dp), content = content)
        }
    }
}

@Composable
private fun WorkspaceMenuRow(
    label: String,
    onClick: () -> Unit,
    @DrawableRes icon: Int? = null,
    selected: Boolean? = null,
    enabled: Boolean = true,
) {
    val gesture =
        if (selected == null) Modifier.clickable(enabled, role = Role.Button, onClick = onClick)
        else Modifier.selectable(selected, enabled, role = Role.RadioButton, onClick = onClick)
    val foreground = MaterialTheme.colorScheme.onSurface
    val color = if (enabled) foreground else foreground.copy(alpha = 0.4f)
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(10.dp))
            .then(gesture)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(painterResource(icon), null, Modifier.size(18.dp), tint = color)
        }
        Text(label, Modifier.weight(1f), style = filterLabelStyle(), color = color)
        if (selected == true) {
            Icon(painterResource(R.drawable.ic_check), null, Modifier.size(18.dp), tint = color)
        }
    }
}

@Composable
private fun filterLabelStyle() =
    MaterialTheme.typography.bodyMedium.copy(
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.sp,
    )

private class WorkspaceMenuPosition(
    private val edge: Int,
    private val topEdge: Int,
    private val gap: Int,
) : PopupPositionProvider {
    override fun calculatePosition(
        anchorBounds: IntRect,
        windowSize: IntSize,
        layoutDirection: LayoutDirection,
        popupContentSize: IntSize,
    ): IntOffset {
        val width = popupContentSize.width
        val height = popupContentSize.height
        val endAligned =
            if (layoutDirection == LayoutDirection.Ltr) anchorBounds.right - width
            else anchorBounds.left
        val below = anchorBounds.bottom + gap
        val bottom = windowSize.height - edge - height
        val vertical = if (below <= bottom) below else anchorBounds.top - gap - height
        return IntOffset(
            endAligned.coerceIn(edge, maxOf(edge, windowSize.width - edge - width)),
            vertical.coerceIn(topEdge, maxOf(topEdge, bottom)),
        )
    }
}
