package ai.okou.android

import ai.okou.android.artifacts.ArtifactCatalogModel
import ai.okou.android.artifacts.ArtifactsRoute
import ai.okou.android.artifacts.ChatArtifactLinkPreview
import ai.okou.android.artifacts.ChatArtifactResources
import ai.okou.android.artifacts.attachmentPreviewId
import ai.okou.android.artifacts.chatAttachment
import ai.okou.android.chat.AssistantFailureCard
import ai.okou.android.chat.AssistantRecoveryModel
import ai.okou.android.chat.AssistantRecoveryPanel
import ai.okou.android.chat.ChatArtifactActions
import ai.okou.android.chat.ChatAttachmentReference
import ai.okou.android.chat.ChatComposerField
import ai.okou.android.chat.ChatComposerModel
import ai.okou.android.chat.ChatComposerTopInset
import ai.okou.android.chat.ChatImageViewer
import ai.okou.android.chat.ChatImageVisit
import ai.okou.android.chat.ChatListFilter
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ChatListReadFailure
import ai.okou.android.chat.ChatListScreen
import ai.okou.android.chat.ChatListSource
import ai.okou.android.chat.ChatListUiState
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.ChatRowAction
import ai.okou.android.chat.ComposerPrefillResult
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.chat.ConfirmedChat
import ai.okou.android.chat.ConfirmedProject
import ai.okou.android.chat.ConversationCodeReading
import ai.okou.android.chat.ConversationContentMaxWidth
import ai.okou.android.chat.ConversationFind
import ai.okou.android.chat.ConversationFindTarget
import ai.okou.android.chat.ConversationFindVisit
import ai.okou.android.chat.ConversationFullCode
import ai.okou.android.chat.ConversationLink
import ai.okou.android.chat.ConversationLinkPosition
import ai.okou.android.chat.ConversationLinkSource
import ai.okou.android.chat.ConversationModelControls
import ai.okou.android.chat.ConversationQueueButton
import ai.okou.android.chat.ConversationRoute
import ai.okou.android.chat.ConversationStopButton
import ai.okou.android.chat.ConversationStopPlacement
import ai.okou.android.chat.ConversationToolbarActions
import ai.okou.android.chat.ConversationUiState
import ai.okou.android.chat.CreateProjectSheet
import ai.okou.android.chat.HistoryPhase
import ai.okou.android.chat.NewConversationWelcome
import ai.okou.android.chat.ProjectCreatePhase
import ai.okou.android.chat.ProjectExpansionModel
import ai.okou.android.chat.ProjectMoveFocus
import ai.okou.android.chat.ProjectMovePicker
import ai.okou.android.chat.ProvisionalChat
import ai.okou.android.chat.RunControlsModel
import ai.okou.android.chat.SearchMessageAnchor
import ai.okou.android.chat.SearchMessageHit
import ai.okou.android.chat.SearchRead
import ai.okou.android.chat.SearchWorkflowIntro
import ai.okou.android.chat.WorkspaceNamePresentation
import ai.okou.android.chat.WorkspaceRenameTarget
import ai.okou.android.chat.WorkspaceSearchModel
import ai.okou.android.chat.WorkspaceSearchScreen
import ai.okou.android.chat.attachmentFocusMessage
import ai.okou.android.chat.conversationRunControls
import ai.okou.android.chat.imageFocusReply
import ai.okou.android.chat.openConversationWebLink
import ai.okou.android.chat.projectDestinations
import ai.okou.android.chat.rememberChatAttachmentPicker
import ai.okou.android.chat.rememberConversationReadVisit
import ai.okou.android.chat.rowActions
import ai.okou.android.chat.searchCatalog
import ai.okou.android.chat.searchWorkflowById
import ai.okou.android.connectors.ConnectorAccountTarget
import ai.okou.android.connectors.ConnectorModel
import ai.okou.android.connectors.ConnectorsPage
import ai.okou.android.preferences.MemberPreferencesModel
import ai.okou.android.settings.DefaultModelSettings
import ai.okou.android.state.ArtifactsDestination
import ai.okou.android.state.ChatConnectorVisit
import ai.okou.android.state.ConversationLinkReturn
import ai.okou.android.state.RetainedExternalImagePreview
import ai.okou.android.state.SearchRoute
import ai.okou.android.state.SettingsDestination
import ai.okou.android.state.WorkflowConnectorVisit
import ai.okou.android.state.WorkflowDraftAction
import ai.okou.android.state.WorkflowDraftReturn
import ai.okou.android.state.WorkflowTab
import ai.okou.android.state.WorkflowsMode
import ai.okou.android.state.WorkflowsRoute
import ai.okou.android.state.WorkspaceTarget
import ai.okou.android.state.rememberArtifactPageHolder
import ai.okou.android.state.rememberChatConnectorVisit
import ai.okou.android.state.rememberChatSearchState
import ai.okou.android.state.rememberConnectorsOpen
import ai.okou.android.state.rememberConversationCodeVisit
import ai.okou.android.state.rememberConversationLinkPosition
import ai.okou.android.state.rememberConversationLinkReturns
import ai.okou.android.state.rememberConversationQueueFlag
import ai.okou.android.state.rememberConversationUiState
import ai.okou.android.state.rememberSearchWorkflowId
import ai.okou.android.state.rememberWorkflowConnectorVisit
import ai.okou.android.state.rememberWorkflowPageState
import ai.okou.android.state.rememberWorkflowsRoute
import ai.okou.android.state.rememberWorkspaceNavigation
import ai.okou.android.updates.UpdateToolbarAction
import ai.okou.android.workflows.WorkflowModel
import ai.okou.android.workflows.WorkflowReadAnnouncements
import ai.okou.android.workflows.WorkflowScreen
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
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
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.structuralEqualityPolicy
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import java.util.TimeZone
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

private data class ChatMoveTarget(val threadId: String, val fromList: Boolean)

private data class WorkflowDraftError(val workflowId: String?, val message: Int)

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
    workspaceSearch: WorkspaceSearchModel? = null,
    updateToolbarAction: UpdateToolbarAction? = null,
    startupRecovery: @Composable (() -> Unit)? = null,
    workspaceReady: Boolean = composer != null,
    connectors: ConnectorModel? = null,
    workflows: WorkflowModel? = null,
    workflowReadAnnouncements: WorkflowReadAnnouncements? = null,
    workflowTimezone: String = TimeZone.getDefault().id,
    defaultModel: DefaultModelSettings? = null,
    memberPreferences: MemberPreferencesModel? = null,
    snackbar: SnackbarHostState = remember { SnackbarHostState() },
    feedbackInOverlay: Boolean = false,
    namePresentation: WorkspaceNamePresentation? = null,
    settingsProgress: @Composable (SettingsDestination) -> Unit = {},
    cachedStartupChats: ChatListModel? = null,
) {
    val startupPhase = if (startupRecovery == null) ChatReadPhase.Loading else ChatReadPhase.Idle
    val listOwner = chats ?: cachedStartupChats
    val listState =
        listOwner?.uiState?.collectAsStateWithLifecycle()
            ?: rememberUpdatedState(
                remember(startupPhase) { ChatListUiState(listPhase = startupPhase) },
            )
    val list by rememberWorkspaceChatNavigation(listState)
    var navigation by rememberWorkspaceNavigation()
    val attachmentPicker =
        composer
            ?.takeIf { it.acceptsAttachments }
            ?.let {
                key(it.attachmentPickerKey) { rememberChatAttachmentPicker(it) }
            }
    var linkReturns by rememberConversationLinkReturns()
    var linkPosition by rememberConversationLinkPosition()
    var linkFocusKey by remember(chats) { mutableStateOf<String?>(null) }
    var connectorsOpen by rememberConnectorsOpen()
    var chatConnectorVisit by rememberChatConnectorVisit()
    var workflowConnectorVisit by rememberWorkflowConnectorVisit()
    var workflowConnectionReturn by remember { mutableStateOf<WorkflowConnectorVisit?>(null) }
    val workflowPageState = rememberWorkflowPageState()
    val canOpenConnectors = connectors != null && workspaceReady
    val showingConnectors =
        canOpenConnectors &&
            (connectorsOpen || workflowConnectorVisit != null || chatConnectorVisit != null)
    var workflowOrigin by rememberWorkspaceNavigation()
    var workflowRoute by rememberWorkflowsRoute()
    val workflowHistoryReturnFocus =
        remember(workflows, workflowRoute.id, workflowRoute.tab) { DirectoryReturnFocus() }
    val returnInputMode = LocalInputModeManager.current
    val workflowQuery = rememberChatSearchState()
    val workflowPositions =
        key(workflowRoute.id) {
            WorkflowTab.entries.map { tab -> key(tab) { rememberLazyListState() } }
        }
    val workflowInput = workflows?.state?.collectAsStateWithLifecycle()
    val readAnnouncements =
        workflowReadAnnouncements ?: remember(workflows) { WorkflowReadAnnouncements() }
    val showWorkflows =
        workflows != null && !showingConnectors && workflowRoute.mode == WorkflowsMode.Directory
    val chatFromWorkflows = workflows != null && workflowRoute.mode == WorkflowsMode.Chat
    val retainWorkflowVisit = workflowConnectionReturn != null
    fun syncWorkflowDestination(route: WorkflowsRoute, open: Boolean) {
        workflows?.let {
            if (open) it.select(route.id, route.tab)
            it.visibilityChanged(open, retainCurrentVisit = retainWorkflowVisit)
        }
    }
    fun changeWorkflowRoute(route: WorkflowsRoute) {
        if (route != workflowRoute) workflowConnectionReturn = null
        syncWorkflowDestination(route, !showingConnectors && route.mode == WorkflowsMode.Directory)
        workflowRoute = route
    }
    LaunchedEffect(workflows, workflowRoute.id, workflowRoute.tab, showWorkflows) {
        syncWorkflowDestination(workflowRoute, showWorkflows)
    }
    val artifactPageState = rememberArtifactPageHolder()
    val resourcesPageState = rememberArtifactPageHolder()
    val inlineArtifactPageState = rememberArtifactPageHolder()
    val resourcesFocus = remember { FocusRequester() }
    var restoreConversationActionsFocus by remember { mutableStateOf(false) }
    val artifactEntryFocus = remember { FocusRequester() }
    var restoreArtifactEntryFocus by remember { mutableStateOf(false) }
    val artifactsOpen = navigation.artifacts != null
    val searchArtifactId = navigation.artifacts?.searchResultId
    val artifactSource = navigation.artifacts?.sourceId.takeIf { artifacts != null }
    val showArtifacts = artifactsOpen && artifacts != null && artifactSource == null
    val composerInput = composer?.uiState?.collectAsStateWithLifecycle()
    val settings =
        when {
            listOwner == null -> null
            navigation.settings == SettingsDestination.Instructions && !workspaceReady ->
                SettingsDestination.Overview
            else -> navigation.settings
        }
    SideEffect {
        defaultModel?.showSettings(settings)
        memberPreferences?.showSettings(settings != null)
    }
    val requestedTarget = artifactSource?.let { WorkspaceTarget.Chat(it) } ?: navigation.target
    val restoringFirstSend =
        remember(workspaceReady, requestedTarget, composerInput) {
                derivedStateOf(structuralEqualityPolicy()) {
                    !workspaceReady &&
                        requestedTarget is WorkspaceTarget.NewChat &&
                        composerInput
                            ?.value
                            ?.entry(ComposerTarget(projectId = requestedTarget.projectId))
                            ?.let { it.pending != null || it.createdThreadId != null } == true
                }
            }
            .value
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
    LaunchedEffect(chatArtifacts, target) {
        (target as? WorkspaceTarget.Chat)?.let { chatArtifacts?.inlineImages?.revisit(it.id) }
    }
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
                !showWorkflows &&
                navigation.chatResourcesId == it
        }
    val showingFind =
        settings == null &&
            !showArtifacts &&
            resourcesId == null &&
            findVisit?.let { it.target == null } == true
    val searchState = rememberChatSearchState()
    var searchWorkflowId by rememberSearchWorkflowId(searchState)
    var focusSearch by remember { mutableStateOf(false) }
    val searchActive = chats != null && !artifactsOpen && !showWorkflows && navigation.search.isOpen
    val searchKeyword =
        searchState.keyword.takeIf { navigation.search != SearchRoute.Closed }.orEmpty()
    val searchWorkflowsAvailable = workflows != null
    val searchArtifactsAvailable = artifacts != null
    val searchCatalogOpen =
        navigation.search.isOpen && !artifactsOpen && !showingConnectors && settings == null
    if (workflows != null) {
        LifecycleResumeEffect(workflows) {
            workflows.foregroundChanged(true)
            onPauseOrDispose { workflows.foregroundChanged(false) }
        }
        LaunchedEffect(workflows, searchCatalogOpen) {
            workflows.searchVisibilityChanged(searchCatalogOpen)
        }
        DisposableEffect(workflows) { onDispose { workflows.searchVisibilityChanged(false) } }
    }
    val searchVisible =
        workspaceSearch != null &&
            searchActive &&
            settings == null &&
            LocalLifecycleOwner.current.lifecycle
                .currentStateAsState()
                .value
                .isAtLeast(Lifecycle.State.RESUMED)
    LaunchedEffect(
        workspaceSearch,
        searchKeyword,
        searchState.type,
        searchArtifactsAvailable,
        searchVisible,
    ) {
        workspaceSearch?.update(
            searchKeyword,
            searchState.type,
            artifactsAvailable = searchArtifactsAvailable,
            visible = searchVisible,
        )
    }
    DisposableEffect(workspaceSearch) { onDispose { workspaceSearch?.pauseReads() } }
    val inlineArtifactLink =
        when (val link = navigation.chatArtifactLink) {
            RetainedExternalImagePreview -> chatArtifacts?.retainedExternalImageId()
            else -> link
        }.takeIf {
            val composerPreview =
                it != null &&
                    chatAttachment(it) != null &&
                    (target is WorkspaceTarget.NewChat ||
                        listWidth != null && target == WorkspaceTarget.List)
            (thread != null || composerPreview) &&
                chatArtifacts != null &&
                settings == null &&
                !showArtifacts &&
                !showWorkflows &&
                resourcesId == null &&
                (listWidth != null || !searchActive)
        }
    val conversationSnackbar = remember(chats) { SnackbarHostState() }
    var conversationFeedbackInOptions by remember(chats, target) { mutableStateOf(false) }
    val savedCodeVisit = rememberConversationCodeVisit()
    val codeReading = remember(savedCodeVisit) { ConversationCodeReading(savedCodeVisit) }
    val codeThread = (target as? WorkspaceTarget.Chat)?.id
    LaunchedEffect(chats, target) {
        if (chats != null) codeReading.retainChat(codeThread)
    }
    val codeVisit =
        codeReading.visit?.takeIf {
            it.threadId == codeThread &&
                thread != null &&
                settings == null &&
                !showWorkflows &&
                !showingConnectors &&
                !showArtifacts &&
                resourcesId == null &&
                !showingFind &&
                inlineArtifactLink == null
        }
    val showList =
        if (codeVisit != null) listWidth != null && !codeVisit.expanded
        else listWidth != null || searchActive || target == WorkspaceTarget.List
    val showChatList =
        settings == null &&
            showList &&
            !searchActive &&
            !showArtifacts &&
            !showWorkflows &&
            !showingConnectors
    val linkedFrom = linkReturns.lastOrNull()
    val showWorkspaceBack =
        linkedFrom != null ||
            artifactSource != null ||
            chatFromWorkflows ||
            listWidth == null && !searchActive && target != WorkspaceTarget.List
    val listPositions =
        ChatListFilter.entries.map { filter -> key(filter) { rememberLazyListState() } }
    val listUndoFocus = remember(chats, showChatList) { DirectoryReturnFocus() }
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
    val conversationNavigationErrors =
        remember(chats) {
            mutableStateListOf<ConversationNavigationError>()
        }
    val listNavigationErrors = remember(chats) { mutableStateListOf<FeedbackReceipt<String>>() }
    val showListNavigationFeedback =
        settings == null &&
            !showWorkflows &&
            !showingConnectors &&
            !showArtifacts &&
            (showChatList || target == WorkspaceTarget.List)
    LaunchedEffect(showListNavigationFeedback) {
        if (!showListNavigationFeedback) listNavigationErrors.clear()
    }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val linkUnavailable = stringResource(R.string.conversation_link_unavailable)
    val browserUnavailable = stringResource(R.string.conversation_link_no_browser)

    fun clearConversationLinks() {
        conversationNavigationErrors.clear()
        linkReturns.forEach { link ->
            link.navigation.chatResourcesId?.let {
                resourcesPageState.removeState("chat-resources:$it")
            }
        }
        linkReturns = emptyList()
        linkPosition = null
        linkFocusKey = null
    }
    val missingChat = stringResource(R.string.history_missing)
    val missingMessage = stringResource(R.string.chat_search_message_unavailable)
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    fun openChatArtifact(link: String, focusKey: String?, visit: ChatImageVisit? = null) {
        focus.clearFocus()
        keyboard?.hide()
        chatArtifacts?.showChatImages(visit)
        navigation = navigation.copy(chatArtifactLink = link, chatArtifactFocusKey = focusKey)
    }
    fun conversationArtifactActions(threadId: String): ChatArtifactActions? =
        chatArtifacts?.let { model ->
            ChatArtifactActions(
                open = { link, key -> openChatArtifact(link, key) },
                restoreKey = navigation.chatArtifactFocusKey,
                restored = {
                    navigation =
                        navigation.copy(
                            chatArtifactLink = null,
                            chatArtifactFocusKey = null,
                        )
                },
                images = model.inlineImages,
                threadId = threadId,
                openImages = { visit, key -> openChatArtifact(visit.initialLink, key, visit) },
            )
        }
    val openComposerAttachment: ((ChatAttachmentReference) -> Unit)? =
        if (chatArtifacts == null) null
        else { attachment -> openChatArtifact(attachment.attachmentPreviewId(), null) }

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
    val workflowsFocus = remember { FocusRequester() }
    var workflowEntryFocused by remember { mutableStateOf(false) }
    var restoreWorkflowFocus by remember { mutableStateOf(false) }
    var handoff by remember { mutableStateOf<Job?>(null) }
    var handoffPending by remember { mutableStateOf(false) }
    var workflowDraftError by remember { mutableStateOf<WorkflowDraftError?>(null) }
    var searchEntryFocused by remember { mutableStateOf(false) }
    var restoreSearchFocus by remember { mutableStateOf(false) }
    var restoreSettingsFocus by remember { mutableStateOf(false) }
    var connectorEntryFocused by remember { mutableStateOf(false) }
    var restoreConnectorFocus by remember { mutableStateOf(false) }

    fun dismissWorkflowIntro() {
        handoff?.cancel()
        searchWorkflowId = null
    }

    LaunchedEffect(searchWorkflowsAvailable) {
        if (searchWorkflowId != null && !searchWorkflowsAvailable) {
            dismissWorkflowIntro()
        }
    }

    fun closeArtifacts(restoreFocus: Boolean) {
        restoreArtifactEntryFocus = restoreFocus
        navigation = navigation.copy(artifacts = null)
        artifacts?.select(null)
        artifactPageState.removeState("artifacts")
    }

    fun closeResources(
        returnToActions: Boolean = false,
        returnToCard: Boolean = false,
        preservePage: Boolean = false,
    ) {
        composer?.showDraftImages(null)
        if (navigation.chatArtifactLink != null) {
            navigation =
                navigation.copy(
                    chatArtifactLink = null,
                    chatArtifactFocusKey = navigation.chatArtifactFocusKey.takeIf { returnToCard },
                )
            chatArtifacts?.select(null)
            chatArtifacts?.showChatImages(null)
            inlineArtifactPageState.removeState("chat-artifact-link")
        }
        if (!returnToCard && navigation.chatArtifactFocusKey != null) {
            navigation = navigation.copy(chatArtifactFocusKey = null)
        }
        val resourcesThread = navigation.chatResourcesId ?: return
        if (!returnToActions) restoreConversationActionsFocus = false
        navigation = navigation.copy(chatResourcesId = null)
        chatArtifacts?.select(null)
        if (!preservePage) resourcesPageState.removeState("chat-resources:$resourcesThread")
    }

    fun releaseSearchFocus() {
        focus.clearFocus()
        keyboard?.hide()
        focusSearch = false
    }

    fun closeSearch() {
        searchWorkflowId = null
        releaseSearchFocus()
        restoreSearchFocus = true
        searchState.reset()
        navigation = navigation.copy(search = SearchRoute.Closed)
    }

    fun closeCodeReader() {
        codeReading.close()
        if (listWidth == null && searchActive) {
            releaseSearchFocus()
            navigation = navigation.copy(search = SearchRoute.ReturnOnBack)
        }
    }

    fun openSearch() {
        closeResources()
        if (artifactSource != null) closeArtifacts(restoreFocus = false)
        restoreSearchFocus = searchEntryFocused
        searchState.reset()
        focusSearch = true
        navigation = navigation.copy(target = target, settings = null, search = SearchRoute.Open)
    }

    fun openWorkflows(
        id: String? = null,
        tab: WorkflowTab = WorkflowTab.Instructions,
        resourceRow: String? = null,
    ) {
        restoreWorkflowFocus = id == null && workflowEntryFocused
        searchWorkflowId = null
        if (artifactSource != null) closeArtifacts(restoreFocus = false)
        focus.clearFocus()
        keyboard?.hide()
        workflowOrigin = navigation
        workflowQuery.reset()
        workflowDraftError = null
        changeWorkflowRoute(
            WorkflowsRoute(
                mode = WorkflowsMode.Directory,
                id = id,
                tab = tab,
                resourceReturnRow = resourceRow,
            ),
        )
    }

    fun closeWorkflows() {
        handoff?.cancel()
        handoff = null
        workflowConnectionReturn = null
        workflowPageState.removeState("workflow")
        if (navigation.chatResourcesId != null)
            workflowRoute.resourceReturnRow?.let { linkFocusKey = it }
        changeWorkflowRoute(WorkflowsRoute())
    }

    fun leaveWorkflowChat() {
        if (!chatFromWorkflows) return
        restoreWorkflowFocus = false
        closeWorkflows()
    }

    fun returnToWorkflows() {
        clearConversationLinks()
        navigation = workflowOrigin
        val draftReturn = workflowRoute.draftReturn
        val showDirectory = draftReturn?.action == WorkflowDraftAction.Create && listWidth == null
        changeWorkflowRoute(
            workflowRoute.copy(
                mode = WorkflowsMode.Directory,
                id = workflowRoute.id.takeUnless { showDirectory },
                tab = if (showDirectory) WorkflowTab.Instructions else workflowRoute.tab,
                draftReturn = draftReturn?.takeIf { it.restoreFocus },
            ),
        )
    }

    fun openArtifacts(searchResultId: String? = null) {
        if (searchResultId == null) leaveWorkflowChat()
        closeResources()
        focus.clearFocus()
        keyboard?.hide()
        navigation =
            navigation.copy(artifacts = ArtifactsDestination(searchResultId = searchResultId))
    }

    fun returnToList() {
        clearConversationLinks()
        closeResources()
        val search =
            when (navigation.search) {
                SearchRoute.Open,
                SearchRoute.OpenBeforeLink -> SearchRoute.Open
                SearchRoute.ReturnOnBack ->
                    if (listWidth == null) SearchRoute.Open else SearchRoute.Closed
                SearchRoute.Closed -> SearchRoute.Closed
            }
        if (search == SearchRoute.Closed) {
            searchState.reset()
        }
        navigation =
            navigation.copy(
                target = WorkspaceTarget.List,
                search = search,
                searchMessageAnchor = null,
            )
    }

    val visibleThread = thread?.takeIf {
        settings == null && !showWorkflows && !showArtifacts && (!searchActive || listWidth != null)
    }
    LaunchedEffect(workspaceSearch, visibleThread?.id, visibleThread?.archived) {
        if (visibleThread != null) workspaceSearch?.opened(visibleThread)
    }

    var confirmingProjectDelete by remember(chats) { mutableStateOf<String?>(null) }
    val renameEditor = namePresentation?.editor
    val projectCreationEditor = namePresentation?.projectCreation
    val projectCreation by
        remember(listState) {
            derivedStateOf { listState.value.projectList.creation }
        }
    val renameTarget = renameEditor?.target
    val renameFocus = namePresentation?.focusReturn
    fun finishRenameFocus(request: WorkspaceRenameTarget) {
        namePresentation?.finishFocus(request)
    }

    fun openConversation(
        threadId: String,
        destination: WorkspaceTarget,
        fromSearch: Boolean,
        fromLink: Boolean = false,
        searchMessageAnchor: SearchMessageAnchor? = null,
        keepAttachmentVisit: Boolean = false,
    ) {
        if (!fromLink) clearConversationLinks()
        if (!keepAttachmentVisit) closeResources(preservePage = fromLink)
        if (artifactSource != null && !fromLink) closeArtifacts(restoreFocus = false)
        val search =
            when {
                fromLink && navigation.search.isOpen -> SearchRoute.OpenBeforeLink
                fromLink -> navigation.search
                fromSearch && listWidth == null -> SearchRoute.ReturnOnBack
                !fromSearch && navigation.search.isOpen -> SearchRoute.Open
                !fromSearch && listWidth == null -> navigation.search
                else -> SearchRoute.Closed
            }
        if (fromSearch) releaseSearchFocus()
        closeFind()
        if (search == SearchRoute.Closed) searchState.reset()
        conversations.open(threadId)
        navigation =
            navigation.copy(
                target = destination,
                settings = null,
                search = search,
                artifacts = navigation.artifacts.takeUnless { fromLink },
                searchMessageAnchor = searchMessageAnchor,
            )
    }

    fun openChat(
        chat: ConfirmedChat,
        fromSearch: Boolean = false,
        fromLink: Boolean = false,
        keepAttachmentVisit: Boolean = false,
    ) {
        val activeChats = chats ?: return
        val pending = composer?.uiState?.value?.pendingNewChat(chat.id)
        val destination =
            if (pending == null) WorkspaceTarget.Chat(chat.id)
            else WorkspaceTarget.NewChat(pending.projectId)
        openConversation(
            chat.id,
            destination,
            fromSearch,
            fromLink,
            keepAttachmentVisit = keepAttachmentVisit,
        )
        if (pending == null) composer?.acknowledge(chat.id)
        activeChats.history.open(chat)
    }

    fun returnFromLink() {
        val source = linkReturns.last()
        linkReturns = linkReturns.dropLast(1)
        closeFind()
        closeResources()
        linkPosition = ConversationLinkPosition(source = source.source)
        linkFocusKey = source.source.key
        val search =
            if (navigation.search == SearchRoute.OpenBeforeLink) source.navigation.search
            else navigation.search
        navigation = source.navigation.copy(settings = navigation.settings, search = search)
        list.threads
            .firstOrNull { it.id == source.threadId && it.hidden != true }
            ?.let { chats?.history?.open(it) }
    }

    fun showConversationNavigationError(threadId: String, message: String) {
        conversationNavigationErrors.add(ConversationNavigationError(threadId, message))
    }

    fun returnFromUnavailableLink(source: ConversationLinkReturn) {
        if (linkReturns.lastOrNull() !== source) return
        returnFromLink()
        showConversationNavigationError(source.threadId, linkUnavailable)
    }

    fun openMessageLink(link: ConversationLink, source: ConversationLinkSource) {
        when (link) {
            is ConversationLink.Web -> {
                if (!openConversationWebLink(context, link)) {
                    (target as? WorkspaceTarget.Chat)?.let {
                        showConversationNavigationError(it.id, browserUnavailable)
                    }
                }
            }
            is ConversationLink.Chat -> {
                val current = thread ?: return
                val destination =
                    list.threads.firstOrNull { it.id == link.threadId && it.hidden != true }
                if (destination == null) {
                    showConversationNavigationError(current.id, linkUnavailable)
                    return
                }
                if (destination.id == current.id && link.anchor == null) return
                val next =
                    (linkReturns + ConversationLinkReturn(navigation, current.id, source)).takeLast(
                        16,
                    )
                if (linkReturns.size == 16) {
                    linkReturns.first().navigation.chatResourcesId?.let { dropped ->
                        if (next.none { it.navigation.chatResourcesId == dropped }) {
                            resourcesPageState.removeState("chat-resources:$dropped")
                        }
                    }
                }
                linkReturns = next
                linkPosition =
                    ConversationLinkPosition(
                        destination =
                            link.anchor?.let { ConversationFindTarget(it.id, null, it.isRun) },
                    )
                linkFocusKey = null
                focus.clearFocus()
                keyboard?.hide()
                openChat(destination, fromLink = true)
            }
        }
    }

    fun openSearchMessage(hit: SearchMessageHit) {
        val activeChats = chats ?: return
        val result =
            activeChats.uiState.value.threads.firstOrNull {
                it.id == hit.threadId && it.hidden != true
            } ?: return
        leaveWorkflowChat()
        openConversation(
            result.id,
            WorkspaceTarget.Chat(result.id),
            fromSearch = true,
            searchMessageAnchor = SearchMessageAnchor(hit.seqId, hit.sourceRange),
        )
        composer?.acknowledge(result.id)
        activeChats.history.open(result)
    }

    fun openProvisionalChat(chat: ProvisionalChat) {
        leaveWorkflowChat()
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
        leaveWorkflowChat()
        clearConversationLinks()
        closeResources()
        if (artifactSource != null) closeArtifacts(restoreFocus = false)
        activeComposer.beginNew(projectId)
        conversations.open(ComposerTarget(projectId = projectId).key)
        val search = if (navigation.search.isOpen) SearchRoute.Open else SearchRoute.Closed
        if (search == SearchRoute.Closed) searchState.reset()
        navigation =
            navigation.copy(
                target = WorkspaceTarget.NewChat(projectId),
                search = search,
                searchMessageAnchor = null,
            )
    }

    fun workflowDraft(
        prefix: String,
        workflowId: String? = null,
        fromSearch: Boolean = false,
        draftReturn: WorkflowDraftReturn? = null,
    ) {
        val activeComposer = composer ?: return
        if (handoffPending) return
        val useOriginTab =
            workflowRoute.tab.takeIf { draftReturn?.action == WorkflowDraftAction.Use }
        handoffPending = true
        if (draftReturn?.restoreFocus == true)
            workflowRoute = workflowRoute.copy(draftReturn = draftReturn)
        workflowDraftError = null
        handoff = scope.launch {
            try {
                when (activeComposer.prefillNew(prefix)) {
                    ComposerPrefillResult.Ready -> {
                        handoff = null
                        workflowHistoryReturnFocus.cancel()
                        if (fromSearch) leaveWorkflowChat()
                        clearConversationLinks()
                        focus.clearFocus()
                        keyboard?.hide()
                        conversations.open(ComposerTarget().key)
                        val nextSearch =
                            if (fromSearch && listWidth == null) SearchRoute.ReturnOnBack
                            else SearchRoute.Closed
                        if (fromSearch) {
                            searchWorkflowId = null
                            if (nextSearch == SearchRoute.Closed) searchState.reset()
                        }
                        navigation =
                            navigation.copy(
                                target = WorkspaceTarget.NewChat(null),
                                settings = null,
                                search = nextSearch,
                                searchMessageAnchor = null,
                            )
                        if (!fromSearch) {
                            changeWorkflowRoute(
                                workflowRoute.copy(
                                    mode = WorkflowsMode.Chat,
                                    tab = useOriginTab ?: workflowRoute.tab,
                                    draftReturn = draftReturn,
                                ),
                            )
                        }
                    }
                    ComposerPrefillResult.NetworkFailed,
                    ComposerPrefillResult.Unavailable -> {
                        workflowDraftError =
                            WorkflowDraftError(workflowId, R.string.workflow_draft_unavailable)
                    }
                }
            } finally {
                if (
                    draftReturn?.restoreFocus == true &&
                        workflowRoute.mode == WorkflowsMode.Directory
                )
                    workflowRoute = workflowRoute.copy(draftReturn = null)
                handoffPending = false
            }
        }
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
        showWorkflows,
        linkedFrom,
    ) {
        if (target is WorkspaceTarget.Chat && !showArtifacts && !showWorkflows) {
            val pending = pendingNewChat
            if (artifactSource != null) {
                if (thread != null) chats?.history?.open(thread)
                else if (list.listPhase == ChatReadPhase.Ready) {
                    navigation =
                        navigation.copy(artifacts = navigation.artifacts?.copy(sourceId = null))
                }
            } else if (pending != null && navigation.target == target) {
                navigation = navigation.copy(target = WorkspaceTarget.NewChat(pending.projectId))
            } else if (thread != null) chats?.history?.open(thread)
            else if (
                !awaitingCreatedChat &&
                    list.listPhase == ChatReadPhase.Ready &&
                    navigation.target == target
            ) {
                if (linkedFrom != null) returnFromUnavailableLink(linkedFrom)
                else if (chatFromWorkflows) returnToWorkflows()
                else {
                    returnToList()
                    listNavigationErrors.add(FeedbackReceipt(missingChat))
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
    val activeComposerKey =
        (target as? WorkspaceTarget.Chat)?.let { "thread:${it.id}" } ?: newTarget?.key
    LaunchedEffect(connectors, activeComposerKey) {
        connectors?.chatOptions?.activate(activeComposerKey)
    }
    LaunchedEffect(chatConnectorVisit, activeComposerKey, workspaceReady) {
        if (
            workspaceReady &&
                chatConnectorVisit?.composerKey?.let { it != activeComposerKey } == true
        ) {
            if (!connectorsOpen && workflowConnectorVisit == null) connectors?.select(null)
            chatConnectorVisit = null
        }
    }

    fun manageChatConnectors(origin: ComposerTarget, account: ConnectorAccountTarget?) {
        if (wideWelcome) navigation = navigation.copy(target = WorkspaceTarget.NewChat(null))
        chatConnectorVisit = ChatConnectorVisit(origin.key, account?.slug, account?.connectionId)
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
    val composerRestored =
        remember(composerInput) {
                derivedStateOf(structuralEqualityPolicy()) { composerInput?.value?.journal != null }
            }
            .value
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
    val provisionalChat = provisionalId?.let { id ->
        list.threads.firstOrNull { it.id == id && it.hidden != true }
    }
    val needsWorkflowSourceChats =
        showWorkflows &&
            workflowRoute.tab == WorkflowTab.History &&
            remember(workflowInput) {
                    derivedStateOf(structuralEqualityPolicy()) {
                        workflowInput?.value?.history?.runs?.any { it.chatThreadId != null } == true
                    }
                }
                .value
    // An open conversation uses the live list projection for its title and chat actions.
    val needsChatList =
        needsWorkflowSourceChats ||
            (settings == null &&
                !showWorkflows &&
                !showingConnectors &&
                (showArtifacts ||
                    showList ||
                    (provisionalId != null && provisionalChat == null) ||
                    target is WorkspaceTarget.Chat))
    DisposableEffect(chats, needsChatList) {
        chats?.listVisibilityChanged(needsChatList)
        onDispose { chats?.listVisibilityChanged(false) }
    }
    DisposableEffect(chats, showChatList) {
        chats?.listPaneVisibilityChanged(showChatList)
        onDispose { chats?.listPaneVisibilityChanged(false) }
    }
    LaunchedEffect(newChat, provisionalId, provisionalChat, createdId) {
        if (newChat != null && navigation.target == newChat && provisionalId != null) {
            conversations.open(provisionalId)
            if (provisionalChat != null) {
                if (createdId != null)
                    openChat(
                        provisionalChat,
                        keepAttachmentVisit =
                            chatArtifacts?.chatImageVisit?.threadId == provisionalId ||
                                (navigation.chatArtifactLink == null &&
                                    attachmentFocusMessage(navigation.chatArtifactFocusKey) !=
                                        null),
                    )
                else chats?.history?.open(provisionalChat)
            }
        }
    }

    fun back() {
        val find = findVisit
        if (settings == null && find != null) {
            if (find.target == null) closeFind(returnToActions = true)
            else find.returnToResults(returnInputMode.inputMode)
            return
        }
        when (settings) {
            SettingsDestination.Instructions,
            SettingsDestination.ModelAccounts,
            SettingsDestination.CreditBalance,
            SettingsDestination.ProactiveServices,
            SettingsDestination.BuiltInTools,
            SettingsDestination.Account ->
                navigation = navigation.copy(settings = SettingsDestination.Overview)
            SettingsDestination.Overview -> navigation = navigation.copy(settings = null)
            null ->
                when {
                    linkReturns.isNotEmpty() -> returnFromLink()
                    artifactSource != null ->
                        navigation =
                            navigation.copy(artifacts = navigation.artifacts?.copy(sourceId = null))
                    navigation.search.isOpen -> closeSearch()
                    chatFromWorkflows -> returnToWorkflows()
                    else -> returnToList()
                }
        }
    }

    BackHandler(
        !showWorkflows &&
            !showArtifacts &&
            !showingConnectors &&
            (codeVisit != null ||
                settings != null ||
                showWorkspaceBack ||
                searchActive ||
                findVisit != null),
        onBack = {
            if (codeVisit != null) closeCodeReader()
            else if (
                settings == null &&
                    searchActive &&
                    (listWidth == null || navigation.search == SearchRoute.Open)
            )
                closeSearch()
            else back()
        },
    )

    val controlThreadId =
        if (showWorkflows || showingConnectors || showArtifacts) null
        else
            when (target) {
                is WorkspaceTarget.Chat ->
                    target.id.takeIf { thread != null || awaitingCreatedChat }
                is WorkspaceTarget.NewChat -> createdId
                else -> null
            }
    val runActions =
        if (
            settings == null &&
                controlThreadId != null &&
                controls != null &&
                pendingNewChat == null &&
                (!searchActive || listWidth != null)
        )
            conversationRunControls(
                controls,
                checkNotNull(chats).history,
                controlThreadId,
                composer,
            )
        else null
    val conversationMissing = runActions?.confirmed?.phase == HistoryPhase.Missing
    LaunchedEffect(inlineArtifactLink, conversationMissing) {
        if (inlineArtifactLink != null && conversationMissing) closeResources()
    }
    val actionableThread = thread.takeUnless { conversationMissing }
    val visibleConversationId =
        (actionableThread?.id
                ?: provisionalId?.takeIf { it == controlThreadId && !conversationMissing })
            ?.takeIf {
                settings == null &&
                    !showWorkflows &&
                    !showingConnectors &&
                    !showArtifacts &&
                    resourcesId == null &&
                    inlineArtifactLink == null &&
                    codeVisit == null &&
                    !showingFind &&
                    (listWidth != null || !searchActive)
            }
    // The transcript and complete source are destinations within the same live visit.
    val conversationReadVisit =
        if (
            chats != null &&
                codeThread != null &&
                !awaitingCreatedChat &&
                (visibleConversationId != null || codeVisit != null)
        ) {
            val generation =
                runActions?.confirmed?.generation
                    ?: chats.history.uiState.collectAsStateWithLifecycle().value.generation
            rememberConversationReadVisit(chats.history, codeThread, generation, visible = true)
        } else null
    if (codeVisit != null) {
        SideEffect { conversationReadVisit?.value?.showRunActivity(null) }
    }
    if (visibleConversationId != null) {
        DisposableEffect(chats, visibleConversationId) {
            codeReading.showFeedbackFor(visibleConversationId)
            onDispose {
                // The destination can already have its own navigation error.
                conversationNavigationErrors.removeAll { it.threadId == visibleConversationId }
                codeReading.showFeedbackFor(null)
            }
        }
    }
    DisposableEffect(controls, visibleConversationId) {
        controls?.showActionFeedbackFor(visibleConversationId)
        onDispose { controls?.showActionFeedbackFor(null) }
    }
    if (renameFocus != null) {
        val originVisible =
            when (renameFocus) {
                is WorkspaceRenameTarget.Chat ->
                    if (renameFocus.fromConversation) visibleConversationId == renameFocus.id
                    else showChatList
                is WorkspaceRenameTarget.Project -> showChatList
            }
        if (!originVisible) LaunchedEffect(renameFocus) { finishRenameFocus(renameFocus) }
    }
    // Workflow history also shows feedback from chat operations.
    if (chats != null) {
        val creation = projectCreation
        if (creation?.phase == ProjectCreatePhase.Confirmed) {
            val filter = listState.value.filter
            LaunchedEffect(creation, filter, projectCreationEditor) {
                if (
                    projectCreationEditor != null &&
                        normalizedRenameName(projectCreationEditor.field.input.text) !=
                            creation.name
                ) {
                    chats.dismissProjectCreation()
                    return@LaunchedEffect
                }
                val projectId =
                    creation.id.takeIf { id ->
                        projectCreationEditor != null &&
                            listState.value.projects.any { it.id == id }
                    }
                if (projectId != null) {
                    if (filter != ChatListFilter.Inbox) {
                        chats.selectFilter(ChatListFilter.Inbox)
                        return@LaunchedEffect
                    }
                    keyboard?.hide()
                    projectExpansion?.setExpanded(projectId, true)
                }
                namePresentation?.finishProjectCreation(projectId)
                chats.dismissProjectCreation()
            }
        }
        if (projectCreationEditor != null) {
            CreateProjectSheet(
                projectCreationEditor,
                creation?.phase,
                create = chats::createProject,
                dismiss = {
                    val phase = chats.uiState.value.projectList.creation?.phase
                    if (phase?.inProgress != true && phase != ProjectCreatePhase.Confirmed) {
                        val retain = phase == ProjectCreatePhase.Unconfirmed
                        namePresentation.closeProjectCreation(projectCreationEditor, retain)
                        if (!retain) chats.dismissProjectCreation()
                    }
                },
            )
        }
        WorkspaceChatFeedback(
            chats,
            listState,
            snackbar,
            conversationSnackbar,
            showChatList,
            listNavigationError =
                listNavigationErrors.firstOrNull().takeIf { showListNavigationFeedback },
            dismissListNavigationError = { listNavigationErrors.remove(it) },
            onFocusedListUndo = { listUndoFocus.returningFrom(it, InputMode.Keyboard) },
            onFocusedConversationUndo = { resourcesFocus.requestFocus() },
            provisionalChats = provisionalChats,
            visibleConversationId = visibleConversationId,
            navigationError =
                conversationNavigationErrors.firstOrNull { it.threadId == visibleConversationId },
            dismissNavigationError = { conversationNavigationErrors.remove(it) },
            runControls = runActions,
            codeFeedback =
                codeReading.previewFeedback.takeIf { visibleConversationId != null }.orEmpty(),
            dismissCodeFeedback = codeReading::dismissFeedback,
            visibleWorkflowId = workflowRoute.id.takeIf { showWorkflows },
            confirmingProjectDelete = confirmingProjectDelete,
            dismissProjectDelete = { confirmingProjectDelete = null },
            renameEditor = renameEditor,
            dismissRename = { namePresentation?.dismiss(it) },
        )
    }

    if (showWorkflows && workflowInput != null) {
        val creation = stringResource(R.string.workflow_creation_prompt)
        workflowPageState.SaveableStateProvider("workflow") {
            WorkflowScreen(
                model = workflows,
                state = workflowInput.value,
                route = workflowRoute,
                changeRoute = {
                    if (it.id != workflowRoute.id && workflowDraftError?.workflowId != null)
                        workflowDraftError = null
                    changeWorkflowRoute(it.copy(draftReturn = null))
                },
                query = workflowQuery,
                positions = workflowPositions,
                listWidth = listWidth,
                timezone = workflowTimezone,
                handoffPending = handoffPending,
                createError = workflowDraftError?.takeIf { it.workflowId == null }?.message,
                useError =
                    workflowDraftError?.takeIf { it.workflowId == workflowRoute.id }?.message,
                readAnnouncements = readAnnouncements,
                detailPaneFeedback = { readErrors, detailSnackbar ->
                    WorkspaceWorkflowFeedback(
                        chats,
                        listState,
                        workflowRoute.id,
                        readErrors,
                        detailSnackbar,
                    )
                },
                onClose = ::closeWorkflows,
                directEntry =
                    workflowOrigin.search.isOpen || workflowRoute.resourceReturnRow != null,
                onCreate = { focused ->
                    workflowDraft(
                        "$creation\n\n",
                        draftReturn = WorkflowDraftReturn(WorkflowDraftAction.Create, focused),
                    )
                },
                onUse = { detail, focused ->
                    workflowDraft(
                        "/${detail.name} ",
                        detail.id,
                        draftReturn = WorkflowDraftReturn(WorkflowDraftAction.Use, focused),
                    )
                },
                onDraftFocusRestored = { workflowRoute = workflowRoute.copy(draftReturn = null) },
                onViewConnection =
                    if (canOpenConnectors) {
                        { slug, ruleId ->
                            focus.clearFocus()
                            keyboard?.hide()
                            workflowConnectionReturn = null
                            workflowConnectorVisit = WorkflowConnectorVisit(slug, ruleId)
                        }
                    } else null,
                connectionReturn = workflowConnectionReturn,
                onConnectionFocusRestored = { workflowConnectionReturn = null },
                sourceChatAvailable = { id ->
                    list.threads.any { it.id == id && it.hidden != true }
                },
                historyReturnFocus = workflowHistoryReturnFocus,
                onOpenChat = { runId, threadId ->
                    if (!handoffPending) {
                        list.threads
                            .firstOrNull { it.id == threadId && it.hidden != true }
                            ?.let {
                                workflowHistoryReturnFocus.returningFrom(
                                    runId,
                                    returnInputMode.inputMode,
                                )
                                openChat(it)
                                changeWorkflowRoute(workflowRoute.copy(mode = WorkflowsMode.Chat))
                            }
                    }
                },
            )
        }
        return
    }

    if (showingConnectors) {
        ConnectorsPage(
            connectors,
            listWidth,
            initialSlug = workflowConnectorVisit?.slug ?: chatConnectorVisit?.slug,
            initialAccountId = chatConnectorVisit?.accountId,
        ) {
            workflowConnectionReturn = workflowConnectorVisit
            workflowConnectorVisit = null
            chatConnectorVisit = null
            connectorsOpen = false
        }
        return
    }

    if (showArtifacts) {
        artifactPageState.SaveableStateProvider("artifacts") {
            ArtifactsRoute(
                artifacts,
                list.threads,
                listWidth,
                onClose = { closeArtifacts(restoreFocus = searchArtifactId == null) },
                searchArtifactId = searchArtifactId,
                onSource = { source ->
                    leaveWorkflowChat()
                    clearConversationLinks()
                    closeFind()
                    conversations.open(source.id)
                    navigation =
                        navigation.copy(
                            artifacts = navigation.artifacts?.copy(sourceId = source.id),
                        )
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
            SettingsDestination.ProactiveServices ->
                stringResource(R.string.settings_proactive_services)
            SettingsDestination.BuiltInTools -> stringResource(R.string.settings_built_in_tools)
            SettingsDestination.Account -> stringResource(R.string.settings_account_security)
            null ->
                when (target) {
                    WorkspaceTarget.List ->
                        stringResource(
                            if (wideWelcome) R.string.composer_new else R.string.app_name,
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
    val stopPlacement = remember(controlThreadId) { ConversationStopPlacement() }
    // A resource visit owns its list position while its workflow is open.
    val canOpenQueue = controlThreadId != null && navigation.chatResourcesId == null
    val queueOpenState = if (canOpenQueue) rememberConversationQueueFlag(controlThreadId) else null
    val queueOpen = queueOpenState?.value == true
    // The queue can move a notice between windows without restarting its accessible timeout.
    WorkspaceFeedbackTimeout(conversationSnackbar)
    val queuePosition = if (queueOpen) key(controlThreadId) { rememberLazyListState() } else null
    val queueTrigger = remember(controlThreadId) { FocusRequester() }
    var queueTriggerFocused by remember(controlThreadId) { mutableStateOf(false) }
    val restoreQueueTrigger =
        if (canOpenQueue) rememberConversationQueueFlag(controlThreadId) else null

    val queueCount =
        runActions?.takeIf { canOpenQueue && !conversationMissing }?.presentation?.queue?.size ?: 0
    LaunchedEffect(conversationMissing) {
        if (conversationMissing) queueOpenState?.value = false
    }
    LaunchedEffect(queueOpen, queueCount) {
        if (!queueOpen && restoreQueueTrigger?.value == true) {
            restoreQueueTrigger.value = false
            if (queueCount > 0) queueTrigger.requestFocus()
        }
    }
    fun rowAction(id: String, action: ChatRowAction, fromConversation: Boolean = false) {
        val started =
            chats?.performRowAction(
                id,
                action,
                fromConversation,
                feedbackWorkflowId =
                    workflowRoute.id.takeIf {
                        action == ChatRowAction.Delete && fromConversation && chatFromWorkflows
                    },
            ) == true
        if (
            started && action == ChatRowAction.Delete && (target as? WorkspaceTarget.Chat)?.id == id
        ) {
            if (chatFromWorkflows) returnToWorkflows() else returnToList()
        }
    }
    val inputMode = LocalInputModeManager.current
    var moveTarget by remember(chats) { mutableStateOf<ChatMoveTarget?>(null) }
    var moveFocus by remember(chats) { mutableStateOf<ProjectMoveFocus?>(null) }
    LaunchedEffect(showChatList) { if (!showChatList) moveFocus = null }
    fun moveChat(from: ChatMoveTarget, destination: String?) {
        if (
            chats?.moveThreadToProject(
                from.threadId,
                destination,
                fromConversation = !from.fromList,
            ) == true &&
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
            if (!conversationMissing && !stopPlacement.inline && runActions?.currentRunId != null)
                ConversationStopButton(runActions, stopPlacement, inline = false)
            if (queueCount > 0) {
                ConversationQueueButton(
                    queueCount,
                    onClick = {
                        restoreQueueTrigger?.value = queueTriggerFocused
                        queueOpenState?.value = true
                    },
                    modifier =
                        Modifier.focusRequester(queueTrigger).onFocusChanged {
                            queueTriggerFocused = it.isFocused
                        },
                )
            }
            ConversationToolbarActions(
                state = listState.value,
                thread = actionableThread,
                onRowAction = { id, action -> rowAction(id, action, fromConversation = true) },
                onMove = { requestMove(it, fromList = false) },
                onRename = { id, restore ->
                    namePresentation?.openChat(
                        id,
                        fromConversation = true,
                        restoreFocus = restore,
                        list = listState.value,
                    )
                },
                renameFocus =
                    (renameFocus as? WorkspaceRenameTarget.Chat)?.takeIf {
                        it.fromConversation && it.id == visibleConversationId
                    },
                onRenameFocusFinished = ::finishRenameFocus,
                openResources =
                    actionableThread
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
                actionsFocus = resourcesFocus,
                onFind =
                    actionableThread?.let { selected ->
                        { restoreFocus ->
                            val find = findVisit
                            if (find != null) {
                                find.returnToResults(returnInputMode.inputMode)
                            } else {
                                val history = chats?.history
                                val transcript =
                                    history
                                        ?.uiState
                                        ?.value
                                        ?.takeIf { it.thread?.id == selected.id }
                                        ?.transcript
                                val rows = history?.checkpoint(selected.id)?.rows.orEmpty()
                                findVisit =
                                    ConversationFindVisit(
                                        transcript,
                                        rows,
                                        chatArtifacts != null,
                                        restoreFocus,
                                        chatArtifacts?.inlineImages?.names(selected.id),
                                    )
                            }
                        }
                    },
            )
            LaunchedEffect(Unit) {
                if (restoreConversationActionsFocus && actionableThread != null) {
                    restoreConversationActionsFocus = false
                    resourcesFocus.requestFocus()
                }
            }
        }

    val toolbarActions =
        @Composable {
            if (settings == null && !searchActive) {
                WorkspaceToolbarActions(
                    showFilter = showList,
                    list = listState.value,
                    selectFilter = listOwner?.let { it::selectFilter },
                    markAllRead = chats?.let { it::markAllRead },
                    update = updateToolbarAction.takeIf { showList },
                    settingsFocus = settingsFocus,
                    openSettings =
                        if (listOwner == null) null
                        else
                            { restore ->
                                restoreSettingsFocus = restore
                                focus.clearFocus()
                                keyboard?.hide()
                                navigation =
                                    navigation.copy(settings = SettingsDestination.Overview)
                            },
                    openProjectCreation =
                        namePresentation?.takeIf { chats != null }?.let { it::openProjectCreation },
                )
                if (namePresentation?.restoreCreationFocus == true) {
                    LaunchedEffect(namePresentation) {
                        settingsFocus.requestFocus()
                        namePresentation.finishCreationFocus()
                    }
                }
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
                    openWorkflows = if (workflows != null) ({ openWorkflows() }) else null,
                    workflowsFocus = workflowsFocus,
                    onWorkflowsFocusChanged = { workflowEntryFocused = it },
                    openArtifacts = if (artifacts != null) ({ openArtifacts() }) else null,
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
            LaunchedEffect(chatFromWorkflows) {
                if (restoreSearchFocus) {
                    restoreSearchFocus = false
                    searchEntryFocus.requestFocus()
                }
                if (restoreWorkflowFocus && !chatFromWorkflows && workflows != null) {
                    restoreWorkflowFocus = false
                    workflowsFocus.requestFocus()
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
                                modifier = Modifier.padding(start = 8.dp),
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
                                        },
                                ),
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
                            containerColor = MaterialTheme.colorScheme.background,
                        ),
                    navigationIcon = {
                        if (settings != null || showWorkspaceBack || findVisit?.target != null)
                            IconButton(
                                modifier =
                                    Modifier.padding(start = if (settings != null) 8.dp else 0.dp),
                                onClick = {
                                    focus.clearFocus()
                                    keyboard?.hide()
                                    back()
                                },
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
                                        else R.string.back,
                                    ),
                                )
                            }
                    },
                    actions = { if (settings == null) detailActions() },
                )
                if (settings == null)
                    HorizontalDivider(
                        Modifier.align(Alignment.BottomCenter),
                        color = MaterialTheme.colorScheme.outlineVariant,
                    )
            }
        }

    Scaffold(
        modifier =
            Modifier.fillMaxSize()
                .onGloballyPositioned { stopPlacement.contentCoordinates = it }
                .pointerInput(stopPlacement) {
                    awaitEachGesture {
                        val down =
                            awaitFirstDown(
                                requireUnconsumed = false,
                                pass = PointerEventPass.Initial,
                            )
                        stopPlacement.onContentPress(down.position)
                    }
                },
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets.safeDrawing,
        snackbarHost = {
            if (!showChatList && visibleConversationId == null) {
                // The visible host can move into the model picker during the same notice.
                WorkspaceFeedbackTimeout(snackbar)
                if (!feedbackInOverlay)
                    WorkspaceFeedbackHost(
                        snackbar,
                        Modifier.padding(bottom = if (settings != null) 8.dp else 16.dp),
                        manageTimeout = false,
                    )
            }
        },
        topBar = {
            if (!showingFind && codeVisit == null) {
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
                SettingsPage(subpagePosition, progress = { settingsProgress(settings) }) {
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
                                val remote =
                                    workspaceSearch?.results?.collectAsStateWithLifecycle()?.value
                                val workflowState = workflowInput?.value
                                val workflowRead =
                                    remember(
                                        workflowState?.catalog,
                                        workflowState?.catalogRefreshing,
                                        workflowState?.catalogFailure,
                                        searchState.keyword,
                                    ) {
                                        if (searchState.keyword.isEmpty()) null
                                        else workflowState?.searchCatalog(searchState.keyword)
                                    }
                                val selectedWorkflowId = searchWorkflowId
                                val intro =
                                    remember(workflowState?.catalog, selectedWorkflowId) {
                                        selectedWorkflowId?.let {
                                            workflowState?.searchWorkflowById(it)
                                        }
                                    }
                                val unavailableWorkflowId = selectedWorkflowId.takeIf {
                                    workflowRead == SearchRead.Failed ||
                                        workflowRead == SearchRead.AccessLost ||
                                        workflowRead is SearchRead.Ready && intro == null
                                }
                                LaunchedEffect(unavailableWorkflowId) {
                                    if (
                                        unavailableWorkflowId != null &&
                                            searchWorkflowId == unavailableWorkflowId
                                    ) {
                                        dismissWorkflowIntro()
                                    }
                                }
                                val recents =
                                    workspaceSearch
                                        ?.recentlyOpened
                                        ?.collectAsStateWithLifecycle()
                                        ?.value
                                WorkspaceSearchScreen(
                                    state = listState.value,
                                    search = searchState,
                                    widthDp = window.width,
                                    listWidth = listWidth,
                                    focusOnEntry = focusSearch,
                                    onFocused = { focusSearch = false },
                                    onInputFocusGained = {
                                        // A late Find result must yield to focus in this pane.
                                        findVisit?.returnFocus?.cancel()
                                    },
                                    onClose = ::closeSearch,
                                    resolveMessageChats = chats::resolveSearchChats,
                                    onOpen = {
                                        leaveWorkflowChat()
                                        openChat(it, fromSearch = true)
                                    },
                                    remote = remote,
                                    workflowResults = workflowRead,
                                    workspacePreparation =
                                        when {
                                            workspaceReady -> null
                                            startupRecovery == null -> SearchRead.Loading
                                            else -> SearchRead.Failed
                                        },
                                    recentlyOpened = recents.orEmpty(),
                                    onOpenMessage = ::openSearchMessage,
                                    restoreResultFocus = selectedWorkflowId == null,
                                    onMoreArtifacts = { term, cursor ->
                                        workspaceSearch?.nextArtifacts(term, cursor)
                                    },
                                    onOpenWorkflow =
                                        if (!searchWorkflowsAvailable) null
                                        else
                                            { hit ->
                                                releaseSearchFocus()
                                                workflowDraftError = null
                                                searchWorkflowId = hit.id
                                            },
                                    onOpenArtifact =
                                        if (!searchArtifactsAvailable) null
                                        else { hit -> openArtifacts(hit.id) },
                                )
                                if (searchWorkflowsAvailable && intro != null) {
                                    SearchWorkflowIntro(
                                        intro,
                                        canStartDraft = workspaceReady,
                                        pending = handoffPending,
                                        failed = workflowDraftError?.workflowId == intro.id,
                                        onClose = ::dismissWorkflowIntro,
                                        onUse = {
                                            workflowDraft(
                                                "/${intro.name} ",
                                                intro.id,
                                                fromSearch = true,
                                            )
                                        },
                                        onOpenDetails = { openWorkflows(intro.id) },
                                    )
                                }
                            } else {
                                if (listWidth != null) listToolbar()
                                val list = listState.value
                                ChatListScreen(
                                    list,
                                    composerInput,
                                    {
                                        if (target != WorkspaceTarget.Chat(it.id))
                                            leaveWorkflowChat()
                                        openChat(it)
                                    },
                                    provisionalChats,
                                    ::openProvisionalChat,
                                    { id, action -> rowAction(id, action) },
                                    { requestMove(it, fromList = true) },
                                    moveFocus = moveFocus,
                                    onMoveFocusFinished = { request ->
                                        if (moveFocus == request) moveFocus = null
                                    },
                                    renameThread = { id, restore ->
                                        namePresentation?.openChat(
                                            id,
                                            fromConversation = false,
                                            restoreFocus = restore,
                                            list = listState.value,
                                        )
                                    },
                                    renameProject = { id, restore ->
                                        namePresentation?.openProject(
                                            id,
                                            restore,
                                            listState.value,
                                        )
                                    },
                                    renamingProjectId =
                                        (renameTarget as? WorkspaceRenameTarget.Project)?.id,
                                    renameFocus = renameFocus,
                                    onRenameFocusFinished = ::finishRenameFocus,
                                    { id -> confirmingProjectDelete = id },
                                    confirmingProjectDelete,
                                    projectExpansion,
                                    listPositions[list.filter.ordinal],
                                    undoReturnFocus = listUndoFocus,
                                    newChat = ::startNewChat,
                                    showInbox = { listOwner?.selectFilter(ChatListFilter.Inbox) },
                                    selectedChatId =
                                        if (listWidth != null)
                                            (target as? WorkspaceTarget.Chat)?.id ?: provisionalId
                                        else null,
                                    wide = listWidth != null,
                                    newChatEnabled = workspaceReady,
                                    chatActionsEnabled = chats != null,
                                    startupSyncPending =
                                        cachedStartupChats != null && startupRecovery == null,
                                    startupRecovery = startupRecovery,
                                    dismissProjectRenameRejection = {
                                        chats?.dismissProjectRenameRejection(it)
                                    },
                                    feedback = {
                                        WorkspaceFeedbackHost(
                                            snackbar,
                                            Modifier.testTag("chat_list_feedback"),
                                            restorePaneFocus = { settingsFocus.requestFocus() },
                                        )
                                    },
                                )
                            }
                        }
                    }
                    if (listWidth != null && showList) VerticalDivider()
                    if (
                        chats != null &&
                            (codeVisit != null ||
                                listWidth != null ||
                                (!searchActive && target != WorkspaceTarget.List))
                    ) {
                        Column(
                            Modifier.weight(1f).fillMaxHeight(),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) detailPane@{
                            if (codeVisit != null) {
                                key(codeVisit.threadId, codeVisit.target) {
                                    ConversationFullCode(
                                        chats.history,
                                        runActions?.presentation,
                                        codeVisit,
                                        wide = listWidth != null,
                                        back = ::closeCodeReader,
                                        expand = codeReading::toggleExpanded,
                                    )
                                }
                                return@detailPane
                            }
                            if (
                                inlineArtifactLink != null &&
                                    chatArtifacts != null &&
                                    !conversationMissing
                            ) {
                                inlineArtifactPageState.SaveableStateProvider(
                                    "chat-artifact-link",
                                ) {
                                    val visit =
                                        chatArtifacts.chatImageVisit?.takeIf {
                                            it.initialLink == inlineArtifactLink &&
                                                it.threadId == (thread?.id ?: provisionalId)
                                        }
                                    val close = { closeResources(returnToCard = true) }
                                    if (visit != null) {
                                        ChatImageViewer(
                                            chatArtifacts,
                                            visit,
                                            listWidth != null,
                                            close,
                                        )
                                    } else {
                                        ChatArtifactLinkPreview(
                                            chatArtifacts,
                                            inlineArtifactLink,
                                            listWidth != null,
                                            inlineImage =
                                                imageFocusReply(navigation.chatArtifactFocusKey) !=
                                                    null,
                                            onClose = close,
                                        )
                                    }
                                }
                                return@detailPane
                            }
                            if (resourcesId != null && chatArtifacts != null) {
                                val conversation by
                                    chats.history.uiState.collectAsStateWithLifecycle()
                                LifecycleStartEffect(chats.history, resourcesId) {
                                    chats.history.invalidate(resourcesId)
                                    onStopOrDispose {}
                                }
                                val availableChats =
                                    remember(list.threads) {
                                        list.threads
                                            .filter { it.hidden != true }
                                            .associate { it.id to it.title }
                                    }
                                resourcesPageState.SaveableStateProvider(
                                    "chat-resources:$resourcesId",
                                ) {
                                    ChatArtifactResources(
                                        chatArtifacts,
                                        resourcesId,
                                        listWidth != null,
                                        onClose = { closeResources(returnToActions = true) },
                                        history =
                                            conversation.takeIf { it.thread?.id == resourcesId }
                                                ?: ConversationUiState(),
                                        resourceFocusKey = linkFocusKey,
                                        availableRelatedChats = availableChats,
                                        onResourceFocusTaken = { linkFocusKey = null },
                                        onOpenLink = { link, key ->
                                            openMessageLink(
                                                link,
                                                ConversationLinkSource(key, null),
                                            )
                                        },
                                        onOpenWorkflow =
                                            if (workflows != null) {
                                                { id, key ->
                                                    openWorkflows(id, WorkflowTab.Automations, key)
                                                }
                                            } else null,
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
                            val contentWidth = Modifier.widthIn(max = ConversationContentMaxWidth)
                            Column(
                                Modifier.fillMaxWidth().weight(1f).imePadding(),
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                when (target) {
                                    is WorkspaceTarget.Chat ->
                                        conversations.Content(target.id) {
                                            val composerTarget = actionableThread?.let {
                                                ComposerTarget(
                                                    threadId = it.id,
                                                    projectId = it.projectId,
                                                )
                                            }
                                            var followup by
                                                remember(composerTarget) {
                                                    mutableStateOf<String?>(null)
                                                }
                                            val hasComposer =
                                                composerTarget != null &&
                                                    pendingNewChat == null &&
                                                    composer != null &&
                                                    controls != null
                                            ConversationRoute(
                                                chats.history,
                                                target.id,
                                                listState.value,
                                                Modifier.weight(1f),
                                                composer = composer,
                                                historyAvailable = !awaitingCreatedChat,
                                                controls = runActions,
                                                stopPlacement = stopPlacement,
                                                feedback =
                                                    conversationSnackbar.takeIf {
                                                        visibleConversationId == target.id &&
                                                            !conversationFeedbackInOptions
                                                    },
                                                feedbackBottomPadding =
                                                    if (hasComposer) 8.dp - ChatComposerTopInset
                                                    else 8.dp,
                                                restorePaneFocus = {
                                                    resourcesFocus.requestFocus()
                                                },
                                                queueOpen = queueOpen,
                                                queuePosition = queuePosition,
                                                dismissQueue = { queueOpenState?.value = false },
                                                codeReading = codeReading,
                                                readVisit = conversationReadVisit,
                                                onFollowup =
                                                    if (hasComposer) { prompt -> followup = prompt }
                                                    else null,
                                                artifactActions =
                                                    thread?.let {
                                                        conversationArtifactActions(it.id)
                                                    },
                                                findTarget = find?.target,
                                                linkPosition = linkPosition,
                                                onLink = ::openMessageLink,
                                                linkFocusKey = linkFocusKey,
                                                onLinkFocusRestored = { linkFocusKey = null },
                                                onLinkUnavailable =
                                                    linkedFrom?.let { source ->
                                                        { returnFromUnavailableLink(source) }
                                                    },
                                                searchMessageAnchor =
                                                    navigation.searchMessageAnchor.takeIf {
                                                        artifactSource == null &&
                                                            navigation.target == target
                                                    },
                                                onSearchMessageResolved = { anchor, found ->
                                                    if (
                                                        navigation.target == target &&
                                                            navigation.searchMessageAnchor == anchor
                                                    ) {
                                                        navigation =
                                                            navigation.copy(
                                                                searchMessageAnchor = null,
                                                            )
                                                        if (!found) {
                                                            showConversationNavigationError(
                                                                target.id,
                                                                missingMessage,
                                                            )
                                                        }
                                                    }
                                                },
                                            ) { failure ->
                                                if (
                                                    recovery != null &&
                                                        composer != null &&
                                                        composerTarget != null
                                                )
                                                    AssistantRecoveryPanel(
                                                        recovery,
                                                        composer,
                                                        composerTarget,
                                                        failureId = failure.id,
                                                        reason = failure.failureReason,
                                                    )
                                                else AssistantFailureCard(failure.failureReason)
                                            }
                                            Column(
                                                contentWidth.fillMaxWidth(),
                                                horizontalAlignment = Alignment.CenterHorizontally,
                                            ) {
                                                if (hasComposer) {
                                                    val modelEdits by
                                                        remember(listState, actionableThread.id) {
                                                            derivedStateOf {
                                                                listState.value
                                                                    .conversationModelEdits[
                                                                        actionableThread.id]
                                                            }
                                                        }
                                                    ChatComposerField(
                                                        composer,
                                                        composerTarget,
                                                        stopPlacement = stopPlacement,
                                                        appBarHeight = appBarHeight,
                                                        attachmentPicker = attachmentPicker,
                                                        openUploadedAttachment =
                                                            openComposerAttachment,
                                                        attachmentImages =
                                                            chatArtifacts?.inlineImages,
                                                        followup = followup,
                                                        onFollowupInserted = { followup = null },
                                                        defaultModel = defaultModel,
                                                        conversationModel =
                                                            ConversationModelControls(
                                                                chats,
                                                                actionableThread,
                                                                modelEdits,
                                                            ),
                                                        conversationSnackbar =
                                                            conversationSnackbar.takeIf {
                                                                visibleConversationId == target.id
                                                            },
                                                        onOptionsFeedbackInOverlay = {
                                                            conversationFeedbackInOptions = it
                                                        },
                                                        connectorOptions =
                                                            connectors?.chatOptions.takeIf {
                                                                canOpenConnectors
                                                            },
                                                        manageConnectors = {
                                                            manageChatConnectors(
                                                                composerTarget,
                                                                it,
                                                            )
                                                        },
                                                    )
                                                }
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
                                                    controls = runActions,
                                                    stopPlacement = stopPlacement,
                                                    feedback =
                                                        conversationSnackbar.takeIf {
                                                            visibleConversationId == provisionalId
                                                        },
                                                    restorePaneFocus = {
                                                        resourcesFocus.requestFocus()
                                                    },
                                                    artifactActions =
                                                        conversationArtifactActions(provisionalId),
                                                    queueOpen = queueOpen,
                                                    queuePosition = queuePosition,
                                                    dismissQueue = {
                                                        queueOpenState?.value = false
                                                    },
                                                )
                                            }
                                        } else {
                                            Box(contentWidth.weight(1f)) {
                                                if (workspaceReady) {
                                                    val welcome =
                                                        if (wideWelcome)
                                                            Modifier.testTag("workspace_new_chat")
                                                        else Modifier
                                                    NewConversationWelcome(welcome)
                                                }
                                            }
                                        }
                                        if (
                                            createdId == null &&
                                                newTarget != null &&
                                                composer != null
                                        ) {
                                            Column(contentWidth.fillMaxWidth()) {
                                                conversations.Content(newTarget.key) {
                                                    ChatComposerField(
                                                        composer,
                                                        newTarget,
                                                        stopPlacement = stopPlacement,
                                                        appBarHeight = appBarHeight,
                                                        attachmentPicker = attachmentPicker,
                                                        openUploadedAttachment =
                                                            openComposerAttachment,
                                                        attachmentImages =
                                                            chatArtifacts?.inlineImages,
                                                        defaultModel = defaultModel,
                                                        connectorOptions =
                                                            connectors?.chatOptions.takeIf {
                                                                canOpenConnectors
                                                            },
                                                        manageConnectors = {
                                                            manageChatConnectors(newTarget, it)
                                                        },
                                                        beforeSend = {
                                                            if (wideWelcome) startNewChat(null)
                                                        },
                                                    )
                                                }
                                            }
                                        }
                                    }
                                }
                                if (awaitingCreatedChat || createdId != null) {
                                    Box(contentWidth.fillMaxWidth()) {
                                        TextButton(
                                            onClick = chats::retryList,
                                            enabled =
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
}

internal data class WorkspaceChatNavigation(
    val threads: List<ConfirmedChat>,
    val projects: List<ConfirmedProject>,
    val acceptedNewChats: List<ProvisionalChat>,
    val listPhase: ChatReadPhase,
    val projectsPhase: ChatReadPhase,
    val projectsSource: ChatListSource?,
)

@Composable
internal fun rememberWorkspaceChatNavigation(
    listState: State<ChatListUiState>,
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
        !supportsWorkspacePanes(widthDp, heightDp) -> null
        widthDp >= 1100 -> 344
        else -> 320
    }
