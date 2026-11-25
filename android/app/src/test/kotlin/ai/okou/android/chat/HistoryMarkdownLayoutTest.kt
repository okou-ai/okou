package ai.okou.android.chat

import ai.okou.android.TestOkouApplication
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class HistoryMarkdownLayoutTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun conversationMarkdownUsesItsFormattedHeightOnTheFirstLayout() {
        val source = "# Title\n${"\n".repeat(8)}**Subtitle**"
        val replyHeights = mutableListOf<Int>()
        compose.setContent {
            MaterialTheme {
                Box(Modifier.width(160.dp).onSizeChanged { replyHeights += it.height }) {
                    HistoryMarkdown(
                        source,
                        MaterialTheme.typography.bodyLarge,
                        artifacts = null,
                        messageId = "reply",
                        artifactTurnKey = "reply",
                    )
                }
            }
        }
        compose.waitUntilExactlyOneExists(hasText("Title"), 5_000)
        compose.runOnIdle {
            assertEquals(listOf(replyHeights.last()), replyHeights)
        }
    }
}
