package ai.okou.android.chat

import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
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
    fun textActionsExtendIntoTheGutterAndHighlightOnlyWhilePressedInTouchMode() {
        val prompt = "Review the checklist"
        val completion =
            ConversationCompletion(
                "completed",
                null,
                null,
                listOf(ConversationFollowup(prompt, ConversationFollowupKind.Talk)),
            )
        var toggled = false
        var selected: String? = null
        val pageColor = Color.Magenta
        var pressedColor = Color.Unspecified
        compose.setContent {
            OkouTheme {
                val colors = MaterialTheme.colorScheme
                pressedColor =
                    colors.onSecondaryContainer
                        .copy(alpha = 0.09f)
                        .compositeOver(colors.secondaryContainer)
                Column(Modifier.width(240.dp).background(pageColor).padding(horizontal = 24.dp)) {
                    ConversationReplySummary(
                        ReplySummary(ReplyPhase.Completed, null, null),
                        2,
                        false,
                    ) {
                        toggled = true
                    }
                    ConversationCompletionRow(completion) { selected = it }
                }
            }
        }

        val summary = compose.onNodeWithTag("conversation_reply_summary")
        val followup = compose.onNodeWithTag("conversation_followup")
        val summaryBounds = summary.getUnclippedBoundsInRoot()
        val followupBounds = followup.getUnclippedBoundsInRoot()
        assertEquals(16.dp, summaryBounds.left)
        assertEquals(16.dp, followupBounds.left)
        assertEquals(216.dp, followupBounds.right)
        assertTrue(summaryBounds.right < followupBounds.right)

        for (action in listOf(summary, followup)) {
            action.assertHeightIsEqualTo(48.dp)
            fun colorAtOutset(): Int {
                val pixels = action.captureToImage().toPixelMap()
                return pixels[2, pixels.height / 2].toArgb()
            }
            assertEquals(pageColor.toArgb(), colorAtOutset())
            action.performTouchInput { down(Offset(2f, centerY)) }
            assertEquals(pressedColor.toArgb(), colorAtOutset())
            action.performTouchInput { up() }
            assertEquals(pageColor.toArgb(), colorAtOutset())
        }
        compose.runOnIdle {
            assertTrue(toggled)
            assertEquals(prompt, selected)
        }
    }

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
