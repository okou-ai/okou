package ai.okou.android.chat

import ai.okou.android.R
import androidx.annotation.StringRes
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
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.structuralEqualityPolicy
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
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
    composer: ChatComposerModel? = null,
    historyAvailable: Boolean = true,
) {
    // Capture this composition's value: a deferred effect must not read a newer State.value.
    val state = model.uiState.collectAsStateWithLifecycle().value
    val output = model.output.state.collectAsStateWithLifecycle().value
    val input = composer?.uiState?.collectAsStateWithLifecycle()
    val localMessages by
        remember(input, threadId) {
            derivedStateOf(structuralEqualityPolicy()) {
                input?.value?.messagesFor(threadId).orEmpty()
            }
        }
    val thread = state.thread?.takeIf { historyAvailable && it.id == threadId }
    val transcript = state.transcript.takeIf { thread != null }
    val messages = transcript?.withOutput(output, threadId).orEmpty()
    val previews = localMessages.filterNot { it.eventId in transcript?.persistedIds.orEmpty() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val actionColors =
        ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)
    var visit by
        remember(model, threadId, state.generation) {
            mutableStateOf<ConversationReadSession?>(null)
        }
    // Restored navigation can mount this route before the history resource selects its thread.
    val readVisible = visible && historyAvailable
    DisposableEffect(model, threadId, state.generation, lifecycle, readVisible) {
        fun update() {
            if (readVisible && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                if (visit == null) visit = model.beginVisit(threadId, state.generation)
            } else {
                visit?.let(model::endVisit)
                visit = null
            }
        }
        val observer = LifecycleEventObserver { _, _ -> update() }
        lifecycle.addObserver(observer)
        update()
        onDispose {
            lifecycle.removeObserver(observer)
            visit?.let(model::endVisit)
            visit = null
        }
    }
    val displayedVisit = visit
    LaunchedEffect(displayedVisit, state.confirmation) {
        state.confirmation?.let { displayedVisit?.confirmDisplayed(it) }
    }
    val readState = visit?.readState?.collectAsStateWithLifecycle()?.value
    key(threadId) {
        val position = rememberLazyListState()
        LaunchedEffect(position, previews.lastOrNull()?.eventId) {
            if (previews.isNotEmpty())
                position.scrollToItem(
                    messages.size + previews.lastIndex + if (historyAvailable) 1 else 0
                )
        }
        LazyColumn(
            modifier.fillMaxSize().testTag("conversation"),
            state = position,
            contentPadding = PaddingValues(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (historyAvailable) {
                item(key = "conversation_status") {
                    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        Column {
                            if (thread != null) {
                                Text(
                                    list.agents
                                        .firstOrNull { it.agentId == thread.agentId }
                                        ?.displayName ?: stringResource(R.string.app_name)
                                )
                                thread.selectedModel?.let { Text(it) }
                            }
                            TextButton(onClick = model::refresh, colors = actionColors) {
                                Text(stringResource(R.string.chat_refresh))
                            }
                        }
                        if (thread == null || state.phase == HistoryPhase.Loading)
                            Text(stringResource(R.string.history_loading))
                        if (thread != null) {
                            if (state.source == ChatListSource.Cache)
                                Text(stringResource(R.string.chat_cached))
                            when (state.phase) {
                                HistoryPhase.Failed ->
                                    Column {
                                        Text(stringResource(R.string.history_failed))
                                        TextButton(
                                            onClick = model::refresh,
                                            colors = actionColors,
                                        ) {
                                            Text(stringResource(R.string.retry))
                                        }
                                    }
                                HistoryPhase.Missing ->
                                    Text(stringResource(R.string.history_missing))
                                else -> Unit
                            }
                            if (state.cacheUnavailable)
                                Text(stringResource(R.string.chat_cache_unavailable))
                            if (readState == HistoryReadState.Failed)
                                Column {
                                    Text(stringResource(R.string.history_read_failed))
                                    TextButton(onClick = model::refresh, colors = actionColors) {
                                        Text(stringResource(R.string.retry))
                                    }
                                }
                        }
                        if (transcript != null) {
                            Column {
                                Text(stringResource(transcript.execution.label()))
                                Text(
                                    stringResource(
                                        R.string.history_work_steps,
                                        transcript.workSteps,
                                    )
                                )
                            }
                            if (
                                output.threadId == threadId &&
                                    (transcript.activeRunId != null || output.messages.isNotEmpty())
                            )
                                Text(
                                    stringResource(
                                        when (output.phase) {
                                            RunOutputPhase.CatchingUp -> R.string.output_catching_up
                                            RunOutputPhase.Live -> R.string.output_live
                                            RunOutputPhase.Waiting -> R.string.output_waiting
                                        }
                                    )
                                )
                            if (
                                messages.isEmpty() &&
                                    previews.isEmpty() &&
                                    state.phase == HistoryPhase.Ready
                            )
                                Text(stringResource(R.string.history_empty))
                        }
                    }
                }
            }
            items(messages, key = { it.id }) { message -> HistoryMessageCard(message) }
            items(previews, key = { it.eventId }) { preview ->
                HistoryMessageCard(
                    HistoryMessage(
                        preview.eventId,
                        null,
                        HistoryRole.User,
                        listOf(HistoryBlock(HistoryBlockKind.Text, preview.text)),
                    ),
                    deliveryStatus =
                        preview.disposition?.label()
                            ?: if (preview.sending) R.string.composer_sending
                            else R.string.composer_unconfirmed,
                )
            }
        }
    }
}

@Composable
internal fun HistoryMessageCard(message: HistoryMessage, @StringRes deliveryStatus: Int? = null) {
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
            deliveryStatus?.let { Text(stringResource(it)) }
            if (message.queued) Text(stringResource(R.string.history_queued))
            if (message.rejected) Text(stringResource(R.string.history_rejected))
            message.status?.let { status ->
                if (status == "run.failed") {
                    val copy = assistantRunFailureCopy(message.failureReason)
                    Text(stringResource(copy.title))
                    Text(stringResource(copy.description))
                } else {
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
        HistoryExecution.Completed -> R.string.history_completed
        HistoryExecution.Failed -> R.string.history_run_failed
        HistoryExecution.Cancelled -> R.string.history_cancelled
    }
