package ai.okou.android

import ai.okou.android.chat.ChatChanges
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.printToString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w1180dp-h1000dp", application = ChatListApplication::class)
internal class ConversationInlineImageRootTest : ArtifactCatalogRootTestFixture() {
    @Test
    fun opensAuthorizedOriginalAndRestoresTheImageWithoutRefetchingItsThumbnail() {
        val fixture = InlineImageFixture(app.fixture)
        fixture.install()
        openConversation()
        val image = hasContentDescription(fixture.readyAlt)
        val loaded =
            image and
                hasClickAction() and
                SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription)
        compose.waitUntil(8_000) { compose.onAllNodes(loaded).fetchSemanticsNodes().isNotEmpty() }
        val frame = compose.onNode(image).getUnclippedBoundsInRoot()
        assertEquals(240.dp, frame.width)
        assertEquals(216.dp, frame.height)
        assertEquals(listOf(fixture.readyReference), fixture.references.toList())
        assertEquals(listOf(fixture.readyReference), fixture.thumbnails.toList())
        assertTrue(fixture.originals.isEmpty())

        compose.onNode(image).assertIsDisplayed().performClick()
        awaitText(fixture.filename)
        compose.waitUntil(8_000) { fixture.originals.isNotEmpty() }
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.waitUntil(8_000) {
            compose.onAllNodes(image and isFocused()).fetchSemanticsNodes().isNotEmpty()
        }
        assertEquals(frame, compose.onNode(image).getUnclippedBoundsInRoot())
        assertEquals(listOf(fixture.readyReference), fixture.thumbnails.toList())
        assertEquals(listOf(fixture.readyReference), fixture.originals.toList())
        assertEquals(
            listOf(fixture.readyReference, fixture.readyReference),
            fixture.references.toList(),
        )
    }

    @Test
    fun withdrawsAnInlineImageAndItsSearchableFilenameWhenOriginalAccessIsDenied() {
        val fixture = InlineImageFixture(app.fixture)
        fixture.install()
        openConversation()
        val image = hasContentDescription(fixture.readyAlt)
        val loaded =
            image and
                hasClickAction() and
                SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription)
        compose.waitUntil(8_000) { compose.onAllNodes(loaded).fetchSemanticsNodes().isNotEmpty() }
        val frame = compose.onNode(image).getUnclippedBoundsInRoot()

        fixture.readyReferenceDenied = true
        compose.onNode(image).performClick()
        awaitText("You don’t have access to this artifact")
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        val unavailable =
            image and
                SemanticsMatcher.expectValue(
                    SemanticsProperties.StateDescription,
                    "Image unavailable",
                )
        compose.waitUntil(8_000) {
            compose.onAllNodes(unavailable).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNode(unavailable).assert(!hasClickAction())
        assertEquals(frame, compose.onNode(unavailable).getUnclippedBoundsInRoot())
        assertEquals(listOf(fixture.readyReference), fixture.thumbnails.toList())
        assertTrue(fixture.originals.isEmpty())

        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Find messages").performClick()
        val query = compose.onNodeWithTag("conversation_find_query")
        query.performTextReplacement(fixture.filename)
        awaitText("No matching messages")
        query.performTextReplacement(fixture.readyAlt)
        awaitText("1 matching message")
    }

    @Test
    fun findsAHiddenTimelineImageWithoutLoadingItUntilTheResultIsOpened() {
        val fixture = InlineImageFixture(app.fixture)
        fixture.install()
        openConversation()
        awaitText("The release is ready for review.")
        compose.onNodeWithContentDescription(fixture.readyAlt).assertIsDisplayed()
        assertTrue(fixture.earlierReference !in fixture.references)

        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Find messages").performClick()
        compose.onNodeWithTag("conversation_find_query").performTextReplacement("Staging baseline")
        awaitText("1 matching message")
        assertTrue(fixture.earlierReference !in fixture.references)
        compose.onNodeWithText(fixture.earlierAlt, substring = true).performClick()
        val hit = hasTestTag("conversation_find_hit") and hasContentDescription(fixture.earlierAlt)
        try {
            compose.waitUntil(8_000) {
                compose.onAllNodes(hit and isFocused()).fetchSemanticsNodes().isNotEmpty()
            }
        } catch (error: ComposeTimeoutException) {
            throw AssertionError(compose.onRoot().printToString(), error)
        }
        compose.waitUntil(8_000) {
            compose
                .onAllNodes(
                    hit and SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription),
                )
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        assertTrue(fixture.earlierReference in fixture.thumbnails)
        compose.onNode(hit).assertIsDisplayed()
    }

    @Test
    fun repeatedBareAndAngleBracketImagesShareAReadAndDeniedReferencesStayStatic() {
        val fixture = InlineImageFixture(app.fixture)
        fixture.install(
            latest =
                "![${fixture.readyAlt}](/artifacts/${fixture.readyReference})\n\n" +
                    "![Duplicate](<https://app.okou.ai/artifacts/${fixture.readyReference}>)\n\n" +
                    "![${fixture.deniedAlt}](/artifacts/${fixture.deniedReference})",
            earlier = false,
        )
        openConversation()
        val unavailable =
            hasContentDescription(fixture.deniedAlt) and
                SemanticsMatcher.expectValue(
                    SemanticsProperties.StateDescription,
                    "Image unavailable",
                )
        compose.waitUntil(8_000) {
            compose.onAllNodes(unavailable).fetchSemanticsNodes().isNotEmpty()
        }
        val ready = hasContentDescription(fixture.readyAlt)
        compose.onNode(unavailable).assert(!hasClickAction())
        compose.onNode(ready).performScrollTo()
        compose.waitUntil(8_000) {
            compose
                .onAllNodes(
                    ready and SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription),
                )
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        assertEquals(listOf(fixture.readyReference), fixture.thumbnails.toList())
        assertEquals(
            setOf(fixture.readyReference, fixture.deniedReference),
            fixture.references.toSet(),
        )
        assertEquals(2, fixture.references.size)
        assertTrue(fixture.originals.isEmpty())
    }

    @Test
    fun removesAnInvalidatedFilenameFromAnOpenFindVisit() {
        val fixture = InlineImageFixture(app.fixture)
        fixture.install()
        openConversation()
        val loaded =
            hasContentDescription(fixture.readyAlt) and
                hasClickAction() and
                SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription)
        compose.waitUntil(8_000) { compose.onAllNodes(loaded).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Find messages").performClick()
        val query = compose.onNodeWithTag("conversation_find_query")
        query.performTextReplacement(fixture.filename)
        awaitText("1 matching message")

        (app.realtimeService as TestRealtimeService).invalidate(
            ChatChanges(artifactThreads = setOf(CHAT_PERSONAL)),
        )
        awaitText("No matching messages")
        query.performTextReplacement(fixture.readyAlt)
        awaitText("1 matching message")
    }

    @Test
    @Config(qualifiers = "en-rUS-w360dp-h890dp")
    fun keepsLinkedImagesInsideTheirScrollableTableCell() {
        val fixture = InlineImageFixture(app.fixture)
        fixture.install(
            latest =
                "| Evidence | Note | Source |\n| --- | --- | --- |\n" +
                    "| [![${fixture.readyAlt}](/artifacts/${fixture.readyReference})]" +
                    "(https://example.com/report) | Passed | Staging |",
            earlier = false,
        )
        openConversation()
        val loaded =
            hasContentDescription(fixture.readyAlt) and
                hasClickAction() and
                SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription)
        compose.waitUntil(8_000) { compose.onAllNodes(loaded).fetchSemanticsNodes().isNotEmpty() }
        val frame = compose.onNode(loaded).assertIsDisplayed().getUnclippedBoundsInRoot()
        assertEquals(144.dp, frame.width)
        assertEquals(130.dp, frame.height)
        assertEquals(listOf(fixture.readyReference), fixture.thumbnails.toList())
        assertTrue(fixture.originals.isEmpty())
    }

    @Test
    @Config(qualifiers = "en-rUS-w1400dp-h1460dp")
    fun keepsAllVisibleTableImagesWhenTheResultCacheIsFull() {
        val fixture = InlineImageFixture(app.fixture)
        val names = List(25) { "cell-$it.png" }
        val table = buildString {
            appendLine("| A | B | C | D | E |")
            appendLine("| --- | --- | --- | --- | --- |")
            for (row in names.chunked(5)) {
                appendLine(
                    row.joinToString(" | ", "| ", " |") { name ->
                        "![Table cell $name](${app.fixture.server.url("/inline-thumbnail/$name")})"
                    },
                )
            }
        }
        fixture.install(latest = table, earlier = false)
        openConversation()
        val loaded =
            hasContentDescription("Table cell ", substring = true) and
                hasClickAction() and
                SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription)
        compose.waitUntil(10_000) {
            compose.onAllNodes(loaded).fetchSemanticsNodes().size == names.size
        }
        assertEquals(names.sorted(), fixture.thumbnails.sorted())
    }

    private fun openConversation() {
        app.responseGate.countDown()
        awaitText("Personal chat")
        compose.onNodeWithText("Personal chat").performClick()
    }
}
