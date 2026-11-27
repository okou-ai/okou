package ai.okou.android.chat

import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.resolvePalette
import androidx.compose.foundation.background
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
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.click
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.Dp
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
    fun floatingActionKeepsListGeometryStableUnderFeedback() {
        verifyFeedbackOverlay(480.dp, floatingAction = true)
    }

    @Test
    fun inlineActionKeepsListGeometryStableUnderFeedback() {
        verifyFeedbackOverlay(200.dp, floatingAction = false)
    }

    private fun verifyFeedbackOverlay(height: Dp, floatingAction: Boolean) {
        val feedbackHeight = mutableStateOf(0.dp)
        compose.setContent {
            OkouTheme {
                val listState = rememberLazyListState()
                ChatListViewport(
                    Modifier.fillMaxWidth().height(height).testTag("viewport"),
                    listState,
                    contentChangeKey = null,
                    syncing = false,
                    filter = ChatListFilter.Inbox,
                    newChatEnabled = true,
                    newChat = {},
                    feedback = {
                        if (feedbackHeight.value > 0.dp) {
                            Box(
                                Modifier.fillMaxWidth()
                                    .height(feedbackHeight.value)
                                    .testTag("feedback"),
                            )
                        }
                    },
                ) { bottomSpace, inline ->
                    LazyColumn(
                        Modifier.fillMaxWidth().testTag("rows"),
                        state = listState,
                        contentPadding = PaddingValues(bottom = bottomSpace),
                    ) {
                        if (inline != null) item(content = { inline() })
                        items(20) { index ->
                            Box(Modifier.fillMaxWidth().height(52.dp)) { Text("Chat $index") }
                        }
                    }
                }
            }
        }
        val rows = compose.onNodeWithTag("rows")
        val row = compose.onNodeWithText("Chat 19")
        val feedback = compose.onNodeWithTag("feedback")
        rows.performScrollToIndex(if (floatingAction) 19 else 20)
        val rowBounds = row.assertIsDisplayed().getUnclippedBoundsInRoot()
        val feedbackBottom =
            if (floatingAction)
                compose
                    .onNode(hasText("New chat") and hasClickAction())
                    .getUnclippedBoundsInRoot()
                    .top - 8.dp
            else compose.onNodeWithTag("viewport").getUnclippedBoundsInRoot().bottom - 8.dp

        for (height in listOf(48.dp, 100.dp, 0.dp)) {
            compose.runOnIdle { feedbackHeight.value = height }
            assertEquals(rowBounds, row.getUnclippedBoundsInRoot())
            if (height == 0.dp) feedback.assertDoesNotExist()
            else assertEquals(feedbackBottom, feedback.getUnclippedBoundsInRoot().bottom)
        }

        rows.performScrollToIndex(7)
        val midList = compose.onNodeWithText(if (floatingAction) "Chat 7" else "Chat 6")
        val midBounds = midList.getUnclippedBoundsInRoot()
        compose.runOnIdle { feedbackHeight.value = 100.dp }
        assertEquals(midBounds, midList.getUnclippedBoundsInRoot())
    }

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
                    filter = ChatListFilter.Inbox,
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
        val colors = resolvePalette(UserPreferencesColorTheme.DEFAULT, dark = false)
        assertEquals(colors.primary, pixels[pixels.width / 8, pixels.height / 2])
        assertEquals(colors.secondaryContainer, pixels[pixels.width * 3 / 4, pixels.height / 2])
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun refreshFadesReversesAndRetiresWhenTheFilterChanges() {
        val syncing = mutableStateOf(false)
        val filter = mutableStateOf(ChatListFilter.Inbox)
        compose.setContent {
            OkouTheme(dark = false) {
                ChatListViewport(
                    Modifier.fillMaxWidth().height(280.dp).testTag("viewport"),
                    rememberLazyListState(),
                    contentChangeKey = null,
                    syncing = syncing.value,
                    filter = filter.value,
                    newChatEnabled = false,
                    newChat = {},
                    feedback = {},
                ) { _, _ ->
                    Box(Modifier.fillMaxWidth().height(56.dp).background(Color.White))
                }
            }
        }
        val viewport = compose.onNodeWithTag("viewport")
        val progress = compose.onNodeWithContentDescription("Syncing chats…")
        val progressRange =
            compose.onNode(
                SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo),
                useUnmergedTree = true,
            )
        fun tint(): Float {
            val pixels = viewport.captureToImage().toPixelMap()
            return 1f - (0 until pixels.width).minOf { pixels[it, 2].blue }
        }
        fun advance(millis: Long) {
            // SubcomposeLayout installs the overlay during Android layout, outside the test clock.
            compose.mainClock.advanceTimeByFrame()
            compose.waitForIdle()
            compose.mainClock.advanceTimeBy(millis)
        }
        compose.mainClock.autoAdvance = false
        try {
            assertEquals(0f, tint())
            compose.runOnIdle { syncing.value = true }
            advance(64)
            val entering = tint()
            advance(160)
            val active = tint()
            assertTrue(
                "Entry tint $entering, settled tint $active",
                entering > 0f && entering < active,
            )
            progress.assertIsDisplayed()
            progressRange.assertExists()

            compose.runOnIdle { syncing.value = false }
            advance(64)
            progress.assertDoesNotExist()
            progressRange.assertDoesNotExist()
            val exiting = tint()
            assertTrue("Exit tint $exiting, settled tint $active", exiting > 0f && exiting < active)

            compose.runOnIdle { syncing.value = true }
            advance(16)
            val reversalStart = tint()
            // The in-flight exit can advance a frame before Compose observes the new target.
            assertEquals(
                "The first reversal frame retains the exit tint",
                exiting,
                reversalStart,
                active * 0.2f,
            )
            advance(200)
            progress.assertIsDisplayed()
            assertTrue("The reversed transition resumes fading in", tint() > reversalStart)

            compose.runOnIdle { syncing.value = false }
            advance(48)
            assertTrue(tint() > 0f)
            compose.runOnIdle { filter.value = ChatListFilter.Unread }
            advance(32)
            assertEquals(0f, tint())
            progress.assertDoesNotExist()

            compose.runOnIdle { syncing.value = true }
            advance(192)
            assertTrue(tint() > 0f)
            compose.runOnIdle { syncing.value = false }
            // Allow the first animation frame before checking the completed 150 ms exit.
            advance(192)
            assertEquals(0f, tint())
            progressRange.assertDoesNotExist()
        } finally {
            compose.mainClock.autoAdvance = true
        }
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
                    filter = ChatListFilter.Inbox,
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
