package ai.okou.android

import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ChatRowAction
import android.content.res.Configuration
import android.os.Looper
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.MouseButton
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performMouseInput
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.compose.ui.text.TextRange
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
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
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
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
    fun titleSearchRestoresTheQueryAfterOpeningAnArchivedChatAndResizing() {
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
                        agent = CHAT_OTHER_AGENT,
                    )
                val archived =
                    chatEventWire(
                        id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                        seq = 24,
                        thread = CHAT_IN_PROJECT,
                        kind = "archived",
                        agent = CHAT_OTHER_AGENT,
                    )
                jsonResponse(
                    """{"events":[${chatEventWire()},$project,$archived],"hasMore":false}"""
                )
            }
        }
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithContentDescription("Search").performClick()
        compose.onNodeWithText("Recent chats").assertExists()
        compose.onNodeWithTag("chat_search_query").performTextInput("project")
        compose.onNodeWithTag("chat_search_query").performTextInputSelection(TextRange(3))
        compose.onNodeWithText("Personal chat").assertDoesNotExist()
        compose.onNodeWithText("Research · Archived").assertExists()
        compose.onNodeWithText("Project chat").performClick()
        compose.onNodeWithTag("conversation").assertExists()

        compose.runOnIdle {
            val wide =
                Configuration(compose.activity.resources.configuration).apply {
                    screenWidthDp = 1000
                }
            compose.activity.window.decorView.dispatchConfigurationChanged(wide)
        }
        compose.onNodeWithTag("chat_list").assertExists()
        compose.onNodeWithTag("conversation").assertExists()
        compose.runOnIdle {
            compose.activity.window.decorView.dispatchConfigurationChanged(
                compose.activity.resources.configuration
            )
        }
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
                        agent = CHAT_OTHER_AGENT,
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
        compose.onNodeWithContentDescription("Search").performClick()
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
    @Config(qualifiers = "en-rUS-w1000dp-h800dp")
    fun wideTitleSearchReturnsTheListAndOpensTheResultInDetail() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithText("Personal chat").performClick()
        compose.onNodeWithContentDescription("Search").performClick()
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
        compose.onNodeWithTag("chat_$CHAT_IN_PROJECT").assertIsSelected()
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
            compose.onNodeWithContentDescription("Settings").performClick()
            compose.onNodeWithText("Appearance").assertExists()
            release.countDown()
            compose.waitUntil(10_000) {
                compose.runOnIdle {
                    chats.warming.state.value.phase == ai.okou.android.chat.ChatReadPhase.Failed
                }
            }
            compose.onNodeWithText("Appearance").assertExists()
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
        val gate = CountDownLatch(1)
        val indicatorsGate = CountDownLatch(1)
        val indicatorReads = java.util.concurrent.atomic.AtomicInteger()
        app.fixture.indicators = {
            if (indicatorReads.incrementAndGet() == 1) {
                indicatorsGate.await()
                jsonResponse(
                    """{"agents":{},"threads":{"$CHAT_IN_PROJECT":"unread"},"unreadAt":{"$CHAT_IN_PROJECT":"$CHAT_DATE"}}"""
                )
            } else jsonResponse("""{"agents":{},"threads":{},"unreadAt":{}}""")
        }
        app.fixture.beforeHistoryResponse = { request ->
            if (request.requestUrl?.encodedPath?.endsWith("/event-snapshot") == true) gate.await()
        }
        try {
            app.responseGate.countDown()
            awaitListAndNames()
            compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Project chat"))
            compose.onNodeWithText("Project chat").performClick()
            compose.onNodeWithTag("conversation").assertExists()
            compose.onNodeWithText("Loading conversation…").assertExists()
            compose.onNodeWithContentDescription("Settings").performClick()
            compose.onNodeWithText("Appearance").assertExists()
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
            indicatorsGate.countDown()
            compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
            compose.onNodeWithTag("conversation").assertDoesNotExist()
            compose.onNodeWithTag("chat_list").assertExists()
            compose.onNodeWithText("Project chat").assertExists()
            compose.onNodeWithText("Research").performClick()
            compose.onNodeWithText("Project chat").assertDoesNotExist()
            compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Research"))
            compose.onNodeWithText("Research").performClick()
            compose.onNodeWithText("Project chat").assertExists()
        } finally {
            gate.countDown()
            indicatorsGate.countDown()
            app.fixture.beforeHistoryResponse = {}
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
        compose.onNodeWithText("Appearance").assertExists()
    }

    @Test
    fun expiredSignedStorageKeepsTheWorkspaceOpenAndRetriesWithAFreshDescriptor() {
        val app = compose.activity.application as ChatListApplication
        app.fixture.snapshot = {
            jsonResponse(
                """{"url":"${app.fixture.server.url("/archive")}","expiresInSeconds":60,"latestEventId":null,"latestSeqId":null}"""
            )
        }
        app.fixture.archive = { okhttp3.mockwebserver.MockResponse().setResponseCode(403) }
        app.responseGate.countDown()
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithText("Could not load chats. Check your connection and try again.")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose.onNodeWithContentDescription("Chats").assertExists()
        app.fixture.archive = { jsonResponse("""{"chatThreads":[]}""") }
        val retry = compose.activity.getString(R.string.retry)
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText(retry))
        compose.onNodeWithText(retry).performClick()
        awaitListAndNames()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Project chat"))
        compose.onNodeWithText("Project chat").assertExists()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Appearance").assertExists()
    }

    @Test
    fun heldTransportKeepsNavigationAndRestoresTheListWithProjectStatus() {
        compose.onNodeWithContentDescription("Chats").assertExists()
        compose.onNodeWithText("Loading chats…").assertExists()
        compose.onNodeWithContentDescription("Switch workspace").performClick()
        compose.onNodeWithText("Workspace B").assertExists()
        compose.onNodeWithText("Back").performClick()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Appearance").assertExists()
        (compose.activity.application as ChatListApplication).responseGate.countDown()
        compose.onNodeWithContentDescription("Back").performClick()
        awaitListAndNames()
        val unread = SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Unread")
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Project chat"))
        compose.waitUntil(10_000) {
            compose
                .onAllNodes(hasText("Project chat").and(unread))
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose.onNodeWithText("Project chat").assert(unread)
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Research"))
        val projectUnreadCount =
            SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Unread 1")
        compose.onNodeWithText("Research").assert(!projectUnreadCount).performClick()
        compose.onNodeWithText("Research").assert(projectUnreadCount)
        compose.onNodeWithText("Project chat").assertDoesNotExist()
        compose.onNodeWithTag("chat_list").performScrollToIndex(0)
        compose.onNodeWithContentDescription("Filter").performClick()
        compose.onNodeWithText("Archived").performClick()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("No chats in this view."))
        compose.onNodeWithText("No chats in this view.").assertExists()
        compose.activityRule.scenario.recreate()
        awaitListAndNames()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("No chats in this view."))
        compose.onNodeWithText("No chats in this view.").assertExists()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun pullingBelowTheEmptyFilteredListRefreshesChats() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        compose.onNodeWithContentDescription("Filter").performClick()
        compose.onNodeWithText("Archived").performClick()
        compose.onNodeWithText("No chats in this view.").assertExists()

        app.fixture.events = { okhttp3.mockwebserver.MockResponse().setResponseCode(503) }
        compose.onRoot().performTouchInput {
            swipe(Offset(centerX, height * 0.6f), Offset(centerX, height * 0.9f))
        }

        val failure = app.getString(R.string.chat_refresh_failed)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(failure).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Filter · Archived").assertExists()
        compose.onNodeWithText(app.getString(R.string.retry)).assertExists()
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
        compose.onNodeWithText("Filter · Archived").assertExists()
        compose.onNodeWithText("No chats in this view.").assertIsDisplayed()
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
                    """{"agents":{},"threads":{"$CHAT_IN_PROJECT":"unread"},"unreadAt":{"$CHAT_IN_PROJECT":"$CHAT_DATE"}}"""
                )
            } else {
                jsonResponse("""{"agents":{},"threads":{},"unreadAt":{}}""")
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
        val marked = CopyOnWriteArrayList<String>()
        val events =
            listOf(
                chatEventWire(),
                chatEventWire(
                    id = UUID.randomUUID().toString(),
                    seq = 18,
                    thread = CHAT_IN_PROJECT,
                    extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                    agent = CHAT_OTHER_AGENT,
                    title = "Project chat",
                ),
                chatEventWire(
                    id = UUID.randomUUID().toString(),
                    seq = 19,
                    thread = CHAT_IN_PROJECT,
                    kind = "archived",
                    agent = CHAT_OTHER_AGENT,
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
            val threads = unread.keys.joinToString("") { id -> ",\"$id\":\"unread\"" }
            jsonResponse(
                """{"agents":{},"threads":{"$running":"active"$threads},"unreadAt":{$markers}}"""
            )
        }
        app.fixture.commandResponse = { request ->
            val path = request.requestUrl?.pathSegments.orEmpty()
            if (request.method != "POST" || path.lastOrNull() != "mark-read") {
                null
            } else {
                val id = path[2]
                marked.add(id)
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
            SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Unread 1")
        list.performScrollToNode(hasText("Research"))
        compose.onNodeWithText("Research").performClick()
        val filter = compose.onNodeWithContentDescription("Filter")
        filter.performClick()
        compose.onNodeWithText("Unread").performClick()
        list.performScrollToNode(hasText("Research"))
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
        markAll()
        awaitMessage("Some chats may still be unread.")
        assertEquals(setOf(CHAT_PERSONAL, CHAT_IN_PROJECT), marked.toSet())
        assertEquals(2, marked.size)
        list.performScrollToNode(hasText("Personal chat"))
        compose.onNodeWithText("Personal chat").assert(unread)
        compose.onNodeWithText("Research").assert(projectUnreadCount)
        rejectProject.set(false)
        markAll()
        awaitMessage("Marked 2 chats as read.")
        compose.onNodeWithText("Filter · Unread").assertExists()
        filter.performClick()
        compose.onNodeWithText("Unread").assertIsSelected()
        compose.onNodeWithText("Inbox").performClick()
        list.performScrollToNode(hasText("Running chat"))
        compose
            .onNodeWithText("Running chat")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Active"))
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
                jsonResponse("""{"agents":{},"threads":{$status},"unreadAt":{$value}}""")
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
        val failed = "Could not confirm the chat change."
        compose.waitUntil(10_000) {
            compose.onAllNodes(target.and(muted).and(available)).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(failed).assertDoesNotExist()
        row.performSemanticsAction(SemanticsActions.OnLongClick)
        compose.onNodeWithText("Mark as read").assertDoesNotExist()
        compose.onNodeWithText("Mark as unread").assertDoesNotExist()
        compose.onNodeWithText("Unmute chat").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(failed).fetchSemanticsNodes().isNotEmpty()
        }
        row.assert(muted)
        assertEquals(
            listOf("mute", "mark-read"),
            commands.map { it.requestUrl?.pathSegments?.last() },
        )

        rejectRead.set(false)
        row.performSemanticsAction(SemanticsActions.OnLongClick)
        compose.onNodeWithText("Unmute chat").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodes(target.and(!muted).and(available)).fetchSemanticsNodes().isNotEmpty()
        }
        row.assert(!unreadBadge)
        val refreshStatus = app.getString(R.string.chat_refresh_status)
        indicatorsUnavailable.set(false)
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText(refreshStatus))
        compose.onNodeWithText(refreshStatus).performClick()
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
    @Config(qualifiers = "en-rUS-w1000dp-h800dp")
    fun archiveAndRestoreFollowConfirmedPlacementAndKeepTheOpenConversation() {
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
            row.performTouchInput { longClick() }
            compose.onNodeWithText("Archive chat").performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { readback.count == 0L } }
            row.assert(!SemanticsMatcher.keyIsDefined(SemanticsActions.OnLongClick))
            compose.onNodeWithTag("conversation").assertExists()
            release.countDown()
            compose.waitUntil(10_000) { compose.onAllNodes(target).fetchSemanticsNodes().isEmpty() }
            compose.onNodeWithContentDescription("Filter").performClick()
            compose.onNodeWithText("Archived").performClick()
            compose.onNodeWithTag("chat_list").performScrollToNode(target)
            compose.onNodeWithTag(rowTag).performSemanticsAction(SemanticsActions.OnLongClick)
            compose.onNodeWithText("Unarchive chat").performClick()
            compose.waitUntil(10_000) { compose.onAllNodes(target).fetchSemanticsNodes().isEmpty() }
            compose.onNodeWithContentDescription("Filter").performClick()
            compose.onNodeWithText("Inbox").performClick()
            compose.onNodeWithTag("chat_list").performScrollToNode(target)
            compose.onNodeWithTag(rowTag).assertExists()
            compose.onNodeWithTag("conversation").assertExists()
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
    fun titleAndPinsFollowAuthoritativeReadback() {
        val app = compose.activity.application as ChatListApplication
        val readback = CountDownLatch(1)
        val release = CountDownLatch(1)
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
            row.assert(hasText("Personal chat"))
            assertEquals(1, commands.size)
            release.countDown()
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
            compose.waitUntil(10_000) {
                compose.onAllNodes(personal.and(pinned)).fetchSemanticsNodes().isNotEmpty()
            }
            choose("Unpin chat")
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
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w1000dp-h800dp")
    fun projectMoveReadsBackPartialTieWritesAndCanRecover() {
        val app = compose.activity.application as ChatListApplication
        val fixture = app.fixture
        val neighbor = "99999999-9999-4999-8999-999999999999"
        val outside = "18888888-8888-4888-8888-888888888888"
        fun seed(
            seq: Long,
            id: String,
            title: String,
            rank: String,
            project: Boolean,
            agent: String = CHAT_AGENT,
        ) =
            listOf(
                chatEventWire(
                    id = "00000000-0000-4000-8000-${seq.toString().padStart(12, '0')}",
                    seq = seq,
                    thread = id,
                    title = title,
                    agent = agent,
                    extra = if (project) ",\"projectId\":\"$CHAT_PROJECT\"" else "",
                ),
                chatEventWire(
                    id = "00000000-0000-4000-8000-${(seq + 1).toString().padStart(12, '0')}",
                    seq = seq + 1,
                    thread = id,
                    kind = "pinned",
                    agent = agent,
                    extra = ",\"pinOrder\":\"$rank\"",
                ),
            )
        val initial =
            seed(17, CHAT_PERSONAL, "First Project pin", "a0", true) +
                seed(19, neighbor, "Other agent pin", "a1", true, CHAT_OTHER_AGENT) +
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
            first.fetchSemanticsNode().boundsInRoot.top <
                target.fetchSemanticsNode().boundsInRoot.top
        )
        rejectMoved.set(false)
        moveDown()
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

    private fun RecordedRequest.jsonCommandBody() =
        Json.parseToJsonElement(body.clone().readUtf8()).jsonObject

    private fun ChatListApiFixture.rowEventTail(
        beforeReadback: (Long) -> Unit = {}
    ): MutableList<Pair<Long, String>> {
        val initialEvents = events
        val tail = CopyOnWriteArrayList<Pair<Long, String>>()
        events = { request ->
            val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLong()
            if (since == null) initialEvents(request)
            else {
                if (tail.isNotEmpty()) beforeReadback(since)
                val observed = tail.filter { it.first > since }.joinToString(",") { it.second }
                jsonResponse("""{"events":[$observed],"hasMore":false}""")
            }
        }
        return tail
    }

    private fun RecordedRequest.rowEvent(
        seq: Long,
        thread: String,
        kind: String,
        extra: String = "",
    ): String {
        val id = checkNotNull(requestUrl?.queryParameter("eventId"))
        assertEquals(id, UUID.fromString(id).toString())
        assertEquals("Bearer fixture-token", getHeader("Authorization"))
        assertEquals(0L, bodySize)
        return chatEventWire(id = id, seq = seq, thread = thread, kind = kind, extra = extra)
    }

    private fun awaitListAndNames() {
        compose.waitUntil(10_000) {
            listOf(R.string.chat_loading, R.string.chat_refreshing, R.string.chat_metadata_loading)
                .all { label ->
                    compose
                        .onAllNodesWithText(compose.activity.getString(label))
                        .fetchSemanticsNodes()
                        .isEmpty()
                }
        }
    }
}
