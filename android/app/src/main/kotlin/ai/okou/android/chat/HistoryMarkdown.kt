package ai.okou.android.chat

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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
import org.commonmark.node.ListItem
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text as MarkdownText
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.Parser

/** UI-owned parsing stays off Main; no HTML execution, image downloads or automatic link opens. */
@Composable
internal fun HistoryMarkdown(source: String) {
    val rendered by
        produceState<AnnotatedString?>(null, source) {
            value = withContext(Dispatchers.Default) { renderHistoryMarkdown(source) }
        }
    Text(rendered ?: AnnotatedString(source))
}

internal fun renderHistoryMarkdown(source: String): AnnotatedString = buildAnnotatedString {
    val builder = this
    Parser.builder()
        .build()
        .parse(source)
        .accept(
            object : AbstractVisitor() {
                private val listNumbers = mutableMapOf<OrderedList, Int>()

                override fun visit(node: MarkdownText) {
                    append(node.literal)
                }

                override fun visit(node: Paragraph) {
                    visitChildren(node)
                    append("\n\n")
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
                    pushStyle(
                        SpanStyle(fontWeight = FontWeight.Bold, fontSize = (26 - node.level).sp)
                    )
                    visitChildren(node)
                    pop()
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
