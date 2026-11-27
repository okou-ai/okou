package ai.okou.android.chat

import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.node.Block
import org.commonmark.node.Code
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Node
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.SourceSpan
import org.commonmark.node.Text

internal data class SearchMessageExcerpt(
    val text: String,
    val ranges: List<IntRange>,
    val sourceRange: IntRange?,
)

internal fun Node.searchExcerpt(
    source: String,
    ranges: List<IntRange>,
    escapes: List<Int> = emptyList(),
): SearchMessageExcerpt =
    MarkdownExcerpt(source, ranges).apply { append(this@searchExcerpt, escapes) }.build()

internal fun Node.firstReadableSearchRange(source: String, ranges: List<IntRange>): IntRange? =
    MarkdownExcerpt(source, ranges, firstMatchOnly = true)
        .apply { append(this@firstReadableSearchRange) }
        .sourceRange

// GFM consumes a backslash before an escaped pipe before parsing the cell's inlines.
internal fun Node.tablePipeEscapes(source: String): List<Int> {
    val span = (this as? TableCell)?.sourceSpans?.singleOrNull() ?: return emptyList()
    return buildList {
        for (index in span.inputIndex until span.inputIndex + span.length - 1) {
            if (source[index] == '\\' && source[index + 1] == '|') add(index)
        }
    }
}

internal fun List<Int>.originalMarkdownIndex(inlineIndex: Int): Int {
    var index = inlineIndex
    for (escape in this) {
        if (escape >= index) break
        index++
    }
    return index
}

/** Collect the visible literals paired with the search index's UTF-16 offsets. */
private class MarkdownExcerpt(
    private val source: String,
    private val ranges: List<IntRange>,
    private val firstMatchOnly: Boolean = false,
) {
    private val text = StringBuilder()
    private val matches = mutableListOf<IntRange>()
    var sourceRange: IntRange? = null
        private set

    fun build() = SearchMessageExcerpt(text.toString().trimEnd(), matches, sourceRange)

    fun append(node: Node, escapes: List<Int> = emptyList()) {
        when (node) {
            is Text -> appendLiteral(node.literal, node.sourceSpans, escapes)
            is Code -> appendLiteral(node.literal, node.sourceSpans, escapes)
            is FencedCodeBlock -> appendLiteral(node.literal, node.sourceSpans.drop(1), escapes)
            is IndentedCodeBlock -> appendLiteral(node.literal, node.sourceSpans, escapes)
            is HtmlInline -> appendLiteral(node.literal, node.sourceSpans, escapes)
            is HtmlBlock -> appendLiteral(node.literal, node.sourceSpans, escapes)
            is SoftLineBreak,
            is HardLineBreak -> if (!firstMatchOnly) text.append(' ')
            else -> {
                val start = text.length
                val childEscapes =
                    if (node is TableCell && escapes.isEmpty() && ranges.isNotEmpty())
                        node.tablePipeEscapes(source)
                    else escapes
                for (child in generateSequence(node.firstChild) { it.next }) {
                    append(child, childEscapes)
                    if (firstMatchOnly && sourceRange != null) return
                }
                if (text.length > start && (node is Block || node is TableCell || node is Image))
                    text.append(' ')
            }
        }
    }

    private fun appendLiteral(literal: String, spans: List<SourceSpan>, escapes: List<Int>) {
        val offset = text.length
        if (!firstMatchOnly) text.append(literal)
        val sourceStart =
            spans.firstOrNull()?.let { escapes.originalMarkdownIndex(it.inputIndex) } ?: return
        val last = spans.last()
        val sourceEnd = escapes.originalMarkdownIndex(last.inputIndex + last.length)
        // The service returns ordered, disjoint ranges. Find the first possible overlap.
        val index = ranges.binarySearch { it.last.compareTo(sourceStart) }
        val first = if (index < 0) -index - 1 else index
        if (ranges.getOrNull(first)?.first?.let { it < sourceEnd } != true) return
        val raw = source.substring(sourceStart, sourceEnd)
        val literalStart = raw.indexOf(literal)
        val prefix = if (literalStart >= 0) 0 else raw.commonPrefixWith(literal).length
        val suffix = if (literalStart >= 0) 0 else raw.commonSuffixWith(literal).length
        for (i in first until ranges.size) {
            val range = ranges[i]
            if (range.first >= sourceEnd) break
            val start = maxOf(range.first - sourceStart, 0)
            val end = minOf(range.last + 1, sourceEnd) - sourceStart
            if (start >= end) continue
            val visibleStart =
                when {
                    literalStart >= 0 -> start - literalStart
                    end <= prefix -> start
                    start >= raw.length - suffix -> start + literal.length - raw.length
                    else -> {
                        // CommonMark can decode escapes and entities inside a text node.
                        val term = raw.substring(start, end)
                        val found = literal.indexOf(term)
                        if (
                            found < 0 ||
                                literal.indexOf(term, found + 1) >= 0 ||
                                raw.indexOf(term) != start ||
                                raw.indexOf(term, start + 1) >= 0
                        )
                            continue
                        found
                    }
                }
            val from = maxOf(0, visibleStart)
            val to = minOf(literal.length, visibleStart + end - start)
            if (from < to) {
                if (sourceRange == null) sourceRange = range
                if (firstMatchOnly) return
                matches += (offset + from) until (offset + to)
            }
        }
    }
}
