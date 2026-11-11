package ai.okou.android

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.testing.TestLifecycleOwner
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FoundationScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun nativeDraftAndActionsUseTheRealStateHolder() {
        val model = compose.runOnIdle { FoundationModel() }
        compose.setContent { OkouTheme { FoundationScreen(model) } }
        compose.onNodeWithText("Preview draft").assertIsNotEnabled()
        compose.onNodeWithText("Local draft").performTextInput("  Hello Okou\n")
        compose.onNodeWithText("Preview draft").assertIsEnabled().performClick()
        compose.onNodeWithText("Draft preview:   Hello Okou\n").assertExists()
        compose.onNodeWithText("Local draft").performTextReplacement("   ")
        compose.onNodeWithText("Preview draft").assertIsNotEnabled()
    }

    @Test
    fun stoppedScreenPausesCollectionAndResumesWithTheOwnersLatestState() {
        val model = compose.runOnIdle { FoundationModel() }
        val lifecycle = compose.runOnIdle { TestLifecycleOwner(Lifecycle.State.STARTED) }
        try {
            compose.runOnIdle {
                model.replaceDraft("visible")
                model.previewDraft()
            }
            compose.setContent {
                CompositionLocalProvider(LocalLifecycleOwner provides lifecycle) {
                    OkouTheme { FoundationScreen(model) }
                }
            }
            compose.onNodeWithText("Draft preview: visible").assertExists()
            compose.runOnIdle { lifecycle.currentState = Lifecycle.State.CREATED }
            compose.runOnIdle {
                model.replaceDraft("while stopped")
                model.previewDraft()
            }
            compose.onNodeWithText("Draft preview: visible").assertExists()
            compose.runOnIdle { lifecycle.currentState = Lifecycle.State.STARTED }
            compose.onNodeWithText("Draft preview: while stopped").assertExists()
        } finally {
            compose.runOnIdle { lifecycle.currentState = Lifecycle.State.DESTROYED }
        }
    }

    @Test
    fun replacingScreenOwnerRebindsStateAndActions() {
        val first = compose.runOnIdle { FoundationModel() }
        val second = compose.runOnIdle { FoundationModel() }
        val selected = mutableStateOf(first)
        compose.runOnIdle {
            first.replaceDraft("first")
            first.previewDraft()
            second.replaceDraft("second")
            second.previewDraft()
        }
        compose.setContent { OkouTheme { FoundationScreen(selected.value) } }
        compose.onNodeWithText("Draft preview: first").assertExists()
        compose.runOnIdle { selected.value = second }
        compose.onNodeWithText("Draft preview: second").assertExists()
        compose.runOnIdle {
            first.replaceDraft("retired screen")
            first.previewDraft()
        }
        compose.onNodeWithText("Draft preview: second").assertExists()
        compose.onNodeWithText("Local draft").performTextReplacement("new second")
        compose.onNodeWithText("Preview draft").performClick()
        compose.onNodeWithText("Draft preview: new second").assertExists()
        compose.runOnIdle {
            org.junit.Assert.assertEquals("retired screen", first.uiState.value.text)
            org.junit.Assert.assertEquals("new second", second.uiState.value.text)
        }
    }
}
