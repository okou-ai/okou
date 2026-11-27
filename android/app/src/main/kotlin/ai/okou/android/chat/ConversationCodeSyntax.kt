package ai.okou.android.chat

import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString

private enum class CodeGrammar(val keywords: Set<String>, val comment: String?) {
    Json(setOf("true", "false", "null"), null),
    Kotlin(
        ("as break class continue do else false for fun if in interface is null object package " +
                "return super this throw true try typealias val var when while by catch finally " +
                "import override private public internal protected suspend data sealed companion")
            .split(' ')
            .toSet(),
        "//",
    ),
    JavaScript(
        ("async await break case catch class const continue default delete do else export extends " +
                "false finally for from function if import in instanceof let new null of return " +
                "super switch this throw true try typeof undefined var void while yield interface " +
                "type enum implements readonly as satisfies")
            .split(' ')
            .toSet(),
        "//",
    ),
    Python(
        ("and as assert async await break class continue def del elif else except False finally " +
                "for from global if import in is lambda None nonlocal not or pass raise return " +
                "True try while with yield")
            .split(' ')
            .toSet(),
        "#",
    ),
}

internal fun codeLanguageName(info: String): String =
    when (info.lowercase()) {
        "js",
        "javascript" -> "JavaScript"
        "ts",
        "typescript" -> "TypeScript"
        "kt",
        "kts",
        "kotlin" -> "Kotlin"
        "py",
        "python" -> "Python"
        "json" -> "JSON"
        "html" -> "HTML"
        "css" -> "CSS"
        "sql" -> "SQL"
        "sh",
        "shell" -> "Shell"
        "bash" -> "Bash"
        "java" -> "Java"
        "rs",
        "rust" -> "Rust"
        "go",
        "golang" -> "Go"
        "md",
        "markdown" -> "Markdown"
        "yml",
        "yaml" -> "YAML"
        "mermaid" -> "Mermaid"
        else -> info
    }

internal fun codeHighlight(
    text: String,
    language: String?,
    colors: ColorScheme,
    background: Color,
): AnnotatedString {
    val grammar =
        when (language?.lowercase()) {
            "json" -> CodeGrammar.Json
            "kt",
            "kts",
            "kotlin" -> CodeGrammar.Kotlin
            "js",
            "javascript",
            "ts",
            "typescript" -> CodeGrammar.JavaScript
            "py",
            "python" -> CodeGrammar.Python
            else -> return AnnotatedString(text)
        }
    val keyword = SpanStyle(color = codeInk(colors.primary, background, colors.onSurface))
    val string = SpanStyle(color = codeInk(colors.tertiary, background, colors.onSurface))
    val number = SpanStyle(color = codeInk(colors.secondary, background, colors.onSurface))
    val comment = SpanStyle(color = codeInk(colors.onSurfaceVariant, background, colors.onSurface))
    return buildAnnotatedString {
        append(text)
        var index = 0
        while (index < text.length) {
            val start = index
            val char = text[index]
            when {
                grammar.comment?.let { text.startsWith(it, index) } == true -> {
                    index = text.indexOf('\n', index).takeIf { it >= 0 } ?: text.length
                    addStyle(comment, start, index)
                }
                grammar.comment == "//" && text.startsWith("/*", index) -> {
                    val end = text.indexOf("*/", index + 2)
                    index = if (end >= 0) end + 2 else text.length
                    addStyle(comment, start, index)
                }
                char == '"' ||
                    char == '\'' ||
                    char.code == 96 && grammar == CodeGrammar.JavaScript -> {
                    val triple =
                        (grammar == CodeGrammar.Python || grammar == CodeGrammar.Kotlin) &&
                            text.getOrNull(index + 1) == char &&
                            text.getOrNull(index + 2) == char
                    index = text.quotedCodeEnd(index, char, triple)
                    addStyle(string, start, index)
                }
                char.isDigit() -> {
                    index++
                    while (
                        index < text.length &&
                            (text[index].isLetterOrDigit() ||
                                text[index] == '_' ||
                                text[index] == '.')
                    ) index++
                    addStyle(number, start, index)
                }
                char.isLetter() || char == '_' || char == '$' -> {
                    index++
                    while (
                        index < text.length &&
                            (text[index].isLetterOrDigit() ||
                                text[index] == '_' ||
                                text[index] == '$')
                    ) index++
                    if (text.substring(start, index) in grammar.keywords)
                        addStyle(keyword, start, index)
                }
                else -> index++
            }
        }
    }
}

private fun String.quotedCodeEnd(start: Int, quote: Char, triple: Boolean): Int {
    val delimiter = if (triple) quote.toString().repeat(3) else quote.toString()
    var index = start + delimiter.length
    while (index < length) {
        if (startsWith(delimiter, index)) return index + delimiter.length
        if (!triple && quote.code != 96 && this[index] == '\n') return index
        index += if (this[index] == '\\' && index + 1 < length) 2 else 1
    }
    return length
}

private fun codeInk(ink: Color, background: Color, foreground: Color): Color {
    val a = ink.luminance()
    val b = background.luminance()
    val contrast = (maxOf(a, b) + 0.05f) / (minOf(a, b) + 0.05f)
    return if (contrast >= 4.5f) ink else foreground
}
