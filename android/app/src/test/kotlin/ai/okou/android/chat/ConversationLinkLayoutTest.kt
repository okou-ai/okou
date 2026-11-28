package ai.okou.android.chat

import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.TestOkouApplication
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-mdpi", application = TestOkouApplication::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConversationLinkLayoutTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun wrappedConversationLinkPaintsOnlyItsFragments() {
        val chipColor = Color.Magenta
        val text = buildAnnotatedString {
            append("0123456789 ")
            pushStringAnnotation(ConversationLinkAnnotation, "/chats/$CHAT_IN_PROJECT")
            append("设计稿对话")
            pop()
            append(" · END")
        }
        compose.setContent {
            MaterialTheme(colorScheme = lightColorScheme(secondaryContainer = chipColor)) {
                ConversationLinkText(
                    text,
                    TextStyle(
                        color = Color.Black,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 16.sp,
                        lineHeight = 28.sp,
                    ),
                    "test-link",
                    ConversationLinkActions(open = { _, _ -> }, restoreKey = null, restored = {}),
                    Modifier.width(154.dp)
                        .background(Color.White)
                        .testTag("conversation-link-text"),
                )
            }
        }

        val node = compose.onNodeWithTag("conversation-link-text")
        val layouts = mutableListOf<TextLayoutResult>()
        node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        val layout = layouts.single()
        val rendered = layout.layoutInput.text
        val link = rendered.getLinkAnnotations(0, rendered.length).single()
        val icon = checkNotNull(layout.placeholderRects.first())
        assertEquals(0, layout.getLineForOffset(link.start + 1))
        assertEquals(1, layout.getLineForOffset(link.end - 1))

        val pixels = node.captureToImage().toPixelMap()
        fun containsChip(xs: IntRange, ys: IntRange) = ys.any { y ->
            xs.any { x -> pixels[x, y] == chipColor }
        }

        val firstLine = layout.getLineTop(0).toInt() until layout.getLineBottom(0).toInt()
        val secondLine = layout.getLineTop(1).toInt() until layout.getLineBottom(1).toInt()
        assertFalse(
            "Chip paint under preceding text",
            containsChip(0 until icon.left.toInt() - 1, firstLine),
        )
        assertTrue(
            "Chip paint behind the inline icon",
            containsChip(icon.left.toInt() until icon.right.toInt(), firstLine),
        )
        assertTrue("Chip paint on the continuation", containsChip(0 until pixels.width, secondLine))
        val suffix = layout.getBoundingBox(link.end + 1)
        assertFalse(
            "Chip paint under following text",
            containsChip(suffix.left.toInt() + 1 until pixels.width, secondLine),
        )
    }
}
