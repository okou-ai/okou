package ai.okou.android.chat

import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.internal.util.Escaping
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
    // Each removed backslash shifts the subsequent inline positions by one.
    var low = 0
    var high = size
    while (low < high) {
        val middle = (low + high) ushr 1
        if (this[middle] - middle < inlineIndex) low = middle + 1 else high = middle
    }
    return inlineIndex + low
}

private fun List<Int>.countBefore(index: Int): Int {
    val position = binarySearch(index)
    return if (position < 0) -position - 1 else position
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
            is Text -> appendText(node, escapes)
            is Code -> appendCode(node, escapes)
            is FencedCodeBlock ->
                appendLines(node.literal, node.sourceSpans, escapes, skipLines = 1)
            is IndentedCodeBlock -> appendLines(node.literal, node.sourceSpans, escapes)
            is HtmlInline -> appendLines(node.literal, node.sourceSpans, escapes)
            is HtmlBlock -> appendLines(node.literal, node.sourceSpans, escapes)
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

    private fun appendText(node: Text, escapes: List<Int>) =
        appendLiteral(node.literal, node.sourceSpans, escapes) { start, end, offset ->
            val literal = node.literal
            if (
                escapes.isEmpty() &&
                    end - start == literal.length &&
                    source.startsWith(literal, start)
            ) {
                appendCopy(start, end, offset, escapes)
            } else {
                for ((copied, visibleStart) in
                    copiedText(inlineSource(start, end, escapes), literal)) {
                    appendCopy(
                        start + copied.first,
                        start + copied.last + 1,
                        offset + visibleStart,
                        escapes,
                    )
                    if (firstMatchOnly && sourceRange != null) break
                }
            }
        }

    private fun appendCode(node: Code, escapes: List<Int>) =
        appendLiteral(node.literal, node.sourceSpans, escapes) { _, _, offset ->
            val spans = node.sourceSpans
            val lines = spans.map {
                inlineSource(it.inputIndex, it.inputIndex + it.length, escapes)
            }
            // CommonMark folds inline code's line breaks to spaces and may strip one padding space
            // on each side.
            val raw = lines.joinToString(" ")
            val fence = raw.indexOfFirst { it != '`' }
            val start = fence + if (raw.length - 2 * fence == node.literal.length + 2) 1 else 0
            val end = raw.length - start
            if (
                start < 0 ||
                    end - start != node.literal.length ||
                    !raw.startsWith(node.literal, start)
            )
                return@appendLiteral

            var lineStart = 0
            for ((index, line) in lines.withIndex()) {
                val from = maxOf(start - lineStart, 0)
                val to = minOf(end - lineStart, line.length)
                val spanStart = spans[index].inputIndex
                appendCopy(
                    spanStart + from,
                    spanStart + to,
                    offset + lineStart + from - start,
                    escapes,
                )
                if (firstMatchOnly && sourceRange != null) break
                lineStart += line.length + 1
            }
        }

    private fun appendLines(
        literal: String,
        spans: List<SourceSpan>,
        escapes: List<Int>,
        skipLines: Int = 0,
    ) =
        appendLiteral(literal, spans, escapes) { _, _, offset ->
            val firstLine = spans.first().lineIndex + skipLines
            var spanIndex = 0
            var lineOffset = offset
            for ((index, line) in literal.lineSequence().withIndex()) {
                val lineNumber = firstLine + index
                while (
                    spanIndex < spans.size && spans[spanIndex].lineIndex < lineNumber
                ) spanIndex++
                val span = spans.getOrNull(spanIndex) ?: break
                if (span.lineIndex == lineNumber) {
                    val end = span.inputIndex + span.length
                    // Code block literals may omit indentation at the start of a source line.
                    val length =
                        line.commonSuffixWith(inlineSource(span.inputIndex, end, escapes)).length
                    appendCopy(end - length, end, lineOffset + line.length - length, escapes)
                    if (firstMatchOnly && sourceRange != null) break
                }
                lineOffset += line.length + 1
            }
        }

    private inline fun appendLiteral(
        literal: String,
        spans: List<SourceSpan>,
        escapes: List<Int>,
        project: (start: Int, end: Int, visibleStart: Int) -> Unit,
    ) {
        val offset = text.length
        if (!firstMatchOnly) text.append(literal)
        val start = spans.firstOrNull()?.inputIndex ?: return
        val last = spans.last()
        val end = last.inputIndex + last.length
        val first = firstPossibleMatch(escapes.originalMarkdownIndex(start))
        if (ranges.getOrNull(first)?.first?.let { it < escapes.originalMarkdownIndex(end) } == true)
            project(start, end, offset)
    }

    private fun firstPossibleMatch(sourceStart: Int): Int {
        // The service returns ordered, disjoint ranges. Find the first possible overlap.
        val index = ranges.binarySearch { it.last.compareTo(sourceStart) }
        return if (index < 0) -index - 1 else index
    }

    private fun appendCopy(start: Int, end: Int, offset: Int, escapes: List<Int>) {
        if (start >= end) return
        val sourceStart = escapes.originalMarkdownIndex(start)
        val sourceEnd = escapes.originalMarkdownIndex(end)
        for (i in firstPossibleMatch(sourceStart) until ranges.size) {
            val range = ranges[i]
            if (range.first >= sourceEnd) break
            val rawStart = maxOf(range.first, sourceStart)
            val rawEnd = minOf(range.last + 1, sourceEnd)
            val from = rawStart - escapes.countBefore(rawStart) - start
            val to = rawEnd - escapes.countBefore(rawEnd) - start
            if (from < to) {
                if (sourceRange == null) sourceRange = range
                if (firstMatchOnly) return
                matches += (offset + from) until (offset + to)
            }
        }
    }

    private fun inlineSource(start: Int, end: Int, escapes: List<Int>): String {
        val sourceStart = escapes.originalMarkdownIndex(start)
        val sourceEnd = escapes.originalMarkdownIndex(end)
        val first = escapes.countBefore(sourceStart)
        val last = escapes.countBefore(sourceEnd)
        val raw =
            if (first == last) source.substring(sourceStart, sourceEnd)
            else
                buildString(end - start) {
                    var from = sourceStart
                    for (index in first until last) {
                        val escape = escapes[index]
                        append(source, from, escape)
                        from = escape + 1
                    }
                    append(source, from, sourceEnd)
                }
        return raw.replace('\u0000', '\uFFFD')
    }
}

private val inlineTextEscapes =
    Regex("""\\${Escaping.ESCAPABLE}|${Escaping.ENTITY}""", RegexOption.IGNORE_CASE)

private data class LiteralCopy(val source: IntRange, val visibleStart: Int)

// CommonMark merges adjacent Text spans after decoding. Keep only characters copied into the
// displayed text.
private fun copiedText(raw: String, literal: String): List<LiteralCopy> {
    if (raw == literal) return listOf(LiteralCopy(raw.indices, 0))
    val copies = mutableListOf<LiteralCopy>()
    var start = 0
    var visibleStart = 0
    for (escape in inlineTextEscapes.findAll(raw)) {
        val token = escape.value
        val decoded = Escaping.unescapeString(token)
        if (token == decoded) continue
        val end = escape.range.first
        val length = end - start
        val decodedStart = visibleStart + length
        if (
            !literal.regionMatches(visibleStart, raw, start, length) ||
                !literal.startsWith(decoded, decodedStart)
        )
            return emptyList()
        copies += LiteralCopy(start until end, visibleStart)
        if (token.startsWith('\\')) {
            start = end + 1
            visibleStart = decodedStart
        } else {
            start = escape.range.last + 1
            visibleStart = decodedStart + decoded.length
        }
    }
    val length = literal.length - visibleStart
    if (length < 0 || !literal.regionMatches(visibleStart, raw, start, length)) return emptyList()
    val end = start + length
    // Text spans can include trailing line whitespace that the parser leaves out of the literal.
    if ((end until raw.length).any { raw[it] != ' ' && raw[it] != '\t' }) return emptyList()
    copies += LiteralCopy(start until end, visibleStart)
    return copies
}
