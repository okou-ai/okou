package ai.okou.android

import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.ComposerPersistence
import ai.okou.android.chat.plainText
import android.content.Intent
import android.os.Looper
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasText
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
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
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

    private fun captureOwners(activity: MainActivity = compose.activity) {
        compose.runOnIdle {
            val ready =
                checkNotNull(
                    ViewModelProvider(activity)[SessionModel::class.java].uiState.value.ready
                )
            editorJob = ready.composer.viewModelScope.coroutineContext[Job]
            editor = ready.composer
            listJob = ready.chats.viewModelScope.coroutineContext[Job]
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
        compose.onNodeWithText("Appearance").assertExists()
        captureOwners()
        // Recreation runs the same complete Activity budget check as every Debug save.
        compose.activityRule.scenario.recreate()
        compose.onNodeWithText("Appearance").assertExists()
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
    fun heldDefaultReadAndDisconnectedSendPreserveNavigationNewerEditingAndOriginalReceipt() {
        val app = compose.activity.application as ComposerRootApplication
        compose.onNodeWithText("New chat").performClick()
        compose.onNodeWithText("Loading chat availability…").assertExists()
        compose
            .onNodeWithTag("message_input")
            .assertIsEnabled()
            .performTextInput("Original **message** 👋")
        compose.onNodeWithContentDescription("Send").assertIsNotEnabled()
        captureOwners()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithContentDescription("Chats").assertExists()
        compose.onNodeWithText("New chat").performClick()
        compose.onNodeWithTag("message_input").assertTextContains("Original **message** 👋")
        app.contextGate.countDown()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Loading chat availability…").fetchSemanticsNodes().isEmpty()
        }
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
        compose.activityRule.scenario.recreate()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag("message_input").fetchSemanticsNodes().size == 1
        }
        compose.onNodeWithTag("message_input").assertTextContains("Newer draft 你好")
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
