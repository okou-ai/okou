package ai.okou.android.chat

import ai.okou.android.R
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun ConversationRoute(
    model: ConversationHistoryModel,
    threadId: String,
    list: ChatListUiState,
    modifier: Modifier = Modifier,
    visible: Boolean = true,
) {
    // Capture this composition's value: a deferred effect must not read a newer State.value.
    val state = model.uiState.collectAsStateWithLifecycle().value
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // Restored navigation can mount this route before the history resource selects its thread.
    DisposableEffect(model, threadId, state.generation, lifecycle, visible) {
        fun update() =
            model.setVisible(
                threadId,
                visible && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED),
            )
        val observer = LifecycleEventObserver { _, _ -> update() }
        lifecycle.addObserver(observer)
        update()
        onDispose {
            lifecycle.removeObserver(observer)
            model.setVisible(threadId, false)
        }
    }
    LaunchedEffect(model, state.generation, state.phase, state.confirmation, threadId, visible) {
        if (visible && state.thread?.id == threadId && state.phase == HistoryPhase.Ready)
            model.confirmDisplayed(threadId, state.confirmation)
    }
    key(threadId) {
        val position = rememberLazyListState()
        LazyColumn(
            modifier.fillMaxSize().testTag("conversation"),
            state = position,
            contentPadding = PaddingValues(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            val thread = state.thread?.takeIf { it.id == threadId }
            item {
                Text(
                    thread?.title ?: stringResource(R.string.chat_untitled),
                    style = MaterialTheme.typography.headlineSmall,
                    modifier = Modifier.semantics { heading() },
                )
                if (thread != null) {
                    Text(
                        list.agents.firstOrNull { it.agentId == thread.agentId }?.displayName
                            ?: stringResource(R.string.chat_agent_identity, thread.agentId)
                    )
                    thread.projectId?.let { id ->
                        Text(list.projects.firstOrNull { it.id == id }?.name ?: id)
                    }
                    thread.selectedModel?.let { Text(it) }
                }
                TextButton(onClick = model::refresh) { Text(stringResource(R.string.chat_refresh)) }
            }
            if (thread == null || state.phase == HistoryPhase.Loading)
                item { Text(stringResource(R.string.history_loading)) }
            if (thread != null) {
                if (state.source == ChatListSource.Cache)
                    item { Text(stringResource(R.string.chat_cached)) }
                when (state.phase) {
                    HistoryPhase.Failed ->
                        item {
                            Text(stringResource(R.string.history_failed))
                            TextButton(onClick = model::refresh) {
                                Text(stringResource(R.string.retry))
                            }
                        }
                    HistoryPhase.Missing -> item { Text(stringResource(R.string.history_missing)) }
                    else -> Unit
                }
                if (state.cacheUnavailable)
                    item { Text(stringResource(R.string.chat_cache_unavailable)) }
                if (state.readFailed)
                    item {
                        Text(stringResource(R.string.history_read_failed))
                        TextButton(onClick = model::refresh) {
                            Text(stringResource(R.string.retry))
                        }
                    }
                state.transcript?.let { transcript ->
                    item {
                        Text(stringResource(transcript.execution.label()))
                        Text(stringResource(R.string.history_work_steps, transcript.workSteps))
                    }
                    if (transcript.messages.isEmpty() && state.phase == HistoryPhase.Ready)
                        item { Text(stringResource(R.string.history_empty)) }
                    items(transcript.messages, key = { it.id }) { message ->
                        HistoryMessageCard(message)
                    }
                }
            }
        }
    }
}

@Composable
private fun HistoryMessageCard(message: HistoryMessage) {
    OutlinedCard(Modifier.fillMaxWidth().testTag("message_${message.id}")) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                stringResource(
                    when (message.role) {
                        HistoryRole.User -> R.string.history_you
                        HistoryRole.Assistant -> R.string.app_name
                        HistoryRole.System -> R.string.history_work
                    }
                ),
                style = MaterialTheme.typography.labelLarge,
            )
            if (message.queued) Text(stringResource(R.string.history_queued))
            if (message.rejected) Text(stringResource(R.string.history_rejected))
            message.status?.let { status ->
                Text(
                    stringResource(
                        when (status) {
                            "run.completed" -> R.string.history_completed
                            "run.cancelled" -> R.string.history_cancelled
                            else -> R.string.history_run_failed
                        }
                    )
                )
            }
            for (block in message.blocks) {
                if (block.kind == HistoryBlockKind.Unsupported)
                    Text(stringResource(R.string.history_unsupported))
                if (block.kind == HistoryBlockKind.Reference)
                    Text(stringResource(R.string.history_reference))
                SelectionContainer {
                    if (
                        block.kind == HistoryBlockKind.Text && message.role == HistoryRole.Assistant
                    )
                        HistoryMarkdown(block.text)
                    else Text(block.text)
                }
            }
        }
    }
}

private fun HistoryExecution.label() =
    when (this) {
        HistoryExecution.Idle -> R.string.history_idle
        HistoryExecution.Queued -> R.string.history_queued
        HistoryExecution.Running -> R.string.history_running
        HistoryExecution.Stopping -> R.string.history_stopping
        HistoryExecution.Completed -> R.string.history_completed
        HistoryExecution.Failed -> R.string.history_run_failed
        HistoryExecution.Cancelled -> R.string.history_cancelled
    }
