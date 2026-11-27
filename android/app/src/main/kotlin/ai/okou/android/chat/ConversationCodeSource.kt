package ai.okou.android.chat

import org.commonmark.node.FencedCodeBlock

internal const val ConversationCodePreviewLines = 12

internal data class ConversationCodeTarget(
    val messageId: String,
    val bodyIndex: Int,
    val path: String,
)

internal data class ConversationCodeSource(val language: String?, val text: String) {
    val lineCount: Int
    val preview: String

    init {
        var ends = 0
        var previewEnd = text.length
        for ((index, char) in text.withIndex()) {
            if (char == '\n' || char == '\r' && text.getOrNull(index + 1) != '\n') {
                ends++
                if (ends == ConversationCodePreviewLines) previewEnd = index + 1
            }
        }
        lineCount =
            ends + if (text.isNotEmpty() && text.last() != '\r' && text.last() != '\n') 1 else 0
        preview = text.substring(0, previewEnd)
    }
}

private val codeLineEnding = Regex("\r\n|\r|\n")

internal fun String.markdownLineEndings(): List<String> =
    codeLineEnding.findAll(this).map { it.value }.toList() + ""

internal fun FencedCodeBlock.conversationCodeSource(
    lineEndings: List<String>,
): ConversationCodeSource? {
    val language = info.orEmpty().takeWhile { !it.isWhitespace() }.takeIf(String::isNotEmpty)
    if (literal.isEmpty() || language.equals("math", ignoreCase = true)) return null
    // CommonMark removes container indentation and normalizes the line endings, even adding
    // one at EOF. Recover the actual separators without re-parsing the Markdown containers.
    val firstLine = sourceSpans.first().lineIndex + 1
    val source =
        buildString(literal.length) {
            var start = 0
            var line = firstLine
            for ((index, char) in literal.withIndex()) {
                if (char == '\n') {
                    append(literal, start, index)
                    append(lineEndings[line++])
                    start = index + 1
                }
            }
            append(literal, start, literal.length)
        }
    return ConversationCodeSource(language, source)
}

internal fun codeDisplayText(source: String): String {
    val normalized = source.replace("\r\n", "\n").replace('\r', '\n').removeSuffix("\n")
    if ('\t' !in normalized) return normalized
    return buildString(normalized.length) {
        var column = 0
        for (char in normalized) {
            when (char) {
                '\n' -> {
                    append(char)
                    column = 0
                }
                '\t' -> {
                    val spaces = 4 - column % 4
                    repeat(spaces) { append(' ') }
                    column += spaces
                }
                else -> {
                    append(char)
                    if (!char.isLowSurrogate()) column++
                }
            }
        }
    }
}
