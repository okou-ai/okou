package ai.okou.android.chat

import ai.okou.android.TestOkouApplication
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
    fun workspaceSearchUsesTheReportedUtf16RangeInTheOriginalMarkdown() {
        val word = "截止时间"
        val indexed = "💬 First **$word**.\r\n\r\n$word from the second paragraph."
        val prefix = "\r\n".repeat(10) + '\uFEFF'
        val reply = reply("$prefix$indexed \r\n")
        val start = indexed.lastIndexOf(word)
        val target =
            reply.workspaceSearchTarget(start until start + word.length, inlineImages = true)
        assertEquals("1", target.markdownBlockPath)
        assertEquals(0, target.bodyIndex)
        assertNull(target.markdownImage)

        val messageOnly = reply.workspaceSearchTarget(null, inlineImages = true)
        assertEquals(reply.id, messageOnly.id)
        assertNull(messageOnly.markdownBlockPath)
    }

    @Test
    fun workspaceSearchUsesTheExactInlineImageWithADuplicateDescription() {
        val image = "![Release plan](https://example.com/plan.png)"
        val source = "Status\n\n$image before $image."
        val start = source.lastIndexOf("Release")
        val range = start until start + "Release".length
        val reply = reply(source)

        val target = reply.workspaceSearchTarget(range, inlineImages = true)
        assertEquals("1", target.markdownBlockPath)
        assertEquals("1/1", target.markdownImage)
        assertNull(reply.workspaceSearchTarget(range, inlineImages = false).markdownImage)
    }

    @Test
    fun workspaceSearchFocusesTheReplyWhenOnlyALinkDefinitionMatches() {
        val keyword = "release-notes"
        val source = "Read the [guide][docs].\n\n[docs]: https://example.com/$keyword"
        val start = source.indexOf(keyword)
        val message = reply(source)
        val target = message.workspaceSearchTarget(start until start + keyword.length, false)
        assertEquals(message.id, target.id)
        assertNull(target.markdownBlockPath)
    }

    @Test
    fun workspaceSearchFocusesOnlyTheMatchedParagraphOfANestedListItem() {
        val sibling = "Build passed"
        val match = "Confirm the release owner."
        val source = "1. Review the rollout\n   - $sibling\n   - $match\n2. Notify the team"
        val start = source.indexOf(match)
        val target = reply(source).workspaceSearchTarget(start until start + match.length, false)
        compose.setContent {
            MaterialTheme {
                HistoryMarkdown(
                    source,
                    MaterialTheme.typography.bodyLarge,
                    artifacts = null,
                    messageId = "reply",
                    artifactTurnKey = "reply",
                    highlight = ConversationFindHighlight(target, reveal = {}),
                )
            }
        }
        val focused = hasTestTag("conversation_find_hit") and isFocused()
        compose.waitUntilExactlyOneExists(focused, 5_000)
        compose.onNode(focused).assertIsDisplayed().assertTextEquals(match)
        compose.onNodeWithText(sibling).assertIsDisplayed()
    }

    private fun reply(source: String) =
        HistoryMessage(
            "reply",
            null,
            HistoryRole.Assistant,
            listOf(HistoryBlock(HistoryBlockKind.Text, source)),
        )

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
