package ai.okou.android.chat

import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.R
import ai.okou.android.WorkspaceMenu
import ai.okou.android.WorkspaceMenuItem
import ai.okou.android.state.rememberEarlierRepliesExpanded
import android.content.ClipData
import android.os.Build
import android.widget.Toast
import androidx.annotation.StringRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.LongState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
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
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
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
    @StringRes val deliveryStatus: Int? = null,
) : ConversationTimelineRow {
    override val key: String
        get() = earlier.firstOrNull()?.id ?: message.id

    fun includes(id: String?) = message.id == id || earlier.any { it.id == id }
}

internal fun HistoryMessage.visibleInConversation() =
    status != "run.completed" || blocks.isNotEmpty()

internal fun conversationMessages(messages: List<HistoryMessage>): List<ConversationMessage> =
    buildList {
        var previous: HistoryMessage? = null
        val earlier = mutableListOf<HistoryMessage>()
        for (message in messages) {
            if (!message.visibleInConversation()) continue
            val preceding = previous
            if (preceding != null) {
                if (
                    message.isReply() &&
                        preceding.isReply() &&
                        message.runId != null &&
                        message.runId == preceding.runId
                ) {
                    earlier += preceding
                } else {
                    add(ConversationMessage(preceding, earlier.toList()))
                    earlier.clear()
                }
            }
            previous = message
        }
        previous?.let { add(ConversationMessage(it, earlier.toList())) }
    }

private fun HistoryMessage.isReply() = role == HistoryRole.Assistant && blocks.isNotEmpty()

@Composable
internal fun ConversationMessageRow(
    entry: ConversationMessage,
    revoke: (() -> Unit)?,
    artifactActions: ChatArtifactActions? = null,
    findHighlight: ConversationFindHighlight? = null,
) {
    val message = entry.message
    val colors = MaterialTheme.colorScheme
    when {
        message.queued && message.role == HistoryRole.User ->
            Surface(
                modifier = Modifier.fillMaxWidth().testTag("message_${message.id}"),
                shape = RoundedCornerShape(12.dp),
                color = colors.surface,
                border = BorderStroke(1.dp, colors.outline),
            ) {
                Row(
                    Modifier.padding(start = 12.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        ConversationMeta(stringResource(R.string.history_queued))
                        MessageBody(message, compact = true)
                    }
                    if (revoke != null) {
                        TextButton(
                            onClick = revoke,
                            colors =
                                ButtonDefaults.textButtonColors(contentColor = colors.onSurface),
                        ) {
                            Text(stringResource(R.string.conversation_revoke))
                        }
                    }
                }
            }
        message.role == HistoryRole.User ->
            Box(
                Modifier.fillMaxWidth().testTag("message_${message.id}"),
                contentAlignment = Alignment.CenterEnd,
            ) {
                Surface(
                    modifier = Modifier.fillMaxWidth(.85f).wrapContentWidth(Alignment.End),
                    shape = RoundedCornerShape(16.dp),
                    color = colors.surfaceVariant,
                    contentColor = colors.onSurface,
                ) {
                    Column(
                        Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        MessageBody(message, findHighlight = findHighlight)
                        MessageStatus(message, entry.deliveryStatus)
                    }
                }
            }
        message.isReply() ->
            Column(Modifier.fillMaxWidth().testTag("message_${message.id}")) {
                ConversationReplyHeader(message)
                if (entry.earlier.isNotEmpty()) {
                    var expanded by rememberEarlierRepliesExpanded()
                    if (findHighlight?.reveal != null) {
                        val targetId = findHighlight.target.id
                        LaunchedEffect(targetId) {
                            if (entry.earlier.any { it.id == targetId }) expanded = true
                        }
                    }
                    TextButton(
                        onClick = { expanded = !expanded },
                        colors =
                            ButtonDefaults.textButtonColors(contentColor = colors.onSurfaceVariant),
                    ) {
                        Icon(
                            painterResource(
                                if (expanded) R.drawable.ic_expand_less
                                else R.drawable.ic_expand_more
                            ),
                            null,
                            Modifier.size(16.dp),
                        )
                        Text(
                            stringResource(R.string.conversation_work),
                            Modifier.padding(start = 8.dp),
                        )
                    }
                    if (expanded)
                        Column(
                            Modifier.padding(bottom = 12.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            for (earlier in entry.earlier) {
                                Column(Modifier.testTag("message_${earlier.id}")) {
                                    MessageBody(
                                        earlier,
                                        artifactActions = artifactActions,
                                        findHighlight =
                                            findHighlight?.takeIf { it.target.id == earlier.id },
                                    )
                                }
                            }
                        }
                }
                MessageBody(
                    message,
                    artifactActions = artifactActions,
                    findHighlight = findHighlight?.takeIf { it.target.id == message.id },
                )
            }
        else ->
            Column(Modifier.fillMaxWidth().testTag("message_${message.id}")) {
                MessageStatus(message, entry.deliveryStatus)
                MessageBody(message, compact = true)
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
    val openMenu by rememberUpdatedState {
        restoreFocus = keyboardFocused
        menuMessage = message
    }
    Box(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
        Row(
            Modifier.fillMaxWidth()
                .heightIn(min = 48.dp)
                .then(
                    if (message == null) Modifier
                    else
                        Modifier.pointerInput(message.id) {
                            detectTapGestures(onLongPress = { openMenu() })
                        }
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
            if (message != null) {
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
                                                    selected.blocks.joinToString("\n\n") {
                                                        if (it.kind == HistoryBlockKind.Text)
                                                            conversationMarkdownForCopy(it.text)
                                                        else it.text
                                                    }
                                                }
                                            clipboard.setClipEntry(
                                                ClipEntry(ClipData.newPlainText(null, copy))
                                            )
                                            if (Build.VERSION.SDK_INT < 33)
                                                Toast.makeText(
                                                        context,
                                                        R.string.conversation_reply_copied,
                                                        Toast.LENGTH_SHORT,
                                                    )
                                                    .show()
                                        }
                                    }
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
    @StringRes label: Int,
    modifier: Modifier = Modifier,
    runningFrame: LongState? = null,
) {
    val color = LocalActivityStatusColor.current
    Row(
        modifier.heightIn(min = 24.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (label == R.string.conversation_processing && runningFrame != null) {
            Canvas(Modifier.size(14.dp)) { drawRunningWave(color, runningFrame.longValue, row = 0) }
        } else {
            Box(Modifier.size(8.dp).background(color, CircleShape))
        }
        ConversationMeta(stringResource(label), maxLines = 1)
    }
}

@Composable
private fun ConversationMeta(text: String, maxLines: Int = Int.MAX_VALUE) {
    Text(
        text,
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
    artifactActions: ChatArtifactActions? = null,
    findHighlight: ConversationFindHighlight? = null,
) {
    val typography = MaterialTheme.typography
    val colors = MaterialTheme.colorScheme
    val markdownHighlight = findHighlight?.takeIf { message.role == HistoryRole.Assistant }
    val bodyHighlight = findHighlight.takeUnless { markdownHighlight != null }
    val foreground =
        if (bodyHighlight?.target?.highlighted == true) colors.onSecondaryContainer
        else colors.onSurface
    val style =
        if (compact) typography.bodyMedium
        else typography.bodyLarge.copy(fontSize = 16.sp, lineHeight = 28.sp, letterSpacing = 0.sp)
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
                        ConversationMeta(stringResource(R.string.history_reference))
                    else -> Unit
                }
                if (block.kind == HistoryBlockKind.Text && message.role == HistoryRole.Assistant)
                    HistoryMarkdown(
                        block.text,
                        style,
                        artifactActions,
                        "${message.id}/$index",
                        markdownHighlight,
                    )
                else Text(block.text, style = style, color = foreground)
            }
        }
    }
}

internal data class ConversationFindHighlight(
    val target: ConversationFindTarget,
    val reveal: (suspend (LayoutCoordinates) -> Unit)?,
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
            val bounds =
                snapshotFlow { coordinates?.takeIf { it.isAttached } }.filterNotNull().first()
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
private fun MessageStatus(message: HistoryMessage, @StringRes deliveryStatus: Int?) {
    if (deliveryStatus != null) ConversationMeta(stringResource(deliveryStatus))
    if (message.rejected) ConversationMeta(stringResource(R.string.history_rejected))
    when (message.status) {
        "run.failed" -> {
            val copy = assistantRunFailureCopy(message.failureReason)
            ConversationMeta(stringResource(copy.title))
            ConversationMeta(stringResource(copy.description))
        }
        "run.cancelled" -> ConversationMeta(stringResource(R.string.history_cancelled))
        "output.error" -> ConversationMeta(stringResource(R.string.history_run_failed))
    }
}
