package ai.okou.android

import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.auth.OpeningWorkspace
import ai.okou.android.auth.SessionModel
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.chat.ChatComposerModel
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.ComposerPersistence
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.chat.HistoryPhase
import ai.okou.android.chat.RunControlPhase
import ai.okou.android.chat.plainText
import android.content.Intent
import android.os.Looper
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.isOff
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.SocketPolicy
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

open class ComposerRootApplication : TestOkouApplication() {
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
        controlService = fixture.service
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

class DraftModelRootApplication : ComposerRootApplication() {
    internal lateinit var modelFixture: DefaultModelApiFixture

    override fun onCreate() {
        super.onCreate()
        modelFixture = DefaultModelApiFixture(fixture.chats)
        recoveryService = fixture.service
    }
}

internal abstract class ChatComposerRootTestFixture {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    protected var editorJob: Job? = null
        private set

    protected var listJob: Job? = null
        private set

    protected var editor: ChatComposerModel? = null
        private set

    protected var replacement: ActivityScenario<MainActivity>? = null
    protected var cleanupApplication: ComposerRootApplication? = null

    protected fun messageText(eventId: String, text: String) =
        compose.onNode(
            hasText(text) and hasAnyAncestor(hasTestTag("message_$eventId")),
            useUnmergedTree = true,
        )

    protected fun messageDelivery(eventId: String, status: String) =
        compose.onNode(
            SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, status) and
                hasAnyAncestor(hasTestTag("message_$eventId")),
            useUnmergedTree = true,
        )

    protected fun awaitConversation(condition: () -> Boolean) {
        compose.waitUntil(10_000) {
            // Drive composition and Main-looper HTTP completions before reading the fixture.
            compose.onAllNodesWithTag("conversation").fetchSemanticsNodes()
            condition()
        }
    }

    protected fun captureOwners(activity: MainActivity = compose.activity) {
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

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w400dp-h800dp",
    application = ComposerRootApplication::class,
)
internal class ChatComposerRootTest : ChatComposerRootTestFixture() {

    @Test
    @Config(application = DraftModelRootApplication::class)
    fun conversationModelUpdatesImmediatelyAndSendUsesServerSettings() {
        val app = compose.activity.application as DraftModelRootApplication
        app.modelFixture.gptFastMultiplier = 2.75
        cleanupApplication = app
        app.contextGate.countDown()
        app.sendGate.countDown()
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val requests = ConcurrentLinkedQueue<JsonObject>()
        val events = app.fixture.chats.rowEventTail()
        val delayedEvents = ConcurrentLinkedQueue<Pair<Long, String>>()
        val previous = app.fixture.chats.commandResponse
        app.fixture.chats.commandResponse = { request ->
            if (
                request.requestUrl?.encodedPath !=
                    "/api/chat-threads/$CHAT_PERSONAL/model-selection"
            )
                previous(request)
            else {
                val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                requests += body
                val attempt = requests.size
                if (attempt == 2 || attempt == 6) {
                    jsonResponse("""{"code":"BAD_REQUEST","message":"Unavailable"}""")
                        .setResponseCode(400)
                } else {
                    if (attempt == 1) {
                        started.countDown()
                        release.await()
                    }
                    val seq = 100L + attempt * 2
                    val model =
                        chatEventWire(
                            id = body.getValue("eventId").jsonPrimitive.content,
                            seq = seq,
                            kind = "model_selection_updated",
                        )
                    val modelFields = buildMap {
                        put("selectedModel", body.getValue("model"))
                        body["reasoningEffort"]?.let { effort ->
                            put(
                                "modelSettingsPatch",
                                JsonObject(
                                    mapOf("model" to body.getValue("model"), "effort" to effort),
                                ),
                            )
                        }
                    }
                    val resultEvents = if (attempt == 4) delayedEvents else events
                    resultEvents +=
                        seq to
                            JsonObject(Json.parseToJsonElement(model).jsonObject + modelFields)
                                .toString()
                    body["codexServiceTier"]?.let { tier ->
                        val tierEvent =
                            chatEventWire(
                                id = body.getValue("serviceTierEventId").jsonPrimitive.content,
                                seq = seq + 1,
                                kind = "service_tier_updated",
                            )
                        val serviceTier =
                            if (tier == JsonNull) JsonNull else JsonPrimitive("priority")
                        resultEvents +=
                            (seq + 1) to
                                JsonObject(
                                        Json.parseToJsonElement(tierEvent).jsonObject +
                                            ("serviceTier" to serviceTier),
                                    )
                                    .toString()
                    }
                    MockResponse().setResponseCode(204).apply {
                        if (attempt == 4) setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                    }
                }
            }
        }
        val modelRow = hasTestTag("chat-options-model") and isEnabled()
        fun openModel() {
            compose.onNodeWithTag("chat-options-button").performClick()
            compose.waitUntilExactlyOneExists(modelRow, 8_000)
            compose.onNode(modelRow).performClick()
        }
        fun closeModel() {
            compose
                .onNode(
                    hasContentDescription("Back") and hasAnyAncestor(hasTestTag("model-picker")),
                )
                .performClick()
            compose
                .onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss))
                .performSemanticsAction(SemanticsActions.Dismiss)
        }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.waitUntilExactlyOneExists(hasText("Personal chat"), 8_000)
            compose.onNodeWithText("Personal chat").performClick()
            compose.waitUntilExactlyOneExists(hasTestTag("message_input") and isEnabled(), 8_000)
            compose.onNodeWithTag("message_input").performTextInput("Preserve this draft")
            openModel()
            val auto = compose.onNodeWithText("Auto")
            val gpt = compose.onNodeWithText("GPT 5.6 Sol")
            val fast = compose.onNodeWithText("Fast mode")
            auto.assertIsSelected()
            fast.assertDoesNotExist()
            gpt.performClick().assertIsSelected()
            fast.assertIsOff()
            compose.onNodeWithText("2.75×", substring = true).assertExists()
            assertTrue(started.await(5, TimeUnit.SECONDS))
            fast.performClick().assertIsOn()
            compose.onNodeWithText("Medium").performClick()
            compose.onNodeWithText("High").performClick()
            compose.onNodeWithText("High").assertExists()
            assertEquals(1, requests.size)

            closeModel()
            val send = compose.onNodeWithContentDescription("Send")
            compose.onNodeWithTag("message_input").assertTextContains("Preserve this draft")
            send.assertIsEnabled().performClick()
            awaitConversation { app.fixture.inputs.isNotEmpty() }
            val input = app.fixture.inputs.values.single()
            assertEquals(CHAT_PERSONAL, input.getValue("threadId").jsonPrimitive.content)
            assertEquals("Preserve this draft", input.getValue("prompt").jsonPrimitive.content)
            assertTrue(input.keys.none { it in setOf("inputModel", "model", "runOptions") })
            assertEquals(1, requests.size)

            val saveFailure = hasText("Couldn’t save the model for this chat.")
            val conversationFeedback = hasTestTag("conversation_feedback")
            openModel()
            release.countDown()
            compose.waitUntilExactlyOneExists(
                saveFailure and hasAnyAncestor(hasTestTag("model-picker")),
                8_000,
            )
            compose.onAllNodes(saveFailure).assertCountEquals(1)
            compose.waitUntilExactlyOneExists(hasText("Fast mode") and isOff(), 8_000)
            gpt.assertIsSelected()
            compose.onNodeWithText("High").assertExists()
            fast.performClick().assertIsOn()
            awaitConversation { requests.size == 4 }
            val needsCheck = hasText("Couldn’t check the saved model.")
            compose.waitUntilExactlyOneExists(needsCheck, 8_000)
            fast.assertIsOn()
            events.addAll(delayedEvents)
            compose.onNodeWithText("Try again").performClick()
            compose.waitUntilDoesNotExist(needsCheck, 8_000)
            val saving = hasText("Saving…") or hasText("Checking the save result…")
            compose.waitUntilDoesNotExist(saving, 8_000)
            fast.assertIsOn()
            fast.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            fast.assertIsFocused()
            compose.runOnIdle {
                val defaultModel =
                    checkNotNull(
                            ViewModelProvider(compose.activity)[SessionModel::class.java]
                                .uiState
                                .value
                                .ready,
                        )
                        .settings
                        .defaultModel
                defaultModel.foreground(false)
                app.modelFixture.gptFastAvailable = false
                defaultModel.foreground(true)
            }
            compose.waitUntilDoesNotExist(hasText("Fast mode"), 8_000)
            gpt.assertIsFocused()
            compose.onNodeWithText("High").performClick()
            compose.onNodeWithText("Medium").performClick()
            compose.waitUntilExactlyOneExists(hasText("Medium") and isEnabled(), 8_000)
            awaitConversation { requests.size == 5 }
            compose.waitUntilDoesNotExist(saving, 8_000)
            val tierWrite = requests.elementAt(1)
            assertEquals(JsonNull, requests.first().getValue("codexServiceTier"))
            assertEquals("fast", tierWrite.getValue("codexServiceTier").jsonPrimitive.content)
            assertTrue("reasoningEffort" !in tierWrite)
            val effortWrite = requests.elementAt(2)
            assertEquals("high", effortWrite.getValue("reasoningEffort").jsonPrimitive.content)
            assertTrue("codexServiceTier" !in effortWrite)
            val unsupportedTierWrite = requests.elementAt(4)
            assertEquals(
                "medium",
                unsupportedTierWrite.getValue("reasoningEffort").jsonPrimitive.content,
            )
            assertEquals(JsonNull, unsupportedTierWrite.getValue("codexServiceTier"))
            assertTrue(app.fixture.created.isEmpty())
            assertTrue(app.modelFixture.writes.isEmpty())

            compose.waitUntilDoesNotExist(saveFailure, 8_000)
            compose.onNodeWithText("Medium").performClick()
            compose.onNodeWithText("High").performClick()
            compose.waitUntilExactlyOneExists(
                saveFailure and hasAnyAncestor(hasTestTag("model-picker")),
                8_000,
            )
            compose.onNodeWithText("Medium").assertIsDisplayed()
            // Drive each transition without consuming the notice's accessible timeout.
            compose.mainClock.autoAdvance = false
            try {
                compose
                    .onNode(
                        hasContentDescription("Back") and
                            hasAnyAncestor(hasTestTag("model-picker")),
                    )
                    .performClick()
                compose.mainClock.advanceTimeBy(500)
                compose
                    .onNode(
                        hasContentDescription("Drag handle") and
                            SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss),
                    )
                    .performSemanticsAction(SemanticsActions.Dismiss)
                compose.mainClock.advanceTimeBy(500)
                compose
                    .onNode(saveFailure and hasAnyAncestor(conversationFeedback))
                    .assertIsDisplayed()
                compose.onAllNodes(saveFailure).assertCountEquals(1)
            } finally {
                compose.mainClock.autoAdvance = true
            }
        } finally {
            release.countDown()
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    @Config(application = DraftModelRootApplication::class)
    fun newChatUsesItsDraftModelAndAdvancedOptionsOnFirstSend() {
        val app = compose.activity.application as DraftModelRootApplication
        app.modelFixture.gptFastMultiplier = 2.75
        cleanupApplication = app
        app.contextGate.countDown()
        app.sendGate.countDown()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            compose.onNodeWithText("New chat").performClick()
            val editor = compose.onNodeWithTag("message_input")
            editor.performTextInput("Use my draft model")
            editor.assertIsFocused()
            compose.onNodeWithTag("chat-options-button").performClick()
            val modelRow = compose.onNodeWithTag("chat-options-model")
            compose.waitUntil(8_000) {
                compose
                    .onAllNodes(
                        hasTestTag("chat-options-model") and hasText("GPT 5.6 Sol") and isEnabled(),
                    )
                    .fetchSemanticsNodes()
                    .isNotEmpty()
            }
            modelRow.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            modelRow.assertIsFocused().performClick()
            val gpt = compose.onNodeWithText("GPT 5.6 Sol")
            val claude = compose.onNodeWithText("Claude Sonnet 5")
            val fast = compose.onNodeWithText("Fast mode")
            gpt.assertIsSelected()
            compose.onNodeWithText("2.75×", substring = true).assertExists()
            fast.assertIsOff().performClick().assertIsOn()
            claude.performClick().assertIsSelected()
            compose.onNodeWithText("High").assertIsDisplayed()
            fast.assertDoesNotExist()
            gpt.performClick().assertIsSelected()
            fast.assertIsOff()
            compose.onNodeWithText("Medium").performClick()
            compose.onNodeWithText("High").performClick()
            fast.performClick().assertIsOn()
            compose
                .onNode(
                    hasContentDescription("Back") and hasAnyAncestor(hasTestTag("model-picker")),
                )
                .performSemanticsAction(SemanticsActions.OnClick)
            compose.waitUntil(5_000) {
                compose
                    .onAllNodes(hasTestTag("chat-options-model") and isFocused())
                    .fetchSemanticsNodes()
                    .isNotEmpty()
            }
            modelRow.assertTextContains("GPT 5.6 Sol").assertIsFocused()
            compose
                .onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss))
                .performSemanticsAction(SemanticsActions.Dismiss)
            editor.assertIsFocused().assertTextContains("Use my draft model")
        } finally {
            instrumentation.resetInTouchMode()
        }
        compose.onNodeWithContentDescription("Send").performClick()
        awaitConversation { app.fixture.inputs.isNotEmpty() }
        val request = app.fixture.created.single()
        assertEquals("gpt-test", request["model"]?.jsonPrimitive?.content)
        assertEquals("high", request["reasoningEffort"]?.jsonPrimitive?.content)
        assertEquals("priority", request["serviceTier"]?.jsonPrimitive?.content)
        assertTrue(app.modelFixture.writes.isEmpty())
    }

    @Test
    @Config(application = DraftModelRootApplication::class)
    fun switchingToAutoHidesModelEntryWhenNamedModelsAreUnavailable() {
        val app = compose.activity.application as DraftModelRootApplication
        cleanupApplication = app
        app.modelFixture.planRestricted = true
        compose.onNodeWithText("New chat").performClick()
        compose.onNodeWithTag("chat-options-button").performClick()
        val model = hasTestTag("chat-options-model") and isEnabled()
        compose.waitUntil(8_000) { compose.onAllNodes(model).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(model).assertTextContains("GPT 5.6 Sol").performClick()
        compose.onNodeWithText("GPT 5.6 Sol").assertIsNotEnabled().assertIsSelected()
        compose.onNodeWithText("Auto").performClick().assertIsSelected()
        compose
            .onNode(hasContentDescription("Back") and hasAnyAncestor(hasTestTag("model-picker")))
            .performClick()
        compose.onNodeWithTag("chat-options-model").assertDoesNotExist()
        compose.onNodeWithText("Chat options").assertIsDisplayed()
    }

    @Test
    @Config(application = DraftModelRootApplication::class)
    fun restoredModelPickerWaitsForCatalogAndFocusesItsDraftChoice() {
        val app = compose.activity.application as DraftModelRootApplication
        cleanupApplication = app
        app.contextGate.countDown()
        val catalogStarted = CountDownLatch(1)
        val releaseCatalog = CountDownLatch(1)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            val scenario = compose.activityRule.scenario
            scenario.recreate()
            compose.onNodeWithText("New chat").performClick()
            captureOwners()
            compose.onNodeWithTag("chat-options-button").performClick()
            val modelRow = hasTestTag("chat-options-model") and isEnabled()
            compose.waitUntilExactlyOneExists(modelRow, 8_000)
            compose.onNode(modelRow).performClick()
            val claude = hasText("Claude Sonnet 5")
            compose.onNode(claude).performClick().assertIsSelected()
            awaitConversation { editor?.uiState?.value?.persistence == ComposerPersistence.Durable }

            app.modelFixture.beforeCatalogReturn = {
                catalogStarted.countDown()
                releaseCatalog.await()
            }
            compose.runOnIdle { compose.activity.viewModelStore.clear() }
            scenario.recreate()
            compose.waitUntilExactlyOneExists(hasTestTag("model-picker"), 8_000)
            captureOwners()
            assertTrue(catalogStarted.await(5, TimeUnit.SECONDS))
            compose.onNodeWithText("Auto").assertDoesNotExist()

            releaseCatalog.countDown()
            compose.waitUntilExactlyOneExists(claude and isFocused(), 8_000)
            compose.onNode(claude).assertIsSelected().assertIsDisplayed()
        } finally {
            releaseCatalog.countDown()
            app.modelFixture.beforeCatalogReturn = null
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    @Config(application = DraftModelRootApplication::class)
    fun restoredDraftKeepsDisplayedEffortWithoutReopeningThePicker() {
        val app = compose.activity.application as DraftModelRootApplication
        cleanupApplication = app
        app.contextGate.countDown()
        app.sendGate.countDown()
        compose.onNodeWithText("New chat").performClick()
        captureOwners()
        val prompt = "Send the restored model draft"
        compose.onNodeWithTag("message_input").performTextInput(prompt)
        compose.onNodeWithTag("chat-options-button").performClick()
        val model = hasTestTag("chat-options-model") and isEnabled()
        compose.waitUntilExactlyOneExists(model, 8_000)
        compose.onNode(model).performClick()
        compose.onNodeWithText("Claude Sonnet 5").performClick()
        compose.onNodeWithText("GPT 5.6 Sol").performClick()
        compose.onNodeWithText("Medium").assertIsDisplayed()
        compose
            .onNode(hasContentDescription("Back") and hasAnyAncestor(hasTestTag("model-picker")))
            .performClick()
        compose
            .onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss))
            .performSemanticsAction(SemanticsActions.Dismiss)
        awaitConversation { editor?.uiState?.value?.persistence == ComposerPersistence.Durable }

        compose.activityRule.scenario.close()
        compose.waitUntil(10_000) {
            shadowOf(Looper.getMainLooper()).idle()
            editorJob?.isCompleted == true && listJob?.isCompleted == true
        }
        runBlocking { checkNotNull(app.journalStore).close() }
        app.journalStore = ComposerJournalStore(app, app.journalDirectory)
        val fresh = ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java))
        replacement = fresh
        compose.onNodeWithText("New chat").performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("message_input") and hasText(prompt), 10_000)
        var activity: MainActivity? = null
        fresh.onActivity { activity = it }
        captureOwners(checkNotNull(activity))
        compose.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
        awaitConversation { app.fixture.inputs.isNotEmpty() }
        val request = app.fixture.created.single()
        assertEquals("gpt-test", request["model"]?.jsonPrimitive?.content)
        assertEquals("medium", request["reasoningEffort"]?.jsonPrimitive?.content)
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
        val chats = compose.runOnIdle {
            checkNotNull(
                    ViewModelProvider(checkNotNull(activity))[SessionModel::class.java]
                        .uiState
                        .value
                        .ready,
                )
                .chats
        }
        compose.onNodeWithContentDescription("Back").performClick()
        // Returning to the list restores the reads used by history warming.
        compose.waitUntil(10_000) {
            compose.runOnIdle { chats.warming.state.value.phase == ChatReadPhase.Ready }
        }
        assertEquals(0, app.fixture.chats.readRequests.get())
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
        val editor = input.fetchSemanticsNode().config
        assertEquals(draft, editor[SemanticsProperties.InputText].text)
        assertEquals(
            "First line Second line Third line Final line",
            editor[SemanticsProperties.EditableText].text,
        )
        compose.onNodeWithContentDescription("Send").assertIsDisplayed().assertIsEnabled()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h520dp")
    fun earlierRepliesExpandBelowTheSummaryWithoutMovingIt() {
        val app = compose.activity.application as ComposerRootApplication
        val earlier = "The website copy is checked."
        val lastParagraph = "Record the final decisions in the release notes."
        val latest =
            "The release materials are ready.\n\n" +
                "The website and email are confirmed. Two checks remain before launch.\n\n" +
                "Please share the updated checklist with all channel owners.\n\n" +
                lastParagraph
        fun id(seq: Long) = "50624000-0000-4000-8000-${seq.toString().padStart(12, '0')}"
        fun reply(seq: Long, text: String) =
            historyEventWire(id(seq), seq, payload = """{"content":${JsonPrimitive(text)}}""")
        val rows =
            listOf(
                reply(1, "$earlier\n\nUse the approved release links."),
                reply(2, "The email draft is checked."),
                reply(3, latest),
                historyEventWire(id(4), 4, type = "run.completed", payload = "null"),
            )
        app.fixture.chats.historyCatchUp = { MockResponse().setResponseCode(503) }
        app.fixture.chats.historyRows = { request ->
            val since = request.requestUrl?.queryParameter("sinceSeqId")?.toInt() ?: 0
            jsonResponse(
                """{"rows":[${rows.drop(since).joinToString(",")}],"cursor":{"lastEventId":"${id(4)}","lastSeqId":4},"hasMore":false}""",
            )
        }
        app.contextGate.countDown()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Personal chat").fetchSemanticsNodes().size == 1
        }
        compose.onNodeWithText("Personal chat").performClick()
        captureOwners()
        val summary = compose.onNodeWithTag("conversation_reply_summary")
        compose.waitUntilExactlyOneExists(hasTestTag("conversation_reply_summary"), 5_000)
        compose.waitUntil("latest conversation is displayed", 5_000) {
            app.fixture.chats.readRequests.get() > 0
        }
        // Wait for the independently laid out paragraph after Markdown rendering.
        compose.waitUntilExactlyOneExists(hasText(lastParagraph), 5_000)
        val resting = summary.assertIsDisplayed().getUnclippedBoundsInRoot()
        summary.performClick()
        compose.waitUntilExactlyOneExists(hasText(earlier), 5_000)
        val expanded = summary.assertIsDisplayed().getUnclippedBoundsInRoot()
        assertEquals(resting.top, expanded.top)
        val firstReply = compose.onNodeWithText(earlier).assertIsDisplayed()
        assertTrue(firstReply.getUnclippedBoundsInRoot().top >= expanded.bottom)
        summary.performClick()
        compose.waitUntilDoesNotExist(hasText(earlier), 5_000)
        assertEquals(resting.top, summary.getUnclippedBoundsInRoot().top)
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
        // Recreation runs the same complete Activity budget check as every Debug save.
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
    fun firstInputIsVisibleThroughHeldCreateSendListAndHistory() {
        val app = compose.activity.application as ComposerRootApplication
        val create = CountDownLatch(1)
        val list = CountDownLatch(1)
        val history = CountDownLatch(1)
        val listStarted = CountDownLatch(1)
        val historyStarted = CountDownLatch(1)
        app.fixture.beforeCreateReturn = { create.await() }
        // Hold both ways a confirmed queue entry can replace the accepted bubble.
        app.fixture.beforeInputStatusReturn = { history.await() }
        app.fixture.chats.historyCatchUp = {
            jsonResponse("""{"events":{},"notFoundThreads":[]}""")
        }
        // A list read can see the new chat while its create response is still held.
        app.fixture.beforeListReturn = { containsCreatedChat ->
            if (containsCreatedChat) {
                listStarted.countDown()
                list.await()
            }
        }
        app.fixture.beforeHistoryReturn = { id ->
            val created = app.fixture.created.singleOrNull()
            if (created?.getValue("clientThreadId")?.jsonPrimitive?.content == id) {
                historyStarted.countDown()
                history.await()
            }
        }
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
            messageDelivery(pending.eventId, "Sending…").assertIsDisplayed()
            messageText(pending.eventId, "Sending…").assertDoesNotExist()
            compose.onNodeWithText("Check delivery").assertDoesNotExist()
            assertEquals(0, app.fixture.inputs.size)
            compose.onNodeWithContentDescription("Back").performClick()
            compose.onNodeWithTag("chat_${pending.threadId}").assertIsDisplayed().performClick()
            messageText(pending.eventId, prompt).assertIsDisplayed()
            create.countDown()
            awaitConversation { app.fixture.inputs.size == 1 }
            messageDelivery(pending.eventId, "Sending…").assertIsDisplayed()
            val sendingBody = messageText(pending.eventId, prompt).getUnclippedBoundsInRoot()
            app.sendGate.countDown()
            awaitConversation {
                listStarted.count == 0L &&
                    editor
                        ?.uiState
                        ?.value
                        ?.entry(ComposerTarget(pending.threadId))
                        ?.receipt
                        ?.eventId == pending.eventId
            }
            messageText(pending.eventId, prompt).assertIsDisplayed()
            messageDelivery(pending.eventId, "Sending…").assertDoesNotExist()
            compose.onNodeWithText("Check delivery").assertDoesNotExist()
            val acceptedBody = messageText(pending.eventId, prompt).getUnclippedBoundsInRoot()
            assertEquals(sendingBody.left, acceptedBody.left)
            assertEquals(sendingBody.right, acceptedBody.right)
            assertEquals(
                sendingBody.bottom - sendingBody.top,
                acceptedBody.bottom - acceptedBody.top,
            )
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
            val withdrawalLabel = app.getString(R.string.conversation_revoke)
            compose.waitUntilExactlyOneExists(hasTestTag("open_conversation_queue"), 10_000)
            compose.onNodeWithTag("open_conversation_queue").performClick()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("New conversation").fetchSemanticsNodes().isNotEmpty() &&
                    compose
                        .onAllNodesWithTag("message_${pending.eventId}")
                        .fetchSemanticsNodes()
                        .size == 1 &&
                    compose
                        .onAllNodesWithContentDescription(withdrawalLabel, substring = true)
                        .fetchSemanticsNodes()
                        .size == 1
            }
            messageText(pending.eventId, prompt).assertIsDisplayed()
            compose
                .onNodeWithContentDescription(withdrawalLabel, substring = true)
                .assertIsDisplayed()
            assertEquals(1, app.fixture.inputs.size)
        } finally {
            create.countDown()
            list.countDown()
            history.countDown()
        }
    }

    @Test
    fun pendingFirstSendStaysVisibleAcrossActivityRecreation() {
        val app = compose.activity.application as ComposerRootApplication
        val create = CountDownLatch(1)
        app.fixture.beforeCreateReturn = { create.await() }
        app.contextGate.countDown()
        try {
            compose.onNodeWithText("New chat").performClick()
            captureOwners()
            awaitConversation { editor?.uiState?.value?.journal != null }
            val prompt = "Keep the first send through recreation"
            compose.onNodeWithTag("message_input").performTextInput(prompt)
            compose.onNodeWithContentDescription("Send").performClick()
            awaitConversation { app.fixture.created.size == 1 }
            val pending = checkNotNull(editor?.uiState?.value?.entry(ComposerTarget())?.pending)
            compose.activityRule.scenario.recreate()
            awaitConversation {
                compose.onAllNodesWithText(prompt).fetchSemanticsNodes().size == 1
            }
            messageDelivery(pending.eventId, "Sending…").assertIsDisplayed()
            compose.onNodeWithText("Check delivery").assertDoesNotExist()
            app.sendGate.countDown()
            create.countDown()
            awaitConversation { app.fixture.inputs.containsKey(pending.eventId) }
            awaitConversation {
                editor?.uiState?.value?.entry(ComposerTarget(pending.threadId))?.receipt?.eventId ==
                    pending.eventId
            }
            assertEquals(setOf(pending.eventId), app.fixture.inputs.keys)
            assertEquals(1, app.fixture.created.size)
        } finally {
            create.countDown()
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
            // The provisional conversation can start a list read before its first send completes.
            app.fixture.beforeListReturn = { containsCreatedChat ->
                if (containsCreatedChat) oldList.await()
            }
            compose.onNodeWithTag("message_input").performTextInput("An accepted first send")
            compose.onNodeWithContentDescription("Send").performClick()
            awaitConversation { app.fixture.inputs.size == 1 }
            val pending = checkNotNull(editor?.uiState?.value?.entry(ComposerTarget())?.pending)
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
                            """{"error":{"code":"NOT_FOUND","message":"Chat thread not found"}}""",
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
                    """{"url":"${list.server.url("/archive")}","expiresInSeconds":60,"latestEventId":"$HISTORY_LAST_EVENT","latestSeqId":40}""",
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
    fun rejectedFirstSendShowsTheOriginalBubbleWithoutARetryControl() {
        val app = compose.activity.application as ComposerRootApplication
        app.contextGate.countDown()
        app.fixture.rejectSend = true
        compose.onNodeWithText("New chat").performClick()
        captureOwners()
        awaitConversation { editor?.uiState?.value?.journal != null }
        val prompt = "Keep my rejected first input"
        compose.onNodeWithTag("message_input").performTextInput(prompt)
        compose.onNodeWithContentDescription("Send").performClick()
        awaitConversation { app.fixture.created.size == 1 }
        val pending = checkNotNull(editor?.uiState?.value?.entry(ComposerTarget())?.pending)
        app.sendGate.countDown()
        awaitConversation {
            compose.onAllNodesWithText("Not sent").fetchSemanticsNodes().size == 1
        }
        messageText(pending.eventId, prompt).assertIsDisplayed()
        messageDelivery(pending.eventId, "Sending…").assertDoesNotExist()
        compose.onNodeWithText("Check delivery").assertDoesNotExist()
        assertTrue(app.fixture.inputs.isEmpty())
    }

    @Test
    fun rejectedChatCreationKeepsTheInputRecoverable() {
        val app = compose.activity.application as ComposerRootApplication
        app.contextGate.countDown()
        app.fixture.rejectCreate = true
        compose.onNodeWithText("New chat").performClick()
        val input = compose.onNodeWithTag("message_input")
        val prompt = "Keep this unsent message"
        input.performTextInput(prompt)
        compose.onNodeWithContentDescription("Send").performClick()
        val restore = hasText("Restore retained draft") and isEnabled()
        compose.waitUntilExactlyOneExists(restore, 8_000)
        compose
            .onNodeWithText("The request failed. Your draft and pending message are retained.")
            .assertDoesNotExist()
        compose.onNode(restore).performClick()
        input.assertTextContains(prompt)
        assertTrue(app.fixture.created.isEmpty())
        assertTrue(app.fixture.inputs.isEmpty())
    }

    @Test
    fun firstInputKeepsItsEditorWhenTheChatRowAndHistoryArriveBeforeTheReceipt() {
        val app = compose.activity.application as ComposerRootApplication
        app.contextGate.countDown()
        try {
            compose.onNodeWithText("New chat").performClick()
            captureOwners()
            val chats = compose.runOnIdle {
                checkNotNull(
                        ViewModelProvider(compose.activity)[SessionModel::class.java]
                            .uiState
                            .value
                            .ready,
                    )
                    .chats
            }
            awaitConversation { editor?.uiState?.value?.journal != null }
            val prompt = "Input with a delayed receipt"
            compose.onNodeWithTag("message_input").performTextInput(prompt)
            compose.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
            awaitConversation { app.fixture.inputs.size == 1 }
            val pending = checkNotNull(editor?.uiState?.value?.entry(ComposerTarget())?.pending)
            messageDelivery(pending.eventId, "Sending…").assertIsDisplayed()
            compose.onNodeWithTag("message_input").performTextInput("Keep this newer draft")
            compose.runOnIdle { chats.refreshList() }
            awaitConversation {
                pending.eventId in chats.history.uiState.value.transcript?.persistedIds.orEmpty()
            }
            val queue = hasTestTag("open_conversation_queue")
            compose.waitUntilExactlyOneExists(queue, 10_000)
            messageText(pending.eventId, prompt).assertDoesNotExist()
            messageDelivery(pending.eventId, "Sending…").assertDoesNotExist()
            compose.onNodeWithContentDescription("Back").performClick()
            compose.onNodeWithText("New conversation").performClick()
            compose.onNodeWithTag("message_input").assertTextContains("Keep this newer draft")
            compose.onNodeWithText("Check delivery").assertDoesNotExist()
            app.sendGate.countDown()
            awaitConversation {
                editor?.uiState?.value?.entry(ComposerTarget(pending.threadId))?.receipt?.eventId ==
                    pending.eventId
            }
            compose.onNode(queue).performClick()
            val row = hasTestTag("message_${pending.eventId}")
            compose.waitUntilExactlyOneExists(row, 10_000)
            messageText(pending.eventId, prompt).assertIsDisplayed()
            val panel = hasTestTag("conversation_queue")
            compose
                .onNode(
                    hasContentDescription("Back") and hasAnyAncestor(hasAnyDescendant(panel)),
                )
                .performClick()
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
        val checkStarted = CountDownLatch(1)
        val checkResponse = CountDownLatch(1)
        app.fixture.beforeInputStatusReturn = {
            checkStarted.countDown()
            checkResponse.await()
        }
        // Keep confirmed history from settling the input before the status check returns.
        app.fixture.beforeHistoryReturn = { threadId ->
            if (
                app.fixture.created.any { it["clientThreadId"]?.jsonPrimitive?.content == threadId }
            ) {
                checkResponse.await()
            }
        }
        val event: String
        try {
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
            event = app.fixture.inputs.keys.single()
            messageText(event, "Original **message** 👋").assertIsDisplayed()
            compose.onNodeWithTag("message_input").performTextInput("Newer draft 你好")
            app.sendGate.countDown()
            awaitConversation { checkStarted.count == 0L }
            messageDelivery(event, "Sending…").assertIsDisplayed()
            compose.onNodeWithText("Check delivery").assertDoesNotExist()
            messageText(event, "Original **message** 👋").assertIsDisplayed()
        } finally {
            checkResponse.countDown()
        }
        val thread = app.fixture.created.single().getValue("clientThreadId").jsonPrimitive.content
        awaitConversation {
            editor?.uiState?.value?.entry(ComposerTarget(thread))?.receipt?.eventId == event &&
                compose.onAllNodesWithText("New conversation").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("message_input").assertTextContains("Newer draft 你好")
        compose.onNodeWithContentDescription("Send").assertIsEnabled()
        compose.onNodeWithText("Check delivery").assertDoesNotExist()
        assertEquals(1, app.fixture.inputs.size)
        assertEquals(1, app.fixture.created.size)
        assertEquals(
            1,
            app.fixture.requests.count { it.requestUrl?.encodedPath == "/api/chat/events" },
        )
    }

    @Test
    fun statusConfirmedFirstInputCanBeWithdrawnWhileTheChatListIsHeld() {
        val app = compose.activity.application as ComposerRootApplication
        val listStarted = CountDownLatch(1)
        val releaseList = CountDownLatch(1)
        app.fixture.beforeListReturn = { containsCreatedChat ->
            if (containsCreatedChat) {
                listStarted.countDown()
                releaseList.await()
            }
        }
        app.fixture.disconnectSend = true
        val withdrawal = AtomicReference<JsonObject>()
        val composerResponse = app.fixture.chats.commandResponse
        app.fixture.chats.commandResponse = { request ->
            val body =
                if (
                    request.method == "POST" &&
                        request.requestUrl?.encodedPath == "/api/chat/events"
                )
                    Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                else null
            if (body != null && "revokesEventId" in body) {
                withdrawal.set(body)
                MockResponse()
                    .setResponseCode(201)
                    .setHeader("Content-Type", "application/json")
                    .setBody(
                        """{"threadId":${body.getValue("threadId")},"createdAt":"$CHAT_DATE"}""",
                    )
            } else composerResponse(request)
        }
        app.contextGate.countDown()
        try {
            compose.onNodeWithText("New chat").performClick()
            captureOwners()
            awaitConversation { editor?.uiState?.value?.journal != null }
            compose.onNodeWithTag("message_input").performTextInput("Withdraw my first input")
            compose.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
            awaitConversation { app.fixture.inputs.size == 1 }
            val (eventId, input) = app.fixture.inputs.entries.single()
            app.sendGate.countDown()
            awaitConversation {
                listStarted.count == 0L &&
                    compose
                        .onAllNodesWithTag("open_conversation_queue")
                        .fetchSemanticsNodes()
                        .size == 1
            }
            compose.onNodeWithTag("open_conversation_queue").performClick()
            compose
                .onNode(
                    hasContentDescription(
                        app.getString(R.string.conversation_revoke),
                        substring = true,
                    ) and hasAnyAncestor(hasTestTag("message_$eventId")),
                )
                .assertIsDisplayed()
                .assertIsEnabled()
                .assertWidthIsEqualTo(48.dp)
                .assertHeightIsEqualTo(48.dp)
                .performClick()
            awaitConversation { withdrawal.get() != null }
            val request = checkNotNull(withdrawal.get())
            assertEquals(input.getValue("threadId"), request.getValue("threadId"))
            assertEquals(eventId, request.getValue("revokesEventId").jsonPrimitive.content)
            assertEquals(1, app.fixture.inputs.size)
            compose.onNodeWithTag("message_$eventId").assertDoesNotExist()
            compose
                .onNodeWithText(app.getString(R.string.conversation_queue_empty))
                .assertIsDisplayed()
        } finally {
            releaseList.countDown()
        }
    }

    @Test
    fun pendingWithdrawalRemovesOnlyItsCardAndTransfersFocusBeforeHistoryReturns() {
        val app = compose.activity.application as ComposerRootApplication
        val api = app.fixture.chats
        val manualId = UUID.randomUUID().toString()
        val automationId = UUID.randomUUID().toString()
        val holdHistory = AtomicBoolean(false)
        val historyRequested = CountDownLatch(1)
        val releaseHistory = CountDownLatch(1)
        val withdrawals = ConcurrentLinkedQueue<JsonObject>()
        val manualText = "Withdraw this message"
        val workflowName = "Keep this automation"
        val queuedRows =
            listOf(
                historyEventWire(
                    manualId,
                    1,
                    type = "input.prompt",
                    payload =
                        """{"userMessage":{"version":1,"parts":[{"type":"text","text":"$manualText"}]}}""",
                    run = null,
                ),
                historyEventWire(
                    automationId,
                    2,
                    type = "input.automation",
                    payload =
                        """{"userMessage":{"version":1,"parts":[{"type":"automation","workflowName":"$workflowName"}]}}""",
                    run = null,
                ),
            )
        val otherRows = api.historyRows
        api.historyRows = { request ->
            val url = checkNotNull(request.requestUrl)
            if (url.pathSegments[2] != CHAT_PERSONAL) otherRows(request)
            else {
                val withdrawalId =
                    withdrawals.peek()?.getValue("clientEventId")?.jsonPrimitive?.content
                val terminalRow = withdrawalId?.let { id ->
                    historyEventWire(
                        id,
                        3,
                        type = "control.revoke",
                        payload = "null",
                        run = null,
                        revoke = manualId,
                    )
                }
                val events = queuedRows + listOfNotNull(terminalRow)
                if (holdHistory.compareAndSet(true, false)) {
                    historyRequested.countDown()
                    releaseHistory.await()
                }
                val since = url.queryParameter("sinceSeqId")?.toInt() ?: 0
                val rows = events.drop(since).joinToString(",")
                val lastId = withdrawalId ?: automationId
                jsonResponse(
                    """{"rows":[$rows],"cursor":{"lastEventId":"$lastId","lastSeqId":${events.size}},"hasMore":false}""",
                )
            }
        }
        val composerResponse = api.commandResponse
        api.commandResponse = { request ->
            val body =
                if (
                    request.method == "POST" &&
                        request.requestUrl?.encodedPath == "/api/chat/events"
                )
                    Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                else null
            if (body != null && "revokesEventId" in body) {
                withdrawals += body
                MockResponse().setResponseCode(503)
            } else composerResponse(request)
        }

        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        app.contextGate.countDown()
        try {
            compose.activityRule.scenario.recreate()
            compose.waitUntilExactlyOneExists(hasText("Personal chat"), 10_000)
            compose.onNodeWithText("Personal chat").performClick()
            captureOwners()
            val ready = compose.runOnIdle {
                checkNotNull(
                    ViewModelProvider(compose.activity)[SessionModel::class.java]
                        .uiState
                        .value
                        .ready,
                )
            }
            val withdraw =
                compose.onNodeWithContentDescription(
                    app.getString(R.string.conversation_revoke),
                    substring = true,
                )
            awaitConversation {
                ready.chats.history.uiState.value.phase == HistoryPhase.Ready
            }
            compose.onNodeWithTag("open_conversation_queue").performClick()
            withdraw
                .assertIsEnabled()
                .performSemanticsAction(SemanticsActions.RequestFocus)
                .assertIsFocused()
            holdHistory.set(true)
            compose.runOnIdle { ready.chats.history.refresh() }
            awaitConversation { historyRequested.count == 0L }
            withdraw.performClick()
            compose.onNodeWithTag("message_$manualId").assertDoesNotExist()
            messageText(automationId, workflowName).assertIsDisplayed()
            compose.onNodeWithTag("message_$automationId").assertIsFocused()
            awaitConversation {
                ready.controls.uiState.value.pending.isEmpty()
            }
            assertEquals(
                manualId,
                withdrawals.single().getValue("revokesEventId").jsonPrimitive.content,
            )
            assertTrue(
                manualId in ready.chats.history.uiState.value.transcript?.pendingInputIds.orEmpty(),
            )
            messageText(manualId, manualText).assertDoesNotExist()
            messageText(automationId, workflowName).assertIsDisplayed()
            compose.onNodeWithTag("message_$automationId").assertIsFocused()
            releaseHistory.countDown()
            awaitConversation {
                ready.chats.history.uiState.value.transcript?.pendingInputIds == setOf(automationId)
            }
            messageText(manualId, manualText).assertDoesNotExist()
        } finally {
            releaseHistory.countDown()
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    fun recoveredWithdrawalTakesPriorityAndMovesWithTheQueueSheet() {
        val app = compose.activity.application as ComposerRootApplication
        val api = app.fixture.chats
        val queuedId = UUID.randomUUID().toString()
        val prompt = "Restore this queued message"
        val queued =
            historyEventWire(
                queuedId,
                1,
                type = "input.prompt",
                payload =
                    """{"userMessage":{"version":1,"parts":[{"type":"text","text":"$prompt"}]}}""",
                run = null,
            )
        val readsUnavailable = AtomicBoolean(false)
        val withdrawals = AtomicInteger()
        val listEvents = api.rowEventTail()
        val otherRows = api.historyRows
        api.historyRows = { request ->
            val url = checkNotNull(request.requestUrl)
            if (url.pathSegments[2] != CHAT_PERSONAL) otherRows(request)
            else if (readsUnavailable.get()) MockResponse().setResponseCode(400)
            else {
                val since = url.queryParameter("sinceSeqId")?.toInt() ?: 0
                val rows = if (since < 1) queued else ""
                jsonResponse(
                    """{"rows":[$rows],"cursor":{"lastEventId":"$queuedId","lastSeqId":1},"hasMore":false}""",
                )
            }
        }
        val otherCommands = api.commandResponse
        api.commandResponse = { request ->
            val body =
                if (
                    request.method == "POST" &&
                        request.requestUrl?.encodedPath == "/api/chat/events"
                )
                    Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                else null
            when {
                body != null && "revokesEventId" in body -> {
                    withdrawals.incrementAndGet()
                    readsUnavailable.set(true)
                    jsonResponse("{}").setResponseCode(201)
                }
                request.requestUrl?.encodedPath == "/api/chat-threads/$CHAT_PERSONAL/archive" -> {
                    listEvents.add(24L to request.rowEvent(24, CHAT_PERSONAL, "archived"))
                    MockResponse().setResponseCode(204)
                }
                request.requestUrl?.encodedPath in
                    setOf(
                        "/api/chat-threads/$CHAT_PERSONAL/mark-read",
                        "/api/chat-threads/$CHAT_PERSONAL/mark-unread",
                    ) -> MockResponse().setResponseCode(400)
                else -> otherCommands(request)
            }
        }

        app.contextGate.countDown()
        compose.waitUntilExactlyOneExists(hasText("Personal chat"), 10_000)
        compose.onNodeWithText("Personal chat").performClick()
        val ready = compose.runOnIdle {
            checkNotNull(
                ViewModelProvider(compose.activity)[SessionModel::class.java].uiState.value.ready,
            )
        }
        val history = ready.chats.history
        awaitConversation {
            history.uiState.value.phase == HistoryPhase.Ready
        }
        val transcript = compose.onNodeWithTag("conversation").assertIsDisplayed()
        val readingBounds = transcript.getUnclippedBoundsInRoot()
        val actions = compose.onNodeWithContentDescription("Chat actions")
        actions.performClick()
        compose.onNodeWithText("Archive chat").performClick()
        val undo = hasText("Undo")
        compose.waitUntilExactlyOneExists(undo, 10_000)
        compose.onNodeWithTag("open_conversation_queue").performClick()
        val withdraw =
            hasContentDescription(
                app.getString(R.string.conversation_revoke),
                substring = true,
            ) and hasAnyAncestor(hasTestTag("message_$queuedId"))
        compose.onNode(withdraw).assertIsEnabled().performClick()
        awaitConversation {
            history.uiState.value.phase == HistoryPhase.Failed &&
                ready.controls.uiState.value.phases.values.singleOrNull() == RunControlPhase.Unknown
        }
        compose.onNodeWithTag("message_$queuedId").assertDoesNotExist()

        readsUnavailable.set(false)
        compose.runOnIdle { history.invalidate(CHAT_PERSONAL) }
        awaitConversation { history.uiState.value.phase == HistoryPhase.Ready }
        val failure = hasText(app.getString(R.string.conversation_withdraw_failed))
        compose.waitUntilExactlyOneExists(failure, 10_000)
        compose
            .onNode(
                failure and hasAnyAncestor(hasTestTag("queue_control_feedback")),
            )
            .assertIsDisplayed()
        messageText(queuedId, prompt).assertIsDisplayed()
        compose.onNode(withdraw).assertIsEnabled()
        assertEquals(1, withdrawals.get())

        compose.mainClock.advanceTimeBy(2_500)
        compose
            .onNode(
                hasContentDescription("Back") and
                    hasAnyAncestor(hasAnyDescendant(hasTestTag("conversation_queue"))),
            )
            .performClick()
        val conversationHost = hasAnyAncestor(hasTestTag("conversation_feedback"))
        compose.onNode(failure and conversationHost).assertIsDisplayed()
        assertEquals(readingBounds, transcript.getUnclippedBoundsInRoot())
        compose.onNode(undo).assertDoesNotExist()

        actions.performClick()
        compose.onNode(hasText("Mark as read") or hasText("Mark as unread")).performClick()
        awaitConversation { ready.chats.uiState.value.rowActionFailures.any { it.rejected } }
        val secondError = hasText("Could not update the read status.") and conversationHost
        compose.onNode(failure).assertIsDisplayed()
        compose.onNode(secondError).assertDoesNotExist()

        compose.mainClock.advanceTimeBy(2_500)
        compose.onNode(failure).assertDoesNotExist()
        compose.onNode(secondError).assertIsDisplayed()
        compose.onNode(undo).assertDoesNotExist()
        compose.mainClock.advanceTimeBy(5_000)
        compose.onNode(secondError).assertDoesNotExist()
        compose.onNode(undo and conversationHost).assertIsDisplayed()
        assertEquals(readingBounds, transcript.getUnclippedBoundsInRoot())
    }

    @Test
    fun deliveredInputStatusKeepsTheBubbleWhenOlderQueuedHistoryArrives() {
        val app = compose.activity.application as ComposerRootApplication
        app.contextGate.countDown()
        app.fixture.disconnectSend = true
        app.fixture.inputDisposition = "consumed"
        val releaseList = CountDownLatch(1)
        app.fixture.beforeListReturn = { if (it) releaseList.await() }
        try {
            compose.onNodeWithText("New chat").performClick()
            captureOwners()
            awaitConversation { editor?.uiState?.value?.journal != null }
            val prompt = "Already delivered to the run"
            compose.onNodeWithTag("message_input").performTextInput(prompt)
            compose.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
            awaitConversation { app.fixture.inputs.size == 1 }
            val (eventId, input) = app.fixture.inputs.entries.single()
            val threadId = input.getValue("threadId").jsonPrimitive.content
            app.sendGate.countDown()
            awaitConversation {
                editor?.uiState?.value?.entry(ComposerTarget(threadId))?.receipt?.disposition ==
                    ai.okou.android.chat.TextDisposition.Consumed
            }
            messageText(eventId, prompt).assertIsDisplayed()
            messageDelivery(eventId, "Sending…").assertDoesNotExist()
            releaseList.countDown()
            val history = compose.runOnIdle {
                checkNotNull(
                        ViewModelProvider(compose.activity)[SessionModel::class.java]
                            .uiState
                            .value
                            .ready,
                    )
                    .chats
                    .history
            }
            awaitConversation {
                eventId in history.uiState.value.transcript?.pendingInputIds.orEmpty()
            }
            messageText(eventId, prompt).assertIsDisplayed()
            compose.onNodeWithTag("conversation_queue").assertDoesNotExist()
            assertEquals(1, app.fixture.inputs.size)
        } finally {
            releaseList.countDown()
        }
    }
}
