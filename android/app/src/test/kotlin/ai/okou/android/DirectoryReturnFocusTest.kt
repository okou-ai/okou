package ai.okou.android

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.InputModeManager
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w840dp-h820dp", application = TestOkouApplication::class)
class DirectoryReturnFocusTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun waitsForTheRowAndRestoresItOnlyOnceAcrossLayoutChanges() = withKeyboard {
        var loaded by mutableStateOf(false)
        var width by mutableStateOf(320.dp)
        val returnFocus = pendingReturn()
        compose.setContent {
            Directory(loaded, returnFocus, hasRow = loaded, modifier = Modifier.width(width))
        }

        val fallback = compose.onNodeWithTag("fallback")
        fallback.assertIsNotFocused()
        compose.runOnIdle {
            assertNotNull(returnFocus.pending)
            width = 730.dp
            loaded = true
        }
        compose.onNodeWithTag("row").assertIsFocused()

        fallback.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        compose.runOnIdle { width = 540.dp }
        fallback.assertIsFocused()
    }

    @Test
    fun usesTheFallbackWhenTheRowDisappearsBeforeLayout() = withKeyboard {
        var ready by mutableStateOf(false)
        val returnFocus = pendingReturn()
        compose.setContent { Directory(ready, returnFocus, hasRow = !ready) }
        compose.onNodeWithTag("row").assertExists()

        compose.runOnIdle { ready = true }

        compose.onNodeWithTag("row").assertDoesNotExist()
        compose.onNodeWithTag("fallback").assertIsFocused()
    }

    @Test
    fun usesTheFallbackWhenTheRowIsDisabled() = withKeyboard {
        var ready by mutableStateOf(false)
        val returnFocus = pendingReturn()
        compose.setContent { Directory(ready, returnFocus, rowEnabled = false) }

        compose.runOnIdle { ready = true }

        compose.onNodeWithTag("row").assertIsNotEnabled()
        compose.onNodeWithTag("fallback").assertIsFocused()
    }

    @Test
    fun touchCancelsReturnFocusWhileTheDirectoryIsLoading() = withKeyboard {
        var loaded by mutableStateOf(false)
        val returnFocus = pendingReturn()
        var mode by mutableStateOf(InputMode.Keyboard)
        val inputMode =
            object : InputModeManager {
                override val inputMode: InputMode
                    get() = mode

                override fun requestInputMode(inputMode: InputMode) = inputMode == this.inputMode
            }
        compose.setContent {
            CompositionLocalProvider(LocalInputModeManager provides inputMode) {
                Directory(loaded, returnFocus, hasRow = loaded)
            }
        }

        compose.runOnIdle { mode = InputMode.Touch }
        compose.waitForIdle()
        compose.runOnIdle {
            mode = InputMode.Keyboard
            loaded = true
        }

        val row = compose.onNodeWithTag("row").assertIsNotFocused()
        compose.onNodeWithTag("fallback").assertIsNotFocused()

        compose.runOnIdle { returnFocus.returningFrom("row", InputMode.Keyboard) }
        row.assertIsFocused()
    }

    @Test
    fun keepsKeyboardFocusMovedWhileTheDirectoryIsLoading() = withKeyboard {
        var loaded by mutableStateOf(false)
        val returnFocus = pendingReturn()
        compose.setContent {
            Directory(loaded, returnFocus, hasRow = loaded)
        }

        compose.onRoot().performKeyInput { pressKey(Key.Tab) }
        compose.onNodeWithTag("fallback").assertIsFocused().performKeyInput { pressKey(Key.Tab) }
        val other = compose.onNodeWithTag("other").assertIsFocused()

        compose.runOnIdle { loaded = true }

        compose.onNodeWithTag("row").assertExists()
        other.assertIsFocused()
    }

    @Test
    fun anOldCallbackCannotClearANewReturnToTheSameRow() {
        val returnFocus = pendingReturn()
        val first = checkNotNull(returnFocus.pending)
        returnFocus.returningFrom("row", InputMode.Keyboard)
        val latest = checkNotNull(returnFocus.pending)

        returnFocus.finish(first)

        assertSame(latest, returnFocus.pending)
    }

    private fun withKeyboard(test: () -> Unit) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            test()
        } finally {
            instrumentation.resetInTouchMode()
        }
    }
}

private fun pendingReturn() =
    DirectoryReturnFocus().apply { returningFrom("row", InputMode.Keyboard) }

@Composable
private fun Directory(
    ready: Boolean,
    returnFocus: DirectoryReturnFocus,
    modifier: Modifier = Modifier,
    hasRow: Boolean = true,
    rowEnabled: Boolean = true,
) {
    val position = rememberLazyListState()
    val row = remember { FocusRequester() }
    val fallback = remember { FocusRequester() }
    OkouTheme(false) {
        Column(
            modifier.restoreDirectoryFocus(
                returnFocus,
                ready,
                position,
                row,
                fallback,
                rowEnabled,
            ),
        ) {
            Button(onClick = {}, modifier = Modifier.focusRequester(fallback).testTag("fallback")) {
                Text("Fallback")
            }
            Button(onClick = {}, modifier = Modifier.testTag("other")) { Text("Other action") }
            LazyColumn(state = position) {
                if (hasRow) {
                    item(key = "row") {
                        Button(
                            onClick = {},
                            modifier = Modifier.focusRequester(row).testTag("row"),
                            enabled = rowEnabled,
                        ) {
                            Text("Row")
                        }
                    }
                }
            }
        }
    }
}
