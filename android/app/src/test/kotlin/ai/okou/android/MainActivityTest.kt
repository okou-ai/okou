package ai.okou.android

import ai.okou.android.api.generated.UserPreferencesColorTheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
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
    @Config(qualifiers = "en-rUS-notnight")
    fun pastelPaletteKeepsSettingsAndDialogActionsReadable() {
        compose.onNodeWithText("Settings").performClick()
        compose.onNodeWithText("Default").performScrollTo().performClick()
        compose.onNodeWithText("Cotton sky").performScrollTo().performClick()
        val colors =
            resolvePalette(compose.activity, false, UserPreferencesColorTheme.COTTON_SKY).scheme
        fun readable(value: String, surface: Color = colors.background, scroll: Boolean = true) {
            val layouts = mutableListOf<TextLayoutResult>()
            val node = compose.onNodeWithText(value)
            if (scroll) node.performScrollTo()
            node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            val foreground = layouts.single().layoutInput.style.color
            assertTrue("$value exposes its rendered text color", foreground != Color.Unspecified)
            val contrast =
                (maxOf(foreground.luminance(), surface.luminance()) + 0.05f) /
                    (minOf(foreground.luminance(), surface.luminance()) + 0.05f)
            assertTrue("$value text contrast $contrast must be at least 4.5", contrast >= 4.5f)
        }
        readable("Sign out")
        readable("Cotton sky")
        readable("English")
        readable("Refresh preferences")
        compose.onNodeWithText("English").performScrollTo().performClick()
        readable("Back", colors.surfaceContainerHigh, scroll = false)
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    fun activityRecreationAndSystemBackKeepTheRetainedNativeEditor() {
        compose.onNode(hasSetTextAction()).performTextInput("Retained editor")
        compose.onNode(hasSetTextAction()).performTextInputSelection(TextRange(4))
        compose.onNodeWithText("Settings").performClick()
        compose.activityRule.scenario.recreate()
        compose.onNodeWithText("Appearance").assertExists()
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNode(hasSetTextAction()).assertTextContains("Retained editor")
        compose
            .onNode(hasSetTextAction())
            .assert(
                SemanticsMatcher.expectValue(SemanticsProperties.TextSelectionRange, TextRange(4))
            )
    }
}
