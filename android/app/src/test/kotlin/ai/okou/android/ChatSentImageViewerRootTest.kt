package ai.okou.android

import ai.okou.android.artifacts.ArtifactContent
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.chat.TextDisposition
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pressKey
import java.nio.file.Files
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = ChatListApplication::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
internal class ChatSentImageViewerRootTest : ArtifactCatalogRootTestFixture() {
    @Test
    fun startsAtTheTappedImageAndReturnsToItsMessageAfterPaging() {
        val fixture = openConversation()
        compose.onNodeWithContentDescription(fixture.second).performClick()
        awaitPage(2)
        awaitImage(fixture.second)
        compose.waitUntil(10_000) { fixture.originalReads.contains(fixture.second) }
        assertEquals(listOf(fixture.second), fixture.originalReads.toList())

        compose.activityRule.scenario.recreate()
        awaitPage(2)
        awaitImage(fixture.second)
        compose.onNodeWithTag("artifact_image_transform").performKeyInput {
            pressKey(Key.DirectionLeft)
        }
        awaitPage(1)
        awaitImage(fixture.first)
        try {
            compose.waitUntil(10_000) {
                val preview = compose.runOnIdle { ready.chatArtifacts.state.value.preview }
                preview?.item?.title == fixture.first &&
                    preview.access != null &&
                    preview.problem == null &&
                    (preview.content is ArtifactContent.EncodedImage ||
                        preview.content is ArtifactContent.Image)
            }
        } catch (failure: Exception) {
            val preview = compose.runOnIdle { ready.chatArtifacts.state.value.preview }
            throw AssertionError(
                "Requests: ${fixture.resolves}; originals: ${fixture.originalReads}; " +
                    "preview: ${preview?.problem} ${preview?.content?.javaClass?.simpleName}",
                failure,
            )
        }

        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        awaitText(fixture.prompt)
        compose.onNodeWithContentDescription(fixture.second).assertIsDisplayed()
        compose.onNodeWithText("Notes.txt").assertIsDisplayed()
    }

    @Test
    fun dragKeepsTheCurrentPageUntilSettledAndKeyboardCanLeaveARevokedItem() {
        val fixture = openConversation()
        compose.onNodeWithContentDescription(fixture.first).performClick()
        awaitPage(1)
        awaitImage(fixture.first)
        fixture.denied = fixture.second
        val pager = compose.onNodeWithTag("image_viewer_pager")
        pager.performTouchInput {
            down(center)
            moveBy(Offset(-width * .35f, 0f))
        }
        compose.onNodeWithContentDescription("Image 1 of 2").assertIsDisplayed()
        assertTrue(fixture.second !in fixture.originalReads)
        pager.performTouchInput {
            moveBy(Offset(-width * .40f, 0f))
            up()
        }
        awaitPage(2)
        awaitText("Image unavailable")
        compose.onNodeWithTag("artifact_image_transform").assertDoesNotExist()
        compose.onNodeWithContentDescription("Image actions").assertDoesNotExist()
        assertTrue(fixture.second !in fixture.originalReads)

        pager.performKeyInput { pressKey(Key.DirectionLeft) }
        awaitPage(1)
        awaitImage(fixture.first)
    }

    @Test
    fun plusZoomsTheFocusedImageFromFit() {
        val fixture = openConversation()
        // Keep the thumbnail in place throughout the keyboard interaction.
        val releaseOriginal = CountDownLatch(1)
        fixture.beforeOriginal = { releaseOriginal.await() }
        try {
            compose.onNodeWithContentDescription(fixture.first).performClick()
            val image =
                hasTestTag("artifact_image_transform") and hasContentDescription(fixture.first)
            val fitImage = hasImageAction("Fit image")
            val readyImage = image and isFocused() and hasImageAction("Zoom in") and !fitImage
            compose.waitUntilExactlyOneExists(readyImage, 5_000)

            compose.onNode(readyImage).performKeyInput { pressKey(Key.Plus) }

            compose.waitUntilExactlyOneExists(image and fitImage, 5_000)
        } finally {
            releaseOriginal.countDown()
        }
    }

    @Test
    fun shareThatLosesAccessToAZoomedImageLeavesTheGroupNavigable() {
        val fixture = openConversation()
        compose.onNodeWithContentDescription(fixture.first).performClick()
        awaitImage(fixture.first)
        val image = compose.onNodeWithTag("artifact_image_transform")
        val zoom =
            image.fetchSemanticsNode().config[SemanticsActions.CustomActions].single {
                it.label == "Zoom in"
            }
        compose.runOnIdle { assertTrue(zoom.action()) }
        compose.waitUntil(5_000) {
            image.fetchSemanticsNode().config[SemanticsActions.CustomActions].any {
                it.label == "Fit image"
            }
        }
        compose.waitUntilExactlyOneExists(hasContentDescription("Image actions"), 10_000)
        compose.onNodeWithContentDescription("Image actions").performClick()

        fixture.denied = fixture.first
        compose.onNodeWithText("Share image").performClick()
        awaitText("Unable to share this file")
        awaitText("Image unavailable")
        compose.onNodeWithTag("artifact_image_transform").assertDoesNotExist()
        compose.onNodeWithContentDescription("Image actions").assertDoesNotExist()
        assertNull(shadowOf(compose.activity).nextStartedActivity)

        compose.onNodeWithTag("image_viewer_pager").performKeyInput { pressKey(Key.DirectionRight) }
        awaitPage(2)
        awaitImage(fixture.second)
    }

    @Test
    fun deniedDownloadKeepsAnAuthorizedChatImageVisible() {
        val fixture = openConversation()
        compose.onNodeWithContentDescription(fixture.first).performClick()
        awaitImage(fixture.first)
        compose.waitUntilExactlyOneExists(hasContentDescription("Image actions"), 10_000)
        compose.onNodeWithContentDescription("Image actions").performClick()

        fixture.downloadDenied = fixture.first
        compose.onNodeWithText("Share image").performClick()
        awaitText("Unable to share this file")
        awaitImage(fixture.first)
        compose.onNodeWithContentDescription("Image actions").assertDoesNotExist()
        assertNull(shadowOf(compose.activity).nextStartedActivity)
    }

    private fun openConversation(): ChatImageGalleryFixture {
        val fixture = ChatImageGalleryFixture(app.fixture)
        fixture.install()
        app.responseGate.countDown()
        awaitText("Personal chat")
        compose.onNodeWithText("Personal chat").performClick()
        awaitText(fixture.prompt)
        return fixture
    }

    private fun awaitPage(number: Int) =
        compose.waitUntilExactlyOneExists(hasContentDescription("Image $number of 2"), 10_000)

    private fun awaitImage(filename: String) =
        compose.waitUntilExactlyOneExists(
            hasTestTag("artifact_image_transform") and hasContentDescription(filename),
            10_000,
        )

    private fun hasImageAction(label: String) =
        SemanticsMatcher("has image action '$label'") { node ->
            node.config.getOrNull(SemanticsActions.CustomActions)?.any { it.label == label } == true
        }
}

class ChatPendingImageApplication : ChatListApplication() {
    internal lateinit var gallery: ChatImageGalleryFixture
    private lateinit var store: ComposerJournalStore
    private lateinit var directory: java.io.File
    private lateinit var stagedKeys: List<String>
    internal val pending = CountDownLatch(1)
    internal val accept = CountDownLatch(1)
    private val identity = WorkspaceIdentity(BuildConfig.API_ORIGIN, "user-a", "session-a", "org-a")

    override fun onCreate() {
        super.onCreate()
        composerService = fixture.service
        // Application.onCreate runs before Robolectric's native graphics environment is ready.
        gallery =
            ChatImageGalleryFixture(
                fixture,
                Base64.getDecoder()
                    .decode(
                        "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAZElEQVR4nO3PUQkAIBTAwBfMsBaxmyH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY8dgGMXi0e63sIfgAAAABJRU5ErkJggg==",
                    ),
            )
        gallery.install(includeHistory = false)
        directory = Files.createTempDirectory(cacheDir.toPath(), "pending-gallery-").toFile()
        store = ComposerJournalStore(this, directory)
        journalStore = store
        stagedKeys = runBlocking {
            gallery.seedDraft(store, identity, "thread:$CHAT_PERSONAL", uploaded = true)
        }
        val previous = fixture.commandResponse
        fixture.commandResponse = { request ->
            if (request.method != "POST" || request.requestUrl?.encodedPath != "/api/chat/events") {
                previous(request)
            } else {
                val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                val event = body.getValue("clientEventId").jsonPrimitive.content
                val message = body.getValue("userMessage")
                val run = "51475000-0000-4000-8000-000000000006"
                pending.countDown()
                check(accept.await(10, TimeUnit.SECONDS))
                fixture.setHistoryEvents(
                    CHAT_PERSONAL,
                    listOf(
                        historyEventWire(
                            event,
                            40,
                            type = "input.prompt",
                            payload = """{"userMessage":$message}""",
                            run = run,
                        ),
                        historyEventWire(
                            id = "51475000-0000-4000-8000-000000000007",
                            seq = 41,
                            type = "run.completed",
                            payload = "null",
                            run = run,
                        ),
                    ),
                )
                jsonResponse("""{"threadId":"$CHAT_PERSONAL","createdAt":"$CHAT_DATE"}""")
                    .setResponseCode(201)
            }
        }
    }

    internal fun closeJournal() {
        runBlocking { store.close() }
        stagedKeys.forEach { store.attachmentDirectory(identity).resolve(it).delete() }
        check(directory.deleteRecursively())
    }
}

@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w400dp-h800dp",
    application = ChatPendingImageApplication::class,
)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
internal class ChatPendingImageViewerRootTest : ArtifactCatalogRootTestFixture() {
    @Test
    fun opensThePendingLocalImageAndKeepsItsPageWhenHistoryConfirmsTheSend() {
        val pendingApp = app as ChatPendingImageApplication
        val gallery = pendingApp.gallery
        val finishOriginal = CountDownLatch(1)
        gallery.beforeOriginal = { check(finishOriginal.await(10, TimeUnit.SECONDS)) }
        try {
            app.responseGate.countDown()
            awaitText("Personal chat")
            compose.onNodeWithText("Personal chat").performClick()
            awaitText(gallery.draftText)
            val sendLabel = app.getString(R.string.composer_send)
            compose.onNodeWithContentDescription(sendLabel).assertIsEnabled().performClick()
            compose.waitUntil(10_000) { pendingApp.pending.count == 0L }
            val tapped =
                hasContentDescription(gallery.second) and
                    hasAnyAncestor(hasTestTag("chat-message-attachments"))
            compose.waitUntilExactlyOneExists(tapped, 10_000)
            compose.onNode(tapped).performClick()
            val image =
                hasTestTag("artifact_image_transform") and hasContentDescription(gallery.second)
            compose.waitUntilExactlyOneExists(image, 10_000)
            compose.onNodeWithContentDescription("Image 2 of 2").assertIsDisplayed()
            pendingApp.accept.countDown()
            compose.waitUntil(10_000) {
                compose.runOnIdle {
                    ready.composer.uiState.value
                        .entry(ComposerTarget(CHAT_PERSONAL))
                        .receipt
                        ?.disposition == TextDisposition.Accepted
                }
            }
            compose.onNodeWithContentDescription("Image 2 of 2").assertIsDisplayed()
            compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
            compose.waitUntil(10_000) {
                compose.runOnIdle {
                    ready.chats.history.uiState.value.transcript?.messages?.any { message ->
                        message.blocks.any { it.attachment?.filename == gallery.second }
                    } == true
                }
            }
            compose.waitUntilExactlyOneExists(tapped, 10_000)
            compose.onNode(tapped).assertIsDisplayed()
        } finally {
            pendingApp.accept.countDown()
            finishOriginal.countDown()
            compose.runOnIdle { compose.activity.viewModelStore.clear() }
            pendingApp.closeJournal()
        }
    }
}
