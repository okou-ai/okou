package ai.okou.android

import ai.okou.android.api.generated.UserPreferencesColorTheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = TestOkouApplication::class)
class MainActivityTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    @Config(qualifiers = "en-rUS-w411dp-h731dp-notnight")
    fun pastelPaletteKeepsSettingsAndDialogActionsReadable() {
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Color theme").performScrollTo().performClick()
        compose.onNode(isSelectable() and hasText("Deep lagoon")).assertIsDisplayed()
        val choice = compose.onNode(isSelectable() and hasText("Cotton sky"))
        choice.performScrollTo().performSemanticsAction(SemanticsActions.OnClick)
        choice.assertDoesNotExist()
        val colors =
            resolvePalette(compose.activity, false, UserPreferencesColorTheme.COTTON_SKY).scheme
        fun readable(value: String) {
            val layouts = mutableListOf<TextLayoutResult>()
            val node = compose.onNodeWithText(value, useUnmergedTree = true)
            node.performScrollTo()
            node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            val foreground = layouts.single().layoutInput.style.color
            val surface = colors.surface
            assertTrue("$value exposes its rendered text color", foreground != Color.Unspecified)
            val contrast =
                (maxOf(foreground.luminance(), surface.luminance()) + 0.05f) /
                    (minOf(foreground.luminance(), surface.luminance()) + 0.05f)
            assertTrue("$value text contrast $contrast must be at least 4.5", contrast >= 4.5f)
        }
        readable("Sign out")
        readable("Cotton sky")
        readable("English")
        compose.onNodeWithText("Language").performScrollTo().performClick()
        readable("日本語")
    }
}
