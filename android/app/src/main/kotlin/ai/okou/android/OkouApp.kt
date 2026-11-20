package ai.okou.android

import ai.okou.android.chat.AssistantRecoveryModel
import ai.okou.android.chat.AssistantRecoveryPanel
import ai.okou.android.chat.ChatComposerField
import ai.okou.android.chat.ChatComposerModel
import ai.okou.android.chat.ChatListFilter
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ChatListScreen
import ai.okou.android.chat.ChatListUiState
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.ChatTitleSearch
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.chat.ConfirmedChat
import ai.okou.android.chat.ConversationRoute
import ai.okou.android.chat.RealtimeNotice
import ai.okou.android.chat.RunControlsModel
import ai.okou.android.chat.RunControlsPanel
import ai.okou.android.state.SearchRoute
import ai.okou.android.state.SettingsDestination
import ai.okou.android.state.WorkspaceTarget
import ai.okou.android.state.rememberChatSearchState
import ai.okou.android.state.rememberCollapsedProjects
import ai.okou.android.state.rememberConversationUiState
import ai.okou.android.state.rememberWorkspaceNavigation
import ai.okou.android.updates.UpdateToolbarAction
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
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
import androidx.compose.ui.platform.LocalAccessibilityManager
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun OkouApp(
    chats: ChatListModel?,
    composer: ChatComposerModel?,
    controls: RunControlsModel?,
    settingsContent: @Composable (SettingsDestination, openInstructions: () -> Unit) -> Unit,
    recovery: AssistantRecoveryModel? = null,
    workspaceTitle: @Composable ((ChatListFilter) -> Unit)? = null,
    updateToolbarAction: UpdateToolbarAction? = null,
    onUpdateEditingChanged: (Boolean) -> Unit = {},
    startupRecovery: @Composable (() -> Unit)? = null,
) {
    val list =
        chats?.uiState?.collectAsStateWithLifecycle()?.value
            ?: ChatListUiState(
                listPhase =
                    if (startupRecovery == null) ChatReadPhase.Loading else ChatReadPhase.Idle
            )
    var navigation by rememberWorkspaceNavigation()
    val settings = navigation.settings.takeIf { composer != null }
    // Let protected destinations wait for preparation without blocking authorized chat navigation.
    val target =
        if (
            chats == null ||
                (composer == null &&
                    (navigation.settings != null || navigation.target is WorkspaceTarget.NewChat))
        )
            WorkspaceTarget.List
        else navigation.target
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
    DisposableEffect(chats, showChatList) {
        chats?.listVisibilityChanged(showChatList)
        onDispose { chats?.listVisibilityChanged(false) }
    }
    val showWorkspaceBack = listWidth == null && !searchActive && target != WorkspaceTarget.List
    val listPositions =
        ChatListFilter.entries.map { filter -> key(filter) { rememberLazyListState() } }
    val settingsPosition = rememberScrollState()
    val collapsed = rememberCollapsedProjects()
    val conversations = rememberConversationUiState()
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val missingChat = stringResource(R.string.history_missing)
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val settingsFocus = remember { FocusRequester() }
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

    list.failedRowAction?.let { action ->
        val message =
            stringResource(
                if (action.updatesChat) R.string.chat_row_action_failed
                else R.string.chat_read_action_failed
            )
        val refreshLabel = stringResource(R.string.chat_refresh)
        LaunchedEffect(chats, action, message, showChatList) {
            if (
                showChatList &&
                    snackbar.showSnackbar(
                        message,
                        actionLabel = refreshLabel,
                        duration = SnackbarDuration.Indefinite,
                    ) == SnackbarResult.ActionPerformed
            ) {
                if (action.updatesChat) chats?.reloadAfterRowActionFailure()
                else chats?.refreshIndicators()
            }
            chats?.dismissRowActionFailure(action)
        }
    }
    list.markAllReadResult?.let { result ->
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
            if (showChatList) snackbar.showSnackbar(message, duration = SnackbarDuration.Indefinite)
            chats?.dismissMarkAllReadResult(result)
        }
    }

    fun openChat(chat: ConfirmedChat, fromSearch: Boolean = false) {
        val activeChats = chats ?: return
        val pending = composer?.uiState?.value?.pendingNewChat(chat.id)
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
        conversations.open(chat.id)
        navigation =
            navigation.copy(
                target =
                    if (pending == null) WorkspaceTarget.Chat(chat.id)
                    else WorkspaceTarget.NewChat(pending.projectId),
                settings = null,
                search = search,
            )
        if (pending == null) composer?.acknowledge(chat.id)
        activeChats.history.open(chat)
    }

    fun startNewChat(projectId: String?) {
        val activeComposer = composer ?: return
        activeComposer.beginNew(projectId)
        conversations.open(ComposerTarget(projectId = projectId).key)
        val search =
            if (navigation.search == SearchRoute.Open) SearchRoute.Open else SearchRoute.Closed
        if (search == SearchRoute.Closed) searchState.reset()
        navigation = navigation.copy(target = WorkspaceTarget.NewChat(projectId), search = search)
    }

    val composerInput = composer?.uiState?.collectAsStateWithLifecycle()
    val pendingNewChat by
        remember(composerInput, target) {
            derivedStateOf(structuralEqualityPolicy()) {
                (target as? WorkspaceTarget.Chat)?.let {
                    composerInput?.value?.pendingNewChat(it.id)
                }
            }
        }
    LaunchedEffect(target, thread, list.listPhase, listWidth, pendingNewChat) {
        if (target is WorkspaceTarget.Chat) {
            val pending = pendingNewChat
            if (pending != null && navigation.target == target) {
                navigation = navigation.copy(target = WorkspaceTarget.NewChat(pending.projectId))
            } else if (thread != null) chats?.history?.open(thread)
            else if (list.listPhase == ChatReadPhase.Ready && navigation.target == target) {
                returnToList()
                scope.launch {
                    snackbar.showSnackbar(missingChat, duration = SnackbarDuration.Indefinite)
                }
            }
        }
    }
    val newChat = target as? WorkspaceTarget.NewChat
    val newTarget = newChat?.let { ComposerTarget(projectId = it.projectId) }
    val submission by
        remember(composerInput, newTarget) {
            derivedStateOf(structuralEqualityPolicy()) {
                newTarget
                    ?.let { composerInput?.value?.entry(it) }
                    ?.let { it.pending?.threadId to it.createdThreadId }
            }
        }
    val (pendingId, createdId) = submission ?: (null to null)
    val provisionalId = pendingId ?: createdId
    val provisionalChat =
        provisionalId?.let { id -> list.threads.firstOrNull { it.id == id && it.hidden != true } }
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
            SettingsDestination.Overview -> stringResource(R.string.settings)
            SettingsDestination.Instructions -> stringResource(R.string.instructions_title)
            null ->
                when (target) {
                    WorkspaceTarget.List -> stringResource(R.string.app_name)
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
            maxOf(64.dp, textHeight + 16.dp)
        }

    val toolbarActions =
        @Composable {
            if (settings == null && !searchActive && chats != null) {
                WorkspaceToolbarActions(
                    showFilter = showList,
                    list = list,
                    selectFilter = chats::selectFilter,
                    markAllRead = chats::markAllRead,
                    openSearch = if (showList) ::openSearch else null,
                    update = updateToolbarAction.takeIf { showList && composer != null },
                    stackUpdateLabel =
                        with(LocalDensity.current) {
                            (listWidth ?: window.width).dp <= 16.sp.toDp() * 19
                        },
                    settingsFocus = settingsFocus,
                    openSettings =
                        if (composer == null) null
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
                title = {
                    if (workspaceTitle != null) {
                        workspaceTitle(list.filter)
                    } else {
                        Column(Modifier.padding(start = 8.dp)) {
                            Text(
                                stringResource(R.string.app_name),
                                style = workspaceListTitleStyle(window.width, listWidth),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            WorkspaceFilterSubtitle(list.filter)
                        }
                    }
                },
                actions = toolbarActions,
            )
        }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets.safeDrawing,
        snackbarHost = {
            if (!showChatList) {
                WorkspaceFeedbackHost(
                    snackbar,
                    Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp),
                )
            }
        },
        topBar = {
            if (settings == null && listWidth == null && showList && !searchActive) {
                Box(Modifier.windowInsetsPadding(TopAppBarDefaults.windowInsets)) { listToolbar() }
            } else if (settings != null || listWidth == null && !searchActive) {
                TopAppBar(
                    title = {
                        if (settings != null) {
                            Text(
                                title,
                                style = settingsTitleStyle,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        } else detailTitle()
                    },
                    expandedHeight = appBarHeight,
                    colors =
                        TopAppBarDefaults.topAppBarColors(
                            containerColor = MaterialTheme.colorScheme.background
                        ),
                    navigationIcon = {
                        if (settings != null || showWorkspaceBack) {
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
                        }
                    },
                    actions = { toolbarActions() },
                )
            }
        },
    ) { insets ->
        Column(Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets)) {
            if (settings != null) {
                val scroll =
                    if (settings == SettingsDestination.Overview) settingsPosition
                    else rememberScrollState()
                SettingsPage(scroll) {
                    settingsContent(settings) {
                        navigation = navigation.copy(settings = SettingsDestination.Instructions)
                    }
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
                                    focusOnEntry = focusSearch,
                                    onFocused = { focusSearch = false },
                                    onClose = ::closeSearch,
                                    retry = chats::refreshList,
                                    onOpen = { openChat(it, fromSearch = true) },
                                )
                            } else {
                                if (listWidth != null) listToolbar()
                                ChatListScreen(
                                    list,
                                    { chats?.refreshMetadata() },
                                    ::openChat,
                                    { id, action -> chats?.performRowAction(id, action) },
                                    { id, title -> chats?.renameThread(id, title) },
                                    collapsed.values,
                                    collapsed::toggle,
                                    listPositions[list.filter.ordinal],
                                    ::startNewChat,
                                    showInbox = { chats?.selectFilter(ChatListFilter.Inbox) },
                                    selectedChatId = if (listWidth != null) thread?.id else null,
                                    wide = listWidth != null,
                                    newChatEnabled = composer != null,
                                    startupRecovery = startupRecovery,
                                    feedback = {
                                        WorkspaceFeedbackHost(
                                            snackbar,
                                            Modifier.padding(horizontal = 16.dp)
                                                .testTag("chat_list_feedback"),
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
                            if (listWidth != null && target != WorkspaceTarget.List) {
                                Box(
                                    Modifier.fillMaxWidth()
                                        .heightIn(min = 63.dp)
                                        .padding(
                                            horizontal = if (listWidth == 344) 40.dp else 32.dp
                                        ),
                                    contentAlignment = Alignment.CenterStart,
                                ) {
                                    detailTitle()
                                }
                                HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                            }
                            Column(Modifier.widthIn(max = 768.dp).fillMaxWidth().weight(1f)) {
                                if (target != WorkspaceTarget.List && composer != null)
                                    RealtimeNotice(chats.updates)
                                when (target) {
                                    WorkspaceTarget.List -> {
                                        if (composer != null) {
                                            Box(
                                                Modifier.fillMaxSize()
                                                    .testTag("workspace_new_chat"),
                                                contentAlignment = Alignment.Center,
                                            ) {
                                                Button(onClick = { startNewChat(null) }) {
                                                    Icon(
                                                        painterResource(R.drawable.ic_edit_square),
                                                        contentDescription = null,
                                                        modifier =
                                                            Modifier.size(ButtonDefaults.IconSize),
                                                    )
                                                    Spacer(
                                                        Modifier.width(ButtonDefaults.IconSpacing)
                                                    )
                                                    Text(stringResource(R.string.composer_new))
                                                }
                                            }
                                        }
                                    }
                                    is WorkspaceTarget.Chat ->
                                        conversations.Content(target.id) {
                                            ConversationRoute(
                                                chats.history,
                                                target.id,
                                                list,
                                                Modifier.weight(1f),
                                                composer = composer,
                                            )
                                            if (
                                                thread != null &&
                                                    pendingNewChat == null &&
                                                    composer != null &&
                                                    controls != null
                                            ) {
                                                val composerTarget =
                                                    ComposerTarget(
                                                        thread.id,
                                                        thread.agentId,
                                                        thread.projectId,
                                                    )
                                                RunControlsPanel(controls, chats.history, thread.id)
                                                recovery?.let {
                                                    AssistantRecoveryPanel(
                                                        it,
                                                        composer,
                                                        composerTarget,
                                                    )
                                                }
                                                ChatComposerField(
                                                    composer,
                                                    composerTarget,
                                                    onInputFocusChanged = { composerFocused = it },
                                                )
                                            }
                                        }
                                    is WorkspaceTarget.NewChat -> {
                                        if (provisionalId != null) {
                                            conversations.Content(provisionalId) {
                                                ConversationRoute(
                                                    chats.history,
                                                    provisionalId,
                                                    list,
                                                    Modifier.weight(1f),
                                                    composer = composer,
                                                    historyAvailable = provisionalChat != null,
                                                )
                                            }
                                        } else Box(Modifier.weight(1f))
                                        conversations.Content(checkNotNull(newTarget).key) {
                                            if (createdId != null) {
                                                TextButton(onClick = chats::refreshList) {
                                                    Text(stringResource(R.string.chat_refresh))
                                                }
                                            } else
                                                ChatComposerField(checkNotNull(composer), newTarget)
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
}

@Composable
private fun WorkspaceFeedbackHost(state: SnackbarHostState, modifier: Modifier) {
    val accessibility = LocalAccessibilityManager.current
    val current = state.currentSnackbarData
    LaunchedEffect(current, accessibility) {
        if (current != null) {
            val duration =
                accessibility?.calculateRecommendedTimeoutMillis(
                    5_000L,
                    containsText = true,
                    containsControls = current.visuals.actionLabel != null,
                ) ?: 5_000L
            delay(duration)
            current.dismiss()
        }
    }
    SnackbarHost(state) { data ->
        Surface(
            modifier = modifier.widthIn(max = 480.dp).fillMaxWidth(),
            shape = RoundedCornerShape(12.dp),
            color = MaterialTheme.colorScheme.inverseSurface,
            contentColor = MaterialTheme.colorScheme.inverseOnSurface,
            shadowElevation = 4.dp,
        ) {
            Row(
                Modifier.heightIn(min = 48.dp).padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val action = data.visuals.actionLabel
                Text(
                    data.visuals.message,
                    modifier = if (action == null) Modifier else Modifier.weight(1f),
                    style =
                        MaterialTheme.typography.bodyMedium.copy(
                            fontSize = 14.sp,
                            lineHeight = 20.sp,
                            letterSpacing = 0.sp,
                        ),
                )
                if (action != null) {
                    TextButton(
                        onClick = data::performAction,
                        colors =
                            ButtonDefaults.textButtonColors(
                                contentColor = MaterialTheme.colorScheme.inversePrimary
                            ),
                    ) {
                        Text(action)
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
