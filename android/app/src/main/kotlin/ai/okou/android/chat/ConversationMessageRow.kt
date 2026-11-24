package ai.okou.android.chat

import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.R
import ai.okou.android.WorkspaceMenu
import ai.okou.android.WorkspaceMenuItem
import ai.okou.android.state.rememberEarlierRepliesExpanded
import android.content.ClipData
import android.os.Build
import android.widget.Toast
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.LongState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal sealed interface ConversationTimelineRow {
    val key: String
}

internal data class ConversationMessage(
    val message: HistoryMessage,
    val earlier: List<HistoryMessage> = emptyList(),
    val preview: ComposerMessagePreview? = null,
    val summary: ReplySummary? = null,
) : ConversationTimelineRow {
    override val key: String
        get() = earlier.firstOrNull()?.id ?: message.id

    fun includes(id: String?) = message.id == id || earlier.any { it.id == id }
}

private fun HistoryMessage.isReply() = role == HistoryRole.Assistant && blocks.isNotEmpty()

@Composable
internal fun ConversationMessageRow(
    entry: ConversationMessage,
    artifactActions: ChatArtifactActions? = null,
    findHighlight: ConversationFindHighlight? = null,
    links: ConversationLinkActions? = null,
    onToggleEarlierReplies: (toggle: () -> Unit) -> Unit = { it() },
    failureContent: @Composable (HistoryMessage) -> Unit = {
        AssistantFailureText(it.failureReason)
    },
) {
    val message = entry.message
    val colors = MaterialTheme.colorScheme
    when {
        message.role == HistoryRole.User ->
            Box(
                Modifier.fillMaxWidth().testTag("message_${message.id}"),
                contentAlignment = Alignment.CenterEnd,
            ) {
                Box(modifier = Modifier.fillMaxWidth(.85f).wrapContentWidth(Alignment.End)) {
                    val delivery = entry.preview?.pendingDelivery
                    val status = delivery?.let { stringResource(it.label()) }
                    Surface(
                        modifier =
                            if (status == null) Modifier
                            else Modifier.semantics { stateDescription = status },
                        shape = RoundedCornerShape(16.dp),
                        color = colors.surfaceVariant,
                        contentColor = colors.onSurface,
                    ) {
                        Column(
                            Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            MessageBody(message, findHighlight = findHighlight)
                            MessageStatus(message)
                        }
                    }
                    if (delivery != null) {
                        DeliveryIndicator(
                            delivery,
                            Modifier.align(Alignment.CenterStart).offset(x = (-24).dp),
                        )
                    }
                }
            }
        message.isReply() ->
            Column(Modifier.fillMaxWidth().testTag("message_${message.id}")) {
                ConversationReplyHeader(message)
                if (entry.summary != null) {
                    var expanded by rememberEarlierRepliesExpanded()
                    if (findHighlight?.reveal != null) {
                        val targetId = findHighlight.messageId
                        LaunchedEffect(targetId) {
                            if (entry.earlier.any { it.id == targetId }) expanded = true
                        }
                    }
                    ConversationReplySummary(entry.summary, entry.earlier.size, expanded) {
                        onToggleEarlierReplies { expanded = !expanded }
                    }
                    if (expanded && entry.earlier.isNotEmpty()) {
                        ConversationReplyTimeline {
                            for (earlier in entry.earlier) {
                                key(earlier.id) {
                                    Column(Modifier.testTag("message_${earlier.id}")) {
                                        MessageBody(
                                            earlier,
                                            earlierReply = true,
                                            artifactActions = artifactActions,
                                            findHighlight =
                                                findHighlight?.takeIf {
                                                    it.messageId == earlier.id
                                                },
                                            links = links,
                                        )
                                    }
                                }
                            }
                        }
                    } else {
                        Spacer(Modifier.height(8.dp))
                    }
                }
                MessageBody(
                    message,
                    artifactActions = artifactActions,
                    artifactTurnKey = entry.key,
                    findHighlight = findHighlight?.takeIf { it.messageId == message.id },
                    links = links,
                )
                if (entry.earlier.isNotEmpty() && artifactActions != null) {
                    EarlierReplyArtifacts(entry, artifactActions)
                }
            }
        else ->
            Column(Modifier.fillMaxWidth().testTag("message_${message.id}")) {
                if (message.status == "run.failed") {
                    MessageBody(message, compact = true)
                    failureContent(message)
                } else {
                    MessageStatus(message)
                    MessageBody(message, compact = true)
                }
            }
    }
}

@Composable
private fun EarlierReplyArtifacts(entry: ConversationMessage, actions: ChatArtifactActions) {
    // Reuse the earlier replies' parsed results across chunks of the latest reply.
    val candidates =
        key(entry.earlier) {
                produceState<List<ReplyArtifact>?>(null) {
                    value =
                        withContext(Dispatchers.Default) { earlierReplyArtifacts(entry.earlier) }
                }
            }
            .value
    // Keep the previous cards laid out while fresh text is being parsed.
    val cards by
        produceState(emptyList<ReplyArtifact>(), candidates, entry.message.blocks) {
            val earlier = candidates ?: return@produceState
            value =
                if (earlier.isEmpty()) earlier
                else
                    withContext(Dispatchers.Default) {
                        earlier.excludingArtifacts(entry.message.blocks)
                    }
        }
    if (cards.isNotEmpty()) {
        Column(
            Modifier.padding(top = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            for (card in cards) {
                key(card.link) {
                    MessageArtifactCard(card.title, card.link, entry.key, actions)
                }
            }
        }
    }
}

@Composable
internal fun ConversationReplyHeader(message: HistoryMessage? = null) {
    val colors = MaterialTheme.colorScheme
    var menuMessage by remember { mutableStateOf<HistoryMessage?>(null) }
    val focus = remember { FocusRequester() }
    var keyboardFocused by remember { mutableStateOf(false) }
    var restoreFocus by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboard.current
    val context = LocalContext.current
    val label = stringResource(R.string.conversation_reply_actions)
    val copyableReply = message?.takeIf {
        it.blocks.any { block -> block.kind == HistoryBlockKind.Text }
    }
    val openMenu by rememberUpdatedState {
        restoreFocus = keyboardFocused
        menuMessage = copyableReply
    }
    Box(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
        Row(
            Modifier.fillMaxWidth()
                .heightIn(min = 48.dp)
                .then(
                    if (copyableReply == null) Modifier
                    else
                        Modifier.pointerInput(copyableReply.id) {
                            detectTapGestures(onLongPress = { openMenu() })
                        },
                ),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Image(
                painterResource(R.drawable.okou_conversation_avatar),
                null,
                Modifier.size(24.dp).clip(RoundedCornerShape(8.dp)),
            )
            Text(
                stringResource(R.string.app_name),
                Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
            )
            if (copyableReply != null) {
                Box {
                    IconButton(
                        onClick = openMenu,
                        modifier =
                            Modifier.size(48.dp).focusRequester(focus).onFocusChanged {
                                keyboardFocused = it.isFocused
                            },
                    ) {
                        Icon(
                            painterResource(R.drawable.ic_more_vert),
                            label,
                            Modifier.size(20.dp),
                            tint = colors.onSurfaceVariant,
                        )
                    }
                    menuMessage?.let { selected ->
                        WorkspaceMenu(
                            items =
                                listOf(
                                    WorkspaceMenuItem(
                                        stringResource(R.string.conversation_copy_reply),
                                        R.drawable.ic_content_copy,
                                    ) {
                                        menuMessage = null
                                        scope.launch {
                                            val copy =
                                                withContext(Dispatchers.Default) {
                                                    selected.blocks
                                                        .filter { it.kind == HistoryBlockKind.Text }
                                                        .joinToString("\n\n") {
                                                            conversationMarkdownForCopy(it.text)
                                                        }
                                                }
                                            clipboard.setClipEntry(
                                                ClipEntry(ClipData.newPlainText(null, copy)),
                                            )
                                            if (Build.VERSION.SDK_INT < 33)
                                                Toast.makeText(
                                                        context,
                                                        R.string.conversation_reply_copied,
                                                        Toast.LENGTH_SHORT,
                                                    )
                                                    .show()
                                        }
                                    },
                                ),
                            close = { menuMessage = null },
                        )
                    }
                }
            }
        }
    }
    LaunchedEffect(menuMessage) {
        if (menuMessage == null && restoreFocus) {
            restoreFocus = false
            focus.requestFocus()
        }
    }
}

@Composable
internal fun ConversationActivity(
    label: String,
    modifier: Modifier = Modifier,
    queued: Boolean = false,
    stopped: Boolean = false,
    runningFrame: LongState? = null,
    controls: ConversationRunControls? = null,
    stopPlacement: ConversationStopPlacement? = null,
) {
    val color = LocalActivityStatusColor.current
    Row(
        modifier.fillMaxWidth().heightIn(min = if (stopped) 24.dp else ConversationStopTouchSize),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) {
            if (queued || stopped) {
                Icon(
                    painterResource(if (queued) R.drawable.ic_schedule else R.drawable.ic_stop),
                    null,
                    Modifier.size(16.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else if (runningFrame != null) {
                Canvas(Modifier.size(14.dp)) {
                    drawRunningWave(color, runningFrame.longValue, row = 0)
                }
            } else {
                Box(Modifier.size(8.dp).background(color, CircleShape))
            }
        }
        ConversationMeta(label, Modifier.weight(1f), maxLines = 2)
        if (controls?.currentRunId != null && stopPlacement != null) {
            DisposableEffect(stopPlacement) {
                onDispose { stopPlacement.reportInlineSlot(null) }
            }
            Box(
                Modifier.size(ConversationStopTouchSize).onGloballyPositioned { slot ->
                    val bounds = slot.boundsInRoot()
                    stopPlacement.reportInlineSlot(
                        bounds.takeIf {
                            bounds.width >= slot.size.width - 0.5f &&
                                bounds.height >= slot.size.height - 0.5f
                        },
                    )
                },
            ) {
                if (stopPlacement.inline) ConversationStopButton(controls, stopPlacement, true)
            }
        } else {
            Spacer(Modifier.width(ConversationStopTouchSize))
        }
    }
}

@Composable
private fun ConversationMeta(
    text: String,
    modifier: Modifier = Modifier,
    maxLines: Int = Int.MAX_VALUE,
) {
    Text(
        text,
        modifier,
        style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 20.sp),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun MessageBody(
    message: HistoryMessage,
    compact: Boolean = false,
    earlierReply: Boolean = false,
    artifactActions: ChatArtifactActions? = null,
    artifactTurnKey: String = message.id,
    findHighlight: ConversationFindHighlight? = null,
    links: ConversationLinkActions? = null,
) {
    val typography = MaterialTheme.typography
    val colors = MaterialTheme.colorScheme
    val markdownHighlight = findHighlight?.takeIf { message.role == HistoryRole.Assistant }
    val bodyHighlight = findHighlight.takeUnless { markdownHighlight != null }
    val foreground =
        if (bodyHighlight?.target?.highlighted == true) colors.onSecondaryContainer
        else colors.onSurface
    val style =
        when {
            earlierReply ->
                typography.bodyMedium.copy(
                    fontSize = 14.sp,
                    lineHeight = 20.sp,
                    letterSpacing = 0.sp,
                    color = colors.onSurfaceVariant,
                )
            compact -> typography.bodyMedium
            else ->
                typography.bodyLarge.copy(
                    fontSize = 16.sp,
                    lineHeight = 28.sp,
                    letterSpacing = 0.sp,
                )
        }
    SelectionContainer {
        Column(
            Modifier.conversationFindHighlight(bodyHighlight),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            for ((index, block) in message.blocks.withIndex()) {
                when (block.kind) {
                    HistoryBlockKind.Unsupported ->
                        ConversationMeta(stringResource(R.string.history_unsupported))
                    HistoryBlockKind.Reference ->
                        ConversationMeta(block.title ?: stringResource(R.string.history_reference))
                    HistoryBlockKind.Error -> Text(block.text, style = style, color = foreground)
                    HistoryBlockKind.Text ->
                        if (message.role == HistoryRole.Assistant)
                            HistoryMarkdown(
                                block.text,
                                style,
                                artifactActions,
                                "${message.id}/$index",
                                artifactTurnKey,
                                markdownHighlight,
                                links,
                                compactReply = earlierReply,
                            )
                        else Text(block.text, style = style, color = foreground)
                }
            }
        }
    }
}

internal data class ConversationFindHighlight(
    val target: ConversationFindTarget,
    val reveal: (suspend (LayoutCoordinates) -> Unit)?,
    val messageId: String = target.id,
)

@Composable
internal fun Modifier.conversationFindHighlight(highlight: ConversationFindHighlight?): Modifier {
    if (highlight == null) return this
    val colors = MaterialTheme.colorScheme
    val focus = remember { FocusRequester() }
    val reveal = highlight.reveal
    var coordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
    if (reveal != null) {
        LaunchedEffect(highlight.target) {
            val bounds = snapshotFlow {
                coordinates?.takeIf { it.isAttached }
            }
                .filterNotNull()
                .first()
            reveal(bounds)
            if (bounds.isAttached) focus.requestFocus()
        }
    }
    return drawBehind {
            if (highlight.target.highlighted) {
                val edge = 2.dp.toPx()
                drawRoundRect(
                    colors.secondaryContainer,
                    topLeft = Offset(-edge, -edge),
                    size = Size(size.width + 2 * edge, size.height + 2 * edge),
                    cornerRadius = CornerRadius(4.dp.toPx() + edge),
                )
            }
        }
        .then(if (reveal != null) Modifier.onGloballyPositioned { coordinates = it } else Modifier)
        .focusRequester(focus)
        .focusable()
        .semantics(mergeDescendants = true) {}
        .testTag("conversation_find_hit")
}

@Composable
private fun MessageStatus(message: HistoryMessage) {
    if (message.rejected) ConversationMeta(stringResource(R.string.history_rejected))
    when (message.status) {
        "run.failed" -> AssistantFailureText(message.failureReason)
        "run.cancelled" ->
            ConversationActivity(
                stringResource(R.string.history_cancelled),
                stopped = true,
            )
        "output.error" -> ConversationMeta(stringResource(R.string.history_run_failed))
    }
}

@Composable
internal fun AssistantFailureText(reason: String?) {
    val copy = assistantRunFailureCopy(reason)
    Text(
        stringResource(copy.title),
        style =
            MaterialTheme.typography.bodyLarge.copy(
                fontSize = 16.sp,
                lineHeight = 24.sp,
                fontWeight = FontWeight.Medium,
            ),
    )
    Text(
        stringResource(copy.description),
        modifier = Modifier.padding(top = 4.dp),
        style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

private fun PendingDelivery.label() =
    when (this) {
        PendingDelivery.Sending -> R.string.composer_sending
        PendingDelivery.Checking -> R.string.composer_checking_delivery
        PendingDelivery.Unconfirmed -> R.string.composer_unconfirmed
    }

@Composable
private fun DeliveryIndicator(delivery: PendingDelivery, modifier: Modifier) {
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    Box(modifier.size(16.dp).clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
        if (delivery == PendingDelivery.Unconfirmed) {
            Icon(painterResource(R.drawable.ic_schedule), contentDescription = null, tint = color)
        } else {
            CircularProgressIndicator(Modifier.size(14.dp), color = color, strokeWidth = 2.dp)
        }
    }
}
