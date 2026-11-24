package ai.okou.android.chat

import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ComposeUiTestConfig
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.click
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToIndex
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
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = TestOkouApplication::class)
class ChatListViewportTest {
    private val animationScale = mutableFloatStateOf(1f)
    private val motion =
        object : MotionDurationScale {
            override val scaleFactor: Float
                get() = animationScale.floatValue
        }
    @get:Rule val compose = createComposeRule(ComposeUiTestConfig(motion))

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun reducedMotionPreservesTheActiveSegmentAndProgressSemantics() {
        animationScale.floatValue = 0f
        compose.setContent {
            OkouTheme(dark = false) {
                ChatListViewport(
                    Modifier.fillMaxWidth().height(280.dp),
                    rememberLazyListState(),
                    contentChangeKey = null,
                    syncing = true,
                    newChatEnabled = false,
                    newChat = {},
                    feedback = {},
                ) { _, _ ->
                    Box(Modifier.fillMaxWidth())
                }
            }
        }
        val indicator = compose.onNodeWithContentDescription("Syncing chats…")
        assertEquals(
            ProgressBarRangeInfo.Indeterminate,
            indicator.fetchSemanticsNode().config[SemanticsProperties.ProgressBarRangeInfo],
        )
        val pixels = indicator.captureToImage().toPixelMap()
        assertEquals(Color(0xFFB5790C), pixels[pixels.width / 8, pixels.height / 2])
        assertEquals(Color(0xFFF6EFE2), pixels[pixels.width * 3 / 4, pixels.height / 2])
    }

    @Test
    fun aReaderAtTheEndFollowsNewRowsAndViewportChanges() {
        val height = mutableStateOf(480.dp)
        val projectCount = mutableStateOf(0)
        val rowCount = mutableStateOf(30)
        val syncing = mutableStateOf(false)
        var clickedChat: Int? = null
        compose.setContent {
            OkouTheme {
                val listState = rememberLazyListState()
                ChatListViewport(
                    Modifier.fillMaxWidth().height(height.value),
                    listState,
                    contentChangeKey = projectCount.value to "chat_${rowCount.value - 1}",
                    syncing = syncing.value,
                    newChatEnabled = true,
                    newChat = {},
                    feedback = {},
                ) { bottomSpace, _ ->
                    LazyColumn(
                        Modifier.widthIn(max = 280.dp).fillMaxWidth().testTag("rows"),
                        state = listState,
                        contentPadding = PaddingValues(bottom = bottomSpace),
                    ) {
                        items(projectCount.value, key = { "project_$it" }) { index ->
                            Box(Modifier.fillMaxWidth().height(52.dp)) { Text("Project $index") }
                        }
                        items(rowCount.value, key = { it }) { index ->
                            Box(
                                Modifier.fillMaxWidth()
                                    .height(52.dp)
                                    .clickable { clickedChat = index }
                                    .testTag("chat_$index"),
                            ) {
                                Text("Chat $index")
                            }
                        }
                    }
                }
            }
        }
        val rows = compose.onNodeWithTag("rows")
        rows.performScrollToIndex(29)
        compose.onNodeWithTag("chat_29").assertIsDisplayed()

        compose.runOnIdle { rowCount.value = 32 }

        val lastRow = compose.onNodeWithTag("chat_31")
        lastRow.assertIsDisplayed()

        compose.runOnIdle { projectCount.value = 160 }
        lastRow.assertIsDisplayed()

        compose.runOnIdle { height.value = 280.dp }

        lastRow.assertIsDisplayed()
        val action = compose.onNodeWithText("New chat").getUnclippedBoundsInRoot()
        assertTrue(lastRow.getUnclippedBoundsInRoot().bottom < action.top)

        rows.performScrollToIndex(projectCount.value + 8)
        val visibleRow = compose.onNodeWithTag("chat_8")
        val position = visibleRow.getUnclippedBoundsInRoot().top
        val progress = compose.onNodeWithContentDescription("Syncing chats…")
        progress.assertDoesNotExist()

        compose.runOnIdle { syncing.value = true }
        val progressBounds = progress.assertIsDisplayed().getUnclippedBoundsInRoot()
        val listBounds = rows.getUnclippedBoundsInRoot()
        assertTrue(listBounds.left > 0.dp)
        assertTrue(progressBounds.top <= listBounds.top && progressBounds.bottom > listBounds.top)
        assertEquals(listBounds.left, progressBounds.left)
        assertEquals(listBounds.right, progressBounds.right)
        assertEquals(position, visibleRow.getUnclippedBoundsInRoot().top)
        visibleRow.performTouchInput { click(Offset(center.x, 1.dp.toPx())) }
        compose.runOnIdle { assertEquals(8, clickedChat) }

        compose.runOnIdle { syncing.value = false }
        progress.assertDoesNotExist()

        compose.runOnIdle { rowCount.value = 33 }

        assertEquals(position, visibleRow.getUnclippedBoundsInRoot().top)
    }
}
