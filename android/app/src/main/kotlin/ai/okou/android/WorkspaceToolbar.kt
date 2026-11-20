package ai.okou.android

import ai.okou.android.chat.ChatListFilter
import ai.okou.android.chat.ChatListUiState
import ai.okou.android.chat.label
import ai.okou.android.chat.markAllReadTargets
import ai.okou.android.updates.UpdateToolbarAction
import ai.okou.android.updates.UpdateToolbarButton
import android.os.Build
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusTarget
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
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
internal fun workspaceListTitleStyle(widthDp: Int, listWidth: Int?): TextStyle {
    val fontSize =
        when {
            listWidth == 320 -> 18.sp
            widthDp < 360 -> 16.sp
            else -> 20.sp
        }
    return MaterialTheme.typography.titleLarge.copy(
        fontSize = fontSize,
        lineHeight = 24.sp,
        letterSpacing = 0.sp,
        fontWeight = FontWeight.SemiBold,
    )
}

@Composable
internal fun WorkspaceFilterSubtitle(filter: ChatListFilter) {
    if (filter == ChatListFilter.Inbox) return
    Text(
        stringResource(R.string.chat_filter_subtitle, stringResource(filter.label())),
        style =
            MaterialTheme.typography.bodySmall.copy(
                fontSize = 12.sp,
                lineHeight = 16.sp,
                letterSpacing = 0.sp,
            ),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
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
            widthDp < 360 -> 8.dp
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
    update: UpdateToolbarAction?,
    stackUpdateLabel: Boolean,
    settingsFocus: FocusRequester,
    openSettings: (restoreFocus: Boolean) -> Unit,
) {
    val hasUpdate = update != null
    var menu by remember(showFilter, hasUpdate) { mutableStateOf<WorkspaceMenuPage?>(null) }
    val filterFocus = remember { FocusRequester() }
    var restoreMenuFocus by remember(showFilter, hasUpdate) { mutableStateOf(false) }
    var anchorFocused by remember { mutableStateOf(false) }
    var restoreSettingsAnchor by remember { mutableStateOf(false) }
    val settingsAnchor =
        Modifier.focusRequester(settingsFocus).onFocusChanged { anchorFocused = it.isFocused }
    val colors = MaterialTheme.colorScheme

    fun closeMenu() {
        restoreMenuFocus = true
        menu = null
    }
    LaunchedEffect(menu, showFilter, hasUpdate) {
        if (menu == null && restoreMenuFocus) {
            restoreMenuFocus = false
            (if (hasUpdate) settingsFocus else filterFocus).requestFocus()
        }
    }

    val menuContent =
        @Composable {
            menu?.let { page ->
                val items = buildList {
                    if (page == WorkspaceMenuPage.Overflow) {
                        if (showFilter) {
                            add(
                                WorkspaceMenuItem(
                                    stringResource(R.string.chat_filter),
                                    R.drawable.ic_filter_list,
                                ) {
                                    menu = WorkspaceMenuPage.Filter
                                }
                            )
                        }
                        if (openSearch != null) {
                            add(
                                WorkspaceMenuItem(
                                    stringResource(R.string.chat_search),
                                    R.drawable.ic_search,
                                ) {
                                    menu = null
                                    openSearch()
                                }
                            )
                        }
                        add(
                            WorkspaceMenuItem(
                                stringResource(R.string.settings),
                                R.drawable.ic_settings,
                            ) {
                                menu = null
                                openSettings(restoreSettingsAnchor)
                            }
                        )
                    } else {
                        add(
                            WorkspaceMenuItem(
                                stringResource(R.string.chat_mark_all_read),
                                R.drawable.ic_done_all,
                                enabled = remember(list) { list.markAllReadTargets().isNotEmpty() },
                            ) {
                                closeMenu()
                                markAllRead()
                            }
                        )
                        for (choice in ChatListFilter.entries) {
                            add(
                                WorkspaceMenuItem(
                                    stringResource(choice.label()),
                                    selected = list.filter == choice,
                                ) {
                                    selectFilter(choice)
                                    closeMenu()
                                }
                            )
                        }
                    }
                }
                WorkspaceMenu(page, items, close = ::closeMenu) {
                    if (hasUpdate && menu == WorkspaceMenuPage.Filter) {
                        menu = WorkspaceMenuPage.Overflow
                    } else {
                        closeMenu()
                    }
                }
            }
        }
    if (update == null) {
        if (showFilter) {
            Box {
                val currentFilter = stringResource(list.filter.label())
                IconButton(
                    onClick = { menu = WorkspaceMenuPage.Filter },
                    modifier =
                        Modifier.focusRequester(filterFocus).semantics {
                            stateDescription = currentFilter
                        },
                ) {
                    Icon(
                        painterResource(R.drawable.ic_filter_list),
                        stringResource(R.string.chat_filter),
                    )
                }
                menuContent()
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
        UpdateToolbarButton(update, stacked = stackUpdateLabel)
        Box {
            IconButton(
                modifier = settingsAnchor,
                onClick = {
                    restoreSettingsAnchor = anchorFocused
                    menu = WorkspaceMenuPage.Overflow
                },
            ) {
                Icon(
                    painterResource(R.drawable.ic_more_horiz),
                    stringResource(R.string.chat_more_actions),
                )
            }
            menuContent()
        }
    }
}

private enum class WorkspaceMenuPage {
    Overflow,
    Filter,
}

private data class WorkspaceMenuItem(
    val label: String,
    @DrawableRes val icon: Int? = null,
    val selected: Boolean? = null,
    val enabled: Boolean = true,
    val onClick: () -> Unit,
)

@Composable
private fun WorkspaceMenu(
    page: WorkspaceMenuPage,
    items: List<WorkspaceMenuItem>,
    close: () -> Unit,
    back: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val window = currentWindowSizeDp()
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
        properties = PopupProperties(focusable = true, dismissOnBackPress = false),
    ) {
        WorkspacePopupBackHandler(back)
        Surface(
            modifier =
                Modifier.width((window.width - 24).coerceIn(1, 244).dp)
                    .heightIn(max = (window.height - 80).coerceAtLeast(48).dp)
                    .testTag("workspace_popup"),
            shape = RoundedCornerShape(16.dp),
            color = colors.surface,
            shadowElevation = 6.dp,
            border = BorderStroke(1.dp, colors.outline),
        ) {
            key(page) { WorkspaceMenuItems(items, page != WorkspaceMenuPage.Overflow, back) }
        }
    }
}

@Composable
private fun WorkspaceMenuItems(items: List<WorkspaceMenuItem>, filter: Boolean, back: () -> Unit) {
    val inputMode = LocalInputModeManager.current.inputMode
    val popupFocus = remember { FocusRequester() }
    val itemFocus = remember(items.size) { List(items.size) { FocusRequester() } }
    val enabled = items.indices.filter { items[it].enabled }
    var focusedIndex by remember { mutableIntStateOf(-1) }
    LaunchedEffect(inputMode, enabled) {
        if (inputMode == InputMode.Touch) {
            // Keep legacy Back keys in this window without highlighting a row on touch.
            popupFocus.requestFocus()
        } else if (focusedIndex !in enabled) {
            itemFocus[enabled.first()].requestFocus()
        }
    }

    Column(
        Modifier.onPreviewKeyEvent { event ->
                when (event.key) {
                    Key.Back,
                    Key.Escape -> {
                        if (event.type == KeyEventType.KeyUp && !event.nativeKeyEvent.isCanceled)
                            back()
                        true
                    }
                    Key.DirectionUp,
                    Key.DirectionDown,
                    Key.MoveHome,
                    Key.MoveEnd -> {
                        if (event.type == KeyEventType.KeyDown) {
                            val position = enabled.indexOf(focusedIndex)
                            val next =
                                when (event.key) {
                                    Key.MoveHome -> enabled.first()
                                    Key.MoveEnd -> enabled.last()
                                    Key.DirectionUp ->
                                        if (position <= 0) enabled.last() else enabled[position - 1]
                                    else -> enabled[(position + 1) % enabled.size]
                                }
                            itemFocus[next].requestFocus()
                        }
                        true
                    }
                    else -> false
                }
            }
            .focusProperties { canFocus = inputMode == InputMode.Touch }
            .focusRequester(popupFocus)
            .focusTarget()
            .verticalScroll(rememberScrollState())
            .padding(7.dp)
    ) {
        val row: @Composable (Int) -> Unit = { index ->
            WorkspaceMenuRow(
                items[index],
                Modifier.focusRequester(itemFocus[index]).onFocusChanged {
                    if (it.isFocused) focusedIndex = index
                    else if (focusedIndex == index) focusedIndex = -1
                },
                focused = inputMode == InputMode.Keyboard && focusedIndex == index,
            )
        }
        if (filter) {
            row(0)
            HorizontalDivider(Modifier.padding(horizontal = 6.dp, vertical = 5.dp))
            Column(Modifier.selectableGroup()) { for (index in 1..items.lastIndex) row(index) }
        } else {
            for (index in items.indices) row(index)
        }
    }
}

@Composable
private fun WorkspacePopupBackHandler(back: () -> Unit) {
    if (Build.VERSION.SDK_INT >= 33) {
        val view = LocalView.current
        val onBack by rememberUpdatedState(back)
        // Popup's default callback merges outside taps and system Back into one dismissal.
        DisposableEffect(view) {
            val dispatcher = view.findOnBackInvokedDispatcher()
            val callback = OnBackInvokedCallback { onBack() }
            dispatcher?.registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_OVERLAY,
                callback,
            )
            onDispose { dispatcher?.unregisterOnBackInvokedCallback(callback) }
        }
    }
}

@Composable
private fun WorkspaceMenuRow(item: WorkspaceMenuItem, modifier: Modifier, focused: Boolean) {
    val (label, icon, selected, enabled, onClick) = item
    val gesture =
        if (selected == null) Modifier.clickable(enabled, role = Role.Button, onClick = onClick)
        else Modifier.selectable(selected, enabled, role = Role.RadioButton, onClick = onClick)
    val colors = MaterialTheme.colorScheme
    val foreground = colors.onSurface
    val color = if (enabled) foreground else foreground.copy(alpha = 0.4f)
    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(shape)
            .then(if (focused) Modifier.border(2.dp, colors.onSurfaceVariant, shape) else Modifier)
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
