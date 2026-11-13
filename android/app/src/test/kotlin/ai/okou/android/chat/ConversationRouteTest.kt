package ai.okou.android.chat

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatListApiFixture
import ai.okou.android.OkouTheme
import ai.okou.android.R
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.HistorySnapshot
import ai.okou.android.api.generated.ReadState
import ai.okou.android.api.generated.ThreadDetail
import ai.okou.android.historyEventWire
import androidx.activity.ComponentActivity
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = TestOkouApplication::class)
class ConversationRouteTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    @get:Rule val temporary = TemporaryFolder()
    private val owners = ViewModelStore()
    private val fixture = ChatListApiFixture()
    private var cache: ChatCacheStore? = null
    private var ownerJob: Job? = null

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
        val model =
            compose.runOnIdle {
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
                                )
                            }
                        },
                    )[ChatListModel::class.java]
                    .also {
                        ownerJob = it.viewModelScope.coroutineContext[Job]
                        it.refresh()
                    }
            }
        compose.setContent {
            val list by model.uiState.collectAsStateWithLifecycle()
            OkouTheme {
                ConversationRoute(model.history, CHAT_IN_PROJECT, list, visible = visible.value)
            }
        }
        compose.onNodeWithText("Loading conversation…").assertExists()
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.uiState.value.listPhase == ChatReadPhase.Ready }
        }
        compose.runOnIdle {
            model.history.open(model.uiState.value.threads.single { it.id == CHAT_IN_PROJECT })
        }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.history.uiState.value.phase == HistoryPhase.Ready }
        }
        compose
            .onNodeWithTag("conversation")
            .performScrollToNode(hasText("Native history", substring = true))
        compose.onNodeWithText("Native history", substring = true).assertExists()
        compose.waitUntil(10_000) { compose.runOnIdle { fixture.readRequests.get() > 0 } }
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
        val readFailed = compose.activity.getString(R.string.history_read_failed)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(readFailed).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(readFailed).assertExists()
        compose.waitForIdle()
        assertEquals(5, fixture.readRequests.get())
        fixture.historyMarkRead = successfulRead
        compose.onNodeWithText(compose.activity.getString(R.string.retry)).performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(readFailed).fetchSemanticsNodes().isEmpty()
        }
        assertEquals(6, fixture.readRequests.get())
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
                    """{"chatThreads":[{"id":"$CHAT_PERSONAL","agentId":"agent-original","projectId":null,"title":"History thread","sortAt":"$CHAT_DATE","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","pinnedAt":null,"archived":false,"renamedAt":null}]}"""
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
