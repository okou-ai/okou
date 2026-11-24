package ai.okou.android

import ai.okou.android.artifacts.ArtifactItem
import ai.okou.android.artifacts.ArtifactKind
import ai.okou.android.artifacts.ArtifactPage
import ai.okou.android.artifacts.ArtifactSaveResult
import ai.okou.android.artifacts.ConfirmedArtifactCatalog
import ai.okou.android.artifacts.ConfirmedWorkflowResources
import ai.okou.android.artifacts.WorkflowResource
import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ChatChanges
import ai.okou.android.chat.ConversationHistorySync
import android.app.Activity
import android.content.Intent
import android.media.MediaPlayer
import android.net.Uri
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.VideoView
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollAction
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
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.width
import androidx.core.view.children
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
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

internal abstract class ArtifactCatalogRootTestFixture {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    protected val app
        get() = compose.activity.application as ChatListApplication

    protected val ready
        get() =
            checkNotNull(
                ViewModelProvider(compose.activity)[SessionModel::class.java].uiState.value.ready,
            )

    protected val artifactModel
        get() = ready.artifacts

    @After
    fun close() {
        app.responseGate.countDown()
        compose.runOnIdle { compose.activity.viewModelStore.clear() }
        app.fixture.close()
        app.cacheSnapshot.restore()
    }

    protected fun loadedWebsiteUrl(): String? = websiteView()?.let { shadowOf(it).lastLoadedUrl }

    protected fun scrollWebsitePreview() {
        compose
            .onNode(hasScrollAction() and hasAnyDescendant(hasTestTag("artifact_preview_surface")))
            .performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 180f) }
    }

    protected fun websiteView(): WebView? = compose.runOnIdle {
        compose.activity.window.decorView.website()
    }

    protected fun openWebsite(fixture: ArtifactApiFixture) {
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.site.title)
        compose.onNodeWithText(fixture.site.title).performClick()
        compose.waitUntil(10_000) { loadedWebsiteUrl() != null }
    }

    protected fun failWebsiteDocument(view: WebView, status: Int = 503) {
        compose.runOnIdle {
            val address = Uri.parse(checkNotNull(shadowOf(view).lastLoadedUrl))
            val request =
                object : WebResourceRequest {
                    override fun getUrl() = address

                    override fun isForMainFrame() = true

                    override fun isRedirect() = false

                    override fun hasGesture() = false

                    override fun getMethod() = "GET"

                    override fun getRequestHeaders() = emptyMap<String, String>()
                }
            val response =
                WebResourceResponse("text/plain", "UTF-8", status, "Unavailable", emptyMap(), null)
            view.webViewClient.onReceivedHttpError(view, request, response)
        }
    }

    private fun View.website(): WebView? =
        when (this) {
            is WebView -> this
            is ViewGroup -> children.firstNotNullOfOrNull { it.website() }
            else -> null
        }

    protected fun awaitText(value: String, partial: Boolean = false) {
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithText(value, substring = partial)
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
    }

    protected fun cancelSaveAfterLeavingPreview(title: String, backDescription: String) {
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
                ),
            )
        }
        compose.onNodeWithText(title).performClick()
        awaitText("Save file")
        compose.onNodeWithText("Save file").assertIsEnabled()
    }
}

class ArtifactWorkflowResourcesApplication : ChatListApplication() {
    override fun onCreate() {
        super.onCreate()
        workflows = fixture.service
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = ChatListApplication::class)
internal class ArtifactCatalogReadRootTest : ArtifactCatalogRootTestFixture() {
    @Test
    fun firstCatalogReadRetriesWhileConnectivityIsUnavailableAndUsesTerminalErrorMeasurements() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val release = CountDownLatch(1)
        val attempts = CopyOnWriteArrayList<Long>()
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/artifacts/catalog") {
                attempts.add(SystemClock.uptimeMillis())
                if (attempts.size == 1) {
                    release.await()
                    MockResponse().setResponseCode(503).setHeader("Retry-After", "4")
                } else MockResponse().setResponseCode(503)
            } else respond(request)
        }
        compose.runOnIdle { app.connectivity.value = false }
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        val failureText = "Temporarily unable to load artifacts"
        try {
            compose.onNodeWithContentDescription("Artifacts").performClick()
            compose.waitUntil(10_000) {
                attempts.size == 1 &&
                    compose
                        .onAllNodes(hasTestTag("artifact_row_skeleton"))
                        .fetchSemanticsNodes()
                        .isNotEmpty()
            }
            compose.onNodeWithText(failureText).assertDoesNotExist()
        } finally {
            release.countDown()
        }
        val mainLooper = shadowOf(Looper.getMainLooper())
        compose.waitUntil(10_000) {
            mainLooper.idleFor(250, TimeUnit.MILLISECONDS)
            compose.onAllNodesWithText(failureText).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("Search artifacts").assertIsDisplayed()
        assertTrue(
            compose.onAllNodes(hasTestTag("artifact_row_skeleton")).fetchSemanticsNodes().isEmpty(),
        )
        assertEquals(3, attempts.size)
        assertTrue(attempts[1] - attempts[0] >= 4_000)
        assertTrue(attempts[2] - attempts[1] >= 3_000)
        assertInitialReadFeedback(failureText)
        mainLooper.idleFor(12, TimeUnit.SECONDS)
        assertEquals(3, attempts.size)
        app.fixture.commandResponse = respond
        compose.runOnIdle { app.connectivity.value = true }
        awaitText(fixture.summary.title)
    }

    @Test
    fun staleChatResourcesRestoreWhileSyncingAndRefreshFailureKeepsRows() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        val item = ArtifactItem(fixture.summary.id, fixture.summary.title, ArtifactKind.File, 1_000)
        seedChatCatalog(listOf(item), ageMinutes = 11)
        val cache = ready.chats.cache
        val release = CountDownLatch(1)
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/artifacts/catalog") {
                release.await()
                MockResponse().setResponseCode(400)
            } else respond(request)
        }
        val refreshing = compose.onNodeWithContentDescription("Syncing chat resources")
        val resource = compose.onNodeWithText(item.title)
        try {
            openChatResources(fixture.sourceTitle)
            awaitText(item.title)
            refreshing.assertIsDisplayed()
            val progress = refreshing.getUnclippedBoundsInRoot()
            assertTrue(progress.bottom <= resource.getUnclippedBoundsInRoot().top)
        } finally {
            release.countDown()
        }
        val failure = "Temporarily unable to update. Showing loaded artifacts."
        awaitText(failure)
        resource.assertIsDisplayed()
        assertTrue(
            compose.onNodeWithText(failure).getUnclippedBoundsInRoot().bottom <=
                resource.getUnclippedBoundsInRoot().top,
        )
        refreshing.assertDoesNotExist()
        assertEquals(
            item,
            runBlocking { cache.loadArtifactCatalog(CHAT_PERSONAL)?.page?.items?.single() },
        )
    }

    @Test
    fun recentlyConfirmedEmptyChatCatalogRemainsVisibleDuringSilentRefresh() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val release = CountDownLatch(1)
        fixture.beforeCatalog = { release.await() }
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        seedChatCatalog(emptyList(), ageMinutes = 9)
        try {
            openChatResources(fixture.sourceTitle)
            awaitText("No artifacts yet")
            compose.onNodeWithContentDescription("Syncing chat resources").assertDoesNotExist()
            assertTrue(
                compose
                    .onAllNodes(hasTestTag("artifact_row_skeleton"))
                    .fetchSemanticsNodes()
                    .isEmpty(),
            )
        } finally {
            release.countDown()
        }
        awaitText(fixture.summary.title)
        compose.onNodeWithText("No artifacts yet").assertDoesNotExist()
    }

    @Test
    fun chatResourcesResumesTheSameFailedPageAndEvictsOnConfirmedRevocation() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.pageSize = 2
        fixture.install()
        val realtime = app.realtimeService as TestRealtimeService
        val refuseAppend = AtomicBoolean(true)
        val deny = AtomicBoolean(false)
        val appendRequests = AtomicInteger()
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            val url = request.requestUrl
            if (url?.encodedPath == "/api/artifacts/catalog" && deny.get()) {
                MockResponse().setResponseCode(403)
            } else if (
                url?.encodedPath == "/api/artifacts/catalog" && url.queryParameter("cursor") == "2"
            ) {
                appendRequests.incrementAndGet()
                if (refuseAppend.get()) MockResponse().setResponseCode(400) else respond(request)
            } else respond(request)
        }
        app.responseGate.countDown()
        openChatResources(fixture.sourceTitle)
        val notice = "Temporarily unable to load more artifacts"
        awaitText(notice)
        val previousRow = compose.onNodeWithText(fixture.summary.title).getUnclippedBoundsInRoot()
        assertTrue(
            compose.onNodeWithText(notice).getUnclippedBoundsInRoot().top > previousRow.bottom,
        )
        assertEquals(1, appendRequests.get())
        compose.runOnIdle { app.connectivity.value = false }
        compose.waitUntil(10_000) { ready.chatArtifacts.state.value.offline }
        refuseAppend.set(false)
        compose.runOnIdle { app.connectivity.value = true }
        awaitText(fixture.slides.title)
        assertEquals(2, appendRequests.get())

        deny.set(true)
        realtime.invalidate(ChatChanges(artifactThreads = setOf(CHAT_PERSONAL)))
        val firstReadError = "You don’t have access to this artifact catalog"
        awaitText(firstReadError)
        assertInitialReadFeedback(firstReadError)
        compose.onNodeWithText(fixture.summary.title).assertDoesNotExist()
        val cache = ready.chats.cache
        compose.waitUntil(10_000) {
            runBlocking { cache.loadArtifactCatalog(CHAT_PERSONAL) == null }
        }
    }

    @Test
    fun chatResourcesClosesAnOpenPreviewWhenConversationAccessIsLost() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        app.responseGate.countDown()
        openChatResources(fixture.sourceTitle)
        awaitText(fixture.summary.title)
        compose.onNodeWithText(fixture.summary.title).performClick()
        awaitText(fixture.summary.title)
        compose.onNodeWithContentDescription("Back to chat resources").assertIsDisplayed()

        app.fixture.historyDetail = { MockResponse().setResponseCode(403) }
        compose.runOnIdle { ready.chats.history.invalidateDetail(CHAT_PERSONAL) }
        val unavailable = "This conversation was deleted or is unavailable."
        awaitText(unavailable)
        assertInitialReadFeedback(unavailable)
        compose.onNodeWithText(fixture.summary.title).assertDoesNotExist()
        compose.onNodeWithContentDescription("Back to chat resources").assertDoesNotExist()
        compose.onNodeWithContentDescription("Back").assertIsDisplayed()
    }

    @Test
    fun chatResourcesRechecksAnOpenCatalogAfterRealtimeResync() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val removed = AtomicBoolean(false)
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/artifacts/catalog" && removed.get()) {
                jsonResponse("""{"artifacts":[],"nextCursor":null}""")
            } else respond(request)
        }
        app.responseGate.countDown()
        openChatResources(fixture.sourceTitle)
        awaitText(fixture.summary.title)

        removed.set(true)
        (app.realtimeService as TestRealtimeService).invalidate()

        awaitText("No artifacts yet")
        compose.onNodeWithText(fixture.summary.title).assertDoesNotExist()
    }

    @Test
    fun relatedChatsDeduplicateAndReturnToTheResourcesList() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val respondEvents = app.fixture.events
        app.fixture.events = { request ->
            if (request.requestUrl?.queryParameter("sinceSeqId") == null) {
                val source = chatEventWire(title = fixture.sourceTitle)
                val peer =
                    chatEventWire(
                        id = "77777777-7777-4777-8777-777777777777",
                        seq = 23,
                        thread = CHAT_IN_PROJECT,
                        title = "Handoff conversation",
                    )
                jsonResponse("""{"events":[$source,$peer],"hasMore":false}""")
            } else respondEvents(request)
        }
        val respond = app.fixture.commandResponse
        val communicationStatus = AtomicInteger(200)
        app.fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/chat-threads/$CHAT_PERSONAL/relations/children" ->
                    jsonResponse(
                        """{"items":[{"id":"$CHAT_PERSONAL","threadId":"$CHAT_IN_PROJECT","title":"Original title","status":"idle","sourceRunId":"$CHAT_PERSONAL","createdAt":"2026-01-01T00:00:00Z"}]}""",
                    )
                "/api/chat-threads/$CHAT_PERSONAL/relations/communications" ->
                    if (communicationStatus.get() != 200) {
                        MockResponse().setResponseCode(communicationStatus.get())
                    } else
                        jsonResponse(
                            """{"items":[{"threadId":"$CHAT_IN_PROJECT","title":"Handoff conversation","status":"idle","sentCount":1,"receivedCount":1,"lastMessageAt":"2026-01-02T00:00:00Z"}]}""",
                        )
                else -> respond(request)
            }
        }
        app.responseGate.countDown()
        openChatResources(fixture.sourceTitle)
        awaitText("Handoff conversation")
        compose.onNodeWithText("Original title").assertDoesNotExist()
        compose.onNodeWithText("Handoff conversation").performClick()
        compose.onNodeWithTag("chat_artifact_resources").assertDoesNotExist()
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        awaitText("Related chats")
        compose.onNodeWithText("Handoff conversation").assertIsDisplayed()

        val realtime = app.realtimeService as TestRealtimeService
        communicationStatus.set(400)
        realtime.invalidate()
        val failure = "Temporarily unable to load related chats"
        awaitText(failure)
        compose.onNodeWithText("Handoff conversation").assertIsDisplayed()

        communicationStatus.set(403)
        realtime.invalidate()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Handoff conversation").fetchSemanticsNodes().isEmpty()
        }
        awaitText("Related chats are no longer available")
        compose.onNodeWithText("Handoff conversation").assertDoesNotExist()
    }

    @Test
    @Config(
        qualifiers = "en-rUS-w400dp-h560dp",
        application = ArtifactWorkflowResourcesApplication::class,
    )
    fun workflowResourcesRefreshCachedAuthorityAndRestoreTheActivatedRow() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        val firstRead = CountDownLatch(1)
        try {
            compose.activityRule.scenario.recreate()
            val artifacts = ArtifactApiFixture(app.fixture)
            artifacts.install()
            val workflows = WorkflowApiFixture(chats = app.fixture)
            workflows.releaseTitle = "Weekly release workflow"
            val requestCount = AtomicInteger()
            val workflowVisible = AtomicBoolean(true)
            val respond = app.fixture.commandResponse
            app.fixture.commandResponse = { request ->
                if (request.requestUrl?.encodedPath == "/api/workflows") {
                    if (requestCount.incrementAndGet() == 1) firstRead.await()
                    if (workflowVisible.get()) respond(request) else jsonResponse("[]")
                } else respond(request)
            }
            installAutomationHistory()
            app.responseGate.countDown()
            awaitText(artifacts.sourceTitle)
            seedAutomationResources("Cached workflow title")
            assertEquals(0, requestCount.get())
            openChatResources(artifacts.sourceTitle)
            compose.waitUntil(10_000) {
                compose
                    .onAllNodes(hasContentDescription("Syncing chat resources"))
                    .fetchSemanticsNodes()
                    .isNotEmpty() && requestCount.get() == 1
            }
            awaitText(artifacts.slides.title)
            val list = compose.onNodeWithTag("chat_resources_list")
            list.performScrollToNode(hasText("Cached workflow title"))
            compose.onNodeWithText("Cached workflow title").assertIsDisplayed()
            compose.onNodeWithContentDescription("Syncing chat resources").assertIsDisplayed()
            firstRead.countDown()
            awaitText(workflows.releaseTitle)
            compose.onNodeWithText("Historical workflow title").assertDoesNotExist()
            list.performScrollToNode(hasText(workflows.releaseTitle))
            val row = compose.onNodeWithText(workflows.releaseTitle)
            row.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            val bounds = row.assertIsFocused().getUnclippedBoundsInRoot()
            row.performClick()
            awaitText(workflows.ruleTitle)
            compose.onNodeWithTag("workflow_tab_automations").assertIsSelected()
            compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
            awaitText(workflows.releaseTitle)
            assertEquals(bounds, row.assertIsFocused().getUnclippedBoundsInRoot())

            workflowVisible.set(false)
            (app.realtimeService as TestRealtimeService).invalidate()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText(workflows.releaseTitle).fetchSemanticsNodes().isEmpty()
            }
            list.performScrollToNode(hasText("Slack"))
            compose.onNodeWithText("Slack").assertIsDisplayed()
            compose.onNodeWithText("Workflows and automations").assertDoesNotExist()
        } finally {
            firstRead.countDown()
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    @Config(application = ArtifactWorkflowResourcesApplication::class)
    fun workflowResourcesRecheckAfterResyncDuringAnOlderRead() {
        val artifacts = ArtifactApiFixture(app.fixture)
        artifacts.install()
        val workflows = WorkflowApiFixture(chats = app.fixture)
        workflows.releaseTitle = "Weekly release workflow"
        val workflowVisible = AtomicBoolean(true)
        val workflowReads = AtomicInteger()
        val releaseFirstRead = CountDownLatch(1)
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/workflows") {
                val response =
                    if (workflowVisible.get()) respond(request)
                    else
                        jsonResponse(
                                """{"error":{"code":"FORBIDDEN","message":"Workflows unavailable"}}""",
                            )
                            .setResponseCode(403)
                if (workflowReads.incrementAndGet() == 1) releaseFirstRead.await()
                response
            } else respond(request)
        }
        installAutomationHistory()
        app.responseGate.countDown()
        awaitText(artifacts.sourceTitle)
        seedAutomationResources(workflows.releaseTitle)
        try {
            openChatResources(artifacts.sourceTitle)
            compose.waitUntil(10_000) {
                compose
                    .onAllNodes(hasContentDescription("Syncing chat resources"))
                    .fetchSemanticsNodes()
                    .isNotEmpty() && workflowReads.get() == 1
            }
            awaitText(artifacts.summary.title)
            compose
                .onNodeWithTag("chat_resources_list")
                .performScrollToNode(hasText(workflows.releaseTitle))
            compose.onNodeWithText(workflows.releaseTitle).assertIsDisplayed()

            val artifactReads = artifacts.catalogScopes.size
            workflowVisible.set(false)
            (app.realtimeService as TestRealtimeService).invalidate()
            compose.waitUntil(10_000) {
                compose
                    .onAllNodes(hasTestTag("chat_resources_list"))
                    .fetchSemanticsNodes()
                    .isNotEmpty() && artifacts.catalogScopes.size > artifactReads
            }
            assertEquals(1, workflowReads.get())
            releaseFirstRead.countDown()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText(workflows.releaseTitle).fetchSemanticsNodes().isEmpty()
            }
            assertEquals(2, workflowReads.get())
            compose.onNodeWithText("Slack").assertIsDisplayed()
        } finally {
            releaseFirstRead.countDown()
        }
    }

    private fun seedAutomationResources(workflowTitle: String) {
        runBlocking {
            val store = ready.chats.cache
            val checkpoint =
                ConversationHistorySync(app.fixture.service).synchronize(CHAT_PERSONAL, null)
            val now = System.currentTimeMillis()
            store.saveHistory(checkpoint, now)
            store.saveWorkflowResources(
                CHAT_PERSONAL,
                ConfirmedWorkflowResources(
                    listOf(WorkflowResource(WORKFLOW_RELEASE, workflowTitle)),
                    now - 11 * 60_000,
                ),
            )
        }
    }

    private fun installAutomationHistory() {
        val before = app.fixture.historyRows
        app.fixture.historyCatchUp = { jsonResponse("""{"events":{},"notFoundThreads":[]}""") }
        app.fixture.historyRows = { request ->
            val url = checkNotNull(request.requestUrl)
            if (url.pathSegments[2] != CHAT_PERSONAL) before(request)
            else {
                val launch =
                    historyEventWire(
                        id = HISTORY_RUN,
                        seq = 1,
                        type = "input.automation",
                        payload =
                            """{"userMessage":{"version":1,"parts":[{"type":"automation","workflowId":"$WORKFLOW_RELEASE","workflowName":"Historical workflow title"},{"type":"source","kind":"slack"}]}}""",
                    )
                val rows =
                    if ((url.queryParameter("sinceSeqId")?.toLong() ?: 0L) == 0L)
                        "$launch,${historyEventWire(type = "run.completed", payload = "null")}"
                    else ""
                jsonResponse(
                    """{"rows":[$rows],"cursor":{"lastEventId":"$HISTORY_LAST_EVENT","lastSeqId":37},"hasMore":false}""",
                )
            }
        }
    }

    private fun openChatResources(chat: String) {
        awaitText(chat)
        compose.onNodeWithText(chat).performClick()
        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Chat resources").performClick()
    }

    private fun seedChatCatalog(items: List<ArtifactItem>, ageMinutes: Int) {
        compose.waitUntil(10_000) {
            ViewModelProvider(compose.activity)[SessionModel::class.java].uiState.value.ready !=
                null
        }
        val cache = ready.chats.cache
        runBlocking {
            cache.saveArtifactCatalog(
                CHAT_PERSONAL,
                ConfirmedArtifactCatalog(
                    ArtifactPage(items, null),
                    System.currentTimeMillis() - ageMinutes * 60_000L,
                ),
                appendedTo = null,
            )
        }
    }

    private fun assertInitialReadFeedback(text: String) {
        val feedback =
            compose
                .onNodeWithText(text)
                .assertIsDisplayed()
                .assert(
                    SemanticsMatcher.expectValue(
                        SemanticsProperties.LiveRegion,
                        LiveRegionMode.Polite,
                    ),
                )
        val label = feedback.getUnclippedBoundsInRoot()
        val area = compose.onNodeWithTag("artifact_read_error_area").getUnclippedBoundsInRoot()
        assertEquals(12.dp, label.left - area.left)
        assertEquals(12.dp, area.right - label.right)
        assertEquals(24.dp, label.top - area.top)
        val layouts = mutableListOf<TextLayoutResult>()
        feedback.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        val style = layouts.single().layoutInput.style
        assertEquals(14.sp, style.fontSize)
        assertEquals(20.sp, style.lineHeight)
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = ChatListApplication::class)
internal class ArtifactCatalogRootTest : ArtifactCatalogRootTestFixture() {
    @Test
    fun catalogUsesTheDesignedDateSpacingAndRowAlignment() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.checklist.title)

        val first = compose.onNodeWithText(fixture.checklist.title).getUnclippedBoundsInRoot()
        val title =
            compose
                .onNodeWithText(fixture.checklist.title, useUnmergedTree = true)
                .getUnclippedBoundsInRoot()
        val nextDay = compose.onNodeWithText("Yesterday").getUnclippedBoundsInRoot()
        assertTrue(first.height >= 80.dp)
        assertEquals(8.dp, title.top - first.top)
        assertEquals(16.dp, nextDay.top - first.bottom)
    }

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
        val previewTitleLayouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithTag("artifact_preview_title").performSemanticsAction(
            SemanticsActions.GetTextLayoutResult,
        ) {
            it(previewTitleLayouts)
        }
        val titleStyle = previewTitleLayouts.single().layoutInput.style
        assertEquals(22.sp, titleStyle.fontSize)
        assertEquals(28.sp, titleStyle.lineHeight)
        assertEquals(FontWeight.SemiBold, titleStyle.fontWeight)
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
    @Config(qualifiers = "en-rUS-w400dp-h360dp")
    fun compactCatalogRestoresTheScrolledSearchResultAfterPreview() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            val fixture = ArtifactApiFixture(app.fixture)
            fixture.install()
            app.responseGate.countDown()
            awaitText(fixture.sourceTitle)
            compose.onNodeWithContentDescription("Artifacts").performClick()

            val query = compose.onNodeWithTag("artifact_query")
            query.performTextReplacement("launch")
            awaitText(fixture.summary.title)
            val image = compose.onNodeWithText(fixture.image.title)
            compose.onNodeWithTag("artifact_list").performScrollToNode(hasText(fixture.image.title))
            image.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            val rowBounds = image.assertIsFocused().getUnclippedBoundsInRoot()
            image.performClick()
            compose.onNodeWithTag("artifact_preview_title").assertTextContains(fixture.image.title)
            compose.onNodeWithContentDescription("Back to artifacts").performClick()

            query.assertTextContains("launch").assertIsNotFocused()
            compose.onNodeWithText("Yesterday").assertDoesNotExist()
            assertEquals(rowBounds, image.assertIsFocused().getUnclippedBoundsInRoot())
        } finally {
            instrumentation.resetInTouchMode()
        }
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
    fun saveRetriesTheGrantButDoesNotReplayADestinationWrite() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val grantAttempts = AtomicInteger()
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (
                request.requestUrl?.encodedPath ==
                    "/api/artifact-references/checklist1.md/download" &&
                    grantAttempts.incrementAndGet() <= 2
            ) {
                MockResponse().setResponseCode(503)
            } else respond(request)
        }
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.checklist.title)
        compose.onNodeWithText(fixture.checklist.title).performClick()
        awaitText("Save file")
        val model = artifactModel
        val saved = ByteArrayOutputStream()
        val destinationAttempts = AtomicInteger()
        compose.runOnIdle {
            model.save(fixture.checklist.id) {
                destinationAttempts.incrementAndGet()
                saved
            }
        }
        awaitText("File saved")
        assertEquals(3, grantAttempts.get())
        assertEquals(1, destinationAttempts.get())
        assertEquals(fixture.checklistBody, saved.toString(Charsets.UTF_8.name()))

        compose.runOnIdle {
            model.save(fixture.checklist.id) {
                destinationAttempts.incrementAndGet()
                throw IOException("Document provider failed after being invoked")
            }
        }
        awaitText("Couldn’t save the file")
        compose.onNodeWithText("Save file").assertIsEnabled()
        assertEquals(4, grantAttempts.get())
        assertEquals(2, destinationAttempts.get())
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
        val reopened = CountDownLatch(1)
        fixture.beforeCatalog = { reopened.await() }
        try {
            compose.onNodeWithContentDescription("Chat actions").performClick()
            compose.onNodeWithText("Chat resources").performClick()
            compose.onNodeWithText(fixture.slides.title).assertIsDisplayed()
        } finally {
            reopened.countDown()
        }
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
        compose.onNodeWithText("Artifact preview").assertIsDisplayed()
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
                """{"rows":[$rows],"cursor":{"lastEventId":"$HISTORY_LAST_EVENT","lastSeqId":20},"hasMore":false}""",
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

    @Test
    fun workspaceSearchKeepsArtifactScopeThroughPreviewAndSourceBack() {
        val fixture =
            ArtifactApiFixture(app.fixture).apply {
                pageSize = 1
                install()
            }
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Search workspace").performClick()
        val scope = compose.onNodeWithTag("search_type_Artifacts")
        val query = compose.onNodeWithTag("chat_search_query")
        scope.performClick()
        query.performTextReplacement("Product launch")
        awaitText(fixture.site.title)
        compose.onNodeWithText(fixture.summary.title).performClick()
        awaitText("Artifact preview")
        awaitText("View source conversation")
        compose.onNodeWithText("View source conversation").performClick()
        compose.onNodeWithTag("conversation").assertIsDisplayed()
        compose.onNodeWithContentDescription("Back to artifact preview").performClick()
        awaitText("View source conversation")
        compose.onNodeWithContentDescription("Close artifact preview").performClick()
        query.assertTextContains("Product launch")
        scope.assertIsSelected()
        compose.onNodeWithText(fixture.summary.title).assertIsDisplayed()
        assertTrue(fixture.catalogQueries.all { it.second == "Product launch" })
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = ChatListApplication::class)
internal class ArtifactPreviewRootTest : ArtifactCatalogRootTestFixture() {
    @Test
    fun uncachedDocumentResolvesItsAccessWhileConnectivityIsReportedUnavailable() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        compose.runOnIdle { app.connectivity.value = false }
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.summary.title)
        compose.onNodeWithText(fixture.summary.title).performClick()
        awaitText("Positioning: help teams move ongoing work forward", partial = true)
        assertTrue(fixture.requestedReferences.isNotEmpty())
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
        val frame = compose.onNodeWithTag("artifact_preview_surface").getUnclippedBoundsInRoot()
        val status =
            compose
                .onNodeWithText("No preview is available for this file")
                .getUnclippedBoundsInRoot()
        assertTrue(abs(frame.height.value - frame.width.value * 9 / 16) <= 1)
        val frameCenter = frame.top + frame.height / 2
        val statusCenter = status.top + status.height / 2
        assertTrue(abs((statusCenter - frameCenter).value) <= 1)
    }

    @Test
    fun mediaStartsOnlyAfterPlayAndKeepsItsFrameWhenPlaybackFails() {
        val fixture = ArtifactApiFixture(app.fixture, includeVideo = true)
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        compose.onNodeWithText("Videos").performClick()
        awaitText(fixture.video.title)
        compose.onNodeWithText(fixture.video.title).performClick()
        awaitText("Play")

        val surface = compose.onNodeWithTag("artifact_preview_surface")
        val frame = surface.getUnclippedBoundsInRoot()
        assertTrue(abs(frame.height.value - frame.width.value * 9 / 16) <= 1)
        assertNull(compose.runOnIdle { compose.activity.window.decorView.videoPreview() })
        compose.onNodeWithText("Play").assertHeightIsAtLeast(48.dp).performClick()
        val view =
            checkNotNull(
                compose.runOnIdle { compose.activity.window.decorView.videoPreview() },
            )
        assertTrue(compose.runOnIdle { view.isPlaying })
        assertEquals(frame, surface.getUnclippedBoundsInRoot())

        compose.activityRule.scenario.moveToState(Lifecycle.State.STARTED)
        assertTrue(compose.runOnIdle { !view.isPlaying })
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        assertTrue(compose.runOnIdle { !view.isPlaying })

        compose.runOnIdle {
            shadowOf(view).onErrorListener.onError(null, MediaPlayer.MEDIA_ERROR_UNKNOWN, 0)
        }
        awaitText("Temporarily unable to load preview")
        assertEquals(frame, surface.getUnclippedBoundsInRoot())
        assertNull(compose.runOnIdle { compose.activity.window.decorView.videoPreview() })
        compose.onNodeWithContentDescription("Back to artifacts").performClick()
        compose.onNodeWithText(fixture.video.title).assertIsDisplayed()
        compose.onNodeWithText("Videos").assertIsSelected()
    }

    private fun View.videoPreview(): VideoView? =
        when (this) {
            is VideoView -> this
            is ViewGroup -> children.firstNotNullOfOrNull { it.videoPreview() }
            else -> null
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
        backToCatalog.performClick()

        compose.runOnIdle { app.connectivity.value = false }
        compose.waitUntil(10_000) { artifactModel.state.value.offline }
        compose.onNodeWithText(fixture.image.title).performClick()
        compose.onNodeWithContentDescription(fixture.image.title).assertIsDisplayed()
        backToCatalog.performClick()

        compose.onNodeWithText(fixture.summary.title).performClick()
        compose.onNodeWithText(documentText, substring = true).assertIsDisplayed()
    }

    @Test
    fun exhaustedPreviewRetriesKeepTheCachedDocumentAndShowTheFailure() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.summary.title)
        compose.onNodeWithText(fixture.summary.title).performClick()

        val body = fixture.summaryBody.lineSequence().first().substringAfter(". ")
        awaitText(body, partial = true)
        val surface = compose.onNodeWithTag("artifact_preview_surface")
        val originalBounds = surface.getUnclippedBoundsInRoot()
        compose.runOnIdle { app.connectivity.value = false }
        val failures = CopyOnWriteArrayList<Long>()
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/artifact-bytes/summary") {
                failures.add(SystemClock.uptimeMillis())
                MockResponse().setResponseCode(503)
            } else respond(request)
        }
        compose.runOnIdle { app.connectivity.value = true }
        awaitText("Temporarily unable to load preview")

        compose.onNodeWithText(body, substring = true).assertIsDisplayed()
        compose.onNodeWithText("View source conversation").assertIsEnabled()
        assertEquals(originalBounds, surface.getUnclippedBoundsInRoot())
        assertEquals(3, failures.size)
        assertTrue(failures.zipWithNext().all { (first, next) -> next - first >= 3_000 })
        shadowOf(Looper.getMainLooper()).idleFor(12, TimeUnit.SECONDS)
        assertEquals(3, failures.size)

        val rejectedReferences = AtomicInteger()
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/artifact-references/artifacts2.md") {
                rejectedReferences.incrementAndGet()
                MockResponse().setResponseCode(403)
            } else respond(request)
        }
        compose.onNodeWithText("View source conversation").performClick()
        compose.onNodeWithContentDescription("Back to artifact preview").performClick()
        awaitText("You don’t have access to this artifact")
        compose.onNodeWithText(body, substring = true).assertDoesNotExist()
        compose.onNodeWithText("View source conversation").assertIsEnabled()
        assertEquals(1, rejectedReferences.get())
    }

    @Test
    fun missingWebsiteGrantKeepsTheFrameAndSourceWhenConnectivityDrops() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/host/sites/fixture/preview") {
                MockResponse().setResponseCode(404)
            } else respond(request)
        }
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.site.title)
        compose.onNodeWithText(fixture.site.title).performClick()
        awaitText("Source unavailable")
        val frame = compose.onNodeWithTag("artifact_preview_surface")
        val frameBounds = frame.getUnclippedBoundsInRoot()
        val source = compose.onNodeWithText("View source conversation")
        source.assertIsEnabled()

        compose.runOnIdle { app.connectivity.value = false }
        compose.waitUntil(10_000) { artifactModel.state.value.offline }
        compose.onNodeWithText("Source unavailable").assertIsDisplayed()
        compose.onNodeWithText("Temporarily unable to load preview").assertDoesNotExist()
        source.assertIsEnabled()
        assertEquals(frameBounds, frame.getUnclippedBoundsInRoot())
    }

    @Test
    fun missingWebsiteDocumentKeepsTheSourceStatusUntilReconnectReloads() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        openWebsite(fixture)
        val view = checkNotNull(websiteView())
        val frame = compose.onNodeWithTag("artifact_preview_surface")
        val frameBounds = frame.getUnclippedBoundsInRoot()
        failWebsiteDocument(view, 404)
        awaitText("Source unavailable")
        compose.mainClock.advanceTimeBy(6_000)
        assertNull(websiteView())
        assertEquals(1, fixture.requestedSiteGrants.size)
        assertEquals(frameBounds, frame.getUnclippedBoundsInRoot())
        val browser = compose.onNodeWithText("Open in browser")
        browser.assertIsEnabled()

        compose.runOnIdle { app.connectivity.value = false }
        compose.waitUntil(10_000) { artifactModel.state.value.offline }
        compose.onNodeWithText("Source unavailable").assertIsDisplayed()
        browser.assertDoesNotExist()
        assertEquals(frameBounds, frame.getUnclippedBoundsInRoot())

        compose.runOnIdle { app.connectivity.value = true }
        compose.waitUntil(10_000) { loadedWebsiteUrl() != null }
        assertEquals(2, fixture.requestedSiteGrants.size)
        compose.onNodeWithText("Source unavailable").assertDoesNotExist()
        browser.assertIsEnabled()
        assertEquals(frameBounds, frame.getUnclippedBoundsInRoot())
    }

    @Test
    fun websiteDenialSurvivesDisconnectionBeforeTheNextFrame() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        openWebsite(fixture)
        val view = checkNotNull(websiteView())
        val model = artifactModel
        val connectivity = app.connectivity
        val frame = compose.onNodeWithTag("artifact_preview_surface")
        val frameBounds = frame.getUnclippedBoundsInRoot()
        compose.mainClock.autoAdvance = false
        try {
            failWebsiteDocument(view, 403)
            compose.runOnIdle { connectivity.value = false }
            compose.waitUntil(10_000) { model.state.value.offline }
        } finally {
            compose.mainClock.autoAdvance = true
        }

        compose.onNodeWithText("You don’t have access to this artifact").assertIsDisplayed()
        compose.onNodeWithText("Open in browser").assertDoesNotExist()
        compose.onNodeWithText("View source conversation").assertIsEnabled()
        assertEquals(frameBounds, frame.getUnclippedBoundsInRoot())
    }

    @Test
    fun websiteGrantAndInitialDocumentShareTheRetryBudget() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val grantAttempts = AtomicInteger()
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (
                request.requestUrl?.encodedPath == "/api/host/sites/fixture/preview" &&
                    grantAttempts.incrementAndGet() == 1
            ) {
                MockResponse().setResponseCode(503)
            } else respond(request)
        }
        openWebsite(fixture)
        val first = checkNotNull(websiteView())
        val frame = compose.onNodeWithTag("artifact_preview_surface")
        val originalBounds = frame.getUnclippedBoundsInRoot()
        failWebsiteDocument(first)
        compose.waitUntil(10_000) { websiteView()?.let { it !== first } == true }
        val retry = checkNotNull(websiteView())
        assertEquals(fixture.requestedSiteGrants.single(), loadedWebsiteUrl())
        assertEquals(originalBounds, frame.getUnclippedBoundsInRoot())

        failWebsiteDocument(retry)
        awaitText("Temporarily unable to load preview")
        compose.mainClock.advanceTimeBy(6_000)
        assertNull(websiteView())
        assertEquals(2, grantAttempts.get())
        assertEquals(originalBounds, frame.getUnclippedBoundsInRoot())
        compose.onNodeWithText("View source conversation").assertIsEnabled()
        compose.onNodeWithText("Open in browser").assertIsEnabled()
    }

    @Test
    fun websiteDoesNotRetryNavigationAfterTheFirstDocumentCommits() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        openWebsite(fixture)
        val view = checkNotNull(websiteView())
        compose.runOnIdle {
            view.webViewClient.onPageCommitVisible(view, checkNotNull(shadowOf(view).lastLoadedUrl))
        }
        failWebsiteDocument(view)
        awaitText("Temporarily unable to load preview")
        compose.mainClock.advanceTimeBy(6_000)
        assertNull(websiteView())
        assertEquals(1, fixture.requestedSiteGrants.size)
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
            awaitText("Temporarily unable to load preview")
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
    @Config(qualifiers = "en-rUS-w720dp-h360dp")
    fun websitePreviewKeepsTheReadingPositionInAShortWindow() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.checklist.title)
        compose.onNodeWithTag("artifact_list").performScrollToNode(hasText(fixture.site.title))
        compose.onNodeWithText(fixture.site.title).performClick()

        val browser = compose.onNodeWithText("Open in browser")
        val surface = compose.onNodeWithTag("artifact_preview_surface")
        awaitText("Open in browser")
        val initialBounds = surface.getUnclippedBoundsInRoot()
        assertTrue(browser.getUnclippedBoundsInRoot().bottom <= initialBounds.top)
        scrollWebsitePreview()
        val readingBounds = surface.getUnclippedBoundsInRoot()
        assertTrue(readingBounds.top < initialBounds.top)

        compose.runOnIdle { app.connectivity.value = false }
        awaitText("Temporarily unable to load preview")
        browser.assertDoesNotExist()
        assertEquals(readingBounds, surface.getUnclippedBoundsInRoot())

        compose.runOnIdle { app.connectivity.value = true }
        awaitText("Open in browser")
        assertEquals(readingBounds, surface.getUnclippedBoundsInRoot())
    }

    @Test
    @Config(qualifiers = "en-rUS-w720dp-h360dp")
    fun inlineWebsiteKeepsTheReadingPositionWhileItsReconnectGrantIsPending() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        app.fixture.historyReply = "[${fixture.site.title}](https://fixture.okou.app/)"
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithText(fixture.sourceTitle).performClick()
        awaitText(fixture.site.title)
        compose.runOnIdle { app.connectivity.value = false }
        compose.onNodeWithText(fixture.site.title).performClick()

        val browser = compose.onNodeWithText("Open in browser")
        val surface = compose.onNodeWithTag("artifact_preview_surface")
        awaitText("Temporarily unable to load preview")
        val initialBounds = surface.getUnclippedBoundsInRoot()
        val width = initialBounds.right - initialBounds.left
        val height = initialBounds.bottom - initialBounds.top
        assertEquals(width.value * 9f / 16f, height.value, 1f)
        compose.onNodeWithTag("artifact_preview_title").assertTextContains("fixture.okou.app")
        browser.assertDoesNotExist()
        assertEquals(1, fixture.requestedSiteGrants.size)

        compose.runOnIdle { app.connectivity.value = true }
        compose.waitUntil(10_000) {
            fixture.requestedSiteGrants.size == 2 &&
                loadedWebsiteUrl() == fixture.requestedSiteGrants.last()
        }
        awaitText("Open in browser")
        assertEquals(initialBounds, surface.getUnclippedBoundsInRoot())
        assertTrue(browser.getUnclippedBoundsInRoot().bottom <= initialBounds.top)
        scrollWebsitePreview()
        val readingBounds = surface.getUnclippedBoundsInRoot()
        assertTrue(readingBounds.top < initialBounds.top)

        compose.runOnIdle { app.connectivity.value = false }
        awaitText("Temporarily unable to load preview")
        assertEquals(readingBounds, surface.getUnclippedBoundsInRoot())

        val releaseGrant = CountDownLatch(1)
        try {
            fixture.beforeSitePreview = { releaseGrant.await() }
            compose.runOnIdle { app.connectivity.value = true }
            compose.waitUntilExactlyOneExists(hasTestTag("artifact_preview_loading"), 10_000)
            compose.waitUntil(10_000) { fixture.requestedSiteGrants.size == 3 }
            browser.assertDoesNotExist()
            assertEquals(readingBounds, surface.getUnclippedBoundsInRoot())
        } finally {
            releaseGrant.countDown()
        }

        awaitText("Open in browser")
        assertEquals(readingBounds, surface.getUnclippedBoundsInRoot())
    }
}
