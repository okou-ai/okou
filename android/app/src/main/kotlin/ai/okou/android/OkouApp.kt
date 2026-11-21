package ai.okou.android

import ai.okou.android.chat.AssistantRecoveryModel
import ai.okou.android.chat.AssistantRecoveryPanel
import ai.okou.android.chat.ChatComposerField
import ai.okou.android.chat.ChatComposerModel
import ai.okou.android.chat.ChatListFilter
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ChatListReadFailure
import ai.okou.android.chat.ChatListScreen
import ai.okou.android.chat.ChatListUiState
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.ChatRowAction
import ai.okou.android.chat.ChatTitleSearch
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.chat.ConfirmedChat
import ai.okou.android.chat.ConversationRoute
import ai.okou.android.chat.ConversationStatus
import ai.okou.android.chat.ConversationToolbarActions
import ai.okou.android.chat.NewConversationWelcome
import ai.okou.android.chat.ProjectExpansionModel
import ai.okou.android.chat.ProvisionalChat
import ai.okou.android.chat.RealtimeNotice
import ai.okou.android.chat.RunControlsModel
import ai.okou.android.chat.conversationRunControls
import ai.okou.android.state.SearchRoute
import ai.okou.android.state.SettingsDestination
import ai.okou.android.state.WorkspaceTarget
import ai.okou.android.state.rememberChatSearchState
import ai.okou.android.state.rememberConversationUiState
import ai.okou.android.state.rememberWorkspaceNavigation
import ai.okou.android.updates.UpdateToolbarAction
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.structuralEqualityPolicy
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun OkouApp(
    chats: ChatListModel?,
    composer: ChatComposerModel?,
    controls: RunControlsModel?,
    projectExpansion: ProjectExpansionModel?,
    settingsContent:
        @Composable
        (SettingsDestination, openInstructions: () -> Unit, closeInstructions: () -> Unit) -> Unit,
    recovery: AssistantRecoveryModel? = null,
    workspaceAvatar: @Composable (() -> Unit)? = null,
    workspaceName: String? = null,
    updateToolbarAction: UpdateToolbarAction? = null,
    onUpdateEditingChanged: (Boolean) -> Unit = {},
    startupRecovery: @Composable (() -> Unit)? = null,
    workspaceReady: Boolean = composer != null,
) {
    val list =
        chats?.uiState?.collectAsStateWithLifecycle()?.value
            ?: ChatListUiState(
                listPhase =
                    if (startupRecovery == null) ChatReadPhase.Loading else ChatReadPhase.Idle
            )
    var navigation by rememberWorkspaceNavigation()
    val composerInput = composer?.uiState?.collectAsStateWithLifecycle()
    val settings = navigation.settings.takeIf { workspaceReady }
    val requestedTarget = navigation.target
    val restoringFirstSend =
        !workspaceReady &&
            requestedTarget is WorkspaceTarget.NewChat &&
            composerInput
                ?.value
                ?.entry(ComposerTarget(projectId = requestedTarget.projectId))
                ?.let { it.pending != null || it.createdThreadId != null } == true
    // Let protected destinations wait for preparation without blocking authorized chat navigation.
    val target =
        if (
            chats == null ||
                (!workspaceReady &&
                    (navigation.settings != null ||
                        requestedTarget is WorkspaceTarget.NewChat && !restoringFirstSend))
        )
            WorkspaceTarget.List
        else requestedTarget
    // Window configuration changes on resize. IME insets only change the space inside the panes.
    val window = currentWindowSizeDp()
    val listWidth = workspaceListPaneWidth(window.width, window.height)
    val searchState = rememberChatSearchState()
    var focusSearch by remember { mutableStateOf(false) }
    val searchActive = chats != null && navigation.search == SearchRoute.Open
    var composerFocused by remember(target, settings, searchActive) { mutableStateOf(false) }
    val editing =
        searchActive ||
            settings == SettingsDestination.Instructions ||
            (settings == null && (target is WorkspaceTarget.NewChat || composerFocused))
    DisposableEffect(editing) {
        onUpdateEditingChanged(editing)
        onDispose { onUpdateEditingChanged(false) }
    }
    val showList = listWidth != null || searchActive || target == WorkspaceTarget.List
    val showChatList = settings == null && showList && !searchActive
    val showWorkspaceBack = listWidth == null && !searchActive && target != WorkspaceTarget.List
    val listPositions =
        ChatListFilter.entries.map { filter -> key(filter) { rememberLazyListState() } }
    val settingsPosition = rememberScrollState()
    val conversations = rememberConversationUiState()
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val missingChat = stringResource(R.string.history_missing)
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val settingsFocus = remember { FocusRequester() }
    val searchEntryFocus = remember { FocusRequester() }
    var searchEntryFocused by remember { mutableStateOf(false) }
    var restoreSearchFocus by remember { mutableStateOf(false) }
    var restoreSettingsFocus by remember { mutableStateOf(false) }

    fun releaseSearchFocus() {
        focus.clearFocus()
        keyboard?.hide()
        focusSearch = false
    }

    fun closeSearch() {
        releaseSearchFocus()
        searchState.reset()
        navigation = navigation.copy(search = SearchRoute.Closed)
    }

    fun openSearch() {
        restoreSearchFocus = searchEntryFocused
        searchState.reset()
        focusSearch = true
        navigation = navigation.copy(target = target, settings = null, search = SearchRoute.Open)
    }

    fun returnToList() {
        val search =
            when (navigation.search) {
                SearchRoute.Open -> SearchRoute.Open
                SearchRoute.ReturnOnBack ->
                    if (listWidth == null) SearchRoute.Open else SearchRoute.Closed
                SearchRoute.Closed -> SearchRoute.Closed
            }
        if (search == SearchRoute.Closed) {
            searchState.reset()
        }
        navigation = navigation.copy(target = WorkspaceTarget.List, search = search)
    }

    val thread =
        (target as? WorkspaceTarget.Chat)?.let { chat ->
            list.threads.firstOrNull { it.id == chat.id && it.hidden != true }
        }

    LaunchedEffect(chats, showChatList) { if (!showChatList) chats?.clearRowUndo() }
    if (showChatList && chats != null) ChatUndoFeedback(chats, list, snackbar)
    list.failedRowAction
        ?.takeIf { list.rowUndo == null }
        ?.let { failure ->
            val action = failure.action
            val message =
                stringResource(
                    when {
                        failure.rejected -> R.string.chat_row_action_rejected
                        action.updatesChat -> R.string.chat_row_action_failed
                        else -> R.string.chat_read_action_failed
                    }
                )
            val refreshLabel = if (failure.rejected) null else stringResource(R.string.chat_refresh)
            LaunchedEffect(chats, failure, message, showChatList) {
                if (
                    showChatList &&
                        snackbar.showSnackbar(
                            message,
                            actionLabel = refreshLabel,
                            withDismissAction = !failure.rejected,
                            duration =
                                if (failure.rejected) SnackbarDuration.Short
                                else SnackbarDuration.Indefinite,
                        ) == SnackbarResult.ActionPerformed
                ) {
                    if (action.updatesChat) chats?.reloadAfterRowActionFailure()
                    else chats?.refreshIndicators()
                }
                chats?.dismissRowActionFailure(failure)
            }
        }
    list.markAllReadResult
        ?.takeIf { list.rowUndo == null }
        ?.let { result ->
            val message =
                if (result.confirmed == result.requested) {
                    pluralStringResource(
                        R.plurals.chat_mark_all_read_success,
                        result.confirmed,
                        result.confirmed,
                    )
                } else {
                    stringResource(R.string.chat_mark_all_read_unconfirmed)
                }
            LaunchedEffect(chats, result, message, showChatList) {
                if (showChatList)
                    snackbar.showSnackbar(message, duration = SnackbarDuration.Indefinite)
                chats?.dismissMarkAllReadResult(result)
            }
        }

    fun openConversation(threadId: String, destination: WorkspaceTarget, fromSearch: Boolean) {
        val search =
            when {
                fromSearch && listWidth == null -> SearchRoute.ReturnOnBack
                !fromSearch && navigation.search == SearchRoute.Open -> SearchRoute.Open
                else -> SearchRoute.Closed
            }
        if (fromSearch) releaseSearchFocus()
        when (search) {
            SearchRoute.Closed -> searchState.reset()
            SearchRoute.ReturnOnBack -> searchState.edit(searchState.query.copy(composition = null))
            SearchRoute.Open -> Unit
        }
        conversations.open(threadId)
        navigation = navigation.copy(target = destination, settings = null, search = search)
    }

    fun openChat(chat: ConfirmedChat, fromSearch: Boolean = false) {
        val activeChats = chats ?: return
        val pending = composer?.uiState?.value?.pendingNewChat(chat.id)
        val destination =
            if (pending == null) WorkspaceTarget.Chat(chat.id)
            else WorkspaceTarget.NewChat(pending.projectId)
        openConversation(chat.id, destination, fromSearch)
        if (pending == null) composer?.acknowledge(chat.id)
        activeChats.history.open(chat)
    }

    fun openProvisionalChat(chat: ProvisionalChat) {
        val draft = composer?.uiState?.value?.entry(ComposerTarget(projectId = chat.projectId))
        val destination =
            if (
                draft?.pending?.threadId == chat.threadId || draft?.createdThreadId == chat.threadId
            )
                WorkspaceTarget.NewChat(chat.projectId)
            else WorkspaceTarget.Chat(chat.threadId)
        openConversation(chat.threadId, destination, fromSearch = false)
    }

    fun startNewChat(projectId: String?) {
        val activeComposer = composer?.takeIf { workspaceReady } ?: return
        activeComposer.beginNew(projectId)
        conversations.open(ComposerTarget(projectId = projectId).key)
        val search =
            if (navigation.search == SearchRoute.Open) SearchRoute.Open else SearchRoute.Closed
        if (search == SearchRoute.Closed) searchState.reset()
        navigation = navigation.copy(target = WorkspaceTarget.NewChat(projectId), search = search)
    }

    val pendingChats by
        remember(composerInput) {
            derivedStateOf(structuralEqualityPolicy()) {
                composerInput?.value?.pendingNewChats().orEmpty()
            }
        }
    val provisionalChats =
        remember(pendingChats, list.acceptedNewChats) {
            (pendingChats + list.acceptedNewChats).distinctBy { it.threadId }
        }
    val awaitingCreatedChat =
        target is WorkspaceTarget.Chat &&
            thread == null &&
            provisionalChats.any { it.threadId == target.id }
    val pendingNewChat by
        remember(composerInput, target) {
            derivedStateOf(structuralEqualityPolicy()) {
                (target as? WorkspaceTarget.Chat)?.let {
                    composerInput?.value?.pendingNewChat(it.id)
                }
            }
        }
    LaunchedEffect(target, thread, list.listPhase, listWidth, pendingNewChat, awaitingCreatedChat) {
        if (target is WorkspaceTarget.Chat) {
            val pending = pendingNewChat
            if (pending != null && navigation.target == target) {
                navigation = navigation.copy(target = WorkspaceTarget.NewChat(pending.projectId))
            } else if (thread != null) chats?.history?.open(thread)
            else if (
                !awaitingCreatedChat &&
                    list.listPhase == ChatReadPhase.Ready &&
                    navigation.target == target
            ) {
                returnToList()
                scope.launch {
                    snackbar.showSnackbar(missingChat, duration = SnackbarDuration.Indefinite)
                }
            }
        }
    }
    val newChat = target as? WorkspaceTarget.NewChat
    val wideWelcome = listWidth != null && target == WorkspaceTarget.List && workspaceReady
    val newTarget =
        when {
            newChat != null -> ComposerTarget(projectId = newChat.projectId)
            wideWelcome -> ComposerTarget()
            else -> null
        }
    val submission by
        remember(composerInput, newChat, newTarget) {
            derivedStateOf(structuralEqualityPolicy()) {
                newTarget
                    ?.takeIf { newChat != null }
                    ?.let { composerInput?.value?.entry(it) }
                    ?.let { it.pending?.threadId to it.createdThreadId }
            }
        }
    val (pendingId, createdId) = submission ?: (null to null)
    val provisionalId = pendingId ?: createdId
    val provisionalChat =
        provisionalId?.let { id -> list.threads.firstOrNull { it.id == id && it.hidden != true } }
    val needsChatList =
        settings == null &&
            (showList ||
                (provisionalId != null && provisionalChat == null) ||
                (target is WorkspaceTarget.Chat && thread == null))
    DisposableEffect(chats, needsChatList, showChatList) {
        chats?.listVisibilityChanged(needsChatList, showingFilter = showChatList)
        onDispose { chats?.listVisibilityChanged(false) }
    }
    LaunchedEffect(newChat, provisionalId, provisionalChat, createdId) {
        if (newChat != null && navigation.target == newChat && provisionalId != null) {
            conversations.open(provisionalId)
            if (provisionalChat != null) {
                if (createdId != null) openChat(provisionalChat)
                else chats?.history?.open(provisionalChat)
            }
        }
    }

    fun back() {
        when (settings) {
            SettingsDestination.Instructions ->
                navigation = navigation.copy(settings = SettingsDestination.Overview)
            SettingsDestination.Overview -> navigation = navigation.copy(settings = null)
            null -> if (navigation.search == SearchRoute.Open) closeSearch() else returnToList()
        }
    }

    BackHandler(settings != null || showWorkspaceBack || searchActive, onBack = ::back)

    val title =
        when (settings) {
            SettingsDestination.Overview,
            SettingsDestination.Instructions -> stringResource(R.string.settings)
            null ->
                when (target) {
                    WorkspaceTarget.List ->
                        stringResource(
                            if (wideWelcome) R.string.composer_new else R.string.app_name
                        )
                    is WorkspaceTarget.Chat ->
                        thread?.title?.takeIf { it.isNotBlank() }
                            ?: stringResource(R.string.chat_untitled)
                    is WorkspaceTarget.NewChat -> stringResource(R.string.composer_new)
                }
        }
    val projectId = newChat?.projectId ?: thread?.projectId
    val projectSubtitle = projectId?.let { id -> list.projects.firstOrNull { it.id == id }?.name }
    val detailTitleStyle =
        MaterialTheme.typography.titleMedium.copy(
            fontSize = 18.sp,
            lineHeight = 24.sp,
            letterSpacing = 0.sp,
            fontWeight = FontWeight(550),
        )
    val projectSubtitleStyle =
        MaterialTheme.typography.bodySmall.copy(
            fontSize = 12.sp,
            lineHeight = 16.sp,
            letterSpacing = 0.sp,
        )
    val settingsTitleStyle =
        MaterialTheme.typography.titleLarge.copy(
            fontSize = 20.sp,
            lineHeight = 28.sp,
            letterSpacing = 0.sp,
            fontWeight = FontWeight.SemiBold,
        )
    val detailTitle =
        @Composable {
            Column {
                Text(
                    title,
                    style = detailTitleStyle,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (projectSubtitle != null) {
                    Text(
                        projectSubtitle,
                        style = projectSubtitleStyle,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    val appBarHeight =
        with(LocalDensity.current) {
            val textHeight =
                if (settings != null) settingsTitleStyle.lineHeight.toDp()
                else
                    detailTitleStyle.lineHeight.toDp() +
                        if (projectSubtitle != null) projectSubtitleStyle.lineHeight.toDp()
                        else 0.dp
            maxOf(TopAppBarDefaults.TopAppBarExpandedHeight, textHeight + 16.dp)
        }
    val shortConversation = window.height < 480
    val runActions =
        if (
            settings == null &&
                thread != null &&
                controls != null &&
                pendingNewChat == null &&
                (!searchActive || listWidth != null)
        )
            conversationRunControls(controls, checkNotNull(chats).history, thread.id, list.offline)
        else null
    fun rowAction(id: String, action: ChatRowAction) {
        val started = chats?.performRowAction(id, action) == true
        if (
            started && action == ChatRowAction.Delete && (target as? WorkspaceTarget.Chat)?.id == id
        )
            returnToList()
    }
    val detailActions =
        @Composable {
            if (shortConversation) ConversationStatus(list.offline, runActions, short = true)
            ConversationToolbarActions(
                state = list,
                thread = thread,
                onRowAction = ::rowAction,
                onRename = { id, title -> chats?.renameThread(id, title) },
                openSettings =
                    if (!workspaceReady || listWidth != null) null
                    else {
                        { restore ->
                            restoreSettingsFocus = restore
                            focus.clearFocus()
                            keyboard?.hide()
                            navigation = navigation.copy(settings = SettingsDestination.Overview)
                        }
                    },
                settingsFocus = settingsFocus.takeIf { listWidth == null },
            )
            LaunchedEffect(Unit) {
                if (listWidth == null && restoreSettingsFocus) {
                    restoreSettingsFocus = false
                    settingsFocus.requestFocus()
                }
            }
        }

    val toolbarActions =
        @Composable {
            if (settings == null && !searchActive && chats != null) {
                WorkspaceToolbarActions(
                    showFilter = showList,
                    list = list,
                    selectFilter = chats::selectFilter,
                    markAllRead = chats::markAllRead,
                    update = updateToolbarAction.takeIf { showList && workspaceReady },
                    settingsFocus = settingsFocus,
                    openSettings =
                        if (!workspaceReady) null
                        else
                            { restore ->
                                restoreSettingsFocus = restore
                                focus.clearFocus()
                                keyboard?.hide()
                                navigation =
                                    navigation.copy(settings = SettingsDestination.Overview)
                            },
                )
                LaunchedEffect(Unit) {
                    if (restoreSettingsFocus) {
                        restoreSettingsFocus = false
                        settingsFocus.requestFocus()
                    }
                }
            }
        }
    val listToolbar =
        @Composable {
            WorkspaceListToolbar(
                widthDp = window.width,
                listWidth = listWidth,
                avatar = workspaceAvatar,
                searchFocus = searchEntryFocus,
                onSearchFocusChanged = { searchEntryFocused = it },
                openSearch = if (chats != null) ::openSearch else null,
                actions = toolbarActions,
            )
            LaunchedEffect(Unit) {
                if (restoreSearchFocus) {
                    restoreSearchFocus = false
                    searchEntryFocus.requestFocus()
                }
            }
        }
    val detailBar =
        @Composable {
            Box {
                TopAppBar(
                    title = {
                        if (settings != null) {
                            Text(
                                title,
                                style = settingsTitleStyle,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        } else {
                            Box(
                                Modifier.padding(
                                    start =
                                        when (listWidth) {
                                            344 -> 24.dp
                                            320 -> 16.dp
                                            else -> 0.dp
                                        }
                                )
                            ) {
                                detailTitle()
                            }
                        }
                    },
                    expandedHeight = appBarHeight,
                    windowInsets =
                        if (settings == null && listWidth != null) WindowInsets(0, 0, 0, 0)
                        else TopAppBarDefaults.windowInsets,
                    colors =
                        TopAppBarDefaults.topAppBarColors(
                            containerColor = MaterialTheme.colorScheme.background
                        ),
                    navigationIcon = {
                        if (settings != null || showWorkspaceBack)
                            IconButton(
                                onClick = {
                                    focus.clearFocus()
                                    keyboard?.hide()
                                    back()
                                }
                            ) {
                                Icon(
                                    painterResource(R.drawable.ic_arrow_back),
                                    stringResource(R.string.back),
                                )
                            }
                    },
                    actions = { if (settings == null) detailActions() },
                )
                if (settings == null)
                    HorizontalDivider(
                        Modifier.align(Alignment.BottomCenter),
                        color = MaterialTheme.colorScheme.outline,
                    )
            }
        }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets.safeDrawing,
        snackbarHost = {
            if (!showChatList) {
                WorkspaceFeedbackHost(snackbar, Modifier.padding(bottom = 16.dp))
            }
        },
        topBar = {
            if (settings == null && listWidth == null && showList && !searchActive) {
                Box(Modifier.windowInsetsPadding(TopAppBarDefaults.windowInsets)) { listToolbar() }
            } else if (settings != null || listWidth == null && !searchActive) {
                detailBar()
            }
        },
    ) { insets ->
        Column(Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets)) {
            if (settings != null) {
                SettingsPage(settingsPosition) {
                    settingsContent(
                        settings,
                        {
                            navigation =
                                navigation.copy(settings = SettingsDestination.Instructions)
                        },
                        ::back,
                    )
                }
            } else {
                if (!showChatList && startupRecovery != null) {
                    Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) { startupRecovery() }
                }
                Row(Modifier.fillMaxSize()) {
                    if (showList) {
                        Column(
                            if (listWidth == null) Modifier.weight(1f).fillMaxHeight()
                            else Modifier.width((listWidth - 1).dp).fillMaxHeight(),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            if (searchActive) {
                                ChatTitleSearch(
                                    state = list,
                                    search = searchState,
                                    widthDp = window.width,
                                    listWidth = listWidth,
                                    workspaceName = workspaceName,
                                    focusOnEntry = focusSearch,
                                    onFocused = { focusSearch = false },
                                    onClose = ::closeSearch,
                                    retry = chats::retryList,
                                    onOpen = { openChat(it, fromSearch = true) },
                                )
                            } else {
                                if (listWidth != null) listToolbar()
                                ChatListScreen(
                                    list,
                                    { chats?.retryList() },
                                    { chats?.refreshMetadata() },
                                    { chats?.refreshIndicators() },
                                    ::openChat,
                                    provisionalChats,
                                    ::openProvisionalChat,
                                    ::rowAction,
                                    { id, title -> chats?.renameThread(id, title) },
                                    { id, name -> chats?.renameProject(id, name) },
                                    { id -> chats?.retryProjectRename(id) },
                                    projectExpansion,
                                    listPositions[list.filter.ordinal],
                                    ::startNewChat,
                                    showInbox = { chats?.selectFilter(ChatListFilter.Inbox) },
                                    selectedChatId =
                                        if (listWidth != null)
                                            (target as? WorkspaceTarget.Chat)?.id ?: provisionalId
                                        else null,
                                    wide = listWidth != null,
                                    newChatEnabled = workspaceReady,
                                    startupRecovery = startupRecovery,
                                    dismissProjectRenameRejection = {
                                        chats?.dismissProjectRenameRejection(it)
                                    },
                                    feedback = {
                                        WorkspaceFeedbackHost(
                                            snackbar,
                                            Modifier.testTag("chat_list_feedback"),
                                        )
                                    },
                                )
                            }
                        }
                    }
                    if (listWidth != null) VerticalDivider()
                    if (
                        chats != null &&
                            (listWidth != null || (!searchActive && target != WorkspaceTarget.List))
                    ) {
                        Column(
                            Modifier.weight(1f).fillMaxHeight(),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            if (
                                listWidth != null && (target != WorkspaceTarget.List || wideWelcome)
                            ) {
                                detailBar()
                            }
                            Column(
                                Modifier.widthIn(max = 768.dp)
                                    .fillMaxWidth()
                                    .weight(1f)
                                    .imePadding()
                            ) {
                                when (target) {
                                    is WorkspaceTarget.Chat ->
                                        conversations.Content(target.id) {
                                            val composerTarget =
                                                thread?.let {
                                                    ComposerTarget(it.id, it.agentId, it.projectId)
                                                }
                                            ConversationRoute(
                                                chats.history,
                                                target.id,
                                                list,
                                                Modifier.weight(1f),
                                                composer = composer,
                                                historyAvailable = !awaitingCreatedChat,
                                                realtime = chats.updates.takeIf { workspaceReady },
                                                controls = runActions,
                                            ) { failureId ->
                                                if (
                                                    recovery != null &&
                                                        composer != null &&
                                                        composerTarget != null
                                                )
                                                    AssistantRecoveryPanel(
                                                        recovery,
                                                        composer,
                                                        composerTarget,
                                                        failureId = failureId,
                                                        offline = list.offline,
                                                    )
                                            }
                                            if (
                                                composerTarget != null &&
                                                    pendingNewChat == null &&
                                                    composer != null &&
                                                    controls != null
                                            ) {
                                                if (!shortConversation)
                                                    ConversationStatus(
                                                        list.offline,
                                                        runActions,
                                                        short = false,
                                                    )
                                                ChatComposerField(
                                                    composer,
                                                    composerTarget,
                                                    onInputFocusChanged = { composerFocused = it },
                                                    offline = list.offline,
                                                )
                                            }
                                        }
                                    is WorkspaceTarget.NewChat,
                                    WorkspaceTarget.List -> {
                                        if (provisionalId != null) {
                                            conversations.Content(provisionalId) {
                                                ConversationRoute(
                                                    chats.history,
                                                    provisionalId,
                                                    list,
                                                    Modifier.weight(1f),
                                                    composer = composer,
                                                    historyAvailable = provisionalChat != null,
                                                    realtime =
                                                        chats.updates.takeIf { workspaceReady },
                                                )
                                            }
                                        } else {
                                            Box(Modifier.weight(1f)) {
                                                if (workspaceReady) {
                                                    val welcome =
                                                        if (wideWelcome)
                                                            Modifier.testTag("workspace_new_chat")
                                                        else Modifier
                                                    NewConversationWelcome(welcome)
                                                    Box(Modifier.align(Alignment.BottomCenter)) {
                                                        RealtimeNotice(chats.updates)
                                                    }
                                                }
                                            }
                                        }
                                        if (
                                            createdId == null &&
                                                newTarget != null &&
                                                composer != null
                                        ) {
                                            if (!shortConversation)
                                                ConversationStatus(
                                                    list.offline,
                                                    null,
                                                    short = false,
                                                )
                                            conversations.Content(newTarget.key) {
                                                ChatComposerField(
                                                    composer,
                                                    newTarget,
                                                    onInputFocusChanged = { composerFocused = it },
                                                    offline = list.offline,
                                                    beforeSend = {
                                                        if (wideWelcome) startNewChat(null)
                                                    },
                                                )
                                            }
                                        }
                                    }
                                }
                                if (awaitingCreatedChat || createdId != null) {
                                    TextButton(
                                        onClick = chats::retryList,
                                        enabled =
                                            !list.offline &&
                                                list.listReadFailure !=
                                                    ChatListReadFailure.Retrying &&
                                                list.listPhase != ChatReadPhase.Loading,
                                    ) {
                                        Text(stringResource(R.string.chat_refresh))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Returns the persistent list width in dp when the window has room for both panes. */
internal fun workspaceListPaneWidth(widthDp: Int, heightDp: Int): Int? =
    when {
        widthDp < 840 || heightDp < 480 -> null
        widthDp >= 1100 -> 344
        else -> 320
    }
