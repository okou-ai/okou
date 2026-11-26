package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.WorkspaceSearchInput
import ai.okou.android.WorkspaceSearchToolbar
import ai.okou.android.committedSearchText
import ai.okou.android.currentWindowSizeDp
import ai.okou.android.searchClearAction
import ai.okou.android.workspaceSearchControlHeight
import ai.okou.android.workspaceSearchFocusOutline
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/** The snapshot and native search state live for one visit in the current conversation. */
internal class ConversationFindVisit(
    transcript: HistoryTranscript?,
    private val rows: List<HistoryEvent>,
    private val artifactCards: Boolean,
    val restoreActionsFocus: Boolean,
    private val imageNames: Flow<Map<String, String>>? = null,
) {
    private val messages = transcript?.messages.orEmpty()
    private val pendingInputIds = transcript?.pendingInputIds.orEmpty()
    private var indexedImageNames: Map<String, String>? = null

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

    var focusPending = true
        private set

    fun focusRestored() {
        focusPending = false
    }

    fun onInputFocusChanged(focused: Boolean) {
        inputFocused = focused
    }

    suspend fun prepareIndex() {
        (imageNames ?: flowOf(emptyMap())).collectLatest { names ->
            if (index != null && indexedImageNames == names) return@collectLatest
            // Remove revoked names from the visible results before rebuilding off Main.
            if (indexedImageNames.orEmpty().any { (source, name) -> names[source] != name }) {
                index = null
            }
            val refreshed =
                withContext(Dispatchers.Default) {
                    findMessages(messages, rows, pendingInputIds, artifactCards, names)
                }
            if (input.composition != null) {
                snapshotFlow {
                    input.composition == null || normalizeFindText(input.text.toString()) == keyword
                }
                    .first { it }
            }
            index = refreshed
            indexedImageNames = names
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
                result.passage?.index?.toString().takeIf { message.role == HistoryRole.Assistant },
                bodyIndex = result.passage?.bodyIndex,
                markdownImage = result.passage?.imagePath,
            )
    }

    fun returnToResults() {
        focusPending = true
        target = null
    }
}

internal class ConversationFindTarget(
    val id: String,
    val markdownBlockPath: String?,
    val isRun: Boolean = false,
    val bodyIndex: Int? = null,
    val markdownImage: String? = null,
) {
    var positioned by mutableStateOf(false)
        private set

    var highlighted by mutableStateOf(true)
        private set

    fun finishPositioning() {
        positioned = true
    }

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

internal data class FindPassage(
    val index: Int,
    val start: Int,
    val end: Int,
    val bodyIndex: Int,
    val imagePath: String?,
)

internal data class FindMessage(
    val id: String,
    val role: HistoryRole,
    val text: String,
    val passages: List<FindPassage>,
    val attachmentOnly: Boolean,
    val filenames: List<String>,
)

internal data class FindResult(
    val message: FindMessage,
    val match: Int = 0,
    val passage: FindPassage? = null,
    val text: String = message.text,
)

private fun findMessages(
    messages: List<HistoryMessage>,
    rows: List<HistoryEvent>,
    pendingInputIds: Set<String>,
    artifactCards: Boolean,
    imageNames: Map<String, String>,
): List<FindMessage> {
    val byId = messages.associateBy { it.id }
    return rows.asReversed().mapNotNull { row ->
        val message = byId[row.id] ?: return@mapNotNull null
        if (message.role == HistoryRole.System || message.rejected || row.id in pendingInputIds)
            return@mapNotNull null
        val text = StringBuilder()
        val passages = buildList {
            for ((bodyIndex, block) in message.blocks.withIndex()) {
                if (block.kind != HistoryBlockKind.Text) continue
                val parts =
                    if (message.role == HistoryRole.Assistant)
                        conversationMarkdownFindPassages(block.text, artifactCards, imageNames)
                    else listOf(MarkdownFindPassage(0, block.text))
                for (part in parts) {
                    val normalized = normalizeFindText(part.text)
                    if (normalized.isEmpty()) continue
                    if (text.isNotEmpty()) text.append(' ')
                    val start = text.length
                    text.append(normalized)
                    add(FindPassage(part.block, start, text.length, bodyIndex, part.imagePath))
                }
            }
        }
        val references =
            if (message.role == HistoryRole.User)
                message.blocks.filter {
                    it.kind == HistoryBlockKind.Attachment || it.kind == HistoryBlockKind.Reference
                }
            else emptyList()
        if (text.isEmpty() && references.isEmpty()) return@mapNotNull null
        val attachments = references.filter { it.isFindAttachment() }
        val filenames = attachments.mapNotNull {
            (it.attachment?.filename ?: it.title)?.let(::normalizeFindText)
        }
        FindMessage(
            message.id,
            message.role,
            text.toString(),
            passages,
            attachments.isNotEmpty() && attachments.size == references.size,
            filenames,
        )
    }
}

private fun HistoryBlock.isFindAttachment(): Boolean {
    if (kind == HistoryBlockKind.Attachment) return true
    val part = Json.parseToJsonElement(text) as? JsonObject
    return when (part?.text("type")) {
        "attachment",
        "file",
        "image" -> true
        else -> false
    }
}

internal fun conversationFindResults(
    messages: List<FindMessage>,
    keyword: String,
): List<FindResult> = messages.mapNotNull { message ->
    if (keyword.isEmpty()) {
        FindResult(message).takeIf { message.role == HistoryRole.User }
    } else {
        val match = message.text.indexOf(keyword, ignoreCase = true)
        if (match < 0) {
            for (filename in message.filenames) {
                val filenameMatch = filename.indexOf(keyword, ignoreCase = true)
                if (filenameMatch >= 0)
                    return@mapNotNull FindResult(message, filenameMatch, text = filename)
            }
            return@mapNotNull null
        }
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
    val focusColor = colors.onSurface
    val keyboardMode = LocalInputModeManager.current.inputMode == InputMode.Keyboard
    val rowShape = RoundedCornerShape(8.dp)
    LaunchedEffect(visit) { visit.prepareIndex() }
    LaunchedEffect(visit) {
        snapshotFlow { visit.input.committedSearchText() }
            .filterNotNull()
            .collect(visit::commitQuery)
    }
    val index = visit.index
    val keyword = visit.keyword
    val filtered by
        produceState<Triple<List<FindMessage>, String, List<FindResult>>?>(null, index, keyword) {
            value = index?.let { loaded ->
                withContext(Dispatchers.Default) {
                    Triple(loaded, keyword, conversationFindResults(loaded, keyword))
                }
            }
        }
    val results = filtered?.takeIf { it.first === index && it.second == keyword }?.third
    LaunchedEffect(visit) {
        if (visit.focusPending && visit.focusedResult == null && inputFocus.requestFocus()) {
            visit.focusRestored()
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
                        modifier =
                            Modifier.size(workspaceSearchControlHeight())
                                .workspaceSearchFocusOutline(CircleShape),
                    ) {
                        Icon(
                            painterResource(R.drawable.ic_arrow_back),
                            stringResource(R.string.back),
                        )
                    }
                },
                field = { modifier ->
                    WorkspaceSearchInput(
                        state = visit.input,
                        label = label,
                        onClear = searchClearAction(inputFocus) { visit.input.clearText() },
                        modifier =
                            modifier
                                .focusRequester(inputFocus)
                                .onFocusChanged { visit.onInputFocusChanged(it.isFocused) }
                                .testTag("conversation_find_query"),
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
                    Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                        Text(
                            when {
                                keyword.isEmpty() && results.isEmpty() ->
                                    stringResource(R.string.conversation_find_empty)
                                keyword.isEmpty() ->
                                    stringResource(R.string.conversation_find_turns)
                                results.isEmpty() ->
                                    stringResource(R.string.conversation_find_no_match)
                                else ->
                                    pluralStringResource(
                                        R.plurals.conversation_find_matches,
                                        results.size,
                                        results.size,
                                    )
                            },
                            Modifier.semantics { heading() },
                            style = summaryStyle.copy(fontWeight = FontWeight.SemiBold),
                            color = colors.onSurfaceVariant,
                        )
                        Text(
                            stringResource(R.string.conversation_find_loaded_scope),
                            style = summaryStyle,
                            color = colors.onSurfaceVariant,
                        )
                    }
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
                                else Modifier,
                            )
                            .onFocusChanged { rowFocused = it.isFocused }
                            .then(
                                if (restoreFocus)
                                    Modifier.focusProperties { canFocus = true }
                                        .focusRequester(resultFocus)
                                else Modifier,
                            )
                            .clickable(role = Role.Button) {
                                keyboard?.hide()
                                visit.open(result)
                            }
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalArrangement =
                            Arrangement.spacedBy(4.dp, Alignment.CenterVertically),
                    ) {
                        if (keyword.isEmpty()) {
                            Text(
                                message.text.ifEmpty {
                                    stringResource(
                                        if (message.attachmentOnly)
                                            R.string.conversation_find_attachment
                                        else R.string.history_reference,
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
                                    else R.string.app_name,
                                ),
                                style = titleStyle,
                            )
                            FindExcerpt(result, keyword.length, summaryStyle)
                        }
                    }
                    if (restoreFocus) {
                        LaunchedEffect(message.id) {
                            if (visit.focusPending && resultFocus.requestFocus())
                                visit.focusRestored()
                        }
                    }
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
    val text = result.text
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
