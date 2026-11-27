package ai.okou.android

import ai.okou.android.chat.ChatChanges
import android.content.ClipboardManager
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w1180dp-h1000dp", application = ChatListApplication::class)
internal class ConversationInlineImageRootTest : ArtifactCatalogRootTestFixture() {
    @Test
    fun authorizedPlaceholderKeepsItsBoundsAndShowsNoFallbackBeforeDecoding() {
        val fixture = InlineImageFixture(app.fixture)
        val decode = CountDownLatch(1)
        fixture.beforeReadyThumbnail = { check(decode.await(10, TimeUnit.SECONDS)) }
        fixture.install(earlier = false)
        val image = hasContentDescription(fixture.readyAlt)
        val loading =
            image and
                hasClickAction() and
                SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Loading image…")
        val followingText = compose.onNodeWithText("The release is ready for review.")
        val (frame, textBounds) =
            try {
                openConversation()
                compose.waitUntilExactlyOneExists(loading, 8_000)
                compose.onNodeWithText("View original", useUnmergedTree = true).assertDoesNotExist()
                compose.onNode(loading).getUnclippedBoundsInRoot() to
                    followingText.getUnclippedBoundsInRoot()
            } finally {
                decode.countDown()
            }
        val loaded = image and SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription)
        compose.waitUntilExactlyOneExists(loaded, 8_000)
        assertEquals(frame, compose.onNode(loaded).getUnclippedBoundsInRoot())
        assertEquals(textBounds, followingText.getUnclippedBoundsInRoot())
        compose.onNodeWithText("View original", useUnmergedTree = true).assertDoesNotExist()
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun failedThumbnailDecodeShowsTheOriginalActionInsideTheSameFrame() {
        val fixture = InlineImageFixture(app.fixture)
        fixture.invalidReadyThumbnail = true
        fixture.install(earlier = false)
        openConversation()
        val fallback =
            hasContentDescription(fixture.readyAlt) and
                hasClickAction() and
                SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "No thumbnail")
        compose.waitUntilExactlyOneExists(fallback, 8_000)
        val frame = compose.onNode(fallback).getUnclippedBoundsInRoot()
        assertEquals(240.dp, frame.width)
        assertEquals(216.dp, frame.height)
        compose.onNodeWithText("View original", useUnmergedTree = true).assertIsDisplayed()
        compose.onNode(fallback).performClick()
        compose.waitUntilExactlyOneExists(
            hasTestTag("artifact_image_transform") and hasContentDescription(fixture.readyAlt),
            8_000,
        )
        compose.waitUntil(8_000) { fixture.originals.isNotEmpty() }
    }

    @Test
    fun copiesAuthorizedImagesAndTableCellsInReadingOrder() {
        val fixture = InlineImageFixture(app.fixture)
        val ready = "/artifacts/${fixture.readyReference}"
        val outer = "https://example.com/rollout"
        fixture.install(
            latest =
                "Rollout checks\n\n- Build complete\n- Tests passed\n\n" +
                    "![${fixture.readyAlt}]($ready)\n\n" +
                    "| Evidence | Note |\n| --- | --- |\n" +
                    "| [![Linked chart]($ready)]($outer) | ![${fixture.deniedAlt}](/artifacts/${fixture.deniedReference}) |",
            earlier = false,
        )
        openConversation()
        val mainImage = hasContentDescription(fixture.readyAlt) and hasClickAction()
        val linked = hasContentDescription("Linked chart") and hasClickAction()
        val denied =
            hasContentDescription(fixture.deniedAlt) and
                SemanticsMatcher.expectValue(
                    SemanticsProperties.StateDescription,
                    "Image unavailable",
                )
        compose.waitUntil(8_000) {
            listOf(mainImage, linked, denied).all {
                compose.onAllNodes(it).fetchSemanticsNodes().isNotEmpty()
            }
        }
        val references = fixture.references.toList()
        compose.onNodeWithContentDescription("Reply actions").assertIsDisplayed().performClick()
        awaitText("Copy reply")
        compose.onNodeWithText("Copy reply").performClick()
        val clipboard =
            checkNotNull(compose.activity.getSystemService(ClipboardManager::class.java))
        compose.waitUntil(5_000) { clipboard.primaryClip != null }

        assertEquals(
            "Rollout checks\n\n• Build complete\n• Tests passed\n" +
                "${fixture.readyAlt} [${BuildConfig.WEB_ORIGIN.trimEnd('/')}$ready]\n\n" +
                "Evidence\tNote\nLinked chart [$outer]\t${fixture.deniedAlt}",
            clipboard.primaryClip?.getItemAt(0)?.text?.toString(),
        )
        assertEquals(references, fixture.references.toList())
        assertTrue(fixture.originals.isEmpty())
    }

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
        compose.waitUntilExactlyOneExists(
            hasTestTag("artifact_image_transform") and hasContentDescription(fixture.readyAlt),
            8_000,
        )
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
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun browsesReplyImagesInReadingOrderAndReturnsToTheTappedOccurrence() {
        val fixture = InlineImageFixture(app.fixture)
        val ready = "/artifacts/${fixture.readyReference}"
        val second = "/artifacts/${fixture.earlierReference}"
        fixture.install(
            latest =
                """
                ![First chart]($ready)

                - ![List chart]($second)
                - [![Linked chart]($ready)](https://example.com/rollout)

                | Chart |
                | --- |
                | ![Table chart]($ready) |
            """
                    .trimIndent(),
            earlier = false,
        )
        openConversation()
        val first = hasContentDescription("First chart") and hasClickAction()
        compose.waitUntilExactlyOneExists(first, 8_000)
        compose.onNode(first).performClick()
        val pager = compose.onNodeWithTag("image_viewer_pager")
        fun page(n: Int, name: String) {
            compose.waitUntilExactlyOneExists(hasContentDescription("Image $n of 3"), 8_000)
            compose.waitUntilExactlyOneExists(
                hasTestTag("artifact_image_transform") and hasContentDescription(name),
                8_000,
            )
        }
        page(1, "First chart")
        pager.performTouchInput { swipeLeft() }
        page(2, "List chart")
        pager.performTouchInput { swipeLeft() }
        page(3, "Table chart")
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.waitUntilExactlyOneExists(first and isFocused(), 8_000)
    }

    @Test
    fun keepsTheThumbnailOnForegroundUntilTheServerRevokesAccess() {
        val fixture = InlineImageFixture(app.fixture)
        fixture.install(earlier = false)
        openConversation()
        val image = hasContentDescription(fixture.readyAlt)
        val loaded =
            image and
                hasClickAction() and
                SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription)
        compose.waitUntilExactlyOneExists(loaded, 8_000)
        val frame = compose.onNode(loaded).assertIsDisplayed().getUnclippedBoundsInRoot()
        val allowResponse = CountDownLatch(1)
        fixture.beforeReadyReference = { check(allowResponse.await(10, TimeUnit.SECONDS)) }

        try {
            resumeArtifactRoute()
            compose.waitUntil(5_000) { fixture.references.size >= 2 }
            assertEquals(
                frame,
                compose.onNode(loaded).assertIsDisplayed().getUnclippedBoundsInRoot(),
            )
            assertEquals(listOf(fixture.readyReference), fixture.thumbnails.toList())

            fixture.readyReferenceDenied = true
        } finally {
            allowResponse.countDown()
        }
        val unavailable =
            image and
                SemanticsMatcher.expectValue(
                    SemanticsProperties.StateDescription,
                    "Image unavailable",
                )
        compose.waitUntilExactlyOneExists(unavailable, 8_000)
        compose.onNode(unavailable).assert(!hasClickAction())
        assertEquals(frame, compose.onNode(unavailable).getUnclippedBoundsInRoot())
        assertEquals(listOf(fixture.readyReference), fixture.thumbnails.toList())
    }

    @Test
    fun refreshesTheAuthorizedFilenameWithoutDownloadingTheSameThumbnailAgain() {
        val fixture = InlineImageFixture(app.fixture)
        fixture.install(latest = "![](/artifacts/${fixture.readyReference})", earlier = false)
        openConversation()
        val ready =
            hasClickAction() and
                SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription)
        val initial = ready and hasContentDescription(fixture.filename)
        compose.waitUntilExactlyOneExists(initial, 8_000)
        val frame = compose.onNode(initial).assertIsDisplayed().getUnclippedBoundsInRoot()

        val updatedName = "verified-rollout.png"
        fixture.filename = updatedName
        resumeArtifactRoute()

        val validated = ready and hasContentDescription(updatedName)
        compose.waitUntilExactlyOneExists(validated, 8_000)
        assertEquals(
            frame,
            compose.onNode(validated).assertIsDisplayed().getUnclippedBoundsInRoot(),
        )
        assertEquals(
            listOf(fixture.readyReference, fixture.readyReference),
            fixture.references.toList(),
        )
        assertEquals(listOf(fixture.readyReference), fixture.thumbnails.toList())
        assertTrue(fixture.originals.isEmpty())
    }

    @Test
    fun rechecksOriginalAccessOnForegroundWhenTheThumbnailIsMissing() {
        val fixture = InlineImageFixture(app.fixture)
        fixture.missingThumbnail = true
        fixture.install(latest = "![](/artifacts/${fixture.readyReference})", earlier = false)
        openConversation()
        val missingThumbnail =
            hasContentDescription(fixture.filename) and
                hasClickAction() and
                SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "No thumbnail")
        compose.waitUntilExactlyOneExists(missingThumbnail, 8_000)
        val frame = compose.onNode(missingThumbnail).assertIsDisplayed().getUnclippedBoundsInRoot()

        fixture.readyReferenceDenied = true
        resumeArtifactRoute()

        val unavailable =
            hasContentDescription("Image") and
                SemanticsMatcher.expectValue(
                    SemanticsProperties.StateDescription,
                    "Image unavailable",
                )
        compose.waitUntilExactlyOneExists(unavailable, 5_000)
        compose.onNodeWithContentDescription(fixture.filename).assertDoesNotExist()
        compose.onNode(unavailable).assert(!hasClickAction())
        assertEquals(frame, compose.onNode(unavailable).getUnclippedBoundsInRoot())
        assertEquals(
            listOf(fixture.readyReference, fixture.readyReference),
            fixture.references.toList(),
        )
        assertTrue(fixture.thumbnails.isEmpty())
        assertTrue(fixture.originals.isEmpty())
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
        awaitText("Image unavailable")
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
    fun withdrawsAnExternalImageWhenItsUrlNoLongerAllowsReading() {
        val fixture = InlineImageFixture(app.fixture)
        val filename = "external-evidence.png"
        val url = app.fixture.server.url("/inline-thumbnail/$filename")
        fixture.install(latest = "![](<$url>)", earlier = false)
        openConversation()
        val loaded =
            hasContentDescription(filename) and
                hasClickAction() and
                SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription)
        compose.waitUntil(8_000) { compose.onAllNodes(loaded).fetchSemanticsNodes().isNotEmpty() }
        val frame = compose.onNode(loaded).getUnclippedBoundsInRoot()

        fixture.deniedExternalFilename = filename
        compose.onNode(loaded).performClick()
        awaitText("Image unavailable")
        compose.onNodeWithTag("artifact_preview_title").assertDoesNotExist()
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }

        val unavailable =
            hasContentDescription("Image") and
                SemanticsMatcher.expectValue(
                    SemanticsProperties.StateDescription,
                    "Image unavailable",
                )
        compose.waitUntil(8_000) {
            compose.onAllNodes(unavailable).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNode(unavailable).assert(!hasClickAction())
        assertEquals(frame, compose.onNode(unavailable).getUnclippedBoundsInRoot())
        assertEquals(listOf(filename, filename), fixture.thumbnails.toList())

        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Find messages").performClick()
        compose.onNodeWithTag("conversation_find_query").performTextReplacement(filename)
        awaitText("No matching messages")
    }

    @Test
    fun aDeniedExternalThumbnailClearsOtherSizesOfTheSameImage() {
        val fixture = InlineImageFixture(app.fixture)
        val filename = "shared-evidence.png"
        val url = app.fixture.server.url("/inline-thumbnail/$filename")
        fixture.install(
            latest = "![Full-width evidence](<$url>)",
            earlierText =
                "| Evidence | A | B | C | D |\n| --- | --- | --- | --- | --- |\n" +
                    "| ![Table evidence](<$url>) | a | b | c | d |",
        )
        openConversation()
        val full = hasContentDescription("Full-width evidence")
        compose.waitUntil(8_000) {
            compose.onAllNodes(full and hasClickAction()).fetchSemanticsNodes().isNotEmpty()
        }
        val fullWidth = compose.onNode(full).getUnclippedBoundsInRoot().width
        assertEquals(listOf(filename), fixture.thumbnails.toList())

        fixture.deniedExternalFilename = filename
        compose.onNodeWithTag("conversation_reply_summary").performClick()
        val table = hasContentDescription("Table evidence")
        compose.waitUntil(8_000) { compose.onAllNodes(table).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(table).performScrollTo()
        assertTrue(compose.onNode(table).getUnclippedBoundsInRoot().width < fullWidth)
        val unavailable =
            SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Image unavailable")
        compose.waitUntil(8_000) {
            compose.onAllNodes(table and unavailable).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNode(full).assert(unavailable and !hasClickAction())
        assertEquals(listOf(filename, filename), fixture.thumbnails.toList())
    }

    @Test
    fun restoresAnExternalPreviewAcrossRecreationWithoutSavingTheUrlInActivityState() {
        val fixture = InlineImageFixture(app.fixture)
        val filename = "external-preview.png"
        val url =
            app.fixture.server
                .url("/inline-thumbnail/$filename")
                .newBuilder()
                .addQueryParameter("test-signature", "a".repeat(26_000))
                .build()
        fixture.install(latest = "![](<$url>)", earlier = false)
        openConversation()
        val loaded =
            hasContentDescription(filename) and
                hasClickAction() and
                SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription)
        compose.waitUntil(8_000) { compose.onAllNodes(loaded).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(loaded).performClick()
        val viewerImage = hasTestTag("artifact_image_transform") and hasContentDescription(filename)
        compose.waitUntilExactlyOneExists(viewerImage, 8_000)
        compose.waitUntil(8_000) { fixture.thumbnails.size >= 2 }

        compose.activityRule.scenario.recreate()
        compose.waitUntilExactlyOneExists(viewerImage, 8_000)
        compose.onNodeWithTag("artifact_preview").assertIsDisplayed()
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.waitUntil(8_000) {
            compose.onAllNodes(loaded and isFocused()).fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    fun findsAHiddenTimelineImageWithoutLoadingItUntilTheResultIsOpened() {
        val fixture = InlineImageFixture(app.fixture)
        fixture.install()
        openConversation()
        awaitText("The release is ready for review.")
        val latestImage =
            hasContentDescription(fixture.readyAlt) and
                SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription)
        compose.waitUntil(8_000) {
            compose.onAllNodes(latestImage).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNode(latestImage).assertIsDisplayed()
        assertTrue(fixture.earlierReference !in fixture.references)

        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Find messages").performClick()
        compose.onNodeWithTag("conversation_find_query").performTextReplacement("Staging baseline")
        awaitText("1 matching message")
        assertTrue(fixture.earlierReference !in fixture.references)
        compose
            .onNode(hasText(fixture.earlierAlt, substring = true) and hasClickAction())
            .assertIsDisplayed()
            .performSemanticsAction(SemanticsActions.OnClick)
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
