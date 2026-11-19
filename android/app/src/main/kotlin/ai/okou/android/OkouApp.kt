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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.structuralEqualityPolicy
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun OkouApp(
    chats: ChatListModel?,
    composer: ChatComposerModel?,
    controls: RunControlsModel?,
    settingsContent: @Composable (SettingsDestination, openInstructions: () -> Unit) -> Unit,
    recovery: AssistantRecoveryModel? = null,
    workspaceTitle: @Composable (() -> Unit)? = null,
    openUpdate: (() -> Unit)? = null,
    startupRecovery: @Composable (() -> Unit)? = null,
) {
    val list =
        chats?.uiState?.collectAsStateWithLifecycle()?.value
            ?: ChatListUiState(
                listPhase =
                    if (startupRecovery == null) ChatReadPhase.Loading else ChatReadPhase.Idle
            )
    var navigation by rememberWorkspaceNavigation()
    // Keep saved navigation available for Ready without entering a protected destination early.
    val settings = navigation.settings.takeIf { composer != null }
    val target = if (composer != null) navigation.target else WorkspaceTarget.List
    // Window configuration changes on resize. IME insets only change the space inside the panes.
    val window = LocalConfiguration.current
    val listWidth = workspaceListPaneWidth(window.screenWidthDp, window.screenHeightDp)
    val searchState = rememberChatSearchState()
    var focusSearch by remember { mutableStateOf(false) }
    val searchActive = chats != null && composer != null && navigation.search == SearchRoute.Open
    val showList = listWidth != null || searchActive || target == WorkspaceTarget.List
    val showWorkspaceBack = listWidth == null && !searchActive && target != WorkspaceTarget.List
    val listPosition = rememberLazyListState()
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
        navigation = navigation.copy(search = SearchRoute.Open)
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
        LaunchedEffect(action, message) {
            snackbar.showSnackbar(message)
            chats?.dismissRowActionFailure(action)
        }
    }

    fun openChat(chat: ConfirmedChat, fromSearch: Boolean = false) {
        val activeComposer = composer ?: return
        val activeChats = chats ?: return
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
        navigation = navigation.copy(target = WorkspaceTarget.Chat(chat.id), search = search)
        activeComposer.acknowledge(chat.id)
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

    LaunchedEffect(target, thread, list.listPhase, listWidth) {
        if (target is WorkspaceTarget.Chat) {
            if (thread != null) chats?.history?.open(thread)
            else if (list.listPhase == ChatReadPhase.Ready && navigation.target == target) {
                returnToList()
                scope.launch { snackbar.showSnackbar(missingChat) }
            }
        }
    }
    val newChat = target as? WorkspaceTarget.NewChat
    val newTarget = newChat?.let { ComposerTarget(projectId = it.projectId) }
    val createdId =
        if (newTarget != null && composer != null) {
            val draft = newTarget
            val input = composer.uiState.collectAsStateWithLifecycle()
            val created by
                remember(input, draft) {
                    derivedStateOf(structuralEqualityPolicy()) {
                        input.value.entry(draft).createdThreadId
                    }
                }
            created
        } else null
    val createdChat =
        createdId?.let { id -> list.threads.firstOrNull { it.id == id && it.hidden != true } }
    LaunchedEffect(newChat, createdChat) {
        if (newChat != null && navigation.target == newChat && createdChat != null) {
            openChat(createdChat)
        }
    }

    fun back() {
        when (navigation.settings) {
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
                    is WorkspaceTarget.NewChat ->
                        list.projects.firstOrNull { it.id == target.projectId }?.name
                            ?: stringResource(R.string.composer_new)
                }
        }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets.safeDrawing,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            if (settings != null || !searchActive || listWidth != null) {
                TopAppBar(
                    title = {
                        if (
                            settings == null &&
                                target == WorkspaceTarget.List &&
                                workspaceTitle != null
                        ) {
                            workspaceTitle()
                        } else {
                            Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    },
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
                    actions = {
                        if (
                            settings == null && !searchActive && chats != null && composer != null
                        ) {
                            WorkspaceToolbarActions(
                                showFilter = showList,
                                filter = list.filter,
                                selectFilter = chats::selectFilter,
                                openSearch = if (showList) ::openSearch else null,
                                openUpdate = openUpdate,
                                settingsFocus = settingsFocus,
                                openSettings = { restore ->
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
                    },
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
                if (chats != null && composer != null) RealtimeNotice(chats.updates)
                Row(Modifier.fillMaxSize()) {
                    if (showList) {
                        Column(
                            if (listWidth == null) Modifier.weight(1f).fillMaxHeight()
                            else Modifier.width(listWidth.dp).fillMaxHeight(),
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
                                if (list.filter != ChatListFilter.Recent) {
                                    AppliedChatFilter(list.filter) {
                                        chats?.selectFilter(ChatListFilter.Recent)
                                    }
                                }
                                ChatListScreen(
                                    list,
                                    { chats?.refresh() },
                                    { chats?.refreshList() },
                                    { chats?.refreshMetadata() },
                                    { chats?.refreshIndicators() },
                                    ::openChat,
                                    { id, action ->
                                        if (composer != null) chats?.performRowAction(id, action)
                                    },
                                    { id, title ->
                                        if (composer != null) chats?.renameThread(id, title)
                                    },
                                    collapsed.values,
                                    collapsed::toggle,
                                    listPosition,
                                    ::startNewChat,
                                    selectedChatId = if (listWidth != null) thread?.id else null,
                                    actionsEnabled = composer != null,
                                    refreshEnabled = chats != null,
                                    startupRecovery = startupRecovery,
                                )
                            }
                        }
                    }
                    if (listWidth != null) VerticalDivider()
                    if (
                        chats != null &&
                            composer != null &&
                            controls != null &&
                            (listWidth != null || (!searchActive && target != WorkspaceTarget.List))
                    ) {
                        Box(
                            Modifier.weight(1f).fillMaxHeight(),
                            contentAlignment = Alignment.TopCenter,
                        ) {
                            Column(Modifier.widthIn(max = 768.dp).fillMaxWidth().fillMaxHeight()) {
                                when (target) {
                                    WorkspaceTarget.List ->
                                        Box(
                                            Modifier.fillMaxSize().testTag("workspace_new_chat"),
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            Button(onClick = { startNewChat(null) }) {
                                                Icon(
                                                    painterResource(R.drawable.ic_edit_square),
                                                    contentDescription = null,
                                                    modifier =
                                                        Modifier.size(ButtonDefaults.IconSize),
                                                )
                                                Spacer(Modifier.width(ButtonDefaults.IconSpacing))
                                                Text(stringResource(R.string.composer_new))
                                            }
                                        }
                                    is WorkspaceTarget.Chat ->
                                        conversations.Content(target.id) {
                                            ConversationRoute(
                                                chats.history,
                                                target.id,
                                                list,
                                                Modifier.weight(1f),
                                            )
                                            if (thread != null) {
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
                                                ChatComposerField(composer, composerTarget)
                                            }
                                        }
                                    is WorkspaceTarget.NewChat ->
                                        conversations.Content(checkNotNull(newTarget).key) {
                                            Box(Modifier.weight(1f))
                                            if (createdId != null) {
                                                Text(
                                                    stringResource(R.string.composer_accepted),
                                                    Modifier.padding(16.dp),
                                                )
                                                TextButton(onClick = chats::refreshList) {
                                                    Text(stringResource(R.string.chat_refresh))
                                                }
                                            } else ChatComposerField(composer, newTarget)
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
