package ai.okou.android

import ai.okou.android.artifacts.ArtifactCatalogModel
import ai.okou.android.artifacts.ArtifactsRoute
import ai.okou.android.artifacts.ChatArtifactLinkPreview
import ai.okou.android.artifacts.ChatArtifactResources
import ai.okou.android.chat.AssistantRecoveryModel
import ai.okou.android.chat.AssistantRecoveryPanel
import ai.okou.android.chat.ChatArtifactActions
import ai.okou.android.chat.ChatComposerField
import ai.okou.android.chat.ChatComposerModel
import ai.okou.android.chat.ChatListFilter
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ChatListReadFailure
import ai.okou.android.chat.ChatListScreen
import ai.okou.android.chat.ChatListSource
import ai.okou.android.chat.ChatListUiState
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.ChatRowAction
import ai.okou.android.chat.ChatTitleSearch
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.chat.ConfirmedChat
import ai.okou.android.chat.ConfirmedProject
import ai.okou.android.chat.ConversationFind
import ai.okou.android.chat.ConversationFindTarget
import ai.okou.android.chat.ConversationFindVisit
import ai.okou.android.chat.ConversationLink
import ai.okou.android.chat.ConversationLinkPosition
import ai.okou.android.chat.ConversationLinkSource
import ai.okou.android.chat.ConversationRoute
import ai.okou.android.chat.ConversationStatus
import ai.okou.android.chat.ConversationToolbarActions
import ai.okou.android.chat.HistoryPhase
import ai.okou.android.chat.NewConversationWelcome
import ai.okou.android.chat.ProjectExpansionModel
import ai.okou.android.chat.ProjectMoveFocus
import ai.okou.android.chat.ProjectMovePicker
import ai.okou.android.chat.ProvisionalChat
import ai.okou.android.chat.RealtimeNotice
import ai.okou.android.chat.RunControlsModel
import ai.okou.android.chat.conversationRunControls
import ai.okou.android.chat.openConversationWebLink
import ai.okou.android.chat.projectDestinations
import ai.okou.android.chat.rowActions
import ai.okou.android.connectors.ConnectorModel
import ai.okou.android.connectors.ConnectorsPage
import ai.okou.android.state.ArtifactsDestination
import ai.okou.android.state.ConversationLinkReturn
import ai.okou.android.state.SearchRoute
import ai.okou.android.state.SettingsDestination
import ai.okou.android.state.WorkspaceTarget
import ai.okou.android.state.rememberArtifactPageHolder
import ai.okou.android.state.rememberChatSearchState
import ai.okou.android.state.rememberConnectorsOpen
import ai.okou.android.state.rememberConversationLinkReturns
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.structuralEqualityPolicy
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

private data class ChatMoveTarget(val threadId: String, val fromList: Boolean)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun OkouApp(
    chats: ChatListModel?,
    composer: ChatComposerModel?,
    controls: RunControlsModel?,
    projectExpansion: ProjectExpansionModel?,
    settingsContent:
        @Composable
        (SettingsDestination, open: (SettingsDestination) -> Unit, close: () -> Unit) -> Unit,
    recovery: AssistantRecoveryModel? = null,
    artifacts: ArtifactCatalogModel? = null,
    chatArtifacts: ArtifactCatalogModel? = null,
    workspaceAvatar: @Composable (() -> Unit)? = null,
    workspaceName: String? = null,
    updateToolbarAction: UpdateToolbarAction? = null,
    onUpdateEditingChanged: (Boolean) -> Unit = {},
    startupRecovery: @Composable (() -> Unit)? = null,
    workspaceReady: Boolean = composer != null,
    connectors: ConnectorModel? = null,
) {
    val startupPhase = if (startupRecovery == null) ChatReadPhase.Loading else ChatReadPhase.Idle
    val listState =
        chats?.uiState?.collectAsStateWithLifecycle()
            ?: rememberUpdatedState(
                remember(startupPhase) { ChatListUiState(listPhase = startupPhase) }
            )
    val list by rememberWorkspaceChatNavigation(listState)
    var navigation by rememberWorkspaceNavigation()
    var linkReturns by rememberConversationLinkReturns()
    var linkPosition by remember(chats) { mutableStateOf<ConversationLinkPosition?>(null) }
    var linkFocusKey by remember(chats) { mutableStateOf<String?>(null) }
    val artifactPageState = rememberArtifactPageHolder()
    val resourcesPageState = rememberArtifactPageHolder()
    val inlineArtifactPageState = rememberArtifactPageHolder()
    val resourcesFocus = remember { FocusRequester() }
    var restoreConversationActionsFocus by remember { mutableStateOf(false) }
    val artifactEntryFocus = remember { FocusRequester() }
    var restoreArtifactEntryFocus by remember { mutableStateOf(false) }
    val artifactsOpen = navigation.artifacts != null
    val artifactSource = navigation.artifacts?.sourceId.takeIf { artifacts != null }
    val showArtifacts = artifactsOpen && artifacts != null && artifactSource == null
    var connectorsOpen by rememberConnectorsOpen()
    val canOpenConnectors = connectors != null && workspaceReady
    val showingConnectors = canOpenConnectors && connectorsOpen
    val composerInput = composer?.uiState?.collectAsStateWithLifecycle()
    val settings =
        when {
            chats == null -> null
            navigation.settings == SettingsDestination.Instructions && !workspaceReady ->
                SettingsDestination.Overview
            else -> navigation.settings
        }
    val requestedTarget = artifactSource?.let { WorkspaceTarget.Chat(it) } ?: navigation.target
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
                    requestedTarget is WorkspaceTarget.NewChat &&
                    !restoringFirstSend)
        )
            WorkspaceTarget.List
        else requestedTarget
    var findVisit by remember(chats, target) { mutableStateOf<ConversationFindVisit?>(null) }
    // Window configuration changes on resize. IME insets only change the space inside the panes.
    val window = currentWindowSizeDp()
    val listWidth = workspaceListPaneWidth(window.width, window.height)
    val thread =
        (target as? WorkspaceTarget.Chat)?.let { chat ->
            list.threads.firstOrNull { it.id == chat.id && it.hidden != true }
        }
    val resourcesId =
        thread?.id?.takeIf {
            chatArtifacts != null &&
                settings == null &&
                !showArtifacts &&
                navigation.chatResourcesId == it
        }
    val showingFind =
        settings == null &&
            !showArtifacts &&
            resourcesId == null &&
            findVisit?.let { it.target == null } == true
    val searchState = rememberChatSearchState()
    var focusSearch by remember { mutableStateOf(false) }
    val searchActive = chats != null && !artifactsOpen && navigation.search == SearchRoute.Open
    val inlineArtifactLink =
        navigation.chatArtifactLink.takeIf {
            thread != null &&
                chatArtifacts != null &&
                settings == null &&
                !showArtifacts &&
                resourcesId == null &&
                (listWidth != null || !searchActive)
        }
    var composerFocused by
        remember(target, settings, searchActive, showArtifacts, resourcesId) {
            mutableStateOf(false)
        }
    val editing =
        showArtifacts ||
            inlineArtifactLink != null ||
            resourcesId != null ||
            showingConnectors ||
            searchActive ||
            settings == SettingsDestination.Instructions ||
            (settings == null && (target is WorkspaceTarget.NewChat || composerFocused))
    DisposableEffect(editing) {
        onUpdateEditingChanged(editing)
        onDispose { onUpdateEditingChanged(false) }
    }
    val showList = listWidth != null || searchActive || target == WorkspaceTarget.List
    val showChatList =
        settings == null && showList && !searchActive && !showArtifacts && !showingConnectors
    val showWorkspaceBack =
        linkReturns.isNotEmpty() ||
            artifactSource != null ||
            listWidth == null && !searchActive && target != WorkspaceTarget.List
    val listPositions =
        ChatListFilter.entries.map { filter -> key(filter) { rememberLazyListState() } }
    val settingsPosition = rememberScrollState()
    val subpagePosition =
        if (
            settings != null &&
                settings != SettingsDestination.Overview &&
                settings != SettingsDestination.Instructions
        )
            key(settings) { rememberScrollState() }
        else settingsPosition
    val conversations = rememberConversationUiState()
    val snackbar = remember { SnackbarHostState() }
    val linkSnackbar = remember(chats) { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val linkUnavailable = stringResource(R.string.conversation_link_unavailable)
    val browserUnavailable = stringResource(R.string.conversation_link_no_browser)

    fun clearConversationLinks() {
        linkSnackbar.currentSnackbarData?.dismiss()
        linkReturns = emptyList()
        linkPosition = null
        linkFocusKey = null
    }
    val missingChat = stringResource(R.string.history_missing)
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current

    fun closeFind(returnToActions: Boolean = false) {
        val find = findVisit ?: return
        if (find.inputFocused) {
            focus.clearFocus()
            keyboard?.hide()
        }
        if (returnToActions) restoreConversationActionsFocus = find.restoreActionsFocus
        findVisit = null
    }

    val activeFind = findVisit
    if (activeFind != null && chats != null && target is WorkspaceTarget.Chat) {
        LaunchedEffect(chats.history, target.id, activeFind, showingFind) {
            chats.history.uiState.first { state ->
                state.thread?.id == target.id &&
                    (state.phase == HistoryPhase.Missing ||
                        activeFind.hasLoadedMessages && state.transcript == null)
            }
            if (findVisit === activeFind) {
                if (showingFind) closeFind() else findVisit = null
            }
        }
    }

    val settingsFocus = remember { FocusRequester() }
    val searchEntryFocus = remember { FocusRequester() }
    val connectorEntryFocus = remember { FocusRequester() }
    var searchEntryFocused by remember { mutableStateOf(false) }
    var restoreSearchFocus by remember { mutableStateOf(false) }
    var restoreSettingsFocus by remember { mutableStateOf(false) }
    var connectorEntryFocused by remember { mutableStateOf(false) }
    var restoreConnectorFocus by remember { mutableStateOf(false) }

    fun closeArtifacts(restoreFocus: Boolean) {
        restoreArtifactEntryFocus = restoreFocus
        navigation = navigation.copy(artifacts = null)
        artifacts?.select(null)
        artifactPageState.removeState("artifacts")
    }

    fun closeResources(returnToActions: Boolean = false, returnToCard: Boolean = false) {
        if (navigation.chatArtifactLink != null) {
            navigation =
                navigation.copy(
                    chatArtifactLink = null,
                    chatArtifactFocusKey = navigation.chatArtifactFocusKey.takeIf { returnToCard },
                )
            chatArtifacts?.select(null)
            inlineArtifactPageState.removeState("chat-artifact-link")
        }
        if (!returnToCard && navigation.chatArtifactFocusKey != null) {
            navigation = navigation.copy(chatArtifactFocusKey = null)
        }
        if (navigation.chatResourcesId == null) return
        if (!returnToActions) restoreConversationActionsFocus = false
        navigation = navigation.copy(chatResourcesId = null)
        chatArtifacts?.select(null)
        resourcesPageState.removeState("chat-resources")
    }

    fun openArtifacts() {
        closeResources()
        focus.clearFocus()
        keyboard?.hide()
        navigation = navigation.copy(artifacts = ArtifactsDestination())
    }

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
        closeResources()
        if (artifactSource != null) closeArtifacts(restoreFocus = false)
        restoreSearchFocus = searchEntryFocused
        searchState.reset()
        focusSearch = true
        navigation = navigation.copy(target = target, settings = null, search = SearchRoute.Open)
    }

    fun returnToList() {
        clearConversationLinks()
        closeResources()
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

    val showConversationFeedback =
        settings == null && !showChatList && !showingConnectors && thread != null
    val showRowFeedback = showChatList || showConversationFeedback
    var confirmingProjectDelete by remember(chats) { mutableStateOf<String?>(null) }
    if (chats != null) {
        WorkspaceChatFeedback(
            chats,
            listState,
            snackbar,
            showChatList,
            showRowFeedback,
            confirmingProjectDelete,
            dismissProjectDelete = { confirmingProjectDelete = null },
        )
    }

    fun openConversation(
        threadId: String,
        destination: WorkspaceTarget,
        fromSearch: Boolean,
        fromLink: Boolean = false,
    ) {
        if (!fromLink) clearConversationLinks()
        closeResources()
        if (artifactSource != null && !fromLink) closeArtifacts(restoreFocus = false)
        val search =
            when {
                fromSearch && listWidth == null -> SearchRoute.ReturnOnBack
                !fromSearch && navigation.search == SearchRoute.Open -> SearchRoute.Open
                else -> SearchRoute.Closed
            }
        if (fromSearch) releaseSearchFocus()
        closeFind()
        when (search) {
            SearchRoute.Closed -> searchState.reset()
            SearchRoute.ReturnOnBack -> searchState.edit(searchState.query.copy(composition = null))
            SearchRoute.Open -> Unit
        }
        conversations.open(threadId)
        navigation =
            navigation.copy(
                target = destination,
                settings = null,
                search = search,
                artifacts = navigation.artifacts.takeUnless { fromLink },
            )
    }

    fun openChat(chat: ConfirmedChat, fromSearch: Boolean = false, fromLink: Boolean = false) {
        val activeChats = chats ?: return
        val pending = composer?.uiState?.value?.pendingNewChat(chat.id)
        val destination =
            if (pending == null) WorkspaceTarget.Chat(chat.id)
            else WorkspaceTarget.NewChat(pending.projectId)
        openConversation(chat.id, destination, fromSearch, fromLink)
        if (pending == null) composer?.acknowledge(chat.id)
        activeChats.history.open(chat)
    }

    fun returnFromLink() {
        linkSnackbar.currentSnackbarData?.dismiss()
        val source = linkReturns.last()
        linkReturns = linkReturns.dropLast(1)
        closeFind()
        closeResources()
        linkPosition = ConversationLinkPosition(source = source.source)
        linkFocusKey = source.source.key
        navigation = source.navigation
        list.threads
            .firstOrNull { it.id == source.threadId && it.hidden != true }
            ?.let { chats?.history?.open(it) }
    }

    fun showLinkFailure(message: String) {
        linkSnackbar.currentSnackbarData?.dismiss()
        scope.launch { linkSnackbar.showSnackbar(message) }
    }

    fun openMessageLink(link: ConversationLink, source: ConversationLinkSource) {
        when (link) {
            is ConversationLink.Web -> {
                if (!openConversationWebLink(context, link)) showLinkFailure(browserUnavailable)
            }
            is ConversationLink.Chat -> {
                val current = thread ?: return
                val destination =
                    list.threads.firstOrNull { it.id == link.threadId && it.hidden != true }
                if (destination == null) {
                    showLinkFailure(linkUnavailable)
                    return
                }
                if (destination.id == current.id && link.anchor == null) return
                linkSnackbar.currentSnackbarData?.dismiss()
                linkReturns =
                    (linkReturns + ConversationLinkReturn(navigation, current.id, source)).takeLast(
                        16
                    )
                linkPosition =
                    ConversationLinkPosition(
                        destination =
                            link.anchor?.let { ConversationFindTarget(it.id, null, it.isRun) }
                    )
                linkFocusKey = null
                focus.clearFocus()
                keyboard?.hide()
                openChat(destination, fromLink = true)
            }
        }
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
        clearConversationLinks()
        closeResources()
        if (artifactSource != null) closeArtifacts(restoreFocus = false)
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
    LaunchedEffect(
        target,
        thread,
        list.listPhase,
        listWidth,
        pendingNewChat,
        awaitingCreatedChat,
        showArtifacts,
    ) {
        if (target is WorkspaceTarget.Chat && !showArtifacts) {
            val pending = pendingNewChat
            if (artifactSource != null) {
                if (thread != null) chats?.history?.open(thread)
                else if (list.listPhase == ChatReadPhase.Ready) {
                    navigation = navigation.copy(artifacts = ArtifactsDestination())
                }
            } else if (pending != null && navigation.target == target) {
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
    val deletedNewChatProject =
        newChat?.projectId?.takeIf { id ->
            list.projectsSource == ChatListSource.Network &&
                list.projectsPhase == ChatReadPhase.Ready &&
                list.projects.none { it.id == id }
        }
    val composerRestored = composerInput?.value?.journal != null
    LaunchedEffect(newChat, deletedNewChatProject, provisionalId, composerRestored) {
        if (
            deletedNewChatProject != null &&
                provisionalId == null &&
                composerRestored &&
                navigation.target == newChat
        ) {
            // Project-scoped new chats share the workspace draft. An already submitted send
            // keeps its original target until the composer confirms its own outcome.
            navigation = navigation.copy(target = WorkspaceTarget.NewChat(null))
        }
    }
    val provisionalChat =
        provisionalId?.let { id -> list.threads.firstOrNull { it.id == id && it.hidden != true } }
    val needsChatList =
        !showingConnectors &&
            settings == null &&
            (showArtifacts ||
                showList ||
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
        val find = findVisit
        if (settings == null && find != null) {
            if (find.target == null) closeFind(returnToActions = true) else find.returnToResults()
            return
        }
        when (settings) {
            SettingsDestination.Instructions,
            SettingsDestination.ModelAccounts,
            SettingsDestination.CreditBalance,
            SettingsDestination.Account ->
                navigation = navigation.copy(settings = SettingsDestination.Overview)
            SettingsDestination.Overview -> navigation = navigation.copy(settings = null)
            null ->
                when {
                    linkReturns.isNotEmpty() -> returnFromLink()
                    artifactSource != null ->
                        navigation = navigation.copy(artifacts = ArtifactsDestination())
                    navigation.search == SearchRoute.Open -> closeSearch()
                    else -> returnToList()
                }
        }
    }

    BackHandler(
        !showArtifacts &&
            !showingConnectors &&
            (settings != null || showWorkspaceBack || searchActive || findVisit != null),
        onBack = { if (settings == null && searchActive) closeSearch() else back() },
    )

    if (showingConnectors) {
        ConnectorsPage(connectors, listWidth) { connectorsOpen = false }
        return
    }

    if (showArtifacts) {
        artifactPageState.SaveableStateProvider("artifacts") {
            ArtifactsRoute(
                artifacts,
                list.threads,
                listWidth,
                onClose = { closeArtifacts(restoreFocus = true) },
                onSource = { source ->
                    clearConversationLinks()
                    closeFind()
                    conversations.open(source.id)
                    navigation = navigation.copy(artifacts = ArtifactsDestination(source.id))
                },
            )
        }
        return
    }

    val title =
        when (settings) {
            SettingsDestination.Overview,
            SettingsDestination.Instructions -> stringResource(R.string.settings)
            SettingsDestination.ModelAccounts -> stringResource(R.string.settings_model_accounts)
            SettingsDestination.CreditBalance -> stringResource(R.string.settings_credit_balance)
            SettingsDestination.Account -> stringResource(R.string.settings_account_security)
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
    val inputMode = LocalInputModeManager.current
    var moveTarget by remember(chats) { mutableStateOf<ChatMoveTarget?>(null) }
    var moveFocus by remember(chats) { mutableStateOf<ProjectMoveFocus?>(null) }
    LaunchedEffect(showChatList) { if (!showChatList) moveFocus = null }
    fun moveChat(from: ChatMoveTarget, destination: String?) {
        if (
            chats?.moveThreadToProject(from.threadId, destination) == true &&
                from.fromList &&
                destination != null &&
                inputMode.inputMode == InputMode.Keyboard
        ) {
            moveFocus = ProjectMoveFocus(from.threadId, destination)
        }
    }
    fun requestMove(id: String, fromList: Boolean) {
        val list = listState.value
        val chat = list.threads.firstOrNull { it.id == id && it.hidden != true } ?: return
        if (ChatRowAction.MoveProject !in list.rowActions(chat) || id in list.pendingRowActions)
            return
        val destinations = list.projectDestinations(chat)
        val from = ChatMoveTarget(id, fromList)
        if (destinations.size == 1) moveChat(from, destinations[0].id)
        else if (destinations.isNotEmpty()) moveTarget = from
    }
    moveTarget?.let { from ->
        WorkspaceChatMovePicker(from.threadId, listState, dismiss = { moveTarget = null }) {
            destination ->
            moveTarget = null
            moveChat(from, destination)
        }
    }
    val detailActions =
        @Composable {
            if (shortConversation) ConversationStatus(list.offline, runActions, short = true)
            ConversationToolbarActions(
                state = listState.value,
                thread = thread,
                onRowAction = ::rowAction,
                onMove = { requestMove(it, fromList = false) },
                onRename = { id, title -> chats?.renameThread(id, title) },
                openResources =
                    thread
                        ?.id
                        ?.takeIf { chatArtifacts != null }
                        ?.let { id ->
                            { restore ->
                                restoreConversationActionsFocus = restore
                                focus.clearFocus()
                                keyboard?.hide()
                                navigation = navigation.copy(chatResourcesId = id)
                            }
                        },
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
                settingsFocus = if (listWidth == null) settingsFocus else resourcesFocus,
                onFind =
                    thread?.let { selected ->
                        { restoreFocus ->
                            val find = findVisit
                            if (find != null) {
                                find.returnToResults()
                            } else {
                                val history = chats?.history
                                val messages =
                                    history
                                        ?.uiState
                                        ?.value
                                        ?.takeIf { it.thread?.id == selected.id }
                                        ?.transcript
                                        ?.messages
                                        .orEmpty()
                                val rows = history?.checkpoint(selected.id)?.rows.orEmpty()
                                findVisit =
                                    ConversationFindVisit(
                                        messages,
                                        rows,
                                        chatArtifacts != null,
                                        restoreFocus,
                                    )
                            }
                        }
                    },
            )
            LaunchedEffect(Unit) {
                if (listWidth == null && restoreSettingsFocus) {
                    restoreSettingsFocus = false
                    settingsFocus.requestFocus()
                }
                if (restoreConversationActionsFocus && thread != null) {
                    restoreConversationActionsFocus = false
                    (if (listWidth == null) settingsFocus else resourcesFocus).requestFocus()
                }
            }
        }

    val toolbarActions =
        @Composable {
            if (settings == null && !searchActive) {
                WorkspaceToolbarActions(
                    showFilter = showList,
                    list = listState.value,
                    selectFilter = chats?.let { it::selectFilter },
                    markAllRead = { chats?.markAllRead() },
                    update = updateToolbarAction.takeIf { showList },
                    settingsFocus = settingsFocus,
                    openSettings =
                        if (chats == null) null
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
            Column {
                WorkspaceListToolbar(
                    widthDp = window.width,
                    listWidth = listWidth,
                    avatar = workspaceAvatar,
                    searchFocus = searchEntryFocus,
                    onSearchFocusChanged = { searchEntryFocused = it },
                    openSearch = if (chats != null) ::openSearch else null,
                    actions = toolbarActions,
                )
                WorkspaceToolEntries(
                    openArtifacts = if (artifacts == null) null else ::openArtifacts,
                    artifactFocus = artifactEntryFocus,
                    connectorFocus = connectorEntryFocus,
                    onConnectorFocusChanged = { connectorEntryFocused = it },
                    openConnectors =
                        if (canOpenConnectors) {
                            {
                                restoreConnectorFocus = connectorEntryFocused
                                focus.clearFocus()
                                keyboard?.hide()
                                connectorsOpen = true
                            }
                        } else null,
                )
                LaunchedEffect(canOpenConnectors) {
                    if (canOpenConnectors && restoreConnectorFocus) {
                        restoreConnectorFocus = false
                        connectorEntryFocus.requestFocus()
                    }
                }
            }
            LaunchedEffect(Unit) {
                if (restoreSearchFocus) {
                    restoreSearchFocus = false
                    searchEntryFocus.requestFocus()
                }
                if (restoreArtifactEntryFocus && artifacts != null) {
                    restoreArtifactEntryFocus = false
                    artifactEntryFocus.requestFocus()
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
                                            else -> 16.dp
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
                        if (settings != null || showWorkspaceBack || findVisit?.target != null)
                            IconButton(
                                onClick = {
                                    focus.clearFocus()
                                    keyboard?.hide()
                                    back()
                                }
                            ) {
                                Icon(
                                    painterResource(R.drawable.ic_arrow_back),
                                    stringResource(
                                        if (
                                            artifactSource != null &&
                                                settings == null &&
                                                findVisit?.target == null
                                        )
                                            R.string.artifact_return_preview
                                        else R.string.back
                                    ),
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
            if (!showChatList && !showConversationFeedback) {
                WorkspaceFeedbackHost(snackbar, Modifier.padding(bottom = 16.dp))
            }
        },
        topBar = {
            if (!showingFind) {
                if (settings == null && listWidth == null && showList && !searchActive) {
                    Box(Modifier.windowInsetsPadding(TopAppBarDefaults.windowInsets)) {
                        listToolbar()
                    }
                } else if (
                    settings != null ||
                        listWidth == null &&
                            !searchActive &&
                            resourcesId == null &&
                            inlineArtifactLink == null
                ) {
                    detailBar()
                }
            }
        },
    ) { insets ->
        Column(Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets)) {
            if (settings != null) {
                SettingsPage(subpagePosition) {
                    settingsContent(
                        settings,
                        { destination -> navigation = navigation.copy(settings = destination) },
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
                                    state = listState.value,
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
                                val list = listState.value
                                ChatListScreen(
                                    list,
                                    { chats?.retryList() },
                                    { chats?.refreshMetadata() },
                                    { chats?.refreshIndicators() },
                                    ::openChat,
                                    provisionalChats,
                                    ::openProvisionalChat,
                                    ::rowAction,
                                    { requestMove(it, fromList = true) },
                                    moveFocus = moveFocus,
                                    onMoveFocusFinished = { request ->
                                        if (moveFocus == request) moveFocus = null
                                    },
                                    { id, title -> chats?.renameThread(id, title) },
                                    { id, name -> chats?.renameProject(id, name) },
                                    { id -> confirmingProjectDelete = id },
                                    confirmingProjectDelete,
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
                        ) detailPane@{
                            if (inlineArtifactLink != null && chatArtifacts != null) {
                                inlineArtifactPageState.SaveableStateProvider(
                                    "chat-artifact-link"
                                ) {
                                    ChatArtifactLinkPreview(
                                        chatArtifacts,
                                        inlineArtifactLink,
                                        listWidth != null,
                                    ) {
                                        closeResources(returnToCard = true)
                                    }
                                }
                                return@detailPane
                            }
                            if (resourcesId != null && chatArtifacts != null) {
                                resourcesPageState.SaveableStateProvider("chat-resources") {
                                    ChatArtifactResources(
                                        chatArtifacts,
                                        resourcesId,
                                        listWidth != null,
                                        onClose = { closeResources(returnToActions = true) },
                                    )
                                }
                                return@detailPane
                            }
                            val find = findVisit
                            if (showingFind && find != null) {
                                Box(Modifier.fillMaxSize().imePadding()) {
                                    ConversationFind(
                                        find,
                                        onClose = { closeFind(returnToActions = true) },
                                    )
                                }
                                return@detailPane
                            }
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
                                                    ComposerTarget(
                                                        threadId = it.id,
                                                        projectId = it.projectId,
                                                    )
                                                }
                                            ConversationRoute(
                                                chats.history,
                                                target.id,
                                                listState.value,
                                                Modifier.weight(1f),
                                                composer = composer,
                                                historyAvailable = !awaitingCreatedChat,
                                                realtime = chats.updates.takeIf { workspaceReady },
                                                controls = runActions,
                                                artifactActions =
                                                    if (chatArtifacts == null || thread == null)
                                                        null
                                                    else
                                                        ChatArtifactActions(
                                                            open = { link, key ->
                                                                focus.clearFocus()
                                                                keyboard?.hide()
                                                                navigation =
                                                                    navigation.copy(
                                                                        chatArtifactLink = link,
                                                                        chatArtifactFocusKey = key,
                                                                    )
                                                            },
                                                            restoreKey =
                                                                navigation.chatArtifactFocusKey,
                                                            restored = {
                                                                navigation =
                                                                    navigation.copy(
                                                                        chatArtifactFocusKey = null
                                                                    )
                                                            },
                                                        ),
                                                findTarget = find?.target,
                                                linkPosition = linkPosition,
                                                onLink = ::openMessageLink,
                                                linkFocusKey = linkFocusKey,
                                                onLinkFocusRestored = { linkFocusKey = null },
                                                onLinkUnavailable =
                                                    if (linkReturns.isEmpty()) null
                                                    else {
                                                        {
                                                            returnFromLink()
                                                            showLinkFailure(linkUnavailable)
                                                        }
                                                    },
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
                                            if (showConversationFeedback)
                                                WorkspaceFeedbackHost(
                                                    snackbar,
                                                    Modifier.padding(horizontal = 16.dp)
                                                        .testTag("conversation_feedback"),
                                                )
                                            if (linkSnackbar.currentSnackbarData != null)
                                                WorkspaceFeedbackHost(
                                                    linkSnackbar,
                                                    Modifier.padding(horizontal = 16.dp),
                                                )
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
                                                    listState.value,
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
                                                listState.value.listReadFailure !=
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

internal data class WorkspaceChatNavigation(
    val threads: List<ConfirmedChat>,
    val projects: List<ConfirmedProject>,
    val acceptedNewChats: List<ProvisionalChat>,
    val listPhase: ChatReadPhase,
    val projectsPhase: ChatReadPhase,
    val projectsSource: ChatListSource?,
    val offline: Boolean,
)

@Composable
internal fun rememberWorkspaceChatNavigation(
    listState: State<ChatListUiState>
): State<WorkspaceChatNavigation> =
    remember(listState) {
        derivedStateOf(structuralEqualityPolicy()) {
            val list = listState.value
            WorkspaceChatNavigation(
                list.threads,
                list.projects,
                list.acceptedNewChats,
                list.listPhase,
                list.projectsPhase,
                list.projectsSource,
                list.offline,
            )
        }
    }

@Composable
private fun WorkspaceChatMovePicker(
    threadId: String,
    listState: State<ChatListUiState>,
    dismiss: () -> Unit,
    move: (String?) -> Unit,
) {
    val list = listState.value
    val chat = list.threads.firstOrNull { it.id == threadId && it.hidden != true }
    if (
        chat != null &&
            ChatRowAction.MoveProject in list.rowActions(chat) &&
            threadId !in list.pendingRowActions
    ) {
        ProjectMovePicker(list.projectDestinations(chat), dismiss = dismiss, move = move)
    } else {
        LaunchedEffect(threadId) { dismiss() }
    }
}

/** Returns the persistent list width in dp when the window has room for both panes. */
internal fun workspaceListPaneWidth(widthDp: Int, heightDp: Int): Int? =
    when {
        widthDp < 840 || heightDp < 480 -> null
        widthDp >= 1100 -> 344
        else -> 320
    }
