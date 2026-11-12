package ai.okou.android.chat

import ai.okou.android.HomeModel
import ai.okou.android.HomeScreen
import ai.okou.android.R
import ai.okou.android.api.generated.IndicatorsThreadsValue
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun ChatListRoute(model: ChatListModel, home: HomeModel) {
    val state by model.uiState.collectAsStateWithLifecycle()
    if (state.enabled == false) HomeScreen(home)
    else
        ChatListScreen(
            state,
            model::refresh,
            model::refreshList,
            model::refreshMetadata,
            model::refreshIndicators,
            model::selectFilter,
        )
}

@Composable
private fun ChatListScreen(
    state: ChatListUiState,
    refresh: () -> Unit,
    retryList: () -> Unit,
    retryMetadata: () -> Unit,
    refreshIndicators: () -> Unit,
    selectFilter: (ChatListFilter) -> Unit,
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
        state.agentsPhase == ChatReadPhase.Loading ||
            state.projectsEnabled && state.projectsPhase == ChatReadPhase.Loading
    val metadataFailed =
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
        ) {
            item {
                Text(
                    stringResource(R.string.chat_list_title),
                    style = MaterialTheme.typography.headlineLarge,
                    modifier = Modifier.semantics { heading() },
                )
                ChatAction(
                    R.string.chat_refresh,
                    refresh,
                    state.rolloutPhase != ChatReadPhase.Loading,
                )
            }
            if (state.enabled == null) {
                item {
                    ChatNotice(
                        if (state.rolloutPhase == ChatReadPhase.Failed) R.string.chat_load_failed
                        else R.string.chat_loading
                    )
                    if (state.rolloutPhase == ChatReadPhase.Failed)
                        ChatAction(R.string.retry, refresh)
                }
            } else {
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
                if (state.rolloutPhase == ChatReadPhase.Failed)
                    item { ChatNotice(R.string.chat_refresh_failed) }
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
                if (state.cacheUnavailable) item { ChatNotice(R.string.chat_cache_unavailable) }
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
                                Text(
                                    group.project?.name
                                        ?: stringResource(R.string.chat_outside_projects),
                                    style = MaterialTheme.typography.titleMedium,
                                    modifier = Modifier.semantics { heading() },
                                )
                                if (group.threads.isEmpty())
                                    Text(stringResource(R.string.chat_project_empty))
                            }
                            items(group.threads, key = { it.id }) { thread ->
                                ChatRow(thread, state)
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
}

@Composable
private fun ChatRow(thread: ConfirmedChat, state: ChatListUiState) {
    val agent = state.agents.firstOrNull { it.agentId == thread.agentId }
    val indicator = state.indicators?.threads?.get(thread.id)
    OutlinedCard(Modifier.fillMaxWidth().testTag("chat_${thread.id}")) {
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
