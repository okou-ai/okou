package ai.okou.android

import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ComposerJournalStore
import android.os.Bundle
import android.os.Parcel
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.TextRange
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

class ComposerRootApplication : TestOkouApplication() {
    lateinit var fixture: ComposerApiFixture
    lateinit var cacheSnapshot: ChatCacheSnapshot
    val contextGate = CountDownLatch(1)
    val sendGate = CountDownLatch(1)

    override fun onCreate() {
        fixture = ComposerApiFixture()
        fixture.beforeContextReturn = { contextGate.await() }
        fixture.beforeSendReturn = { sendGate.await() }
        chatService = fixture.service
        composerService = fixture.service
        journalStore =
            ComposerJournalStore(
                this,
                noBackupFilesDir.resolve("composer-root-${UUID.randomUUID()}"),
            )
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

    private fun captureOwners() {
        compose.runOnIdle {
            val ready =
                checkNotNull(
                    ViewModelProvider(compose.activity)[SessionModel::class.java]
                        .uiState
                        .value
                        .ready
                )
            editorJob = ready.composer.viewModelScope.coroutineContext[Job]
            editor = ready.composer
            listJob = ready.chats.viewModelScope.coroutineContext[Job]
        }
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
        captureOwners()
        compose.runOnIdle {
            val saved = Bundle()
            InstrumentationRegistry.getInstrumentation()
                .callActivityOnSaveInstanceState(compose.activity, saved)
            val parcel = Parcel.obtain()
            try {
                parcel.writeBundle(saved)
                assertTrue(
                    "Chat drafts must not fill the Activity/Binder bundle",
                    parcel.dataSize() < 64 * 1024,
                )
            } finally {
                parcel.recycle()
            }
        }
        compose.activityRule.scenario.recreate()
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
        compose.onNodeWithText("Send").assertIsNotEnabled()
        captureOwners()
        compose.onNodeWithText("Back").performClick()
        compose.onNodeWithText("Chats").assertExists()
        compose.onNodeWithText("New chat").performClick()
        compose.onNodeWithTag("message_input").assertTextContains("Original **message** 👋")
        app.contextGate.countDown()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Loading chat availability…").fetchSemanticsNodes().isEmpty()
        }
        app.fixture.disconnectSend = true
        compose.onNodeWithText("Send").assertIsEnabled().performClick()
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
        compose.onNodeWithText("Send").assertIsEnabled()
        assertEquals(1, app.fixture.inputs.size)
        assertEquals(1, app.fixture.created.size)
        assertEquals(
            1,
            app.fixture.requests.count { it.requestUrl?.encodedPath == "/api/chat/events" },
        )
    }

    @After
    fun close() {
        val app = compose.activity.application as ComposerRootApplication
        app.contextGate.countDown()
        app.sendGate.countDown()
        compose.activityRule.scenario.close()
        compose.waitUntil(10_000) {
            editorJob?.isCompleted != false && listJob?.isCompleted != false
        }
        try {
            runBlocking { checkNotNull(app.journalStore).close() }
            app.fixture.close()
        } finally {
            app.cacheSnapshot.restore()
        }
    }
}
