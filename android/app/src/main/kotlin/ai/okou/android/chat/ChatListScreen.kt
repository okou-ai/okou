package ai.okou.android.chat

import ai.okou.android.R
import androidx.annotation.DrawableRes
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.LongState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.isSecondaryPressed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
@OptIn(ExperimentalMaterial3Api::class)
internal fun ChatListScreen(
    state: ChatListUiState,
    refresh: () -> Unit,
    retryList: () -> Unit,
    retryMetadata: () -> Unit,
    refreshIndicators: () -> Unit,
    open: (ConfirmedChat) -> Unit,
    performRowAction: (String, ChatRowAction) -> Unit,
    renameThread: (String, String) -> Unit,
    collapsed: List<String>,
    toggleProject: (String) -> Unit,
    listState: LazyListState,
    newChat: (String?) -> Unit,
    selectedChatId: String?,
    wide: Boolean,
    actionsEnabled: Boolean,
    refreshEnabled: Boolean,
    startupRecovery: @Composable (() -> Unit)?,
) {
    var renamingId by remember { mutableStateOf<String?>(null) }
    val renaming =
        renamingId?.let { id -> state.threads.firstOrNull { it.id == id && it.hidden != true } }
    if (renaming != null) {
        key(renaming.id) {
            RenameChatDialog(
                currentTitle = renaming.title.orEmpty(),
                enabled =
                    state.listPhase != ChatReadPhase.Failed &&
                        renaming.id !in state.pendingRowActions,
                dismiss = { renamingId = null },
                save = { title ->
                    renameThread(renaming.id, title)
                    renamingId = null
                },
            )
        }
    } else if (renamingId != null && state.listPhase == ChatReadPhase.Ready) {
        LaunchedEffect(renamingId) { renamingId = null }
    }
    val groups =
        remember(
            state.threads,
            state.projects,
            state.projectsEnabled,
            state.agents,
            state.filter,
            state.indicators,
        ) {
            chatListGroups(state)
        }
    val indicators = state.indicators?.threads.orEmpty()
    val sections =
        remember(groups, collapsed, indicators) { chatListSections(groups, collapsed, indicators) }
    val runningKeys =
        remember(indicators, sections) {
            buildSet {
                sections.forEach { section ->
                    when (section.foldedStatus) {
                        ChatRowStatus.Running ->
                            add(projectRowKey(checkNotNull(section.group.project).id))
                        null ->
                            section.group.threads.forEach { thread ->
                                if (
                                    chatRowStatus(indicators[thread.id], thread.muted == true) ==
                                        ChatRowStatus.Running
                                ) {
                                    add(thread.id)
                                }
                            }
                        else -> Unit
                    }
                }
            }
        }
    val runningFrame = rememberRunningWaveFrame(listState, runningKeys)
    val metadataPending =
        state.projectsSettingsPhase == ChatReadPhase.Loading ||
            state.agentsPhase == ChatReadPhase.Loading ||
            state.projectsEnabled && state.projectsPhase == ChatReadPhase.Loading
    val metadataFailed =
        state.projectsSettingsPhase == ChatReadPhase.Failed ||
            state.agentsPhase == ChatReadPhase.Failed ||
            state.projectsEnabled && state.projectsPhase == ChatReadPhase.Failed
    val knownProjects =
        remember(state.projectsEnabled, state.projects) {
            if (state.projectsEnabled) state.projects.mapTo(hashSetOf()) { it.id } else emptySet()
        }
    val missingDefault =
        state.agentsPhase == ChatReadPhase.Ready &&
            state.agents.none { it.isDefaultAgent } &&
            state.threads.any { it.hidden != true && it.projectId !in knownProjects }
    val refreshLabel = stringResource(R.string.chat_refresh)
    val listLabel = stringResource(R.string.chat_list_title)
    val largeCompact = LocalConfiguration.current.screenWidthDp >= 600
    val listInset = if (wide) 12.dp else if (largeCompact) 24.dp else 16.dp
    val outline = MaterialTheme.colorScheme.outline
    PullToRefreshBox(
        isRefreshing = state.confirmedAt != null && state.listPhase == ChatReadPhase.Loading,
        onRefresh = { if (refreshEnabled) refresh() },
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.TopCenter,
    ) {
        LazyColumn(
            Modifier.widthIn(max = 720.dp).fillMaxSize().testTag("chat_list").semantics {
                contentDescription = listLabel
                if (refreshEnabled && state.listPhase != ChatReadPhase.Loading) {
                    customActions =
                        listOf(
                            CustomAccessibilityAction(refreshLabel) {
                                refresh()
                                true
                            }
                        )
                }
            },
            contentPadding =
                PaddingValues(start = listInset, end = listInset, top = 4.dp, bottom = 100.dp),
            state = listState,
        ) {
            if (startupRecovery != null) item { startupRecovery() }
            if (state.source == ChatListSource.Cache) item { ChatNotice(R.string.chat_cached) }
            if (state.listPhase == ChatReadPhase.Loading)
                item {
                    ChatNotice(
                        if (state.confirmedAt == null) R.string.chat_loading
                        else R.string.chat_refreshing
                    )
                }
            if (state.listPhase == ChatReadPhase.Failed)
                item {
                    ChatNotice(
                        if (state.confirmedAt == null) R.string.chat_load_failed
                        else R.string.chat_refresh_failed
                    )
                    ChatAction(R.string.retry, retryList)
                }
            if (state.cacheUnavailable || state.projectCacheUnavailable)
                item { ChatNotice(R.string.chat_cache_unavailable) }
            if (metadataPending) item { ChatNotice(R.string.chat_metadata_loading) }
            if (
                state.agentsSource == ChatListSource.Cache ||
                    state.projectsSource == ChatListSource.Cache
            )
                item { ChatNotice(R.string.chat_metadata_cached) }
            if (metadataFailed || missingDefault)
                item {
                    ChatNotice(R.string.chat_metadata_unavailable)
                    ChatAction(R.string.retry, retryMetadata)
                }
            when (state.indicatorsPhase) {
                ChatReadPhase.Loading -> item { ChatNotice(R.string.chat_status_loading) }
                ChatReadPhase.Failed ->
                    item {
                        ChatNotice(R.string.chat_status_unavailable)
                        ChatAction(R.string.chat_refresh_status, refreshIndicators)
                    }
                else -> Unit
            }
            if (state.confirmedAt != null) {
                sections.forEach { section ->
                    val group = section.group
                    val project = group.project
                    val foldedStatus = section.foldedStatus
                    if (project != null) {
                        item(key = projectRowKey(project.id)) {
                            ProjectRow(
                                project.name,
                                collapsed = foldedStatus != null,
                                status = foldedStatus ?: ChatRowStatus.None,
                                runningFrame = runningFrame,
                                row = section.firstRow,
                                toggle = { toggleProject(project.id) },
                                newChat = if (actionsEnabled) ({ newChat(project.id) }) else null,
                            )
                        }
                        if (foldedStatus == null && group.threads.isEmpty()) {
                            item(key = "project_actions_${project.id}") {
                                Column(Modifier.projectChildIndent(outline)) {
                                    if (!actionsEnabled) {
                                        ChatNotice(R.string.chat_project_empty)
                                    }
                                    NewProjectChatAction(actionsEnabled) { newChat(project.id) }
                                }
                            }
                        }
                    }
                    if (foldedStatus == null) {
                        val pinTail = group.pinnedTailIndex()
                        itemsIndexed(group.threads, key = { _, thread -> thread.id }) {
                            index,
                            thread ->
                            Column(
                                if (project == null) Modifier
                                else Modifier.projectChildIndent(outline)
                            ) {
                                ChatRow(
                                    thread,
                                    chatRowStatus(indicators[thread.id], thread.muted == true),
                                    thread.id == selectedChatId,
                                    runningFrame,
                                    row = section.firstChatRow + index,
                                    actions =
                                        if (actionsEnabled) state.rowActions(thread, group, index)
                                        else emptyList(),
                                    enabled = actionsEnabled,
                                    pendingAction = state.pendingRowActions[thread.id],
                                    performAction = { action ->
                                        if (action == ChatRowAction.Rename) renamingId = thread.id
                                        else performRowAction(thread.id, action)
                                    },
                                ) {
                                    open(thread)
                                }
                                if (index == pinTail) {
                                    HorizontalDivider(
                                        Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                                        thickness = 1.dp,
                                    )
                                }
                            }
                        }
                    }
                }
                if (
                    groups.all { it.threads.isEmpty() } &&
                        !metadataPending &&
                        !metadataFailed &&
                        !missingDefault &&
                        state.listPhase == ChatReadPhase.Ready &&
                        (state.filter != ChatListFilter.Unread ||
                            state.indicatorsPhase == ChatReadPhase.Ready)
                ) {
                    item {
                        Text(
                            stringResource(R.string.chat_empty),
                            Modifier.padding(horizontal = 12.dp, vertical = 38.dp).semantics {
                                liveRegion = LiveRegionMode.Polite
                            },
                            style =
                                MaterialTheme.typography.titleMedium.copy(
                                    fontSize = 19.sp,
                                    lineHeight = 28.5.sp,
                                    letterSpacing = 0.sp,
                                ),
                        )
                    }
                }
            }
        }
        val end = if (wide) 20.dp else if (largeCompact) 32.dp else 24.dp
        NewChatAction(
            Modifier.align(Alignment.BottomEnd).padding(end = end, bottom = 24.dp),
            enabled = actionsEnabled,
            onClick = { newChat(null) },
        )
    }
}

private fun Modifier.projectChildIndent(color: Color): Modifier =
    drawBehind {
            val inset = 20.5.dp.toPx()
            val x = if (layoutDirection == LayoutDirection.Ltr) inset else size.width - inset
            drawLine(color, Offset(x, 0f), Offset(x, size.height), strokeWidth = 1.dp.toPx())
        }
        .padding(start = 24.dp)

@Composable
private fun RenameChatDialog(
    currentTitle: String,
    enabled: Boolean,
    dismiss: () -> Unit,
    save: (String) -> Unit,
) {
    var input by remember { mutableStateOf(TextFieldValue(currentTitle)) }
    val title = input.text.trim()
    val foreground = MaterialTheme.colorScheme.onSurface
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text(stringResource(R.string.chat_rename)) },
        text = {
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.chat_title_field)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                colors =
                    OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = foreground,
                        focusedLabelColor = foreground,
                        cursorColor = foreground,
                    ),
            )
        },
        confirmButton = {
            ChatAction(
                R.string.chat_rename_confirm,
                { save(title) },
                enabled = enabled && title.isNotEmpty() && title != currentTitle.trim(),
            )
        },
        dismissButton = { ChatAction(R.string.chat_rename_cancel, dismiss) },
    )
}

private fun projectRowKey(id: String) = "group_$id"

@Composable
private fun ProjectRow(
    name: String,
    collapsed: Boolean,
    status: ChatRowStatus,
    runningFrame: LongState,
    row: Int,
    toggle: () -> Unit,
    newChat: (() -> Unit)?,
) {
    val label = status.label()
    var menuOpen by remember(newChat != null) { mutableStateOf(false) }
    val openMenu: (() -> Unit)? = if (newChat != null) ({ menuOpen = true }) else null
    Box {
        Row(
            Modifier.fillMaxWidth()
                .heightIn(min = 52.dp)
                .clip(RoundedCornerShape(8.dp))
                .contextMenuInput(openMenu)
                .combinedClickable(
                    role = Role.Button,
                    onClick = toggle,
                    onLongClick = openMenu,
                    onLongClickLabel = stringResource(R.string.chat_more_actions),
                )
                .semantics {
                    heading()
                    if (label != null) stateDescription = label
                    if (collapsed) {
                        expand {
                            toggle()
                            true
                        }
                    } else {
                        collapse {
                            toggle()
                            true
                        }
                    }
                }
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                painterResource(if (collapsed) R.drawable.ic_folder else R.drawable.ic_folder_open),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(8.dp))
            Row(
                Modifier.weight(1f),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    name,
                    Modifier.weight(1f, fill = false),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = chatListTitleStyle(),
                    fontWeight = FontWeight.SemiBold,
                )
                Icon(
                    painterResource(
                        if (collapsed) R.drawable.ic_chevron_right else R.drawable.ic_expand_more
                    ),
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(16.dp),
                )
            }
            if (status != ChatRowStatus.None) {
                Spacer(Modifier.width(8.dp))
                ChatStatusGlyph(status, runningFrame, row)
            }
        }
        if (newChat != null) {
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.composer_new_project)) },
                    leadingIcon = {
                        Icon(painterResource(R.drawable.ic_edit_square), contentDescription = null)
                    },
                    onClick = {
                        menuOpen = false
                        newChat()
                    },
                )
            }
        }
    }
}

@Composable
private fun Modifier.contextMenuInput(openMenu: (() -> Unit)?): Modifier {
    val latestOpenMenu by rememberUpdatedState(openMenu)
    return onKeyEvent {
            val open = latestOpenMenu
            if (
                open != null &&
                    it.type == KeyEventType.KeyUp &&
                    (it.key == Key.Menu || it.key == Key.F10 && it.isShiftPressed)
            ) {
                open()
                true
            } else false
        }
        .pointerInput(Unit) {
            awaitPointerEventScope {
                while (true) {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    if (event.type == PointerEventType.Press && event.buttons.isSecondaryPressed) {
                        event.changes.forEach { it.consume() }
                        latestOpenMenu?.invoke()
                    }
                }
            }
        }
}

@Composable
private fun ChatRow(
    thread: ConfirmedChat,
    status: ChatRowStatus,
    isSelected: Boolean,
    runningFrame: LongState,
    row: Int,
    actions: List<ChatRowAction>,
    enabled: Boolean,
    pendingAction: ChatRowAction?,
    performAction: (ChatRowAction) -> Unit,
    open: () -> Unit,
) {
    var menuOpen by remember(actions) { mutableStateOf(false) }
    val openMenu: (() -> Unit)? =
        if (actions.isNotEmpty() && pendingAction == null) ({ menuOpen = true }) else null
    val labels =
        listOfNotNull(
            status.label(),
            if (thread.pinnedAt != null) stringResource(R.string.chat_pinned) else null,
            pendingAction?.let {
                stringResource(
                    if (it.updatesChat) R.string.chat_row_action_pending
                    else R.string.chat_read_action_pending
                )
            },
        )
    val shape = RoundedCornerShape(8.dp)
    val colors = MaterialTheme.colorScheme
    Box {
        Row(
            Modifier.fillMaxWidth()
                .heightIn(min = 52.dp)
                .clip(shape)
                .then(if (isSelected) Modifier.background(colors.secondaryContainer) else Modifier)
                .contextMenuInput(openMenu)
                .combinedClickable(
                    enabled = enabled,
                    onClick = open,
                    onLongClick = openMenu,
                    onLongClickLabel = stringResource(R.string.chat_actions),
                )
                .testTag("chat_${thread.id}")
                .semantics {
                    if (isSelected) selected = true
                    if (labels.isNotEmpty()) stateDescription = labels.joinToString()
                }
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.weight(1f)) {
                Text(
                    thread.title?.takeIf { it.isNotBlank() }
                        ?: stringResource(R.string.chat_untitled),
                    if (status == ChatRowStatus.Running)
                        Modifier.runningTitleWave(runningFrame, row)
                    else Modifier,
                    color = if (isSelected) colors.onSecondaryContainer else colors.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = chatListTitleStyle(),
                    fontWeight = if (status == ChatRowStatus.Unread) FontWeight.SemiBold else null,
                )
            }
            Spacer(Modifier.width(8.dp))
            ChatStatusGlyph(status, runningFrame, row)
        }
        if (actions.isNotEmpty()) {
            DropdownMenu(
                expanded = menuOpen && pendingAction == null,
                onDismissRequest = { menuOpen = false },
            ) {
                for (action in actions) {
                    DropdownMenuItem(
                        text = { Text(stringResource(action.label())) },
                        leadingIcon = {
                            Icon(painterResource(action.icon()), contentDescription = null)
                        },
                        onClick = {
                            menuOpen = false
                            performAction(action)
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun chatListTitleStyle() =
    MaterialTheme.typography.bodyLarge.copy(
        fontSize = 16.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.sp,
    )

private fun ChatRowAction.label(): Int =
    when (this) {
        ChatRowAction.MarkRead -> R.string.chat_mark_read
        ChatRowAction.MarkUnread -> R.string.chat_mark_unread
        ChatRowAction.Mute -> R.string.chat_mute
        ChatRowAction.Unmute -> R.string.chat_unmute
        ChatRowAction.Archive -> R.string.chat_archive
        ChatRowAction.Unarchive -> R.string.chat_unarchive
        ChatRowAction.Rename -> R.string.chat_rename
        ChatRowAction.Pin -> R.string.chat_pin
        ChatRowAction.Unpin -> R.string.chat_unpin
        ChatRowAction.MovePinUp -> R.string.chat_move_pin_up
        ChatRowAction.MovePinDown -> R.string.chat_move_pin_down
    }

@DrawableRes
private fun ChatRowAction.icon(): Int =
    when (this) {
        ChatRowAction.MarkRead -> R.drawable.ic_drafts
        ChatRowAction.MarkUnread -> R.drawable.ic_mail
        ChatRowAction.Mute -> R.drawable.ic_notifications_off
        ChatRowAction.Unmute -> R.drawable.ic_notifications
        ChatRowAction.Archive -> R.drawable.ic_archive
        ChatRowAction.Unarchive -> R.drawable.ic_unarchive
        ChatRowAction.Rename -> R.drawable.ic_edit
        ChatRowAction.Pin -> R.drawable.ic_keep
        ChatRowAction.Unpin -> R.drawable.ic_keep_off
        ChatRowAction.MovePinUp -> R.drawable.ic_arrow_upward
        ChatRowAction.MovePinDown -> R.drawable.ic_arrow_downward
    }

@Composable
private fun ChatRowStatus.label(): String? =
    when (this) {
        ChatRowStatus.Running -> stringResource(R.string.chat_active)
        ChatRowStatus.Unread -> stringResource(R.string.chat_unread)
        ChatRowStatus.Muted -> stringResource(R.string.chat_muted)
        ChatRowStatus.None -> null
    }

@Composable
private fun ChatStatusGlyph(status: ChatRowStatus, runningFrame: LongState, row: Int) {
    // Web uses sky-600. A lighter blue keeps the mark legible on dark selection fills.
    val color =
        if (MaterialTheme.colorScheme.background.luminance() < 0.5f) Color(0xFF38BDF8)
        else Color(0xFF0084D1)
    Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) {
        when (status) {
            ChatRowStatus.Unread -> Canvas(Modifier.size(8.dp)) { drawCircle(color) }
            ChatRowStatus.Running ->
                Canvas(Modifier.size(14.dp)) { drawRunningWave(color, runningFrame.longValue, row) }
            ChatRowStatus.Muted ->
                Icon(
                    painterResource(R.drawable.ic_notifications_off),
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(16.dp),
                )
            ChatRowStatus.None -> Unit
        }
    }
}

@Composable
private fun ChatAction(label: Int, action: () -> Unit, enabled: Boolean = true) {
    TextButton(
        onClick = action,
        enabled = enabled,
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
    ) {
        Text(stringResource(label))
    }
}

@Composable
private fun NewChatAction(modifier: Modifier, enabled: Boolean, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.alpha(if (enabled) 1f else 0.4f).semantics { role = Role.Button },
        shape = RoundedCornerShape(16.dp),
        color = colors.inverseSurface,
        contentColor = colors.inverseOnSurface,
        shadowElevation = 3.dp,
    ) {
        Row(
            Modifier.heightIn(min = 56.dp).padding(horizontal = 20.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(painterResource(R.drawable.ic_edit_square), null, Modifier.size(22.dp))
            Text(
                stringResource(R.string.composer_new),
                style = MaterialTheme.typography.labelLarge.copy(letterSpacing = 0.sp),
                fontWeight = FontWeight(550),
            )
        }
    }
}

@Composable
private fun NewProjectChatAction(enabled: Boolean, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.heightIn(min = 48.dp),
        shape = RoundedCornerShape(9.dp),
        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp),
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
    ) {
        Icon(painterResource(R.drawable.ic_add), null, Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text(
            stringResource(R.string.composer_new_project),
            style =
                MaterialTheme.typography.labelMedium.copy(
                    fontSize = 13.sp,
                    lineHeight = 20.sp,
                    letterSpacing = 0.sp,
                ),
        )
    }
}

@Composable
private fun ChatNotice(message: Int) {
    Text(
        stringResource(message),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
    )
}

internal fun ChatListFilter.label() =
    when (this) {
        ChatListFilter.Inbox -> R.string.chat_inbox
        ChatListFilter.Unread -> R.string.chat_unread
        ChatListFilter.Archived -> R.string.chat_archived
        ChatListFilter.Muted -> R.string.chat_muted
    }
