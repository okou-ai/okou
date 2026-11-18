package ai.okou.android

import ai.okou.android.chat.AssistantRecoveryModel
import ai.okou.android.chat.AssistantRecoveryPanel
import ai.okou.android.chat.ChatComposerField
import ai.okou.android.chat.ChatComposerModel
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ChatListScreen
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.chat.ConfirmedChat
import ai.okou.android.chat.ConversationRoute
import ai.okou.android.chat.RealtimeNotice
import ai.okou.android.chat.RunControlsModel
import ai.okou.android.chat.RunControlsPanel
import ai.okou.android.state.WorkspaceTarget
import ai.okou.android.state.rememberCollapsedProjects
import ai.okou.android.state.rememberConversationUiState
import ai.okou.android.state.rememberWorkspaceNavigation
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.structuralEqualityPolicy
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun OkouApp(
    chats: ChatListModel,
    composer: ChatComposerModel,
    controls: RunControlsModel,
    appearance: AppearanceUiState,
    selectMode: (AppearanceMode) -> Unit,
    retryAppearance: () -> Unit,
    account: @Composable () -> Unit = {},
    workspacePreferences: @Composable () -> Unit = {},
    recovery: AssistantRecoveryModel? = null,
) {
    val list by chats.uiState.collectAsStateWithLifecycle()
    var navigation by rememberWorkspaceNavigation()
    val target = navigation.target
    val listPosition = rememberLazyListState()
    val collapsed = rememberCollapsedProjects()
    val conversations = rememberConversationUiState()
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val missingChat = stringResource(R.string.history_missing)
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val settingsFocus = remember { FocusRequester() }
    var settingsFocused by remember { mutableStateOf(false) }
    var restoreSettingsFocus by remember { mutableStateOf(false) }
    val thread =
        (target as? WorkspaceTarget.Chat)?.let { chat ->
            list.threads.firstOrNull { it.id == chat.id && it.hidden != true }
        }

    fun openChat(chat: ConfirmedChat) {
        conversations.open(chat.id)
        navigation = navigation.copy(target = WorkspaceTarget.Chat(chat.id))
        composer.acknowledge(chat.id)
        chats.history.open(chat)
    }

    LaunchedEffect(target, thread, list.listPhase) {
        if (target is WorkspaceTarget.Chat) {
            if (thread != null) chats.history.open(thread)
            else if (list.listPhase == ChatReadPhase.Ready && navigation.target == target) {
                navigation = navigation.copy(target = WorkspaceTarget.List)
                scope.launch { snackbar.showSnackbar(missingChat) }
            }
        }
    }
    val newChat = target as? WorkspaceTarget.NewChat
    val newTarget = newChat?.let { ComposerTarget(projectId = it.projectId) }
    val createdId =
        newTarget?.let { draft ->
            val input = composer.uiState.collectAsStateWithLifecycle()
            val created by
                remember(input, draft) {
                    derivedStateOf(structuralEqualityPolicy()) {
                        input.value.entry(draft).createdThreadId
                    }
                }
            created
        }
    val createdChat =
        createdId?.let { id -> list.threads.firstOrNull { it.id == id && it.hidden != true } }
    LaunchedEffect(newChat, createdChat) {
        if (newChat != null && navigation.target == newChat && createdChat != null) {
            openChat(createdChat)
        }
    }

    fun back() {
        navigation =
            if (navigation.settingsOpen) navigation.copy(settingsOpen = false)
            else navigation.copy(target = WorkspaceTarget.List)
    }

    BackHandler(navigation.settingsOpen || target != WorkspaceTarget.List, onBack = ::back)

    val title =
        if (navigation.settingsOpen) stringResource(R.string.settings)
        else
            when (target) {
                WorkspaceTarget.List -> stringResource(R.string.app_name)
                is WorkspaceTarget.Chat ->
                    thread?.title?.takeIf { it.isNotBlank() }
                        ?: stringResource(R.string.chat_untitled)
                is WorkspaceTarget.NewChat ->
                    list.projects.firstOrNull { it.id == target.projectId }?.name
                        ?: stringResource(R.string.composer_new)
            }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets.safeDrawing,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                colors =
                    TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.background
                    ),
                navigationIcon = {
                    if (navigation.settingsOpen || target != WorkspaceTarget.List) {
                        IconButton(
                            onClick = {
                                focus.clearFocus()
                                keyboard?.hide()
                                back()
                            }
                        ) {
                            Icon(painterResource(R.drawable.ic_back), stringResource(R.string.back))
                        }
                    }
                },
                actions = {
                    if (!navigation.settingsOpen) {
                        IconButton(
                            modifier =
                                Modifier.focusRequester(settingsFocus).onFocusChanged {
                                    settingsFocused = it.isFocused
                                },
                            onClick = {
                                restoreSettingsFocus = settingsFocused
                                focus.clearFocus()
                                keyboard?.hide()
                                navigation = navigation.copy(settingsOpen = true)
                            },
                        ) {
                            Icon(
                                painterResource(R.drawable.okou_mark),
                                stringResource(R.string.settings),
                            )
                        }
                        LaunchedEffect(Unit) {
                            if (restoreSettingsFocus) {
                                restoreSettingsFocus = false
                                settingsFocus.requestFocus()
                            }
                        }
                    }
                },
            )
        },
    ) { insets ->
        Column(Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets)) {
            if (navigation.settingsOpen) {
                SettingsScreen(
                    appearance,
                    selectMode,
                    retryAppearance,
                    account,
                    workspacePreferences,
                )
            } else {
                RealtimeNotice(chats.updates)
                when (target) {
                    WorkspaceTarget.List ->
                        ChatListScreen(
                            list,
                            chats::refresh,
                            chats::refreshList,
                            chats::refreshMetadata,
                            chats::refreshIndicators,
                            chats::selectFilter,
                            ::openChat,
                            collapsed.values,
                            collapsed::toggle,
                            listPosition,
                            newChat = { projectId ->
                                composer.beginNew(projectId)
                                conversations.open(ComposerTarget(projectId = projectId).key)
                                navigation =
                                    navigation.copy(target = WorkspaceTarget.NewChat(projectId))
                            },
                        )
                    is WorkspaceTarget.Chat ->
                        conversations.Content(target.id) {
                            ConversationRoute(chats.history, target.id, list, Modifier.weight(1f))
                            if (thread != null) {
                                val composerTarget =
                                    ComposerTarget(thread.id, thread.agentId, thread.projectId)
                                RunControlsPanel(controls, chats.history, thread.id)
                                recovery?.let {
                                    AssistantRecoveryPanel(it, composer, composerTarget)
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
