package ai.okou.android

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.auth.OpeningWorkspace
import ai.okou.android.auth.SessionModel
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.ComposerPersistence
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.chat.plainText
import android.content.Intent
import android.os.Looper
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.TextRange
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

class ComposerRootApplication : TestOkouApplication() {
    lateinit var fixture: ComposerApiFixture
    lateinit var cacheSnapshot: ChatCacheSnapshot
    val contextGate = CountDownLatch(1)
    val sendGate = CountDownLatch(1)
    var preferencesResponse = CompletableDeferred(Unit)
    val journalDirectory by lazy { noBackupFilesDir.resolve("composer-root-${UUID.randomUUID()}") }

    override fun onCreate() {
        fixture = ComposerApiFixture()
        fixture.beforeContextReturn = { contextGate.await() }
        fixture.beforeSendReturn = { sendGate.await() }
        chatService = fixture.service
        composerService = fixture.service
        journalStore = ComposerJournalStore(this, journalDirectory)
        cacheSnapshot = ChatCacheSnapshot(noBackupFilesDir.resolve("chat-list"), chatCache)
        super.onCreate()
    }

    override fun createWorkspaceSession(
        identity: WorkspaceIdentity,
        tokens: WorkspaceTokenProvider,
    ): WorkspaceSession {
        val service = super.createWorkspaceSession(identity, tokens)
        return object : WorkspaceSession by service {
            override suspend fun preferences(): UserPreferences {
                preferencesResponse.await()
                return service.preferences()
            }
        }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w400dp-h800dp",
    application = ComposerRootApplication::class,
)
class ChatComposerRootTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private var editorJob: Job? = null
    private var listJob: Job? = null
    private var editor: ai.okou.android.chat.ChatComposerModel? = null
    private var replacement: ActivityScenario<MainActivity>? = null
    private var cleanupApplication: ComposerRootApplication? = null

    private fun messageText(eventId: String, text: String) =
        compose.onNode(
            hasText(text) and hasAnyAncestor(hasTestTag("message_$eventId")),
            useUnmergedTree = true,
        )

    private fun awaitConversation(condition: () -> Boolean) {
        compose.waitUntil(10_000) {
            // Drive composition and Main-looper HTTP completions before reading the fixture.
            compose.onAllNodesWithTag("conversation").fetchSemanticsNodes()
            condition()
        }
    }

    private fun captureOwners(activity: MainActivity = compose.activity) {
        compose.runOnIdle {
            val state = ViewModelProvider(activity)[SessionModel::class.java].uiState.value
            val opened = state.opening as? OpeningWorkspace.Authorized
            val composer = checkNotNull(state.ready?.composer ?: opened?.composer)
            val chats = checkNotNull(state.ready?.chats ?: opened?.chats)
            editorJob = composer.viewModelScope.coroutineContext[Job]
            editor = composer
            listJob = chats.viewModelScope.coroutineContext[Job]
        }
    }

    @Test
    fun unversionedJournalShowsStorageFailureWithoutBlockingHistoryOrNavigation() {
        val app = compose.activity.application as ComposerRootApplication
        cleanupApplication = app
        app.contextGate.countDown()
        compose.onNodeWithText("New chat").performClick()
        compose.onNodeWithTag("message_input").performTextInput("Retained draft before retirement")
        captureOwners()
        compose.waitUntil(10_000) {
            compose.runOnIdle { editor?.uiState?.value?.persistence == ComposerPersistence.Durable }
        }
        compose.activityRule.scenario.close()
        compose.waitUntil(10_000) {
            shadowOf(Looper.getMainLooper()).idle()
            editorJob?.isCompleted != false && listJob?.isCompleted != false
        }
        runBlocking { checkNotNull(app.journalStore).close() }
        val file = checkNotNull(app.journalDirectory.listFiles()).single { it.extension == "json" }
        file.writeText("{}")
        app.journalStore = ComposerJournalStore(app, app.journalDirectory)
        val fresh = ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java))
        replacement = fresh
        compose.onNodeWithText("New chat").performClick()
        var activity: MainActivity? = null
        fresh.onActivity { activity = it }
        captureOwners(checkNotNull(activity))
        fun assertStorageFailure() {
            compose.waitUntil(10_000) {
                compose
                    .onAllNodesWithText("Draft changes could not be saved on this device.")
                    .fetchSemanticsNodes()
                    .isNotEmpty()
            }
            compose
                .onNodeWithText("Draft changes could not be saved on this device.")
                .assertExists()
            compose.onNodeWithTag("message_input").assertIsNotEnabled()
            compose.onNodeWithContentDescription("Send").assertIsNotEnabled()
        }
        assertStorageFailure()
        compose.onNodeWithText("Try again").performClick()
        assertStorageFailure()
        val chats =
            compose.runOnIdle {
                checkNotNull(
                        ViewModelProvider(checkNotNull(activity))[SessionModel::class.java]
                            .uiState
                            .value
                            .ready
                    )
                    .chats
            }
        // Finish the real HTTP warm and cache write before opening the unselected conversation.
        compose.waitUntil(10_000) {
            compose.runOnIdle { chats.warming.state.value.phase == ChatReadPhase.Ready }
        }
        assertEquals(0, app.fixture.chats.readRequests.get())
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithText("Personal chat").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("No messages yet.").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("No messages yet.").assertExists()
        compose.onNodeWithTag("message_input").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Send").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithContentDescription("Chats").assertExists()
        assertEquals("{}", file.readText())
        assertEquals(0, app.fixture.requests.count { it.method == "POST" })
    }

    @Test
    @Config(qualifiers = "en-rUS-w540dp-h320dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun shortConversationKeepsSpaceForTheTranscriptWhenTheDraftGrows() {
        val app = compose.activity.application as ComposerRootApplication
        app.contextGate.countDown()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Personal chat").fetchSemanticsNodes().size == 1
        }
        compose.onNodeWithText("Personal chat").performClick()
        captureOwners()
        val input = compose.onNodeWithTag("message_input").assertIsEnabled()
        val transcript = compose.onNodeWithTag("conversation").assertIsDisplayed()
        val saving = hasText("Saving draft on this device…") or hasText("Syncing draft…")
        fun enterDraft(text: String) {
            input.performTextReplacement(text)
            compose.waitUntil(10_000) {
                compose.onAllNodes(saving).fetchSemanticsNodes().isEmpty() &&
                    app.fixture.drafts["/api/chat-threads/$CHAT_PERSONAL/draft"]?.plainText() ==
                        text
            }
        }

        enterDraft("First line")
        val initialBounds = transcript.getUnclippedBoundsInRoot()
        val draft = "First line\nSecond line\nThird line\nFinal line"
        enterDraft(draft)

        val finalBounds = transcript.assertIsDisplayed().getUnclippedBoundsInRoot()
        assertEquals(initialBounds.bottom - initialBounds.top, finalBounds.bottom - finalBounds.top)
        assertEquals(
            draft,
            input.fetchSemanticsNode().config[SemanticsProperties.EditableText].text,
        )
        compose.onNodeWithContentDescription("Send").assertIsDisplayed().assertIsEnabled()
    }

    @Test
    fun longDraftStaysOutOfActivityStateAndKeepsSelectionAcrossRecreation() {
        compose.onNodeWithText("New chat").performClick()
        val input = compose.onNodeWithTag("message_input")
        val large = "Long chat draft 你好 👋 ".repeat(5_000)
        input.performTextReplacement(large)
        input.performTextInputSelection(TextRange(13, 29))
        assertEquals(
            TextRange(13, 29),
            input.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
        )
        // Native focus loss collapses an active selection; preserve the cursor on recreation.
        input.performTextInputSelection(TextRange(13))
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Display mode").assertExists()
        captureOwners()
        // Recreation runs the same complete Activity budget check as every Debug save.
        compose.activityRule.scenario.recreate()
        compose.onNodeWithText("Display mode").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        assertEquals(
            large,
            input.fetchSemanticsNode().config[SemanticsProperties.EditableText].text,
        )
        assertEquals(
            TextRange(13),
            input.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
        )
    }

    @Test
    fun firstInputIsVisibleThroughHeldCreateSendListAndHistory() {
        val app = compose.activity.application as ComposerRootApplication
        val create = CountDownLatch(1)
        val list = CountDownLatch(1)
        val history = CountDownLatch(1)
        val listStarted = CountDownLatch(1)
        val historyStarted = CountDownLatch(1)
        app.fixture.beforeCreateReturn = { create.await() }
        app.contextGate.countDown()
        try {
            compose.onNodeWithText("New chat").performClick()
            captureOwners()
            compose.waitUntil(10_000) { editor?.uiState?.value?.journal != null }
            val prompt = "First message before the server responds"
            compose.onNodeWithTag("message_input").performTextInput(prompt)
            compose.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
            compose.onNodeWithTag("conversation").assertIsDisplayed()
            awaitConversation { app.fixture.created.size == 1 }
            val pending = checkNotNull(editor?.uiState?.value?.entry(ComposerTarget())?.pending)
            messageText(pending.eventId, prompt).assertIsDisplayed()
            messageText(pending.eventId, "Sending…").assertIsDisplayed()
            assertEquals(0, app.fixture.inputs.size)
            compose.onNodeWithContentDescription("Back").performClick()
            compose.onNodeWithTag("chat_${pending.threadId}").assertIsDisplayed().performClick()
            messageText(pending.eventId, prompt).assertIsDisplayed()
            app.fixture.beforeListReturn = {
                listStarted.countDown()
                list.await()
            }
            app.fixture.beforeHistoryReturn = { id ->
                if (id == pending.threadId) {
                    historyStarted.countDown()
                    history.await()
                }
            }
            create.countDown()
            awaitConversation { app.fixture.inputs.size == 1 }
            messageText(pending.eventId, "Sending…").assertIsDisplayed()
            app.sendGate.countDown()
            awaitConversation { listStarted.count == 0L }
            messageText(pending.eventId, "Message accepted; waiting for processing.")
                .assertIsDisplayed()
            assertEquals(1L, historyStarted.count)
            compose.onNodeWithContentDescription("Back").performClick()
            compose.onNodeWithText("New chat").performClick()
            compose.onNodeWithTag("message_input").assertIsDisplayed()
            compose.onNodeWithContentDescription("Back").performClick()
            compose.onNodeWithTag("chat_${pending.threadId}").assertIsDisplayed().performClick()
            messageText(pending.eventId, prompt).assertIsDisplayed()
            list.countDown()
            awaitConversation { historyStarted.count == 0L }
            messageText(pending.eventId, prompt).assertIsDisplayed()
            history.countDown()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("New conversation").fetchSemanticsNodes().isNotEmpty() &&
                    compose
                        .onAllNodesWithTag("message_${pending.eventId}")
                        .fetchSemanticsNodes()
                        .size == 1 &&
                    pending.eventId !in editor?.uiState?.value?.receiptMessages.orEmpty()
            }
            messageText(pending.eventId, prompt).assertIsDisplayed()
            assertEquals(1, app.fixture.inputs.size)
        } finally {
            create.countDown()
            list.countDown()
            history.countDown()
        }
    }

    @Test
    fun pendingFirstSendRestoresAndCanRetryWhileWorkspacePreferencesAreUnavailable() {
        val app = compose.activity.application as ComposerRootApplication
        cleanupApplication = app
        val create = CountDownLatch(1)
        val list = CountDownLatch(1)
        app.fixture.beforeCreateReturn = { create.await() }
        app.contextGate.countDown()
        try {
            compose.onNodeWithText("New chat").performClick()
            captureOwners()
            awaitConversation { editor?.uiState?.value?.journal != null }
            val prompt = "Recover my pending first message from the inbox"
            compose.onNodeWithTag("message_input").performTextInput(prompt)
            compose.onNodeWithContentDescription("Send").performClick()
            awaitConversation { app.fixture.created.size == 1 }
            val pending = checkNotNull(editor?.uiState?.value?.entry(ComposerTarget())?.pending)
            app.fixture.beforeListReturn = { list.await() }
            compose.activityRule.scenario.close()
            compose.waitUntil(10_000) {
                shadowOf(Looper.getMainLooper()).idle()
                editorJob?.isCompleted == true && listJob?.isCompleted == true
            }
            create.countDown()
            runBlocking { checkNotNull(app.journalStore).close() }
            app.journalStore = ComposerJournalStore(app, app.journalDirectory)
            app.preferencesResponse = CompletableDeferred()
            val fresh = ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java))
            replacement = fresh
            val row = "chat_${pending.threadId}"
            awaitConversation { compose.onAllNodesWithTag(row).fetchSemanticsNodes().size == 1 }
            var activity: MainActivity? = null
            fresh.onActivity { activity = it }
            captureOwners(checkNotNull(activity))
            compose.onNodeWithTag(row).assertIsDisplayed()
            compose.onNodeWithContentDescription("Settings").assertDoesNotExist()
            compose.runOnIdle {
                app.preferencesResponse.completeExceptionally(
                    ApiFailure.Http(503, null, null, null)
                )
            }
            val unavailable = "Could not load your session or workspace. Please try again."
            awaitConversation {
                compose.onAllNodesWithText(unavailable).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithTag(row).assertIsDisplayed().performClick()
            messageText(pending.eventId, prompt).assertIsDisplayed()
            compose.onNodeWithText("Check delivery").assertExists()
            assertTrue(app.fixture.inputs.isEmpty())
            assertEquals(
                1,
                app.fixture.requests.count {
                    it.method == "POST" && it.requestUrl?.encodedPath == "/api/chat-threads"
                },
            )
            val retry = "Retry this same message"
            awaitConversation { editor?.uiState?.value?.busy?.isEmpty() == true }
            app.sendGate.countDown()
            compose.onNodeWithText(retry).assertIsEnabled().performClick()
            awaitConversation { app.fixture.inputs.containsKey(pending.eventId) }
            assertEquals(1, app.fixture.created.size)
            assertEquals(setOf(pending.eventId), app.fixture.inputs.keys)

            list.countDown()
            awaitConversation {
                compose.onAllNodesWithText("New conversation").fetchSemanticsNodes().isNotEmpty() &&
                    editor?.uiState?.value?.entry(ComposerTarget())?.createdThreadId == null
            }
            messageText(pending.eventId, prompt).assertIsDisplayed()
            compose.onNodeWithContentDescription("Back").performClick()
            compose.onNodeWithTag(row).assertIsDisplayed()
            compose.onNodeWithContentDescription("Settings").assertDoesNotExist()
        } finally {
            create.countDown()
            list.countDown()
            app.preferencesResponse.complete(Unit)
        }
    }

    @Test
    fun restoredAcceptedChatDeletedBeforeSnapshotDoesNotStayInTheInbox() {
        val app = compose.activity.application as ComposerRootApplication
        cleanupApplication = app
        val oldList = CountDownLatch(1)
        val detail = CountDownLatch(1)
        val detailRequested = AtomicBoolean(false)
        val cursorExpired = AtomicBoolean(false)
        app.contextGate.countDown()
        try {
            compose.waitUntil(10_000) {
                compose.onAllNodesWithTag("chat_$CHAT_PERSONAL").fetchSemanticsNodes().size == 1
            }
            compose.onNodeWithTag("chat_$CHAT_PERSONAL").assertIsDisplayed()
            compose.onNodeWithText("New chat").performClick()
            captureOwners()
            awaitConversation { editor?.uiState?.value?.journal != null }
            compose.onNodeWithTag("message_input").performTextInput("An accepted first send")
            compose.onNodeWithContentDescription("Send").performClick()
            awaitConversation { app.fixture.inputs.size == 1 }
            val pending = checkNotNull(editor?.uiState?.value?.entry(ComposerTarget())?.pending)
            app.fixture.beforeListReturn = { oldList.await() }
            app.sendGate.countDown()
            awaitConversation {
                val state = editor?.uiState?.value
                state?.entry(ComposerTarget())?.createdThreadId == pending.threadId &&
                    state?.persistence == ComposerPersistence.Durable
            }
            compose.activityRule.scenario.close()
            compose.waitUntil(10_000) {
                shadowOf(Looper.getMainLooper()).idle()
                editorJob?.isCompleted == true && listJob?.isCompleted == true
            }
            oldList.countDown()
            runBlocking { checkNotNull(app.journalStore).close() }
            app.journalStore = ComposerJournalStore(app, app.journalDirectory)

            fun jsonResponse(body: String) =
                MockResponse().setHeader("Content-Type", "application/json").setBody(body)
            val list = app.fixture.chats
            val reply = list.commandResponse
            list.commandResponse = { request ->
                if (
                    request.method == "GET" &&
                        request.requestUrl?.encodedPath == "/api/chat-threads/${pending.threadId}"
                ) {
                    detailRequested.set(true)
                    detail.await()
                    jsonResponse(
                            """{"error":{"code":"NOT_FOUND","message":"Chat thread not found"}}"""
                        )
                        .setResponseCode(404)
                } else reply(request)
            }
            list.events = { request ->
                val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull()
                if (since != null && since < 40L) {
                    cursorExpired.set(true)
                    jsonResponse("{}").setResponseCode(410)
                } else jsonResponse("""{"events":[],"hasMore":false}""")
            }
            list.snapshot = {
                jsonResponse(
                    """{"url":"${list.server.url("/archive")}","expiresInSeconds":60,"latestEventId":"$HISTORY_LAST_EVENT","latestSeqId":40}"""
                )
            }
            list.archive = { jsonResponse("""{"chatThreads":[]}""") }

            val fresh = ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java))
            replacement = fresh
            var activity: MainActivity? = null
            fresh.onActivity { activity = it }
            val row = "chat_${pending.threadId}"
            awaitConversation { cursorExpired.get() }
            awaitConversation { detailRequested.get() }
            compose.waitUntil(10_000) {
                compose.onAllNodesWithTag(row).fetchSemanticsNodes().size == 1
            }
            captureOwners(checkNotNull(activity))
            detail.countDown()
            awaitConversation {
                val state = editor?.uiState?.value
                state?.journal != null &&
                    state.entry(ComposerTarget()).createdThreadId == null &&
                    state.persistence == ComposerPersistence.Durable
            }
            compose.onNodeWithTag(row).assertDoesNotExist()
        } finally {
            oldList.countDown()
            detail.countDown()
        }
    }

    @Test
    fun rejectedFirstSendKeepsRecoveryAfterTheCreatedRowArrives() {
        val app = compose.activity.application as ComposerRootApplication
        app.contextGate.countDown()
        app.fixture.rejectSend = true
        compose.onNodeWithText("New chat").performClick()
        captureOwners()
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
        awaitConversation { editor?.uiState?.value?.journal != null }
        val prompt = "Keep my rejected first input"
        compose.onNodeWithTag("message_input").performTextInput(prompt)
        compose.onNodeWithContentDescription("Send").performClick()
        awaitConversation { app.fixture.created.size == 1 }
        val pending = checkNotNull(editor?.uiState?.value?.entry(ComposerTarget())?.pending)
        app.sendGate.countDown()
        awaitConversation {
            editor?.uiState?.value?.failed?.contains(ComposerTarget().key) == true &&
                chats.uiState.value.threads.any { it.id == pending.threadId }
        }
        val checkingDelivery = AtomicBoolean(false)
        val deliveryResponse = CountDownLatch(1)
        app.fixture.beforeInputStatusReturn = {
            checkingDelivery.set(true)
            deliveryResponse.await()
        }
        try {
            compose.onNodeWithContentDescription("Back").performClick()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("New conversation").fetchSemanticsNodes().size == 1
            }
            compose.onNodeWithTag("chat_${pending.threadId}").performClick()
            messageText(pending.eventId, prompt).assertIsDisplayed()
            awaitConversation { checkingDelivery.get() }
            compose.onNodeWithText("Check delivery").assertIsNotEnabled()
        } finally {
            deliveryResponse.countDown()
        }
        compose.waitUntil(10_000) {
            compose
                .onAllNodes(hasText("Check delivery") and isEnabled())
                .fetchSemanticsNodes()
                .size == 1
        }
        assertTrue(app.fixture.inputs.isEmpty())
    }

    @Test
    fun firstInputKeepsItsEditorWhenTheChatRowAndHistoryArriveBeforeTheReceipt() {
        val app = compose.activity.application as ComposerRootApplication
        app.contextGate.countDown()
        try {
            compose.onNodeWithText("New chat").performClick()
            captureOwners()
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
            awaitConversation { editor?.uiState?.value?.journal != null }
            val prompt = "Input with a delayed receipt"
            compose.onNodeWithTag("message_input").performTextInput(prompt)
            compose.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
            awaitConversation { app.fixture.inputs.size == 1 }
            val pending = checkNotNull(editor?.uiState?.value?.entry(ComposerTarget())?.pending)
            messageText(pending.eventId, "Sending…").assertIsDisplayed()
            compose.onNodeWithTag("message_input").performTextInput("Keep this newer draft")
            compose.runOnIdle { chats.refreshList() }
            awaitConversation {
                pending.eventId in chats.history.uiState.value.transcript?.persistedIds.orEmpty()
            }
            messageText(pending.eventId, prompt).assertIsDisplayed()
            messageText(pending.eventId, "Sending…").assertDoesNotExist()
            assertEquals(
                1,
                compose.onAllNodesWithTag("message_${pending.eventId}").fetchSemanticsNodes().size,
            )
            compose.onNodeWithContentDescription("Back").performClick()
            compose.onNodeWithText("New conversation").performClick()
            compose.onNodeWithTag("message_input").assertTextContains("Keep this newer draft")
            compose.onNodeWithText("Check delivery").assertIsNotEnabled()
            compose.onNodeWithContentDescription("Send").assertIsNotEnabled()
            app.sendGate.countDown()
            awaitConversation {
                compose.onAllNodesWithText("New conversation").fetchSemanticsNodes().isNotEmpty()
            }
            messageText(pending.eventId, prompt).assertIsDisplayed()
            compose.onNodeWithTag("message_input").assertTextContains("Keep this newer draft")
            compose.onNodeWithContentDescription("Send").assertIsEnabled()
            assertEquals(1, app.fixture.inputs.size)
        } finally {
            app.sendGate.countDown()
        }
    }

    @Test
    fun heldDefaultReadAndDisconnectedSendPreserveNavigationNewerEditingAndOriginalReceipt() {
        val app = compose.activity.application as ComposerRootApplication
        compose.onNodeWithText("New chat").performClick()
        compose
            .onNodeWithTag("message_input")
            .assertIsEnabled()
            .performTextInput("Original **message** 👋")
        compose.onNodeWithContentDescription("Send").assertIsEnabled()
        captureOwners()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithContentDescription("Chats").assertExists()
        compose.onNodeWithText("New chat").performClick()
        compose.onNodeWithTag("message_input").assertTextContains("Original **message** 👋")
        app.fixture.disconnectSend = true
        compose.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
        compose.waitUntil(10_000) {
            // Drain the actual native owner as journal/HTTP completions return to Main.
            compose.onNodeWithTag("message_input").fetchSemanticsNode()
            app.fixture.inputs.size == 1 ||
                editor?.uiState?.value?.failed?.isNotEmpty() == true ||
                editor?.uiState?.value?.persistence ==
                    ai.okou.android.chat.ComposerPersistence.Failed
        }
        assertEquals(
            "${editor?.uiState?.value}; requests=${app.fixture.requests.map { it.path }}",
            1,
            app.fixture.inputs.size,
        )
        app.contextGate.countDown()
        val event = app.fixture.inputs.keys.single()
        messageText(event, "Original **message** 👋").assertIsDisplayed()
        compose.onNodeWithTag("message_input").performTextInput("Newer draft 你好")
        app.sendGate.countDown()
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithText(
                    "The request failed. Your draft and pending message are retained."
                )
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        messageText(event, "Message delivery is unconfirmed.").assertIsDisplayed()
        compose.activityRule.scenario.recreate()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag("message_input").fetchSemanticsNodes().size == 1
        }
        compose.onNodeWithTag("message_input").assertTextContains("Newer draft 你好")
        messageText(event, "Original **message** 👋").assertIsDisplayed()
        compose.onNodeWithText("Check delivery").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("New conversation").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("message_input").assertTextContains("Newer draft 你好")
        compose.onNodeWithContentDescription("Send").assertIsEnabled()
        assertEquals(1, app.fixture.inputs.size)
        assertEquals(1, app.fixture.created.size)
        assertEquals(
            1,
            app.fixture.requests.count { it.requestUrl?.encodedPath == "/api/chat/events" },
        )
    }

    @After
    fun close() {
        val app = cleanupApplication ?: compose.activity.application as ComposerRootApplication
        app.contextGate.countDown()
        app.sendGate.countDown()
        val failures = mutableListOf<Throwable>()
        for (cleanup in
            listOf<() -> Unit>(
                { replacement?.close() },
                { compose.activityRule.scenario.close() },
                {
                    compose.waitUntil(10_000) {
                        // Finish cancellation callbacks on Robolectric's paused Main looper.
                        shadowOf(Looper.getMainLooper()).idle()
                        editorJob?.isCompleted != false && listJob?.isCompleted != false
                    }
                },
                { runBlocking { checkNotNull(app.journalStore).close() } },
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
}
