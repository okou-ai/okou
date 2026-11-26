package ai.okou.android

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.IntState
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.InputModeManager
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.WindowInfo
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
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
    private val restoration = StateRestorationTester(compose)
    private val windowWidth = mutableIntStateOf(360)

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

        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("Choose entry").assertIsDisplayed()
        option(18).assertIsDisplayed().assertIsFocused()
        option(2).assertDoesNotExist()
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

    @Test
    fun retainsKeyboardFocusAcrossAdaptiveModalChanges() = keyboard {
        val submissions = mutableListOf<Int>()
        show(mutableIntStateOf(17)) { submissions.add(it) }
        open()
        option(17).assertIsFocused().performKeyInput { pressKey(Key.DirectionDown) }
        option(18).assertIsFocused()

        compose.runOnIdle { windowWidth.intValue = 900 }

        option(18).assertIsDisplayed().assertIsFocused().assertIsNotSelected()
        option(18).performKeyInput { pressKey(Key.DirectionDown) }
        option(19).assertIsFocused()

        compose.runOnIdle { windowWidth.intValue = 360 }

        option(19).assertIsDisplayed().assertIsFocused().assertIsNotSelected()
        option(19).performKeyInput { pressKey(Key.Enter) }
        compose.onNodeWithText("Settings entry").assertIsFocused()
        compose.runOnIdle { assertEquals(listOf(19), submissions) }
    }

    private fun show(selected: IntState, onSelect: (Int) -> Unit) {
        val keyboard =
            object : InputModeManager {
                override val inputMode = InputMode.Keyboard

                override fun requestInputMode(inputMode: InputMode) = inputMode == this.inputMode
            }
        restoration.setContent {
            val window = LocalWindowInfo.current
            val density = LocalDensity.current
            CompositionLocalProvider(
                LocalInputModeManager provides keyboard,
                LocalWindowInfo provides
                    object : WindowInfo by window {
                        override val containerSize: IntSize
                            get() =
                                with(density) {
                                    IntSize(windowWidth.intValue.dp.roundToPx(), 480.dp.roundToPx())
                                }
                    },
            ) {
                OkouTheme(dark = false) {
                    SettingsPickerRow("Settings entry", null, leading = {}) { dismiss ->
                        SettingsChoiceSheet(
                            "Choose entry",
                            dismiss,
                            (0..23).toList(),
                            selected.intValue,
                            Int::toString,
                        ) { option, position ->
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
