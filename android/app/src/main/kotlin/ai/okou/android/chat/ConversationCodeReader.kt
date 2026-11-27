package ai.okou.android.chat

import ai.okou.android.FeedbackReceipt
import ai.okou.android.R
import ai.okou.android.WorkspaceFeedbackHost
import ai.okou.android.updates.updateFocusOutline
import android.content.ClipData
import android.os.Build
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal data class ConversationCodeVisit(
    val threadId: String,
    val target: ConversationCodeTarget,
    val anchor: ConversationAnchor?,
    val previewOffsetPx: Int,
    val expanded: Boolean = false,
)

internal class ConversationCodeReading(
    private val saved: MutableState<ConversationCodeVisit?>,
) {
    val visit by saved
    var returning by mutableStateOf<ConversationCodeVisit?>(null)
        private set

    var previewFeedback by mutableStateOf<List<FeedbackReceipt<Int>>>(emptyList())
        private set

    private var feedbackThreadId: String? = null

    fun showFeedbackFor(threadId: String?) {
        if (feedbackThreadId == threadId) return
        feedbackThreadId = threadId
        previewFeedback = emptyList()
    }

    fun reportFeedback(threadId: String, message: Int) {
        if (feedbackThreadId != threadId) return
        val pending =
            if (message == R.string.conversation_code_copied)
                previewFeedback.filterNot { it.value == message }
            else previewFeedback
        previewFeedback = pending + FeedbackReceipt(message)
    }

    fun dismissFeedback(receipt: FeedbackReceipt<Int>) {
        previewFeedback = previewFeedback - receipt
    }

    fun open(
        threadId: String,
        target: ConversationCodeTarget,
        anchor: ConversationAnchor?,
        previewOffsetPx: Int,
    ) {
        saved.value = ConversationCodeVisit(threadId, target, anchor, previewOffsetPx)
        returning = null
    }

    fun toggleExpanded() {
        saved.value = visit?.let { it.copy(expanded = !it.expanded) }
    }

    fun close() {
        returning = visit
        saved.value = null
    }

    fun retainChat(threadId: String?) {
        if (visit?.threadId != threadId) saved.value = null
        if (returning?.threadId != threadId) returning = null
    }

    fun restored(visit: ConversationCodeVisit) {
        if (returning == visit) returning = null
    }
}

internal data class ConversationCodeActions(
    val open: (ConversationCodeTarget, previewOffsetPx: Int) -> Unit,
    val returning: ConversationCodeVisit?,
    val restored: (ConversationCodeVisit) -> Unit,
    val feedback: (Int) -> Unit,
)

internal data class ConversationCodeBody(
    val reader: ConversationCodeActions,
    val messageId: String,
    val index: Int,
    val restoreReply: () -> Unit,
)

@Composable
internal fun ConversationCodeCard(
    source: ConversationCodeSource,
    reader: ConversationCodeActions,
    target: ConversationCodeTarget,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val background = colors.surfaceContainerLow
    val language =
        source.language?.let(::codeLanguageName)
            ?: stringResource(R.string.conversation_code_generic)
    val copy = copyConversationCode(source.text, reader.feedback)
    val focus = remember { FocusRequester() }
    val horizontal = rememberScrollState()
    val returning = reader.returning?.takeIf { it.target == target }
    val long = source.lineCount > ConversationCodePreviewLines
    LaunchedEffect(returning, long) {
        if (returning != null && long) {
            horizontal.scrollTo(returning.previewOffsetPx)
            if (focus.requestFocus()) reader.restored(returning)
        }
    }
    Surface(
        modifier.fillMaxWidth().testTag("conversation_code_card"),
        shape = MaterialTheme.shapes.medium,
        color = background,
        contentColor = colors.onSurface,
        border = BorderStroke(1.dp, colors.outlineVariant),
    ) {
        Column {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 12.dp, end = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    language,
                    Modifier.weight(1f),
                    color = colors.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                )
                CodeIconButton(
                    R.drawable.ic_content_copy,
                    R.string.conversation_code_copy,
                    copy,
                )
            }
            CodeText(
                source.preview,
                source.language,
                background,
                Modifier.fillMaxWidth()
                    .padding(start = 12.dp, end = 12.dp, bottom = 12.dp)
                    .horizontalScroll(horizontal),
            )
            if (long) {
                CodePreviewFooter(source.lineCount, focus) { reader.open(target, horizontal.value) }
            }
        }
    }
}

@Composable
private fun CodePreviewFooter(lineCount: Int, focus: FocusRequester, open: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val type = MaterialTheme.typography
    val count =
        pluralStringResource(
            R.plurals.conversation_code_lines,
            lineCount,
            ConversationCodePreviewLines,
            lineCount,
        )
    val action = stringResource(R.string.conversation_code_view)
    HorizontalDivider(color = colors.outlineVariant)
    BoxWithConstraints(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 12.dp, end = 4.dp),
    ) {
        val measure = rememberTextMeasurer()
        val density = LocalDensity.current
        val layout = LocalLayoutDirection.current
        val buttonPadding = ButtonDefaults.TextButtonContentPadding
        val countWidth = with(density) { measure.measure(count, type.bodySmall).size.width.toDp() }
        val actionWidth =
            with(density) { measure.measure(action, type.labelLarge).size.width.toDp() } +
                buttonPadding.calculateLeftPadding(layout) +
                buttonPadding.calculateRightPadding(layout)
        val label: @Composable () -> Unit = {
            Text(count, style = type.bodySmall, color = colors.onSurfaceVariant)
        }
        val button: @Composable () -> Unit = {
            TextButton(
                open,
                Modifier.focusRequester(focus)
                    .updateFocusOutline(CircleShape, colors.onSurface, keyboardOnly = true),
            ) {
                Text(action)
            }
        }
        if (countWidth + maxOf(48.dp, actionWidth) + 4.dp <= maxWidth) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                label()
                button()
            }
        } else {
            Column(Modifier.fillMaxWidth()) {
                Box(Modifier.padding(top = 8.dp)) { label() }
                Box(Modifier.align(Alignment.End)) { button() }
            }
        }
    }
}

@Composable
internal fun ConversationFullCode(
    history: ConversationHistoryModel,
    presentation: ConversationContent?,
    visit: ConversationCodeVisit,
    wide: Boolean,
    back: () -> Unit,
    expand: () -> Unit,
) {
    val historyState by history.uiState.collectAsStateWithLifecycle()
    val availableHistory = historyState.takeIf { it.thread?.id == visit.threadId }
    val messages =
        if (presentation != null) presentation.messages
        else {
            val output by history.output.state.collectAsStateWithLifecycle()
            remember(availableHistory?.transcript, output, visit.threadId) {
                conversationContent(
                        availableHistory?.transcript,
                        output,
                        visit.threadId,
                        emptyList(),
                        emptySet(),
                    )
                    .messages
            }
        }
    val target = visit.target
    val missing = availableHistory?.phase == HistoryPhase.Missing
    val body =
        remember(messages, target, missing) {
            messages
                .firstNotNullOfOrNull { row ->
                    when {
                        row.message.id == target.messageId -> row.message
                        else -> row.earlier.firstOrNull { it.id == target.messageId }
                    }
                }
                ?.blocks
                ?.getOrNull(target.bodyIndex)
                ?.takeIf { !missing && it.kind == HistoryBlockKind.Text }
                ?.text
        }
    val code =
        rememberMarkdownLayout(body) { it?.let { conversationMarkdownCode(it, target.path) } }
    val retire = code == null && availableHistory?.phase?.let { it != HistoryPhase.Loading } == true
    LaunchedEffect(retire) {
        if (retire) back()
    }
    FullCodePage(
        code.takeUnless { missing },
        wide,
        visit.expanded,
        back,
        expand,
    )
}

@Composable
private fun FullCodePage(
    source: ConversationCodeSource?,
    wide: Boolean,
    expanded: Boolean,
    back: () -> Unit,
    expand: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val feedback = remember { SnackbarHostState() }
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val copy =
        copyConversationCode(source?.text.orEmpty()) { message ->
            scope.launch { feedback.showSnackbar(resources.getString(message)) }
        }
    val backFocus = remember { FocusRequester() }
    val input = LocalInputModeManager.current
    var expansionFocused by remember { mutableStateOf(false) }
    LaunchedEffect(backFocus) {
        if (input.inputMode == InputMode.Keyboard) backFocus.requestFocus()
    }
    LaunchedEffect(wide) {
        if (!wide && expansionFocused) backFocus.requestFocus()
    }
    Surface(Modifier.fillMaxSize().testTag("conversation_full_code"), color = colors.surface) {
        Column {
            Row(
                Modifier.fillMaxWidth()
                    .heightIn(min = 64.dp)
                    .padding(horizontal = 12.dp)
                    .testTag("conversation_code_toolbar"),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CodeIconButton(
                    R.drawable.ic_arrow_back,
                    R.string.back,
                    back,
                    Modifier.focusRequester(backFocus).onFocusChanged {
                        if (it.isFocused) expansionFocused = false
                    },
                )
                Text(
                    stringResource(R.string.conversation_code_full),
                    Modifier.weight(1f),
                    style =
                        MaterialTheme.typography.titleLarge.copy(
                            fontSize = 20.sp,
                            lineHeight = 28.sp,
                            fontWeight = FontWeight.SemiBold,
                        ),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (wide) {
                    CodeIconButton(
                        if (expanded) R.drawable.ic_fullscreen_exit else R.drawable.ic_fullscreen,
                        if (expanded) R.string.conversation_code_collapse
                        else R.string.conversation_code_expand,
                        expand,
                        Modifier.onFocusChanged { if (it.isFocused) expansionFocused = true },
                    )
                }
                CodeIconButton(
                    R.drawable.ic_content_copy,
                    R.string.conversation_code_copy,
                    copy,
                    Modifier.onFocusChanged { if (it.isFocused) expansionFocused = false },
                    enabled = source != null,
                )
            }
            Box(Modifier.fillMaxWidth().weight(1f)) {
                val vertical = rememberScrollState()
                val horizontal = rememberScrollState()
                if (source != null) {
                    Box(
                        Modifier.fillMaxSize().padding(16.dp).verticalScroll(vertical),
                    ) {
                        CodeText(
                            source.text,
                            source.language,
                            colors.surface,
                            Modifier.fillMaxWidth().horizontalScroll(horizontal),
                            vertical,
                            onFocus = { expansionFocused = false },
                        )
                    }
                } else {
                    CircularProgressIndicator(Modifier.align(Alignment.Center).size(20.dp))
                }
                WorkspaceFeedbackHost(
                    feedback,
                    Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun CodeText(
    source: String,
    language: String?,
    background: Color,
    modifier: Modifier,
    vertical: ScrollState? = null,
    onFocus: () -> Unit = {},
) {
    val colors = MaterialTheme.colorScheme
    val display = remember(source) { codeDisplayText(source) }
    var selected by remember { mutableStateOf(TextRange.Zero) }
    var styled by
        remember(display, language, colors, background) {
            mutableStateOf(AnnotatedString(display))
        }
    LaunchedEffect(display, language, colors, background) {
        styled =
            withContext(Dispatchers.Default) {
                codeHighlight(display, language, colors, background)
            }
    }
    var measured by remember { mutableStateOf<String?>(null) }
    var previous by remember { mutableStateOf(display) }
    val follow =
        remember(display, vertical) {
            vertical != null &&
                vertical.maxValue != Int.MAX_VALUE &&
                !vertical.canScrollForward &&
                selected.collapsed &&
                display.length > previous.length &&
                display.startsWith(previous)
        }
    LaunchedEffect(display) {
        previous = display
        if (follow && vertical != null) {
            snapshotFlow { measured }.first { it == display }
            withFrameNanos {}
            if (selected.collapsed) vertical.scrollTo(vertical.maxValue)
        }
    }
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Box(modifier) {
            BasicTextField(
                TextFieldValue(styled, selected),
                onValueChange = { if (it.text == display) selected = it.selection },
                modifier =
                    Modifier.testTag("conversation_code_source")
                        .onFocusChanged { if (it.isFocused) onFocus() }
                        .updateFocusOutline(
                            MaterialTheme.shapes.extraSmall,
                            colors.onSurface,
                            keyboardOnly = true,
                        ),
                readOnly = true,
                textStyle =
                    TextStyle(
                        color = colors.onSurface,
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Normal,
                        fontSize = 14.sp,
                        lineHeight = 20.sp,
                        textDirection = TextDirection.Ltr,
                        textAlign = TextAlign.Start,
                    ),
                onTextLayout = { if (vertical != null) measured = it.layoutInput.text.text },
            )
        }
    }
}

@Composable
private fun CodeIconButton(
    @DrawableRes icon: Int,
    @StringRes description: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    IconButton(
        onClick,
        modifier.updateFocusOutline(
            CircleShape,
            MaterialTheme.colorScheme.onSurface,
            keyboardOnly = true,
        ),
        enabled = enabled,
    ) {
        Icon(painterResource(icon), stringResource(description), Modifier.size(24.dp))
    }
}

@Composable
private fun copyConversationCode(source: String, feedback: (Int) -> Unit): () -> Unit {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    return {
        scope.launch {
            val message =
                try {
                    clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(null, source)))
                    R.string.conversation_code_copied.takeIf { Build.VERSION.SDK_INT < 33 }
                } catch (error: CancellationException) {
                    throw error
                } catch (_: RuntimeException) {
                    R.string.conversation_code_copy_failed
                }
            message?.let(feedback)
        }
    }
}
