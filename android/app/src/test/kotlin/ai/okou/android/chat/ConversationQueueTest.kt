package ai.okou.android.chat

import ai.okou.android.OkouTheme
import androidx.activity.ComponentActivity
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.WindowInfo
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp")
class ConversationQueueTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val position = LazyListState()
    private val size = mutableStateOf(IntSize(400, 800))

    @Test
    fun keepsTheFirstVisibleRowWhenTheOpenPanelChangesLayout() {
        show(mutableStateOf(entries(40)))
        compose.runOnIdle { position.requestScrollToItem(16, scrollOffset = 13) }
        item(16).assertIsDisplayed()

        listOf(IntSize(400, 440), IntSize(900, 800), IntSize(400, 800)).forEach { window ->
            compose.runOnIdle { size.value = window }
            item(16).assertIsDisplayed()
            val header = compose.onNodeWithTag("compact-panel-top-app-bar")
            if (window.height < 480) header.assertHeightIsEqualTo(64.dp)
            else header.assertDoesNotExist()
            compose.runOnIdle {
                assertEquals(16, position.firstVisibleItemIndex)
                assertEquals(13, position.firstVisibleItemScrollOffset)
            }
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w480dp-h280dp")
    fun shortQueueKeepsItsBackTargetAndCanScrollAtLargeTextSize() {
        val originalScale = RuntimeEnvironment.getFontScale()
        try {
            RuntimeEnvironment.setFontScale(2f)
            compose.activityRule.scenario.recreate()
            assertEquals(2f, compose.activity.resources.configuration.fontScale, 0f)
            size.value = IntSize(480, 280)
            show(mutableStateOf(entries(40)))
            val back = compose.onNodeWithContentDescription("Back")
            back.assertHeightIsEqualTo(48.dp)
            queue().performScrollToIndex(16)
            item(16).assertIsDisplayed()
            compose.onNodeWithText("Queue (40)").assertIsDisplayed()
            back.assertIsDisplayed()
        } finally {
            RuntimeEnvironment.setFontScale(originalScale)
        }
    }

    @Test
    fun restoredPanelUsesTheLoadedQueueToChooseItsHeight() {
        val pendingEntries = mutableStateOf<List<ConversationMessage>>(emptyList())
        show(pendingEntries)
        compose.onNodeWithText("No queued items").assertIsDisplayed()

        compose.runOnIdle {
            position.requestScrollToItem(16, scrollOffset = 13)
            pendingEntries.value = entries(40)
        }
        item(16).assertIsDisplayed()
        item(19).assertIsDisplayed()
        val openedTop = compose.onNodeWithText("Queue (40)").getUnclippedBoundsInRoot().top

        compose.runOnIdle { pendingEntries.value = emptyList() }
        compose.onNodeWithText("No queued items").assertIsDisplayed()
        assertEquals(openedTop, compose.onNodeWithText("Queue (0)").getUnclippedBoundsInRoot().top)
    }

    @Test
    fun movesFocusToTheNextSurvivingRowOutsideTheViewportAfterABatchRemoval() = keyboard {
        val entries = mutableStateOf(entries(40))
        show(entries)
        item(2).performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        queue().performScrollToIndex(16)
        item(2).assertIsFocused()
        compose.runOnIdle {
            assertTrue(position.layoutInfo.visibleItemsInfo.none { it.key == "queued-3" })
            entries.value = entries.value.drop(1).filterNot { it.message.id == "queued-2" }
        }

        item(3).assertIsDisplayed().assertIsFocused()
    }

    @Test
    fun movesFocusToThePreviousRowAndThenTheTitleWhenTheQueueEmpties() = keyboard {
        val entries = mutableStateOf(entries(2))
        show(entries)
        item(1).performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        compose.runOnIdle { entries.value = entries.value.take(1) }
        item(0).assertIsFocused()

        compose.runOnIdle { entries.value = emptyList() }
        compose.onNodeWithText("Queue (0)").assertIsDisplayed().assertIsFocused()
        compose.onNodeWithText("No queued items").assertIsDisplayed()
    }

    private fun show(entries: State<List<ConversationMessage>>) {
        compose.setContent {
            val window = LocalWindowInfo.current
            val density = LocalDensity.current
            CompositionLocalProvider(
                LocalWindowInfo provides
                    object : WindowInfo by window {
                        override val containerSize: IntSize
                            get() =
                                with(density) {
                                    IntSize(
                                        size.value.width.dp.roundToPx(),
                                        size.value.height.dp.roundToPx(),
                                    )
                                }
                    },
            ) {
                OkouTheme {
                    ConversationQueueModal(entries.value, null, null, position, onDismiss = {})
                }
            }
        }
    }

    private fun entries(count: Int) =
        List(count) { index ->
            ConversationMessage(
                HistoryMessage(
                    id = "queued-$index",
                    runId = null,
                    role = HistoryRole.User,
                    blocks = listOf(HistoryBlock(HistoryBlockKind.Text, "Waiting message $index")),
                    queued = true,
                ),
            )
        }

    private fun queue() = compose.onNodeWithTag("conversation_queue")

    private fun item(index: Int) = compose.onNodeWithTag("message_queued-$index")

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
