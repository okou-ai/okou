package ai.okou.android

import ai.okou.android.auth.SessionModel
import android.os.Looper
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.Job
import org.junit.After
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
        compose.onNodeWithText("Chats").assertExists()
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
            compose.onNodeWithText("Chats").assertExists()
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
        compose.onNodeWithText("Chats").assertExists()
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
        compose.onNodeWithText("Chats").assertExists()
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
        compose.onNodeWithText("Research").assert(!unread).performClick()
        compose.onNodeWithText("Research").assert(unread)
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
        compose.onNodeWithText("Archived").assertExists()
        compose.onNodeWithText(app.getString(R.string.retry)).assertExists()
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
