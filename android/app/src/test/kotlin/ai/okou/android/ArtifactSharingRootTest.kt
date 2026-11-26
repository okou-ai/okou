package ai.okou.android

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.core.content.IntentCompat
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = ChatListApplication::class)
internal class ArtifactSharingRootTest : ArtifactCatalogRootTestFixture() {
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
