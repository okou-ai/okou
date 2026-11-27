package ai.okou.android.chat

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatListApiFixture
import ai.okou.android.OkouTheme
import ai.okou.android.R
import ai.okou.android.RecoveryApiFixture
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.HistorySnapshot
import ai.okou.android.api.generated.ReadState
import ai.okou.android.api.generated.ThreadDetail
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import android.content.ClipboardManager
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.assertTouchHeightIsEqualTo
import androidx.compose.ui.test.assertTouchWidthIsEqualTo
import androidx.compose.ui.test.click
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = TestOkouApplication::class)
class ConversationRouteTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    @get:Rule val temporary = TemporaryFolder()
    private val owners = ViewModelStore()
    private val fixture = ChatListApiFixture()
    private var cache: ChatCacheStore? = null
    private var ownerJob: Job? = null

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun historicalFailureShowsReasonAndGuidanceWithoutRecoveryNetworkReads() {
        fun history(wire: String): HistoryMessage {
            val row = HistoryEvent.decode(wire)
            return projectHistory(
                    HistoryCheckpoint(CHAT_PERSONAL, listOf(row), HistoryCursor(row.id, row.seqId)),
                )
                .messages
                .single()
        }
        fun failure(reason: String) = history(RecoveryApiFixture.failure(reason))
        val legacy =
            history(
                historyEventWire(
                    "legacy",
                    1,
                    type = "output.error",
                    payload = """{"error":"Legacy error"}""",
                ),
            )
        val displayed = mutableStateOf(listOf(legacy))
        fun show(vararg messages: HistoryMessage) {
            compose.runOnIdle { displayed.value = messages.toList() }
        }
        compose.setContent {
            OkouTheme {
                Column {
                    for (entry in conversationTurns(displayed.value, emptySet()).messages) {
                        key(entry.key) { ConversationMessageRow(entry) }
                    }
                }
            }
        }
        val header = compose.onNodeWithTag("conversation_reply_header")
        val avatar = compose.onNodeWithTag("conversation_reply_avatar")
        val card = compose.onNodeWithTag("conversation_failure_card")
        val legacyTop = card.getUnclippedBoundsInRoot().top
        compose.onNodeWithText("Legacy error").assertExists()

        show(legacy, failure("provider_request_timeout"))
        compose.onNodeWithText("Legacy error").assertDoesNotExist()
        assertEquals(legacyTop, card.getUnclippedBoundsInRoot().top)
        val headerBounds = header.getUnclippedBoundsInRoot()
        val avatarBounds = avatar.getUnclippedBoundsInRoot()
        assertEquals(48.dp, headerBounds.bottom - headerBounds.top)
        assertEquals(32.dp, avatarBounds.right - avatarBounds.left)
        assertEquals(
            8.dp,
            card.getUnclippedBoundsInRoot().top - header.getUnclippedBoundsInRoot().bottom,
        )
        compose.onNodeWithText("The model response timed out").assertExists()
        compose
            .onNodeWithText("Try again in a moment, or choose another model to keep working.")
            .assertExists()

        show(failure("future_reason"))
        compose.onNodeWithText("This run couldn't finish").assertExists()
        compose.onNodeWithText("Open the chat on the Okou website for details.").assertExists()

        show(failure("provider_image_too_large"))
        compose.onNodeWithText("Image is too large").assertExists()
        compose.onNodeWithText("Remove the image or replace it with a smaller one.").assertExists()

        show(failure("guest_memory_oom_killed"))
        compose.onNodeWithText("This run ran out of memory").assertExists()
        compose.onNodeWithText("The content generated so far is still available.").assertExists()

        show(failure("safety_policy_refusal"))
        compose.onNodeWithText("Revise your request before sending it again.").assertExists()

        show(failure("firewall_auth_failed"))
        compose.onNodeWithText("This run couldn't finish").assertExists()

        show(history(historyEventWire(type = "run.cancelled", payload = "null")))
        header.assertExists()
        compose.onNodeWithText("Stopped").assertExists()
        card.assertDoesNotExist()
        val stopped = compose.onNodeWithTag("conversation_stopped").getUnclippedBoundsInRoot()
        assertEquals(8.dp, stopped.top - header.getUnclippedBoundsInRoot().bottom)
        assertEquals(24.dp, stopped.bottom - stopped.top)
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun canonicalHistoryShowsAuthoredJsonAndReferenceTitlesWithoutInternalPayloads() {
        val authored = """{"color":"blue"}"""
        val referenceTitle = "Launch decision"
        val file = "checklist.pdf"
        val mcpPrompt = "Please check the release date."
        val clientName = "Fixture MCP client"
        val reply = """{"status":"ready"}"""
        val followups = """[{"prompt":"Review the checklist"}]"""
        val rows =
            listOf(
                    historyEventWire(
                        scrollEventId(17),
                        17,
                        type = "input.prompt",
                        payload =
                            """
                            {"userMessage":{"version":1,"parts":[
                                {"type":"text","text":${JsonPrimitive(authored)}},
                                {"type":"model","selectedModel":"fixture-internal-model"},
                                {"type":"additional_info","text":"internal context only"},
                                {"type":"source","kind":"slack"},
                                {"type":"chat_thread","threadId":"$CHAT_IN_PROJECT","titleSnapshot":${JsonPrimitive(referenceTitle)}},
                                {"type":"file","fileId":"internal-file-id","filenameSnapshot":${JsonPrimitive(file)},"contentType":"application/pdf"},
                                {"type":"future","opaqueKey":8}
                            ]}}
                            """
                                .trimIndent(),
                    ),
                    historyEventWire(
                        scrollEventId(19),
                        19,
                        type = "input.prompt",
                        payload =
                            """
                            {"userMessage":{"version":1,"parts":[
                                {"type":"text","text":${JsonPrimitive(mcpPrompt)}},
                                {"type":"source","kind":"mcp","clientId":"fixture-client-id","clientName":${JsonPrimitive(clientName)}}
                            ]}}
                            """
                                .trimIndent(),
                    ),
                    historyEventWire(
                        scrollEventId(23),
                        23,
                        payload = """{"content":${JsonPrimitive(reply)}}""",
                    ),
                    historyEventWire(
                        scrollEventId(29),
                        29,
                        type = "output.followups",
                        payload = """{"content":${JsonPrimitive(followups)}}""",
                    ),
                    historyEventWire(
                        scrollEventId(31),
                        31,
                        type = "usage.recorded",
                        payload = """{"usage":{"inputTokens":9}}""",
                    ),
                    historyEventWire(
                        scrollEventId(37),
                        37,
                        type = "run.completed",
                        payload = "null",
                    ),
                )
                .map { Json.parseToJsonElement(it).jsonObject }
        fixture.historyRows = { request ->
            val after = request.requestUrl?.queryParameter("sinceSeqId")?.toLong() ?: 0L
            val tail = JsonArray(rows.filter { it.getValue("seqId").jsonPrimitive.long > after })
            jsonResponse(
                """{"rows":$tail,"cursor":{"lastEventId":"${scrollEventId(37)}","lastSeqId":37},"hasMore":false}""",
            )
        }
        val model = createListModel()
        compose.setContent {
            val list by model.uiState.collectAsStateWithLifecycle()
            OkouTheme { ConversationRoute(model.history, CHAT_PERSONAL, list) }
        }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.uiState.value.listPhase == ChatReadPhase.Ready }
        }
        compose.runOnIdle {
            model.history.open(model.uiState.value.threads.single { it.id == CHAT_PERSONAL })
        }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.history.uiState.value.phase != HistoryPhase.Loading }
        }
        val history = model.history.uiState.value
        assertEquals(HistoryPhase.Ready, history.phase)
        assertTrue(scrollEventId(31) in history.transcript?.persistedIds.orEmpty())
        compose.onNodeWithText(reply).assertIsDisplayed()
        compose.onNodeWithText(authored).assertIsDisplayed()
        compose.onNodeWithText(referenceTitle).assertIsDisplayed()
        compose.onNodeWithText(file).assertIsDisplayed()
        compose.onNodeWithText(mcpPrompt).assertIsDisplayed()
        compose
            .onNodeWithText(compose.activity.getString(R.string.history_unsupported))
            .assertIsDisplayed()
        compose
            .onNode(
                hasText(clientName) or
                    hasText(compose.activity.getString(R.string.history_reference)),
            )
            .assertDoesNotExist()
        for (internal in
            listOf(
                "fixture-internal-model",
                "internal context only",
                "internal-file-id",
                "opaqueKey",
                "inputTokens",
                "Review the checklist",
            )) {
            compose.onNodeWithText(internal, substring = true).assertDoesNotExist()
        }
        compose.onNodeWithTag("message_${scrollEventId(31)}").assertDoesNotExist()
        compose.onNodeWithTag("message_${scrollEventId(29)}").assertDoesNotExist()
    }

    @Test
    fun longPressCopiesTheReplyShownAfterAStreamUpdate() {
        fun reply(text: String, id: String = "output") =
            HistoryMessage(
                id,
                null,
                HistoryRole.Assistant,
                listOf(HistoryBlock(HistoryBlockKind.Text, text)),
            )
        val displayed = mutableStateOf(reply("First chunk"))
        compose.setContent {
            OkouTheme {
                ConversationMessageRow(ConversationMessage(displayed.value))
            }
        }
        val header = compose.onNodeWithText(compose.activity.getString(R.string.app_name))
        val row = compose.onNodeWithTag("conversation_reply_header").getUnclippedBoundsInRoot()
        val avatar = compose.onNodeWithTag("conversation_reply_avatar").getUnclippedBoundsInRoot()
        compose
            .onNode(
                hasContentDescription(
                    compose.activity.getString(R.string.conversation_reply_actions),
                ) and hasClickAction(),
            )
            .assertTouchWidthIsEqualTo(48.dp)
            .assertTouchHeightIsEqualTo(48.dp)
        assertEquals(48.dp, row.bottom - row.top)
        assertEquals(32.dp, avatar.right - avatar.left)
        assertEquals(32.dp, avatar.bottom - avatar.top)
        assertEquals(8.dp, header.getUnclippedBoundsInRoot().left - avatar.right)
        // Start the same pointer handler before this reply receives more content.
        header.performTouchInput { click() }
        val complete = "First chunk and the [release notes](https://example.org/releases)."
        val rendered = "First chunk and the release notes (https://example.org/releases)."
        compose.runOnIdle { displayed.value = reply(complete) }
        compose.waitUntilExactlyOneExists(hasText(rendered), 5_000)
        compose.onNodeWithText(rendered).assertIsDisplayed()
        assertEquals(
            avatar,
            compose.onNodeWithTag("conversation_reply_avatar").getUnclippedBoundsInRoot(),
        )
        header.performTouchInput { longClick() }
        val copy =
            compose.onNodeWithText(compose.activity.getString(R.string.conversation_copy_reply))
        copy.assertIsDisplayed()
        // A following reply can receive whitespace before its usable body arrives.
        compose.runOnIdle { displayed.value = reply(" ", id = "next-output") }
        copy.assertIsDisplayed().performClick()
        val clipboard =
            checkNotNull(compose.activity.getSystemService(ClipboardManager::class.java))
        compose.waitUntil(5_000) { clipboard.primaryClip != null }
        assertEquals(rendered, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
    }

    @After
    fun close() {
        try {
            compose.runOnIdle { owners.clear() }
            compose.waitUntil(10_000) { compose.runOnIdle { ownerJob?.isCompleted != false } }
        } finally {
            try {
                runBlocking { cache?.close() }
            } finally {
                fixture.close()
            }
        }
    }

    @Test
    fun visibleVisitsTrackSelectionLifecycleAndReadRecovery() {
        val visible = mutableStateOf(true)
        val model = createListModel()
        compose.setContent {
            val list by model.uiState.collectAsStateWithLifecycle()
            OkouTheme {
                ConversationRoute(model.history, CHAT_IN_PROJECT, list, visible = visible.value)
            }
        }
        compose.mainClock.advanceTimeBy(300)
        compose.waitUntilExactlyOneExists(
            hasContentDescription(compose.activity.getString(R.string.history_loading)),
            5_000,
        )
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.uiState.value.listPhase == ChatReadPhase.Ready }
        }
        compose.runOnIdle {
            model.history.open(model.uiState.value.threads.single { it.id == CHAT_IN_PROJECT })
        }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.history.uiState.value.phase == HistoryPhase.Ready }
        }
        compose.waitUntil(10_000) { compose.runOnIdle { fixture.readRequests.get() > 0 } }
        compose.onNodeWithText("Native history", substring = true).assertIsDisplayed()
        assertEquals(1, fixture.readRequests.get())
        compose.runOnIdle {
            val threads = model.uiState.value.threads
            model.history.open(threads.single { it.id == CHAT_PERSONAL })
            model.history.open(threads.single { it.id == CHAT_IN_PROJECT })
        }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.history.uiState.value.phase == HistoryPhase.Ready }
        }
        compose.onNodeWithText("Native history", substring = true).assertExists()
        compose.waitUntil(10_000) { compose.runOnIdle { fixture.readRequests.get() >= 2 } }
        assertEquals(2, fixture.readRequests.get())
        compose.runOnIdle { visible.value = false }
        compose.waitForIdle()
        compose.runOnIdle { model.history.refresh() }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.history.uiState.value.phase == HistoryPhase.Ready }
        }
        compose.waitForIdle()
        assertEquals(2, fixture.readRequests.get())
        compose.runOnIdle { visible.value = true }
        compose.waitUntil(10_000) { compose.runOnIdle { fixture.readRequests.get() >= 3 } }
        assertEquals(3, fixture.readRequests.get())
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        compose.waitUntil(10_000) { compose.runOnIdle { fixture.readRequests.get() >= 4 } }
        assertEquals(4, fixture.readRequests.get())
        compose.onNodeWithTag("conversation").performScrollToIndex(0)
        compose.runOnIdle { visible.value = false }
        compose.waitForIdle()
        val successfulRead = fixture.historyMarkRead
        fixture.historyMarkRead = { MockResponse().setResponseCode(503) }
        compose.runOnIdle { visible.value = true }
        compose.waitUntil(10_000) {
            compose.runOnIdle {
                model.history.readSessionFor(CHAT_IN_PROJECT)?.readState?.value ==
                    HistoryReadState.Failed
            }
        }
        compose.onNodeWithText(compose.activity.getString(R.string.retry)).assertDoesNotExist()
        compose.onNodeWithText("Native history", substring = true).assertExists()
        assertEquals(5, fixture.readRequests.get())
        fixture.historyMarkRead = successfulRead
        compose.runOnIdle { model.history.invalidate() }
        compose.waitUntil(10_000) { compose.runOnIdle { fixture.readRequests.get() >= 6 } }
        assertEquals(6, fixture.readRequests.get())
    }

    @Test
    @Config(qualifiers = "en-rUS-w360dp-h400dp")
    fun jumpRevealsAndAcknowledgesTheLatestReplyWhenSuggestionsFillTheViewport() {
        fixture.indicators = {
            jsonResponse(
                """{"threads":{"$CHAT_PERSONAL":"unread"},"unreadAt":{"$CHAT_PERSONAL":"$CHAT_DATE"}}""",
            )
        }
        val followups =
            """{"version":1,"followups":[{"kind":"talk","prompt":"Summarize the release notes"},{"kind":"email","prompt":"Draft the announcement"},{"kind":"workflow","prompt":"Set up a release checklist"}]}"""
        serveConversationRows(
            listOf(
                historyEventWire(
                    scrollEventId(1),
                    1,
                    payload = """{"content":"The release is ready."}""",
                ),
                historyEventWire(scrollEventId(2), 2, type = "run.completed", payload = "null"),
                historyEventWire(
                    scrollEventId(3),
                    3,
                    type = "output.followups",
                    payload = """{"content":${JsonPrimitive(followups)}}""",
                ),
            ),
        )
        val model = createListModel()
        compose.setContent {
            val list by model.uiState.collectAsStateWithLifecycle()
            OkouTheme {
                ConversationRoute(
                    model.history,
                    CHAT_PERSONAL,
                    list,
                    modifier = Modifier.height(160.dp),
                    onFollowup = {},
                )
            }
        }
        openPersonalHistory(model)
        compose.onNodeWithText("Set up a release checklist").assertIsDisplayed()
        compose.onNodeWithText("The release is ready.").assertIsNotDisplayed()
        assertEquals(0, fixture.readRequests.get())

        val jump =
            hasTestTag("conversation_jump") and
                hasContentDescription(compose.activity.getString(R.string.conversation_new_reply))
        compose.waitUntilExactlyOneExists(jump, 5_000)
        compose.onNode(jump).performClick()
        compose.onNodeWithText("The release is ready.").assertIsDisplayed()
        compose.onNode(jump).assertDoesNotExist()
        compose.waitUntil("reading the latest reply is acknowledged", 5_000) {
            fixture.readRequests.get() > 0
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun returningFromAnArtifactRestoresItsFocusAfterANewReply() {
        val artifact = "/artifacts/aaaaaaaaaa.md"
        val replies =
            listOf(
                historyEventWire(
                    scrollEventId(1),
                    1,
                    payload = """{"content":"[Release checklist]($artifact)"}""",
                ),
                historyEventWire(
                    scrollEventId(2),
                    2,
                    payload = """{"content":"The rollout is now scheduled."}""",
                ),
            )
        val available = AtomicInteger(1)
        serveConversationRows(replies, available::get)
        val model = createListModel()
        var opened: Pair<String, String>? = null
        val restoreKey = mutableStateOf<String?>(null)
        compose.setContent {
            val list by model.uiState.collectAsStateWithLifecycle()
            OkouTheme {
                ConversationRoute(
                    model.history,
                    CHAT_PERSONAL,
                    list,
                    artifactActions =
                        ChatArtifactActions(
                            open = { link, key -> opened = link to key },
                            restoreKey = restoreKey.value,
                            restored = { restoreKey.value = null },
                        ),
                )
            }
        }
        openPersonalHistory(model)
        val card = hasText("Release checklist") and hasClickAction()
        compose.waitUntilExactlyOneExists(card, 5_000)
        compose.onNode(card).performClick()
        val source = compose.runOnIdle { checkNotNull(opened) }
        assertEquals(artifact, source.first)

        compose.runOnIdle {
            available.set(2)
            model.history.refresh()
        }
        compose.waitUntilExactlyOneExists(hasText("The rollout is now scheduled."), 5_000)
        compose.waitUntilExactlyOneExists(card, 5_000)
        compose.runOnIdle { restoreKey.value = source.second }
        compose.onNode(card).assertIsFocused()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h320dp")
    fun staleConversationShowsFixedProgressWithoutMovingMessages() {
        var now = System.currentTimeMillis()
        val model = createListModel(wallMillis = { now })
        val showQueue = mutableStateOf(false)
        val controls = compose.runOnIdle {
            ViewModelProvider(
                owners,
                viewModelFactory {
                    initializer {
                        RunControlsModel(
                            fixture.service,
                            RunControlOwners(),
                            fixture.identity,
                            model.history,
                            { true },
                            {},
                        )
                    }
                },
            )[RunControlsModel::class.java]
        }
        compose.setContent {
            val list by model.uiState.collectAsStateWithLifecycle()
            val state by model.history.uiState.collectAsStateWithLifecycle()
            val output by model.history.output.state.collectAsStateWithLifecycle()
            val queuedControls =
                if (showQueue.value) {
                    val presentation =
                        conversationContent(
                            state.transcript,
                            output,
                            CHAT_IN_PROJECT,
                            emptyList(),
                            emptySet(),
                        )
                    val queued =
                        HistoryMessage(
                            scrollEventId(40),
                            null,
                            HistoryRole.User,
                            listOf(HistoryBlock(HistoryBlockKind.Text, "Check the rollout")),
                            queued = true,
                        )
                    ConversationRunControls(
                        controls,
                        CHAT_IN_PROJECT,
                        RunControlsState(),
                        state,
                        null,
                        emptyList(),
                        presentation.copy(queue = listOf(ConversationMessage(queued))),
                    )
                } else null
            OkouTheme {
                ConversationRoute(model.history, CHAT_IN_PROJECT, list, controls = queuedControls)
            }
        }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.uiState.value.listPhase == ChatReadPhase.Ready }
        }
        compose.runOnIdle {
            model.history.open(model.uiState.value.threads.single { it.id == CHAT_IN_PROJECT })
        }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.history.uiState.value.phase == HistoryPhase.Ready }
        }
        val conversation = compose.onNodeWithTag("conversation")
        val reply = compose.onNodeWithTag("message_output").assertIsDisplayed()
        val syncLabel = compose.activity.getString(R.string.history_syncing)
        val refreshRequested = CountDownLatch(1)
        val allowRefreshResponse = CountDownLatch(1)
        val historyRows = fixture.historyRows
        fixture.historyRows = { request ->
            refreshRequested.countDown()
            allowRefreshResponse.await()
            historyRows(request)
        }
        val bounds = reply.getUnclippedBoundsInRoot()
        val progress = hasContentDescription(syncLabel)
        try {
            compose.mainClock.autoAdvance = false
            compose.runOnIdle {
                now += 599_001
                model.history.refresh()
            }
            compose.waitUntil(5_000) { refreshRequested.count == 0L }
            compose.mainClock.advanceTimeBy(100)
            compose.onNode(progress).assertDoesNotExist()
            compose.mainClock.advanceTimeBy(1_000)
            compose.onNode(progress).assertIsDisplayed()
            val bar = compose.onNodeWithTag("history_sync_progress").getUnclippedBoundsInRoot()
            val viewport = conversation.getUnclippedBoundsInRoot()
            assertEquals(viewport.top, bar.top)
            assertEquals(viewport.left, bar.left)
            assertEquals(viewport.right, bar.right)
            assertEquals(4.dp, bar.bottom - bar.top)
            assertEquals(bounds, reply.getUnclippedBoundsInRoot())
            compose.runOnIdle { showQueue.value = true }
            compose.mainClock.advanceTimeByFrame()
            compose.onNode(progress).assertIsDisplayed()
        } finally {
            compose.mainClock.autoAdvance = true
            allowRefreshResponse.countDown()
        }
        compose.waitUntilDoesNotExist(progress, 5_000)
    }

    @Test
    fun staleHistoryShowsProgressWhenThereAreNoVisibleMessages() {
        val eventId = scrollEventId(1)
        val usage =
            historyEventWire(
                id = eventId,
                seq = 1,
                thread = CHAT_IN_PROJECT,
                type = "usage.recorded",
                payload = "null",
            )
        fixture.historyRows = { request ->
            val rows = if (request.requestUrl?.queryParameter("sinceSeqId") == "1") "" else usage
            jsonResponse(
                """{"rows":[$rows],"cursor":{"lastEventId":"$eventId","lastSeqId":1},"hasMore":false}""",
            )
        }
        var now = System.currentTimeMillis()
        val model = createListModel(wallMillis = { now })
        compose.setContent {
            val list by model.uiState.collectAsStateWithLifecycle()
            OkouTheme { ConversationRoute(model.history, CHAT_IN_PROJECT, list) }
        }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.uiState.value.listPhase == ChatReadPhase.Ready }
        }
        compose.runOnIdle {
            model.history.open(model.uiState.value.threads.single { it.id == CHAT_IN_PROJECT })
        }
        val emptyHistory = compose.activity.getString(R.string.history_empty)
        compose.waitUntilExactlyOneExists(hasText(emptyHistory), 10_000)
        val refreshRequested = CountDownLatch(1)
        val allowRefreshResponse = CountDownLatch(1)
        val historyRows = fixture.historyRows
        fixture.historyRows = { request ->
            refreshRequested.countDown()
            allowRefreshResponse.await()
            historyRows(request)
        }
        val progress = hasContentDescription(compose.activity.getString(R.string.history_syncing))
        try {
            compose.runOnIdle {
                now += 600_001
                model.history.refresh()
            }
            compose.waitUntil(5_000) { refreshRequested.count == 0L }
            compose.onNode(progress).assertIsDisplayed()
            compose.onNodeWithText(emptyHistory).assertIsDisplayed()
        } finally {
            allowRefreshResponse.countDown()
        }
        compose.waitUntilDoesNotExist(progress, 5_000)
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h320dp")
    fun staleSyncLetsTheRunningStatusProvideFeedbackWithoutMovingIt() {
        var now = System.currentTimeMillis()
        val model = openScrollHistory(AtomicInteger(12), wallMillis = { now })
        val status =
            compose.onNodeWithText(compose.activity.getString(R.string.conversation_processing))
        status.assertIsDisplayed()
        val statusBounds = status.getUnclippedBoundsInRoot()
        val syncLabel = compose.activity.getString(R.string.history_syncing)
        val refreshRequested = CountDownLatch(1)
        val allowRefreshResponse = CountDownLatch(1)
        val historyRows = fixture.historyRows
        fixture.historyRows = { request ->
            refreshRequested.countDown()
            allowRefreshResponse.await()
            historyRows(request)
        }
        try {
            compose.runOnIdle {
                now += 600_001
                model.history.refresh()
            }
            compose.waitUntil(5_000) { refreshRequested.count == 0L }
            assertEquals(0L, model.history.uiState.value.syncProgressDelayMillis)
            compose.onNode(hasContentDescription(syncLabel)).assertDoesNotExist()
            assertEquals(statusBounds, status.assertIsDisplayed().getUnclippedBoundsInRoot())
        } finally {
            allowRefreshResponse.countDown()
        }
        compose.waitUntil("the stale refresh is confirmed", 5_000) {
            compose.runOnIdle { model.history.uiState.value.phase == HistoryPhase.Ready }
        }
        assertEquals(statusBounds, status.assertIsDisplayed().getUnclippedBoundsInRoot())
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h320dp")
    fun staleSyncLetsTheQueuedTaskStatusProvideFeedback() {
        val eventId = scrollEventId(40)
        val prompt = "Please check the launch notes"
        val queuedInput =
            historyEventWire(
                id = eventId,
                seq = 40,
                thread = CHAT_IN_PROJECT,
                type = "input.prompt",
                payload =
                    """{"userMessage":{"version":1,"parts":[{"type":"text","text":${JsonPrimitive(prompt)}}]}}""",
                run = null,
            )
        fixture.historyRows = { request ->
            val after = request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0
            val rows = if (after < 40) queuedInput else ""
            jsonResponse(
                """{"rows":[$rows],"cursor":{"lastEventId":"$eventId","lastSeqId":40},"hasMore":false}""",
            )
        }
        var now = System.currentTimeMillis()
        val model = createListModel(wallMillis = { now })
        compose.setContent {
            val list by model.uiState.collectAsStateWithLifecycle()
            OkouTheme { ConversationRoute(model.history, CHAT_IN_PROJECT, list) }
        }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.uiState.value.listPhase == ChatReadPhase.Ready }
        }
        compose.runOnIdle {
            model.history.open(model.uiState.value.threads.single { it.id == CHAT_IN_PROJECT })
        }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.history.uiState.value.phase != HistoryPhase.Loading }
        }
        assertEquals(HistoryPhase.Ready, model.history.uiState.value.phase)
        val queuedLabel = compose.activity.getString(R.string.conversation_run_queued)
        val status = compose.onNodeWithText(queuedLabel).assertIsDisplayed()
        val statusBounds = status.getUnclippedBoundsInRoot()
        val refreshRequested = CountDownLatch(1)
        val allowRefreshResponse = CountDownLatch(1)
        fixture.beforeHistoryResponse = { request ->
            if (request.requestUrl?.pathSegments?.lastOrNull() == "event-rows") {
                refreshRequested.countDown()
                allowRefreshResponse.await()
            }
        }
        try {
            compose.runOnIdle {
                now += 600_001
                model.history.refresh()
            }
            compose.waitUntil(5_000) { refreshRequested.count == 0L }
            assertEquals(0L, model.history.uiState.value.syncProgressDelayMillis)
            compose
                .onNode(hasContentDescription(compose.activity.getString(R.string.history_syncing)))
                .assertDoesNotExist()
            assertEquals(statusBounds, status.assertIsDisplayed().getUnclippedBoundsInRoot())
        } finally {
            allowRefreshResponse.countDown()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h320dp")
    fun mixedQueueScrollsInServerOrderWithoutMovingTheTranscript() {
        val events =
            listOf(
                historyEventWire(
                    scrollEventId(39),
                    39,
                    CHAT_IN_PROJECT,
                    "output.message",
                    """{"content":"Keep reading this reply"}""",
                ),
                historyEventWire(
                    scrollEventId(40),
                    40,
                    CHAT_IN_PROJECT,
                    "input.prompt",
                    """{"userMessage":{"version":1,"parts":[{"type":"text","text":"First waiting message"}]}}""",
                    run = null,
                ),
                historyEventWire(
                    scrollEventId(41),
                    41,
                    CHAT_IN_PROJECT,
                    "input.automation",
                    """{"userMessage":{"version":1,"parts":[{"type":"automation","workflowName":"Morning brief","automationBrief":"Every day at 9:00 AM"}]}}""",
                    run = null,
                ),
            ) +
                (42..45).map { seq ->
                    historyEventWire(
                        scrollEventId(seq),
                        seq.toLong(),
                        CHAT_IN_PROJECT,
                        "input.prompt",
                        """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Waiting message $seq"}]}}""",
                        run = null,
                    )
                }
        fixture.historyRows = { request ->
            val after = request.requestUrl?.queryParameter("sinceSeqId")?.toInt() ?: 0
            val rows = events.drop((after - 38).coerceIn(0, events.size)).joinToString(",")
            jsonResponse(
                """{"rows":[$rows],"cursor":{"lastEventId":"${scrollEventId(45)}","lastSeqId":45},"hasMore":false}""",
            )
        }
        val model = createListModel()
        val queueOpen = mutableStateOf(false)
        compose.setContent {
            val list by model.uiState.collectAsStateWithLifecycle()
            OkouTheme {
                ConversationRoute(
                    model.history,
                    CHAT_IN_PROJECT,
                    list,
                    queueOpen = queueOpen.value,
                    dismissQueue = { queueOpen.value = false },
                )
            }
        }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.uiState.value.listPhase == ChatReadPhase.Ready }
        }
        compose.runOnIdle {
            model.history.open(model.uiState.value.threads.single { it.id == CHAT_IN_PROJECT })
        }
        compose.waitUntilExactlyOneExists(hasText("Keep reading this reply"), 10_000)
        val reply = compose.onNodeWithText("Keep reading this reply").assertIsDisplayed()
        val beforeScroll = reply.getUnclippedBoundsInRoot()
        compose.runOnIdle { queueOpen.value = true }
        compose.waitUntilExactlyOneExists(hasText("First waiting message"), 10_000)
        val queue = compose.onNodeWithTag("conversation_queue").assertIsDisplayed()
        queue.performScrollToIndex(1)
        compose.onNodeWithText("Morning brief").assertIsDisplayed()
        compose
            .onNodeWithText(compose.activity.getString(R.string.conversation_queue_automation))
            .assertIsDisplayed()
        compose
            .onNode(hasContentDescription("Skip this automation, Morning brief"))
            .assertIsDisplayed()
        queue.performScrollToIndex(4)
        compose.onNodeWithText("Waiting message 44").assertIsDisplayed()
        compose.runOnIdle { queueOpen.value = false }
        assertEquals(beforeScroll, reply.assertIsDisplayed().getUnclippedBoundsInRoot())
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h800dp")
    fun conversationKeepsOneSkeletonAcrossTheFirstReadAndVisitRetry() {
        val visible = mutableStateOf(false)
        val model = createListModel()
        val historyRows = fixture.historyRows
        fixture.historyRows = { MockResponse().setResponseCode(503) }
        fixture.historyCatchUp = { MockResponse().setResponseCode(503) }
        compose.setContent {
            val list by model.uiState.collectAsStateWithLifecycle()
            OkouTheme {
                ConversationRoute(model.history, CHAT_IN_PROJECT, list, visible = visible.value)
            }
        }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.uiState.value.listPhase == ChatReadPhase.Ready }
        }
        compose.runOnIdle {
            model.history.open(model.uiState.value.threads.single { it.id == CHAT_IN_PROJECT })
        }
        val retryLabel = compose.activity.getString(R.string.retry)
        val skeleton = hasContentDescription(compose.activity.getString(R.string.history_loading))
        compose.waitUntil(5_000) {
            compose.runOnIdle { model.history.uiState.value.phase == HistoryPhase.Failed }
        }
        compose.waitUntilExactlyOneExists(skeleton, 5_000)
        compose.onNode(skeleton).assertIsDisplayed()
        val bounds = compose.onNode(skeleton).getUnclippedBoundsInRoot()
        compose.onNodeWithText(retryLabel).assertDoesNotExist()
        compose.runOnIdle { visible.value = true }
        compose.waitUntil(5_000) {
            compose.runOnIdle { model.history.uiState.value.consecutiveReadFailures > 0 }
        }
        compose.onNode(skeleton).assertIsDisplayed()
        assertEquals(bounds, compose.onNode(skeleton).getUnclippedBoundsInRoot())
        compose.onNodeWithText(retryLabel).assertDoesNotExist()
        compose.mainClock.autoAdvance = false
        try {
            fixture.historyRows = historyRows
            compose.waitUntil(10_000) {
                compose.runOnIdle { model.history.uiState.value.phase == HistoryPhase.Ready }
            }
            val message = hasText("Hello history")
            compose.mainClock.advanceTimeUntil(1_000) {
                if (compose.onAllNodes(message).fetchSemanticsNodes().isNotEmpty()) true
                else {
                    compose.onNode(skeleton).assertIsDisplayed()
                    false
                }
            }
            compose.onNode(message).assertIsDisplayed()
        } finally {
            compose.mainClock.autoAdvance = true
        }
        compose.onNode(skeleton).assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h320dp")
    fun firstReplyPreservesAnOlderAnchorAndDefersReadUntilJumpingToLatest() {
        val received = AtomicInteger(12)
        val model = openScrollHistory(received)
        val readCount = fixture.readRequests.get()
        compose.onNodeWithTag("conversation").performScrollToIndex(7)
        val anchor = compose.onNodeWithTag("message_${scrollEventId(6)}").assertIsDisplayed()
        val bounds = anchor.getUnclippedBoundsInRoot()
        receiveFirstReply(model, received)
        assertEquals(bounds, anchor.getUnclippedBoundsInRoot())
        assertEquals(readCount, fixture.readRequests.get())
        compose.onNodeWithTag("conversation_jump").performClick()
        compose.onNodeWithText("The first reply").assertIsDisplayed()
        compose.waitUntil(10_000) {
            compose.runOnIdle { fixture.readRequests.get() == readCount + 1 }
        }
        compose.onNodeWithTag("conversation_jump").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h320dp")
    fun newReplyKeepsTheCurrentMessageAfterASmallScrollAwayFromTheEnd() {
        val received = AtomicInteger(12)
        val model = openScrollHistory(received)
        val readCount = fixture.readRequests.get()
        val anchor = compose.onNodeWithTag("message_${scrollEventId(12)}").assertIsDisplayed()
        val atEnd = anchor.getUnclippedBoundsInRoot()
        val density = compose.activity.resources.displayMetrics.density
        compose.onNodeWithTag("conversation").performSemanticsAction(SemanticsActions.ScrollBy) {
            assertTrue(it(0f, 8f * density))
        }
        val reading = anchor.getUnclippedBoundsInRoot()
        assertEquals(8.dp.value, (reading.bottom - atEnd.bottom).value, 1f)
        receiveFirstReply(model, received)
        assertEquals(reading, anchor.getUnclippedBoundsInRoot())
        assertEquals(readCount, fixture.readRequests.get())
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h320dp")
    fun anIncomingReplyFollowsTheEndWithoutAJumpAction() {
        val received = AtomicInteger(12)
        val model = openScrollHistory(received)
        val readCount = fixture.readRequests.get()
        received.incrementAndGet()
        compose.runOnIdle { model.history.refresh() }
        compose.waitUntilExactlyOneExists(hasText("The first reply"), 10_000)
        compose.onNodeWithText("The first reply").assertIsDisplayed()
        compose.onNodeWithTag("conversation_jump").assertDoesNotExist()
        compose.waitUntil(10_000) { fixture.readRequests.get() > readCount }
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h320dp")
    fun reopeningAnOlderPositionOnlyShowsNewReplyForUnreadContent() {
        val showConversation = mutableStateOf(true)
        val unread = AtomicBoolean(false)
        fixture.indicators = {
            if (unread.get())
                jsonResponse(
                    """{"threads":{"$CHAT_IN_PROJECT":"unread"},"unreadAt":{"$CHAT_IN_PROJECT":"$CHAT_DATE"}}""",
                )
            else jsonResponse("""{"threads":{},"unreadAt":{}}""")
        }
        val received = AtomicInteger(12)
        val model = openScrollHistory(received, showConversation)
        val readCountBeforeReply = fixture.readRequests.get()
        received.incrementAndGet()
        compose.runOnIdle { model.history.refresh() }
        compose.waitUntilExactlyOneExists(hasText("The first reply"), 10_000)
        compose.onNodeWithText("The first reply").assertIsDisplayed()
        compose.waitUntil(10_000) { fixture.readRequests.get() == readCountBeforeReply + 1 }

        val conversation = compose.onNodeWithTag("conversation")
        val jump = hasTestTag("conversation_jump")
        val newReply =
            jump and
                hasContentDescription(compose.activity.getString(R.string.conversation_new_reply))
        conversation.performScrollToIndex(7)
        compose.waitUntilExactlyOneExists(jump, 10_000)
        val anchorTag = "message_${scrollEventId(6)}"
        val anchor = compose.onNodeWithTag(anchorTag).assertIsDisplayed()
        val bounds = anchor.getUnclippedBoundsInRoot()
        compose.waitUntil("the older anchor is recorded", 5_000) {
            compose.runOnIdle {
                runBlocking { model.history.restoreReadingAnchor(CHAT_IN_PROJECT) } != null
            }
        }

        compose.runOnIdle { showConversation.value = false }
        compose.waitUntilDoesNotExist(hasTestTag("conversation"), 5_000)
        compose.mainClock.autoAdvance = false
        try {
            compose.runOnIdle { showConversation.value = true }
            compose.mainClock.advanceTimeUntil(1_000) {
                compose.onNodeWithText("The first reply").assertIsNotDisplayed()
                compose.onAllNodes(hasTestTag(anchorTag)).fetchSemanticsNodes().isNotEmpty()
            }
        } finally {
            compose.mainClock.autoAdvance = true
        }
        compose.waitUntilExactlyOneExists(jump, 10_000)
        assertEquals(bounds, anchor.getUnclippedBoundsInRoot())
        compose.onNode(newReply).assertDoesNotExist()
        assertEquals(readCountBeforeReply + 1, fixture.readRequests.get())

        compose.runOnIdle { showConversation.value = false }
        compose.waitUntilDoesNotExist(hasTestTag("conversation"), 5_000)
        // The first reopen can restore the anchor while its history refresh is still running.
        compose.waitUntil(10_000) {
            compose.runOnIdle {
                model.uiState.value.indicatorsPhase != ChatReadPhase.Loading &&
                    model.history.uiState.value.confirmation?.cursor?.seqId == 13L
            }
        }
        received.incrementAndGet()
        unread.set(true)
        compose.runOnIdle { model.refreshIndicators() }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.uiState.value.isUnread(CHAT_IN_PROJECT) }
        }
        compose.runOnIdle { showConversation.value = true }
        compose.waitUntilExactlyOneExists(newReply, 10_000)
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.history.uiState.value.confirmation?.cursor?.seqId == 14L }
        }
        assertEquals(bounds, anchor.getUnclippedBoundsInRoot())
        assertEquals(readCountBeforeReply + 1, fixture.readRequests.get())
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h320dp")
    fun firstReplyPreservesTheMessageUnderAnActiveDrag() {
        val received = AtomicInteger(12)
        val model = openScrollHistory(received)
        val readCount = fixture.readRequests.get()
        val conversation = compose.onNodeWithTag("conversation")
        val anchor = compose.onNodeWithTag("message_${scrollEventId(12)}").assertIsDisplayed()
        val latest = anchor.getUnclippedBoundsInRoot()
        conversation.performTouchInput {
            down(center)
            moveBy(Offset(x = 0f, y = 22.dp.toPx()))
        }
        val afterDrag =
            try {
                val reading = anchor.getUnclippedBoundsInRoot()
                assertTrue(reading.bottom > latest.bottom)
                receiveFirstReply(model, received)
                assertEquals(reading, anchor.getUnclippedBoundsInRoot())
                conversation.performTouchInput { moveBy(Offset(x = 0f, y = 4.dp.toPx())) }
                val moved = anchor.getUnclippedBoundsInRoot()
                assertEquals(4f, (moved.bottom - reading.bottom).value, 1f)
                moved
            } finally {
                conversation.performTouchInput { cancel() }
            }
        assertEquals(afterDrag, anchor.getUnclippedBoundsInRoot())
        assertEquals(readCount, fixture.readRequests.get())
        compose.onNodeWithTag("conversation_jump").performClick()
        compose.onNodeWithText("The first reply").assertIsDisplayed()
        compose.waitUntil(10_000) { fixture.readRequests.get() == readCount + 1 }
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h320dp")
    fun losingConversationAccessClearsAnActivelyDraggedTimeline() {
        val model = openScrollHistory(AtomicInteger(12))
        val conversation = compose.onNodeWithTag("conversation")
        val working =
            compose.onNodeWithText(compose.activity.getString(R.string.conversation_processing))
        conversation.performScrollToIndex(1)
        conversation.performTouchInput {
            down(center)
            moveBy(Offset(x = 0f, y = 22.dp.toPx()))
        }
        try {
            working.assertIsDisplayed()
            fixture.historyDetail = { MockResponse().setResponseCode(403) }
            compose.runOnIdle { model.history.invalidateDetail(CHAT_IN_PROJECT) }
            compose.waitUntil(5_000) {
                compose.runOnIdle { model.history.uiState.value.phase == HistoryPhase.Missing }
            }
            compose
                .onNodeWithText(compose.activity.getString(R.string.history_missing))
                .assertIsDisplayed()
            working.assertDoesNotExist()
        } finally {
            conversation.performTouchInput { cancel() }
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w400dp-h320dp")
    fun confirmedAccessLossRemainsVisibleUntilAnAuthorizedHistoryRead() {
        val model = openScrollHistory(AtomicInteger(12))
        val originalRows = fixture.historyRows
        val missing = hasText(compose.activity.getString(R.string.history_missing))
        val lastMessage = hasText("Prompt number 12")
        fixture.historyRows = { MockResponse().setResponseCode(403) }
        compose.runOnIdle { model.history.invalidate(CHAT_IN_PROJECT) }
        compose.waitUntilExactlyOneExists(missing, 5_000)

        val recheckRequested = CountDownLatch(1)
        val completeRecheck = CountDownLatch(1)
        fixture.historyRows = { request ->
            recheckRequested.countDown()
            completeRecheck.await()
            originalRows(request)
        }
        try {
            compose.runOnIdle { model.history.invalidate(CHAT_IN_PROJECT) }
            compose.waitUntil("the history recheck has reached the server", 5_000) {
                compose.runOnIdle { recheckRequested.count == 0L }
            }
            compose.onNode(missing).assertIsDisplayed()
            compose.onNode(lastMessage).assertDoesNotExist()
        } finally {
            completeRecheck.countDown()
        }

        compose.waitUntilExactlyOneExists(lastMessage, 5_000)
        compose.onNode(missing).assertDoesNotExist()
    }

    private fun scrollEventId(sequence: Int) =
        "aaaaaaaa-aaaa-4aaa-8aaa-${sequence.toString().padStart(12, '0')}"

    private fun serveConversationRows(rows: List<String>, published: () -> Int = { rows.size }) {
        fixture.historyRows = { request ->
            val after = request.requestUrl?.queryParameter("sinceSeqId")?.toInt() ?: 0
            val last = published()
            val tail = rows.subList(after, last).joinToString(",")
            jsonResponse(
                """{"rows":[$tail],"cursor":{"lastEventId":"${scrollEventId(last)}","lastSeqId":$last},"hasMore":false}""",
            )
        }
    }

    private fun openPersonalHistory(model: ChatListModel) {
        compose.waitUntil(5_000) {
            compose.runOnIdle { model.uiState.value.listPhase == ChatReadPhase.Ready }
        }
        compose.runOnIdle {
            model.history.open(model.uiState.value.threads.single { it.id == CHAT_PERSONAL })
        }
        compose.waitUntil(5_000) {
            compose.runOnIdle { model.history.uiState.value.phase == HistoryPhase.Ready }
        }
    }

    private fun openScrollHistory(
        received: AtomicInteger,
        showConversation: State<Boolean>? = null,
        wallMillis: () -> Long = System::currentTimeMillis,
    ): ChatListModel {
        fixture.historyRows = { request ->
            val after = request.requestUrl?.queryParameter("sinceSeqId")?.toInt() ?: 0
            val last = received.get()
            val rows =
                ((after + 1)..last).joinToString(",") { sequence ->
                    val isReply = sequence > 12
                    historyEventWire(
                        id = scrollEventId(sequence),
                        seq = sequence.toLong(),
                        thread = CHAT_IN_PROJECT,
                        type = if (isReply) "output.message" else "input.prompt",
                        payload =
                            if (isReply) """{"content":"The first reply"}"""
                            else
                                """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Prompt number $sequence"}]}}""",
                        run = "bbbbbbbb-bbbb-4bbb-8bbb-${sequence.toString().padStart(12, '0')}",
                    )
                }
            jsonResponse(
                """{"rows":[$rows],"cursor":{"lastEventId":"${scrollEventId(last)}","lastSeqId":$last},"hasMore":false}""",
            )
        }
        val model = createListModel(wallMillis = wallMillis)
        compose.setContent {
            val list by model.uiState.collectAsStateWithLifecycle()
            OkouTheme {
                if (showConversation?.value != false)
                    ConversationRoute(model.history, CHAT_IN_PROJECT, list)
            }
        }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.uiState.value.listPhase == ChatReadPhase.Ready }
        }
        compose.runOnIdle {
            model.history.open(model.uiState.value.threads.single { it.id == CHAT_IN_PROJECT })
        }
        compose.waitUntil("the first confirmed history is ready", 10_000) {
            compose.runOnIdle { model.history.uiState.value.phase != HistoryPhase.Loading }
        }
        assertEquals(HistoryPhase.Ready, model.history.uiState.value.phase)
        compose.onNodeWithText("Prompt number 12").assertIsDisplayed()
        compose.waitUntil("the visible latest history is acknowledged", 10_000) {
            compose.runOnIdle { fixture.readRequests.get() > 0 }
        }
        return model
    }

    private fun receiveFirstReply(model: ChatListModel, received: AtomicInteger) {
        received.incrementAndGet()
        compose.runOnIdle { model.history.refresh() }
        compose.waitUntilExactlyOneExists(
            hasTestTag("conversation_jump") and
                hasContentDescription(compose.activity.getString(R.string.conversation_new_reply)),
            10_000,
        )
    }

    private fun createListModel(
        wallMillis: () -> Long = System::currentTimeMillis,
    ): ChatListModel = compose.runOnIdle {
        val storage = ChatCacheStore(compose.activity.application, temporary.newFolder())
        cache = storage
        ViewModelProvider(
                owners,
                viewModelFactory {
                    initializer {
                        ChatListModel(
                            fixture.service,
                            storage,
                            fixture.identity,
                            { true },
                            {},
                            wallMillis = wallMillis,
                        )
                    }
                },
            )[ChatListModel::class.java]
            .also {
                ownerJob = it.viewModelScope.coroutineContext[Job]
                it.refresh()
            }
    }

    @Test
    fun anEffectCannotAcknowledgeContentThatArrivedAfterItsComposition() {
        var sequence = 37L
        val markedSequences = mutableListOf<Long>()
        val advanceAfterComposition = AtomicBoolean()
        val service =
            object : ConversationHistoryService {
                override suspend fun threadDetail(threadId: String) = ThreadDetail(null, false)

                override suspend fun historySnapshot(threadId: String): HistorySnapshot =
                    throw ApiFailure.Http(404, "CHAT_EVENT_SNAPSHOT_NOT_FOUND", null, null)

                override suspend fun historyArchive(url: String): List<HistoryEvent> =
                    error("No archive for this fixture")

                override suspend fun historyRows(
                    threadId: String,
                    cursor: HistoryCursor,
                ): HistoryPage {
                    if (cursor.seqId >= sequence) return HistoryPage(emptyList(), cursor, false)
                    val id = "aaaaaaaa-aaaa-4aaa-8aaa-${sequence.toString().padStart(12, '0')}"
                    return HistoryPage(
                        listOf(HistoryEvent.decode(historyEventWire(id, sequence, threadId))),
                        HistoryCursor(id, sequence),
                        false,
                    )
                }

                override suspend fun markRead(threadId: String): ReadState {
                    markedSequences += sequence
                    return ReadState(CHAT_DATE)
                }
            }
        // Real, immediate IO failure lets the fixture deliver results during composition apply.
        val storage =
            ChatCacheStore(
                    compose.activity.application,
                    temporary.newFile(),
                    Dispatchers.Unconfined,
                )
                .also { cache = it }
        val lease = storage.open(fixture.identity) { true }
        val scope = CoroutineScope(Job() + Dispatchers.Unconfined)
        val model =
            ConversationHistoryModel(
                service,
                lease,
                scope,
                { true },
                {},
                {},
                Dispatchers.Unconfined,
            )
        val thread =
            Json.decodeFromString<ChatArchive>(
                    """{"chatThreads":[{"id":"$CHAT_PERSONAL","projectId":null,"title":"History thread","sortAt":"$CHAT_DATE","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","pinnedAt":null,"archived":false,"renamedAt":null}]}""",
                )
                .chatThreads
                .single()
        try {
            compose.runOnIdle { model.open(thread) }
            compose.setContent {
                val confirmation = model.uiState.collectAsStateWithLifecycle().value.confirmation
                DisposableEffect(confirmation) {
                    if (advanceAfterComposition.getAndSet(false)) {
                        sequence = 73
                        model.refresh()
                    }
                    onDispose {}
                }
                OkouTheme { ConversationRoute(model, CHAT_PERSONAL, ChatListUiState()) }
            }
            compose.waitForIdle()
            compose.runOnIdle { assertEquals(listOf(37L), markedSequences) }
            compose.mainClock.autoAdvance = false
            compose.runOnIdle {
                sequence = 53
                advanceAfterComposition.set(true)
                model.refresh()
            }
            compose.mainClock.advanceTimeByFrame()
            compose.runOnIdle { assertEquals(listOf(37L), markedSequences) }
            compose.mainClock.advanceTimeByFrame()
            compose.runOnIdle { assertEquals(listOf(37L, 73L), markedSequences) }
        } finally {
            compose.mainClock.autoAdvance = true
            compose.runOnIdle {
                model.close()
                scope.cancel()
                lease.close()
            }
        }
    }
}
