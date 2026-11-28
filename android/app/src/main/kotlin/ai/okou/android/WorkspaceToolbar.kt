package ai.okou.android

import ai.okou.android.chat.ChatListFilter
import ai.okou.android.chat.ChatListRowShape
import ai.okou.android.chat.ChatListUiState
import ai.okou.android.chat.label
import ai.okou.android.chat.markAllReadTargets
import ai.okou.android.updates.UpdateToolbarAction
import ai.okou.android.updates.UpdateToolbarButton
import ai.okou.android.updates.updateFocusOutline
import android.os.Build
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
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
import androidx.compose.ui.graphics.Shape
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
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties

private val searchFieldEdge = 12.dp
private val searchIconSize = 20.dp
private val searchIconGap = 8.dp

@Composable internal fun workspaceSearchTextStyle() = MaterialTheme.typography.bodyLarge

@Composable
internal fun Modifier.workspaceSearchFocusOutline(shape: Shape): Modifier =
    updateFocusOutline(shape, MaterialTheme.colorScheme.onBackground, keyboardOnly = true)

@Composable
internal fun workspaceSearchControlHeight(): Dp {
    val lineHeight = workspaceSearchTextStyle().lineHeight
    return with(LocalDensity.current) { maxOf(48.dp, lineHeight.toDp() + 16.dp) }
}

@Composable
internal fun WorkspaceSearchToolbar(
    widthDp: Int,
    listWidth: Int?,
    leading: @Composable () -> Unit,
    field: @Composable (Modifier) -> Unit,
    actions: (@Composable () -> Unit)? = null,
) {
    val inset =
        when {
            listWidth == 320 -> 10.dp
            listWidth == null && isAtLeastMediumWindowWidth(widthDp) -> 16.dp
            widthDp < 360 -> 8.dp
            else -> 12.dp
        }
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = TopAppBarDefaults.TopAppBarExpandedHeight)
            .padding(horizontal = inset, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        field(Modifier.weight(1f))
        if (actions != null) {
            Row(
                Modifier.widthIn(min = 100.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                actions()
            }
        }
    }
}

@Composable
internal fun WorkspaceSearchField(
    modifier: Modifier,
    onClick: (() -> Unit)? = null,
    hasTrailingAction: Boolean = false,
    iconOnly: Boolean = false,
    shape: Shape = CircleShape,
    content: @Composable RowScope.() -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Row(
        modifier
            .height(workspaceSearchControlHeight())
            .clip(shape)
            .background(colors.surfaceContainerHigh)
            .then(
                if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick)
                else Modifier,
            )
            .padding(
                start = if (iconOnly) 0.dp else searchFieldEdge,
                end = if (iconOnly || hasTrailingAction) 0.dp else searchFieldEdge,
            ),
        horizontalArrangement =
            if (iconOnly) Arrangement.Center else Arrangement.spacedBy(searchIconGap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painterResource(R.drawable.ic_search),
            contentDescription = null,
            modifier = Modifier.size(searchIconSize),
            tint = colors.onSurface,
        )
        content()
    }
}

@Composable
internal fun WorkspaceListToolbar(
    widthDp: Int,
    listWidth: Int?,
    avatar: (@Composable () -> Unit)?,
    searchFocus: FocusRequester,
    onSearchFocusChanged: (Boolean) -> Unit,
    openSearch: (() -> Unit)?,
    actions: @Composable () -> Unit,
) {
    val label = stringResource(R.string.chat_search_workspace)
    WorkspaceSearchToolbar(
        widthDp,
        listWidth,
        leading = {
            Box(Modifier.size(workspaceSearchControlHeight()).testTag("workspace_search_leading")) {
                if (avatar == null) {
                    Box(
                        Modifier.matchParentSize()
                            .background(MaterialTheme.colorScheme.surfaceVariant, CircleShape),
                    )
                } else avatar()
            }
        },
        field = { modifier ->
            BoxWithConstraints(modifier) {
                val style = workspaceSearchTextStyle()
                val em = with(LocalDensity.current) { style.fontSize.toDp() }
                val textWidth = maxWidth - searchFieldEdge * 2 - searchIconSize - searchIconGap
                val iconOnly = textWidth < em * 2
                WorkspaceSearchField(
                    Modifier.fillMaxWidth()
                        .focusRequester(searchFocus)
                        .focusProperties { canFocus = openSearch != null }
                        .onFocusChanged { onSearchFocusChanged(it.isFocused) }
                        .workspaceSearchFocusOutline(CircleShape)
                        .testTag("workspace_search_entry")
                        .semantics { if (openSearch != null) contentDescription = label },
                    onClick = openSearch,
                    iconOnly = iconOnly,
                ) {
                    if (!iconOnly) {
                        Text(
                            if (textWidth < em * 5) stringResource(R.string.chat_search_short)
                            else label,
                            Modifier.padding(vertical = 8.dp).clearAndSetSemantics {},
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = style,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        },
        actions = actions,
    )
}

@Composable
internal fun WorkspaceToolEntries(
    openWorkflows: (() -> Unit)?,
    workflowsFocus: FocusRequester,
    onWorkflowsFocusChanged: (Boolean) -> Unit,
    openArtifacts: (() -> Unit)?,
    artifactFocus: FocusRequester,
    connectorFocus: FocusRequester,
    onConnectorFocusChanged: (Boolean) -> Unit,
    openConnectors: (() -> Unit)?,
) {
    val stackBelow = with(LocalDensity.current) { 16.sp.toDp() * 19 }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val stacked = maxWidth <= stackBelow
        Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 5.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            WorkspaceToolEntry(
                R.drawable.ic_account_tree,
                R.string.workspace_workflows,
                stacked,
                Modifier.weight(1f).focusRequester(workflowsFocus).onFocusChanged {
                    onWorkflowsFocusChanged(it.isFocused)
                },
                onClick = openWorkflows,
            )
            WorkspaceToolEntry(
                R.drawable.ic_extension,
                R.string.workspace_connectors,
                stacked,
                Modifier.weight(1f).focusRequester(connectorFocus).onFocusChanged {
                    onConnectorFocusChanged(it.isFocused)
                },
                onClick = openConnectors,
            )
            WorkspaceToolEntry(
                R.drawable.ic_inventory_2,
                R.string.workspace_artifacts,
                stacked,
                Modifier.weight(1f).focusRequester(artifactFocus),
                onClick = openArtifacts,
            )
        }
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
}

@Composable
private fun WorkspaceToolEntry(
    @DrawableRes icon: Int,
    @StringRes label: Int,
    stacked: Boolean,
    modifier: Modifier,
    onClick: (() -> Unit)? = null,
) {
    val title = stringResource(label)
    val color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (onClick == null) 0.4f else 1f)
    val interaction =
        if (onClick != null) {
            Modifier.updateFocusOutline(ChatListRowShape, MaterialTheme.colorScheme.onSurface)
                .clickable(role = Role.Button, onClick = onClick)
                .clearAndSetSemantics { contentDescription = title }
        } else {
            Modifier.clearAndSetSemantics {
                contentDescription = title
                role = Role.Button
                disabled()
            }
        }
    val iconContent: @Composable () -> Unit = {
        Icon(painterResource(icon), null, Modifier.size(18.dp), tint = color)
    }
    val titleContent: @Composable (Modifier) -> Unit = { titleModifier ->
        Text(
            title,
            modifier = titleModifier,
            color = color,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style =
                MaterialTheme.typography.bodySmall.copy(
                    fontSize = 13.sp,
                    lineHeight = 20.sp,
                    letterSpacing = 0.sp,
                ),
        )
    }
    Box(
        modifier
            .heightIn(min = 48.dp)
            .clip(ChatListRowShape)
            .then(interaction)
            .padding(
                horizontal = if (stacked) 0.dp else 6.dp,
                vertical = if (stacked) 4.dp else 2.dp,
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (stacked) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                iconContent()
                titleContent(Modifier)
            }
        } else {
            Row(
                horizontalArrangement = Arrangement.spacedBy(5.dp, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                iconContent()
                titleContent(Modifier.weight(1f, fill = false))
            }
        }
    }
}

@Composable
internal fun WorkspaceToolbarActions(
    showFilter: Boolean,
    list: ChatListUiState,
    selectFilter: ((ChatListFilter) -> Unit)?,
    markAllRead: (() -> Unit)?,
    update: UpdateToolbarAction?,
    settingsFocus: FocusRequester,
    openSettings: ((restoreFocus: Boolean) -> Unit)?,
    openProjectCreation: ((restoreFocus: Boolean) -> Unit)?,
) {
    val hasUpdate = update != null
    var menu by remember(showFilter, hasUpdate) { mutableStateOf<WorkspaceMenuPage?>(null) }
    val filterFocus = remember { FocusRequester() }
    var restoreMenuFocus by
        remember(showFilter, hasUpdate) { mutableStateOf<FocusRequester?>(null) }
    var anchorFocused by remember { mutableStateOf(false) }
    var restoreSettingsAnchor by remember { mutableStateOf(false) }
    val settingsAnchor =
        Modifier.size(48.dp).focusRequester(settingsFocus).onFocusChanged {
            anchorFocused = it.isFocused
        }
    val colors = MaterialTheme.colorScheme
    val currentFilter = stringResource(list.filter.label())
    val filterApplied = showFilter && list.filter != ChatListFilter.Inbox
    val filterTreatment =
        if (filterApplied) Modifier.background(colors.secondaryContainer, RoundedCornerShape(12.dp))
        else Modifier
    val filterTint = if (filterApplied) colors.onSecondaryContainer else colors.onSurface

    fun closeMenu() {
        restoreMenuFocus =
            if (hasUpdate || menu == WorkspaceMenuPage.Overflow) settingsFocus else filterFocus
        menu = null
    }
    LaunchedEffect(menu, showFilter, hasUpdate) {
        if (menu == null) {
            restoreMenuFocus?.requestFocus()
            restoreMenuFocus = null
        }
    }

    val menuContent =
        @Composable {
            menu?.let { page ->
                val items = buildList {
                    if (page == WorkspaceMenuPage.Overflow) {
                        if (hasUpdate && showFilter) {
                            add(
                                WorkspaceMenuItem(
                                    stringResource(R.string.chat_filter),
                                    R.drawable.ic_filter_list,
                                    enabled = selectFilter != null,
                                ) {
                                    menu = WorkspaceMenuPage.Filter
                                },
                            )
                        }
                        if (showFilter) {
                            add(
                                WorkspaceMenuItem(
                                    stringResource(R.string.chat_project_create),
                                    R.drawable.ic_create_new_folder,
                                    enabled = openProjectCreation != null,
                                ) {
                                    menu = null
                                    openProjectCreation?.invoke(restoreSettingsAnchor)
                                },
                            )
                        }
                        add(
                            WorkspaceMenuItem(
                                stringResource(R.string.settings),
                                R.drawable.ic_settings,
                                enabled = openSettings != null,
                            ) {
                                menu = null
                                openSettings?.invoke(restoreSettingsAnchor)
                            },
                        )
                    } else {
                        add(
                            WorkspaceMenuItem(
                                stringResource(R.string.chat_mark_all_read),
                                R.drawable.ic_done_all,
                                enabled =
                                    markAllRead != null &&
                                        remember(list) { list.markAllReadTargets().isNotEmpty() },
                            ) {
                                closeMenu()
                                markAllRead?.invoke()
                            },
                        )
                        for (choice in ChatListFilter.entries) {
                            add(
                                WorkspaceMenuItem(
                                    stringResource(choice.label()),
                                    selected = list.filter == choice,
                                ) {
                                    selectFilter?.invoke(choice)
                                    closeMenu()
                                },
                            )
                        }
                    }
                }
                WorkspaceMenu(
                    items,
                    close = ::closeMenu,
                    filter = page == WorkspaceMenuPage.Filter,
                ) {
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
                WithButtonFocusOutline(filterTint) {
                    IconButton(
                        onClick = { menu = WorkspaceMenuPage.Filter },
                        enabled = selectFilter != null,
                        colors = IconButtonDefaults.iconButtonColors(contentColor = filterTint),
                        modifier =
                            Modifier.size(48.dp)
                                .focusRequester(filterFocus)
                                .then(filterTreatment)
                                .semantics { stateDescription = currentFilter },
                    ) {
                        Icon(
                            painterResource(R.drawable.ic_filter_list),
                            stringResource(R.string.chat_filter),
                        )
                    }
                }
                if (menu == WorkspaceMenuPage.Filter) menuContent()
            }
        }
    } else {
        UpdateToolbarButton(update, height = workspaceSearchControlHeight())
    }
    if (showFilter || hasUpdate) {
        Box {
            val overflowTint = if (hasUpdate) filterTint else colors.onSurface
            WithButtonFocusOutline(overflowTint) {
                IconButton(
                    modifier =
                        settingsAnchor
                            .then(if (hasUpdate) filterTreatment else Modifier)
                            .semantics {
                                if (hasUpdate && showFilter) stateDescription = currentFilter
                            },
                    enabled = hasUpdate || openSettings != null || openProjectCreation != null,
                    onClick = {
                        restoreSettingsAnchor = anchorFocused
                        menu = WorkspaceMenuPage.Overflow
                    },
                ) {
                    Icon(
                        painterResource(R.drawable.ic_more_horiz),
                        stringResource(R.string.chat_more_actions),
                        tint = overflowTint,
                    )
                }
            }
            if (hasUpdate || menu == WorkspaceMenuPage.Overflow) menuContent()
        }
    } else {
        IconButton(
            modifier = settingsAnchor,
            onClick = { openSettings?.invoke(anchorFocused) },
            enabled = openSettings != null,
            colors = IconButtonDefaults.iconButtonColors(contentColor = colors.onSurface),
        ) {
            Icon(painterResource(R.drawable.ic_settings), stringResource(R.string.settings))
        }
    }
}

private enum class WorkspaceMenuPage {
    Overflow,
    Filter,
}

internal data class WorkspaceMenuItem(
    val label: String,
    @DrawableRes val icon: Int? = null,
    val selected: Boolean? = null,
    val enabled: Boolean = true,
    val destructive: Boolean = false,
    val onClick: () -> Unit,
)

@Composable
internal fun WorkspaceMenu(
    items: List<WorkspaceMenuItem>,
    close: () -> Unit,
    filter: Boolean = false,
    separatorBefore: Int? = null,
    back: () -> Unit = close,
) {
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
            shape = MenuDefaults.shape,
            color = MenuDefaults.containerColor,
            tonalElevation = MenuDefaults.TonalElevation,
            shadowElevation = MenuDefaults.ShadowElevation,
        ) {
            key(filter) { WorkspaceMenuItems(items, filter, close, back, separatorBefore) }
        }
    }
}

@Composable
private fun WorkspaceMenuItems(
    items: List<WorkspaceMenuItem>,
    filter: Boolean,
    close: () -> Unit,
    back: () -> Unit,
    separatorBefore: Int?,
) {
    val inputMode = LocalInputModeManager.current.inputMode
    val popupFocus = remember { FocusRequester() }
    val itemFocus = remember(items.size) { List(items.size) { FocusRequester() } }
    val enabled = items.indices.filter { items[it].enabled }
    val containerFocusable = inputMode == InputMode.Touch || enabled.isEmpty()
    var focusedIndex by remember { mutableIntStateOf(-1) }
    LaunchedEffect(containerFocusable, enabled) {
        if (containerFocusable) {
            // The popup can receive Back even before an option is available.
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
                    Key.Tab -> {
                        if (event.type == KeyEventType.KeyUp && !event.nativeKeyEvent.isCanceled)
                            close()
                        true
                    }
                    Key.DirectionUp,
                    Key.DirectionDown,
                    Key.MoveHome,
                    Key.MoveEnd -> {
                        if (event.type == KeyEventType.KeyDown && enabled.isNotEmpty()) {
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
            .focusProperties { canFocus = containerFocusable }
            .focusRequester(popupFocus)
            .focusTarget()
            .verticalScroll(rememberScrollState())
            .padding(vertical = 8.dp),
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
            for (index in items.indices) {
                if (index == separatorBefore)
                    HorizontalDivider(Modifier.padding(horizontal = 6.dp, vertical = 5.dp))
                row(index)
            }
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
    val (label, icon, selected, enabled, destructive, onClick) = item
    val gesture =
        if (selected == null) Modifier.clickable(enabled, role = Role.Button, onClick = onClick)
        else Modifier.selectable(selected, enabled, role = Role.RadioButton, onClick = onClick)
    val colors = MaterialTheme.colorScheme
    val foreground = if (destructive) colors.error else colors.onSurface
    val disabledColors = MenuDefaults.itemColors()
    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .then(if (focused) Modifier.border(2.dp, colors.onSurface, shape) else Modifier)
            .then(gesture)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(
                painterResource(icon),
                null,
                Modifier.size(24.dp),
                tint = if (enabled) foreground else disabledColors.disabledLeadingIconColor,
            )
        }
        Text(
            label,
            Modifier.weight(1f),
            style = MaterialTheme.typography.labelLarge,
            color = if (enabled) foreground else disabledColors.disabledTextColor,
        )
        if (selected == true) {
            Icon(
                painterResource(R.drawable.ic_check),
                null,
                Modifier.size(24.dp),
                tint = if (enabled) foreground else disabledColors.disabledTrailingIconColor,
            )
        }
    }
}

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
