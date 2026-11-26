package ai.okou.android.chat

import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
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
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConversationAttachmentLayoutTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun centersOneSentImageAtFourByThreeAcrossWidths() {
        val width = mutableStateOf(400.dp)
        val image = ChatAttachmentReference("image", "Rollout diagram.png", "image/png")
        val entry =
            ConversationMessage(
                HistoryMessage("message", null, HistoryRole.User, listOf(image.historyBlock())),
            )
        compose.setContent {
            OkouTheme {
                Box(Modifier.width(width.value)) { ConversationMessageRow(entry) }
            }
        }

        val attachment = compose.onNodeWithContentDescription(image.filename)
        attachment.assertWidthIsEqualTo(240.dp).assertHeightIsEqualTo(180.dp)
        val wide = attachment.getUnclippedBoundsInRoot()
        val group = compose.onNodeWithTag("chat-message-attachments").getUnclippedBoundsInRoot()
        assertEquals(10.dp, wide.left - group.left)
        assertEquals(10.dp, group.right - wide.right)

        compose.runOnIdle { width.value = 240.dp }
        attachment.assertWidthIsEqualTo(172.dp).assertHeightIsEqualTo(129.dp)
    }
}
