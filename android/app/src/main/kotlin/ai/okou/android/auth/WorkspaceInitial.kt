package ai.okou.android.auth

import java.text.BreakIterator

/** Workspaces created from the App keep their generated slug as a name until renamed. */
private val generatedWorkspaceName = Regex("^workspace-[0-9a-f]{8}$", RegexOption.IGNORE_CASE)

private val numberTypes =
    setOf(
        Character.DECIMAL_DIGIT_NUMBER.toInt(),
        Character.LETTER_NUMBER.toInt(),
        Character.OTHER_NUMBER.toInt(),
    )

private val wideScripts =
    setOf(
        Character.UnicodeScript.HAN,
        Character.UnicodeScript.HIRAGANA,
        Character.UnicodeScript.KATAKANA,
        Character.UnicodeScript.HANGUL,
    )

private fun graphemes(text: String): List<String> {
    val iterator = BreakIterator.getCharacterInstance()
    iterator.setText(text)
    val result = mutableListOf<String>()
    var start = iterator.first()
    var end = iterator.next()
    while (end != BreakIterator.DONE) {
        result += text.substring(start, end)
        start = end
        end = iterator.next()
    }
    return result
}

/**
 * The Web client's `workspaceInitial`: the first letter or number as one grapheme, capitalised
 * unless its capital spells more than one (ß). Generated names and names without a letter keep the
 * texture alone.
 */
internal fun workspaceInitial(name: String): String? {
    val trimmed = name.trim()
    if (generatedWorkspaceName.matches(trimmed)) return null
    val grapheme =
        graphemes(trimmed).firstOrNull { candidate ->
            candidate.codePoints().anyMatch {
                Character.isLetter(it) || Character.getType(it) in numberTypes
            }
        } ?: return null
    val upper = grapheme.uppercase()
    return if (graphemes(upper).size == 1) upper else grapheme
}

/** CJK glyphs fill their em box, so they take 0.88 of the Latin size, as on Web and iOS. */
internal fun workspaceInitialScale(initial: String): Float =
    if (initial.codePoints().anyMatch { Character.UnicodeScript.of(it) in wideScripts }) 0.44f
    else 0.5f

/**
 * Each colourway's `letter` in core/src/workspace-logo.ts, in the same order: the ground's own hue,
 * solved to 4.5:1 against the texture.
 */
internal val workspaceLetterColors =
    longArrayOf(
        0xFF6E485B,
        0xFF480000,
        0xFF395766,
        0xFFD9ECFF,
        0xFF675900,
        0xFF6E2F00,
        0xFF465900,
        0xFFEAFFFE,
    )

/** FNV-1a over UTF-16, matching the Web and iOS clients. */
internal fun workspaceColorway(id: String): Int {
    val hash = id.fold(2_166_136_261u) { hash, char -> (hash xor char.code.toUInt()) * 16_777_619u }
    return (hash % workspaceLetterColors.size.toUInt()).toInt()
}
