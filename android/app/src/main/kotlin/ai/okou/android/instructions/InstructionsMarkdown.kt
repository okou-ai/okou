package ai.okou.android.instructions

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.commonmark.node.AbstractVisitor
import org.commonmark.node.BlockQuote
import org.commonmark.node.Code
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.Heading
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.Node
import org.commonmark.node.StrongEmphasis
import org.commonmark.parser.IncludeSourceSpans
import org.commonmark.parser.Parser

@Composable
internal fun rememberInstructionsMarkdown(source: String): VisualTransformation {
    val formatted by
        produceState<AnnotatedString?>(null, source) {
            value = withContext(Dispatchers.Default) { styleInstructionsMarkdown(source) }
        }
    return remember(formatted) {
        VisualTransformation { input ->
            // Keep the source offsets for native selection, deletion, and IME composition.
            TransformedText(
                formatted?.takeIf { it.text == input.text } ?: input,
                OffsetMapping.Identity,
            )
        }
    }
}

private val instructionsParser =
    Parser.builder().includeSourceSpans(IncludeSourceSpans.BLOCKS_AND_INLINES).build()

internal fun styleInstructionsMarkdown(source: String): AnnotatedString = buildAnnotatedString {
    append(source)
    val code = SpanStyle(fontFamily = FontFamily.Monospace)
    val emphasis = SpanStyle(fontStyle = FontStyle.Italic)
    val bold = SpanStyle(fontWeight = FontWeight.Bold)
    instructionsParser
        .parse(source)
        .accept(
            object : AbstractVisitor() {
                override fun visit(node: Heading) =
                    style(node, bold.copy(fontSize = (26 - node.level).sp))

                override fun visit(node: StrongEmphasis) = style(node, bold)

                override fun visit(node: Emphasis) = style(node, emphasis)

                override fun visit(node: BlockQuote) = style(node, emphasis)

                override fun visit(node: Code) = style(node, code)

                override fun visit(node: FencedCodeBlock) = style(node, code)

                override fun visit(node: IndentedCodeBlock) = style(node, code)

                override fun visit(node: Link) =
                    style(node, SpanStyle(textDecoration = TextDecoration.Underline))

                private fun style(node: Node, style: SpanStyle) {
                    node.sourceSpans.forEach { span ->
                        addStyle(style, span.inputIndex, span.inputIndex + span.length)
                    }
                    visitChildren(node)
                }
            }
        )
}
