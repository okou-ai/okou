package ai.okou.android.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
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

/** UI-owned parsing stays off Main; no HTML execution, image downloads or automatic link opens. */
@Composable
internal fun HistoryMarkdown(source: String, style: TextStyle) =
    key(source) {
        val rendered by
            produceState<List<HistoryMarkdownBlock>?>(null) {
                value = withContext(Dispatchers.Default) { historyMarkdownBlocks(source) }
            }
        val blocks = rendered
        if (blocks == null) {
            Text(source, style = style)
        } else {
            HistoryMarkdownBlocks(blocks, style)
        }
    }

@Composable
private fun HistoryMarkdownBlocks(
    blocks: List<HistoryMarkdownBlock>,
    style: TextStyle,
    modifier: Modifier = Modifier,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (block in blocks) when (block) {
            is HistoryMarkdownBlock.Table -> HistoryMarkdownTable(block.rows)
            is HistoryMarkdownBlock.ListItems ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (item in block.items) {
                        Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                            Text(item.marker, Modifier.widthIn(min = 16.dp), style = style)
                            HistoryMarkdownBlocks(item.blocks, style, Modifier.weight(1f))
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
                Text(block.text, style = blockStyle)
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

private fun historyMarkdownBlocks(source: String): List<HistoryMarkdownBlock> =
    historyMarkdownParser.parse(source).children().map(Node::historyMarkdownBlock).toList()

private fun Node.historyMarkdownBlock(): HistoryMarkdownBlock =
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
                            item.children().map(Node::historyMarkdownBlock).toList(),
                        )
                    }
                    .toList()
            )
        }
        else -> {
            val rendered = renderHistoryMarkdownNode(this)
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

internal fun renderHistoryMarkdown(source: String): AnnotatedString =
    renderHistoryMarkdownNode(historyMarkdownParser.parse(source))

private fun renderHistoryMarkdownNode(node: Node): AnnotatedString = buildAnnotatedString {
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
                append(if (node.parent is ListItem) "\n" else "\n\n")
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
                visitChildren(node)
                append("\n\n")
            }

            override fun visit(node: Link) {
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
