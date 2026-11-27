package ai.okou.android.chat

import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationCodeSourceTest {
    @Test
    fun unclosedFencePreservesTerminatorsAndCountsBlankAndPartialLines() {
        val preview =
            "val first = 1\r\n\tval aligned = 2\r\n\r\n" +
                (4..12).joinToString("", transform = { "val line$it = $it\n" })
        val original = preview + "val last = 13"
        val source = checkNotNull(conversationMarkdownCode("```kt\r\n$original", "0"))

        assertEquals("kt", source.language)
        assertEquals(original, source.text)
        assertEquals(13, source.lineCount)
        assertEquals(preview, source.preview)
        assertTrue(
            codeDisplayText(source.preview).startsWith("val first = 1\n    val aligned = 2\n\n"),
        )
        assertEquals(12, codeDisplayText(source.preview).lines().size)
    }

    @Test
    fun nestedFencesUseParsedContainerIndentWithoutLosingSourceIndent() {
        val markdown = "- Output\n\n  > ~~~~example\r\n  >  literal\ttext\r\n  > \r\n  > ~~~~\n"
        val source = checkNotNull(conversationMarkdownCode(markdown, "0/0/1/0"))

        assertEquals("example", source.language)
        assertEquals(" literal\ttext\r\n\r\n", source.text)
        assertEquals(2, source.lineCount)
        assertEquals(" literal    text\n", codeDisplayText(source.preview))
        assertNull(conversationMarkdownCode("```math\nx^2\n```", "0"))
        assertNull(conversationMarkdownCode("```js\n```", "0"))
    }

    @Test
    fun syntaxUpdatesOnlyColorsAndFallsBackForLowContrastOrUnknownLanguages() {
        val colors = lightColorScheme(primary = Color.White, onSurface = Color.Black)
        val text = "val attempt = 3 // result"
        val styled = codeHighlight(text, "kt", colors, Color.White)

        assertEquals(text, styled.text)
        val keyword = styled.spanStyles.single { it.start == 0 && it.end == 3 }
        assertEquals(colors.onSurface, keyword.item.color)
        assertEquals(3, styled.spanStyles.size)
        assertTrue(codeHighlight(text, "unknown", colors, Color.White).spanStyles.isEmpty())
    }
}
