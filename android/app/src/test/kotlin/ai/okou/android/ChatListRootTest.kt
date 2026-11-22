package ai.okou.android

import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ChatChanges
import ai.okou.android.chat.ChatRowAction
import android.os.Looper
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.test.ComposeUiTestConfig
import androidx.compose.ui.test.MouseButton
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.click
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performMouseInput
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.swipe
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Job
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

class ChatListApplication : TestOkouApplication() {
    lateinit var fixture: ChatListApiFixture
    lateinit var cacheSnapshot: ChatCacheSnapshot
    val responseGate = CountDownLatch(1)

    override fun onCreate() {
        fixture = ChatListApiFixture()
        fixture.beforeResponse = { responseGate.await() }
        chatService = fixture.service
        cacheSnapshot = ChatCacheSnapshot(noBackupFilesDir.resolve("chat-list"), chatCache)
        super.onCreate()
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = ChatListApplication::class)
class ChatListRootTest {
    private val animationScale = mutableFloatStateOf(1f)
    private val motion =
        object : MotionDurationScale {
            override val scaleFactor: Float
                get() = animationScale.floatValue
        }

    @get:Rule val compose = createAndroidComposeRule<MainActivity>(ComposeUiTestConfig(motion))
    private var chatJob: Job? = null

    @Before
    fun retainActualOwnerForTeardown() {
        compose.onNodeWithContentDescription("Chats").assertExists()
        compose.runOnIdle {
            chatJob =
                checkNotNull(
                        ViewModelProvider(compose.activity)[SessionModel::class.java]
                            .uiState
                            .value
                            .ready
                    )
                    .chats
                    .viewModelScope
                    .coroutineContext[Job]
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun inPlaceRowMenuActionReturnsFocusToItsKeyboardTrigger() {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        compose.activityRule.scenario.recreate()
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        val target = hasTestTag("chat_$CHAT_PERSONAL")
        compose.onNodeWithTag("chat_list").performScrollToNode(target)
        val row = compose.onNode(target)
        row.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        row.performKeyInput { pressKey(Key.Menu) }
        compose.onNodeWithText("Pin chat").performClick()
        row.assertIsFocused()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun projectToggleReflowsFollowingRowsWhileKeepingItsKeyboardFocus() {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        compose.activityRule.scenario.recreate()
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        val expansion =
            compose.runOnIdle {
                checkNotNull(
                        ViewModelProvider(compose.activity)[SessionModel::class.java]
                            .uiState
                            .value
                            .ready
                    )
                    .projectExpansion
            }
        compose.waitUntil(10_000) { expansion.state.value.expandedIds != null }
        val heading = hasText("Research")
        val project = compose.onNode(heading)
        val followingChat = compose.onNodeWithTag("chat_$CHAT_PERSONAL")
        project.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
        val header = project.getUnclippedBoundsInRoot()
        val collapsedTop = followingChat.getUnclippedBoundsInRoot().top
        compose.mainClock.autoAdvance = false
        try {
            fun toggle(key: Key, newAction: SemanticsPropertyKey<*>) {
                project.performKeyInput { pressKey(key) }
                val updated = heading.and(SemanticsMatcher.keyIsDefined(newAction))
                compose.waitUntil(10_000) {
                    compose.mainClock.advanceTimeByFrame()
                    compose.onAllNodes(updated).fetchSemanticsNodes().isNotEmpty()
                }
                compose.mainClock.advanceTimeBy(64)
                project.assertIsFocused()
                assertEquals(header, project.getUnclippedBoundsInRoot())
            }

            toggle(Key.Enter, SemanticsActions.Collapse)
            val openingTop = followingChat.getUnclippedBoundsInRoot().top
            compose.mainClock.advanceTimeBy(250)
            val expandedTop = followingChat.getUnclippedBoundsInRoot().top
            assertTrue(
                "Opening row is in motion: $collapsedTop, $openingTop, $expandedTop",
                openingTop > collapsedTop && openingTop < expandedTop,
            )

            val child = compose.onNodeWithTag("chat_$CHAT_IN_PROJECT").getUnclippedBoundsInRoot()
            assertEquals(24f, (child.left - header.left).value, 1f)
            assertEquals(52f, (child.bottom - child.top).value, 1f)

            toggle(Key.Spacebar, SemanticsActions.Expand)
            val closingTop = followingChat.getUnclippedBoundsInRoot().top
            assertTrue(
                "Closing row is in motion: $collapsedTop, $closingTop, $expandedTop",
                closingTop > collapsedTop && closingTop < expandedTop,
            )
            compose.mainClock.advanceTimeBy(250)
            assertEquals(collapsedTop, followingChat.getUnclippedBoundsInRoot().top)
            compose.onNodeWithTag("chat_$CHAT_IN_PROJECT").assertDoesNotExist()

            compose.runOnIdle { animationScale.floatValue = 0f }
            toggle(Key.Enter, SemanticsActions.Collapse)
            assertEquals(expandedTop, followingChat.getUnclippedBoundsInRoot().top)
        } finally {
            compose.mainClock.autoAdvance = true
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w320dp-h800dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun workspaceToolEntriesAreVisibleWithArtifactsEnabled() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        val labels = listOf("Workflows", "Connectors", "Artifacts")
        val entries =
            labels.map {
                val entry = compose.onNodeWithContentDescription(it).assertIsDisplayed()
                if (it == "Artifacts") entry.assertIsEnabled()
                else entry.assertIsNotEnabled().assertHasNoClickAction()
                entry
            }
        val search = compose.onNodeWithContentDescription("Search workspace")
        val searchBounds = search.getUnclippedBoundsInRoot()
        val entryBounds = entries.map { it.getUnclippedBoundsInRoot() }
        assertTrue(entryBounds.all { it.top >= searchBounds.bottom && it.bottom - it.top >= 48.dp })
        assertTrue(entryBounds.zipWithNext().all { (start, end) -> start.right < end.left })
        for ((label, bounds) in labels.zip(entryBounds)) {
            val title = compose.onNodeWithText(label, useUnmergedTree = true)
            val titleBounds = title.getUnclippedBoundsInRoot()
            val layouts = mutableListOf<TextLayoutResult>()
            title.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            assertEquals(1, layouts.single().lineCount)
            assertEquals(
                (bounds.top + bounds.bottom).value / 2,
                (titleBounds.top + titleBounds.bottom).value / 2,
                1f,
            )
        }
        search.performClick()
        entries.forEach { it.assertDoesNotExist() }
        compose.onNodeWithContentDescription("Back").performClick()
        entries.forEach { it.assertIsDisplayed() }
    }

    @Test
    @Config(qualifiers = "en-rUS-w280dp-h800dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun connectorLabelFitsOnTheNarrowChatList() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        val connectorLabel = "Connectors"
        val connectorLayouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(connectorLabel, useUnmergedTree = true).performSemanticsAction(
            SemanticsActions.GetTextLayoutResult
        ) {
            it(connectorLayouts)
        }
        val connectorLayout = connectorLayouts.single()
        assertEquals(1, connectorLayout.lineCount)
        assertEquals(connectorLabel.length, connectorLayout.getLineEnd(0, visibleEnd = true))
        assertTrue(connectorLayout.size.width >= connectorLayout.multiParagraph.maxIntrinsicWidth)
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun titleSearchRestoresTheQueryAfterOpeningAnArchivedChatAndRecreating() {
        val app = compose.activity.application as ChatListApplication
        app.fixture.events = { request ->
            if (request.requestUrl?.queryParameter("sinceSeqId") != null) {
                jsonResponse("""{"events":[],"hasMore":false}""")
            } else {
                val project =
                    chatEventWire(
                        id = "77777777-7777-4777-8777-777777777777",
                        seq = 23,
                        thread = CHAT_IN_PROJECT,
                        extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                        title = "Project chat",
                    )
                val archived =
                    chatEventWire(
                        id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                        seq = 24,
                        thread = CHAT_IN_PROJECT,
                        kind = "archived",
                    )
                jsonResponse(
                    """{"events":[${chatEventWire()},$project,$archived],"hasMore":false}"""
                )
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val entry = compose.onNodeWithTag("workspace_search_entry")
        val logo = compose.onNodeWithTag("workspace_search_leading")
        val initialBounds = entry.getUnclippedBoundsInRoot()
        assertEquals(8.dp, initialBounds.left - logo.getUnclippedBoundsInRoot().right)
        entry.performClick()
        val inputBounds = compose.onNodeWithTag("chat_search_query").getUnclippedBoundsInRoot()
        assertEquals(initialBounds.left, inputBounds.left)
        assertEquals(initialBounds.bottom - initialBounds.top, inputBounds.bottom - inputBounds.top)
        compose.onNodeWithText("Recent chats").assertExists()
        compose.onNodeWithTag("chat_search_query").performTextInput("project")
        compose.onNodeWithTag("chat_search_query").performTextInputSelection(TextRange(3))
        compose.onNodeWithText("Personal chat").assertDoesNotExist()
        compose.onNodeWithText("Research · Archived").assertExists()
        compose.onNodeWithText("Project chat").performClick()
        compose.onNodeWithTag("conversation").assertExists()

        compose.activityRule.scenario.recreate()
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }

        compose
            .onNodeWithTag("chat_search_query")
            .assert(hasText("project"))
            .assert(
                SemanticsMatcher.expectValue(SemanticsProperties.TextSelectionRange, TextRange(3))
            )
        compose.onNodeWithText("Project chat").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("chat_list").assertExists()
        compose.onNodeWithText("Project chat").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun pastedTitleRetainsItsUnicodeAndMatchesTheWholeQuery() {
        val app = compose.activity.application as ChatListApplication
        val prefix = "a".repeat(255)
        val title = "$prefix🧪 release"
        val other = "$prefix🔔 release"
        app.fixture.events = { request ->
            if (request.requestUrl?.queryParameter("sinceSeqId") != null) {
                jsonResponse("""{"events":[],"hasMore":false}""")
            } else {
                val project =
                    chatEventWire(
                        id = "77777777-7777-4777-8777-777777777777",
                        seq = 23,
                        thread = CHAT_IN_PROJECT,
                        extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                        title = other,
                    )
                jsonResponse(
                    """{"events":[${chatEventWire(title = title)},$project],"hasMore":false}"""
                )
            }
        }
        app.responseGate.countDown()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(title).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("Search workspace").performClick()
        compose.onNodeWithTag("chat_search_query").performTextInput(title)
        compose.onNodeWithTag("chat_search_query").assert(hasText(title))
        compose.onNodeWithTag("chat_search_results").performScrollToNode(hasText(title))
        compose.onNodeWithText(other).assertDoesNotExist()
        compose
            .onNode(hasText(title) and hasAnyAncestor(hasTestTag("chat_search_results")))
            .performClick()
        compose.onNodeWithTag("conversation").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("chat_search_query").assert(hasText(title))
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun titleSearchKeepsTheResultAndOffersRetryAfterAnActionableRefreshFailure() {
        val app = compose.activity.application as ChatListApplication
        val realtime = app.realtimeService as TestRealtimeService
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithContentDescription("Search workspace").performClick()
        val input = compose.onNodeWithTag("chat_search_query")
        input.performTextInput("personal")
        val result = compose.onNodeWithText("Personal chat")
        val resultBounds = result.getUnclippedBoundsInRoot()
        val events = app.fixture.events
        app.fixture.events = { MockResponse().setResponseCode(400) }
        realtime.invalidate(ChatChanges(list = true))

        val retry = compose.onNodeWithText(app.getString(R.string.retry))
        compose.waitUntilExactlyOneExists(hasText(app.getString(R.string.retry)), 5_000)
        retry.assertIsDisplayed().assertIsEnabled()
        assertEquals(resultBounds, result.getUnclippedBoundsInRoot())
        input.assertIsFocused().assert(hasText("personal"))
        app.fixture.events = events
        retry.performClick()
        compose.waitUntilDoesNotExist(hasText(app.getString(R.string.retry)), 5_000)
        assertEquals(resultBounds, result.getUnclippedBoundsInRoot())
    }

    @Test
    @Config(qualifiers = "en-rUS-w1000dp-h800dp")
    fun wideTitleSearchReturnsTheListAndOpensTheResultInDetail() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithText("Personal chat").performClick()
        compose.onNodeWithContentDescription("Search workspace").performClick()
        compose.onNodeWithTag("conversation").assertExists()
        compose.onNodeWithTag("chat_search_query").performTextInput("missing")
        compose.onNodeWithText("No matching chats").assertExists()
        compose.onNodeWithContentDescription("Clear search").performClick()
        compose.onNodeWithTag("chat_search_query").assertIsFocused().performTextInput("CHAT")
        val results = hasAnyAncestor(hasTestTag("chat_search_results"))
        val project = compose.onNode(hasText("Project chat") and results)
        val personal = compose.onNode(hasText("Personal chat") and results)
        assertTrue(
            project.fetchSemanticsNode().boundsInRoot.top <
                personal.fetchSemanticsNode().boundsInRoot.top
        )
        project.performClick()
        compose.onNodeWithTag("chat_search").assertDoesNotExist()
        compose.onNodeWithTag("chat_list").assertExists()
        compose.onNodeWithTag("conversation").assertExists()
        compose.onNodeWithTag("chat_$CHAT_IN_PROJECT").assertDoesNotExist()
        setResearchExpanded(true)
        compose.onNodeWithTag("chat_$CHAT_IN_PROJECT").assertIsSelected()
    }

    @Test
    @Config(qualifiers = "en-rUS-w960dp-h800dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun findInConversationRestoresQueryAndFocusAfterOpeningAFoldedReply() {
        val app = compose.activity.application as ChatListApplication
        val folded = "Folded staging instructions. Keep the folded staging checklist."
        app.fixture.historyCatchUp = { jsonResponse("""{"events":{},"notFoundThreads":[]}""") }
        app.fixture.historyRows = { request ->
            val thread = checkNotNull(request.requestUrl).pathSegments[2]
            val after = request.requestUrl?.queryParameter("sinceSeqId")?.toLong() ?: 0
            val rows =
                listOf(
                        17L to
                            historyEventWire(
                                "input",
                                17,
                                thread,
                                "input.prompt",
                                """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Hello history"}]}}""",
                            ),
                        22L to
                            historyEventWire(
                                "earlier",
                                22,
                                thread,
                                payload =
                                    """{"content":"## Earlier draft\n\n$folded\n\nReview this after launch."}""",
                            ),
                        23L to historyEventWire("output", 23, thread),
                        37L to
                            historyEventWire(
                                HISTORY_LAST_EVENT,
                                37,
                                thread,
                                "run.completed",
                                "null",
                            ),
                    )
                    .filter { (seq, _) -> seq > after }
                    .joinToString(",") { it.second }
            jsonResponse(
                """{"rows":[$rows],"cursor":{"lastEventId":"$HISTORY_LAST_EVENT","lastSeqId":37},"hasMore":false}"""
            )
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithText("Personal chat").performClick()
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithText("Native history", substring = true)
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose.onNodeWithText(folded).assertDoesNotExist()

        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Find messages").performClick()
        val query = compose.onNodeWithTag("conversation_find_query")
        query.assertIsFocused()
        val fieldBounds = query.getUnclippedBoundsInRoot()
        val listBounds = compose.onNodeWithTag("chat_list").getUnclippedBoundsInRoot()
        assertTrue(fieldBounds.bottom - fieldBounds.top >= 48.dp)
        assertTrue(fieldBounds.left > listBounds.right)
        val draftQuery = "  FOLDED   STAGING  "
        query.performTextInput(draftQuery)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("1 matching message").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(folded, substring = true).performClick()
        val hit = compose.onNodeWithTag("conversation_find_hit")
        compose.waitUntil(10_000) {
            compose
                .onAllNodes(hasTestTag("conversation_find_hit"))
                .fetchSemanticsNodes()
                .firstOrNull()
                ?.config
                ?.getOrElse(SemanticsProperties.Focused) { false } == true
        }
        hit.assertIsDisplayed().assertIsFocused().assertTextContains(folded)
        compose.onNodeWithText("Earlier draft").assertExists()

        compose.onNodeWithContentDescription("Back").performClick()
        query.assertTextContains(draftQuery)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(folded, substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(folded, substring = true).assertIsFocused()
        compose.onNodeWithContentDescription("Clear search").performClick()
        query.assertIsFocused()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Browse turns").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Hello history").assertIsDisplayed()
        compose.onNodeWithContentDescription("Back").performClick()
        hit.assertDoesNotExist()
        compose.onNodeWithTag("conversation").assertIsDisplayed()
    }

    @Test
    fun heldHistoryWarmingFailureKeepsFirstDisplayAndSelectedConversationUsable() {
        val app = compose.activity.application as ChatListApplication
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        app.fixture.historyCatchUp = {
            entered.countDown()
            release.await()
            okhttp3.mockwebserver.MockResponse().setResponseCode(503)
        }
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            compose.waitUntil(10_000) { compose.runOnIdle { entered.count == 0L } }
            compose.onNodeWithContentDescription("Chats").assertExists()
            org.junit.Assert.assertEquals(0, app.fixture.readRequests.get())
            val chats =
                compose.runOnIdle {
                    checkNotNull(
                            ViewModelProvider(compose.activity)[SessionModel::class.java]
                                .uiState
                                .value
                                .ready
                        )
                        .chats
                }
            compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Personal chat"))
            compose.onNodeWithText("Personal chat").performClick()
            compose.waitUntil(10_000) {
                compose.runOnIdle {
                    chats.history.uiState.value.phase == ai.okou.android.chat.HistoryPhase.Ready
                }
            }
            compose
                .onNodeWithTag("conversation")
                .performScrollToNode(hasText("Native history", substring = true))
            compose.onNodeWithText("Native history", substring = true).assertExists()
            compose.onNodeWithContentDescription("Chat actions").performClick()
            compose.onNodeWithText("Settings").performClick()
            compose.onNodeWithText("Display mode").assertExists()
            release.countDown()
            compose.waitUntil(10_000) {
                compose.runOnIdle {
                    chats.warming.state.value.phase == ai.okou.android.chat.ChatReadPhase.Failed
                }
            }
            compose.onNodeWithText("Display mode").assertExists()
            compose.onNodeWithContentDescription("Back").performClick()
            compose
                .onNodeWithTag("conversation")
                .performScrollToNode(hasText("Native history", substring = true))
            compose.onNodeWithText("Native history", substring = true).assertExists()
        } finally {
            release.countDown()
        }
    }

    @Test
    fun selectedConversationKeepsNavigationUsableAndOnlyVisibleConfirmedContentMarksRead() {
        val app = compose.activity.application as ChatListApplication
        val fixture = app.fixture
        val historyRequested = CountDownLatch(1)
        val gate = CountDownLatch(1)
        val refreshGate = CountDownLatch(1)
        val indicatorReads = AtomicInteger()
        fixture.indicators = {
            indicatorReads.incrementAndGet()
            if (fixture.readRequests.get() == 0) {
                jsonResponse(
                    """{"threads":{"$CHAT_IN_PROJECT":"unread"},"unreadAt":{"$CHAT_IN_PROJECT":"$CHAT_DATE"}}"""
                )
            } else jsonResponse("""{"threads":{},"unreadAt":{}}""")
        }
        val snapshotResponse = fixture.historySnapshot
        val rowsResponse = fixture.historyRows
        val catchUpResponse = fixture.historyCatchUp
        fun awaitHistoryResponse() {
            historyRequested.countDown()
            gate.await()
        }
        fixture.historySnapshot = {
            awaitHistoryResponse()
            snapshotResponse()
        }
        fixture.historyRows = { request ->
            awaitHistoryResponse()
            rowsResponse(request)
        }
        fixture.historyCatchUp = { request ->
            awaitHistoryResponse()
            catchUpResponse(request)
        }
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            setResearchExpanded(true)
            compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Project chat"))
            compose.onNodeWithText("Project chat").performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { historyRequested.count == 0L } }
            compose.onNodeWithTag("conversation").assertExists()
            val loadingLabel = app.getString(R.string.history_loading)
            compose.mainClock.advanceTimeBy(160)
            compose.waitUntilExactlyOneExists(hasContentDescription(loadingLabel), 5_000)
            compose.onNodeWithContentDescription("Chat actions").performClick()
            compose.onNodeWithText("Settings").performClick()
            compose.onNodeWithText("Display mode").assertExists()
            gate.countDown()
            val chats =
                compose.runOnIdle {
                    checkNotNull(
                            ViewModelProvider(compose.activity)[SessionModel::class.java]
                                .uiState
                                .value
                                .ready
                        )
                        .chats
                }
            val model = chats.history
            compose.waitUntil(10_000) {
                compose.runOnIdle {
                    model.uiState.value.phase != ai.okou.android.chat.HistoryPhase.Loading
                }
            }
            org.junit.Assert.assertEquals(
                model.uiState.value.toString(),
                ai.okou.android.chat.HistoryPhase.Ready,
                model.uiState.value.phase,
            )
            org.junit.Assert.assertEquals(0, app.fixture.readRequests.get())
            compose.onNodeWithContentDescription("Back").performClick()
            compose
                .onNodeWithTag("conversation")
                .performScrollToNode(hasText("Native history", substring = true))
            compose.onNodeWithText("Native history", substring = true).assertExists()
            compose.waitUntil(10_000) { compose.runOnIdle { app.fixture.readRequests.get() >= 1 } }
            org.junit.Assert.assertEquals(1, app.fixture.readRequests.get())
            compose.waitUntil(10_000) {
                compose.runOnIdle {
                    chats.uiState.value.indicatorsPhase ==
                        ai.okou.android.chat.ChatReadPhase.Ready &&
                        chats.uiState.value.indicators?.threads?.isEmpty() == true
                }
            }
            org.junit.Assert.assertTrue(indicatorReads.get() >= 2)
            compose.onNodeWithTag("conversation").performScrollToIndex(1)
            val message = compose.onNodeWithText("Hello history")
            val input = compose.onNode(hasTestTag("message_input") and hasSetTextAction())
            val messageBounds = message.getUnclippedBoundsInRoot()
            val inputBounds = input.getUnclippedBoundsInRoot()
            val refreshRequested = CountDownLatch(1)
            fixture.historyRows = { request ->
                refreshRequested.countDown()
                refreshGate.await()
                rowsResponse(request)
            }
            compose.runOnIdle { model.refresh() }
            compose.waitUntil(10_000) { refreshRequested.count == 0L }
            compose.mainClock.advanceTimeBy(300)
            compose.onNodeWithContentDescription(loadingLabel).assertDoesNotExist()
            assertEquals(messageBounds, message.getUnclippedBoundsInRoot())
            assertEquals(inputBounds, input.getUnclippedBoundsInRoot())
            refreshGate.countDown()
            compose.waitUntil(10_000) {
                compose.runOnIdle {
                    model.uiState.value.phase != ai.okou.android.chat.HistoryPhase.Loading
                }
            }
            assertEquals(
                model.uiState.value.toString(),
                ai.okou.android.chat.HistoryPhase.Ready,
                model.uiState.value.phase,
            )
            assertEquals(messageBounds, message.getUnclippedBoundsInRoot())
            assertEquals(inputBounds, input.getUnclippedBoundsInRoot())
            compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
            compose.onNodeWithTag("conversation").assertDoesNotExist()
            compose.onNodeWithTag("chat_list").assertExists()
            compose.onNodeWithText("Project chat").assertExists()
            setResearchExpanded(false)
            compose.onNodeWithText("Project chat").assertDoesNotExist()
            setResearchExpanded(true)
            compose.onNodeWithText("Project chat").assertExists()
        } finally {
            gate.countDown()
            refreshGate.countDown()
            fixture.historyRows = rowsResponse
            fixture.historySnapshot = snapshotResponse
            fixture.historyCatchUp = catchUpResponse
        }
    }

    @After
    fun close() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        val failures = mutableListOf<Throwable>()
        for (cleanup in
            listOf<() -> Unit>(
                { compose.activityRule.scenario.close() },
                {
                    compose.waitUntil(10_000) {
                        shadowOf(Looper.getMainLooper()).idle()
                        chatJob?.isCompleted != false
                    }
                },
                { app.fixture.close() },
                { app.cacheSnapshot.restore() },
            )) {
            try {
                cleanup()
            } catch (error: Throwable) {
                failures += error
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    @Test
    fun unavailableProjectsDoNotRevokeTheWorkspaceOrHideAuthorizedOutsideChats() {
        val app = compose.activity.application as ChatListApplication
        app.fixture.projects = {
            jsonResponse("""{"error":{"code":"NOT_FOUND","message":"Project not found"}}""")
                .setResponseCode(404)
        }
        app.responseGate.countDown()
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithText("Some Okou or Project information is unavailable.")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        awaitListAndNames()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Personal chat"))
        compose.onNodeWithText("Personal chat").assertExists()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Display mode").assertExists()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun lateProjectHeadersPreserveTheVisibleChatAndItsOffset() {
        val app = compose.activity.application as ChatListApplication
        val projectRequested = CountDownLatch(1)
        val projectGate = CountDownLatch(1)
        val projectResponse = app.fixture.projects
        app.fixture.projects = {
            projectRequested.countDown()
            projectGate.await()
            projectResponse()
        }
        val rows =
            (1..190).joinToString(",") { index ->
                val suffix = index.toString().padStart(12, '0')
                chatEventWire(
                    id = "61000000-0000-4000-8000-$suffix",
                    seq = index.toLong(),
                    thread = "62000000-0000-4000-8000-$suffix",
                    title = "Startup chat $index",
                    extra = if (index <= 160) ",\"projectId\":\"$CHAT_PROJECT\"" else "",
                )
            }
        app.fixture.events = { request ->
            val events = if (request.requestUrl?.queryParameter("sinceSeqId") == null) rows else ""
            jsonResponse("""{"events":[$events],"hasMore":false}""")
        }
        try {
            app.responseGate.countDown()
            compose.waitUntil(10_000) {
                projectRequested.count == 0L &&
                    currentList()?.source == ai.okou.android.chat.ChatListSource.Network
            }
            val list = compose.onNodeWithTag("chat_list")
            val projectChat = compose.onNodeWithText("Startup chat 160")
            projectChat.assertIsDisplayed()
            val projectInset = projectChat.fetchSemanticsNode().boundsInRoot.left
            compose.onNodeWithText("Research").assertDoesNotExist()

            // The header will replace 160 rows, taking the anchor outside Compose's key window.
            list.performScrollToIndex(165)
            list.performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 12f) }
            val anchor = compose.onNodeWithText("Startup chat 185")
            anchor.assertIsDisplayed()
            val anchorBounds = anchor.getUnclippedBoundsInRoot()
            assertTrue(projectInset > anchor.fetchSemanticsNode().boundsInRoot.left)
            projectGate.countDown()
            awaitListAndNames()
            assertEquals(anchorBounds, anchor.getUnclippedBoundsInRoot())

            list.performScrollToIndex(0)
            compose.onNodeWithText("Research").assertIsDisplayed()
            projectChat.assertDoesNotExist()
            setResearchExpanded(true)
            projectChat.assertIsDisplayed()
            assertEquals(projectInset, projectChat.fetchSemanticsNode().boundsInRoot.left)
        } finally {
            projectGate.countDown()
        }
    }

    @Test
    fun expiredSignedStorageKeepsTheWorkspaceOpenAndRetriesWithAFreshDescriptor() {
        val app = compose.activity.application as ChatListApplication
        val descriptors = AtomicInteger()
        val archives = AtomicInteger()
        app.fixture.snapshot = {
            val url = app.fixture.server.url("/archive?attempt=${descriptors.incrementAndGet()}")
            jsonResponse(
                """{"url":"$url","expiresInSeconds":60,"latestEventId":null,"latestSeqId":null}"""
            )
        }
        app.fixture.archive = {
            if (archives.incrementAndGet() == 1) MockResponse().setResponseCode(403)
            else jsonResponse("""{"chatThreads":[]}""")
        }
        compose.onNodeWithContentDescription("Search workspace").performClick()
        app.responseGate.countDown()
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithText("Temporarily unable to load")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose.onNodeWithTag("chat_search").assertExists()
        shadowOf(Looper.getMainLooper()).idleFor(5, TimeUnit.SECONDS)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Project chat").fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue(descriptors.get() >= 2)
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Display mode").assertExists()
    }

    @Test
    fun heldTransportKeepsNavigationAndRestoresTheListWithProjectStatus() {
        compose.onNodeWithContentDescription("Chats").assertExists()
        compose.mainClock.advanceTimeBy(120)
        compose.onNodeWithContentDescription("Loading chats…").assertExists()
        compose.onNodeWithContentDescription("Switch workspace", substring = true).performClick()
        compose.onNodeWithText("Workspace B").assertExists()
        compose.onNode(hasText("Workspace A") and isSelectable()).assertIsSelected().performClick()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Display mode").assertExists()
        (compose.activity.application as ChatListApplication).responseGate.countDown()
        compose.onNodeWithContentDescription("Back").performClick()
        awaitListAndNames()
        val unread = SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Unread")
        val projectUnreadCount =
            SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Unread 1")
        fun assertProjectWeight(expected: FontWeight) {
            val layouts = mutableListOf<TextLayoutResult>()
            compose.onNodeWithText("Research", useUnmergedTree = true).performSemanticsAction(
                SemanticsActions.GetTextLayoutResult
            ) {
                it(layouts)
            }
            assertEquals(expected, layouts.single().layoutInput.style.fontWeight)
        }
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Research"))
        compose.onNodeWithText("Research").assert(projectUnreadCount)
        assertProjectWeight(FontWeight.SemiBold)
        compose.onNodeWithText("Project chat").assertDoesNotExist()
        setResearchExpanded(true)
        assertProjectWeight(FontWeight.Normal)
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Project chat"))
        compose.waitUntil(10_000) {
            compose
                .onAllNodes(hasText("Project chat").and(unread))
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose.onNodeWithText("Project chat").assert(unread)
        setResearchExpanded(false)
        compose.onNodeWithText("Research").assert(projectUnreadCount)
        assertProjectWeight(FontWeight.SemiBold)
        compose.onNodeWithText("Project chat").assertDoesNotExist()
        compose.onNodeWithTag("chat_list").performScrollToIndex(0)
        compose.onNodeWithContentDescription("Filter").performClick()
        compose.onNodeWithText("Archived").performClick()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("No archived chats"))
        compose.onNodeWithText("No archived chats").assertExists()
        compose.activityRule.scenario.recreate()
        awaitListAndNames()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("No archived chats"))
        compose.onNodeWithText("No archived chats").assertExists()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun aFailedRefreshAfterReconnectKeepsAnEmptyFilterVisible() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithContentDescription("Filter").performClick()
        compose.onNodeWithText("Archived").performClick()
        compose.onNodeWithText("No archived chats").assertExists()

        app.fixture.events = { okhttp3.mockwebserver.MockResponse().setResponseCode(503) }
        reconnectList(app)

        compose.waitUntil(10_000) {
            currentList()?.listPhase == ai.okou.android.chat.ChatReadPhase.Failed
        }
        compose.onNodeWithTag("chat_filter_heading").assert(hasText("Archived"))
        compose.onNodeWithText("No archived chats").assertExists()
        compose.onNodeWithTag("chat_list_bottom_status").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h560dp")
    fun returningToInboxRestoresItsScrollPosition() {
        val app = compose.activity.application as ChatListApplication
        val rows =
            (1..24).joinToString(",") { index ->
                val suffix = index.toString().padStart(12, '0')
                chatEventWire(
                    id = "61000000-0000-4000-8000-$suffix",
                    seq = index.toLong(),
                    thread = "62000000-0000-4000-8000-$suffix",
                    title = "Inbox chat $index",
                )
            }
        app.fixture.events = { request ->
            val events = if (request.requestUrl?.queryParameter("sinceSeqId") == null) rows else ""
            jsonResponse("""{"events":[$events],"hasMore":false}""")
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val list = compose.onNodeWithTag("chat_list")
        val chat = "Inbox chat 12"
        list.performScrollToNode(hasText(chat))
        val row = compose.onNodeWithText(chat).assertIsDisplayed()
        val top = row.fetchSemanticsNode().boundsInRoot.top
        val filter = compose.onNodeWithContentDescription("Filter")
        filter.performClick()
        compose.onNodeWithText("Archived").performClick()
        compose.onNodeWithTag("chat_filter_heading").assert(hasText("Archived"))
        compose.onNodeWithText("No archived chats").assertIsDisplayed()
        compose.onNodeWithText("Back to Inbox").performClick()
        row.assertIsDisplayed()
        assertEquals(top, row.fetchSemanticsNode().boundsInRoot.top)
    }

    @Test
    fun aPopulatedProjectStartsItsOwnChatFromTheRowMenu() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Research"))
        compose.onNodeWithText("Research").performSemanticsAction(SemanticsActions.OnLongClick)
        compose
            .onNode(hasText("Research").and(hasAnyAncestor(hasTestTag("workspace_popup"))))
            .assertDoesNotExist()
        compose.onNodeWithText("New chat in this Project").performClick()
        compose.onNodeWithText("Research").assertExists()
        compose.onNodeWithTag("message_input").assertExists()
    }

    @Test
    fun chatRowReadActionsReconcileAndSurfaceFailedWrites() {
        val app = compose.activity.application as ChatListApplication
        val unread = AtomicBoolean(true)
        val rejectUnread = AtomicBoolean(true)
        app.fixture.indicators = {
            if (unread.get()) {
                jsonResponse(
                    """{"threads":{"$CHAT_IN_PROJECT":"unread"},"unreadAt":{"$CHAT_IN_PROJECT":"$CHAT_DATE"}}"""
                )
            } else {
                jsonResponse("""{"threads":{},"unreadAt":{}}""")
            }
        }
        app.fixture.commandResponse = { request ->
            if (request.method != "POST" || request.bodySize != 0L) null
            else
                when (request.requestUrl?.encodedPath) {
                    "/api/chat-threads/$CHAT_IN_PROJECT/mark-read" -> {
                        unread.set(false)
                        jsonResponse("""{"lastReadAt":"$CHAT_DATE"}""")
                    }
                    "/api/chat-threads/$CHAT_IN_PROJECT/mark-unread" ->
                        if (rejectUnread.get()) {
                            okhttp3.mockwebserver.MockResponse().setResponseCode(503)
                        } else {
                            unread.set(true)
                            jsonResponse("""{"lastReadAt":null}""")
                        }
                    else -> null
                }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        setResearchExpanded(true)
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Project chat"))
        val target = hasText("Project chat")
        val unreadStatus =
            SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Unread")
        val available = SemanticsMatcher.keyIsDefined(SemanticsActions.OnLongClick)
        fun awaitAction(status: SemanticsMatcher) {
            compose.waitUntil(10_000) {
                compose
                    .onAllNodes(target.and(status).and(available))
                    .fetchSemanticsNodes()
                    .isNotEmpty()
            }
        }
        fun choose(label: String) {
            compose.onNode(target).performSemanticsAction(SemanticsActions.OnLongClick)
            compose
                .onNode(target.and(hasAnyAncestor(hasTestTag("workspace_popup"))))
                .assertDoesNotExist()
            compose.onNodeWithText(label).performClick()
        }
        awaitAction(unreadStatus)
        choose("Mark as read")
        awaitAction(!unreadStatus)
        choose("Mark as unread")
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithText("Could not update the read status.")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        awaitAction(!unreadStatus)
        rejectUnread.set(false)
        choose("Mark as unread")
        awaitAction(unreadStatus)
        compose.onNodeWithTag("conversation").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun markAllReadIncludesCollapsedArchivedChatsAndKeepsNewUnreadActivity() {
        val app = compose.activity.application as ChatListApplication
        val running = UUID.randomUUID().toString()
        val newer = "2026-11-13T00:01:00.000Z"
        val personalUnread = AtomicReference<String?>(CHAT_DATE)
        val projectUnread = AtomicBoolean(true)
        val rejectProject = AtomicBoolean(true)
        val activeUnreadQuery = AtomicReference<String?>()
        val marked = CopyOnWriteArrayList<String>()
        val releaseWrites = CountDownLatch(1)
        val events =
            listOf(
                chatEventWire(),
                chatEventWire(
                    id = UUID.randomUUID().toString(),
                    seq = 18,
                    thread = CHAT_IN_PROJECT,
                    extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                    title = "Project chat",
                ),
                chatEventWire(
                    id = UUID.randomUUID().toString(),
                    seq = 19,
                    thread = CHAT_IN_PROJECT,
                    kind = "archived",
                ),
                chatEventWire(
                    id = UUID.randomUUID().toString(),
                    seq = 20,
                    thread = running,
                    title = "Running chat",
                ),
            )
        app.fixture.events = { request ->
            val rows =
                if (request.requestUrl?.queryParameter("sinceSeqId") == null) {
                    events.joinToString(",")
                } else ""
            jsonResponse("""{"events":[$rows],"hasMore":false}""")
        }
        app.fixture.indicators = {
            val unread = buildMap {
                personalUnread.get()?.let { put(CHAT_PERSONAL, it) }
                if (projectUnread.get()) put(CHAT_IN_PROJECT, CHAT_DATE)
            }
            val markers = unread.entries.joinToString(",") { (id, time) -> "\"$id\":\"$time\"" }
            val personal = if (CHAT_PERSONAL in unread) ",\"$CHAT_PERSONAL\":\"unread\"" else ""
            jsonResponse(
                """{"threads":{"$running":"active","$CHAT_IN_PROJECT":"active"$personal},"unreadAt":{$markers}}"""
            )
        }
        app.fixture.commandResponse = { request ->
            val url = request.requestUrl
            if (url?.encodedPath == "/api/indicators")
                activeUnreadQuery.set(url.queryParameter("includeActiveUnread"))
            val path = url?.pathSegments.orEmpty()
            if (request.method != "POST" || path.lastOrNull() != "mark-read") {
                null
            } else {
                val id = path[2]
                marked.add(id)
                releaseWrites.await()
                when (id) {
                    CHAT_PERSONAL -> {
                        // A newer reply finishes before the client receives the first receipt.
                        val receipt =
                            personalUnread.getAndUpdate { if (it == CHAT_DATE) newer else null }
                        jsonResponse("""{"lastReadAt":"$receipt"}""")
                    }
                    CHAT_IN_PROJECT ->
                        if (rejectProject.get()) MockResponse().setResponseCode(503)
                        else {
                            projectUnread.set(false)
                            jsonResponse("""{"lastReadAt":"$CHAT_DATE"}""")
                        }
                    else -> MockResponse().setResponseCode(400)
                }
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val list = compose.onNodeWithTag("chat_list")
        val unread = SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Unread")
        val projectUnreadCount =
            SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Unread 1, Active 1")
        val filter = compose.onNodeWithContentDescription("Filter")
        filter.performClick()
        val enabled = !SemanticsMatcher.keyIsDefined(SemanticsProperties.Disabled)
        compose.waitUntil(10_000) {
            compose
                .onAllNodes(hasText("Mark all as read").and(enabled))
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        assertEquals("true", activeUnreadQuery.get())
        compose.onNodeWithText("Unread").performClick()
        setResearchExpanded(true)
        list.performScrollToNode(hasText("Project chat"))
        compose
            .onNodeWithText("Project chat")
            .assert(
                SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Active, Unread")
            )
        setResearchExpanded(false)
        compose.waitUntil(10_000) {
            compose
                .onAllNodes(hasText("Research").and(projectUnreadCount))
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose.onNodeWithText("Project chat").assertDoesNotExist()

        fun markAll() {
            filter.performClick()
            compose.onNodeWithText("Mark all as read").assertIsEnabled().performClick()
        }
        fun awaitMessage(message: String) {
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText(message).fetchSemanticsNodes().isNotEmpty()
            }
        }
        try {
            markAll()
            compose.waitUntil(10_000) { marked.size == 2 }
            compose.onNodeWithText("Personal chat").assertDoesNotExist()
            compose.onNodeWithText("Research").assertDoesNotExist()
        } finally {
            releaseWrites.countDown()
        }
        awaitMessage("Some chats may still be unread.")
        assertEquals(setOf(CHAT_PERSONAL, CHAT_IN_PROJECT), marked.toSet())
        assertEquals(2, marked.size)
        list.performScrollToNode(hasText("Personal chat"))
        compose.onNodeWithText("Personal chat").assert(unread)
        compose.onNodeWithText("Research").assert(projectUnreadCount)
        rejectProject.set(false)
        markAll()
        awaitMessage("Marked 2 chats as read.")
        val feedback = compose.onNodeWithTag("chat_list_feedback").getUnclippedBoundsInRoot()
        val newChat = compose.onNodeWithText("New chat").getUnclippedBoundsInRoot()
        assertEquals(8f, (newChat.top - feedback.bottom).value, 1f)
        assertTrue(feedback.bottom - feedback.top >= 48.dp)
        compose.onNodeWithTag("chat_filter_heading").assert(hasText("Unread"))
        filter.performClick()
        compose
            .onNode(hasText("Unread").and(hasAnyAncestor(hasTestTag("workspace_popup"))))
            .assertIsSelected()
        compose.onNodeWithText("Archived").performClick()
        setResearchExpanded(true)
        list.performScrollToNode(hasText("Project chat"))
        compose
            .onNodeWithText("Project chat")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Active"))
        filter.performClick()
        compose.onNodeWithText("Inbox").performClick()
        list.performScrollToNode(hasText("Running chat"))
        compose
            .onNodeWithText("Running chat")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Active"))
    }

    @Test
    fun projectRenameShowsOptimisticallyAndRetriesTheSameEvent() {
        val app = compose.activity.application as ChatListApplication
        val pending = CountDownLatch(1)
        val writes = CopyOnWriteArrayList<String>()
        val committed = AtomicReference<String?>()
        app.fixture.commandResponse = { request ->
            if (
                request.method != "PATCH" ||
                    request.requestUrl?.encodedPath != "/api/projects/$CHAT_PROJECT"
            ) {
                null
            } else {
                val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                check(body.getValue("name").jsonPrimitive.content == "Field notes")
                val eventId = body.getValue("eventId").jsonPrimitive.content
                writes.add(eventId)
                when (writes.size) {
                    1 -> {
                        pending.await()
                        MockResponse().setResponseCode(503)
                    }
                    2 ->
                        jsonResponse(
                            """{"id":"$CHAT_PROJECT","name":"Field notes","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}"""
                        )
                    else -> {
                        committed.set(eventId)
                        MockResponse().setResponseCode(503)
                    }
                }
            }
        }
        app.fixture.projectEvents = { request ->
            val event =
                committed.get()?.takeIf { request.requestUrl?.queryParameter("sinceSeqId") == "0" }
            val rows =
                if (event == null) ""
                else
                    """{"id":"$event","seqId":1,"projectId":"$CHAT_PROJECT","kind":"renamed","name":"Field notes","createdAt":"$CHAT_DATE"}"""
            jsonResponse("""{"events":[$rows],"hasMore":false}""")
        }
        app.responseGate.countDown()
        awaitListAndNames()
        try {
            compose.onNodeWithText("Research").performTouchInput { longClick() }
            compose.onNodeWithText("Rename").performClick()
            compose.onNode(hasSetTextAction()).performTextReplacement("Field notes")
            val beforeSave = System.currentTimeMillis()
            compose.onNodeWithText("Save").performClick()
            compose.waitUntil(10_000) { writes.size == 1 }
            val operationId = UUID.fromString(writes.first())
            val issuedAt = operationId.mostSignificantBits ushr 16
            assertEquals(7, operationId.version())
            assertEquals(2, operationId.variant())
            assertTrue(issuedAt in beforeSave..System.currentTimeMillis())
            compose.onNodeWithText("Field notes").assertIsDisplayed()
        } finally {
            pending.countDown()
        }
        val unconfirmed = "Could not confirm the Project name."
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(unconfirmed).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Research").assertIsDisplayed()
        compose.onNodeWithText("Try again").performClick()
        compose.waitUntil(10_000) { writes.size == 2 && currentList()?.renamingProjectId == null }
        compose.onNodeWithText(unconfirmed).assertIsDisplayed()
        compose.onNodeWithText("Try again").performClick()
        compose.waitUntil(10_000) { writes.size == 3 && currentList()?.renamingProjectId == null }
        assertEquals(List(3) { writes.first() }, writes.toList())
        compose.onNodeWithText("Field notes").assertIsDisplayed()
        compose.onNodeWithText(unconfirmed).assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun rejectedProjectRenameShowsFailureAtTheProjectWithoutDisplacingUndo() {
        val app = compose.activity.application as ChatListApplication
        val events = app.fixture.rowEventTail()
        val renameStarted = AtomicBoolean()
        val releaseRename = CountDownLatch(1)
        app.fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/chat-threads/$CHAT_PERSONAL/archive" -> {
                    events.add(24L to request.rowEvent(24, CHAT_PERSONAL, "archived"))
                    MockResponse().setResponseCode(204)
                }
                "/api/chat-threads/$CHAT_PERSONAL/unarchive" -> {
                    events.add(25L to request.rowEvent(25, CHAT_PERSONAL, "unarchived"))
                    MockResponse().setResponseCode(204)
                }
                "/api/projects/$CHAT_PROJECT" -> {
                    renameStarted.set(true)
                    releaseRename.await()
                    MockResponse().setResponseCode(409)
                }
                else -> null
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val rowTag = "chat_$CHAT_PERSONAL"
        val chat = compose.onNodeWithTag(rowTag)
        try {
            compose.runOnIdle {
                checkNotNull(
                        ViewModelProvider(compose.activity)[SessionModel::class.java]
                            .uiState
                            .value
                            .ready
                    )
                    .chats
                    .renameProject(CHAT_PROJECT, "Field notes")
            }
            compose.waitUntil(10_000) { renameStarted.get() }
            compose.onNodeWithText("Field notes").assertIsDisplayed()

            compose.onNodeWithTag("chat_list").performScrollToNode(hasTestTag(rowTag))
            chat.performTouchInput { swipe(center.copy(x = width * 0.8f), center) }
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("Chat archived").fetchSemanticsNodes().isNotEmpty()
            }
        } finally {
            releaseRename.countDown()
        }
        val failure = "Could not rename the Project."
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(failure).fetchSemanticsNodes().isNotEmpty()
        }
        val project = compose.onNodeWithText("Research").assertIsDisplayed()
        val inList = hasAnyAncestor(hasTestTag("chat_list"))
        val notice = compose.onNode(hasText(failure).and(inList)).assertIsDisplayed()
        assertTrue(
            notice.getUnclippedBoundsInRoot().top >= project.getUnclippedBoundsInRoot().bottom
        )
        compose.onNodeWithText("Try again").assertDoesNotExist()
        val undo = compose.onNodeWithText("Undo").assertIsDisplayed().assertIsEnabled()
        compose.onNode(hasContentDescription("Dismiss").and(inList)).performClick()
        compose.onNodeWithText(failure).assertDoesNotExist()

        undo.performClick()
        awaitRowActionSettled(CHAT_PERSONAL)
        chat.assertIsDisplayed()
    }

    @Test
    fun muteConfirmsAnUncertainWriteAndUnmuteRequiresAcknowledgement() {
        val app = compose.activity.application as ChatListApplication
        val fixture = app.fixture
        val events = fixture.rowEventTail()
        val commands = CopyOnWriteArrayList<RecordedRequest>()
        val rejectRead = AtomicBoolean(true)
        val unread = AtomicBoolean(true)
        val indicatorsUnavailable = AtomicBoolean(false)
        fixture.indicators = {
            if (indicatorsUnavailable.get()) MockResponse().setResponseCode(503)
            else {
                val value = if (unread.get()) "\"$CHAT_IN_PROJECT\":\"$CHAT_DATE\"" else ""
                val status = if (unread.get()) "\"$CHAT_IN_PROJECT\":\"unread\"" else ""
                jsonResponse("""{"threads":{$status},"unreadAt":{$value}}""")
            }
        }
        fixture.commandResponse = { request ->
            if (request.method != "POST") null
            else
                when (request.requestUrl?.encodedPath) {
                    "/api/chat-threads/$CHAT_IN_PROJECT/mute" -> {
                        commands.add(request)
                        events.add(
                            24L to
                                request.rowEvent(
                                    24,
                                    CHAT_IN_PROJECT,
                                    "sort_touched",
                                    ",\"muted\":true",
                                )
                        )
                        MockResponse().setResponseCode(503)
                    }
                    "/api/chat-threads/$CHAT_IN_PROJECT/mark-read" -> {
                        commands.add(request)
                        if (rejectRead.get()) MockResponse().setResponseCode(503)
                        else {
                            unread.set(false)
                            jsonResponse("""{"lastReadAt":"$CHAT_DATE"}""")
                        }
                    }
                    "/api/chat-threads/$CHAT_IN_PROJECT/unmute" -> {
                        commands.add(request)
                        events.add(
                            25L to
                                request.rowEvent(
                                    25,
                                    CHAT_IN_PROJECT,
                                    "sort_touched",
                                    ",\"muted\":false",
                                )
                        )
                        MockResponse().setResponseCode(204)
                    }
                    else -> null
                }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        setResearchExpanded(true)
        val target = hasText("Project chat")
        val row = compose.onNode(target)
        compose.onNodeWithTag("chat_list").performScrollToNode(target)
        val unreadBadge =
            SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Unread")
        compose.waitUntil(10_000) {
            compose.onAllNodes(target.and(unreadBadge)).fetchSemanticsNodes().isNotEmpty()
        }
        indicatorsUnavailable.set(true)
        row.performMouseInput { click(button = MouseButton.Secondary) }
        compose.onNodeWithText("Mute chat").performClick()

        val available = SemanticsMatcher.keyIsDefined(SemanticsActions.OnLongClick)
        val muted = SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Muted")
        val unconfirmed = "Could not confirm the chat change."
        val rejected = "Could not finish changing the chat."
        compose.waitUntil(10_000) {
            compose.onAllNodes(target.and(muted).and(available)).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(unconfirmed).assertDoesNotExist()
        row.performSemanticsAction(SemanticsActions.OnLongClick)
        compose.onNodeWithText("Mark as read").assertDoesNotExist()
        compose.onNodeWithText("Mark as unread").assertDoesNotExist()
        compose.onNodeWithText("Unmute chat").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(rejected).fetchSemanticsNodes().isNotEmpty()
        }
        row.assert(muted)
        compose.onNodeWithText("Refresh chats").assertDoesNotExist()
        assertEquals(
            listOf("mute", "mark-read"),
            commands.map { it.requestUrl?.pathSegments?.last() },
        )

        rejectRead.set(false)
        awaitRowActionSettled(CHAT_IN_PROJECT)
        row.performSemanticsAction(SemanticsActions.OnLongClick)
        compose.onNodeWithText("Unmute chat").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodes(target.and(!muted).and(available)).fetchSemanticsNodes().isNotEmpty()
        }
        row.assert(!unreadBadge)
        indicatorsUnavailable.set(false)
        reconnectList(app)
        compose.waitUntil(10_000) {
            currentList()?.indicatorsPhase == ai.okou.android.chat.ChatReadPhase.Ready
        }
        compose.onNodeWithTag("chat_list").performScrollToNode(target)
        row.performSemanticsAction(SemanticsActions.OnLongClick)
        compose.onNodeWithText("Mark as unread").assertExists()
        compose.onNodeWithText("Mute chat").assertExists()
        assertEquals(
            listOf("mute", "mark-read", "mark-read", "unmute"),
            commands.map { it.requestUrl?.pathSegments?.last() },
        )
        assertEquals(
            2,
            commands.mapNotNull { it.requestUrl?.queryParameter("eventId") }.distinct().size,
        )
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun markingReadInUnreadCanBeUndoneThroughCanonicalReadActions() {
        val app = compose.activity.application as ChatListApplication
        val unread = AtomicBoolean(true)
        val commands = CopyOnWriteArrayList<String>()
        app.fixture.indicators = {
            if (unread.get())
                jsonResponse(
                    """{"threads":{"$CHAT_PERSONAL":"unread"},"unreadAt":{"$CHAT_PERSONAL":"$CHAT_DATE"}}"""
                )
            else jsonResponse("""{"threads":{},"unreadAt":{}}""")
        }
        app.fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/chat-threads/$CHAT_PERSONAL/mark-read" -> {
                    unread.set(false)
                    commands.add("read")
                    jsonResponse("""{"lastReadAt":"$CHAT_DATE"}""")
                }
                "/api/chat-threads/$CHAT_PERSONAL/mark-unread" -> {
                    unread.set(true)
                    commands.add("unread")
                    jsonResponse("""{"lastReadAt":null}""")
                }
                else -> null
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithContentDescription("Filter").performClick()
        compose.onNodeWithText("Unread").performClick()
        val rowTag = "chat_$CHAT_PERSONAL"
        compose.onNodeWithTag("chat_list").performScrollToNode(hasTestTag(rowTag))
        compose.onNodeWithTag(rowTag).performTouchInput {
            swipe(center.copy(x = width * 0.2f), center)
        }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Chat marked as read").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag(rowTag).assertDoesNotExist()
        compose.onNodeWithText("Undo").performClick()
        compose.waitUntil(10_000) {
            unread.get() && commands.size == 2 && currentList()?.rowUndo == null
        }
        compose.onNodeWithTag(rowTag).assertExists()
        assertEquals(listOf("read", "unread"), commands.toList())
        compose.onNodeWithText("Undo").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun aCommittedArchiveSwipeOffersUndoAcrossFiltersAndRename() {
        val app = compose.activity.application as ChatListApplication
        val events = app.fixture.rowEventTail()
        val commands = CopyOnWriteArrayList<RecordedRequest>()
        val releaseRename = CountDownLatch(1)
        val releaseUndo = CountDownLatch(1)
        app.fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/chat-threads/$CHAT_PERSONAL/archive" -> {
                    commands.add(request)
                    events.add(24L to request.rowEvent(24, CHAT_PERSONAL, "archived"))
                    MockResponse().setResponseCode(204)
                }
                "/api/chat-threads/$CHAT_PERSONAL/unarchive" -> {
                    commands.add(request)
                    releaseUndo.await()
                    events.add(26L to request.rowEvent(26, CHAT_PERSONAL, "unarchived"))
                    MockResponse().setResponseCode(204)
                }
                "/api/chat-threads/$CHAT_PERSONAL/rename" -> {
                    commands.add(request)
                    releaseRename.await()
                    val body = request.jsonCommandBody()
                    events.add(
                        25L to
                            chatEventWire(
                                id = body.getValue("eventId").jsonPrimitive.content,
                                seq = 25,
                                kind = "renamed",
                                title = body.getValue("title").jsonPrimitive.content,
                            )
                    )
                    MockResponse().setResponseCode(204)
                }
                else -> null
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val rowTag = "chat_$CHAT_PERSONAL"
        val row = compose.onNodeWithTag(rowTag)
        compose.onNodeWithTag("chat_list").performScrollToNode(hasTestTag(rowTag))
        val left = row.getUnclippedBoundsInRoot().left
        row.performTouchInput { swipe(center, center.copy(x = centerX - 44.dp.toPx())) }
        row.assertIsDisplayed()
        assertEquals(left, row.getUnclippedBoundsInRoot().left)
        row.performTouchInput {
            swipe(center, center.copy(x = centerX - 90.dp.toPx(), y = centerY - 120.dp.toPx()))
        }
        assertEquals(left, row.getUnclippedBoundsInRoot().left)
        row.performTouchInput {
            down(center)
            moveTo(center + Offset(-32.dp.toPx(), 0f))
            moveTo(center + Offset(-96.dp.toPx(), 72.dp.toPx()))
            up()
        }
        row.assertIsDisplayed()
        assertEquals(left, row.getUnclippedBoundsInRoot().left)
        assertTrue(commands.isEmpty())

        row.performTouchInput { swipe(center.copy(x = width * 0.8f), center) }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Chat archived").fetchSemanticsNodes().isNotEmpty()
        }
        row.assertDoesNotExist()
        compose.onNodeWithContentDescription("Filter").performClick()
        compose.onNodeWithText("Archived").performClick()
        val undo = compose.onNodeWithText("Undo").assertIsDisplayed()
        val dismiss = compose.onNodeWithContentDescription("Dismiss")
        val undoBounds = undo.getUnclippedBoundsInRoot()
        val dismissBounds = dismiss.getUnclippedBoundsInRoot()
        val messageBounds = compose.onNodeWithText("Chat archived").getUnclippedBoundsInRoot()
        assertEquals(
            (messageBounds.top + messageBounds.bottom).value / 2,
            (undoBounds.top + undoBounds.bottom).value / 2,
            1f,
        )
        assertEquals(4f, (dismissBounds.left - undoBounds.right).value, 1f)
        for (bounds in listOf(undoBounds, dismissBounds)) {
            assertTrue(bounds.right - bounds.left >= 48.dp && bounds.bottom - bounds.top >= 48.dp)
        }
        awaitRowActionSettled(CHAT_PERSONAL)
        try {
            compose.runOnIdle {
                checkNotNull(
                        ViewModelProvider(compose.activity)[SessionModel::class.java]
                            .uiState
                            .value
                            .ready
                    )
                    .chats
                    .renameThread(CHAT_PERSONAL, "Weekly brief")
            }
            compose.waitUntil(10_000) { commands.size == 2 }
            undo.assertIsDisplayed().assertIsNotEnabled()
        } finally {
            releaseRename.countDown()
        }
        awaitRowActionSettled(CHAT_PERSONAL)
        compose.runOnIdle { app.connectivity.value = false }
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithText("Undo when you’re back online.", substring = true)
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        undo.assertIsNotEnabled()
        compose.onNodeWithText("Offline").assertIsDisplayed()
        compose.runOnIdle { app.connectivity.value = true }
        compose.waitUntil(10_000) { currentList()?.offline == false }
        assertEquals(2, commands.size)
        try {
            undo.assertIsEnabled().performClick()
            compose.waitUntil(10_000) {
                compose
                    .onAllNodesWithText("Checking undo result…")
                    .fetchSemanticsNodes()
                    .isNotEmpty()
            }
            undo.assertIsNotEnabled()
            dismiss.assertIsDisplayed()
        } finally {
            releaseUndo.countDown()
        }
        compose.waitUntil(10_000) {
            currentList()?.threads?.any {
                it.id == CHAT_PERSONAL && !it.archived && it.title == "Weekly brief"
            } == true && commands.size == 3 && currentList()?.rowUndo == null
        }
        assertEquals(
            listOf("archive", "rename", "unarchive"),
            commands.map { it.requestUrl?.pathSegments?.last() },
        )
        compose.onNodeWithText("Undo").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w1000dp-h800dp")
    fun deletingTheSelectedChatRequiresConfirmationAndReturnsToTheListWhilePending() {
        val app = compose.activity.application as ChatListApplication
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val requests = AtomicInteger()
        val events = app.fixture.rowEventTail()
        app.fixture.commandResponse = { request ->
            if (
                request.method != "DELETE" ||
                    request.requestUrl?.encodedPath != "/api/chat-threads/$CHAT_PERSONAL"
            )
                null
            else {
                requests.incrementAndGet()
                started.countDown()
                release.await()
                events.add(24L to request.rowEvent(24, CHAT_PERSONAL, "deleted"))
                MockResponse().setResponseCode(204)
            }
        }
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            val rowTag = "chat_$CHAT_PERSONAL"
            val row = compose.onNodeWithTag(rowTag)
            compose.onNodeWithTag("chat_list").performScrollToNode(hasTestTag(rowTag))
            row.performClick()
            compose.onNodeWithTag("conversation").assertExists()
            fun openConfirmation() {
                row.performTouchInput { longClick() }
                compose.onNodeWithText("Delete chat").performClick()
                compose.onNodeWithText("Delete chat?").assertIsDisplayed()
            }
            openConfirmation()
            compose.onNodeWithText("Cancel").performClick()
            row.assertIsDisplayed().assertIsSelected()
            assertEquals(0, requests.get())

            openConfirmation()
            compose.onNodeWithText("Delete").performClick()
            compose.waitUntil(10_000) { started.count == 0L }
            row.assertDoesNotExist()
            compose.onNodeWithTag("conversation").assertDoesNotExist()
            compose.onNodeWithTag("workspace_new_chat").assertExists()
            compose.onNodeWithText("Undo").assertDoesNotExist()
            release.countDown()
            compose.waitUntil(10_000) {
                currentList()?.let { list ->
                    CHAT_PERSONAL !in list.pendingRowActions &&
                        list.threads.none { it.id == CHAT_PERSONAL }
                } == true
            }
            row.assertDoesNotExist()
            assertEquals(1, requests.get())
        } finally {
            release.countDown()
        }
    }

    @Test
    fun aRejectedArchiveSwipeRestoresTheRowDuringRefreshAndCanBeRetried() {
        val app = compose.activity.application as ChatListApplication
        val requests = AtomicInteger()
        val holdRead = AtomicBoolean(false)
        val reading = CountDownLatch(1)
        val releaseRead = CountDownLatch(1)
        val writing = CountDownLatch(1)
        val rejectWrite = CountDownLatch(1)
        val events = app.fixture.rowEventTail()
        val eventResponse = app.fixture.events
        app.fixture.events = { request ->
            if (holdRead.get() && request.requestUrl?.queryParameter("sinceSeqId") != null) {
                reading.countDown()
                releaseRead.await()
            }
            eventResponse(request)
        }
        app.fixture.commandResponse = { request ->
            if (request.requestUrl?.encodedPath != "/api/chat-threads/$CHAT_PERSONAL/archive") null
            else if (requests.incrementAndGet() == 1) {
                writing.countDown()
                rejectWrite.await()
                MockResponse().setResponseCode(400)
            } else {
                events.add(24L to request.rowEvent(24, CHAT_PERSONAL, "archived"))
                MockResponse().setResponseCode(204)
            }
        }
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            val rowTag = "chat_$CHAT_PERSONAL"
            val row = compose.onNodeWithTag(rowTag)
            compose.onNodeWithTag("chat_list").performScrollToNode(hasTestTag(rowTag))
            holdRead.set(true)
            reconnectList(app)
            compose.waitUntil(10_000) { compose.runOnIdle { reading.count == 0L } }
            row.performTouchInput { swipe(center.copy(x = width * 0.8f), center) }
            compose.waitUntil(10_000) { compose.runOnIdle { writing.count == 0L } }
            row.assertDoesNotExist()
            rejectWrite.countDown()
            compose.waitUntil(10_000) {
                compose
                    .onAllNodesWithText("Could not finish changing the chat.")
                    .fetchSemanticsNodes()
                    .isNotEmpty()
            }
            row.assertIsDisplayed()
            compose.onNodeWithText("Refresh chats").assertDoesNotExist()
            compose.onNodeWithText("Undo").assertDoesNotExist()
            awaitRowActionSettled(CHAT_PERSONAL)

            releaseRead.countDown()
            row.performTouchInput { swipe(center.copy(x = width * 0.8f), center) }
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("Chat archived").fetchSemanticsNodes().isNotEmpty()
            }
            row.assertDoesNotExist()
            assertEquals(2, requests.get())
        } finally {
            rejectWrite.countDown()
            releaseRead.countDown()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun archivingInACompactConversationKeepsUndoBesideTheComposer() {
        val app = compose.activity.application as ChatListApplication
        val fixture = app.fixture
        val events = fixture.rowEventTail()
        fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/chat-threads/$CHAT_PERSONAL/archive" -> {
                    events.add(24L to request.rowEvent(24, CHAT_PERSONAL, "archived"))
                    MockResponse().setResponseCode(204)
                }
                "/api/chat-threads/$CHAT_PERSONAL/unarchive" -> {
                    events.add(25L to request.rowEvent(25, CHAT_PERSONAL, "unarchived"))
                    MockResponse().setResponseCode(204)
                }
                else -> null
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithTag("chat_$CHAT_PERSONAL").performClick()
        val composer = compose.onNodeWithTag("chat_composer").assertIsDisplayed()
        val bottom = composer.getUnclippedBoundsInRoot().bottom
        compose.onNodeWithContentDescription("Chat actions").performClick()
        compose.onNodeWithText("Archive chat").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodes(hasText("Undo") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
        val feedback = compose.onNodeWithTag("conversation_feedback").assertIsDisplayed()
        val composerTop = composer.getUnclippedBoundsInRoot().top
        assertTrue(feedback.getUnclippedBoundsInRoot().bottom <= composerTop)
        compose.onNodeWithText("Undo").assertIsDisplayed().performClick()
        compose.onNodeWithTag("conversation").assertIsDisplayed()
        assertEquals(bottom, composer.assertIsDisplayed().getUnclippedBoundsInRoot().bottom)
        compose.onNodeWithContentDescription("Back").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodes(hasTestTag("chat_$CHAT_PERSONAL")).fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w1000dp-h800dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun archiveAndRestoreUpdatePlacementAndKeepTheOpenConversation() {
        val app = compose.activity.application as ChatListApplication
        val fixture = app.fixture
        val readback = CountDownLatch(1)
        val release = CountDownLatch(1)
        val events =
            fixture.rowEventTail {
                if (it == 23L) {
                    readback.countDown()
                    release.await()
                }
            }
        val commands = CopyOnWriteArrayList<RecordedRequest>()
        fixture.commandResponse = { request ->
            if (request.method != "POST") null
            else
                when (request.requestUrl?.encodedPath) {
                    "/api/chat-threads/$CHAT_PERSONAL/archive" -> {
                        commands.add(request)
                        events.add(24L to request.rowEvent(24, CHAT_PERSONAL, "archived"))
                        MockResponse().setResponseCode(204)
                    }
                    "/api/chat-threads/$CHAT_PERSONAL/unarchive" -> {
                        commands.add(request)
                        events.add(25L to request.rowEvent(25, CHAT_PERSONAL, "unarchived"))
                        MockResponse().setResponseCode(204)
                    }
                    else -> null
                }
        }
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            val rowTag = "chat_$CHAT_PERSONAL"
            val target = hasTestTag(rowTag)
            val row = compose.onNode(target)
            compose.onNodeWithTag("chat_list").performScrollToNode(target)
            row.performClick()
            compose.waitUntil(10_000) {
                compose
                    .onAllNodesWithText("Native history", substring = true)
                    .fetchSemanticsNodes()
                    .isNotEmpty()
            }
            row.performTouchInput {
                val second = center.copy(x = width * 0.45f)
                down(0, center.copy(x = width * 0.8f))
                down(1, second)
                up(0)
                moveTo(1, second.copy(x = second.x - 20.dp.toPx()))
                up(1)
            }
            row.assertIsDisplayed()
            row.performTouchInput {
                val first = center.copy(x = width * 0.8f)
                val second = center.copy(x = width * 0.55f)
                down(0, first)
                moveTo(0, first.copy(x = first.x - 24.dp.toPx()))
                down(1, second)
                up(0)
                moveTo(1, second.copy(x = second.x - 84.dp.toPx()))
                up(1)
            }
            row.assertIsDisplayed()
            assertTrue(commands.isEmpty())
            row.performTouchInput { longClick() }
            compose.onNodeWithText("Archive chat").performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { readback.count == 0L } }
            row.assertDoesNotExist()
            compose.onNodeWithTag("conversation").assertExists()
            release.countDown()
            compose.waitUntil(10_000) { compose.onAllNodes(target).fetchSemanticsNodes().isEmpty() }
            compose.onNodeWithContentDescription("Filter").performClick()
            compose.onNodeWithText("Archived").performClick()
            val filterLabel = "Archived"
            val filterLayouts = mutableListOf<TextLayoutResult>()
            compose
                .onNodeWithTag("chat_filter_heading", useUnmergedTree = true)
                .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { read ->
                    read(filterLayouts)
                }
            val filterLayout = filterLayouts.single()
            assertEquals(filterLabel.length, filterLayout.getLineEnd(0, visibleEnd = true))
            compose.onNodeWithTag("chat_list").performScrollToNode(target)
            awaitRowActionSettled(CHAT_PERSONAL)
            compose.onNodeWithTag(rowTag).performSemanticsAction(SemanticsActions.OnLongClick)
            compose.onNodeWithText("Unarchive chat").performClick()
            compose.waitUntil(10_000) { compose.onAllNodes(target).fetchSemanticsNodes().isEmpty() }
            compose.onNodeWithContentDescription("Filter").performClick()
            compose.onNodeWithText("Inbox").performClick()
            compose.onNodeWithTag("chat_list").performScrollToNode(target)
            compose.onNodeWithTag(rowTag).assertExists()
            compose.onNodeWithTag("conversation").assertExists()
            awaitRowActionSettled(CHAT_PERSONAL)
            assertEquals(
                listOf("archive", "unarchive"),
                commands.map { it.requestUrl?.pathSegments?.last() },
            )
            assertEquals(
                2,
                commands.mapNotNull { it.requestUrl?.queryParameter("eventId") }.distinct().size,
            )
        } finally {
            release.countDown()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun titleAndPinsAppearBeforeWriteAndReadbackComplete() {
        val app = compose.activity.application as ChatListApplication
        val readback = CountDownLatch(1)
        val release = CountDownLatch(1)
        val pinResponse = CountDownLatch(1)
        val fixture = app.fixture
        val events =
            fixture.rowEventTail {
                readback.countDown()
                release.await()
            }
        val commands = CopyOnWriteArrayList<RecordedRequest>()
        fixture.commandResponse = { request ->
            if (request.method != "POST") null
            else
                when (request.requestUrl?.encodedPath) {
                    "/api/chat-threads/$CHAT_PERSONAL/rename" -> {
                        commands.add(request)
                        val body = request.jsonCommandBody()
                        events.add(
                            24L to
                                chatEventWire(
                                    id = body.getValue("eventId").jsonPrimitive.content,
                                    seq = 24,
                                    kind = "renamed",
                                    title = body.getValue("title").jsonPrimitive.content,
                                )
                        )
                        MockResponse().setResponseCode(503)
                    }
                    "/api/chat-threads/$CHAT_PERSONAL/pin" -> {
                        commands.add(request)
                        pinResponse.await()
                        val rank = request.requestUrl?.queryParameter("pinOrder")
                        events.add(
                            25L to
                                request.rowEvent(
                                    25,
                                    CHAT_PERSONAL,
                                    "pinned",
                                    ",\"pinOrder\":\"$rank\"",
                                )
                        )
                        MockResponse().setResponseCode(204)
                    }
                    "/api/chat-threads/$CHAT_PERSONAL/unpin" -> {
                        commands.add(request)
                        events.add(26L to request.rowEvent(26, CHAT_PERSONAL, "unpinned"))
                        MockResponse().setResponseCode(204)
                    }
                    else -> null
                }
        }
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("Personal chat").fetchSemanticsNodes().isNotEmpty()
            }
            val row = compose.onNodeWithTag("chat_$CHAT_PERSONAL")
            fun choose(label: String) {
                row.performSemanticsAction(SemanticsActions.OnLongClick)
                compose.onNodeWithText(label).performClick()
            }
            compose.runOnIdle {
                val model =
                    checkNotNull(
                            ViewModelProvider(compose.activity)[SessionModel::class.java]
                                .uiState
                                .value
                                .ready
                        )
                        .chats
                model.renameThread(CHAT_PERSONAL, "   ")
                model.renameThread(CHAT_PERSONAL, "Personal chat")
                model.renameThread(CHAT_PERSONAL, "  Weekly brief  ")
                assertEquals(
                    ChatRowAction.Rename,
                    model.uiState.value.pendingRowActions[CHAT_PERSONAL],
                )
            }
            compose.waitUntil(10_000) { compose.runOnIdle { readback.count == 0L } }
            row.assert(hasText("Weekly brief"))
            assertEquals(1, commands.size)
            release.countDown()
            awaitRowActionSettled(CHAT_PERSONAL)
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("Weekly brief").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText("Could not confirm the chat change.").assertDoesNotExist()

            val pinned =
                SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Active, Pinned")
            val personal = hasTestTag("chat_$CHAT_PERSONAL")
            row.performSemanticsAction(SemanticsActions.OnLongClick)
            compose.onNodeWithText("Rename chat").assertExists()
            compose.onNodeWithText("Pin chat").performClick()
            val pendingPin =
                SemanticsMatcher.expectValue(
                    SemanticsProperties.StateDescription,
                    "Active, Pinned, Updating chat…",
                )
            compose.waitUntil(10_000) {
                compose.onAllNodes(personal.and(pendingPin)).fetchSemanticsNodes().isNotEmpty()
            }
            pinResponse.countDown()
            awaitRowActionSettled(CHAT_PERSONAL)
            compose.waitUntil(10_000) {
                compose.onAllNodes(personal.and(pinned)).fetchSemanticsNodes().isNotEmpty()
            }
            choose("Unpin chat")
            awaitRowActionSettled(CHAT_PERSONAL)
            compose.waitUntil(10_000) {
                compose.onAllNodes(personal.and(!pinned)).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithTag("conversation").assertDoesNotExist()
            assertEquals(
                listOf("rename", "pin", "unpin"),
                commands.map { it.requestUrl?.pathSegments?.last() },
            )
            assertEquals(
                "Weekly brief",
                commands[0].jsonCommandBody().getValue("title").jsonPrimitive.content,
            )
            assertEquals("a0", commands[1].requestUrl?.queryParameter("pinOrder"))
            val renameId = commands[0].jsonCommandBody().getValue("eventId").jsonPrimitive.content
            assertEquals(renameId, UUID.fromString(renameId).toString())
            assertEquals(
                3,
                (listOf(renameId) +
                        commands.drop(1).mapNotNull { it.requestUrl?.queryParameter("eventId") })
                    .distinct()
                    .size,
            )
        } finally {
            release.countDown()
            pinResponse.countDown()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w1000dp-h800dp")
    fun projectMoveReadsBackPartialTieWritesAndCanRecover() {
        val app = compose.activity.application as ChatListApplication
        val fixture = app.fixture
        val neighbor = "99999999-9999-4999-8999-999999999999"
        val outside = "18888888-8888-4888-8888-888888888888"
        fun seed(seq: Long, id: String, title: String, rank: String, project: Boolean) =
            listOf(
                chatEventWire(
                    id = "00000000-0000-4000-8000-${seq.toString().padStart(12, '0')}",
                    seq = seq,
                    thread = id,
                    title = title,
                    extra = if (project) ",\"projectId\":\"$CHAT_PROJECT\"" else "",
                ),
                chatEventWire(
                    id = "00000000-0000-4000-8000-${(seq + 1).toString().padStart(12, '0')}",
                    seq = seq + 1,
                    thread = id,
                    kind = "pinned",
                    extra = ",\"pinOrder\":\"$rank\"",
                ),
            )
        val initial =
            seed(17, CHAT_PERSONAL, "First Project pin", "a0", true) +
                seed(19, neighbor, "Neighbor pin", "a1", true) +
                seed(21, CHAT_IN_PROJECT, "Tied Project pin", "a1", true) +
                seed(23, outside, "Outside pin", "a1", false)
        fixture.events = {
            jsonResponse("""{"events":[${initial.joinToString(",")}],"hasMore":false}""")
        }
        val events = fixture.rowEventTail()
        val rejectMoved = AtomicBoolean(true)
        val commands = CopyOnWriteArrayList<RecordedRequest>()
        fixture.commandResponse = { request ->
            val url = request.requestUrl
            if (request.method != "POST" || url?.pathSegments?.lastOrNull() != "pin-order") null
            else {
                val id = url.pathSegments[2]
                commands.add(request)
                if (id == CHAT_PERSONAL && rejectMoved.get()) MockResponse().setResponseCode(503)
                else {
                    val seq = 24L + commands.size
                    val body = request.jsonCommandBody()
                    events.add(
                        seq to
                            chatEventWire(
                                id = body.getValue("eventId").jsonPrimitive.content,
                                seq = seq,
                                thread = id,
                                kind = "sort_touched",
                                extra = ",\"pinOrder\":${body.getValue("pinOrder")}",
                            )
                    )
                    MockResponse().setResponseCode(204)
                }
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        setResearchExpanded(true)
        val first = compose.onNodeWithTag("chat_$CHAT_PERSONAL")
        val target = compose.onNodeWithTag("chat_$neighbor")
        fun moveDown() {
            first.performSemanticsAction(SemanticsActions.OnLongClick)
            compose.onNodeWithText("Move up").assertDoesNotExist()
            compose.onNodeWithText("Move down").performClick()
        }
        moveDown()
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithText("Could not confirm the chat change.")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        assertTrue(
            target.fetchSemanticsNode().boundsInRoot.top <
                first.fetchSemanticsNode().boundsInRoot.top
        )
        compose.onNodeWithContentDescription("Dismiss").assertIsDisplayed()
        compose.onNodeWithText("Refresh chats").performClick()
        compose.waitUntil(10_000) {
            first.fetchSemanticsNode().boundsInRoot.top <
                target.fetchSemanticsNode().boundsInRoot.top
        }
        assertTrue(
            first.fetchSemanticsNode().boundsInRoot.top <
                target.fetchSemanticsNode().boundsInRoot.top
        )
        rejectMoved.set(false)
        moveDown()
        awaitRowActionSettled(CHAT_PERSONAL)
        compose.waitUntil(10_000) {
            target.fetchSemanticsNode().boundsInRoot.top <
                first.fetchSemanticsNode().boundsInRoot.top
        }
        val tied = compose.onNodeWithTag("chat_$CHAT_IN_PROJECT")
        assertTrue(
            first.fetchSemanticsNode().boundsInRoot.top < tied.fetchSemanticsNode().boundsInRoot.top
        )
        assertEquals(
            listOf(CHAT_IN_PROJECT to "a3", CHAT_PERSONAL to "a2", CHAT_PERSONAL to "a2"),
            commands.map { command ->
                command.requestUrl?.pathSegments?.get(2) to
                    command.jsonCommandBody().getValue("pinOrder").jsonPrimitive.content
            },
        )
        assertEquals(
            3,
            commands
                .map { it.jsonCommandBody().getValue("eventId").jsonPrimitive.content }
                .toSet()
                .size,
        )
    }

    private fun setResearchExpanded(expanded: Boolean) {
        val project = hasText("Research")
        val before = if (expanded) SemanticsActions.Expand else SemanticsActions.Collapse
        val after = if (expanded) SemanticsActions.Collapse else SemanticsActions.Expand
        compose.onNodeWithTag("chat_list").performScrollToNode(project)
        compose.onNode(project.and(SemanticsMatcher.keyIsDefined(before))).performClick()
        compose.waitUntil(10_000) {
            compose
                .onAllNodes(project.and(SemanticsMatcher.keyIsDefined(after)))
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
    }

    private fun awaitRowActionSettled(id: String) {
        val menuAvailable =
            hasTestTag("chat_$id").and(SemanticsMatcher.keyIsDefined(SemanticsActions.OnLongClick))
        compose.waitUntil(10_000) {
            compose.onAllNodes(menuAvailable).fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun RecordedRequest.jsonCommandBody() =
        Json.parseToJsonElement(body.clone().readUtf8()).jsonObject

    private fun awaitListAndNames() {
        compose.waitUntil(10_000) {
            val state = currentList() ?: return@waitUntil false
            state.confirmedAt != null &&
                state.projectsPhase != ai.okou.android.chat.ChatReadPhase.Loading &&
                state.indicatorsPhase != ai.okou.android.chat.ChatReadPhase.Loading
        }
    }

    private fun currentList() =
        compose.runOnIdle {
            ViewModelProvider(compose.activity)[SessionModel::class.java]
                .uiState
                .value
                .ready
                ?.chats
                ?.uiState
                ?.value
        }

    private fun reconnectList(app: ChatListApplication) {
        compose.runOnIdle { app.connectivity.value = false }
        compose.waitUntil(10_000) { currentList()?.offline == true }
        compose.runOnIdle { app.connectivity.value = true }
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun unreadWithoutIndicatorsOffersRecoveryWhileInboxKeepsItsRows() {
        val app = compose.activity.application as ChatListApplication
        val failing = AtomicBoolean(true)
        val indicators = app.fixture.indicators
        app.fixture.indicators = {
            if (failing.get()) MockResponse().setResponseCode(503) else indicators()
        }
        app.responseGate.countDown()
        awaitListAndNames()
        val loadFailure = "Temporarily unable to load"
        compose.onNodeWithText("Personal chat").assertIsDisplayed()
        compose.onNodeWithText(loadFailure).assertDoesNotExist()

        compose.onNodeWithContentDescription("Filter").performClick()
        compose.onNodeWithText("Unread").performClick()
        awaitListAndNames()
        compose.onNodeWithText(loadFailure).assertIsDisplayed()
        compose.onNodeWithText("No unread chats").assertDoesNotExist()

        failing.set(false)
        compose.onNodeWithText("Try again").performClick()
        awaitListAndNames()
        compose.onNodeWithText(loadFailure).assertDoesNotExist()
        setResearchExpanded(true)
        compose.onNodeWithText("Project chat").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "en-rUS-w320dp-h270dp")
    fun aShortPaneScrollsNewChatAndOfflineStatusWithTheRows() {
        val app = compose.activity.application as ChatListApplication
        val rows =
            (1..14).joinToString(",") { index ->
                val suffix = index.toString().padStart(12, '0')
                chatEventWire(
                    id = "61000000-0000-4000-8000-$suffix",
                    seq = index.toLong(),
                    thread = "62000000-0000-4000-8000-$suffix",
                    title = "Short pane chat $index",
                )
            }
        app.fixture.events = { request ->
            val events = if (request.requestUrl?.queryParameter("sinceSeqId") == null) rows else ""
            jsonResponse("""{"events":[$events],"hasMore":false}""")
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.runOnIdle { app.connectivity.value = false }
        compose.onNodeWithTag("chat_list_bottom_status").assertIsDisplayed()
        compose.onNodeWithText("New chat").assertIsDisplayed()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Short pane chat 1"))
        compose.onNodeWithText("Short pane chat 1").assertIsDisplayed()
        compose.onNodeWithText("New chat").assertDoesNotExist()
        compose.onNodeWithTag("chat_list").performScrollToIndex(0)
        compose.onNodeWithText("New chat").assertIsDisplayed()
        compose.onNodeWithTag("chat_list_bottom_status").assertIsDisplayed()
    }
}
