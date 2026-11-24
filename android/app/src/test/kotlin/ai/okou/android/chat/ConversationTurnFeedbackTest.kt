package ai.okou.android.chat

import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = TestOkouApplication::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConversationTurnFeedbackTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun anEllipsizedSuggestionStillProvidesItsFullTextAndAction() {
        val prompt =
            "Summarize the release notes, include the deployment dates and flag follow-up tasks."
        val followups = listOf(ConversationFollowup(prompt, ConversationFollowupKind.Talk))
        val completion = ConversationCompletion("completed", null, null, followups)
        var selected: String? = null
        compose.setContent {
            OkouTheme {
                ConversationCompletionRow(completion, Modifier.width(160.dp)) { selected = it }
            }
        }

        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(prompt, useUnmergedTree = true).performSemanticsAction(
            SemanticsActions.GetTextLayoutResult,
        ) {
            it(layouts)
        }
        val layout = layouts.single()
        assertEquals(2, layout.lineCount)
        assertTrue(layout.isLineEllipsized(1))
        compose.onNode(hasText(prompt) and hasClickAction()).performClick()
        compose.runOnIdle { assertEquals(prompt, selected) }
    }
}
