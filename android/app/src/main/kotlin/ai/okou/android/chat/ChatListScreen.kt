package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.api.generated.IndicatorsThreadsValue
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch

@Composable
fun ChatListRoute(model: ChatListModel, composer: ChatComposerModel) {
    val state by model.uiState.collectAsStateWithLifecycle()
    val inputState by composer.uiState.collectAsStateWithLifecycle()
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var composing by rememberSaveable { mutableStateOf(false) }
    var newProject by rememberSaveable { mutableStateOf<String?>(null) }
    var collapsed by rememberSaveable { mutableStateOf(emptyList<String>()) }
    val listPosition = rememberLazyListState()
    val drawerPosition = rememberLazyListState()
    val conversations = rememberSaveableStateHolder()
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val drawerVisible = selected != null && (drawer.isOpen || drawer.isAnimationRunning)
    val scope = rememberCoroutineScope()
    LaunchedEffect(selected, state.threads, state.listPhase) {
        state.threads.firstOrNull { it.id == selected }?.let(model.history::open)
        if (
            selected != null &&
                state.listPhase == ChatReadPhase.Ready &&
                state.threads.none { it.id == selected }
        )
            selected = null
    }
    val open: (ConfirmedChat) -> Unit = { thread ->
        composing = false
        selected = thread.id
        composer.acknowledge(thread.id)
        model.history.open(thread)
        scope.launch { drawer.close() }
    }
    val toggle: (String) -> Unit = { id ->
        collapsed = if (id in collapsed) collapsed - id else collapsed + id
    }
    val newChat: (String?) -> Unit = { projectId ->
        composer.beginNew(projectId)
        selected = null
        newProject = projectId
        composing = true
        scope.launch { drawer.close() }
    }
    val createdThread = inputState.entry(ComposerTarget(projectId = newProject)).createdThreadId
    LaunchedEffect(composing, newProject, createdThread, state.threads) {
        if (composing && createdThread != null)
            state.threads.firstOrNull { it.id == createdThread }?.let(open)
    }
    BackHandler(selected != null || composing) {
        if (drawer.isOpen || drawer.isAnimationRunning) scope.launch { drawer.close() }
        else {
            selected = null
            composing = false
        }
    }
    ModalNavigationDrawer(
        drawerState = drawer,
        gesturesEnabled = selected != null,
        drawerContent = {
            ModalDrawerSheet(
                Modifier.widthIn(max = 360.dp)
                    .fillMaxWidth()
                    .then(if (drawerVisible) Modifier else Modifier.clearAndSetSemantics {})
            ) {
                ChatListScreen(
                    state,
                    model::refresh,
                    model::refreshList,
                    model::refreshMetadata,
                    model::refreshIndicators,
                    model::selectFilter,
                    open,
                    collapsed,
                    toggle,
                    drawerPosition,
                    newChat,
                )
            }
        },
    ) {
        if (composing)
            Column(Modifier.fillMaxSize()) {
                ChatAction(R.string.back, { composing = false })
                Text(
                    state.projects.firstOrNull { it.id == newProject }?.name
                        ?: stringResource(R.string.composer_new),
                    Modifier.padding(16.dp),
                    style = MaterialTheme.typography.headlineSmall,
                )
                Box(Modifier.weight(1f))
                if (createdThread != null) {
                    Text(stringResource(R.string.composer_accepted), Modifier.padding(16.dp))
                    ChatAction(R.string.chat_refresh, model::refreshList)
                } else ChatComposerField(composer, ComposerTarget(projectId = newProject))
            }
        else if (selected == null)
            ChatListScreen(
                state,
                model::refresh,
                model::refreshList,
                model::refreshMetadata,
                model::refreshIndicators,
                model::selectFilter,
                open,
                collapsed,
                toggle,
                listPosition,
                newChat,
            )
        else
            Column(
                Modifier.fillMaxSize()
                    .then(if (drawerVisible) Modifier.clearAndSetSemantics {} else Modifier)
            ) {
                FlowRow {
                    ChatAction(R.string.back, { selected = null })
                    ChatAction(R.string.history_sidebar, { scope.launch { drawer.open() } })
                }
                conversations.SaveableStateProvider(checkNotNull(selected)) {
                    ConversationRoute(
                        model.history,
                        checkNotNull(selected),
                        state,
                        Modifier.weight(1f),
                        visible = !drawer.isOpen && !drawer.isAnimationRunning,
                    )
                }
                state.threads
                    .firstOrNull { it.id == selected }
                    ?.let { thread ->
                        ChatComposerField(
                            composer,
                            ComposerTarget(thread.id, thread.agentId, thread.projectId),
                            Modifier.then(
                                if (drawerVisible) Modifier.clearAndSetSemantics {} else Modifier
                            ),
                        )
                    }
            }
    }
}

@Composable
private fun ChatListScreen(
    state: ChatListUiState,
    refresh: () -> Unit,
    retryList: () -> Unit,
    retryMetadata: () -> Unit,
    refreshIndicators: () -> Unit,
    selectFilter: (ChatListFilter) -> Unit,
    open: (ConfirmedChat) -> Unit,
    collapsed: List<String>,
    toggleProject: (String) -> Unit,
    listState: LazyListState,
    newChat: (String?) -> Unit,
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
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        LazyColumn(
            Modifier.widthIn(max = 760.dp).fillMaxWidth().testTag("chat_list"),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            state = listState,
        ) {
            item {
                Text(
                    stringResource(R.string.chat_list_title),
                    style = MaterialTheme.typography.headlineLarge,
                    modifier = Modifier.semantics { heading() },
                )
                ChatAction(R.string.chat_refresh, refresh, state.listPhase != ChatReadPhase.Loading)
                ChatAction(R.string.composer_new, { newChat(null) })
            }
            item {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(ChatListFilter.entries) { filter ->
                        FilterChip(
                            selected = state.filter == filter,
                            onClick = { selectFilter(filter) },
                            label = { Text(stringResource(filter.label())) },
                        )
                    }
                }
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
            item {
                ChatNotice(
                    when (state.indicatorsPhase) {
                        ChatReadPhase.Ready -> R.string.chat_status_observed
                        ChatReadPhase.Failed -> R.string.chat_status_unavailable
                        else -> R.string.chat_status_loading
                    }
                )
                ChatAction(
                    R.string.chat_refresh_status,
                    refreshIndicators,
                    state.indicatorsPhase != ChatReadPhase.Loading,
                )
            }
            if (state.confirmedAt != null) {
                groups.forEach { group ->
                    if (group.project != null || group.threads.isNotEmpty()) {
                        item(key = "group_${group.project?.id}") {
                            val project = group.project
                            if (project != null)
                                TextButton(
                                    onClick = { toggleProject(project.id) },
                                    colors =
                                        ButtonDefaults.textButtonColors(
                                            contentColor = MaterialTheme.colorScheme.onSurface
                                        ),
                                ) {
                                    Text(
                                        project.name,
                                        style = MaterialTheme.typography.titleMedium,
                                        modifier = Modifier.semantics { heading() },
                                    )
                                }
                            else
                                Text(
                                    stringResource(R.string.chat_outside_projects),
                                    style = MaterialTheme.typography.titleMedium,
                                    modifier = Modifier.semantics { heading() },
                                )
                            if (group.threads.isEmpty())
                                Text(stringResource(R.string.chat_project_empty))
                            if (project != null)
                                ChatAction(R.string.composer_new_project, { newChat(project.id) })
                        }
                        if (group.project?.id !in collapsed)
                            items(group.threads, key = { it.id }) { thread ->
                                ChatRow(thread, state, { open(thread) })
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

@Composable
private fun ChatRow(thread: ConfirmedChat, state: ChatListUiState, open: () -> Unit) {
    val agent = state.agents.firstOrNull { it.agentId == thread.agentId }
    val indicator = state.indicators?.threads?.get(thread.id)
    OutlinedCard(onClick = open, modifier = Modifier.fillMaxWidth().testTag("chat_${thread.id}")) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                thread.title?.takeIf { it.isNotBlank() } ?: stringResource(R.string.chat_untitled),
                style = MaterialTheme.typography.titleMedium,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                agent?.displayName ?: stringResource(R.string.chat_agent_identity, thread.agentId),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (thread.pinnedAt != null) Text(stringResource(R.string.chat_pinned))
                when {
                    indicator == IndicatorsThreadsValue.ACTIVE ->
                        Text(stringResource(R.string.chat_active))
                    indicator == IndicatorsThreadsValue.UNREAD && thread.muted != true ->
                        Text(stringResource(R.string.chat_unread))
                }
                if (thread.muted == true) Text(stringResource(R.string.chat_muted))
            }
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

private fun ChatListFilter.label() =
    when (this) {
        ChatListFilter.Recent -> R.string.chat_recent
        ChatListFilter.Unread -> R.string.chat_unread
        ChatListFilter.Archived -> R.string.chat_archived
        ChatListFilter.Muted -> R.string.chat_muted
    }
