package ai.okou.android

import ai.okou.android.chat.CreateProjectSheet
import ai.okou.android.chat.ProjectCreationEditor
import ai.okou.android.settings.DefaultModelChoice
import ai.okou.android.settings.ModelPickerSheet
import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w480dp-h260dp")
class CompactPanelLayoutTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun shortProjectFormKeepsItsTitleAndCanSubmitAtLargeTextSize() = largeText {
        val editor = ProjectCreationEditor(restoreFocus = false)
        var submitted: String? = null
        compose.setContent {
            OkouTheme {
                CreateProjectSheet(editor, null, create = { submitted = it }, dismiss = {})
            }
        }

        val bar = compose.onNodeWithTag("compact-panel-top-app-bar")
        val before = bar.getUnclippedBoundsInRoot()
        compose.onNodeWithText("New project").assertIsDisplayed()
        compose.onNodeWithContentDescription("Project name").performTextReplacement("Field notes")
        compose.onNodeWithText("Create").performScrollTo().assertIsDisplayed().performClick()
        assertEquals(before, bar.getUnclippedBoundsInRoot())
        compose.runOnIdle { assertEquals("Field notes", submitted) }
    }

    @Test
    fun shortModelPickerKeepsItsSelectionAndOffersKeyboardBackAtLargeTextSize() = largeText {
        val selected = mutableStateOf<String?>("model-12")
        val open = mutableStateOf(true)
        val choices =
            (1..12).map {
                DefaultModelChoice("model-$it", "Model $it", true, emptyList(), null, null)
            }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.setContent {
                OkouTheme {
                    if (open.value) {
                        ModelPickerSheet(
                            title = "Model",
                            choices = choices,
                            selectedId = selected.value,
                            effort = null,
                            fast = false,
                            select = { selected.value = it },
                            selectEffort = {},
                            selectFast = {},
                            dismiss = { open.value = false },
                        )
                    }
                }
            }
            val back = compose.onNodeWithContentDescription("Back")
            back.assertWidthIsEqualTo(48.dp).assertHeightIsEqualTo(48.dp)
            compose.onNodeWithText("Model 12").assertIsSelected().assertIsDisplayed()
            compose.onNodeWithText("Model").assertIsDisplayed()
            back
                .performSemanticsAction(SemanticsActions.RequestFocus)
                .assertIsFocused()
                .performKeyInput { pressKey(Key.Enter) }
            compose.onNodeWithTag("model-picker").assertDoesNotExist()
        } finally {
            instrumentation.resetInTouchMode()
        }
    }

    private fun largeText(block: () -> Unit) {
        val originalScale = RuntimeEnvironment.getFontScale()
        try {
            RuntimeEnvironment.setFontScale(2f)
            compose.activityRule.scenario.recreate()
            assertEquals(2f, compose.activity.resources.configuration.fontScale, 0f)
            block()
        } finally {
            RuntimeEnvironment.setFontScale(originalScale)
        }
    }
}
