package ai.okou.android

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.InputModeManager
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w360dp-h480dp")
class SettingsChoiceListTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun opensAtTheSelectionAndOnlySavesWhenTheFocusedChoiceIsActivated() = keyboard {
        val selected = mutableIntStateOf(17)
        val submissions = mutableListOf<Int>()
        show(selected) { submissions.add(it) }
        open()
        compose.onNodeWithText("Choose entry").assertIsDisplayed()
        option(17).assertIsDisplayed().assertIsSelected().assertIsFocused()
        option(0).assertDoesNotExist()

        compose.runOnIdle { selected.intValue = 2 }
        option(17).assertIsDisplayed().assertIsNotSelected().assertIsFocused()
        option(17).performKeyInput { pressKey(Key.DirectionDown) }
        option(18).assertIsFocused().assertIsNotSelected()
        compose.onNodeWithText("Choose entry").assertIsDisplayed()
        compose.runOnIdle { assertEquals(emptyList<Int>(), submissions) }

        option(18).performKeyInput { pressKey(Key.Enter) }
        compose.onNodeWithText("Choose entry").assertDoesNotExist()
        compose.onNodeWithText("Settings entry").assertIsFocused()
        compose.runOnIdle { assertEquals(listOf(18), submissions) }
    }

    @Test
    fun focusesTheFirstAvailableChoiceWhenTheSavedValueIsMissing() = keyboard {
        val submissions = mutableListOf<Int>()
        show(mutableIntStateOf(-1)) { submissions.add(it) }
        open()
        option(0).assertIsDisplayed().assertIsNotSelected().assertIsFocused()
        compose.runOnIdle { assertEquals(emptyList<Int>(), submissions) }
    }

    private fun show(selected: androidx.compose.runtime.IntState, onSelect: (Int) -> Unit) {
        val keyboard =
            object : InputModeManager {
                override val inputMode = InputMode.Keyboard

                override fun requestInputMode(inputMode: InputMode) = inputMode == this.inputMode
            }
        compose.setContent {
            CompositionLocalProvider(LocalInputModeManager provides keyboard) {
                OkouTheme(dark = false) {
                    SettingsPickerRow("Settings entry", null, leading = {}) { dismiss ->
                        SettingsSheet("Choose entry", dismiss, scroll = SettingsSheetScroll.None) {
                            SettingsChoiceList((0..23).toList(), selected.intValue, { it }) {
                                option,
                                position ->
                                SettingsChoiceRow(
                                    "Option $option",
                                    option == selected.intValue,
                                    enabled = true,
                                    onClick = {
                                        dismiss()
                                        onSelect(option)
                                    },
                                    modifier = position,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    private fun open() {
        compose
            .onNodeWithText("Settings entry")
            .performSemanticsAction(SemanticsActions.RequestFocus)
            .performKeyInput { pressKey(Key.Enter) }
    }

    private fun option(index: Int) = compose.onNode(hasText("Option $index") and isSelectable())

    private fun keyboard(block: () -> Unit) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            block()
        } finally {
            instrumentation.resetInTouchMode()
        }
    }
}
