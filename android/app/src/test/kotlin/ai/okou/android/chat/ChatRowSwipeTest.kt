package ai.okou.android.chat

import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
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
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w400dp-h800dp-mdpi",
    application = TestOkouApplication::class,
)
class ChatRowSwipeTest {
    @get:Rule val compose = createComposeRule()

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun bothLabelsAreClippedToTheMovingEdgeDuringDragAndReversal() {
        val actions = mutableListOf<ChatRowAction>()
        compose.setContent {
            OkouTheme(dark = false) {
                Box(Modifier.width(300.dp).testTag("swipe")) {
                    ChatRowSwipe(
                        ChatRowAction.MarkRead,
                        ChatRowAction.Archive,
                        { actions.add(it) },
                        selected = false,
                    ) {
                        Box(it.fillMaxWidth().height(52.dp))
                    }
                }
            }
        }
        val row = compose.onNodeWithTag("swipe")
        fun labelPixels(fromLeft: Boolean, start: Int, end: Int): Int {
            val pixels = row.captureToImage().toPixelMap()
            return (start until end).sumOf { distance ->
                val x = if (fromLeft) distance else pixels.width - distance - 1
                (16 until 36).count { y -> pixels[x, y] != pixels[x, 10] }
            }
        }

        row.performTouchInput { down(center) }
        for (sign in listOf(1, -1)) {
            val fromLeft = sign > 0
            row.performTouchInput { moveTo(center + Offset(sign * 44.dp.toPx(), 0f)) }
            val partial = labelPixels(fromLeft, 36, 44)
            assertTrue(partial > 0)
            assertEquals(0, labelPixels(fromLeft, 44, 112))
            row.performTouchInput { moveTo(center + Offset(sign * 60.dp.toPx(), 0f)) }
            assertTrue(labelPixels(fromLeft, 36, 60) > partial)
            assertEquals(0, labelPixels(fromLeft, 60, 112))
            row.performTouchInput { moveTo(center + Offset(sign * 44.dp.toPx(), 0f)) }
            assertEquals(partial, labelPixels(fromLeft, 36, 44))
        }
        row.performTouchInput { cancel() }
        assertEquals(0, labelPixels(fromLeft = false, start = 36, end = 112))
        assertTrue(actions.isEmpty())
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun selectedRowHasActionColorBehindItsRoundedEdgeInBothDirections() {
        compose.setContent {
            OkouTheme(dark = true) {
                Box(Modifier.width(300.dp).background(Color.Black).testTag("swipe")) {
                    ChatRowSwipe(
                        ChatRowAction.MarkUnread,
                        ChatRowAction.Archive,
                        {},
                        selected = true,
                    ) { modifier ->
                        ListItem(
                            selected = true,
                            onClick = {},
                            shapes =
                                ListItemDefaults.shapes(
                                    selectedShape = MaterialTheme.shapes.extraLarge,
                                ),
                            modifier = modifier.fillMaxWidth(),
                        ) {}
                    }
                }
            }
        }
        val row = compose.onNodeWithTag("swipe")
        row.performTouchInput { down(center) }
        for (sign in listOf(1, -1)) {
            row.performTouchInput { moveTo(center + Offset(sign * 88.dp.toPx(), 0f)) }
            val pixels = row.captureToImage().toPixelMap()
            fun x(distance: Int) = if (sign > 0) distance else pixels.width - distance - 1
            val action = pixels[x(30), 2]
            assertTrue(action != Color.Black)
            assertEquals(action, pixels[x(90), 2])
            assertTrue(action != pixels[x(90), pixels.height / 2])
        }
        row.performTouchInput { cancel() }
    }

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
                        selected = false,
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
