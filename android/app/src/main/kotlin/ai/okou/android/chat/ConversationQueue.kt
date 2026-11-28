package ai.okou.android.chat

import ai.okou.android.CompactPanelTopAppBar
import ai.okou.android.R
import ai.okou.android.SettingsModal
import ai.okou.android.WorkspaceFeedbackHost
import ai.okou.android.currentWindowSizeDp
import ai.okou.android.isShortWindowHeight
import ai.okou.android.settingsPanelContentPadding
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject

internal data class ConversationContent(
    val messages: List<ConversationMessage>,
    val queue: List<ConversationMessage>,
    val completion: ConversationCompletion?,
)

private data class QueueFocus(
    val id: String,
    val index: Int,
    val entries: List<ConversationMessage>,
) {
    fun adjacentIndexIn(remaining: List<ConversationMessage>): Int {
        val indexById = remaining.withIndex().associate { it.value.message.id to it.index }
        return (index + 1..entries.lastIndex).firstNotNullOfOrNull {
            indexById[entries[it].message.id]
        }
            ?: (index - 1 downTo 0).firstNotNullOfOrNull { indexById[entries[it].message.id] }
            ?: index.coerceAtMost(remaining.lastIndex)
    }
}

internal fun conversationContent(
    transcript: HistoryTranscript?,
    output: RunOutputState,
    threadId: String,
    previews: List<ComposerMessagePreview>,
    hiddenQueueInputs: Set<String>,
): ConversationContent {
    val confirmed = transcript?.withOutput(output, threadId).orEmpty()
    val retainedRunIds =
        if (output.threadId == threadId) output.messages.mapNotNull { it.runId } else emptyList()
    val liveRuns = transcript?.liveRunsIncluding(retainedRunIds).orEmpty().toSet()
    val pending = transcript?.pendingInputIds.orEmpty()
    if (pending.isEmpty() && previews.isEmpty()) {
        val turns = conversationTurns(confirmed, liveRuns)
        return ConversationContent(turns.messages, emptyList(), turns.completion)
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
            message.id in hiddenQueueInputs -> Unit
            else -> queue += ConversationMessage(message.copy(queued = true))
        }
    }
    val local = mutableListOf<ConversationMessage>()
    for (preview in previews) {
        if (
            preview.eventId in transcript?.persistedIds.orEmpty() ||
                preview.disposition == TextDisposition.Revoked ||
                preview.disposition == TextDisposition.Queued &&
                    preview.eventId in hiddenQueueInputs
        )
            continue
        val message =
            HistoryMessage(
                preview.eventId,
                null,
                HistoryRole.User,
                buildList {
                    if (preview.text.isNotEmpty())
                        add(HistoryBlock(HistoryBlockKind.Text, preview.text))
                    preview.attachments.forEach { add(it.historyBlock()) }
                },
                queued = preview.disposition == TextDisposition.Queued,
                rejected = preview.disposition == TextDisposition.Rejected,
                queueSequence = preview.sequence,
            )
        val entry = ConversationMessage(message, preview = preview)
        if (message.queued) {
            queue += entry
            // Input status can update the queue before history can replace the accepted bubble.
            if (preview.keepAcknowledgedBubble) {
                local += entry.copy(message = message.copy(queued = false, queueSequence = null))
            }
        } else local += entry
    }
    val turns = conversationTurns(messages, liveRuns)
    return ConversationContent(
        turns.messages + local,
        queue.sortedBy { it.message.queueSequence ?: Long.MAX_VALUE },
        turns.completion.takeIf {
            pending.isEmpty() && queue.isEmpty() && local.none { !it.message.rejected }
        },
    )
}

@Composable
internal fun ConversationQueueButton(
    count: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val label = stringResource(R.string.conversation_queue_count, count)
    val badge = if (count > 99) "99+" else count.toString()
    IconButton(
        onClick,
        modifier
            .padding(horizontal = 4.dp)
            .size(48.dp)
            .semantics { contentDescription = label }
            .testTag("open_conversation_queue"),
    ) {
        BadgedBox(
            badge = {
                Badge(
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                ) {
                    Text(
                        badge,
                        Modifier.semantics { hideFromAccessibility() },
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            },
        ) {
            Icon(painterResource(R.drawable.ic_schedule), null, Modifier.size(24.dp))
        }
    }
}

@Composable
internal fun ConversationQueueModal(
    entries: List<ConversationMessage>,
    controls: ConversationRunControls?,
    snackbar: SnackbarHostState?,
    position: LazyListState,
    onDismiss: () -> Unit,
) {
    val window = currentWindowSizeDp()
    val fullScreen = isShortWindowHeight(window.height)
    val density = LocalDensity.current
    val titleFocus = remember { FocusRequester() }
    // Restoration can show an empty queue before history loads. Hold the first populated height.
    var openedHeight by remember(window, density) { mutableIntStateOf(0) }
    val panelHeight =
        when {
            fullScreen -> Modifier.fillMaxHeight()
            openedHeight > 0 -> Modifier.height(with(density) { openedHeight.toDp() })
            entries.isNotEmpty() ->
                Modifier.onSizeChanged { if (openedHeight == 0) openedHeight = it.height }
            else -> Modifier
        }
    SettingsModal(onDismiss, fullScreen = fullScreen) {
        Box(Modifier.fillMaxWidth().then(panelHeight)) {
            Column(
                Modifier.fillMaxWidth()
                    .padding(settingsPanelContentPadding(compactHeight = fullScreen)),
            ) {
                val title = stringResource(R.string.conversation_queue_count, entries.size)
                if (fullScreen) {
                    CompactPanelTopAppBar(title, back = onDismiss, titleFocus = titleFocus)
                } else
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 56.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onDismiss, Modifier.size(48.dp)) {
                            Icon(
                                painterResource(R.drawable.ic_arrow_back),
                                stringResource(R.string.back),
                            )
                        }
                        Text(
                            title,
                            Modifier.weight(1f).focusRequester(titleFocus).focusable().semantics {
                                heading()
                            },
                            style = MaterialTheme.typography.titleLarge,
                        )
                    }
                if (entries.isEmpty()) {
                    Text(
                        stringResource(R.string.conversation_queue_empty),
                        Modifier.padding(horizontal = 12.dp, vertical = 20.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                ConversationQueue(entries, controls, titleFocus, position)
            }
            if (snackbar != null) {
                Box(Modifier.align(Alignment.BottomCenter)) {
                    WorkspaceFeedbackHost(
                        snackbar,
                        Modifier.padding(bottom = 8.dp).testTag("queue_control_feedback"),
                        manageTimeout = false,
                    )
                }
            }
        }
    }
}

@Composable
private fun ConversationQueue(
    entries: List<ConversationMessage>,
    controls: ConversationRunControls?,
    titleFocus: FocusRequester,
    position: LazyListState,
) {
    var focused by remember { mutableStateOf<QueueFocus?>(null) }
    val latestEntries by rememberUpdatedState(entries)
    val requesters = remember { mutableStateMapOf<String, FocusRequester>() }
    LaunchedEffect(entries) {
        val previous = focused ?: return@LaunchedEffect
        val currentIndex = entries.indexOfFirst { it.message.id == previous.id }
        if (currentIndex >= 0) {
            focused = previous.copy(index = currentIndex, entries = entries)
            return@LaunchedEffect
        }
        if (entries.isEmpty()) {
            focused = null
            titleFocus.requestFocus()
            return@LaunchedEffect
        }
        val nextIndex = previous.adjacentIndexIn(entries)
        val nextId = entries[nextIndex].message.id
        if (position.layoutInfo.visibleItemsInfo.none { it.key == nextId }) {
            position.scrollToItem(nextIndex)
        }
        val nextFocus = snapshotFlow { requesters[nextId] }.filterNotNull().first()
        if (!nextFocus.requestFocus()) {
            focused = null
            titleFocus.requestFocus()
        }
    }
    if (entries.isEmpty()) return
    val label = stringResource(R.string.conversation_queue)
    LazyColumn(
        Modifier.fillMaxWidth().testTag("conversation_queue").semantics {
            contentDescription = label
        },
        state = position,
    ) {
        itemsIndexed(entries, key = { _, entry -> entry.message.id }) { index, entry ->
            val id = entry.message.id
            val focus = remember { FocusRequester() }
            DisposableEffect(id, focus) {
                requesters[id] = focus
                onDispose { requesters.remove(id, focus) }
            }
            if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            QueueRow(
                entry,
                controls,
                modifier =
                    Modifier.focusRequester(focus)
                        .onFocusChanged { state ->
                            if (state.hasFocus) focused = QueueFocus(id, index, entries)
                            else if (focused?.id == id && latestEntries.any { it.message.id == id })
                                focused = null
                        }
                        .focusable(),
                beforeAction = { if (focused?.id == id) focus.requestFocus() },
            )
        }
    }
}

@Composable
private fun QueueRow(
    entry: ConversationMessage,
    controls: ConversationRunControls?,
    modifier: Modifier,
    beforeAction: () -> Unit,
) {
    val message = entry.message
    val workflow = message.queuedWorkflow
    val revoke = controls?.revoke(message.id, entry.preview)
    val summary =
        remember(message) {
            workflow?.name
                ?: message.blocks
                    .mapNotNull {
                        when (it.kind) {
                            HistoryBlockKind.Text -> it.text
                            HistoryBlockKind.Reference,
                            HistoryBlockKind.Attachment -> it.title
                            else -> null
                        }
                    }
                    .joinToString("\n")
        }
    val attachments =
        remember(message.blocks) {
            message.blocks.count {
                it.kind == HistoryBlockKind.Attachment ||
                    it.kind == HistoryBlockKind.Reference &&
                        Json.parseToJsonElement(it.text).jsonObject.text("type") in
                            setOf("attachment", "file", "image")
            }
        }
    val metadata =
        when {
            workflow != null -> stringResource(R.string.conversation_queue_automation)
            attachments > 0 ->
                pluralStringResource(
                    R.plurals.conversation_queue_attachments,
                    attachments,
                    attachments,
                )
            else -> stringResource(R.string.conversation_queue_message)
        }
    val action =
        stringResource(
            if (workflow == null) R.string.conversation_revoke
            else R.string.conversation_skip_automation,
        )
    ListItem(
        modifier = modifier.fillMaxWidth().testTag("message_${message.id}"),
        leadingContent = {
            Icon(
                painterResource(
                    if (workflow == null) R.drawable.ic_chat_bubble else R.drawable.ic_schedule,
                ),
                null,
                Modifier.size(24.dp),
            )
        },
        supportingContent =
            if (summary.isNotBlank()) {
                { Text(metadata) }
            } else null,
        trailingContent = {
            IconButton(
                onClick = {
                    beforeAction()
                    revoke?.invoke()
                },
                enabled = revoke != null,
                modifier =
                    Modifier.size(48.dp).semantics {
                        contentDescription = "$action, ${summary.ifBlank { metadata }}"
                    },
            ) {
                Icon(painterResource(R.drawable.ic_close), null, Modifier.size(24.dp))
            }
        },
    ) {
        Text(summary.ifBlank { metadata }, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}
