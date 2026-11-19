package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.api.generated.IndicatorsThreadsValue
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LongState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

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
    collapsed: List<String>,
    toggleProject: (String) -> Unit,
    listState: LazyListState,
    newChat: (String?) -> Unit,
    selectedChatId: String?,
) {
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
                indicators.forEach { (id, indicator) ->
                    if (indicator == IndicatorsThreadsValue.ACTIVE) add(id)
                }
                sections.forEach { section ->
                    if (section.foldedStatus == ChatRowStatus.Running) {
                        add(projectRowKey(checkNotNull(section.group.project).id))
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
    PullToRefreshBox(
        isRefreshing = state.confirmedAt != null && state.listPhase == ChatReadPhase.Loading,
        onRefresh = refresh,
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.TopCenter,
    ) {
        LazyColumn(
            Modifier.widthIn(max = 720.dp).fillMaxSize().testTag("chat_list").semantics {
                if (state.listPhase != ChatReadPhase.Loading) {
                    customActions =
                        listOf(
                            CustomAccessibilityAction(refreshLabel) {
                                refresh()
                                true
                            }
                        )
                }
            },
            contentPadding = androidx.compose.foundation.layout.PaddingValues(24.dp),
            state = listState,
        ) {
            item {
                Text(
                    stringResource(R.string.chat_list_title),
                    style = MaterialTheme.typography.headlineLarge,
                    modifier = Modifier.semantics { heading() },
                )
                ChatAction(R.string.composer_new, { newChat(null) })
            }
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
                            )
                        }
                        if (foldedStatus == null) {
                            item(key = "project_actions_${project.id}") {
                                Column(Modifier.padding(start = 24.dp)) {
                                    if (group.threads.isEmpty()) {
                                        ChatNotice(R.string.chat_project_empty)
                                    }
                                    ChatAction(
                                        R.string.composer_new_project,
                                        { newChat(project.id) },
                                    )
                                }
                            }
                        }
                    }
                    if (foldedStatus == null) {
                        val pinTail = group.pinnedTailIndex()
                        itemsIndexed(group.threads, key = { _, thread -> thread.id }) {
                            index,
                            thread ->
                            Column(Modifier.padding(start = if (project == null) 0.dp else 24.dp)) {
                                ChatRow(
                                    thread,
                                    chatRowStatus(indicators[thread.id], thread.muted == true),
                                    thread.id == selectedChatId,
                                    runningFrame,
                                    row = section.firstChatRow + index,
                                    actions = state.rowActions(thread),
                                    pendingAction = state.pendingRowActions[thread.id],
                                    performAction = { action ->
                                        performRowAction(thread.id, action)
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
                    item { ChatNotice(R.string.chat_empty) }
                }
            }
        }
    }
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
) {
    val label = status.label()
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 52.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(role = Role.Button, onClick = toggle)
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
            painterResource(
                if (collapsed) R.drawable.ic_chat_chevron_end else R.drawable.ic_chat_chevron_down
            ),
            contentDescription = null,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            name,
            Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.SemiBold,
        )
        if (status != ChatRowStatus.None) {
            Spacer(Modifier.width(8.dp))
            ChatStatusGlyph(status, runningFrame, row)
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
            if (thread.muted == true && status == ChatRowStatus.Running) {
                stringResource(R.string.chat_muted)
            } else null,
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
                .onKeyEvent {
                    if (
                        openMenu != null &&
                            it.type == KeyEventType.KeyUp &&
                            (it.key == Key.Menu || it.key == Key.F10 && it.isShiftPressed)
                    ) {
                        openMenu()
                        true
                    } else false
                }
                .pointerInput(actions, pendingAction) {
                    awaitPointerEventScope {
                        while (true) {
                            val event = awaitPointerEvent(PointerEventPass.Initial)
                            if (
                                event.type == PointerEventType.Press &&
                                    event.buttons.isSecondaryPressed
                            ) {
                                event.changes.forEach { it.consume() }
                                openMenu?.invoke()
                            }
                        }
                    }
                }
                .combinedClickable(
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
            Text(
                thread.title?.takeIf { it.isNotBlank() } ?: stringResource(R.string.chat_untitled),
                Modifier.weight(1f),
                color = if (isSelected) colors.onSecondaryContainer else colors.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (status == ChatRowStatus.Unread) FontWeight.SemiBold else null,
            )
            if (status != ChatRowStatus.None) {
                Spacer(Modifier.width(8.dp))
                ChatStatusGlyph(status, runningFrame, row)
            }
        }
        if (actions.isNotEmpty()) {
            DropdownMenu(
                expanded = menuOpen && pendingAction == null,
                onDismissRequest = { menuOpen = false },
            ) {
                for (action in actions) {
                    DropdownMenuItem(
                        text = { Text(stringResource(action.label())) },
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

private fun ChatRowAction.label(): Int =
    when (this) {
        ChatRowAction.MarkRead -> R.string.chat_mark_read
        ChatRowAction.MarkUnread -> R.string.chat_mark_unread
        ChatRowAction.Mute -> R.string.chat_mute
        ChatRowAction.Unmute -> R.string.chat_unmute
        ChatRowAction.Archive -> R.string.chat_archive
        ChatRowAction.Unarchive -> R.string.chat_unarchive
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
                    painterResource(R.drawable.ic_chat_muted),
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
private fun ChatNotice(message: Int) {
    Text(
        stringResource(message),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
    )
}

internal fun ChatListFilter.label() =
    when (this) {
        ChatListFilter.Recent -> R.string.chat_all
        ChatListFilter.Unread -> R.string.chat_unread
        ChatListFilter.Archived -> R.string.chat_archived
        ChatListFilter.Muted -> R.string.chat_muted
    }
