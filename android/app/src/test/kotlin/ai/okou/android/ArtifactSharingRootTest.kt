package ai.okou.android

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.unit.dp
import androidx.core.content.IntentCompat
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = ChatListApplication::class)
internal class ArtifactSharingRootTest : ArtifactCatalogRootTestFixture() {
    @Before
    fun initializeShareProvider() {
        compose.runOnIdle {
            val activity = compose.activity
            // Resolve the manifest provider for this test's application and cache directory.
            checkNotNull(
                    activity.contentResolver.acquireContentProviderClient(
                        "${activity.packageName}.artifact-shares",
                    ),
                )
                .close()
        }
    }

    @Test
    fun authorizedFileSharesOriginalBytesWithAReadOnlyGrant() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        openFile(fixture.checklist.title)
        awaitText("Share file")
        compose.onNodeWithText("Share file").performClick()

        var launched: Intent? = null
        compose.waitUntil(10_000) {
            launched = shadowOf(compose.activity).nextStartedActivity
            launched != null
        }
        val chooser = checkNotNull(launched)
        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        val send =
            checkNotNull(
                IntentCompat.getParcelableExtra(chooser, Intent.EXTRA_INTENT, Intent::class.java),
            )
        assertEquals(Intent.ACTION_SEND, send.action)
        assertEquals("text/markdown", send.type)
        assertEquals(
            Intent.FLAG_GRANT_READ_URI_PERMISSION,
            send.flags and
                (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION),
        )
        val uri =
            checkNotNull(
                IntentCompat.getParcelableExtra(send, Intent.EXTRA_STREAM, Uri::class.java),
            )
        assertEquals("content", uri.scheme)
        assertEquals("${compose.activity.packageName}.artifact-shares", uri.authority)
        assertEquals(uri, send.clipData?.getItemAt(0)?.uri)
        assertEquals("checklist.md", send.clipData?.description?.label)
        assertEquals(
            fixture.checklistBody,
            compose.activity.contentResolver.openInputStream(uri)?.bufferedReader()?.use {
                it.readText()
            },
        )
        assertEquals(
            listOf("/api/artifact-references/checklist1.md/download"),
            fixture.requestedDownloads,
        )
    }

    @Test
    fun deniedShareRemovesOriginalActionsAndKeepsPreview() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val prior = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (
                request.requestUrl?.encodedPath == "/api/artifact-references/checklist1.md/download"
            )
                MockResponse().setResponseCode(403)
            else prior(request)
        }
        openFile(fixture.checklist.title)
        awaitText("Share file")
        compose.onNodeWithText("Share file").performClick()
        awaitText("Unable to share this file")
        val pane = compose.onNodeWithTag("artifact_preview").getUnclippedBoundsInRoot()
        val feedback = compose.onNodeWithTag("artifact_action_feedback").getUnclippedBoundsInRoot()
        assertEquals(12.dp, feedback.left - pane.left)
        assertEquals(12.dp, pane.right - feedback.right)
        assertEquals(8.dp, pane.bottom - feedback.bottom)
        compose.onNodeWithText("Share file").assertDoesNotExist()
        compose.onNodeWithText("Save file").assertDoesNotExist()
        awaitText(fixture.checklist.title)
        assertNull(shadowOf(compose.activity).nextStartedActivity)
    }

    @Test
    fun leavingWhilePreparingDropsTheUnsharedCopy() {
        val fixture = ArtifactApiFixture(app.fixture)
        val release = CountDownLatch(1)
        fixture.beforeDownload = { check(release.await(10, TimeUnit.SECONDS)) }
        fixture.install()
        openFile(fixture.checklist.title)
        awaitText("Share file")
        val cache = File(compose.activity.cacheDir, "artifact-shares")
        val prior = cache.list()?.toSet().orEmpty()
        try {
            compose.onNodeWithText("Share file").assertIsEnabled().performClick()
            awaitText("Preparing to share…")
            compose.waitUntil(10_000) { fixture.requestedDownloads.isNotEmpty() }
            assertNotNull(cache.list()?.firstOrNull { it !in prior })
            compose.onNodeWithContentDescription("Back to artifacts").performClick()
        } finally {
            release.countDown()
        }
        compose.waitUntil(10_000) { cache.list()?.toSet().orEmpty() == prior }
        assertNull(shadowOf(compose.activity).nextStartedActivity)
    }

    @Test
    fun openingSourceCancelsSharingBeforeThePreviewIsDisposed() {
        val fixture = ArtifactApiFixture(app.fixture, summaryDownloadAllowed = true)
        fixture.install()
        val requested = CountDownLatch(1)
        val release = CountDownLatch(1)
        val priorResponse = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (
                request.requestUrl?.encodedPath == "/api/artifact-references/artifacts2.md/download"
            ) {
                requested.countDown()
                check(release.await(10, TimeUnit.SECONDS))
                val url = app.fixture.server.url("/artifact-bytes/summary")
                jsonResponse(
                    """{"kind":"file","filename":"summary.md","contentType":"text/markdown","url":"$url"}""",
                )
            } else priorResponse(request)
        }
        openFile(fixture.summary.title)
        awaitText("View source conversation")
        awaitText("Share file")
        val activity = compose.activity
        val cache = File(activity.cacheDir, "artifact-shares")
        val priorCopies = cache.list()?.toSet().orEmpty()
        try {
            compose.onNodeWithText("Share file").performClick()
            compose.waitUntil(10_000) { requested.count == 0L }
            // Run the source action while the clock holds the old preview in composition.
            compose.mainClock.autoAdvance = false
            compose
                .onNodeWithText("View source conversation")
                .performSemanticsAction(SemanticsActions.OnClick)
            release.countDown()
            var launched: Intent? = null
            compose.waitUntil(10_000) {
                compose.runOnUiThread { compose.mainClock.scheduler.runCurrent() }
                launched = shadowOf(activity).nextStartedActivity
                launched != null || cache.list()?.toSet().orEmpty() == priorCopies
            }
            assertNull(launched)
        } finally {
            release.countDown()
            compose.mainClock.autoAdvance = true
        }
        compose.onNodeWithTag("conversation").assertIsDisplayed()
        compose.onNodeWithContentDescription("Back to artifact preview").performClick()
        awaitText(fixture.summary.title)
    }

    @Test
    fun sharesSentChatFileAndReturnsToItsMessage() {
        val fixture = ChatFilePreviewFixture(app.fixture)
        openChatFile(fixture)
        compose.onNodeWithText("Save file").assertIsDisplayed()
        val previewRequests = fixture.requests.size
        compose.onNodeWithText("Share file").performClick()

        var chooser: Intent? = null
        compose.waitUntil(10_000) {
            chooser = shadowOf(compose.activity).nextStartedActivity
            chooser != null ||
                compose
                    .onAllNodesWithText("Unable to", substring = true)
                    .fetchSemanticsNodes()
                    .isNotEmpty()
        }
        assertEquals(
            listOf("/api/web/file-url", "/chat-file/download"),
            fixture.requests.drop(previewRequests),
        )
        assertNotNull("The original share did not launch the chooser", chooser)
        assertEquals(Intent.ACTION_CHOOSER, chooser?.action)
        val send =
            checkNotNull(
                IntentCompat.getParcelableExtra(
                    checkNotNull(chooser),
                    Intent.EXTRA_INTENT,
                    Intent::class.java,
                ),
            )
        assertEquals(Intent.ACTION_SEND, send.action)
        assertEquals("text/plain", send.type)
        assertEquals(
            Intent.FLAG_GRANT_READ_URI_PERMISSION,
            send.flags and
                (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION),
        )
        val uri =
            checkNotNull(
                IntentCompat.getParcelableExtra(send, Intent.EXTRA_STREAM, Uri::class.java),
            )
        assertEquals("content", uri.scheme)
        assertEquals(uri, send.clipData?.getItemAt(0)?.uri)
        assertEquals(fixture.filename, send.clipData?.description?.label)
        assertEquals(
            fixture.original,
            compose.activity.contentResolver.openInputStream(uri)?.bufferedReader()?.use {
                it.readText()
            },
        )

        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        awaitText(fixture.prompt)
        compose.onNodeWithTag("chat-message-attachments").assertIsDisplayed()
    }

    @Test
    fun revokedSentChatFileShareKeepsPreviewAndWithdrawsOriginalActions() {
        val fixture = ChatFilePreviewFixture(app.fixture)
        openChatFile(fixture)
        fixture.denied = true
        compose.onNodeWithText("Share file").performClick()
        awaitText("Unable to share this file")
        compose.onNodeWithText("Share file").assertDoesNotExist()
        compose.onNodeWithText("Save file").assertDoesNotExist()
        compose.onNodeWithText(fixture.preview).assertIsDisplayed()
        assertNull(shadowOf(compose.activity).nextStartedActivity)
    }

    private fun openChatFile(fixture: ChatFilePreviewFixture) {
        fixture.install()
        app.responseGate.countDown()
        awaitText("Personal chat")
        compose.onNodeWithText("Personal chat").performClick()
        awaitText(fixture.filename)
        compose.onNodeWithText(fixture.filename).performClick()
        awaitText(fixture.preview)
        awaitText("Share file")
    }

    private fun openFile(title: String) {
        app.responseGate.countDown()
        compose.onNodeWithContentDescription("Artifacts").let { button ->
            compose.waitUntilExactlyOneExists(
                androidx.compose.ui.test.hasContentDescription("Artifacts"),
                10_000,
            )
            button.performClick()
        }
        awaitText(title)
        compose.onNodeWithText(title).performClick()
    }
}
