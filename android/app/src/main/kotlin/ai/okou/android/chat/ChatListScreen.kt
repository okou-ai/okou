package ai.okou.android.chat

import ai.okou.android.ContentReadFailure
import ai.okou.android.ContentReadFailureLayout
import ai.okou.android.DirectoryReturnFocus
import ai.okou.android.OkouConfirmationDialog
import ai.okou.android.R
import ai.okou.android.WithButtonFocusOutline
import ai.okou.android.WorkspaceMenu
import ai.okou.android.WorkspaceMenuItem
import ai.okou.android.api.generated.IndicatorsThreadsValue
import ai.okou.android.currentWindowSizeDp
import ai.okou.android.rememberContentReadSkeleton
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.ListItemShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.LongState
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.structuralEqualityPolicy
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
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
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.text.NumberFormat

private const val ProjectMotionMillis = 250
private val ChatListLeadingIconSize = 18.dp
private val ChatListLeadingIconGap = 8.dp
private val ChatListRowFocusInset = 3.dp
internal val ChatListMotionEasing = CubicBezierEasing(0.2f, 0f, 0f, 1f)
private val projectPlacement = tween<IntOffset>(ProjectMotionMillis, easing = ChatListMotionEasing)
private val projectChildFade = tween<Float>(ProjectMotionMillis, easing = ChatListMotionEasing)
private val immediatePlacement = snap<IntOffset>()

@Composable
private fun chatRowShapes(): ListItemShapes {
    val active = MaterialTheme.shapes.extraLarge
    return ListItemDefaults.shapes(
        selectedShape = active,
        pressedShape = active,
        focusedShape = active,
    )
}

@Composable
internal fun ChatListScreen(
    state: ChatListUiState,
    composer: State<ComposerState>?,
    open: (ConfirmedChat) -> Unit,
    provisionalChats: List<ProvisionalChat>,
    openProvisional: (ProvisionalChat) -> Unit,
    performRowAction: (String, ChatRowAction) -> Unit,
    requestMove: (String) -> Unit,
    moveFocus: ProjectMoveFocus?,
    onMoveFocusFinished: (ProjectMoveFocus) -> Unit,
    renameThread: (String, Boolean) -> Unit,
    renameProject: (String, Boolean) -> Unit,
    renamingProjectId: String?,
    renameFocus: WorkspaceRenameTarget?,
    onRenameFocusFinished: (WorkspaceRenameTarget) -> Unit,
    requestDeleteProject: (String) -> Unit,
    confirmingProjectDelete: String?,
    projectExpansion: ProjectExpansionModel?,
    listState: LazyListState,
    undoReturnFocus: DirectoryReturnFocus,
    newChat: (String?) -> Unit,
    showInbox: () -> Unit,
    selectedChatId: String?,
    wide: Boolean,
    newChatEnabled: Boolean,
    chatActionsEnabled: Boolean,
    startupSyncPending: Boolean,
    startupRecovery: @Composable (() -> Unit)?,
    dismissProjectRenameRejection: (ProjectRenameRejection) -> Unit,
    feedback: @Composable () -> Unit,
) {
    val draftIds by
        remember(composer, state.draftThreadIds) {
            derivedStateOf(structuralEqualityPolicy()) {
                draftThreadIdsForList(
                    state.draftThreadIds,
                    composer?.value?.journal?.drafts.orEmpty(),
                )
            }
        }
    val canRenameProject = chatActionsEnabled && state.canRenameProject
    var deletingId by remember { mutableStateOf<String?>(null) }
    deletingId?.let { id ->
        val thread = state.threads.firstOrNull { it.id == id && it.hidden != true }
        if (thread != null) {
            DeleteChatDialog(
                chatName = thread.title,
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
    val unreadAt = state.displayUnreadAt
    val pendingByProject =
        remember(state.threads, state.filter, provisionalChats) {
            if (state.filter != ChatListFilter.Inbox || provisionalChats.isEmpty()) emptyMap()
            else {
                val confirmedIds = state.threads.mapTo(hashSetOf()) { it.id }
                provisionalChats.filterNot { it.threadId in confirmedIds }.groupBy { it.projectId }
            }
        }
    val indicators = state.indicators?.threads.orEmpty()
    val unreadChatIds = remember(unreadAt, state.readIntents) { state.unreadChatIds() }
    val groups =
        rememberChatListGroups(
            state.threads,
            state.projects,
            state.filter,
            unreadChatIds,
            pendingByProject.keys,
        )
    val knownProjects = remember(state.projects) { state.projects.mapTo(hashSetOf()) { it.id } }
    val renameRejection =
        state.projectRenameRejection?.takeUnless { it.projectId == renamingProjectId }
    val unconfirmedRenames =
        if (renamingProjectId == null) state.unconfirmedProjectRenames
        else state.unconfirmedProjectRenames - renamingProjectId
    val projectNoticeIds =
        unconfirmedRenames +
            listOfNotNull(
                renameRejection?.projectId,
                state.projectList.deletingId?.takeUnless { it == confirmingProjectDelete },
            ) +
            state.projectList.deleteFeedback.mapNotNull {
                it.projectId.takeIf { id -> !it.rejected && id != confirmingProjectDelete }
            }
    val expansion = projectExpansion?.state?.collectAsStateWithLifecycle()?.value
    val savedExpansion = expansion?.expandedIds
    val expandedProjectIds = savedExpansion.orEmpty()
    val previousExpansion =
        remember(listState, projectExpansion) { ChatListProjectIds(savedExpansion) }
    val precedingIds = previousExpansion.ids
    val createdProject = (renameFocus as? WorkspaceRenameTarget.Project)?.takeIf { it.newlyCreated }
    val expansionChanged =
        savedExpansion != null &&
            (precedingIds != null || expansion.hasLocalChoices) &&
            precedingIds.orEmpty() != savedExpansion &&
            (createdProject == null || precedingIds.orEmpty() != savedExpansion - createdProject.id)
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
    val hasConfirmedChatList = state.confirmedAt != null
    val sections =
        remember(groups, expandedProjectIds, pendingByProject, hasConfirmedChatList) {
            chatListSections(
                groups,
                expandedProjectIds,
                pendingByProject,
                hasConfirmedChatList = hasConfirmedChatList,
            )
        }
    val collapsedActivity =
        remember(sections, indicators, unreadChatIds) {
            buildMap {
                for (section in sections) {
                    if (section.collapsed) {
                        val group = section.group
                        put(
                            checkNotNull(group.project).id,
                            collapsedProjectActivity(group.threads, indicators, unreadChatIds),
                        )
                    }
                }
            }
        }
    val moveFocusSection = moveFocus?.let { request ->
        sections.firstOrNull { section ->
            section.group.projectId == request.projectId &&
                section.group.threads.any { it.id == request.threadId }
        }
    }
    val renameFocusKey =
        when (renameFocus) {
            is WorkspaceRenameTarget.Chat ->
                renameFocus.id.takeUnless { renameFocus.fromConversation }
            is WorkspaceRenameTarget.Project -> projectRowKey(renameFocus.id)
            null -> null
        }
    val runningKeys =
        remember(indicators, sections, collapsedActivity) {
            buildSet {
                for (section in sections) {
                    if (section.collapsed) {
                        val projectId = checkNotNull(section.group.project).id
                        if (collapsedActivity[projectId]?.status == ChatRowStatus.Running) {
                            add(projectRowKey(projectId))
                        }
                    } else {
                        for (thread in section.group.threads) {
                            if (
                                thread.muted != true &&
                                    indicators[thread.id] == IndicatorsThreadsValue.ACTIVE
                            ) {
                                add(thread.id)
                            }
                        }
                    }
                }
            }
        }
    val runningFrame = rememberRunningWaveFrame(listState, runningKeys)
    val metadataUsable = state.projectsSource != null
    val listLabel = stringResource(R.string.chat_list_title)
    val widthDp = currentWindowSizeDp().width
    val largeCompact = widthDp >= 600
    val listInset = if (wide) 12.dp else if (largeCompact) 24.dp else 16.dp
    val outline = MaterialTheme.colorScheme.outlineVariant
    val missingUnread = state.confirmedAt != null && state.waitingForUnreadIndicators
    val needsInboxProjects =
        state.hasUsableList && state.needsProjectsToConfirmEmptyInbox(provisionalChats)
    val firstLoadFailed =
        when {
            needsInboxProjects -> state.projectsPhase == ChatReadPhase.Failed
            state.hasUsableList -> false
            missingUnread -> state.indicatorsNonRetryableFailure
            else -> state.listReadFailure == ChatListReadFailure.NeedsRetry
        }
    val hasUsableList = state.hasUsableList && !needsInboxProjects
    val skeletonVisible =
        rememberContentReadSkeleton(
            hasContent = hasUsableList || pendingByProject.isNotEmpty(),
            awaitingRead =
                !firstLoadFailed &&
                    (startupRecovery == null || state.listPhase != ChatReadPhase.Idle),
        )
    val unreadFilter = state.filter == ChatListFilter.Unread
    val startupSyncVisible =
        remember(startupSyncPending, state.confirmedAt) {
            startupSyncPending &&
                state.confirmedAt?.let {
                    chatSyncNoticeDelayMillis(it, System.currentTimeMillis()) == 0L
                } == true
        }
    val syncVisible =
        hasUsableList &&
            (state.listRefreshProgressVisible ||
                unreadFilter && state.indicatorsRefreshProgressVisible ||
                startupSyncVisible)
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
        syncing = syncVisible,
        filter = state.filter,
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
                else if (state.filter == ChatListFilter.Inbox) {
                    // Keep the top inset keyed so a new notice is visible from the top.
                    row("list_top_inset") { Spacer(Modifier.height(4.dp)) }
                }
                if (startupRecovery != null) row("workspace_recovery", startupRecovery)
                if (state.filter != ChatListFilter.Inbox) {
                    row("filter_heading") {
                        Text(
                            stringResource(state.filter.label()),
                            Modifier.padding(start = 16.dp, top = 8.dp, end = 16.dp, bottom = 4.dp)
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
                if (!hasUsableList && skeletonVisible) {
                    row("list_first_read") { ChatListSkeleton() }
                }
                if (state.cacheUnavailable || state.projectCacheUnavailable)
                    row("list_cache_unavailable") { ChatNotice(R.string.chat_cache_unavailable) }
            }
        KeepChatListProjectAnchor(listState, knownProjects) { key, offset ->
            sections.findScrollAnchor(key, offset, leadingItems.size, projectNoticeIds)
        }
        if (moveFocus != null) {
            val pending = state.pendingRowActions[moveFocus.threadId] == ChatRowAction.MoveProject
            LaunchedEffect(moveFocus, moveFocusSection, pending, leadingItems.size) {
                if (moveFocusSection?.collapsed == true) {
                    val key = projectRowKey(moveFocus.projectId)
                    if (listState.layoutInfo.visibleItemsInfo.none { it.key == key }) {
                        sections
                            .findScrollAnchor(key, 0, leadingItems.size, projectNoticeIds)
                            ?.let { listState.requestScrollToItem(it.index) }
                    }
                } else if (moveFocusSection != null || !pending) {
                    onMoveFocusFinished(moveFocus)
                }
            }
        }
        if (renameFocus != null && renameFocusKey != null) {
            LaunchedEffect(renameFocus, sections, leadingItems.size, projectNoticeIds) {
                val anchor =
                    sections.findScrollAnchor(
                        renameFocusKey,
                        0,
                        leadingItems.size,
                        projectNoticeIds,
                        allowCollapsedChat = false,
                    )
                if (anchor == null) onRenameFocusFinished(renameFocus)
                else {
                    val layout = listState.layoutInfo
                    val row = layout.visibleItemsInfo.firstOrNull { it.key == renameFocusKey }
                    if (
                        row == null ||
                            (createdProject != null &&
                                (row.offset < layout.viewportStartOffset ||
                                    row.offset + row.size > layout.viewportEndOffset))
                    )
                        listState.requestScrollToItem(anchor.index)
                }
            }
        }
        val fillFailureViewport =
            firstLoadFailed &&
                pendingByProject.isEmpty() &&
                groups.none { it.project != null || it.threads.isNotEmpty() }
        val undoRowFocus = remember { FocusRequester() }
        val listFocus = remember { FocusRequester() }
        var listFocused by remember { mutableStateOf(false) }
        val undoFocus = undoReturnFocus.pending
        val inputMode = LocalInputModeManager.current
        val restoreUndoFocus =
            if (undoFocus == null) Modifier
            else
                Modifier.onGloballyPositioned {
                    if (undoReturnFocus.isCurrent(undoFocus, inputMode.inputMode)) {
                        val visible =
                            chatActionsEnabled &&
                                listState.layoutInfo.visibleItemsInfo.any {
                                    it.key == undoFocus.rowKey
                                }
                        if (!visible || !undoRowFocus.requestFocus()) listFocus.requestFocus()
                    }
                    undoReturnFocus.finish(undoFocus)
                }
        LazyColumn(
            Modifier.widthIn(max = 720.dp)
                .fillMaxSize()
                .focusProperties { canFocus = undoReturnFocus.pending != null || listFocused }
                .focusRequester(listFocus)
                .onFocusChanged { listFocused = it.isFocused }
                .focusable()
                .then(restoreUndoFocus)
                .testTag("chat_list")
                .semantics { contentDescription = listLabel },
            contentPadding =
                PaddingValues(
                    start = listInset,
                    end = listInset,
                    bottom = bottomSpace,
                ),
            state = listState,
        ) {
            if (fillFailureViewport) {
                item(key = "list_first_read") {
                    Column(Modifier.fillParentMaxHeight().fillMaxWidth()) {
                        leadingItems.forEach { (key, content) -> key(key) { content() } }
                        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                            ContentReadFailure(
                                R.string.chat_list_first_load_failed,
                                Modifier.fillMaxWidth()
                                    .verticalScroll(rememberScrollState())
                                    .heightIn(min = maxHeight)
                                    .testTag("chat_list_first_read_status"),
                            )
                        }
                    }
                }
            } else {
                items(leadingItems.size, key = { leadingItems[it].first }) {
                    leadingItems[it].second()
                }
                if (firstLoadFailed) {
                    item(key = "list_first_read") {
                        ContentReadFailure(
                            R.string.chat_list_first_load_failed,
                            Modifier.fillMaxWidth().testTag("chat_list_first_read_status"),
                            failureLayout = ContentReadFailureLayout.Section,
                        )
                    }
                }
            }
            if (
                state.confirmedAt != null ||
                    pendingByProject.isNotEmpty() ||
                    state.projects.isNotEmpty()
            ) {
                sections.forEach { section ->
                    val group = section.group
                    val project = group.project
                    val pending = section.provisionalChats
                    if (project != null) {
                        val deleting = state.projectList.isDeleting(project.id)
                        item(key = projectRowKey(project.id)) {
                            ProjectRow(
                                project.name,
                                modifier = Modifier.animateItem(null, placement, null),
                                activity = collapsedActivity[project.id],
                                runningFrame = runningFrame,
                                row = section.firstRow,
                                toggle = { projectExpansion?.toggle(project.id) },
                                newChat = if (newChatEnabled) ({ newChat(project.id) }) else null,
                                rename = { restore -> renameProject(project.id, restore) },
                                canRename = canRenameProject && !deleting,
                                renaming = state.renamingProjectId == project.id,
                                delete = { requestDeleteProject(project.id) },
                                canDelete =
                                    chatActionsEnabled && state.canDeleteProject && !deleting,
                                deleteDialogOpen = confirmingProjectDelete == project.id,
                                renameFocus =
                                    (renameFocus as? WorkspaceRenameTarget.Project)?.takeIf {
                                        it.id == project.id
                                    },
                                onRenameFocusFinished = onRenameFocusFinished,
                                focusAfterMove =
                                    moveFocus?.takeIf {
                                        section === moveFocusSection && section.collapsed
                                    },
                                onMoveFocusFinished = onMoveFocusFinished,
                            )
                        }
                        if (deleting && project.id != confirmingProjectDelete) {
                            item(key = "project_deleting_${project.id}") {
                                ChatNotice(
                                    R.string.chat_project_delete_pending,
                                    Modifier.animateItem(null, placement, null)
                                        .projectChildIndent(outline),
                                )
                            }
                        } else if (
                            renameRejection != null && renameRejection.projectId == project.id
                        ) {
                            item(key = "project_rename_${project.id}") {
                                ProjectRenameRejectionNotice(
                                    Modifier.animateItem(null, placement, null)
                                        .projectChildIndent(outline),
                                ) {
                                    dismissProjectRenameRejection(renameRejection)
                                }
                            }
                        } else if (project.id in unconfirmedRenames) {
                            item(key = "project_rename_${project.id}") {
                                ChatNotice(
                                    if (project.id in state.projectList.connectionFailedRenames)
                                        R.string.chat_action_connection_failed
                                    else R.string.chat_project_rename_unconfirmed,
                                    Modifier.animateItem(null, placement, null)
                                        .projectChildIndent(outline),
                                )
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
                                        .projectChildIndent(outline),
                                ) {
                                    if (!newChatEnabled) {
                                        ChatNotice(R.string.chat_project_empty)
                                    }
                                    WithButtonFocusOutline(MaterialTheme.colorScheme.onSurface) {
                                        ChatListTextAction(
                                            R.string.composer_new_project,
                                            icon = R.drawable.ic_add,
                                            enabled = newChatEnabled,
                                            colors = ButtonDefaults.textButtonColors(),
                                        ) {
                                            newChat(project.id)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if (!section.collapsed) {
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
                                else rowModifier.projectChildIndent(outline),
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
                                    hasDraft = thread != null && id in draftIds,
                                    isSelected = id == selectedChatId,
                                    runningFrame = runningFrame,
                                    row = section.firstChatRow + index,
                                    actions =
                                        thread
                                            ?.takeIf { chatActionsEnabled }
                                            ?.let { state.rowActions(it, group, threadIndex) }
                                            .orEmpty(),
                                    pendingAction = state.pendingRowActions[id],
                                    enabled = chatActionsEnabled,
                                    deleteDialogOpen = deletingId == id,
                                    undoFocus = undoRowFocus.takeIf { id == undoFocus?.rowKey },
                                    rename = { restore -> renameThread(id, restore) },
                                    renameFocus =
                                        (renameFocus as? WorkspaceRenameTarget.Chat)?.takeIf {
                                            !it.fromConversation && it.id == id
                                        },
                                    onRenameFocusFinished = onRenameFocusFinished,
                                    moveLabel = {
                                        projectMoveLabel(
                                            thread?.let {
                                                state.projectDestinations(it).singleOrNull()
                                            },
                                        )
                                    },
                                    performAction = { action ->
                                        when (action) {
                                            ChatRowAction.Delete -> deletingId = id
                                            ChatRowAction.MoveProject -> requestMove(id)
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
                    hasConfirmedChatList &&
                        groups.all { it.project == null && it.threads.isEmpty() } &&
                        pendingByProject.isEmpty() &&
                        (state.filter != ChatListFilter.Inbox || metadataUsable) &&
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
            WithButtonFocusOutline(MaterialTheme.colorScheme.onSurface) {
                ChatListTextAction(
                    R.string.chat_back_to_inbox,
                    colors = ButtonDefaults.textButtonColors(),
                    onClick = showInbox,
                )
            }
        }
    }
}

private data class ChatListScrollAnchor(val index: Int, val offset: Int)

private class ChatListProjectIds(var ids: Set<String>?)

@Composable
internal fun rememberChatListGroups(
    threads: List<ConfirmedChat>,
    projects: List<ConfirmedProject>,
    filter: ChatListFilter,
    unreadChatIds: Set<String>,
    provisionalProjectIds: Set<String?>,
): List<ChatListGroup> {
    val unreadMembership = if (filter == ChatListFilter.Unread) unreadChatIds else emptySet()
    return remember(threads, projects, filter, unreadMembership, provisionalProjectIds) {
        chatListGroups(threads, projects, filter, unreadMembership, provisionalProjectIds)
    }
}

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
    projectNoticeIds: Set<String>,
    allowCollapsedChat: Boolean = true,
): ChatListScrollAnchor? {
    var row = leadingItemCount
    for (section in this) {
        val project = section.group.project
        val header = row
        if (project != null) {
            if (key == projectRowKey(project.id)) return ChatListScrollAnchor(row, offset)
            row += if (project.id in projectNoticeIds) 2 else 1
        }
        val threads = section.group.threads
        val pending = section.provisionalChats
        val threadIndex = threads.indexOfFirst { it.id == key }
        val pendingIndex = pending.indexOfFirst { it.threadId == key }
        if (threadIndex >= 0 || pendingIndex >= 0) {
            if (section.collapsed)
                return ChatListScrollAnchor(header, 0).takeIf { allowCollapsedChat }
            val firstPending = section.pinTail + 1
            val chatIndex =
                when {
                    pendingIndex >= 0 -> firstPending + pendingIndex
                    threadIndex >= firstPending -> threadIndex + pending.size
                    else -> threadIndex
                }
            return ChatListScrollAnchor(row + chatIndex, offset)
        }
        if (!section.collapsed) {
            row += if (section.showsEmptyProjectAction) 1 else threads.size + pending.size
        }
    }
    return null
}

private fun Modifier.projectChildIndent(color: Color): Modifier = drawBehind {
    val inset = 20.5.dp.toPx()
    val x = if (layoutDirection == LayoutDirection.Ltr) inset else size.width - inset
    drawLine(color, Offset(x, 0f), Offset(x, size.height), strokeWidth = 1.dp.toPx())
}
    .padding(start = 24.dp)

@Composable
internal fun DeleteChatDialog(
    chatName: String?,
    enabled: Boolean,
    dismiss: () -> Unit,
    confirm: () -> Unit,
) {
    OkouConfirmationDialog(
        title = stringResource(R.string.chat_delete_title),
        confirm = stringResource(R.string.chat_delete),
        onDismiss = dismiss,
        onConfirm = confirm,
        confirmEnabled = enabled,
        destructive = true,
    ) {
        Text(
            stringResource(
                R.string.chat_delete_description,
                chatName?.takeIf { it.isNotBlank() } ?: stringResource(R.string.chat_untitled),
            ),
        )
    }
}

@Composable
internal fun DeleteProjectDialog(
    projectName: String,
    pending: Boolean,
    status: ProjectDeleteStatus?,
    enabled: Boolean,
    dismiss: () -> Unit,
    confirm: () -> Unit,
) {
    val noticeRes =
        if (pending) null
        else
            when (status) {
                ProjectDeleteStatus.Rejected -> R.string.chat_project_delete_rejected
                ProjectDeleteStatus.ConnectionFailed -> R.string.chat_action_connection_failed
                ProjectDeleteStatus.Confirmed,
                null -> null
            }
    OkouConfirmationDialog(
        title = stringResource(R.string.chat_project_delete_title),
        confirm = stringResource(R.string.chat_project_delete),
        onDismiss = dismiss,
        onConfirm = confirm,
        confirmEnabled = enabled,
        destructive = true,
        pendingConfirmLabel = stringResource(R.string.chat_delete_pending),
        confirmPending = pending,
        actionStatus = {
            Box(Modifier.fillMaxWidth()) {
                val style = MaterialTheme.typography.bodyMedium
                for (message in
                    listOf(
                        R.string.chat_project_delete_rejected,
                        R.string.chat_action_connection_failed,
                    )) {
                    if (message != noticeRes) {
                        Text(
                            stringResource(message),
                            Modifier.clearAndSetSemantics {}.alpha(0f),
                            style = style,
                        )
                    }
                }
                if (noticeRes != null) {
                    Text(
                        stringResource(noticeRes),
                        Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                        color = MaterialTheme.colorScheme.error,
                        style = style,
                    )
                }
            }
        },
    ) {
        Text(stringResource(R.string.chat_project_delete_description, projectName))
    }
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
    rename: (Boolean) -> Unit,
    canRename: Boolean,
    renaming: Boolean,
    delete: () -> Unit,
    canDelete: Boolean,
    deleteDialogOpen: Boolean,
    renameFocus: WorkspaceRenameTarget?,
    onRenameFocusFinished: (WorkspaceRenameTarget) -> Unit,
    focusAfterMove: ProjectMoveFocus?,
    onMoveFocusFinished: (ProjectMoveFocus) -> Unit,
) {
    val collapsed = activity != null
    val status = activity?.status ?: ChatRowStatus.None
    val colors = MaterialTheme.colorScheme
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
    if (focusAfterMove != null) {
        LaunchedEffect(focusAfterMove) {
            rowFocus.requestFocus()
            onMoveFocusFinished(focusAfterMove)
        }
    }
    if (renameFocus != null) RestoreRenameOriginFocus(renameFocus, rowFocus, onRenameFocusFinished)
    var rowFocused by remember { mutableStateOf(false) }
    var restoreMenuFocus by remember { mutableStateOf(false) }
    val openMenu: (() -> Unit)? =
        if (newChat == null && !canRename && !canDelete) null
        else
            ({
                restoreMenuFocus = rowFocused
                menuOpen = true
            })
    LaunchedEffect(menuOpen, deleteDialogOpen) {
        if (!menuOpen && !deleteDialogOpen && restoreMenuFocus) {
            restoreMenuFocus = false
            rowFocus.requestFocus()
        }
    }
    val shapes = chatRowShapes()
    Box(modifier) {
        WithButtonFocusOutline(colors.onSurface, inset = ChatListRowFocusInset) {
            ListItem(
                onClick = toggle,
                onLongClick = openMenu,
                onLongClickLabel = stringResource(R.string.chat_more_actions),
                shapes = shapes,
                modifier =
                    Modifier.fillMaxWidth()
                        .contextMenuInput(openMenu)
                        .focusRequester(rowFocus)
                        .focusProperties { canFocus = true }
                        .onFocusChanged { rowFocused = it.isFocused }
                        .semantics {
                            role = Role.Button
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
                        },
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        painterResource(
                            if (collapsed) R.drawable.ic_folder else R.drawable.ic_folder_open,
                        ),
                        contentDescription = null,
                        tint = colors.onSurfaceVariant,
                        modifier = Modifier.size(ChatListLeadingIconSize),
                    )
                    Spacer(Modifier.width(ChatListLeadingIconGap))
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
                            fontWeight =
                                if (status == ChatRowStatus.Unread) FontWeight.SemiBold
                                else FontWeight.Normal,
                        )
                        Icon(
                            painterResource(
                                if (collapsed) R.drawable.ic_chevron_right
                                else R.drawable.ic_expand_more,
                            ),
                            contentDescription = null,
                            tint = colors.onSurfaceVariant,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                    ChatStatusGlyph(status, runningFrame, row)
                }
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
                        },
                    )
                add(
                    WorkspaceMenuItem(
                        stringResource(R.string.chat_rename_confirm),
                        R.drawable.ic_edit,
                        enabled = canRename,
                    ) {
                        menuOpen = false
                        rename(restoreMenuFocus)
                        restoreMenuFocus = false
                    },
                )
                add(
                    WorkspaceMenuItem(
                        stringResource(R.string.chat_project_delete),
                        R.drawable.ic_delete,
                        enabled = canDelete,
                        destructive = true,
                    ) {
                        menuOpen = false
                        delete()
                    },
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
    hasDraft: Boolean,
    isSelected: Boolean,
    runningFrame: LongState,
    row: Int,
    actions: List<ChatRowAction>,
    pendingAction: ChatRowAction?,
    enabled: Boolean,
    deleteDialogOpen: Boolean,
    undoFocus: FocusRequester?,
    rename: (Boolean) -> Unit,
    renameFocus: WorkspaceRenameTarget?,
    onRenameFocusFinished: (WorkspaceRenameTarget) -> Unit,
    moveLabel: @Composable () -> String,
    performAction: (ChatRowAction) -> Unit,
    open: () -> Unit,
) {
    var menuOpen by remember(actions) { mutableStateOf(false) }
    val localFocus = remember { FocusRequester() }
    val rowFocus = undoFocus ?: localFocus
    if (renameFocus != null) RestoreRenameOriginFocus(renameFocus, rowFocus, onRenameFocusFinished)
    var rowFocused by remember { mutableStateOf(false) }
    var restoreMenuFocus by remember { mutableStateOf(false) }
    LaunchedEffect(menuOpen, deleteDialogOpen) {
        if (!menuOpen && !deleteDialogOpen && restoreMenuFocus) {
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
            if (hasDraft) stringResource(R.string.chat_has_draft) else null,
            if (pinned) stringResource(R.string.chat_pinned) else null,
            pendingAction?.let {
                stringResource(
                    if (it.updatesChat) R.string.chat_row_action_pending
                    else R.string.chat_read_action_pending,
                )
            },
        )
    val colors = MaterialTheme.colorScheme
    val readAction = actions.firstOrNull {
        it == ChatRowAction.MarkRead || it == ChatRowAction.MarkUnread
    }
    val archiveAction = actions.firstOrNull {
        it == ChatRowAction.Archive || it == ChatRowAction.Unarchive
    }
    val shapes = chatRowShapes()
    val itemColors = ListItemDefaults.colors()
    val foreground = if (isSelected) itemColors.selectedContentColor else itemColors.contentColor
    ChatRowSwipe(
        readAction = readAction.takeIf { openMenu != null },
        archiveAction = archiveAction.takeIf { openMenu != null },
        performAction = performAction,
    ) { swipeModifier ->
        WithButtonFocusOutline(foreground, inset = ChatListRowFocusInset) {
            ListItem(
                selected = isSelected,
                onClick = open,
                enabled = enabled,
                onLongClick = openMenu,
                onLongClickLabel = stringResource(R.string.chat_actions),
                shapes = shapes,
                colors = itemColors,
                modifier =
                    swipeModifier
                        .fillMaxWidth()
                        .contextMenuInput(openMenu)
                        .focusRequester(rowFocus)
                        .onFocusChanged { rowFocused = it.isFocused }
                        .testTag("chat_$threadId")
                        .semantics {
                            // A selected chat can still be opened from the list.
                            role = Role.Button
                            if (labels.isNotEmpty()) stateDescription = labels.joinToString()
                        },
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (hasDraft) {
                        Icon(
                            painterResource(R.drawable.ic_edit_note),
                            contentDescription = null,
                            tint = colors.onSurfaceVariant,
                            modifier =
                                Modifier.size(ChatListLeadingIconSize).testTag("chat_draft_icon"),
                        )
                        Spacer(Modifier.width(ChatListLeadingIconGap))
                    }
                    Text(
                        title?.takeIf { it.isNotBlank() } ?: stringResource(R.string.chat_untitled),
                        Modifier.weight(1f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        fontWeight =
                            if (status == ChatRowStatus.Unread) FontWeight.SemiBold else null,
                    )
                    ChatStatusGlyph(status, runningFrame, row)
                }
            }
        }
        if (menuOpen && pendingAction == null) {
            WorkspaceMenu(
                items =
                    actions.map { action ->
                        WorkspaceMenuItem(
                            if (action == ChatRowAction.MoveProject) moveLabel()
                            else stringResource(action.label()),
                            action.icon(),
                            destructive = action == ChatRowAction.Delete,
                        ) {
                            menuOpen = false
                            if (action == ChatRowAction.Rename) {
                                rename(restoreMenuFocus)
                                restoreMenuFocus = false
                            } else performAction(action)
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
        ChatRowAction.MoveProject -> R.string.chat_move_project
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
        ChatRowAction.MoveProject -> R.drawable.ic_folder_open
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
    val color = MaterialTheme.colorScheme.primary
    Box(Modifier.padding(start = 8.dp).size(16.dp), contentAlignment = Alignment.Center) {
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
        colors =
            ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
    ) {
        Text(stringResource(label))
    }
}

@Composable
internal fun ChatListTextAction(
    @StringRes label: Int,
    modifier: Modifier = Modifier,
    @DrawableRes icon: Int? = null,
    enabled: Boolean = true,
    colors: ButtonColors =
        ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
    onClick: () -> Unit,
) {
    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.heightIn(min = 48.dp),
        shape = RoundedCornerShape(12.dp),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        colors = colors,
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
internal fun ContentReadFeedback(@StringRes message: Int, modifier: Modifier = Modifier) {
    Text(
        stringResource(message),
        modifier = modifier.semantics { liveRegion = LiveRegionMode.Polite },
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style =
            MaterialTheme.typography.bodyMedium.copy(
                fontSize = 14.sp,
                lineHeight = 20.sp,
                letterSpacing = 0.sp,
            ),
    )
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
