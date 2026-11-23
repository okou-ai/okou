package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.currentWindowSizeDp
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

internal data class ConversationContent(
    val messages: List<ConversationMessage>,
    val queue: List<ConversationMessage>,
)

private data class QueueFocus(val id: String, val index: Int)

internal fun conversationContent(
    transcript: HistoryTranscript?,
    output: RunOutputState,
    threadId: String,
    previews: List<ComposerMessagePreview>,
    settledQueueInputs: Set<String>,
): ConversationContent {
    val confirmed = transcript?.withOutput(output, threadId).orEmpty()
    val pending = transcript?.pendingInputIds.orEmpty()
    if (pending.isEmpty() && previews.isEmpty()) {
        return ConversationContent(conversationMessages(confirmed), emptyList())
    }
    val observed = previews.associateBy { it.eventId }
    val messages = mutableListOf<HistoryMessage>()
    val queue = mutableListOf<ConversationMessage>()
    for (message in confirmed) {
        if (message.id !in pending) {
            messages += message
            continue
        }
        val disposition = observed[message.id]?.disposition
        when {
            disposition == TextDisposition.Revoked -> Unit
            disposition?.hasLeftQueue == true ->
                messages +=
                    message.copy(
                        queued = false,
                        rejected = disposition == TextDisposition.Rejected,
                        queueSequence = null,
                        queuedWorkflow = null,
                    )
            message.id in settledQueueInputs -> Unit
            else -> queue += ConversationMessage(message.copy(queued = true))
        }
    }
    val local = mutableListOf<ConversationMessage>()
    for (preview in previews) {
        if (
            preview.eventId in transcript?.persistedIds.orEmpty() ||
                preview.disposition == TextDisposition.Revoked ||
                preview.disposition == TextDisposition.Queued &&
                    preview.eventId in settledQueueInputs
        )
            continue
        val message =
            HistoryMessage(
                preview.eventId,
                null,
                HistoryRole.User,
                listOf(HistoryBlock(HistoryBlockKind.Text, preview.text)),
                queued = preview.disposition == TextDisposition.Queued,
                rejected = preview.disposition == TextDisposition.Rejected,
                queueSequence = preview.sequence,
            )
        val entry = ConversationMessage(message, preview = preview)
        if (message.queued) queue += entry else local += entry
    }
    return ConversationContent(
        conversationMessages(messages) + local,
        queue.sortedBy { it.message.queueSequence ?: Long.MAX_VALUE },
    )
}

@Composable
internal fun ConversationQueue(
    entries: List<ConversationMessage>,
    controls: ConversationRunControls?,
    timelineFocus: FocusRequester,
) {
    var focused by remember { mutableStateOf<QueueFocus?>(null) }
    val latestEntries by rememberUpdatedState(entries)
    val requesters = remember { mutableMapOf<String, FocusRequester>() }
    LaunchedEffect(entries) {
        val previous = focused ?: return@LaunchedEffect
        val currentIndex = entries.indexOfFirst { it.message.id == previous.id }
        if (currentIndex >= 0) {
            focused = previous.copy(index = currentIndex)
            return@LaunchedEffect
        }
        focused = null
        val nextId = entries.getOrNull(previous.index)?.message?.id
        if (requesters[nextId]?.requestFocus() != true) timelineFocus.requestFocus()
    }
    if (entries.isEmpty()) return
    val window = currentWindowSizeDp()
    val label = stringResource(R.string.conversation_queue)
    LazyColumn(
        Modifier.fillMaxWidth()
            .padding(
                start = composerHorizontalInset(window),
                end = composerHorizontalInset(window),
                // The composer's 4 dp top inset completes the 8 dp gap.
                bottom = 4.dp,
            )
            .heightIn(max = minOf(200.dp, window.height.dp * 0.22f))
            .testTag("conversation_queue")
            .semantics { contentDescription = label },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        itemsIndexed(entries, key = { _, entry -> entry.message.id }) { index, entry ->
            val id = entry.message.id
            val focus = remember { FocusRequester() }
            DisposableEffect(id, focus) {
                requesters[id] = focus
                onDispose { requesters.remove(id, focus) }
            }
            QueuedMessageCard(
                entry,
                controls,
                modifier =
                    Modifier.focusRequester(focus)
                        .onFocusChanged { state ->
                            if (state.hasFocus) focused = QueueFocus(id, index)
                            else if (focused?.id == id && latestEntries.any { it.message.id == id })
                                focused = null
                        }
                        .focusable(),
                beforeAction = { if (focused?.id == id) focus.requestFocus() },
            )
        }
    }
}
