package ai.okou.android

import android.content.ClipboardManager
import android.content.Intent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.core.content.IntentCompat
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = ChatListApplication::class)
internal class ArtifactLinkRootTest : ArtifactCatalogRootTestFixture() {
    @Test
    fun previewOnlyImageCopiesTheOwnerLinkWhileAnotherArtifactsPolicyIsPending() {
        val fixture = ArtifactApiFixture(app.fixture, imageDownloadAllowed = false)
        fixture.install()
        val previous = app.fixture.commandResponse
        val reads = CopyOnWriteArrayList<String>()
        val releaseChecklist = CountDownLatch(1)
        app.fixture.commandResponse = { request ->
            val path = request.path.orEmpty()
            val match = Regex("^/api/artifacts/([^/]+)/visibility$").matchEntire(path)
            if (match != null) {
                assertEquals("GET", request.method)
                val id = match.groupValues[1]
                reads += id
                if (id == fixture.checklist.id) check(releaseChecklist.await(15, TimeUnit.SECONDS))
                policy(id)
            } else previous(request)
        }

        openArtifact(fixture, fixture.checklist.title)
        awaitText("Save file")
        assertEquals(emptyList<String>(), reads)
        try {
            compose.onNodeWithContentDescription("More actions").performClick()
            compose.waitUntil(5_000) { reads.isNotEmpty() }
            compose.onNodeWithTag("workspace_popup").performKeyInput { pressKey(Key.Escape) }
            compose.onNodeWithContentDescription("Back to artifacts").performClick()
            awaitText(fixture.image.title)
            compose.onNodeWithText(fixture.image.title).performClick()
            compose.waitUntilExactlyOneExists(
                androidx.compose.ui.test.hasContentDescription("Image actions"),
                10_000,
            )
            compose.onNodeWithContentDescription("Image actions").performClick()
            awaitText("Copy link")
            compose.onNodeWithText("Save image").assertDoesNotExist()
            compose.onNodeWithText("Share link").assertDoesNotExist()
            compose.onNodeWithText("Copy link").performClick()
            awaitText("Link copied. Only you and invited people can open it.")
        } finally {
            releaseChecklist.countDown()
        }

        val clipboard =
            checkNotNull(compose.activity.getSystemService(ClipboardManager::class.java))
        compose.waitUntil(5_000) { clipboard.primaryClip != null }
        assertEquals(ownerLink, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertEquals(
            listOf(fixture.checklist.id, fixture.image.id),
            reads,
        )
        assertNull(shadowOf(compose.activity).nextStartedActivity)
    }

    @Test
    fun savesTheDraftOnlyAfterTheServerConfirmsItsAudienceAndAddress() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val previous = app.fixture.commandResponse
        val writes = CopyOnWriteArrayList<String>()
        val respond = CountDownLatch(1)
        val saved = AtomicBoolean()
        app.fixture.commandResponse = { request ->
            if (request.path == "/api/artifacts/${fixture.checklist.id}/visibility") {
                if (request.method == "GET") {
                    policy(
                        fixture.checklist.id,
                        if (saved.get()) "organization" else "private",
                    )
                } else {
                    assertEquals("PATCH", request.method)
                    writes += request.body.readUtf8()
                    check(respond.await(15, TimeUnit.SECONDS))
                    saved.set(true)
                    policy(fixture.checklist.id, "organization")
                }
            } else {
                previous(request)
            }
        }

        try {
            openAccess(fixture)
            compose.onNodeWithText("Save").assertIsNotEnabled()
            compose.onNodeWithText("Workspace members").performClick()
            compose.onNodeWithText("Workspace members").assertIsSelected()
            compose.onNodeWithText("Current access · Only me").assertIsDisplayed()
            assertEquals(emptyList<String>(), writes)
            compose.onNodeWithText("Save").performClick()
            awaitText("Saving…")
            compose.onNodeWithText("Saving…").assertIsNotEnabled()
            compose.onNodeWithText("Current access · Only me").assertIsDisplayed()
        } finally {
            respond.countDown()
        }
        val current = "Current access · Workspace members · Launch team"
        awaitText(current)
        assertEquals(
            parse("""{"visibility":"organization"}"""),
            parse(writes.single()),
        )
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithContentDescription("More actions").performClick()
        awaitText("Share link")
        compose.onNodeWithText("Share link").performClick()
        awaitText(current)
        awaitText(sharedLink)
        shareFromPanel()
        // A recipient URL is a text payload, distinct from the original export.
        assertEquals(sharedLink, takeSharedText())
    }

    @Test
    fun ambiguousWriteChecksPolicyBeforeAnotherSaveAndKeepsTheDraft() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val previous = app.fixture.commandResponse
        val calls = CopyOnWriteArrayList<String>()
        val verify = CountDownLatch(1)
        app.fixture.commandResponse = { request ->
            if (request.path == "/api/artifacts/${fixture.checklist.id}/visibility") {
                if (request.method == "GET") {
                    calls += "read"
                    if (calls.size > 1) check(verify.await(15, TimeUnit.SECONDS))
                    policy(fixture.checklist.id)
                } else {
                    calls += "write"
                    MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                }
            } else {
                previous(request)
            }
        }
        try {
            openAccess(fixture)
            compose.onNodeWithText("Anyone with the link").performClick()
            compose.onNodeWithText("Save").performClick()
            awaitText("Checking the current access…")
            compose.onNodeWithText("Checking…").assertIsNotEnabled()
            compose.onNodeWithText("Anyone with the link").assertIsSelected()
            compose.waitUntil(5_000) { calls.size == 3 }
            assertEquals(listOf("read", "write", "read"), calls)
        } finally {
            verify.countDown()
        }
        awaitText("Couldn’t save access. Try again.")
        compose.onNodeWithText("Current access · Only me").assertIsDisplayed()
        compose.onNodeWithText("Anyone with the link").assertIsSelected()
        compose.onNodeWithText("Save").assertIsEnabled()
        assertEquals(listOf("read", "write", "read"), calls)
    }

    @Test
    fun websiteSharesItsAddressAndChangesVisibilityWithoutRevisionToken() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val previous = app.fixture.commandResponse
        val workspaceId = app.fixture.identity.workspaceId
        val writes = CopyOnWriteArrayList<String>()
        val reassigned = AtomicBoolean()
        val siteAddress = "https://launch.example.com/"
        app.fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/org" ->
                    jsonResponse(
                        """{"id":"$workspaceId","name":"Launch team"}""",
                    )
                "/api/host/sites/fixture/url" -> {
                    assertEquals("fixture.okou.app", request.requestUrl?.queryParameter("hostname"))
                    val siteId = if (reassigned.get()) fixture.slides.id else fixture.site.id
                    jsonResponse(
                        """{"siteId":"$siteId","publicSlug":"fixture","url":"https://fixture.okou.app/","isActive":true,"effectiveUrl":"$siteAddress"}""",
                    )
                }
                "/api/artifacts/${fixture.site.id}/visibility" ->
                    if (request.method == "GET") {
                        jsonResponse(
                            """{"artifactId":"${fixture.site.id}","kind":"hosted-site","visibility":"public","ownerUrl":"$siteAddress","shareUrl":"$siteAddress","shortUrl":"$siteAddress","organization":{"id":"$workspaceId","name":"Launch team"}}""",
                        )
                    } else {
                        assertEquals("PATCH", request.method)
                        writes += request.body.readUtf8()
                        jsonResponse(
                            """{"artifactId":"${fixture.site.id}","kind":"hosted-site","visibility":"private","ownerUrl":"$siteAddress","shareUrl":null,"shortUrl":null,"organization":{"id":"$workspaceId","name":"Launch team"}}""",
                        )
                    }
                else -> previous(request)
            }
        }
        openWebsite(fixture)
        compose.onNodeWithText("Share link").performClick()
        awaitText("${fixture.site.title} · Current version")
        compose.onNodeWithText("${fixture.site.title} · Version 1").assertDoesNotExist()
        awaitText("Current access · Anyone with the link")
        awaitText(siteAddress)
        shareFromPanel()
        assertEquals(siteAddress, takeSharedText())
        compose.onNodeWithContentDescription("More actions").performClick()
        awaitText("Manage access")
        compose.onNodeWithText("Manage access").performClick()
        awaitText("Current access · Anyone with the link")
        compose.onNodeWithText("Only me").performClick()
        compose.onNodeWithText("Save").performClick()
        awaitText("Current access · Only me")
        assertEquals(
            parse("""{"visibility":"private"}"""),
            parse(writes.single()),
        )
        compose.onNodeWithContentDescription("Back").performClick()
        reassigned.set(true)
        compose.onNodeWithText("Share link").performClick()
        awaitText("Couldn’t check link access")
        compose.onNodeWithText(siteAddress).assertDoesNotExist()
        assertNull(shadowOf(compose.activity).nextStartedActivity)
    }

    @Test
    fun legacyDeploymentLinkReadsUnifiedVisibilityEndpoint() {
        val fixture = ArtifactApiFixture(app.fixture)
        val deploymentId = "22222222-2222-4222-8222-222222222222"
        val legacyPath = "/artifacts/legacy0001.html"
        val legacyOwnerUrl = "https://app.okou.ai$legacyPath"
        val legacyPreviewUrl = "https://legacy-preview.okou.app/index.html"
        val legacySharedUrl = "https://legacy-share.okou.app/"
        app.fixture.historyReply = "Legacy site ready.\n\n[Legacy deck]($legacyPath)"
        fixture.install()
        val previous = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath.orEmpty()) {
                "/api/artifact-references/legacy0001.html" ->
                    jsonResponse(
                        """{"url":"$legacyPreviewUrl","expiresAt":"2099-01-01T00:00:00.000Z","downloadUrl":"$legacyPreviewUrl","downloadAllowed":false,"filename":"index.html","contentType":"text/html","target":{"kind":"html","id":"$deploymentId"}}""",
                    )
                "/api/artifacts/$deploymentId/visibility" ->
                    jsonResponse(
                        """{"artifactId":"$deploymentId","kind":"hosted-site","visibility":"public","ownerUrl":"$legacyOwnerUrl","shareUrl":"$legacySharedUrl","shortUrl":"$legacySharedUrl","deploymentVersion":2,"organization":{"id":"org","name":"Launch team"}}""",
                    )
                else -> previous(request)
            }
        }

        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithText(fixture.sourceTitle).performClick()
        awaitText("Legacy deck")
        compose.onNodeWithText("Legacy deck").performClick()
        awaitText("Share link")
        compose.onNodeWithText("Share link").performClick()
        awaitText("index.html · Version 2")
        awaitText("Current access · Anyone with the link")
        awaitText(legacySharedUrl)
        shareFromPanel()
        assertEquals(legacySharedUrl, takeSharedText())
        compose.onNodeWithContentDescription("More actions").performClick()
        awaitText("Copy link")
        compose.onNodeWithText("Manage access").assertDoesNotExist()
    }

    private fun openArtifact(fixture: ArtifactApiFixture, title: String) {
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(title)
        compose.onNodeWithText(title).performClick()
    }

    private fun openAccess(fixture: ArtifactApiFixture) {
        openArtifact(fixture, fixture.checklist.title)
        compose.waitUntilExactlyOneExists(
            androidx.compose.ui.test.hasContentDescription("More actions"),
            10_000,
        )
        compose.onNodeWithContentDescription("More actions").performClick()
        awaitText("Manage access")
        compose.onNodeWithText("Manage access").performClick()
        awaitText("Current access · Only me")
    }

    private fun shareFromPanel() {
        compose
            .onNode(
                hasText("Share link") and
                    hasAnyAncestor(hasTestTag("artifact_share_link_panel")) and
                    androidx.compose.ui.test.hasClickAction(),
            )
            .performClick()
    }

    private fun takeSharedText(): String? {
        val chooser = checkNotNull(shadowOf(compose.activity).nextStartedActivity)
        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        val send =
            checkNotNull(
                IntentCompat.getParcelableExtra(chooser, Intent.EXTRA_INTENT, Intent::class.java),
            )
        assertEquals(Intent.ACTION_SEND, send.action)
        assertEquals("text/plain", send.type)
        assertNull(send.getParcelableExtra(Intent.EXTRA_STREAM, android.net.Uri::class.java))
        return send.getStringExtra(Intent.EXTRA_TEXT)
    }

    private fun policy(id: String, audience: String = "private"): MockResponse {
        val open = audience != "private"
        val url = if (open) "\"$sharedLink\"" else "null"
        return jsonResponse(
            """{"artifactId":"$id","kind":"file","visibility":"$audience","ownerUrl":"$ownerLink","shareUrl":$url,"shortUrl":$url,"organization":{"id":"org","name":"Launch team"}}""",
        )
    }

    private fun parse(body: String) = Json.parseToJsonElement(body)

    private companion object {
        const val ownerLink = "https://app.okou.ai/artifacts/ownerlink1"
        const val sharedLink = "https://app.okou.ai/artifacts/sharedlnk1"
    }
}
