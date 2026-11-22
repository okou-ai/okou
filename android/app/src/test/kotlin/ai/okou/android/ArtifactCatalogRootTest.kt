package ai.okou.android

import ai.okou.android.artifacts.ArtifactSaveResult
import ai.okou.android.auth.SessionModel
import android.app.Activity
import android.content.Intent
import android.os.Looper
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import org.junit.After
import org.junit.Assert.assertEquals
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
