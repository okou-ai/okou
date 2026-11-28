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
    fun wrappedConversationLinkShowsOnSurfaceInkOverTheReplyBackground() {
        val onSurface = Color.Blue
        val secondaryContainer = Color.Magenta
        val text = buildAnnotatedString {
            append("0123456789 ")
            pushStringAnnotation(ConversationLinkAnnotation, "/chats/$CHAT_IN_PROJECT")
            append("设计稿对话")
            pop()
            append(" · END")
        }
        compose.setContent {
            MaterialTheme(
                colorScheme =
                    lightColorScheme(
                        onSurface = onSurface,
                        secondaryContainer = secondaryContainer,
                    ),
            ) {
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
        val icon = checkNotNull(layout.placeholderRects.single())
        assertEquals(20f, icon.width, 0f)
        assertEquals(16f, icon.height, 0f)
        assertEquals(0, layout.getLineForOffset(link.start + 1))
        assertEquals(1, layout.getLineForOffset(link.end - 1))

        val pixels = node.captureToImage().toPixelMap()
        fun containsColor(color: Color, xs: IntRange, ys: IntRange) = ys.any { y ->
            xs.any { x -> pixels[x, y] == color }
        }

        val firstLine = layout.getLineTop(0).toInt() until layout.getLineBottom(0).toInt()
        val secondLine = layout.getLineTop(1).toInt() until layout.getLineBottom(1).toInt()
        assertTrue(
            "Inline icon uses OnSurface",
            containsColor(onSurface, icon.left.toInt() until icon.right.toInt(), firstLine),
        )
        assertEquals(
            "Spacing after the icon shows the reply background",
            Color.White,
            pixels[icon.right.toInt() - 2, icon.center.y.toInt()],
        )
        assertTrue(
            "First line of the label uses OnSurface",
            containsColor(onSurface, icon.right.toInt() until pixels.width, firstLine),
        )
        assertTrue(
            "Wrapped label uses OnSurface",
            containsColor(onSurface, 0 until pixels.width, secondLine),
        )
        assertFalse(
            "Resting link has no selected container fill",
            containsColor(secondaryContainer, 0 until pixels.width, 0 until pixels.height),
        )
    }
}
