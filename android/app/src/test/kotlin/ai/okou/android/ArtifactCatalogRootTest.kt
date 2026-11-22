package ai.okou.android

import ai.okou.android.artifacts.ArtifactSaveResult
import ai.okou.android.auth.SessionModel
import android.app.Activity
import android.content.Intent
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.core.view.children
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = ChatListApplication::class)
class ArtifactCatalogRootTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val app
        get() = compose.activity.application as ChatListApplication

    private val artifactModel
        get() =
            checkNotNull(
                    ViewModelProvider(compose.activity)[SessionModel::class.java]
                        .uiState
                        .value
                        .ready
                )
                .artifacts

    @Test
    fun firstDisplayAndSourceReturnUseTheNativeCatalogAndReferenceAuthority() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val firstPage = CountDownLatch(1)
        fixture.beforeCatalog = { firstPage.await() }
        app.responseGate.countDown()
        try {
            awaitText(fixture.sourceTitle)
            assertTrue(fixture.catalogQueries.isEmpty())
            compose.onNodeWithContentDescription("Artifacts").performClick()
            compose.onNodeWithTag("artifact_catalog").assertIsDisplayed()
            compose.onNodeWithContentDescription("Search artifacts").assertIsDisplayed()
            compose.onNodeWithText(fixture.summary.title).assertDoesNotExist()
        } finally {
            firstPage.countDown()
        }
        awaitText(fixture.summary.title)
        compose.onNodeWithText("Today").assertIsDisplayed()
        compose.onNodeWithText("Yesterday").assertIsDisplayed()
        compose.onNodeWithText("Earlier").assertIsDisplayed()
        compose.onNodeWithText(fixture.summary.title).assertHeightIsAtLeast(80.dp)
        compose.onNodeWithTag("artifact_query").performTextReplacement("Product launch")
        awaitText(fixture.summary.title)
        compose.onNodeWithText("Yesterday").assertDoesNotExist()
        compose.onNodeWithText(fixture.summary.title).performClick()
        awaitText("Preview only", partial = true)
        compose.onNodeWithText("Save file").assertDoesNotExist()
        compose
            .onNodeWithText("View source conversation")
            .assertHeightIsAtLeast(48.dp)
            .performClick()
        compose.onNodeWithTag("conversation").assertIsDisplayed()
        compose.onNodeWithContentDescription("Back to artifact preview").performClick()
        awaitText("View source conversation")
        compose.onNodeWithContentDescription("Back to artifacts").performClick()
        awaitText(fixture.summary.title)
        compose.onNodeWithText(fixture.checklist.title).assertDoesNotExist()
        assertTrue(fixture.catalogQueries.contains(null to "Product launch"))
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun openingTheSourceConversationLeavesFindAndBackRestoresThePreview() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithText(fixture.sourceTitle).performClick()
        awaitText("Native history reply")
        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Find messages").performClick()
        val find = compose.onNodeWithTag("conversation_find")
        find.assertIsDisplayed()

        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.summary.title)
        compose.onNodeWithText(fixture.summary.title).performClick()
        awaitText("View source conversation")
        compose.onNodeWithText("View source conversation").performClick()

        find.assertDoesNotExist()
        compose.onNodeWithText("Native history reply").assertIsDisplayed()
        compose.onNodeWithContentDescription("Back to artifact preview").performClick()
        awaitText("View source conversation")
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun returningFromTheWorkspaceCatalogKeepsFindWithoutReplayingItsFocusRequests() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithText(fixture.sourceTitle).performClick()
        awaitText("Native history reply")
        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Find messages").performClick()
        val query = compose.onNodeWithTag("conversation_find_query")
        query.assertIsFocused().performTextReplacement("Native history")
        awaitText("1 matching message")

        val artifacts = compose.onNodeWithContentDescription("Artifacts")
        val backToWorkspace = compose.onNodeWithContentDescription("Back to workspace")
        artifacts.performClick()
        backToWorkspace.performClick()
        query.assertTextContains("Native history").assertIsNotFocused()
        awaitText("1 matching message")

        val result = compose.onNodeWithText("Native history reply")
        result.performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("conversation_find_hit"), 10_000)
        compose.onNodeWithContentDescription("Back").performClick()
        awaitText("1 matching message")
        result.assertIsFocused()

        artifacts.performClick()
        backToWorkspace.performClick()
        query.assertTextContains("Native history").assertIsNotFocused()
        awaitText("1 matching message")
        result.assertIsNotFocused()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun wideFiltersKeepThePreviewAndDownloadRechecksTheGrant() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.pageSize = 2
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.image.title)
        assertTrue(fixture.catalogQueries.size >= 3)
        compose.onNodeWithText(fixture.checklist.title).performClick()
        awaitText("Save file")
        compose.onNodeWithText("Images").performClick()
        compose.waitUntil(10_000) { fixture.catalogQueries.contains("image" to null) }
        compose.onNodeWithTag("artifact_preview_title").assertIsDisplayed()
        compose.onNodeWithText("Save file").assertIsDisplayed()
        val model = artifactModel
        fun awaitSaveResult(result: ArtifactSaveResult) {
            val expected = fixture.checklist.id to result
            compose.waitUntil(10_000) {
                // Deliver the network result before asking Compose to synchronize the UI.
                shadowOf(Looper.getMainLooper()).idle()
                model.state.value.saveResult == expected
            }
        }

        val saved = ByteArrayOutputStream()
        compose.runOnIdle { model.save(fixture.checklist.id) { saved } }
        awaitSaveResult(ArtifactSaveResult.Saved)
        compose.onNodeWithText("File saved").assertIsDisplayed()
        assertEquals(fixture.checklistBody, saved.toString(Charsets.UTF_8.name()))
        fixture.downloadGranted = false
        compose.runOnIdle {
            model.save(fixture.checklist.id) { error("Denied save opened the destination") }
        }
        awaitSaveResult(ArtifactSaveResult.Denied)
        compose.onNodeWithText("Download access is unavailable").assertIsDisplayed()
        compose.onNodeWithText("Save file").assertDoesNotExist()
        assertEquals(2, fixture.requestedDownloads.size)
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun saveStaysDisabledAfterSelectingAnotherArtifactDuringDownload() {
        val fixture = ArtifactApiFixture(app.fixture, summaryDownloadAllowed = true)
        val finishDownload = CountDownLatch(1)
        fixture.beforeDownload = { finishDownload.await() }
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.checklist.title)
        compose.onNodeWithText(fixture.checklist.title).performClick()
        awaitText("Save file")

        val saved = ByteArrayOutputStream()
        val model = artifactModel
        try {
            compose.runOnIdle { model.save(fixture.checklist.id) { saved } }
            compose.waitUntil(10_000) { fixture.requestedDownloads.isNotEmpty() }

            compose.onNodeWithText(fixture.summary.title).performClick()
            awaitText("Save file")
            compose.onNodeWithText("Save file").assertIsNotEnabled()
        } finally {
            finishDownload.countDown()
        }
        compose.waitUntil(10_000) {
            compose
                .onAllNodes(hasText("Save file") and isEnabled())
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        assertEquals(fixture.checklistBody, saved.toString(Charsets.UTF_8.name()))
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun unreadableImageShowsAnUnsupportedPreview() {
        val fixture =
            ArtifactApiFixture(app.fixture, imageBody = "Invalid raster".encodeToByteArray())
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.image.title)
        compose.onNodeWithText(fixture.image.title).performClick()
        awaitText("No preview is available for this file")
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun cachedDocumentAndImagePreviewsStayReadableOffline() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        val backToCatalog = compose.onNodeWithContentDescription("Back to artifacts")

        awaitText(fixture.summary.title)
        compose.onNodeWithText(fixture.summary.title).performClick()
        val documentText = "Positioning: help teams move ongoing work forward"
        awaitText(documentText, partial = true)
        backToCatalog.performClick()

        awaitText(fixture.image.title)
        compose.onNodeWithText(fixture.image.title).performClick()
        compose.waitUntilExactlyOneExists(hasContentDescription(fixture.image.title), 10_000)
        compose.runOnIdle { app.connectivity.value = false }
        compose.onNodeWithContentDescription(fixture.image.title).assertIsDisplayed()
        backToCatalog.performClick()
        awaitText("Showing saved results offline")
        compose.onNodeWithText(fixture.summary.title).performClick()
        compose.onNodeWithText(documentText, substring = true).assertIsDisplayed()
    }

    @Test
    fun websiteReconnectKeepsItsFrameAndSourceWhileWaitingForFreshAccess() {
        val releaseGrant = CountDownLatch(1)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            val fixture = ArtifactApiFixture(app.fixture)
            fixture.install()
            app.responseGate.countDown()
            awaitText(fixture.sourceTitle)
            compose.onNodeWithContentDescription("Artifacts").performClick()
            awaitText(fixture.site.title)
            compose.onNodeWithText(fixture.site.title).performClick()
            awaitText("View source conversation")
            compose.waitUntil(10_000) {
                val grant = fixture.requestedSiteGrants.firstOrNull()
                grant != null && loadedWebsiteUrl() == grant
            }

            val title = compose.onNodeWithTag("artifact_preview_title")
            val source = compose.onNodeWithText("View source conversation")
            val surface = compose.onNodeWithTag("artifact_preview_surface")
            val titleBounds = title.getUnclippedBoundsInRoot()
            val sourceBounds = source.getUnclippedBoundsInRoot()
            val surfaceBounds = surface.getUnclippedBoundsInRoot()
            val surfaceWidth = surfaceBounds.right - surfaceBounds.left
            val surfaceHeight = surfaceBounds.bottom - surfaceBounds.top
            assertEquals(surfaceWidth.value * 9f / 16f, surfaceHeight.value, 1f)

            compose.runOnIdle { app.connectivity.value = false }
            awaitText("Connect to load the preview")
            compose.onNodeWithText("Open in browser").assertDoesNotExist()
            assertEquals(surfaceBounds, surface.getUnclippedBoundsInRoot())
            assertEquals(sourceBounds, source.getUnclippedBoundsInRoot())
            assertNull(loadedWebsiteUrl())
            source.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            source.assertIsFocused()

            fixture.beforeSitePreview = { releaseGrant.await() }
            compose.runOnIdle { app.connectivity.value = true }
            compose.waitUntil(10_000) {
                // Let the detail response reach the main owner before the grant request begins.
                shadowOf(Looper.getMainLooper()).idle()
                fixture.requestedSiteGrants.size == 2
            }
            compose.waitUntilExactlyOneExists(hasTestTag("artifact_preview_loading"), 10_000)
            assertNull(loadedWebsiteUrl())
            assertEquals(surfaceBounds, surface.getUnclippedBoundsInRoot())
            assertEquals(sourceBounds, source.assertIsFocused().getUnclippedBoundsInRoot())

            releaseGrant.countDown()
            compose.waitUntil(10_000) { loadedWebsiteUrl() == fixture.requestedSiteGrants.last() }
            assertEquals(surfaceBounds, surface.getUnclippedBoundsInRoot())
            assertEquals(titleBounds, title.getUnclippedBoundsInRoot())
            assertEquals(sourceBounds, source.assertIsFocused().getUnclippedBoundsInRoot())
            compose.onNodeWithText("Open in browser").assertIsEnabled()
        } finally {
            releaseGrant.countDown()
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    fun chatResourcesPagesItsOwnCatalogAndReturnsThroughTheSharedPreview() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.pageSize = 2
        fixture.install()
        val firstPage = CountDownLatch(1)
        fixture.beforeCatalog = { firstPage.await() }
        app.responseGate.countDown()
        try {
            awaitText(fixture.sourceTitle)
            compose.onNodeWithText(fixture.sourceTitle).performClick()
            assertTrue(fixture.catalogScopes.isEmpty())
            compose.onNodeWithContentDescription("Chat actions").performClick()
            compose.onNodeWithText("Chat resources").performClick()
            compose.onNodeWithTag("chat_artifact_resources").assertIsDisplayed()
            compose.onNodeWithText(fixture.checklist.title).assertDoesNotExist()
        } finally {
            firstPage.countDown()
        }
        awaitText(fixture.slides.title)
        assertTrue(fixture.catalogScopes.contains(CHAT_PERSONAL to null))
        assertTrue(fixture.catalogScopes.contains(CHAT_PERSONAL to "2"))
        assertTrue(fixture.catalogScopes.all { it.first == CHAT_PERSONAL })
        compose.onNodeWithText(fixture.image.title).assertDoesNotExist()
        compose.onNodeWithText(fixture.summary.title).assertHeightIsAtLeast(72.dp).performClick()
        awaitText("Preview only", partial = true)
        compose.onNodeWithText("Save file").assertDoesNotExist()
        compose.onNodeWithContentDescription("Back to chat resources").performClick()
        compose.onNodeWithTag("chat_artifact_resources").assertIsDisplayed()
        awaitText(fixture.slides.title)
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("conversation").assertIsDisplayed()

        val onlinePages = fixture.catalogScopes.size
        compose.runOnIdle { app.connectivity.value = false }
        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Chat resources").performClick()
        awaitText("Showing saved results offline")
        compose.onNodeWithText(fixture.slides.title).assertIsDisplayed()
        assertEquals(onlinePages, fixture.catalogScopes.size)

        compose.runOnIdle { app.connectivity.value = true }
        compose.waitUntil(10_000) { fixture.catalogScopes.size > onlinePages }
        compose.onNodeWithText(fixture.slides.title).assertIsDisplayed()
    }

    @Test
    fun conversationCardOpensAnAuthorizedPreviewWithoutReadingTheCatalog() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        fixture.installInlineHistory()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithText(fixture.sourceTitle).performClick()
        awaitText(fixture.summary.title)
        assertTrue(fixture.requestedReferences.isEmpty())
        compose.onNodeWithText(fixture.summary.title).assertHeightIsAtLeast(60.dp).performClick()
        awaitText("Preview only", partial = true)
        compose.onNodeWithText("Save file").assertDoesNotExist()
        assertEquals(1, fixture.requestedReferences.size)
        assertTrue(fixture.catalogScopes.isEmpty())
        compose.onNodeWithContentDescription("Back").performClick()
        awaitText(fixture.summary.title)
        compose.onNodeWithText(fixture.summary.title).assertIsFocused()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun inlineArtifactPreviewReturnsToTheFindHit() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        fixture.installInlineHistory()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithText(fixture.sourceTitle).performClick()
        awaitText(fixture.summary.title)

        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Find messages").performClick()
        val query = compose.onNodeWithTag("conversation_find_query")
        query.performTextReplacement("artifacts2.md")
        awaitText("No matching messages")
        query.performTextReplacement("launch summary")
        awaitText("1 matching message")
        val cardLabel = hasText(fixture.summary.title) and hasClickAction()
        compose.onNode(cardLabel).performClick()
        val hit = hasTestTag("conversation_find_hit") and isFocused()
        compose.waitUntil(10_000) { compose.onAllNodes(hit).fetchSemanticsNodes().isNotEmpty() }
        val card = compose.onNode(cardLabel)
        card.assertIsDisplayed().performClick()

        awaitText("Preview only", partial = true)
        compose.onNodeWithTag("chat_list").assertIsDisplayed()
        compose.onNodeWithTag("conversation").assertDoesNotExist()
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.waitUntil(10_000) {
            compose.onAllNodes(cardLabel and isFocused()).fetchSemanticsNodes().isNotEmpty()
        }
        card.assertIsDisplayed().assertIsFocused()

        compose.onNodeWithContentDescription("Back").performClick()
        query.assertTextContains("launch summary")
        awaitText("1 matching message")
        assertTrue(fixture.catalogScopes.isEmpty())
    }

    @Test
    fun chatResourcesReturnsToTheReadingPositionAndFindQuery() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val target = "Find the launch checklist"
        val earlier = "Earlier reading marker 4"
        val history = app.fixture
        history.historyCatchUp = { jsonResponse("""{"events":{},"notFoundThreads":[]}""") }
        history.historyRows = { request ->
            val url = checkNotNull(request.requestUrl)
            val after = url.queryParameter("sinceSeqId")?.toLong() ?: 0
            val rows =
                (1L..20L)
                    .filter { it > after }
                    .joinToString(",") { seq ->
                        val id =
                            if (seq == 20L) HISTORY_LAST_EVENT
                            else "aaaaaaaa-aaaa-4aaa-8aaa-${seq.toString().padStart(12, '0')}"
                        val text = if (seq == 20L) target else "Earlier reading marker $seq"
                        historyEventWire(
                            id,
                            seq,
                            url.pathSegments[2],
                            payload = """{"content":"$text"}""",
                            run = null,
                        )
                    }
            jsonResponse(
                """{"rows":[$rows],"cursor":{"lastEventId":"$HISTORY_LAST_EVENT","lastSeqId":20},"hasMore":false}"""
            )
        }
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithText(fixture.sourceTitle).performClick()
        awaitText(target)
        val actions = compose.onNodeWithContentDescription("Chat actions")
        actions.performClick()
        val find = compose.onNodeWithText("Find messages")
        val resources = compose.onNodeWithText("Chat resources")
        assertTrue(find.getUnclippedBoundsInRoot().top < resources.getUnclippedBoundsInRoot().top)
        find.performClick()
        val query = compose.onNodeWithTag("conversation_find_query")
        query.performTextReplacement("launch checklist")
        awaitText("1 matching message")
        compose.onNodeWithText(target).performClick()
        val focusedHit = hasTestTag("conversation_find_hit") and isFocused()
        compose.waitUntil(10_000) {
            compose.onAllNodes(focusedHit).fetchSemanticsNodes().isNotEmpty()
        }

        compose.onNodeWithTag("conversation").performScrollToNode(hasText(earlier))
        val marker = compose.onNodeWithText(earlier)
        val readingTop = marker.assertIsDisplayed().getUnclippedBoundsInRoot().top
        val jump = hasTestTag("conversation_jump")
        compose.waitUntil(10_000) { compose.onAllNodes(jump).fetchSemanticsNodes().isNotEmpty() }

        actions.performClick()
        resources.performClick()
        compose.onNodeWithTag("chat_artifact_resources").assertIsDisplayed()
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithTag("chat_artifact_resources").assertDoesNotExist()
        compose.waitUntil(10_000) {
            compose.onAllNodes(jump or focusedHit).fetchSemanticsNodes().isNotEmpty()
        }
        assertEquals(readingTop, marker.assertIsDisplayed().getUnclippedBoundsInRoot().top)

        compose.onNodeWithContentDescription("Back").performClick()
        query.assertTextContains("launch checklist")
        awaitText("1 matching message")
    }

    @Test
    fun workspaceCatalogHandlesPickerCancellationAfterLeavingThePreview() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()

        cancelSaveAfterLeavingPreview(fixture.checklist.title, "Back to artifacts")
        assertTrue(fixture.requestedDownloads.isEmpty())
    }

    @Test
    fun chatResourcesHandlesPickerCancellationAfterLeavingThePreview() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithText(fixture.sourceTitle).performClick()
        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Chat resources").performClick()

        cancelSaveAfterLeavingPreview(fixture.checklist.title, "Back to chat resources")
        assertTrue(fixture.requestedDownloads.isEmpty())
    }

    @After
    fun close() {
        app.responseGate.countDown()
        compose.runOnIdle { compose.activity.viewModelStore.clear() }
        app.fixture.close()
        app.cacheSnapshot.restore()
    }

    private fun loadedWebsiteUrl(): String? =
        compose.runOnIdle {
            compose.activity.window.decorView.website()?.let { shadowOf(it).lastLoadedUrl }
        }

    private fun View.website(): WebView? =
        when (this) {
            is WebView -> this
            is ViewGroup -> children.firstNotNullOfOrNull { it.website() }
            else -> null
        }

    private fun awaitText(value: String, partial: Boolean = false) {
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithText(value, substring = partial)
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
    }

    private fun cancelSaveAfterLeavingPreview(title: String, backDescription: String) {
        awaitText(title)
        compose.onNodeWithText(title).performClick()
        awaitText("Save file")
        compose.onNodeWithText("Save file").performClick()
        val launch = checkNotNull(shadowOf(compose.activity).nextStartedActivityForResult)
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, launch.intent.action)
        compose.onNodeWithText("Save file").assertIsNotEnabled()

        compose.onNodeWithContentDescription(backDescription).performClick()
        compose.onNodeWithTag("artifact_preview").assertDoesNotExist()
        compose.activityRule.scenario.onActivity {
            assertTrue(
                it.activityResultRegistry.dispatchResult(
                    launch.requestCode,
                    Activity.RESULT_CANCELED,
                    null,
                )
            )
        }
        compose.onNodeWithText(title).performClick()
        awaitText("Save file")
        compose.onNodeWithText("Save file").assertIsEnabled()
    }
}
