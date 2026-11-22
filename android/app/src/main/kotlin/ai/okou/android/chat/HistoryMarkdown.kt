package ai.okou.android.chat

import ai.okou.android.artifacts.ArtifactKind
import ai.okou.android.artifacts.icon
import ai.okou.android.artifacts.label
import ai.okou.android.artifacts.messageArtifactLink
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.node.AbstractVisitor
import org.commonmark.node.BlockQuote
import org.commonmark.node.Code
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.ListBlock
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text as MarkdownText
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.Parser

internal data class ChatArtifactActions(
    val open: (link: String, focusKey: String) -> Unit,
    val restoreKey: String?,
    val restored: () -> Unit,
)

/** UI-owned parsing stays off Main; no HTML execution, image downloads or automatic link opens. */
@Composable
internal fun HistoryMarkdown(
    source: String,
    style: TextStyle,
    artifacts: ChatArtifactActions?,
    messageId: String,
) =
    key(source, artifacts != null) {
        val rendered by
            produceState<List<HistoryMarkdownBlock>?>(null) {
                value =
                    withContext(Dispatchers.Default) {
                        historyMarkdownBlocks(source, artifacts != null)
                    }
            }
        val blocks = rendered
        if (blocks == null) {
            Text(source, style = style)
        } else {
            HistoryMarkdownBlocks(blocks, style, artifacts, messageId)
        }
    }

@Composable
internal fun HistoryMarkdown(source: String, compactLists: Boolean = false) {
    val rendered by
        produceState<AnnotatedString?>(null, source, compactLists) {
            value = withContext(Dispatchers.Default) { renderHistoryMarkdown(source, compactLists) }
        }
    Text(rendered ?: AnnotatedString(source))
}

@Composable
private fun HistoryMarkdownBlocks(
    blocks: List<HistoryMarkdownBlock>,
    style: TextStyle,
    artifacts: ChatArtifactActions?,
    focusPrefix: String,
    modifier: Modifier = Modifier,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for ((index, block) in blocks.withIndex()) when (block) {
            is HistoryMarkdownBlock.Table -> HistoryMarkdownTable(block.rows)
            is HistoryMarkdownBlock.ListItems ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for ((itemIndex, item) in block.items.withIndex()) {
                        Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                            Text(item.marker, Modifier.widthIn(min = 16.dp), style = style)
                            HistoryMarkdownBlocks(
                                item.blocks,
                                style,
                                artifacts,
                                "$focusPrefix/$index/$itemIndex",
                                Modifier.weight(1f),
                            )
                        }
                    }
                }
            is HistoryMarkdownBlock.Paragraph -> {
                val blockStyle =
                    when (block.heading) {
                        1 ->
                            style.copy(
                                fontSize = 20.sp,
                                lineHeight = 28.sp,
                                fontWeight = FontWeight.Bold,
                            )
                        in 2..6 ->
                            style.copy(
                                fontSize = 16.sp,
                                lineHeight = 24.sp,
                                fontWeight = FontWeight.Bold,
                            )
                        else -> style
                    }
                val cards =
                    remember(block.text) {
                        block.text.getStringAnnotations("artifact", 0, block.text.length)
                    }
                if (artifacts == null || cards.isEmpty()) {
                    Text(block.text, style = blockStyle)
                } else {
                    var start = 0
                    for (card in cards) {
                        val before = block.text.subSequence(start, card.start)
                        if (before.isNotBlank()) Text(before, style = blockStyle)
                        val focusKey = "$focusPrefix/$index/${card.start}"
                        MessageArtifactCard(
                            block.text.text.substring(card.start, card.end),
                            card.item,
                            restoreFocus =
                                artifacts.restored.takeIf { artifacts.restoreKey == focusKey },
                        ) {
                            artifacts.open(card.item, focusKey)
                        }
                        start = card.end
                    }
                    val after = block.text.subSequence(start, block.text.length)
                    if (after.isNotBlank()) Text(after, style = blockStyle)
                }
            }
        }
    }
}

@Composable
private fun MessageArtifactCard(
    title: String,
    link: String,
    restoreFocus: (() -> Unit)?,
    onOpen: () -> Unit,
) {
    val kind =
        when {
            link.startsWith("https://") -> ArtifactKind.Website
            link.endsWith(".pptx") -> ArtifactKind.Presentation
            link.substringAfterLast('.') in setOf("png", "jpg", "jpeg", "webp", "gif") ->
                ArtifactKind.Image
            link.substringAfterLast('.') in setOf("mp4", "webm", "mov") -> ArtifactKind.Video
            else -> ArtifactKind.File
        }
    val shape = RoundedCornerShape(16.dp)
    val focus = remember { FocusRequester() }
    val restore =
        if (restoreFocus == null) Modifier
        else
            Modifier.focusRequester(focus).onGloballyPositioned {
                if (focus.requestFocus()) restoreFocus()
            }
    Surface(shape = shape, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)) {
        Row(
            Modifier.fillMaxWidth()
                .then(restore)
                .heightIn(min = 60.dp)
                .clip(shape)
                .clickable(onClick = onOpen)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(painterResource(kind.icon()), null, Modifier.size(20.dp))
            Column {
                Text(
                    title,
                    style =
                        MaterialTheme.typography.bodyMedium.copy(
                            fontSize = 14.sp,
                            lineHeight = 20.sp,
                        ),
                )
                Text(
                    stringResource(kind.label()),
                    style =
                        MaterialTheme.typography.bodySmall.copy(
                            fontSize = 12.sp,
                            lineHeight = 16.sp,
                        ),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

private sealed interface HistoryMarkdownBlock {
    data class Paragraph(val text: AnnotatedString, val heading: Int) : HistoryMarkdownBlock

    data class Table(val rows: List<List<HistoryMarkdownCell>>) : HistoryMarkdownBlock

    data class ListItems(val items: List<HistoryMarkdownListItem>) : HistoryMarkdownBlock
}

private data class HistoryMarkdownCell(val text: AnnotatedString, val alignment: TextAlign)

private data class HistoryMarkdownListItem(
    val marker: String,
    val blocks: List<HistoryMarkdownBlock>,
)

private val historyMarkdownParser =
    Parser.builder().extensions(listOf(TablesExtension.create())).build()

private val artifactMarkdownParser = Parser.builder().build()

private fun historyMarkdownBlocks(
    source: String,
    artifactCards: Boolean,
): List<HistoryMarkdownBlock> =
    historyMarkdownParser
        .parse(source)
        .children()
        .map { it.historyMarkdownBlock(artifactCards) }
        .toList()

private fun Node.historyMarkdownBlock(artifactCards: Boolean): HistoryMarkdownBlock =
    when (this) {
        is TableBlock -> HistoryMarkdownBlock.Table(historyMarkdownRows(this))
        is ListBlock -> {
            val startNumber = (this as? OrderedList)?.markerStartNumber
            HistoryMarkdownBlock.ListItems(
                children()
                    .mapIndexed { index, item ->
                        val marker = if (startNumber == null) "•" else "${startNumber + index}."
                        HistoryMarkdownListItem(
                            marker,
                            item.children().map { it.historyMarkdownBlock(artifactCards) }.toList(),
                        )
                    }
                    .toList()
            )
        }
        else -> {
            val rendered = renderHistoryMarkdownNode(this, artifactCards = artifactCards)
            HistoryMarkdownBlock.Paragraph(
                rendered.subSequence(0, rendered.text.trimEnd('\n').length),
                (this as? Heading)?.level ?: 0,
            )
        }
    }

private fun Node.children(): Sequence<Node> = generateSequence(firstChild) { it.next }

private fun historyMarkdownRows(table: TableBlock): List<List<HistoryMarkdownCell>> =
    table
        .children()
        .flatMap { it.children() }
        .map { row ->
            row.children()
                .filterIsInstance<TableCell>()
                .map { cell ->
                    HistoryMarkdownCell(
                        renderHistoryMarkdownNode(cell),
                        when (cell.alignment) {
                            TableCell.Alignment.LEFT -> TextAlign.Left
                            TableCell.Alignment.CENTER -> TextAlign.Center
                            TableCell.Alignment.RIGHT -> TextAlign.Right
                            null -> TextAlign.Start
                        },
                    )
                }
                .toList()
        }
        .toList()

@Composable
private fun HistoryMarkdownTable(rows: List<List<HistoryMarkdownCell>>) {
    val columns = rows.firstOrNull()?.size ?: return
    if (columns == 0) return
    val colors = MaterialTheme.colorScheme
    BoxWithConstraints {
        val cellWidth = (maxWidth / columns).coerceIn(112.dp, 240.dp)
        Surface(
            shape = RoundedCornerShape(12.dp),
            color = colors.background,
            contentColor = colors.onSurface,
            border = BorderStroke(1.dp, colors.outline),
        ) {
            Column(Modifier.horizontalScroll(rememberScrollState()).width(cellWidth * columns)) {
                for ((index, row) in rows.withIndex()) {
                    if (index != 0) HorizontalDivider(color = colors.outline)
                    Row(if (index == 0) Modifier.background(colors.surfaceVariant) else Modifier) {
                        for (cell in row) {
                            Text(
                                cell.text,
                                Modifier.width(cellWidth)
                                    .padding(horizontal = 12.dp, vertical = 8.dp),
                                style = MaterialTheme.typography.bodyMedium,
                                textAlign = cell.alignment,
                                fontWeight = if (index == 0) FontWeight.SemiBold else null,
                            )
                        }
                    }
                }
            }
        }
    }
}

internal fun conversationMarkdownForCopy(source: String): String =
    renderHistoryMarkdownNode(historyMarkdownParser.parse(source)).text.trimEnd()

internal fun renderHistoryMarkdown(source: String, compactLists: Boolean = false): AnnotatedString {
    val text =
        renderHistoryMarkdownNode(artifactMarkdownParser.parse(source), styleHeadings = true) {
            paragraph ->
            val item = paragraph.parent as? ListItem
            val list = item?.parent as? ListBlock
            val beforeNewBlock = paragraph.next == null && item?.next == null && list?.next != null
            if (compactLists && list?.isTight == true && !beforeNewBlock) "\n" else "\n\n"
        }
    return if (compactLists) text.subSequence(0, text.text.trimEnd('\n').length) else text
}

private fun renderHistoryMarkdownNode(
    node: Node,
    styleHeadings: Boolean = false,
    artifactCards: Boolean = false,
    paragraphBreak: (Paragraph) -> String = { if (it.parent is ListItem) "\n" else "\n\n" },
): AnnotatedString = buildAnnotatedString {
    val builder = this
    node.accept(
        object : AbstractVisitor() {
            private val listNumbers = mutableMapOf<OrderedList, Int>()

            override fun visit(node: org.commonmark.node.CustomBlock) {
                if (node is TableBlock) {
                    for (row in historyMarkdownRows(node)) {
                        append(row.joinToString("\t") { it.text.text })
                        append("\n")
                    }
                    append("\n")
                } else visitChildren(node)
            }

            override fun visit(node: MarkdownText) {
                append(node.literal)
            }

            override fun visit(node: Paragraph) {
                visitChildren(node)
                append(paragraphBreak(node))
            }

            override fun visit(node: SoftLineBreak) {
                append(" ")
            }

            override fun visit(node: HardLineBreak) {
                append("\n")
            }

            override fun visit(node: StrongEmphasis) {
                pushStyle(SpanStyle(fontWeight = FontWeight.Bold))
                visitChildren(node)
                pop()
            }

            override fun visit(node: Emphasis) {
                pushStyle(SpanStyle(fontStyle = FontStyle.Italic))
                visitChildren(node)
                pop()
            }

            override fun visit(node: Code) {
                pushStyle(SpanStyle(fontFamily = FontFamily.Monospace))
                append(node.literal)
                pop()
            }

            override fun visit(node: FencedCodeBlock) {
                code(node.literal)
            }

            override fun visit(node: IndentedCodeBlock) {
                code(node.literal)
            }

            private fun code(text: String) {
                builder.pushStyle(SpanStyle(fontFamily = FontFamily.Monospace))
                builder.append(text)
                builder.pop()
                builder.append("\n")
            }

            override fun visit(node: Heading) {
                if (styleHeadings)
                    pushStyle(
                        SpanStyle(fontWeight = FontWeight.Bold, fontSize = (26 - node.level).sp)
                    )
                visitChildren(node)
                if (styleHeadings) pop()
                append("\n\n")
            }

            override fun visit(node: Link) {
                val artifact = if (artifactCards) messageArtifactLink(node.destination) else null
                if (artifact != null) {
                    val start = length
                    visitChildren(node)
                    if (length == start) append(node.destination)
                    addStringAnnotation("artifact", artifact, start, length)
                    return
                }
                visitChildren(node)
                append(" (")
                append(node.destination)
                append(")")
            }

            override fun visit(node: Image) {
                visitChildren(node)
                append(" [")
                append(node.destination)
                append("]")
            }

            override fun visit(node: HtmlBlock) {
                append(node.literal)
                append("\n")
            }

            override fun visit(node: HtmlInline) {
                append(node.literal)
            }

            override fun visit(node: BlockQuote) {
                append("│ ")
                visitChildren(node)
            }

            override fun visit(node: ThematicBreak) {
                append("────────\n")
            }

            override fun visit(node: ListItem) {
                val parent = node.parent
                if (parent is OrderedList) {
                    val number = listNumbers[parent] ?: checkNotNull(parent.markerStartNumber)
                    listNumbers[parent] = number + 1
                    append("$number. ")
                } else append("• ")
                visitChildren(node)
            }
        }
    )
}
