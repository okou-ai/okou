package ai.okou.android

import ai.okou.android.api.generated.UserPreferencesColorTheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performMouseInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.test.platform.app.InstrumentationRegistry
import kotlin.math.abs
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w1000dp-h800dp-mdpi",
    application = ChatListApplication::class,
)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
internal class ChatListRowFeedbackTest : ChatListRootTestFixture() {
    @Test
    fun rowHoverAndKeyboardFocusKeepTheirOwnFeedback() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        compose.activityRule.scenario.recreate()
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()

        val chat = compose.onNodeWithTag("chat_$CHAT_PERSONAL")
        val project = compose.onNodeWithText("Research")
        val colors = resolvePalette(UserPreferencesColorTheme.DEFAULT, dark = false)
        val ordinaryHover = colors.onSurface.copy(alpha = .08f).compositeOver(colors.surface)
        val selectedHover =
            colors.onSecondaryContainer.copy(alpha = .08f).compositeOver(colors.secondaryContainer)

        fun assertColor(actual: Color, expected: Color) {
            val sameColor =
                abs(expected.red - actual.red) <= 1.01f / 255 &&
                    abs(expected.green - actual.green) <= 1.01f / 255 &&
                    abs(expected.blue - actual.blue) <= 1.01f / 255
            assertTrue("Row pixel expected $expected but was $actual", sameColor)
        }

        fun assertTopColor(row: SemanticsNodeInteraction, expected: Color) {
            val pixels = row.captureToImage().toPixelMap()
            assertColor(pixels[pixels.width / 2, 0], expected)
        }

        fun assertFocusOutline(row: SemanticsNodeInteraction, surface: Color, outline: Color) {
            val pixels = row.captureToImage().toPixelMap()
            val x = pixels.width / 2
            assertColor(pixels[x, 0], surface)
            assertColor(pixels[x, 2], surface)
            assertColor(pixels[x, 3], outline)
            assertColor(pixels[x, 4], outline)
            assertColor(pixels[x, 5], surface)
        }

        project.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        assertFocusOutline(project, colors.surface, colors.onSurface)
        project.performMouseInput { moveTo(center) }
        assertFocusOutline(project, ordinaryHover, colors.onSurface)
        chat.performMouseInput { moveTo(center) }
        project.assertIsFocused()
        assertFocusOutline(project, colors.surface, colors.onSurface)
        assertTopColor(chat, ordinaryHover)
        chat.performMouseInput { exit() }
        // Keep the native press ripple out of the hover and focus captures.
        chat
            .performSemanticsAction(SemanticsActions.OnClick)
            .assertIsSelected()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
        chat.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        assertFocusOutline(chat, colors.secondaryContainer, colors.onSecondaryContainer)
        chat.performMouseInput { enter(center) }
        assertFocusOutline(chat, selectedHover, colors.onSecondaryContainer)
    }
}
