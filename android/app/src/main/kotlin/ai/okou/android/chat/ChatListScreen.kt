package ai.okou.android.chat

import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.R
import ai.okou.android.WorkspaceMenu
import ai.okou.android.WorkspaceMenuItem
import ai.okou.android.currentWindowSizeDp
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
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
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.contentDescription
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
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.text.NumberFormat
import kotlinx.coroutines.delay

@Composable
internal fun ChatListScreen(
    state: ChatListUiState,
    retryList: () -> Unit,
    retryMetadata: () -> Unit,
    retryIndicators: () -> Unit,
    open: (ConfirmedChat) -> Unit,
    provisionalChats: List<ProvisionalChat>,
    openProvisional: (ProvisionalChat) -> Unit,
    performRowAction: (String, ChatRowAction) -> Unit,
    renameThread: (String, String) -> Unit,
    projectExpansion: ProjectExpansionModel?,
    listState: LazyListState,
    newChat: (String?) -> Unit,
    showInbox: () -> Unit,
    selectedChatId: String?,
    wide: Boolean,
    newChatEnabled: Boolean,
    startupRecovery: @Composable (() -> Unit)?,
    feedback: @Composable () -> Unit,
) {
    var renamingId by remember { mutableStateOf<String?>(null) }
    var deletingId by remember { mutableStateOf<String?>(null) }
    deletingId?.let { id ->
        val thread = state.threads.firstOrNull { it.id == id && it.hidden != true }
        if (thread != null) {
            AlertDialog(
                onDismissRequest = { deletingId = null },
                modifier =
                    Modifier.padding(horizontal = 24.dp).widthIn(max = 360.dp).fillMaxWidth(),
                shape = RoundedCornerShape(28.dp),
                containerColor = MaterialTheme.colorScheme.surface,
                tonalElevation = 0.dp,
                properties = DialogProperties(usePlatformDefaultWidth = false),
                title = {
                    Text(
                        stringResource(R.string.chat_delete_title),
                        fontWeight = FontWeight.SemiBold,
                    )
                },
                text = {
                    Text(
                        stringResource(R.string.chat_delete_description),
                        Modifier.verticalScroll(rememberScrollState()),
                    )
                },
                confirmButton = {
                    TextButton(
                        onClick = {
                            deletingId = null
                            performRowAction(id, ChatRowAction.Delete)
                        },
                        enabled =
                            id !in state.pendingRowActions &&
                                ChatRowAction.Delete in state.rowActions(thread),
                        colors =
                            ButtonDefaults.textButtonColors(
                                contentColor = MaterialTheme.colorScheme.error
                            ),
                    ) {
                        Text(stringResource(R.string.chat_delete_confirm))
                    }
                },
                dismissButton = { ChatAction(R.string.chat_rename_cancel, { deletingId = null }) },
            )
        } else if (state.listPhase == ChatReadPhase.Ready) {
            LaunchedEffect(id) { deletingId = null }
        }
    }
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
    val unreadAt = state.displayUnreadAt
    val groups =
        remember(
            state.threads,
            state.projects,
            state.agents,
            state.filter,
            unreadAt,
            state.readIntents,
        ) {
            chatListGroups(state)
        }
    val indicators = state.indicators?.threads.orEmpty()
    val unreadChatIds = remember(unreadAt, state.readIntents) { state.unreadChatIds() }
    val knownProjects = remember(state.projects) { state.projects.mapTo(hashSetOf()) { it.id } }
    val pendingByProject =
        remember(state.threads, state.filter, provisionalChats, knownProjects) {
            if (state.filter != ChatListFilter.Inbox || provisionalChats.isEmpty()) emptyMap()
            else {
                val confirmedIds = state.threads.mapTo(hashSetOf()) { it.id }
                provisionalChats
                    .filterNot { it.threadId in confirmedIds }
                    .groupBy { it.projectId?.takeIf(knownProjects::contains) }
            }
        }
    val expansion = projectExpansion?.state?.collectAsStateWithLifecycle()?.value
    val expandedProjectIds = expansion?.expandedIds.orEmpty()
    val sections =
        remember(groups, expandedProjectIds, indicators, unreadChatIds, pendingByProject) {
            chatListSections(
                groups,
                expandedProjectIds,
                indicators,
                unreadChatIds,
                pendingByProject,
            )
        }
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
                                    chatRowStatus(
                                        indicators[thread.id],
                                        thread.muted == true,
                                        thread.id in unreadChatIds,
                                    ) == ChatRowStatus.Running
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
    val metadataUsable = state.agentsSource != null && state.projectsSource != null
    val metadataMissing =
        state.agentsSource == null && state.agentsPhase == ChatReadPhase.Failed ||
            state.projectsSource == null && state.projectsPhase == ChatReadPhase.Failed
    val missingDefault =
        state.agentsPhase == ChatReadPhase.Ready &&
            state.agents.none { it.isDefaultAgent } &&
            state.threads.any { it.hidden != true && it.projectId !in knownProjects }
    val listLabel = stringResource(R.string.chat_list_title)
    val widthDp = currentWindowSizeDp().width
    val largeCompact = widthDp >= 600
    val listInset = if (wide) 12.dp else if (largeCompact) 24.dp else 16.dp
    val outline = MaterialTheme.colorScheme.outline
    val status =
        when {
            state.offline -> ChatListStatus.Offline
            state.confirmedAt != null && state.sustainedRefreshFailure ->
                ChatListStatus.RefreshFailed
            else -> null
        }
    val missingUnread =
        state.confirmedAt != null &&
            state.filter == ChatListFilter.Unread &&
            unreadAt == null &&
            groups.all { it.threads.isEmpty() }
    val firstLoadFailure =
        if (missingUnread)
            ChatListReadFailure.NeedsRetry.takeIf { state.indicatorsPhase == ChatReadPhase.Failed }
        else state.listReadFailure
    val awaitingFirstList =
        (state.confirmedAt == null || missingUnread) &&
            pendingByProject.isEmpty() &&
            !state.offline &&
            firstLoadFailure == null &&
            (startupRecovery == null || state.listPhase != ChatReadPhase.Idle)
    var skeletonVisible by remember(awaitingFirstList) { mutableStateOf(false) }
    LaunchedEffect(awaitingFirstList) {
        if (awaitingFirstList) {
            delay(100)
            skeletonVisible = true
        }
    }
    // Follow changes to refreshed content without turning Project expansion into a scroll action.
    val lastContentKey =
        remember(groups, pendingByProject) {
            groups.asReversed().firstNotNullOfOrNull { group ->
                group.threads.lastOrNull()?.takeIf { it.pinnedAt == null }?.id
                    ?: pendingByProject[group.project?.id]?.lastOrNull()?.threadId
                    ?: group.threads.lastOrNull()?.id
                    ?: group.project?.id?.let(::projectRowKey)
            }
        }
    ChatListViewport(
        Modifier.fillMaxSize(),
        listState,
        lastContentKey = lastContentKey,
        status = status,
        newChatEnabled = newChatEnabled,
        newChat = { newChat(null) },
        feedback = feedback,
    ) { bottomSpace, inlineControls ->
        LazyColumn(
            Modifier.widthIn(max = 720.dp).fillMaxSize().testTag("chat_list").semantics {
                contentDescription = listLabel
            },
            contentPadding =
                PaddingValues(
                    start = listInset,
                    end = listInset,
                    top = if (inlineControls == null) 4.dp else 0.dp,
                    bottom = bottomSpace,
                ),
            state = listState,
        ) {
            if (inlineControls != null) item(key = "list_controls") { inlineControls() }
            if (startupRecovery != null) item(key = "workspace_recovery") { startupRecovery() }
            if (state.confirmedAt == null || missingUnread) {
                when {
                    state.offline ->
                        item { ChatListLoadNotice(R.string.chat_list_load_when_online) }
                    firstLoadFailure != null ->
                        item {
                            ChatListLoadNotice(R.string.chat_list_first_load_failed)
                            if (firstLoadFailure == ChatListReadFailure.NeedsRetry)
                                ChatAction(
                                    R.string.retry,
                                    if (missingUnread) retryIndicators else retryList,
                                    enabled =
                                        missingUnread || state.listPhase != ChatReadPhase.Loading,
                                )
                        }
                    skeletonVisible -> item { ChatListSkeleton() }
                }
            }
            if (state.cacheUnavailable || state.projectCacheUnavailable)
                item { ChatNotice(R.string.chat_cache_unavailable) }
            if (
                state.confirmedAt != null &&
                    state.filter == ChatListFilter.Unread &&
                    !missingUnread &&
                    !state.offline &&
                    state.indicators == null &&
                    state.indicatorsPhase == ChatReadPhase.Failed
            ) {
                item {
                    ChatNotice(R.string.chat_refresh_failed)
                    ChatAction(R.string.retry, retryIndicators)
                }
            }
            if (
                projectExpansion != null &&
                    expansion != null &&
                    (expansion.readFailed || expansion.failedWrites.isNotEmpty())
            ) {
                item {
                    ChatNotice(
                        if (expansion.readFailed) R.string.chat_project_expansion_read_failed
                        else R.string.chat_project_expansion_save_failed
                    )
                    ChatAction(R.string.retry, projectExpansion::retry)
                }
            }
            if (!state.offline && (metadataMissing || missingDefault))
                item {
                    ChatNotice(R.string.chat_metadata_unavailable)
                    ChatAction(R.string.retry, retryMetadata)
                }
            if (state.confirmedAt != null || pendingByProject.isNotEmpty()) {
                sections.forEach { section ->
                    val group = section.group
                    val project = group.project
                    val pending = section.provisionalChats
                    val foldedStatus = section.foldedStatus
                    if (project != null) {
                        item(key = projectRowKey(project.id)) {
                            ProjectRow(
                                project.name,
                                activity = section.foldedActivity,
                                runningFrame = runningFrame,
                                row = section.firstRow,
                                toggle = {
                                    projectExpansion?.setExpanded(project.id, foldedStatus != null)
                                },
                                newChat = if (newChatEnabled) ({ newChat(project.id) }) else null,
                            )
                        }
                        if (foldedStatus == null && group.threads.isEmpty() && pending.isEmpty()) {
                            item(key = "project_actions_${project.id}") {
                                Column(Modifier.projectChildIndent(outline)) {
                                    if (!newChatEnabled) {
                                        ChatNotice(R.string.chat_project_empty)
                                    }
                                    ChatListTextAction(
                                        R.string.composer_new_project,
                                        R.drawable.ic_add,
                                        enabled = newChatEnabled,
                                    ) {
                                        newChat(project.id)
                                    }
                                }
                            }
                        }
                    }
                    if (foldedStatus == null) {
                        val pinTail = group.pinnedTailIndex(hasProvisional = pending.isNotEmpty())
                        val firstPending = pinTail + 1
                        fun confirmedIndex(index: Int) =
                            if (index < firstPending) index else index - pending.size
                        items(
                            group.threads.size + pending.size,
                            key = { index ->
                                pending.getOrNull(index - firstPending)?.threadId
                                    ?: group.threads[confirmedIndex(index)].id
                            },
                        ) { index ->
                            Column(
                                if (project == null) Modifier
                                else Modifier.projectChildIndent(outline)
                            ) {
                                val provisional = pending.getOrNull(index - firstPending)
                                val threadIndex = confirmedIndex(index)
                                val thread =
                                    if (provisional == null) group.threads[threadIndex] else null
                                val id = provisional?.threadId ?: checkNotNull(thread).id
                                val unread = thread != null && id in unreadChatIds
                                ChatRow(
                                    id,
                                    thread?.title,
                                    pinned = thread?.pinnedAt != null,
                                    status =
                                        if (thread == null) ChatRowStatus.None
                                        else
                                            chatRowStatus(
                                                indicators[id],
                                                thread.muted == true,
                                                unread,
                                            ),
                                    unread = unread,
                                    isSelected = id == selectedChatId,
                                    runningFrame = runningFrame,
                                    row = section.firstChatRow + index,
                                    actions =
                                        thread
                                            ?.let { state.rowActions(it, group, threadIndex) }
                                            .orEmpty(),
                                    pendingAction = state.pendingRowActions[id],
                                    performAction = { action ->
                                        when (action) {
                                            ChatRowAction.Rename -> renamingId = id
                                            ChatRowAction.Delete -> deletingId = id
                                            else -> performRowAction(id, action)
                                        }
                                    },
                                ) {
                                    if (provisional != null) openProvisional(provisional)
                                    else open(checkNotNull(thread))
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
                        pendingByProject.isEmpty() &&
                        metadataUsable &&
                        !missingDefault &&
                        (state.filter != ChatListFilter.Unread || unreadAt != null)
                ) {
                    item {
                        Column(
                            Modifier.padding(start = 12.dp, end = 12.dp, top = 24.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                stringResource(R.string.chat_empty),
                                Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                                style = chatListTitleStyle().copy(fontWeight = FontWeight.SemiBold),
                            )
                            if (state.filter != ChatListFilter.Inbox) {
                                ChatListTextAction(
                                    R.string.chat_back_to_inbox,
                                    R.drawable.ic_arrow_back,
                                    onClick = showInbox,
                                )
                            }
                        }
                    }
                }
            }
        }
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
    activity: ProjectActivity?,
    runningFrame: LongState,
    row: Int,
    toggle: () -> Unit,
    newChat: (() -> Unit)?,
) {
    val collapsed = activity != null
    val status = activity?.status ?: ChatRowStatus.None
    val locale = LocalConfiguration.current.locales[0]
    val number = remember(locale) { NumberFormat.getIntegerInstance(locale) }
    val unread = stringResource(R.string.chat_unread)
    val running = stringResource(R.string.chat_active)
    val label =
        listOfNotNull(
                activity?.unread?.takeIf { it > 0 }?.let { "$unread ${number.format(it)}" },
                activity?.running?.takeIf { it > 0 }?.let { "$running ${number.format(it)}" },
            )
            .joinToString()
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
                    if (label.isNotEmpty()) stateDescription = label
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
    threadId: String,
    title: String?,
    pinned: Boolean,
    status: ChatRowStatus,
    unread: Boolean,
    isSelected: Boolean,
    runningFrame: LongState,
    row: Int,
    actions: List<ChatRowAction>,
    pendingAction: ChatRowAction?,
    performAction: (ChatRowAction) -> Unit,
    open: () -> Unit,
) {
    var menuOpen by remember(actions) { mutableStateOf(false) }
    val rowFocus = remember { FocusRequester() }
    var restoreMenuFocus by remember { mutableStateOf(false) }
    LaunchedEffect(menuOpen) {
        if (!menuOpen && restoreMenuFocus) {
            restoreMenuFocus = false
            rowFocus.requestFocus()
        }
    }
    val openMenu: (() -> Unit)? =
        if (actions.isNotEmpty() && pendingAction == null) ({ menuOpen = true }) else null
    val labels =
        listOfNotNull(
            status.label(),
            if (status == ChatRowStatus.Running && unread) stringResource(R.string.chat_unread)
            else null,
            if (pinned) stringResource(R.string.chat_pinned) else null,
            pendingAction?.let {
                stringResource(
                    if (it.updatesChat) R.string.chat_row_action_pending
                    else R.string.chat_read_action_pending
                )
            },
        )
    val shape = RoundedCornerShape(8.dp)
    val colors = MaterialTheme.colorScheme
    val readAction =
        actions.firstOrNull { it == ChatRowAction.MarkRead || it == ChatRowAction.MarkUnread }
    val archiveAction =
        actions.firstOrNull { it == ChatRowAction.Archive || it == ChatRowAction.Unarchive }
    ChatRowSwipe(
        readAction = readAction.takeIf { openMenu != null },
        archiveAction = archiveAction.takeIf { openMenu != null },
        performAction = performAction,
    ) { swipeModifier ->
        Row(
            swipeModifier
                .fillMaxWidth()
                .heightIn(min = 52.dp)
                .clip(shape)
                .background(if (isSelected) colors.secondaryContainer else colors.background)
                .contextMenuInput(openMenu)
                .focusRequester(rowFocus)
                .combinedClickable(
                    onClick = open,
                    onLongClick = openMenu,
                    onLongClickLabel = stringResource(R.string.chat_actions),
                )
                .testTag("chat_$threadId")
                .semantics {
                    if (isSelected) selected = true
                    if (labels.isNotEmpty()) stateDescription = labels.joinToString()
                }
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                title?.takeIf { it.isNotBlank() } ?: stringResource(R.string.chat_untitled),
                Modifier.weight(1f),
                color = if (isSelected) colors.onSecondaryContainer else colors.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = chatListTitleStyle(),
                fontWeight = if (status == ChatRowStatus.Unread) FontWeight.SemiBold else null,
            )
            Spacer(Modifier.width(8.dp))
            ChatStatusGlyph(status, runningFrame, row)
        }
        if (menuOpen && pendingAction == null) {
            WorkspaceMenu(
                items =
                    actions.map { action ->
                        WorkspaceMenuItem(
                            stringResource(action.label()),
                            action.icon(),
                            destructive = action == ChatRowAction.Delete,
                        ) {
                            menuOpen = false
                            performAction(action)
                        }
                    },
                close = {
                    restoreMenuFocus = true
                    menuOpen = false
                },
                title =
                    title?.takeIf { it.isNotBlank() } ?: stringResource(R.string.chat_untitled),
            )
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

internal fun ChatRowAction.label(): Int =
    when (this) {
        ChatRowAction.MarkRead -> R.string.chat_mark_read
        ChatRowAction.MarkUnread -> R.string.chat_mark_unread
        ChatRowAction.Mute -> R.string.chat_mute
        ChatRowAction.Unmute -> R.string.chat_unmute
        ChatRowAction.Archive -> R.string.chat_archive
        ChatRowAction.Unarchive -> R.string.chat_unarchive
        ChatRowAction.Delete -> R.string.chat_delete
        ChatRowAction.Rename -> R.string.chat_rename
        ChatRowAction.Pin -> R.string.chat_pin
        ChatRowAction.Unpin -> R.string.chat_unpin
        ChatRowAction.MovePinUp -> R.string.chat_move_pin_up
        ChatRowAction.MovePinDown -> R.string.chat_move_pin_down
    }

@DrawableRes
private fun ChatRowAction.icon(): Int =
    when (this) {
        ChatRowAction.MarkRead -> R.drawable.ic_mark_chat_read
        ChatRowAction.MarkUnread -> R.drawable.ic_mark_chat_unread
        ChatRowAction.Mute -> R.drawable.ic_notifications_off
        ChatRowAction.Unmute -> R.drawable.ic_notifications
        ChatRowAction.Archive -> R.drawable.ic_archive
        ChatRowAction.Unarchive -> R.drawable.ic_unarchive
        ChatRowAction.Delete -> R.drawable.ic_delete
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
    val color = LocalActivityStatusColor.current
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
private fun ChatListTextAction(
    label: Int,
    @DrawableRes icon: Int,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.heightIn(min = 48.dp),
        shape = RoundedCornerShape(9.dp),
        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp),
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
    ) {
        Icon(painterResource(icon), null, Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text(
            stringResource(label),
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
private fun ChatListLoadNotice(message: Int) {
    Box(
        Modifier.heightIn(min = 48.dp).padding(horizontal = 12.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(
            stringResource(message),
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style =
                MaterialTheme.typography.bodyMedium.copy(
                    fontSize = 14.sp,
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
