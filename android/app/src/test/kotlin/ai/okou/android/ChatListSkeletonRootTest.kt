package ai.okou.android

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w440dp-h900dp-440dpi",
    application = ChatListApplication::class,
)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
internal class ChatListSkeletonRootTest : ChatListRootTestFixture() {
    @Test
    fun scaledSkeletonMatchesLoadedProjectAndChatRows() {
        val priorScale = RuntimeEnvironment.getFontScale()
        try {
            RuntimeEnvironment.setFontScale(2f)
            compose.activityRule.scenario.recreate()
            assertEquals(2f, compose.activity.resources.configuration.fontScale, 0f)
            val app = compose.activity.application as ChatListApplication
            compose.mainClock.advanceTimeBy(320)
            val placeholders =
                compose.onAllNodesWithTag("chat_list_skeleton_row", useUnmergedTree = true)
            val projectSlot = placeholders[0].assertIsDisplayed().getUnclippedBoundsInRoot()
            val chatSlot = placeholders[1].assertIsDisplayed().getUnclippedBoundsInRoot()
            app.responseGate.countDown()
            awaitListAndNames()
            val project = compose.onNodeWithText("Research").getUnclippedBoundsInRoot()
            val chat = compose.onNodeWithTag("chat_$CHAT_PERSONAL").getUnclippedBoundsInRoot()
            assertEquals(projectSlot.top, project.top)
            assertEquals(projectSlot.bottom, project.bottom)
            assertEquals(chatSlot.top, chat.top)
            assertEquals(chatSlot.bottom, chat.bottom)
            assertTrue(
                "Expected a scaled placeholder row: $projectSlot",
                projectSlot.bottom - projectSlot.top > 56.dp,
            )
        } finally {
            RuntimeEnvironment.setFontScale(priorScale)
        }
    }
}
