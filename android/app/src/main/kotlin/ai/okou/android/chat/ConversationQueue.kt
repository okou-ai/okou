package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.currentWindowSizeDp
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

internal data class ConversationContent(
    val messages: List<ConversationMessage>,
    val queue: List<ConversationMessage>,
)

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
) {
    if (entries.isEmpty()) return
    val window = currentWindowSizeDp()
    val label = stringResource(R.string.conversation_queue)
    LazyColumn(
        Modifier.fillMaxWidth()
            .padding(
                start = composerHorizontalInset(window),
                end = composerHorizontalInset(window),
                bottom = 4.dp,
            )
            .heightIn(max = minOf(200.dp, window.height.dp * 0.22f))
            .testTag("conversation_queue")
            .semantics { contentDescription = label },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(entries, key = { it.message.id }) { entry ->
            QueuedMessageCard(entry, controls)
        }
    }
}
