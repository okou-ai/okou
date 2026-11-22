package ai.okou.android.chat

import ai.okou.android.TestOkouApplication
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w400dp-h800dp-mdpi",
    application = TestOkouApplication::class,
)
class ChatRowSwipeTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun theRowFollowsADragAndOnlyAnArmedReleaseCommits() {
        val haptics = mutableListOf<HapticFeedbackType>()
        val actions = mutableListOf<ChatRowAction>()
        val feedback =
            object : HapticFeedback {
                override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) {
                    haptics.add(hapticFeedbackType)
                }
            }
        compose.setContent {
            CompositionLocalProvider(LocalHapticFeedback provides feedback) {
                Box(Modifier.width(300.dp).testTag("swipe")) {
                    ChatRowSwipe(
                        ChatRowAction.MarkRead,
                        ChatRowAction.Archive,
                        { actions.add(it) },
                    ) { modifier ->
                        Box(modifier.fillMaxWidth().height(52.dp).testTag("swipe_foreground"))
                    }
                }
            }
        }
        val row = compose.onNodeWithTag("swipe")
        val foreground = compose.onNodeWithTag("swipe_foreground")
        val restingLeft = foreground.getUnclippedBoundsInRoot().left
        val thresholdHaptic = HapticFeedbackType.GestureThresholdActivate
        row.performTouchInput {
            down(center)
            moveTo(center + Offset(-36.dp.toPx(), 0f))
        }
        assertEquals(restingLeft - 36.dp, foreground.getUnclippedBoundsInRoot().left)
        row.performTouchInput { moveTo(center + Offset(-71.dp.toPx(), 0f)) }
        compose.runOnIdle { assertEquals(emptyList<HapticFeedbackType>(), haptics) }
        row.performTouchInput { moveTo(center + Offset(-72.dp.toPx(), 0f)) }
        compose.runOnIdle {
            assertEquals(listOf(thresholdHaptic), haptics)
            assertEquals(emptyList<ChatRowAction>(), actions)
        }
        row.performTouchInput { moveTo(center + Offset(-104.dp.toPx(), 0f)) }
        assertEquals(restingLeft - 104.dp, foreground.getUnclippedBoundsInRoot().left)
        row.performTouchInput {
            moveTo(center + Offset(-64.dp.toPx(), 0f))
            up()
        }
        compose.runOnIdle {
            assertEquals(listOf(thresholdHaptic), haptics)
            assertEquals(emptyList<ChatRowAction>(), actions)
        }

        compose.mainClock.autoAdvance = false
        try {
            row.performTouchInput {
                down(center)
                moveTo(center + Offset(40.dp.toPx(), 0f))
                moveTo(center + Offset(96.dp.toPx(), 80.dp.toPx()))
                moveTo(center + Offset(80.dp.toPx(), 0f))
                moveTo(center + Offset(56.dp.toPx(), 0f))
                moveTo(center + Offset(96.dp.toPx(), 0f))
                up()
            }
            compose.mainClock.advanceTimeByFrame()
            assertEquals(restingLeft, foreground.getUnclippedBoundsInRoot().left)
            compose.runOnIdle {
                assertEquals(List(3) { thresholdHaptic }, haptics)
                assertEquals(listOf(ChatRowAction.MarkRead), actions)
            }
        } finally {
            compose.mainClock.autoAdvance = true
        }
    }
}
