package ai.okou.android.chat

import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.R
import ai.okou.android.WorkspaceMenu
import ai.okou.android.WorkspaceMenuItem
import ai.okou.android.currentWindowSizeDp
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.LongState
import androidx.compose.runtime.SideEffect
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
import androidx.compose.ui.focus.onFocusChanged
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
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.text.NumberFormat

private const val ProjectMotionMillis = 250
internal val ChatListMotionEasing = CubicBezierEasing(0.2f, 0f, 0f, 1f)
private val projectPlacement = tween<IntOffset>(ProjectMotionMillis, easing = ChatListMotionEasing)
private val projectChildFade = tween<Float>(ProjectMotionMillis, easing = ChatListMotionEasing)
private val immediatePlacement = snap<IntOffset>()

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
    renameProject: (String, String) -> Unit,
    retryProjectRename: (String) -> Unit,
    projectExpansion: ProjectExpansionModel?,
    listState: LazyListState,
    newChat: (String?) -> Unit,
    showInbox: () -> Unit,
    selectedChatId: String?,
    wide: Boolean,
    newChatEnabled: Boolean,
    startupRecovery: @Composable (() -> Unit)?,
    dismissProjectRenameRejection: (ProjectRenameRejection) -> Unit,
    feedback: @Composable () -> Unit,
) {
    var renamingId by remember { mutableStateOf<String?>(null) }
    var renamingProjectId by remember { mutableStateOf<String?>(null) }
    val projectToRename = state.projects.firstOrNull { it.id == renamingProjectId }
    val canRenameProject = state.canRenameProject
    if (projectToRename != null) {
        key(projectToRename.id) {
            RenameListItemDialog(
                currentName = projectToRename.name,
                titleRes = R.string.chat_rename_project,
                labelRes = R.string.chat_project_name,
                confirmRes = R.string.chat_project_rename_save,
                maxLength = 120,
                enabled = canRenameProject,
                dismiss = { renamingProjectId = null },
                save = { name ->
                    renameProject(projectToRename.id, name)
                    renamingProjectId = null
                },
            )
        }
    } else if (renamingProjectId != null && state.projectsPhase == ChatReadPhase.Ready) {
        LaunchedEffect(renamingProjectId) { renamingProjectId = null }
    }
    var deletingId by remember { mutableStateOf<String?>(null) }
    deletingId?.let { id ->
        val thread = state.threads.firstOrNull { it.id == id && it.hidden != true }
        if (thread != null) {
            DeleteChatDialog(
                enabled =
                    id !in state.pendingRowActions &&
                        ChatRowAction.Delete in state.rowActions(thread),
                dismiss = { deletingId = null },
                confirm = {
                    deletingId = null
                    performRowAction(id, ChatRowAction.Delete)
                },
            )
        } else if (state.listPhase == ChatReadPhase.Ready) {
            LaunchedEffect(id) { deletingId = null }
        }
    }
    val renaming =
        renamingId?.let { id -> state.threads.firstOrNull { it.id == id && it.hidden != true } }
    if (renaming != null) {
        key(renaming.id) {
            RenameListItemDialog(
                currentName = renaming.title.orEmpty(),
                titleRes = R.string.chat_rename,
                labelRes = R.string.chat_title_field,
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
    val pendingByProject =
        remember(state.threads, state.filter, provisionalChats) {
            if (state.filter != ChatListFilter.Inbox || provisionalChats.isEmpty()) emptyMap()
            else {
                val confirmedIds = state.threads.mapTo(hashSetOf()) { it.id }
                provisionalChats.filterNot { it.threadId in confirmedIds }.groupBy { it.projectId }
            }
        }
    val groups =
        remember(
            state.threads,
            state.projects,
            state.filter,
            unreadAt,
            state.readIntents,
            pendingByProject.keys,
        ) {
            chatListGroups(state, provisionalProjectIds = pendingByProject.keys)
        }
    val indicators = state.indicators?.threads.orEmpty()
    val unreadChatIds = remember(unreadAt, state.readIntents) { state.unreadChatIds() }
    val knownProjects = remember(state.projects) { state.projects.mapTo(hashSetOf()) { it.id } }
    val renameRejection = state.projectRenameRejection
    val renameNoticeIds =
        state.unconfirmedProjectRenames + listOfNotNull(renameRejection?.projectId)
    val expansion = projectExpansion?.state?.collectAsStateWithLifecycle()?.value
    val savedExpansion = expansion?.expandedIds
    val expandedProjectIds = savedExpansion.orEmpty()
    val previousExpansion =
        remember(listState, projectExpansion) { ChatListProjectIds(savedExpansion) }
    val precedingIds = previousExpansion.ids
    val expansionChanged =
        precedingIds != null && savedExpansion != null && precedingIds != savedExpansion
    val newlyExpanded =
        if (expansionChanged) expandedProjectIds - precedingIds.orEmpty() else emptySet()
    // Give Compose stable lazy item positions without animating the initial disk restore.
    val placement =
        when {
            knownProjects.isEmpty() -> null
            expansionChanged -> projectPlacement
            else -> immediatePlacement
        }
    SideEffect { previousExpansion.ids = savedExpansion }
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
    val metadataUsable = state.projectsSource != null
    val metadataMissing =
        state.projectsSource == null && state.projectsPhase == ChatReadPhase.Failed
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
    val skeletonVisible = rememberChatWaitIndicator(awaitingFirstList)
    // Follow changes to refreshed content without turning Project expansion into a scroll action.
    val lastContentKey =
        remember(groups, pendingByProject) {
            groups.asReversed().firstNotNullOfOrNull { group ->
                group.threads.lastOrNull()?.takeIf { it.pinnedAt == null }?.id
                    ?: pendingByProject[group.projectId]?.lastOrNull()?.threadId
                    ?: group.threads.lastOrNull()?.id
                    ?: group.project?.id?.let(::projectRowKey)
            }
        }
    ChatListViewport(
        Modifier.fillMaxSize(),
        listState,
        contentChangeKey = lastContentKey to knownProjects,
        status = status,
        newChatEnabled = newChatEnabled,
        newChat = { newChat(null) },
        feedback = feedback,
    ) { bottomSpace, inlineControls ->
        val leadingItems =
            buildList<Pair<String, @Composable () -> Unit>> {
                fun row(key: String, content: @Composable () -> Unit) {
                    add(key to content)
                }
                if (inlineControls != null) row("list_controls", inlineControls)
                if (startupRecovery != null) row("workspace_recovery", startupRecovery)
                if (state.filter != ChatListFilter.Inbox) {
                    row("filter_heading") {
                        Text(
                            stringResource(state.filter.label()),
                            Modifier.padding(start = 12.dp, top = 8.dp, end = 12.dp, bottom = 4.dp)
                                .semantics { heading() }
                                .testTag("chat_filter_heading"),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style =
                                MaterialTheme.typography.bodySmall.copy(
                                    fontSize = 13.sp,
                                    lineHeight = 20.sp,
                                    letterSpacing = 0.sp,
                                    fontWeight = FontWeight.SemiBold,
                                ),
                        )
                    }
                }
                // A concurrent removal can leave no Project row to attach the failure to.
                if (renameRejection != null && renameRejection.projectId !in knownProjects) {
                    row("project_rename_${renameRejection.projectId}") {
                        ProjectRenameRejectionNotice(Modifier.padding(start = 12.dp)) {
                            dismissProjectRenameRejection(renameRejection)
                        }
                    }
                }
                if (state.confirmedAt == null || missingUnread) {
                    when {
                        state.offline ->
                            row("list_offline") {
                                ChatContentLoadNotice(R.string.chat_list_load_when_online)
                            }
                        firstLoadFailure != null ->
                            row("list_first_load_failure") {
                                ChatContentLoadNotice(
                                    R.string.chat_list_first_load_failed,
                                    retry =
                                        (if (missingUnread) retryIndicators else retryList).takeIf {
                                            firstLoadFailure == ChatListReadFailure.NeedsRetry
                                        },
                                    retryEnabled =
                                        missingUnread || state.listPhase != ChatReadPhase.Loading,
                                )
                            }
                        skeletonVisible -> row("list_skeleton") { ChatListSkeleton() }
                    }
                }
                if (state.cacheUnavailable || state.projectCacheUnavailable)
                    row("list_cache_unavailable") { ChatNotice(R.string.chat_cache_unavailable) }
                if (
                    state.confirmedAt != null &&
                        state.filter == ChatListFilter.Unread &&
                        !missingUnread &&
                        !state.offline &&
                        state.indicators == null &&
                        state.indicatorsPhase == ChatReadPhase.Failed
                ) {
                    row("list_indicators_unavailable") {
                        ChatNotice(R.string.chat_refresh_failed)
                        ChatAction(R.string.retry, retryIndicators)
                    }
                }
                if (
                    projectExpansion != null &&
                        expansion != null &&
                        (expansion.readFailed || expansion.failedWrites.isNotEmpty())
                ) {
                    row("list_expansion_unavailable") {
                        ChatNotice(
                            if (expansion.readFailed) R.string.chat_project_expansion_read_failed
                            else R.string.chat_project_expansion_save_failed
                        )
                        ChatAction(R.string.retry, projectExpansion::retry)
                    }
                }
                if (!state.offline && metadataMissing)
                    row("list_metadata_unavailable") {
                        ChatNotice(R.string.chat_metadata_unavailable)
                        ChatAction(R.string.retry, retryMetadata)
                    }
            }
        KeepChatListProjectAnchor(listState, knownProjects) { key, offset ->
            sections.findScrollAnchor(key, offset, leadingItems.size, renameNoticeIds)
        }
        LazyColumn(
            Modifier.widthIn(max = 720.dp).fillMaxSize().testTag("chat_list").semantics {
                contentDescription = listLabel
            },
            contentPadding =
                PaddingValues(
                    start = listInset,
                    end = listInset,
                    top =
                        if (inlineControls == null && state.filter == ChatListFilter.Inbox) 4.dp
                        else 0.dp,
                    bottom = bottomSpace,
                ),
            state = listState,
        ) {
            items(leadingItems.size, key = { leadingItems[it].first }) { leadingItems[it].second() }
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
                                modifier = Modifier.animateItem(null, placement, null),
                                activity = section.foldedActivity,
                                runningFrame = runningFrame,
                                row = section.firstRow,
                                toggle = {
                                    projectExpansion?.setExpanded(project.id, foldedStatus != null)
                                },
                                newChat = if (newChatEnabled) ({ newChat(project.id) }) else null,
                                rename = { renamingProjectId = project.id },
                                canRename = canRenameProject,
                                renaming = state.renamingProjectId == project.id,
                            )
                        }
                        if (renameRejection != null && renameRejection.projectId == project.id) {
                            item(key = "project_rename_${project.id}") {
                                ProjectRenameRejectionNotice(
                                    Modifier.animateItem(null, placement, null)
                                        .projectChildIndent(outline)
                                ) {
                                    dismissProjectRenameRejection(renameRejection)
                                }
                            }
                        } else if (project.id in state.unconfirmedProjectRenames) {
                            item(key = "project_rename_${project.id}") {
                                Column(
                                    Modifier.animateItem(null, placement, null)
                                        .projectChildIndent(outline)
                                ) {
                                    ChatNotice(R.string.chat_project_rename_unconfirmed)
                                    ChatAction(
                                        R.string.retry,
                                        { retryProjectRename(project.id) },
                                        enabled = canRenameProject,
                                    )
                                }
                            }
                        }
                        if (section.showsEmptyProjectAction) {
                            item(key = "project_actions_${project.id}") {
                                Column(
                                    Modifier.animateItem(
                                            fadeInSpec =
                                                projectChildFade.takeIf {
                                                    project.id in newlyExpanded
                                                },
                                            placementSpec = placement,
                                            fadeOutSpec = projectChildFade,
                                        )
                                        .projectChildIndent(outline)
                                ) {
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
                        val pinTail = section.pinTail
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
                            val rowModifier =
                                Modifier.animateItem(
                                    fadeInSpec =
                                        projectChildFade.takeIf {
                                            project != null && project.id in newlyExpanded
                                        },
                                    placementSpec = placement,
                                    fadeOutSpec = projectChildFade.takeIf { project != null },
                                )
                            Column(
                                if (group.projectId == null) rowModifier
                                else rowModifier.projectChildIndent(outline)
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
                    groups.all { it.project == null && it.threads.isEmpty() } &&
                        pendingByProject.isEmpty() &&
                        metadataUsable &&
                        (state.filter != ChatListFilter.Unread || unreadAt != null)
                ) {
                    item { ChatListEmptyState(state.filter, showInbox) }
                }
            }
        }
    }
}

@Composable
private fun ChatListEmptyState(filter: ChatListFilter, showInbox: () -> Unit) {
    val title =
        when (filter) {
            ChatListFilter.Inbox -> R.string.chat_empty
            ChatListFilter.Unread -> R.string.chat_empty_unread
            ChatListFilter.Archived -> R.string.chat_empty_archived
            ChatListFilter.Muted -> R.string.chat_empty_muted
        }
    Column(Modifier.padding(vertical = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            stringResource(title),
            Modifier.padding(horizontal = 12.dp).semantics {
                heading()
                liveRegion = LiveRegionMode.Polite
            },
            style = chatListTitleStyle().copy(fontWeight = FontWeight.SemiBold),
        )
        if (filter != ChatListFilter.Inbox) {
            ChatListTextAction(R.string.chat_back_to_inbox, onClick = showInbox)
        }
    }
}

private data class ChatListScrollAnchor(val index: Int, val offset: Int)

private class ChatListProjectIds(var ids: Set<String>?)

@Composable
private fun KeepChatListProjectAnchor(
    listState: LazyListState,
    projectIds: Set<String>,
    findAnchor: (Any, Int) -> ChatListScrollAnchor?,
) {
    val previous = remember(listState) { ChatListProjectIds(projectIds) }
    SideEffect {
        if (previous.ids == projectIds) return@SideEffect
        previous.ids = projectIds
        if (
            listState.isScrollInProgress ||
                (listState.canScrollBackward && !listState.canScrollForward)
        ) {
            return@SideEffect
        }
        // A folded Project can move a chat beyond Compose's nearby-key index.
        val firstIndex = listState.firstVisibleItemIndex
        val first =
            listState.layoutInfo.visibleItemsInfo.firstOrNull { it.index == firstIndex }
                ?: return@SideEffect
        val anchor =
            findAnchor(first.key, listState.firstVisibleItemScrollOffset) ?: return@SideEffect
        listState.requestScrollToItem(anchor.index, anchor.offset)
    }
}

private fun List<ChatListSection>.findScrollAnchor(
    key: Any,
    offset: Int,
    leadingItemCount: Int,
    renameNoticeIds: Set<String>,
): ChatListScrollAnchor? {
    var row = leadingItemCount
    for (section in this) {
        val project = section.group.project
        val header = row
        if (project != null) {
            if (key == projectRowKey(project.id)) return ChatListScrollAnchor(row, offset)
            row += if (project.id in renameNoticeIds) 2 else 1
        }
        val threads = section.group.threads
        val pending = section.provisionalChats
        val threadIndex = threads.indexOfFirst { it.id == key }
        val pendingIndex = pending.indexOfFirst { it.threadId == key }
        if (threadIndex >= 0 || pendingIndex >= 0) {
            if (section.foldedActivity != null) return ChatListScrollAnchor(header, 0)
            val firstPending = section.pinTail + 1
            val chatIndex =
                when {
                    pendingIndex >= 0 -> firstPending + pendingIndex
                    threadIndex >= firstPending -> threadIndex + pending.size
                    else -> threadIndex
                }
            return ChatListScrollAnchor(row + chatIndex, offset)
        }
        if (section.foldedActivity == null) {
            row += if (section.showsEmptyProjectAction) 1 else threads.size + pending.size
        }
    }
    return null
}

private fun Modifier.projectChildIndent(color: Color): Modifier =
    drawBehind {
            val inset = 20.5.dp.toPx()
            val x = if (layoutDirection == LayoutDirection.Ltr) inset else size.width - inset
            drawLine(color, Offset(x, 0f), Offset(x, size.height), strokeWidth = 1.dp.toPx())
        }
        .padding(start = 24.dp)

@Composable
internal fun RenameListItemDialog(
    currentName: String,
    @StringRes titleRes: Int,
    @StringRes labelRes: Int,
    enabled: Boolean,
    dismiss: () -> Unit,
    save: (String) -> Unit,
    maxLength: Int = Int.MAX_VALUE,
    @StringRes confirmRes: Int = R.string.chat_rename_confirm,
) {
    var input by remember { mutableStateOf(TextFieldValue(currentName)) }
    val name = input.text.trim()
    val canSave = enabled && name.length in 1..maxLength && name != currentName.trim()
    val foreground = MaterialTheme.colorScheme.onSurface
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text(stringResource(titleRes)) },
        text = {
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(labelRes)) },
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
        confirmButton = { ChatAction(confirmRes, { save(name) }, enabled = canSave) },
        dismissButton = { ChatAction(R.string.chat_rename_cancel, dismiss) },
    )
}

@Composable
internal fun DeleteChatDialog(enabled: Boolean, dismiss: () -> Unit, confirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = dismiss,
        modifier = Modifier.padding(horizontal = 24.dp).widthIn(max = 360.dp).fillMaxWidth(),
        shape = RoundedCornerShape(28.dp),
        containerColor = MaterialTheme.colorScheme.surface,
        tonalElevation = 0.dp,
        properties = DialogProperties(usePlatformDefaultWidth = false),
        title = {
            Text(stringResource(R.string.chat_delete_title), fontWeight = FontWeight.SemiBold)
        },
        text = {
            Text(
                stringResource(R.string.chat_delete_description),
                Modifier.verticalScroll(rememberScrollState()),
            )
        },
        confirmButton = {
            TextButton(
                onClick = confirm,
                enabled = enabled,
                colors =
                    ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
            ) {
                Text(stringResource(R.string.chat_delete_confirm))
            }
        },
        dismissButton = { ChatAction(R.string.chat_rename_cancel, dismiss) },
    )
}

private fun projectRowKey(id: String) = "group_$id"

@Composable
private fun ProjectRow(
    name: String,
    modifier: Modifier,
    activity: ProjectActivity?,
    runningFrame: LongState,
    row: Int,
    toggle: () -> Unit,
    newChat: (() -> Unit)?,
    rename: () -> Unit,
    canRename: Boolean,
    renaming: Boolean,
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
                if (renaming) stringResource(R.string.chat_project_rename_pending) else null,
            )
            .joinToString()
    var menuOpen by remember { mutableStateOf(false) }
    val rowFocus = remember { FocusRequester() }
    var rowFocused by remember { mutableStateOf(false) }
    var restoreMenuFocus by remember { mutableStateOf(false) }
    val openMenu: (() -> Unit)? =
        if (newChat == null && !canRename) null
        else
            ({
                restoreMenuFocus = rowFocused
                menuOpen = true
            })
    LaunchedEffect(menuOpen) {
        if (!menuOpen && restoreMenuFocus) {
            restoreMenuFocus = false
            rowFocus.requestFocus()
        }
    }
    Box(modifier) {
        Row(
            Modifier.fillMaxWidth()
                .heightIn(min = ChatListRowHeight)
                .clip(ChatListRowShape)
                .contextMenuInput(openMenu)
                .focusRequester(rowFocus)
                .onFocusChanged { rowFocused = it.isFocused }
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
                .padding(ChatListRowPadding),
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
                    fontWeight =
                        if (status == ChatRowStatus.Unread) FontWeight.SemiBold
                        else FontWeight.Normal,
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
        if (menuOpen && openMenu != null) {
            val items = buildList {
                if (newChat != null)
                    add(
                        WorkspaceMenuItem(
                            stringResource(R.string.composer_new_project),
                            R.drawable.ic_edit_square,
                        ) {
                            restoreMenuFocus = false
                            menuOpen = false
                            newChat()
                        }
                    )
                add(
                    WorkspaceMenuItem(
                        stringResource(R.string.chat_rename_confirm),
                        R.drawable.ic_edit,
                        enabled = canRename,
                    ) {
                        restoreMenuFocus = false
                        menuOpen = false
                        rename()
                    }
                )
            }
            WorkspaceMenu(items, close = { menuOpen = false })
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
    var rowFocused by remember { mutableStateOf(false) }
    var restoreMenuFocus by remember { mutableStateOf(false) }
    LaunchedEffect(menuOpen) {
        if (!menuOpen && restoreMenuFocus) {
            restoreMenuFocus = false
            rowFocus.requestFocus()
        }
    }
    val openMenu: (() -> Unit)? =
        if (actions.isNotEmpty() && pendingAction == null) {
            {
                restoreMenuFocus = rowFocused
                menuOpen = true
            }
        } else null
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
                .heightIn(min = ChatListRowHeight)
                .clip(ChatListRowShape)
                .background(if (isSelected) colors.secondaryContainer else colors.background)
                .contextMenuInput(openMenu)
                .focusRequester(rowFocus)
                .onFocusChanged { rowFocused = it.isFocused }
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
                .padding(ChatListRowPadding),
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
                            if (action == ChatRowAction.Rename || action == ChatRowAction.Delete) {
                                restoreMenuFocus = false
                            }
                            menuOpen = false
                            performAction(action)
                        }
                    },
                close = { menuOpen = false },
            )
        }
    }
}

@Composable
internal fun chatListTitleStyle() =
    MaterialTheme.typography.bodyLarge.copy(
        fontSize = 16.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.sp,
    )

internal fun ChatRowAction.label(short: Boolean = false): Int =
    when (this) {
        ChatRowAction.MarkRead -> if (short) R.string.chat_swipe_read else R.string.chat_mark_read
        ChatRowAction.MarkUnread ->
            if (short) R.string.chat_swipe_unread else R.string.chat_mark_unread
        ChatRowAction.Mute -> R.string.chat_mute
        ChatRowAction.Unmute -> R.string.chat_unmute
        ChatRowAction.Archive -> if (short) R.string.chat_swipe_archive else R.string.chat_archive
        ChatRowAction.Unarchive ->
            if (short) R.string.chat_swipe_restore else R.string.chat_unarchive
        ChatRowAction.Delete -> R.string.chat_delete
        ChatRowAction.Rename -> R.string.chat_rename
        ChatRowAction.Pin -> R.string.chat_pin
        ChatRowAction.Unpin -> R.string.chat_unpin
        ChatRowAction.MovePinUp -> R.string.chat_move_pin_up
        ChatRowAction.MovePinDown -> R.string.chat_move_pin_down
    }

@DrawableRes
internal fun ChatRowAction.icon(): Int =
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
    @StringRes label: Int,
    @DrawableRes icon: Int? = null,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.heightIn(min = 48.dp),
        shape = RoundedCornerShape(12.dp),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
    ) {
        if (icon != null) {
            Icon(painterResource(icon), null, Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(
            stringResource(label),
            style =
                MaterialTheme.typography.labelMedium.copy(
                    fontSize = 13.sp,
                    lineHeight = 20.sp,
                    letterSpacing = 0.sp,
                    fontWeight = FontWeight(550),
                ),
        )
    }
}

@Composable
internal fun ChatContentLoadNotice(
    @StringRes message: Int,
    horizontalPadding: Dp = 12.dp,
    retry: (() -> Unit)? = null,
    retryEnabled: Boolean = true,
) {
    Column {
        Box(
            Modifier.heightIn(min = 48.dp).padding(horizontal = horizontalPadding),
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
        if (retry != null) ChatAction(R.string.retry, retry, enabled = retryEnabled)
    }
}

@Composable
private fun ProjectRenameRejectionNotice(modifier: Modifier = Modifier, dismiss: () -> Unit) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        ChatNotice(R.string.chat_project_rename_rejected, Modifier.weight(1f))
        IconButton(onClick = dismiss) {
            Icon(
                painterResource(R.drawable.ic_close),
                stringResource(R.string.chat_feedback_dismiss),
            )
        }
    }
}

@Composable
private fun ChatNotice(message: Int, modifier: Modifier = Modifier) {
    Text(
        stringResource(message),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.semantics { liveRegion = LiveRegionMode.Polite },
    )
}

internal fun ChatListFilter.label() =
    when (this) {
        ChatListFilter.Inbox -> R.string.chat_inbox
        ChatListFilter.Unread -> R.string.chat_unread
        ChatListFilter.Archived -> R.string.chat_archived
        ChatListFilter.Muted -> R.string.chat_muted
    }
