package ai.okou.android

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
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
    fun nativeDraftAndActionUseTheRealGraph() {
        val model = compose.runOnIdle { FoundationModel() }
        try {
            compose.setContent { OkouTheme { FoundationScreen(model) } }
            compose.onNodeWithText("Preview draft").assertIsNotEnabled()
            compose.onNodeWithText("Local draft").performTextInput("  Hello Okou\n")
            compose.onNodeWithText("Preview draft").assertIsEnabled().performClick()
            compose.onNodeWithText("Draft preview:   Hello Okou\n").assertExists()
            compose.onNodeWithText("Local draft").performTextReplacement("   ")
            compose.onNodeWithText("Preview draft").assertIsNotEnabled()
        } finally {
            compose.runOnIdle { model.store.close() }
        }
    }
}
