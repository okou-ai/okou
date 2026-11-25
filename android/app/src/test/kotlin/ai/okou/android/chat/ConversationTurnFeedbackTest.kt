package ai.okou.android.chat

import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertHeightIsEqualTo
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
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
    fun textActionsExtendIntoTheGutterAndActivateOnRelease() {
        val prompt = "Review the checklist"
        val completion =
            ConversationCompletion(
                "completed",
                null,
                null,
                listOf(ConversationFollowup(prompt, ConversationFollowupKind.Talk)),
            )
        var toggles = 0
        var selected: String? = null
        compose.setContent {
            OkouTheme {
                LazyColumn(Modifier.width(240.dp).padding(horizontal = 24.dp)) {
                    item {
                        ConversationReplySummary(
                            ReplySummary(ReplyPhase.Completed, null, null),
                            2,
                            false,
                        ) {
                            toggles++
                        }
                    }
                    item {
                        ConversationCompletionRow(completion) { selected = it }
                    }
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
            action.performTouchInput { down(Offset(2f, centerY)) }
            compose.runOnIdle {
                assertEquals(0, toggles)
                assertNull(selected)
            }
            action.performTouchInput { cancel() }
        }
        compose.runOnIdle {
            assertEquals(0, toggles)
            assertNull(selected)
        }
        for (action in listOf(summary, followup)) {
            action.performTouchInput {
                down(Offset(2f, centerY))
                up()
            }
        }
        compose.runOnIdle {
            assertEquals(1, toggles)
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

    @Test
    fun activeSummaryUsesOneLineAndExposesItsFullLabelAtLargeFontScale() {
        val summary = "Checking the release schedule, checklist, dependencies, and rollout notes"
        compose.setContent {
            val density = Density(LocalDensity.current.density, fontScale = 2f)
            CompositionLocalProvider(LocalDensity provides density) {
                OkouTheme { ConversationActivity(summary, Modifier.width(240.dp)) }
            }
        }

        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(summary).performSemanticsAction(
            SemanticsActions.GetTextLayoutResult,
        ) {
            it(layouts)
        }
        val layout = layouts.single()
        assertEquals(1, layout.lineCount)
        assertTrue(layout.isLineEllipsized(0))
        assertEquals(13.sp, layout.layoutInput.style.fontSize)
        assertEquals(20.sp, layout.layoutInput.style.lineHeight)
    }
}
