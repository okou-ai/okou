package ai.okou.android

import ai.okou.android.api.generated.UserPreferencesColorTheme
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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
@Config(sdk = [35], qualifiers = "en-rUS-w1000dp-h800dp", application = ChatListApplication::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
internal class ChatListRowFeedbackTest : ChatListRootTestFixture() {
    @Test
    fun rowHoverUsesTheSurfaceForegroundWithoutMovingKeyboardFocus() {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()

        val chat = compose.onNodeWithTag("chat_$CHAT_PERSONAL")
        val project = compose.onNodeWithText("Research")
        val colors = resolvePalette(UserPreferencesColorTheme.DEFAULT, dark = false)
        val ordinaryHover = colors.onBackground.copy(alpha = .08f).compositeOver(colors.background)
        val selectedHover =
            colors.onSecondaryContainer.copy(alpha = .08f).compositeOver(colors.secondaryContainer)

        fun assertTopColor(row: SemanticsNodeInteraction, expected: Color) {
            val pixels = row.captureToImage().toPixelMap()
            val actual = pixels[pixels.width / 2, 0]
            val sameColor =
                abs(expected.red - actual.red) <= 1.01f / 255 &&
                    abs(expected.green - actual.green) <= 1.01f / 255 &&
                    abs(expected.blue - actual.blue) <= 1.01f / 255
            assertTrue("Row pixel expected $expected but was $actual", sameColor)
        }

        project.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        project.performMouseInput { moveTo(center) }
        assertTopColor(project, ordinaryHover)
        chat.performMouseInput { moveTo(center) }
        project.assertIsFocused()
        assertTopColor(project, colors.background)
        assertTopColor(chat, ordinaryHover)
        chat.performClick().assertIsSelected()
        chat.performMouseInput { moveTo(center + Offset(5f, 0f)) }
        assertTopColor(chat, selectedHover)
    }
}
