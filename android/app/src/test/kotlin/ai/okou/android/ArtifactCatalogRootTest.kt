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
import android.graphics.Bitmap
import android.graphics.Color
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
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
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
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
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
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pressKey
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
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
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

    protected fun resumeArtifactRoute() {
        val scenario = compose.activityRule.scenario
        scenario.moveToState(Lifecycle.State.CREATED)
        scenario.moveToState(Lifecycle.State.RESUMED)
    }

    protected fun assertToolbarTouchTarget(label: String) {
        val bounds = compose.onNodeWithContentDescription(label).fetchSemanticsNode().touchBoundsInRoot
        val minimum = with(compose.density) { 48.dp.roundToPx() }
        assertTrue("Touch bounds for $label: $bounds", bounds.width >= minimum && bounds.height >= minimum)
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

    protected fun failWebsiteDocument(
        view: WebView,
        status: Int = 503,
        retryAfter: String? = null,
    ) {
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
                WebResourceResponse(
                    "text/plain",
                    "UTF-8",
                    status,
                    "Unavailable",
                    retryAfter?.let { mapOf("retry-after" to it) }.orEmpty(),
                    null,
                )
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
    fun catalogReturnsFocusToTheNearestVisibleResultWhenTheOpenedImageIsRemoved() =
        verifyReturnAfterImageRemoval()

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    fun wideCatalogRestoresFocusWithoutReplacingTheVisibleList() = verifyReturnAfterImageRemoval()

    @Test
    fun recreatedCatalogReturnsToTheNearestResultWhenTheOpenedImageIsRemoved() =
        verifyReturnAfterImageRemoval(recreateActivity = true)

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h520dp")
    fun returningToAPartlyVisibleNeighborKeepsTheCatalogPosition() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            val fixture = ArtifactApiFixture(app.fixture, includeVideo = true)
            fixture.install()
            app.responseGate.countDown()
            awaitText(fixture.sourceTitle)
            compose.onNodeWithContentDescription("Artifacts").performClick()
            awaitText(fixture.checklist.title)

            val list = compose.onNodeWithTag("artifact_list")
            val opened = compose.onNodeWithText(fixture.image.title)
            list.performScrollToNode(hasText(fixture.image.title))
            opened.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            opened.performKeyInput { pressKey(Key.Enter) }
            compose.waitUntilExactlyOneExists(hasTestTag("artifact_image_toolbar"), 10_000)

            fixture.removedCatalogIds = setOf(fixture.image.id)
            resumeArtifactRoute()
            compose.waitUntil("refreshed catalog omits the original row", 10_000) {
                artifactModel.state.value.page?.items?.none { it.id == fixture.image.id } == true
            }
            val neighbor = compose.onNodeWithText(fixture.video.title)
            list.performScrollToNode(hasText(fixture.video.title))
            val viewportBottom = list.getUnclippedBoundsInRoot().bottom
            val neighborBounds = neighbor.getUnclippedBoundsInRoot()
            val visibleHeight = viewportBottom - neighborBounds.top
            list.performSemanticsAction(SemanticsActions.ScrollBy) {
                it(0f, with(compose.density) { (neighborBounds.height / 2 - visibleHeight).toPx() })
            }
            val before = neighbor.assertIsDisplayed().getUnclippedBoundsInRoot()
            assertTrue(before.top < viewportBottom && before.bottom > viewportBottom)

            compose.onNodeWithContentDescription("Back to artifacts").performClick()

            neighbor.assertIsFocused()
            assertEquals(before, neighbor.getUnclippedBoundsInRoot())
            opened.assertDoesNotExist()

            neighbor.performKeyInput { pressKey(Key.DirectionUp) }
            compose.onNodeWithText(fixture.slides.title).assertIsFocused().performKeyInput {
                pressKey(Key.DirectionDown)
            }
            assertTrue(
                neighbor.assertIsFocused().getUnclippedBoundsInRoot().bottom <= viewportBottom,
            )
        } finally {
            instrumentation.resetInTouchMode()
        }
    }

    private fun verifyReturnAfterImageRemoval(recreateActivity: Boolean = false) {
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
            awaitText(fixture.image.title)
            val opened = compose.onNodeWithText(fixture.image.title)
            opened.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            fun openImage() {
                opened.performKeyInput { pressKey(Key.Enter) }
                compose.waitUntilExactlyOneExists(hasTestTag("artifact_image_toolbar"), 10_000)
            }
            openImage()
            compose.onNodeWithContentDescription("Back to artifacts").performClick()
            opened.assertIsFocused()
            openImage()

            fixture.removedCatalogIds = setOf(fixture.image.id)
            if (recreateActivity) {
                compose.activityRule.scenario.recreate()
                compose.waitUntilExactlyOneExists(hasTestTag("artifact_image_toolbar"), 10_000)
            } else resumeArtifactRoute()
            compose.waitUntil("refreshed catalog omits the original row", 10_000) {
                artifactModel.state.value.page?.items?.none { it.id == fixture.image.id } == true
            }
            compose.onNodeWithContentDescription("Back to artifacts").performClick()

            val nearest = hasText(fixture.slides.title) and isFocused()
            compose.waitUntilExactlyOneExists(hasTestTag("artifact_row") and isFocused(), 10_000)
            compose.onNode(nearest).assertIsDisplayed().assertHeightIsAtLeast(72.dp)
            query.assertTextContains("launch").assertIsNotFocused()
            opened.assertDoesNotExist()
        } finally {
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun refreshedCatalogReplacesTheThumbnailWithoutMovingTheRow() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val original = Color.rgb(220, 190, 164)
        val replacement = Color.BLUE
        val requested = CountDownLatch(1)
        val release = CountDownLatch(1)
        fixture.imageResponse = {
            requested.countDown()
            check(release.await(10, TimeUnit.SECONDS))
            MockResponse().setBody(Buffer().write(fixture.sampleImage(replacement)))
        }
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.image.title)
        val row = compose.onNode(hasText(fixture.image.title) and hasTestTag("artifact_row"))
        val bounds = row.getUnclippedBoundsInRoot()
        fun thumbnailColor(): Int {
            val image = row.captureToImage().toPixelMap()
            return with(compose.density) { image[36.dp.roundToPx(), 36.dp.roundToPx()].toArgb() }
        }
        try {
            compose.waitUntil(5_000) { thumbnailColor() == original }
            val replacementUrl = app.fixture.server.url("/artifact-bytes/image-preview").toString()
            fixture.imageThumbnailUrl = replacementUrl
            resumeArtifactRoute()
            compose.waitUntil("replacement thumbnail in refreshed catalog", 5_000) {
                artifactModel.state.value.page
                    ?.items
                    ?.firstOrNull { it.id == fixture.image.id }
                    ?.thumbnail == replacementUrl
            }
            compose.waitUntil("replacement thumbnail request", 5_000) { requested.count == 0L }
            val fallback = thumbnailColor()
            assertTrue(fallback != original && fallback != replacement)
            assertEquals(bounds, row.getUnclippedBoundsInRoot())

            release.countDown()
            compose.waitUntil(5_000) { thumbnailColor() == replacement }
            assertEquals(bounds, row.getUnclippedBoundsInRoot())

            fixture.imageThumbnailUrl = null
            resumeArtifactRoute()
            compose.waitUntil(5_000) { thumbnailColor() == fallback }
            assertEquals(bounds, row.getUnclippedBoundsInRoot())
        } finally {
            release.countDown()
        }
    }

    @Test
    fun uncachedFiltersStartTheirOwnSkeletonDelay() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val release = CountDownLatch(1)
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/artifacts/catalog") release.await()
            respond(request)
        }
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        val skeletons = compose.onAllNodes(hasTestTag("artifact_row_skeleton"))
        compose.mainClock.autoAdvance = false
        try {
            compose.onNodeWithContentDescription("Artifacts").performClick()
            compose.mainClock.advanceTimeByFrame()
            compose.mainClock.advanceTimeBy(144)
            assertTrue(skeletons.fetchSemanticsNodes().isEmpty())

            compose.onNodeWithText("Images").performClick()
            compose.mainClock.advanceTimeByFrame()
            compose.mainClock.advanceTimeBy(144)
            assertTrue(skeletons.fetchSemanticsNodes().isEmpty())
            compose.mainClock.advanceTimeBy(144)
            assertTrue(skeletons.fetchSemanticsNodes().isNotEmpty())

            compose.onNodeWithText("Videos").performClick()
            compose.mainClock.advanceTimeByFrame()
            assertTrue(skeletons.fetchSemanticsNodes().isEmpty())
            compose.mainClock.advanceTimeBy(288)
            assertTrue(skeletons.fetchSemanticsNodes().isNotEmpty())
        } finally {
            release.countDown()
            compose.mainClock.autoAdvance = true
        }
        awaitText("No artifacts of this type")
        assertTrue(skeletons.fetchSemanticsNodes().isEmpty())
    }

    @Test
    @Config(qualifiers = "en-rUS-w720dp-h800dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun catalogSkeletonReservesRoomForLargeText() {
        val scale = RuntimeEnvironment.getFontScale()
        val releaseCatalog = CountDownLatch(1)
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.beforeCatalog = { check(releaseCatalog.await(10, TimeUnit.SECONDS)) }
        fixture.install()
        try {
            RuntimeEnvironment.setFontScale(2f)
            compose.activityRule.scenario.recreate()
            compose.activityRule.scenario.onActivity {
                assertEquals(2f, it.resources.configuration.fontScale, 0f)
            }
            app.responseGate.countDown()
            awaitText(fixture.sourceTitle)

            val skeletons = compose.onAllNodes(hasTestTag("artifact_row_skeleton"))
            compose.onNodeWithContentDescription("Artifacts").performClick()
            compose.waitUntil(5_000) { skeletons.fetchSemanticsNodes().isNotEmpty() }
            val first = skeletons[0].assertIsDisplayed().getUnclippedBoundsInRoot()
            assertTrue("Large-font skeleton height was ${first.height}", first.height > 80.dp)

            releaseCatalog.countDown()
            awaitText(fixture.checklist.title)
            assertTrue(skeletons.fetchSemanticsNodes().isEmpty())
        } finally {
            releaseCatalog.countDown()
            RuntimeEnvironment.setFontScale(scale)
        }
    }

    @Test
    fun firstCatalogReadRespectsRetryAfterAndReportsExhaustedRetries() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val release = CountDownLatch(1)
        val releaseRetry = CountDownLatch(1)
        val attempts = CopyOnWriteArrayList<Long>()
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/artifacts/catalog") {
                attempts.add(SystemClock.uptimeMillis())
                when (attempts.size) {
                    1 -> {
                        release.await()
                        MockResponse().setResponseCode(503).setHeader("Retry-After", "4")
                    }
                    2 -> {
                        releaseRetry.await()
                        MockResponse().setResponseCode(503)
                    }
                    else -> MockResponse().setResponseCode(503)
                }
            } else respond(request)
        }
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        val failureText = "Temporarily unable to load"
        val mainLooper = shadowOf(Looper.getMainLooper())
        val skeletons = compose.onAllNodes(hasTestTag("artifact_row_skeleton"))
        try {
            compose.onNodeWithContentDescription("Artifacts").performClick()
            compose.waitUntil(10_000) {
                attempts.size == 1 && skeletons.fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText(failureText).assertDoesNotExist()
            release.countDown()
            compose.waitUntil(10_000) {
                mainLooper.idleFor(250, TimeUnit.MILLISECONDS)
                assertTrue(skeletons.fetchSemanticsNodes().isNotEmpty())
                attempts.size == 2
            }
        } finally {
            release.countDown()
            releaseRetry.countDown()
        }
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
        val panel = compose.onNodeWithTag("artifact_read_failure").assertIsDisplayed()
        val bounds = panel.getUnclippedBoundsInRoot()
        val label =
            compose
                .onNodeWithText(failureText)
                .assertIsDisplayed()
                .assert(
                    SemanticsMatcher.expectValue(
                        SemanticsProperties.LiveRegion,
                        LiveRegionMode.Polite,
                    ),
                )
                .getUnclippedBoundsInRoot()
        assertTrue(abs(((label.left - bounds.left) - (bounds.right - label.right)).value) <= 1f)
        assertTrue(label.top > bounds.top)
        mainLooper.idleFor(12, TimeUnit.SECONDS)
        assertEquals(3, attempts.size)
        app.fixture.commandResponse = respond
        resumeArtifactRoute()
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
        val resourceBounds =
            try {
                openChatResources(fixture.sourceTitle)
                awaitText(item.title)
                refreshing.assertIsDisplayed()
                val progress = refreshing.getUnclippedBoundsInRoot()
                val bounds = resource.getUnclippedBoundsInRoot()
                assertTrue(progress.bottom <= bounds.top)
                bounds
            } finally {
                release.countDown()
            }
        val failure = "Temporarily unable to update. Showing loaded artifacts."
        awaitText(failure)
        resource.assertIsDisplayed()
        assertEquals(resourceBounds, resource.getUnclippedBoundsInRoot())
        val pane = compose.onNodeWithTag("chat_resources_list").getUnclippedBoundsInRoot()
        val snackbar = compose.onNodeWithTag("artifact_refresh_feedback").getUnclippedBoundsInRoot()
        assertEquals(8.dp, pane.bottom - snackbar.bottom)
        refreshing.assertDoesNotExist()
        assertEquals(
            item,
            runBlocking { cache.loadArtifactCatalog(CHAT_PERSONAL)?.page?.items?.single() },
        )
    }

    @Test
    fun recentlyConfirmedEmptyChatCatalogRemainsVisibleThroughRefreshFailure() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val release = CountDownLatch(1)
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/artifacts/catalog") {
                release.await()
                MockResponse().setResponseCode(400)
            } else respond(request)
        }
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
        val failure = "Temporarily unable to update. Showing loaded artifacts."
        awaitText(failure)
        compose.onNodeWithText("No artifacts yet").assertIsDisplayed()
        compose.onNodeWithTag("artifact_refresh_feedback").assertIsDisplayed()
        app.fixture.commandResponse = respond
        resumeArtifactRoute()
        awaitText(fixture.summary.title)
        compose.onNodeWithText("No artifacts yet").assertDoesNotExist()
        compose.onNodeWithText(failure).assertDoesNotExist()
    }

    @Test
    fun chatResourcesRestartsItsSkeletonDelayWhenTheReadIsReplaced() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val release = CountDownLatch(1)
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/artifacts/catalog")
                check(release.await(10, TimeUnit.SECONDS))
            respond(request)
        }
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        val realtime = app.realtimeService as TestRealtimeService
        val skeletons = compose.onAllNodes(hasTestTag("artifact_row_skeleton"))
        try {
            openChatResources(fixture.sourceTitle)
            val model = ready.chatArtifacts
            compose.waitUntil(5_000) { model.state.value.initialReadRound != null }
            compose.mainClock.autoAdvance = false
            compose.mainClock.advanceTimeBy(320)
            assertTrue(skeletons.fetchSemanticsNodes().isNotEmpty())
            val firstRound = model.state.value.initialReadRound
            realtime.invalidate(ChatChanges(artifactThreads = setOf(CHAT_PERSONAL)))
            compose.waitUntil(5_000) {
                model.state.value.initialReadRound?.let { it !== firstRound } == true
            }
            compose.mainClock.advanceTimeByFrame()
            assertTrue(skeletons.fetchSemanticsNodes().isEmpty())
        } finally {
            compose.mainClock.autoAdvance = true
            release.countDown()
        }
        awaitText(fixture.summary.title)
        assertTrue(skeletons.fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun workspaceRefreshFeedbackFollowsTheActiveFilter() {
        val fixture = ArtifactApiFixture(app.fixture, includeVideo = true)
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.summary.title)
        val respond = app.fixture.commandResponse
        val failRefresh = AtomicBoolean(true)
        app.fixture.commandResponse = { request ->
            if (
                request.requestUrl?.encodedPath == "/api/artifacts/catalog" &&
                    failRefresh.getAndSet(false)
            ) {
                MockResponse().setResponseCode(400)
            } else respond(request)
        }

        resumeArtifactRoute()
        val failure = "Temporarily unable to update. Showing loaded artifacts."
        awaitText(failure)
        compose.onNodeWithText(fixture.summary.title).assertIsDisplayed()
        compose.onNodeWithTag("artifact_refresh_feedback").assertIsDisplayed()

        compose.mainClock.advanceTimeBy(5_500L)
        compose.onNodeWithText(failure).assertDoesNotExist()
        failRefresh.set(true)
        resumeArtifactRoute()
        awaitText(failure)

        val videos = compose.onNodeWithText("Videos")
        videos.performClick()
        awaitText(fixture.video.title)
        videos.assertIsSelected()
        compose.onNodeWithText(failure).assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h380dp")
    fun chatResourcesResumesTheSameFailedPageAndEvictsOnConfirmedRevocation() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.pageSize = 3
        fixture.install()
        val realtime = app.realtimeService as TestRealtimeService
        val deny = AtomicBoolean(false)
        val appendRequests = AtomicInteger()
        val releaseFailure = CountDownLatch(1)
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            val url = request.requestUrl
            if (url?.encodedPath == "/api/artifacts/catalog" && deny.get()) {
                MockResponse().setResponseCode(403)
            } else if (
                url?.encodedPath == "/api/artifacts/catalog" &&
                    url.queryParameter("cursor") == "3" &&
                    appendRequests.incrementAndGet() == 1
            ) {
                check(releaseFailure.await(10, TimeUnit.SECONDS))
                MockResponse().setResponseCode(400)
            } else respond(request)
        }
        app.responseGate.countDown()
        val retained = compose.onNodeWithText(fixture.site.title)
        val before =
            try {
                openChatResources(fixture.sourceTitle)
                awaitText(fixture.summary.title)
                val list = compose.onNodeWithTag("chat_resources_list")
                list.performScrollToNode(hasTestTag("artifact_row_skeleton"))
                list.performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 500f) }
                retained.assertIsDisplayed().getUnclippedBoundsInRoot()
            } finally {
                releaseFailure.countDown()
            }
        val notice = "Temporarily unable to load more"
        awaitText(notice)
        assertEquals(before, retained.getUnclippedBoundsInRoot())
        assertEquals(
            12.dp,
            compose.onNodeWithText(notice).getUnclippedBoundsInRoot().top - before.bottom,
        )
        assertEquals(1, appendRequests.get())
        resumeArtifactRoute()
        awaitText(fixture.slides.title)
        assertEquals(2, appendRequests.get())
        assertEquals(before, retained.getUnclippedBoundsInRoot())
        compose.onNodeWithText(notice).assertDoesNotExist()

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
    @Config(qualifiers = "en-rUS-w400dp-h560dp")
    fun workspaceKeepsTheRetainedPageAndResumesItsFailedCursor() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.pageSize = 4
        fixture.install()
        val appendRequests = AtomicInteger()
        val releaseFailure = CountDownLatch(1)
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            val url = request.requestUrl
            if (
                url?.encodedPath == "/api/artifacts/catalog" &&
                    url.queryParameter("cursor") == "4" &&
                    appendRequests.incrementAndGet() == 1
            ) {
                check(releaseFailure.await(10, TimeUnit.SECONDS))
                MockResponse().setResponseCode(400)
            } else respond(request)
        }
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        val retained = compose.onNodeWithText(fixture.slides.title)
        val before =
            try {
                compose.onNodeWithContentDescription("Artifacts").performClick()
                awaitText(fixture.summary.title)
                val list = compose.onNodeWithTag("artifact_list")
                list.performScrollToNode(hasTestTag("artifact_row_skeleton"))
                list.performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 500f) }
                retained.assertIsDisplayed().getUnclippedBoundsInRoot()
            } finally {
                releaseFailure.countDown()
            }
        val notice = "Temporarily unable to load more"
        awaitText(notice)
        assertEquals(before, retained.getUnclippedBoundsInRoot())
        assertEquals(
            12.dp,
            compose.onNodeWithText(notice).getUnclippedBoundsInRoot().top - before.bottom,
        )
        assertEquals(1, appendRequests.get())
        resumeArtifactRoute()
        awaitText(fixture.image.title)
        assertEquals(2, appendRequests.get())
        assertEquals(before, retained.getUnclippedBoundsInRoot())
        compose.onNodeWithText(notice).assertDoesNotExist()
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
            workflows.releaseTitle = "   "
            val command = "release-review"
            val requestCount = AtomicInteger()
            val workflowVisible = AtomicBoolean(true)
            val respond = app.fixture.commandResponse
            app.fixture.commandResponse = { request ->
                when (request.requestUrl?.encodedPath) {
                    "/api/workflows" -> {
                        if (requestCount.incrementAndGet() == 1) firstRead.await()
                        if (workflowVisible.get()) respond(request) else jsonResponse("[]")
                    }
                    "/api/chat-threads/$CHAT_PERSONAL/relations/children",
                    "/api/chat-threads/$CHAT_PERSONAL/relations/communications" ->
                        jsonResponse("""{"items":[]}""")
                    else -> respond(request)
                }
            }
            installAutomationHistory()
            app.responseGate.countDown()
            awaitText(artifacts.sourceTitle)
            seedAutomationResources("   ")
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
            list.performScrollToNode(hasText("Workflows"))
            compose.onNode(hasText("Workflows") and hasClickAction()).assertIsDisplayed()
            compose.onNodeWithContentDescription("Syncing chat resources").assertIsDisplayed()
            firstRead.countDown()
            awaitText(command)
            compose.onNode(hasText("Workflows") and hasClickAction()).assertDoesNotExist()
            compose.onNodeWithText("Historical workflow title").assertDoesNotExist()
            // Measure after the independent related-chats section has settled.
            val chatResources = ready.chatArtifacts
            compose.waitUntil(10_000) {
                val related = chatResources.state.value.relatedChats.confirmed
                related?.created != null && related.communicating != null
            }
            val workflowRow = hasText(command) and hasAnyAncestor(hasTestTag("chat_resources_list"))
            list.performScrollToNode(hasText(command))
            val row = compose.onNode(workflowRow)
            row.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            val bounds = row.assertIsFocused().getUnclippedBoundsInRoot()
            row.performClick()
            awaitText(workflows.ruleTitle)
            compose.onNodeWithTag("workflow_tab_automations").assertIsSelected()
            compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
            compose.waitUntilExactlyOneExists(workflowRow and isFocused(), 10_000)
            assertEquals(bounds, row.assertIsFocused().getUnclippedBoundsInRoot())

            workflowVisible.set(false)
            (app.realtimeService as TestRealtimeService).invalidate()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText(command).fetchSemanticsNodes().isEmpty()
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
    fun emptyCatalogActionsRestoreFocusAndKeepTheSelectedTypeWhenClearing() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            val fixture = ArtifactApiFixture(app.fixture)
            fixture.install()
            app.responseGate.countDown()
            awaitText(fixture.sourceTitle)
            compose.onNodeWithContentDescription("Artifacts").performClick()
            awaitText(fixture.checklist.title)

            val files = compose.onNodeWithText("Files")
            val query = compose.onNodeWithTag("artifact_query")
            files.performClick()
            query.performTextReplacement("no matching artifact")
            awaitText("No matching artifacts")
            val title = compose.onNodeWithText("No matching artifacts", useUnmergedTree = true)
            val list = compose.onNodeWithTag("artifact_list").getUnclippedBoundsInRoot()
            assertEquals(28.dp, title.getUnclippedBoundsInRoot().left - list.left)
            clickCatalogEmptyAction("Clear keyword")
            awaitText(fixture.checklist.title)
            query.assertIsFocused()
            assertEquals(
                "",
                query.fetchSemanticsNode().config[SemanticsProperties.EditableText].text,
            )
            files.assertIsSelected()
            compose.onNodeWithText("Yesterday").assertIsDisplayed()

            compose.onNodeWithText("Videos").performClick()
            awaitText("No artifacts of this type")
            clickCatalogEmptyAction("Show all")
            awaitText(fixture.checklist.title)
            compose.onNodeWithText("All").assertIsSelected().assertIsFocused()
        } finally {
            instrumentation.resetInTouchMode()
        }
    }

    private fun clickCatalogEmptyAction(label: String) {
        val action = compose.onNodeWithText(label).assertHeightIsAtLeast(48.dp)
        val text = compose.onNodeWithText(label, useUnmergedTree = true)
        val layouts = mutableListOf<TextLayoutResult>()
        text.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        val style = layouts.single().layoutInput.style
        assertEquals(14.sp, style.fontSize)
        assertEquals(20.sp, style.lineHeight)
        assertEquals(FontWeight.Medium, style.fontWeight)
        val bounds = action.getUnclippedBoundsInRoot()
        val labelBounds = text.getUnclippedBoundsInRoot()
        val startInset = labelBounds.left - bounds.left
        val endInset = bounds.right - labelBounds.right
        assertTrue(startInset >= 12.dp)
        assertTrue(endInset >= 12.dp)
        assertTrue(abs((startInset - endInset).value) <= 1f)
        action.performClick()
    }

    @Test
    @Config(qualifiers = "en-rUS-w840dp-h820dp")
    fun wideCatalogRevealsKeyboardFiltersAndKeepsFocusOnTheActivatedResult() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            val fixture = ArtifactApiFixture(app.fixture, includeVideo = true)
            fixture.install()
            app.responseGate.countDown()
            awaitText(fixture.sourceTitle)
            compose.onNodeWithContentDescription("Artifacts").performClick()
            awaitText(fixture.checklist.title)

            val catalog = compose.onNodeWithTag("artifact_catalog").getUnclippedBoundsInRoot()
            val videos = compose.onNodeWithText("Videos")
            val filterEnd = catalog.right - 16.dp
            assertTrue(videos.getUnclippedBoundsInRoot().right > filterEnd)
            videos.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            assertTrue(videos.assertIsFocused().getUnclippedBoundsInRoot().right <= filterEnd)
            videos.performKeyInput { pressKey(Key.Enter) }
            awaitText(fixture.video.title)

            val row = compose.onNode(hasText(fixture.video.title) and hasClickAction())
            row.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            row.performKeyInput { pressKey(Key.Enter) }
            awaitText("Play")
            row.assertIsFocused().assertIsSelected()

            val all = compose.onNodeWithText("All")
            all.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            all.performKeyInput { pressKey(Key.Enter) }
            awaitText(fixture.checklist.title)
            compose.onNodeWithTag("artifact_preview_title").assertTextContains(fixture.video.title)
        } finally {
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
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
        val today = compose.onNodeWithText("Today").assertIsDisplayed().getUnclippedBoundsInRoot()
        val nextDay =
            compose.onNodeWithText("Yesterday").assertIsDisplayed().getUnclippedBoundsInRoot()
        val earlier =
            compose.onNodeWithText("Earlier").assertIsDisplayed().getUnclippedBoundsInRoot()
        assertEquals("Title bounds $title in row $first", 72.dp, first.height)
        assertTrue(title.top - first.top >= 10.dp)
        assertEquals(68.dp, title.left - first.left)
        assertEquals(4.dp, first.top - today.bottom)
        assertEquals(8.dp, nextDay.top - first.bottom)
        assertEquals(first.left + 16.dp, today.left)
        assertEquals(today.left, nextDay.left)
        assertEquals(today.left, earlier.left)
    }

    @Test
    fun catalogRegroupsExistingRowsWhenTheDeviceTimeZoneChanges() {
        val original = TimeZone.getDefault()
        val utcHour = Calendar.getInstance(TimeZone.getTimeZone("UTC")).get(Calendar.HOUR_OF_DAY)
        // Put the current time near 18:00 and the fixture's 10:20 entry before the new midnight.
        val hours = 18 - utcHour
        fun zone(offset: Int) = TimeZone.getTimeZone("GMT%+03d:00".format(Locale.ROOT, offset))
        try {
            TimeZone.setDefault(zone(hours))
            val fixture = ArtifactApiFixture(app.fixture)
            fixture.install()
            app.responseGate.countDown()
            awaitText(fixture.sourceTitle)
            compose.onNodeWithContentDescription("Artifacts").performClick()
            awaitText(fixture.checklist.title)
            compose.onNodeWithText("Today").assertIsDisplayed()
            val requests = fixture.catalogQueries.size

            compose.runOnIdle {
                TimeZone.setDefault(zone(hours - 12))
                app.sendBroadcast(Intent(Intent.ACTION_TIMEZONE_CHANGED))
            }
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("Today").fetchSemanticsNodes().isEmpty()
            }
            val yesterday = compose.onNodeWithText("Yesterday").getUnclippedBoundsInRoot()
            val row = compose.onNodeWithText(fixture.checklist.title).getUnclippedBoundsInRoot()
            assertTrue(row.top >= yesterday.bottom)
            assertEquals(requests, fixture.catalogQueries.size)
        } finally {
            TimeZone.setDefault(original)
        }
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
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
        compose.onNodeWithText(fixture.summary.title).assertHeightIsAtLeast(72.dp)
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
        assertEquals(FontWeight.Normal, titleStyle.fontWeight)
        compose.onNodeWithText("Save file").assertDoesNotExist()
        val sourceAction =
            compose.onNodeWithText("View source conversation").assertHeightIsAtLeast(48.dp)
        val sourceLabel = compose.onNodeWithText("View source conversation", useUnmergedTree = true)
        val labelLayouts = mutableListOf<TextLayoutResult>()
        sourceLabel.performSemanticsAction(SemanticsActions.GetTextLayoutResult) {
            it(labelLayouts)
        }
        val labelStyle = labelLayouts.single().layoutInput.style
        assertEquals(14.sp, labelStyle.fontSize)
        assertEquals(20.sp, labelStyle.lineHeight)
        assertEquals(
            42.dp,
            sourceLabel.getUnclippedBoundsInRoot().left -
                sourceAction.getUnclippedBoundsInRoot().left,
        )
        assertEquals(
            24.dp,
            sourceAction.getUnclippedBoundsInRoot().right -
                sourceLabel.getUnclippedBoundsInRoot().right,
        )
        sourceAction.performClick()
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
            compose.waitUntilExactlyOneExists(hasContentDescription(fixture.image.title), 10_000)
            compose.onNodeWithContentDescription("Back to artifacts").performClick()

            query.assertTextContains("launch").assertIsNotFocused()
            compose.onNodeWithText("Yesterday").assertDoesNotExist()
            assertEquals(rowBounds, image.assertIsFocused().getUnclippedBoundsInRoot())
        } finally {
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    fun touchBackFromAnArtifactKeepsTheDirectorySearchUnfocused() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(true)
        try {
            compose.activityRule.scenario.recreate()
            val fixture = ArtifactApiFixture(app.fixture)
            fixture.install()
            app.responseGate.countDown()
            awaitText(fixture.sourceTitle)
            compose.onNodeWithContentDescription("Artifacts").performClick()
            awaitText(fixture.summary.title)
            compose.onNodeWithText(fixture.summary.title).performClick()
            awaitText("Preview only", partial = true)

            compose.onNodeWithContentDescription("Back to artifacts").performClick()

            compose.onNodeWithTag("artifact_query").assertIsNotFocused()
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
        assertToolbarTouchTarget("Back to workspace")
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

        val previousPageRequests = fixture.catalogScopes.size
        val reopened = CountDownLatch(1)
        fixture.beforeCatalog = { reopened.await() }
        try {
            compose.onNodeWithContentDescription("Chat actions").performClick()
            compose.onNodeWithText("Chat resources").performClick()
            compose.onNodeWithText(fixture.slides.title).assertIsDisplayed()
        } finally {
            reopened.countDown()
        }
        compose.waitUntil(10_000) { fixture.catalogScopes.size > previousPageRequests }
        compose.onNodeWithText(fixture.slides.title).assertIsDisplayed()
    }

    @Test
    fun conversationCardOpensAnAuthorizedPreviewWithoutReadingTheCatalog() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            val fixture = ArtifactApiFixture(app.fixture, imageDownloadAllowed = true)
            fixture.install()
            fixture.installInlineHistory()
            app.fixture.historyReply +=
                "\n\n[${fixture.checklist.title}](/artifacts/checklist1.md) " +
                    "[${fixture.image.title}](/artifacts/thumbnail1.png)"
            app.responseGate.countDown()
            awaitText(fixture.sourceTitle)
            compose.onNodeWithText(fixture.sourceTitle).performClick()
            awaitText(fixture.image.title)

            val button = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button)
            val summary = compose.onNode(hasText(fixture.summary.title) and button)
            val checklist = compose.onNode(hasText(fixture.checklist.title) and button)
            val image = compose.onNode(hasText(fixture.image.title) and button)
            val intro = compose.onNodeWithText("The release summary is ready.")
            val summaryBounds = summary.assertHeightIsAtLeast(60.dp).getUnclippedBoundsInRoot()
            val checklistBounds = checklist.getUnclippedBoundsInRoot()
            assertEquals(12.dp, summaryBounds.top - intro.getUnclippedBoundsInRoot().bottom)
            assertEquals(8.dp, checklistBounds.top - summaryBounds.bottom)
            assertEquals(8.dp, image.getUnclippedBoundsInRoot().top - checklistBounds.bottom)
            assertTrue(fixture.requestedReferences.isEmpty())
            summary.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            summary.assertIsFocused().performKeyInput { pressKey(Key.Enter) }

            awaitText("Preview only", partial = true)
            compose.onNodeWithText("Artifact preview").assertIsDisplayed()
            compose.onNodeWithText("Save file").assertDoesNotExist()
            assertEquals(
                listOf("/api/artifact-references/artifacts2.md"),
                fixture.requestedReferences,
            )
            assertTrue(fixture.catalogScopes.isEmpty())
            compose.onNodeWithContentDescription("Back").performClick()
            awaitText(fixture.image.title)
            summary.assertIsFocused()

            image.performClick()
            compose.waitUntilExactlyOneExists(hasTestTag("artifact_image_toolbar"), 10_000)
            compose.onNodeWithContentDescription("Back").performClick()
            compose.waitUntilExactlyOneExists(hasText(fixture.image.title) and isFocused(), 10_000)
            assertTrue(fixture.catalogScopes.isEmpty())
        } finally {
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    fun adjacentArtifactCardsUseEightDpThroughMarkdownListsAndEarlierReplies() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        fixture.installInlineHistory()
        val note = "Additional material for the handoff."
        val handoff = "Release handoff notes"
        val latest =
            app.fixture.historyReply +
                "\n\n- [${fixture.checklist.title}](/artifacts/checklist1.md)" +
                "\n- [${fixture.image.title}](/artifacts/thumbnail1.png)" +
                "\n- $note\n- [$handoff](/artifacts/part000001.md)"
        val earlier =
            "[${fixture.site.title}](https://fixture.okou.app/)" +
                "\n\n[${fixture.slides.title}](/artifacts/launchdeck.pptx)"
        app.fixture.setHistoryEvents(
            CHAT_PERSONAL,
            listOf(
                historyEventWire(
                    "input",
                    17,
                    type = "input.prompt",
                    payload =
                        """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Review the release files"}]}}""",
                ),
                historyEventWire(
                    "earlier-output",
                    19,
                    payload = """{"content":${JsonPrimitive(earlier)}}""",
                ),
                historyEventWire(
                    "output",
                    23,
                    payload = """{"content":${JsonPrimitive(latest)}}""",
                ),
                historyEventWire(type = "run.completed", payload = "null"),
            ),
        )
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithText(fixture.sourceTitle).performClick()
        awaitText(fixture.slides.title)

        val labels =
            listOf(
                fixture.summary.title,
                fixture.checklist.title,
                fixture.image.title,
                note,
                handoff,
                fixture.site.title,
                fixture.slides.title,
            )
        val bounds = labels.map { label ->
            compose.onNodeWithText(label).getUnclippedBoundsInRoot()
        }
        assertEquals(
            listOf(8.dp, 8.dp, 12.dp, 12.dp, 8.dp, 8.dp),
            bounds.zipWithNext { above, below -> below.top - above.bottom },
        )
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
    fun uncachedDocumentKeepsTheSharedDelayBeforeShowingItsPlaceholder() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val releaseDocument = CountDownLatch(1)
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/artifact-bytes/summary") {
                check(releaseDocument.await(10, TimeUnit.SECONDS))
            }
            respond(request)
        }
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.summary.title)
        compose.mainClock.autoAdvance = false
        try {
            compose.onNodeWithText(fixture.summary.title).performClick()
            val placeholder = compose.onNodeWithTag("artifact_preview_loading")
            compose.mainClock.advanceTimeBy(160)
            placeholder.assertDoesNotExist()
            compose.mainClock.advanceTimeBy(160)
            placeholder.assertIsDisplayed()
        } finally {
            releaseDocument.countDown()
            compose.mainClock.autoAdvance = true
        }
        awaitText("Positioning: help teams move ongoing work forward", partial = true)
        compose.onNodeWithTag("artifact_preview_loading").assertDoesNotExist()
        assertTrue(fixture.requestedReferences.isNotEmpty())
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun unreadableImageShowsAPreviewFailureAndKeepsAuthorizedSave() {
        val fixture =
            ArtifactApiFixture(
                app.fixture,
                imageBody = "Invalid raster".encodeToByteArray(),
                imageDownloadAllowed = true,
            )
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.image.title)
        compose.onNodeWithText(fixture.image.title).performClick()
        awaitText("Temporarily unable to load image")
        compose.onNodeWithContentDescription("Image actions").performClick()
        compose.onNodeWithText("Save image").assertIsEnabled()
        val frame = compose.onNodeWithTag("artifact_preview_surface").getUnclippedBoundsInRoot()
        val status =
            compose.onNodeWithText("Temporarily unable to load image").getUnclippedBoundsInRoot()
        assertTrue(status.top >= frame.top && status.bottom <= frame.bottom)
    }

    @Test
    fun imagePreviewReservesItsFrameBeforeShowingLoadingAndAccessLoss() {
        val fixture =
            ArtifactApiFixture(
                app.fixture,
                imageBody = "Invalid thumbnail".encodeToByteArray(),
                imageDownloadAllowed = true,
            )
        val releaseImage = CountDownLatch(1)
        fixture.imageResponse = {
            check(releaseImage.await(10, TimeUnit.SECONDS))
            MockResponse().setResponseCode(403)
        }
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.image.title)

        val surface = compose.onNodeWithTag("artifact_preview_surface")
        val loading = compose.onNodeWithText("Loading image…")
        val toolbar = compose.onNodeWithTag("artifact_image_toolbar")
        compose.mainClock.autoAdvance = false
        val pendingFrame =
            try {
                compose.onNodeWithText(fixture.image.title).performClick()
                compose.mainClock.advanceTimeBy(160)
                val pending = surface.assertIsDisplayed().getUnclippedBoundsInRoot()
                loading.assertDoesNotExist()
                assertEquals(64.dp, toolbar.getUnclippedBoundsInRoot().height)
                assertEquals(toolbar.getUnclippedBoundsInRoot().bottom, pending.top)
                compose.mainClock.advanceTimeBy(160)
                loading.assertIsDisplayed()
                assertEquals(pending.height, surface.getUnclippedBoundsInRoot().height)
                compose.mainClock.autoAdvance = true
                compose.waitUntilExactlyOneExists(hasContentDescription("Image actions"), 10_000)
                assertToolbarTouchTarget("Back to artifacts")
                assertToolbarTouchTarget("Image actions")
                compose.onNodeWithContentDescription("Image actions").performClick()
                compose.onNodeWithText("Save image").assertIsEnabled()
                pending
            } finally {
                releaseImage.countDown()
                compose.mainClock.autoAdvance = true
            }
        awaitText("Image unavailable")
        assertEquals(pendingFrame, surface.getUnclippedBoundsInRoot())
        loading.assertDoesNotExist()
        compose.onNodeWithText("Save image").assertDoesNotExist()
        compose.onNodeWithContentDescription("Image actions").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1180dp-h820dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun wideImageKeepsItsZoomWhenExpandedAndCollapsed() {
        val fixture = ArtifactApiFixture(app.fixture, imageDownloadAllowed = true)
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.image.title)
        compose.onNodeWithText(fixture.image.title).performClick()
        compose.waitUntilExactlyOneExists(hasContentDescription(fixture.image.title), 10_000)

        val viewport = compose.onNodeWithTag("artifact_preview_surface")
        val paneWidth = viewport.getUnclippedBoundsInRoot().width
        val expand = compose.onNodeWithContentDescription("Expand image viewer")
        val menu = compose.onNodeWithContentDescription("Image actions")
        compose.waitUntilExactlyOneExists(hasContentDescription("Image actions"), 10_000)
        assertEquals(
            4.dp,
            menu.getUnclippedBoundsInRoot().left - expand.getUnclippedBoundsInRoot().right,
        )
        val image = compose.onNodeWithContentDescription(fixture.image.title)
        fun actions() = image.fetchSemanticsNode().config[SemanticsActions.CustomActions]
        val zoom = actions().single { it.label == "Zoom in" }
        compose.runOnIdle { assertTrue(zoom.action()) }
        compose.waitUntil(5_000) { actions().any { it.label == "Fit image" } }

        expand.performClick()
        assertTrue(viewport.getUnclippedBoundsInRoot().width > paneWidth)
        assertTrue(actions().any { it.label == "Fit image" })
        compose.onNodeWithContentDescription("Collapse image viewer").performClick()
        assertEquals(paneWidth, viewport.getUnclippedBoundsInRoot().width)
        assertTrue(actions().any { it.label == "Fit image" })
        image.performKeyInput { pressKey(Key.Zero) }
        compose.waitUntil(5_000) { actions().none { it.label == "Fit image" } }
        image.performTouchInput { doubleClick() }
        compose.waitUntil(5_000) { actions().any { it.label == "Fit image" } }
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun decodedOriginalKeepsZoomAndUsesTheFullViewportUntilFit() {
        val fixture = ArtifactApiFixture(app.fixture, imageDownloadAllowed = true)
        val original = Bitmap.createBitmap(512, 256, Bitmap.Config.ARGB_8888)
        val bytes = ByteArrayOutputStream()
        try {
            original.eraseColor(Color.rgb(20, 70, 220))
            assertTrue(original.compress(Bitmap.CompressFormat.PNG, 100, bytes))
        } finally {
            original.recycle()
        }
        val releaseOriginal = CountDownLatch(1)
        fixture.imageResponse = {
            releaseOriginal.await()
            MockResponse().setBody(Buffer().write(bytes.toByteArray()))
        }
        fixture.install()
        try {
            app.responseGate.countDown()
            awaitText(fixture.sourceTitle)
            compose.onNodeWithContentDescription("Artifacts").performClick()
            awaitText(fixture.image.title)
            compose.onNodeWithText(fixture.image.title).performClick()
            compose.waitUntilExactlyOneExists(hasContentDescription(fixture.image.title), 10_000)
            val image = compose.onNodeWithTag("artifact_image_transform")
            val fitInset = with(compose.density) { 16.dp.roundToPx() }
            fun actions() = image.fetchSemanticsNode().config[SemanticsActions.CustomActions]
            fun blueAt(x: (Int) -> Int): Boolean {
                val frame = image.captureToImage()
                val pixel = frame.toPixelMap()[x(frame.width), frame.height / 2]
                return pixel.blue > 0.75f && pixel.red < 0.2f
            }
            assertTrue(!blueAt { it / 2 })
            image.performTouchInput { doubleClick() }
            compose.waitUntil(5_000) { actions().any { it.label == "Fit image" } }
            releaseOriginal.countDown()

            compose.waitUntil(10_000) {
                actions().any { it.label == "Fit image" } && blueAt { fitInset / 2 }
            }
            image.performKeyInput { pressKey(Key.Zero) }
            compose.waitUntil(5_000) { actions().none { it.label == "Fit image" } }
            assertTrue(!blueAt { fitInset / 2 })
            assertTrue(blueAt { fitInset + 4 })
            assertTrue(fixture.requestedDownloads.isEmpty())
        } finally {
            releaseOriginal.countDown()
        }
    }

    @Test
    fun missingOriginalKeepsAnAuthorizedThumbnailAndRemovesOriginalActions() {
        val fixture = ArtifactApiFixture(app.fixture, imageDownloadAllowed = true)
        val releaseOriginal = CountDownLatch(1)
        val authorityRead = CountDownLatch(1)
        val releaseAuthority = CountDownLatch(1)
        val originalMissing = AtomicBoolean()
        fixture.imageResponse = {
            releaseOriginal.await()
            originalMissing.set(true)
            MockResponse().setResponseCode(404)
        }
        fixture.install()
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (
                request.requestUrl?.encodedPath == "/artifact-bytes/image" && originalMissing.get()
            ) {
                authorityRead.countDown()
                releaseAuthority.await()
            }
            respond(request)
        }
        try {
            app.responseGate.countDown()
            awaitText(fixture.sourceTitle)
            compose.onNodeWithContentDescription("Artifacts").performClick()
            awaitText(fixture.image.title)
            compose.onNodeWithText(fixture.image.title).performClick()
            val actions = compose.onNodeWithContentDescription("Image actions")
            compose.waitUntilExactlyOneExists(hasContentDescription("Image actions"), 10_000)
            compose.waitUntilExactlyOneExists(hasContentDescription(fixture.image.title), 10_000)

            releaseOriginal.countDown()
            compose.waitUntilDoesNotExist(hasContentDescription("Image actions"), 10_000)
            compose.waitUntilDoesNotExist(hasContentDescription(fixture.image.title), 10_000)
            releaseAuthority.countDown()
            awaitText("Original image unavailable")
            assertEquals(0L, authorityRead.count)
            compose.onNodeWithContentDescription(fixture.image.title).assertIsDisplayed()
            actions.assertDoesNotExist()
            compose.onNodeWithText("Image unavailable").assertDoesNotExist()
            assertTrue(fixture.requestedDownloads.isEmpty())
        } finally {
            releaseOriginal.countDown()
            releaseAuthority.countDown()
        }
    }

    @Test
    fun showsIndependentThumbnailBeforeOriginalGrantAndAfterReauthorization() {
        val fixture = ArtifactApiFixture(app.fixture, imageDownloadAllowed = true)
        fixture.install()
        val requestedGrant = CountDownLatch(1)
        val releaseGrant = CountDownLatch(1)
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/artifact-references/thumbnail1.png") {
                requestedGrant.countDown()
                check(releaseGrant.await(10, TimeUnit.SECONDS))
                jsonResponse("""{"error":{"code":"NOT_FOUND","message":"Artifact unavailable"}}""")
                    .setResponseCode(404)
            } else respond(request)
        }

        try {
            app.responseGate.countDown()
            awaitText(fixture.sourceTitle)
            compose.onNodeWithContentDescription("Artifacts").performClick()
            awaitText(fixture.image.title)
            compose.onNodeWithText(fixture.image.title).performClick()
            compose.onNodeWithTag("artifact_image_toolbar").assertIsDisplayed()
            compose.waitUntil(5_000) { compose.runOnIdle { requestedGrant.count == 0L } }
            compose.waitUntilExactlyOneExists(hasContentDescription(fixture.image.title), 5_000)
            compose.onNodeWithText("Loading image…").assertDoesNotExist()
            compose.onNodeWithContentDescription("Image actions").assertDoesNotExist()
        } finally {
            releaseGrant.countDown()
        }
        awaitText("Original image unavailable")
        compose.onNodeWithContentDescription(fixture.image.title).assertIsDisplayed()
        compose.onNodeWithContentDescription("Image actions").assertDoesNotExist()
    }

    @Test
    fun openingAnImageFromSearchReadsAnOriginalUsedAsItsOwnThumbnailOnce() {
        val fixture =
            ArtifactApiFixture(
                app.fixture,
                imageDownloadAllowed = true,
                imageThumbnailUrl = "/artifacts/thumbnail1.png",
            )
        fixture.install()
        val imageReads = AtomicInteger()
        val release = CountDownLatch(1)
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/artifact-bytes/image-preview") {
                imageReads.incrementAndGet()
                check(release.await(10, TimeUnit.SECONDS))
            }
            respond(request)
        }

        try {
            app.responseGate.countDown()
            awaitText(fixture.sourceTitle)
            compose.onNodeWithContentDescription("Search workspace").performClick()
            compose.onNodeWithTag("search_type_Artifacts").performClick()
            compose.onNodeWithTag("chat_search_query").performTextReplacement("avatar")
            val row = hasText(fixture.image.title) and hasClickAction()
            compose.waitUntilExactlyOneExists(row, 10_000)
            compose.onNode(row).performClick()
            awaitText("Loading image…")
            release.countDown()
            compose.waitUntilExactlyOneExists(hasContentDescription(fixture.image.title), 10_000)
            assertEquals(1, imageReads.get())
        } finally {
            release.countDown()
        }
    }

    @Test
    fun mediaStartsOnlyAfterPlayAndKeepsItsFrameWhenPlaybackFails() {
        val videoTitle = openVideoPreview()

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
        compose.onNodeWithText(videoTitle).assertIsDisplayed()
        compose.onNodeWithText("Videos").assertIsSelected()
    }

    @Test
    fun mediaDoesNotStartWhenThePlayFrameArrivesAfterPause() {
        openVideoPreview()
        val scenario = compose.activityRule.scenario
        compose.mainClock.autoAdvance = false
        try {
            compose.onNodeWithText("Play").performClick()
            assertNull(compose.runOnIdle { compose.activity.window.decorView.videoPreview() })
            scenario.moveToState(Lifecycle.State.STARTED)
            compose.mainClock.advanceTimeByFrame()
            val view =
                checkNotNull(
                    compose.runOnIdle { compose.activity.window.decorView.videoPreview() },
                )
            compose.runOnIdle { assertTrue(!view.isPlaying) }
            scenario.moveToState(Lifecycle.State.RESUMED)
            compose.runOnIdle { assertTrue(!view.isPlaying) }
        } finally {
            compose.mainClock.autoAdvance = true
        }
    }

    private fun openVideoPreview(): String {
        val fixture = ArtifactApiFixture(app.fixture, includeVideo = true)
        fixture.install()
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        compose.onNodeWithText("Videos").performClick()
        awaitText(fixture.video.title)
        compose.onNodeWithText(fixture.video.title).performClick()
        awaitText("Play")
        return fixture.video.title
    }

    private fun View.videoPreview(): VideoView? =
        when (this) {
            is VideoView -> this
            is ViewGroup -> children.firstNotNullOfOrNull { it.videoPreview() }
            else -> null
        }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun cachedDocumentAndImageStayReadableWhileTheirRefreshIsPending() {
        // Viewing a thumbnail alone does not populate the decoded preview cache.
        val fixture = ArtifactApiFixture(app.fixture).apply { imageThumbnailUrl = null }
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

        val release = CountDownLatch(1)
        val imageRefresh = CountDownLatch(1)
        val documentRefresh = CountDownLatch(1)
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            val refresh =
                when (request.requestUrl?.encodedPath) {
                    "/api/artifacts/catalog/${fixture.image.id}" -> imageRefresh
                    "/api/artifacts/catalog/${fixture.summary.id}" -> documentRefresh
                    else -> null
                }
            if (refresh != null) {
                refresh.countDown()
                release.await()
            }
            respond(request)
        }
        try {
            compose.onNodeWithText(fixture.image.title).performClick()
            compose.waitUntil("image refresh requested", 10_000) { imageRefresh.count == 0L }
            compose.onNodeWithContentDescription(fixture.image.title).assertIsDisplayed()
            backToCatalog.performClick()

            compose.onNodeWithText(fixture.summary.title).performClick()
            compose.waitUntil("document refresh requested", 10_000) { documentRefresh.count == 0L }
            compose.onNodeWithText(documentText, substring = true).assertIsDisplayed()
        } finally {
            release.countDown()
        }
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
        val failures = CopyOnWriteArrayList<Long>()
        val respond = app.fixture.commandResponse
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/artifact-bytes/summary") {
                failures.add(SystemClock.uptimeMillis())
                MockResponse().setResponseCode(503)
            } else respond(request)
        }
        resumeArtifactRoute()
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
    fun missingWebsiteGrantKeepsTheFrameAndSourceAcrossForegrounding() {
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

        resumeArtifactRoute()
        awaitText("Source unavailable")
        compose.onNodeWithText("Temporarily unable to load preview").assertDoesNotExist()
        source.assertIsEnabled()
        assertEquals(frameBounds, frame.getUnclippedBoundsInRoot())
    }

    @Test
    fun missingWebsiteDocumentKeepsTheSourceStatusUntilForegroundRefresh() {
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

        resumeArtifactRoute()
        compose.waitUntil(10_000) { loadedWebsiteUrl() != null }
        assertEquals(2, fixture.requestedSiteGrants.size)
        compose.onNodeWithText("Source unavailable").assertDoesNotExist()
        browser.assertIsEnabled()
        assertEquals(frameBounds, frame.getUnclippedBoundsInRoot())
    }

    @Test
    fun websiteDocumentDenialKeepsTheFrameAndSourceAction() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        openWebsite(fixture)
        val view = checkNotNull(websiteView())
        val frame = compose.onNodeWithTag("artifact_preview_surface")
        val frameBounds = frame.getUnclippedBoundsInRoot()
        failWebsiteDocument(view, 403)
        awaitText("You don’t have access to this artifact")
        assertNull(websiteView())

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
        compose.mainClock.autoAdvance = false
        val retry =
            try {
                failWebsiteDocument(first, retryAfter = "1")
                compose.mainClock.advanceTimeBy(750)
                val waiting = websiteView()
                assertTrue(waiting == null || waiting === first)
                compose.mainClock.advanceTimeUntil(1_250) {
                    websiteView()?.let { it !== first } == true
                }
                checkNotNull(websiteView())
            } finally {
                compose.mainClock.autoAdvance = true
            }
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
    fun websiteKeepsLoadingAcrossTheGrantAndStopsRetryingAfterTheFirstDocumentIsVisible() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        val releaseGrant = CountDownLatch(1)
        fixture.beforeSitePreview = { check(releaseGrant.await(10, TimeUnit.SECONDS)) }
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithContentDescription("Artifacts").performClick()
        awaitText(fixture.site.title)
        val placeholder = compose.onNodeWithTag("artifact_preview_loading")
        val frame = compose.onNodeWithTag("artifact_preview_surface")
        val view =
            try {
                compose.mainClock.autoAdvance = false
                compose.onNodeWithText(fixture.site.title).performClick()
                compose.mainClock.advanceTimeBy(160)
                placeholder.assertDoesNotExist()
                compose.mainClock.advanceTimeBy(160)
                placeholder.assertIsDisplayed()
                compose.waitUntil(10_000) {
                    compose.mainClock.advanceTimeByFrame()
                    compose
                        .onAllNodesWithText("View source conversation")
                        .fetchSemanticsNodes()
                        .isNotEmpty()
                }
                val bounds = frame.getUnclippedBoundsInRoot()
                assertNull(websiteView())

                releaseGrant.countDown()
                compose.waitUntil(10_000) {
                    compose.mainClock.advanceTimeByFrame()
                    loadedWebsiteUrl() != null
                }
                val web = checkNotNull(websiteView())
                placeholder.assertIsDisplayed()
                assertEquals(bounds, frame.getUnclippedBoundsInRoot())
                compose.runOnIdle {
                    assertEquals(0f, web.alpha, 0f)
                    val url = checkNotNull(shadowOf(web).lastLoadedUrl)
                    web.webViewClient.onPageCommitVisible(web, url)
                    web.scrollTo(0, 48)
                    web.webViewClient.onPageFinished(web, url)
                    assertEquals(1f, web.alpha, 0f)
                    assertEquals(48, web.scrollY)
                    web.scrollTo(0, 72)
                    web.webViewClient.onPageFinished(web, url)
                    assertEquals(72, web.scrollY)
                }
                compose.mainClock.autoAdvance = true
                compose.waitUntilDoesNotExist(hasTestTag("artifact_preview_loading"), 5_000)
                assertEquals(bounds, frame.getUnclippedBoundsInRoot())
                web
            } finally {
                releaseGrant.countDown()
                compose.mainClock.autoAdvance = true
            }
        val bounds = frame.getUnclippedBoundsInRoot()
        failWebsiteDocument(view)
        awaitText("Temporarily unable to load preview")
        assertEquals(bounds, frame.getUnclippedBoundsInRoot())
        compose.onNodeWithText("View source conversation").assertIsEnabled()
        compose.mainClock.advanceTimeBy(6_000)
        assertNull(websiteView())
        assertEquals(1, fixture.requestedSiteGrants.size)
    }

    @Test
    fun websiteRefreshKeepsItsFrameAndSourceWhileCheckingAccess() {
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

            val initialUrl = loadedWebsiteUrl()
            val initialView = checkNotNull(websiteView())
            compose.runOnIdle {
                initialView.webViewClient.onPageCommitVisible(initialView, checkNotNull(initialUrl))
                initialView.scrollTo(0, 48)
            }
            source.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            source.assertIsFocused()

            fixture.beforeSitePreview = { releaseGrant.await() }
            val model = artifactModel
            compose.runOnIdle {
                model.setActive(false)
                model.setActive(true)
            }
            compose.waitUntil(10_000) {
                // Let the detail response reach the main owner before the grant request begins.
                shadowOf(Looper.getMainLooper()).idle()
                fixture.requestedSiteGrants.size == 2
            }
            assertEquals(initialUrl, loadedWebsiteUrl())
            assertEquals(surfaceBounds, surface.getUnclippedBoundsInRoot())
            assertEquals(sourceBounds, source.assertIsFocused().getUnclippedBoundsInRoot())

            releaseGrant.countDown()
            compose.waitUntil(10_000) { loadedWebsiteUrl() == fixture.requestedSiteGrants.last() }
            val refreshedView = checkNotNull(websiteView())
            compose.runOnIdle {
                val url = fixture.requestedSiteGrants.last()
                refreshedView.webViewClient.onPageCommitVisible(refreshedView, url)
                refreshedView.webViewClient.onPageFinished(refreshedView, url)
                assertEquals(48, refreshedView.scrollY)
            }
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
        compose.waitUntil(10_000) { loadedWebsiteUrl() != null }
        val initialBounds = surface.getUnclippedBoundsInRoot()
        assertTrue(browser.getUnclippedBoundsInRoot().bottom <= initialBounds.top)
        scrollWebsitePreview()
        val readingBounds = surface.getUnclippedBoundsInRoot()
        assertTrue(readingBounds.top < initialBounds.top)

        failWebsiteDocument(checkNotNull(websiteView()), 404)
        awaitText("Source unavailable")
        assertEquals(readingBounds, surface.getUnclippedBoundsInRoot())

        resumeArtifactRoute()
        compose.waitUntil(10_000) { loadedWebsiteUrl() != null }
        assertEquals(readingBounds, surface.getUnclippedBoundsInRoot())
    }

    @Test
    @Config(qualifiers = "en-rUS-w720dp-h360dp")
    fun inlineWebsiteKeepsTheReadingPositionWhileItsGrantRefreshes() {
        val fixture = ArtifactApiFixture(app.fixture)
        fixture.install()
        app.fixture.historyReply = "[${fixture.site.title}](https://fixture.okou.app/)"
        app.responseGate.countDown()
        awaitText(fixture.sourceTitle)
        compose.onNodeWithText(fixture.sourceTitle).performClick()
        awaitText(fixture.site.title)
        compose.onNodeWithText(fixture.site.title).performClick()

        val browser = compose.onNodeWithText("Open in browser")
        val surface = compose.onNodeWithTag("artifact_preview_surface")
        compose.waitUntil(10_000) { loadedWebsiteUrl() != null }
        val firstUrl = loadedWebsiteUrl()
        val initialBounds = surface.getUnclippedBoundsInRoot()
        val width = initialBounds.right - initialBounds.left
        val height = initialBounds.bottom - initialBounds.top
        assertEquals(width.value * 9f / 16f, height.value, 1f)
        assertTrue(browser.getUnclippedBoundsInRoot().bottom <= initialBounds.top)
        scrollWebsitePreview()
        val readingBounds = surface.getUnclippedBoundsInRoot()
        assertTrue(readingBounds.top < initialBounds.top)

        val releaseGrant = CountDownLatch(1)
        try {
            fixture.beforeSitePreview = { releaseGrant.await() }
            resumeArtifactRoute()
            compose.waitUntil(10_000) { fixture.requestedSiteGrants.size == 2 }
            assertEquals(firstUrl, loadedWebsiteUrl())
            assertEquals(readingBounds, surface.getUnclippedBoundsInRoot())
        } finally {
            releaseGrant.countDown()
        }

        compose.waitUntil(10_000) { loadedWebsiteUrl() == fixture.requestedSiteGrants.last() }
        assertEquals(readingBounds, surface.getUnclippedBoundsInRoot())
    }
}
