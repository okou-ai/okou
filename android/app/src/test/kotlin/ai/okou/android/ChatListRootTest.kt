package ai.okou.android

import ai.okou.android.auth.SessionModel
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.Job
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
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
            compose.onNodeWithText("Conversations").performClick()
            compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Research"))
            compose.onNode(hasText("Research") and hasClickAction()).performSemanticsAction(
                SemanticsActions.OnClick
            ) {
                it()
            }
            compose.onNodeWithTag("chat_list").assertExists()
            compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Research"))
            compose.onNode(hasText("Research") and hasClickAction()).performSemanticsAction(
                SemanticsActions.OnClick
            ) {
                it()
            }
            compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
            compose.onNodeWithTag("chat_list").assertDoesNotExist()
            compose.onNodeWithTag("conversation").assertExists()
            compose.onNodeWithText("Back").performClick()
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
        compose.activityRule.scenario.close()
        compose.waitUntil(10_000) { chatJob?.isCompleted != false }
        try {
            app.fixture.close()
        } finally {
            app.cacheSnapshot.restore()
        }
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
    fun heldTransportKeepsNativeNavigationAndThenShowsCanonicalProjectAndAgentContext() {
        compose.onNodeWithText("Chats").assertExists()
        compose.onNodeWithText("Loading chats…").assertExists()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Appearance").assertExists()
        (compose.activity.application as ChatListApplication).responseGate.countDown()
        compose.onNodeWithContentDescription("Back").performClick()
        awaitListAndNames()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("Project chat"))
        compose.onNodeWithText("Project chat").assertExists()
        compose.onNodeWithText("Research Okou").assertExists()
        compose.onNodeWithTag("chat_list").performScrollToIndex(0)
        compose.onNode(hasText("Archived").and(hasClickAction())).performClick()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("No chats in this view."))
        compose.onNodeWithText("No chats in this view.").assertExists()
        compose.activityRule.scenario.recreate()
        awaitListAndNames()
        compose.onNodeWithTag("chat_list").performScrollToNode(hasText("No chats in this view."))
        compose.onNodeWithText("No chats in this view.").assertExists()
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
