package ai.okou.android.chat

import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.R
import ai.okou.android.WorkspaceSearchField
import ai.okou.android.WorkspaceSearchToolbar
import ai.okou.android.currentWindowSizeDp
import ai.okou.android.workspaceSearchControlHeight
import ai.okou.android.workspaceSearchTextStyle
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.clearText
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/** The snapshot and native search state live for one visit in the current conversation. */
internal class ConversationFindVisit(
    private val messages: List<HistoryMessage>,
    private val rows: List<HistoryEvent>,
) {
    val hasLoadedMessages: Boolean
        get() = messages.isNotEmpty()

    val position = LazyListState()
    val input = TextFieldState()
    var inputFocused by mutableStateOf(false)
        private set

    var index by mutableStateOf<List<FindMessage>?>(null)
        private set

    var keyword by mutableStateOf("")
        private set

    var target by mutableStateOf<ConversationFindTarget?>(null)
        private set

    var focusedResult by mutableStateOf<String?>(null)
        private set

    fun onInputFocusChanged(focused: Boolean) {
        inputFocused = focused
    }

    suspend fun prepareIndex() {
        if (index == null) {
            index = withContext(Dispatchers.Default) { findMessages(messages, rows) }
        }
    }

    fun commitQuery(value: String) {
        val normalized = normalizeFindText(value)
        if (normalized == keyword) return
        keyword = normalized
        focusedResult = null
        position.requestScrollToItem(0)
    }

    fun open(result: FindResult) {
        val message = result.message
        focusedResult = message.id
        target =
            ConversationFindTarget(
                message.id,
                result.passage?.index.takeIf { message.role == HistoryRole.Assistant },
            )
    }

    fun returnToResults() {
        target = null
    }
}

internal class ConversationFindTarget(val id: String, val markdownBlock: Int?) {
    var highlighted by mutableStateOf(true)
        private set

    suspend fun expireHighlight() {
        if (!highlighted) return
        try {
            delay(FindHighlightDurationMillis)
        } finally {
            highlighted = false
        }
    }
}

private const val FindHighlightDurationMillis = 2_000L

private val findWhitespace = Regex("[\\s\\p{Z}]+")

private fun normalizeFindText(text: String): String = text.replace(findWhitespace, " ").trim()

internal data class FindPassage(val index: Int, val start: Int, val end: Int)

internal data class FindMessage(
    val id: String,
    val role: HistoryRole,
    val text: String,
    val passages: List<FindPassage>,
    val attachmentOnly: Boolean,
)

internal data class FindResult(
    val message: FindMessage,
    val match: Int = 0,
    val passage: FindPassage? = null,
)

internal fun findMessages(
    messages: List<HistoryMessage>,
    rows: List<HistoryEvent>,
): List<FindMessage> {
    val byId = messages.associateBy { it.id }
    return rows.asReversed().mapNotNull { row ->
        val message = byId[row.id] ?: return@mapNotNull null
        if (message.role == HistoryRole.System || message.rejected || message.queued)
            return@mapNotNull null
        val parts =
            message.blocks
                .filter { it.kind == HistoryBlockKind.Text }
                .flatMap {
                    if (message.role == HistoryRole.Assistant)
                        conversationMarkdownFindPassages(it.text)
                    else listOf(it.text)
                }
        val text = StringBuilder()
        val passages = buildList {
            for ((index, part) in parts.withIndex()) {
                val normalized = normalizeFindText(part)
                if (normalized.isEmpty()) continue
                if (text.isNotEmpty()) text.append(' ')
                val start = text.length
                text.append(normalized)
                add(FindPassage(index, start, text.length))
            }
        }
        if (text.isNotEmpty()) {
            return@mapNotNull FindMessage(
                message.id,
                message.role,
                text.toString(),
                passages,
                false,
            )
        }
        val references = message.blocks.filter { it.kind == HistoryBlockKind.Reference }
        if (references.isEmpty() || message.role != HistoryRole.User) return@mapNotNull null
        val attachments =
            references.all { reference ->
                val part = Json.parseToJsonElement(reference.text)
                when ((part as? JsonObject)?.text("type")) {
                    "attachment",
                    "file",
                    "image" -> true
                    else -> false
                }
            }
        FindMessage(message.id, message.role, "", emptyList(), attachments)
    }
}

internal fun conversationFindResults(
    messages: List<FindMessage>,
    keyword: String,
): List<FindResult> =
    messages.mapNotNull { message ->
        if (keyword.isEmpty()) {
            FindResult(message).takeIf { message.role == HistoryRole.User }
        } else {
            val match = message.text.indexOf(keyword, ignoreCase = true)
            if (match < 0) return@mapNotNull null
            val passage =
                message.passages.firstOrNull {
                    match >= it.start && match + keyword.length <= it.end
                }
            FindResult(message, match, passage)
        }
    }

@Composable
internal fun ConversationFind(visit: ConversationFindVisit, onClose: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val titleStyle = workspaceSearchTextStyle().copy(fontSize = 16.sp, lineHeight = 24.sp)
    val summaryStyle = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 20.sp)
    val label = stringResource(R.string.conversation_find)
    val keyboard = LocalSoftwareKeyboardController.current
    val inputFocus = remember { FocusRequester() }
    val resultFocus = remember { FocusRequester() }
    val focusColor = LocalActivityStatusColor.current
    val keyboardMode = LocalInputModeManager.current.inputMode == InputMode.Keyboard
    val rowShape = RoundedCornerShape(8.dp)
    LaunchedEffect(visit) { visit.prepareIndex() }
    LaunchedEffect(visit) {
        snapshotFlow { visit.input.text.toString().takeIf { visit.input.composition == null } }
            .filterNotNull()
            .collect(visit::commitQuery)
    }
    val index = visit.index
    val keyword = visit.keyword
    val filtered by
        produceState<Pair<String, List<FindResult>>?>(null, index, keyword) {
            value =
                index?.let { loaded ->
                    withContext(Dispatchers.Default) {
                        keyword to conversationFindResults(loaded, keyword)
                    }
                }
        }
    val results = filtered?.takeIf { it.first == keyword }?.second
    LaunchedEffect(visit) {
        if (visit.focusedResult == null) {
            inputFocus.requestFocus()
            keyboard?.show()
        }
    }
    Column(
        Modifier.fillMaxSize().testTag("conversation_find"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.widthIn(max = 720.dp)) {
            WorkspaceSearchToolbar(
                currentWindowSizeDp().width,
                null,
                leading = {
                    IconButton(
                        onClick = onClose,
                        modifier = Modifier.size(workspaceSearchControlHeight()),
                    ) {
                        Icon(
                            painterResource(R.drawable.ic_arrow_back),
                            stringResource(R.string.back),
                        )
                    }
                },
                field = { modifier ->
                    BasicTextField(
                        state = visit.input,
                        modifier =
                            modifier
                                .focusRequester(inputFocus)
                                .onFocusChanged { visit.onInputFocusChanged(it.isFocused) }
                                .testTag("conversation_find_query")
                                .semantics { contentDescription = label },
                        textStyle = titleStyle.copy(color = colors.onSurface),
                        lineLimits = TextFieldLineLimits.SingleLine,
                        cursorBrush = SolidColor(colors.onSurface),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        onKeyboardAction = { keyboard?.hide() },
                        decorator = { input ->
                            WorkspaceSearchField(
                                Modifier.fillMaxWidth(),
                                focused = visit.inputFocused,
                                hasTrailingAction = visit.input.text.isNotEmpty(),
                            ) {
                                Box(Modifier.weight(1f).padding(vertical = 8.dp)) {
                                    if (visit.input.text.isEmpty())
                                        Text(
                                            label,
                                            style = titleStyle,
                                            color = colors.onSurfaceVariant,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    input()
                                }
                                if (visit.input.text.isNotEmpty()) {
                                    IconButton(
                                        onClick = {
                                            visit.input.clearText()
                                            inputFocus.requestFocus()
                                            keyboard?.show()
                                        }
                                    ) {
                                        Icon(
                                            painterResource(R.drawable.ic_close),
                                            stringResource(R.string.chat_search_clear),
                                            modifier = Modifier.size(20.dp),
                                            tint = colors.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                        },
                    )
                },
            )
        }
        if (results != null) {
            LazyColumn(
                Modifier.widthIn(max = 720.dp)
                    .fillMaxWidth()
                    .weight(1f)
                    .padding(horizontal = 16.dp),
                state = visit.position,
            ) {
                item {
                    Text(
                        when {
                            keyword.isEmpty() && results.isEmpty() ->
                                stringResource(R.string.conversation_find_empty)
                            keyword.isEmpty() -> stringResource(R.string.conversation_find_turns)
                            results.isEmpty() -> stringResource(R.string.conversation_find_no_match)
                            else ->
                                pluralStringResource(
                                    R.plurals.conversation_find_matches,
                                    results.size,
                                    results.size,
                                )
                        },
                        Modifier.padding(horizontal = 12.dp, vertical = 8.dp).semantics {
                            heading()
                        },
                        style = summaryStyle.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.onSurfaceVariant,
                    )
                }
                items(results, key = { it.message.id }) { result ->
                    val message = result.message
                    val restoreFocus = visit.focusedResult == message.id
                    var rowFocused by remember { mutableStateOf(false) }
                    Column(
                        Modifier.fillMaxWidth()
                            .heightIn(min = 52.dp)
                            .clip(rowShape)
                            .then(
                                if (rowFocused && keyboardMode)
                                    Modifier.border(2.dp, focusColor, rowShape)
                                else Modifier
                            )
                            .onFocusChanged { rowFocused = it.isFocused }
                            .then(
                                if (restoreFocus)
                                    Modifier.focusProperties { canFocus = true }
                                        .focusRequester(resultFocus)
                                else Modifier
                            )
                            .clickable(role = Role.Button) {
                                keyboard?.hide()
                                visit.open(result)
                            }
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically),
                    ) {
                        if (keyword.isEmpty()) {
                            Text(
                                message.text.ifEmpty {
                                    stringResource(
                                        if (message.attachmentOnly)
                                            R.string.conversation_find_attachment
                                        else R.string.history_reference
                                    )
                                },
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                style = titleStyle,
                            )
                        } else {
                            Text(
                                stringResource(
                                    if (message.role == HistoryRole.User)
                                        R.string.conversation_find_you
                                    else R.string.app_name
                                ),
                                style = titleStyle,
                            )
                            FindExcerpt(result, keyword.length, summaryStyle)
                        }
                    }
                    if (restoreFocus) LaunchedEffect(message.id) { resultFocus.requestFocus() }
                }
            }
        }
    }
}

@Composable
private fun FindExcerpt(result: FindResult, matchLength: Int, style: TextStyle) {
    val colors = MaterialTheme.colorScheme
    val windowSize = LocalWindowInfo.current.containerSize
    val density = LocalDensity.current
    var startAtMatch by remember(result, matchLength, windowSize, density) { mutableStateOf(false) }
    val text = result.message.text
    val excerptStart = result.passage?.start ?: 0
    val excerptEnd = result.passage?.end ?: text.length
    val start =
        if (startAtMatch) result.match
        else text.codePointBoundary((result.match - 24).coerceAtLeast(excerptStart))
    val end = result.match + matchLength
    val endOfSnippet = text.codePointBoundary(end + minOf(160, excerptEnd - end))
    val ellipsis = !startAtMatch && start > excerptStart
    val snippet = buildAnnotatedString {
        if (ellipsis) append("…")
        append(text, start, result.match)
        withStyle(SpanStyle(color = colors.onSurface, fontWeight = FontWeight.Bold)) {
            append(text, result.match, end)
        }
        append(text, end, endOfSnippet)
        if (endOfSnippet < excerptEnd) append("…")
    }
    val matchEndInSnippet = end - start + if (ellipsis) 1 else 0
    Text(
        snippet,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        style = style,
        color = colors.onSurfaceVariant,
        onTextLayout = { layout ->
            if (
                !startAtMatch &&
                    start < result.match &&
                    layout.lineCount > 0 &&
                    layout.getLineEnd(layout.lineCount - 1, visibleEnd = true) < matchEndInSnippet
            ) {
                startAtMatch = true
            }
        },
    )
}

private fun String.codePointBoundary(offset: Int): Int =
    if (offset in 1 until length && Character.isSurrogatePair(this[offset - 1], this[offset]))
        offset - 1
    else offset
