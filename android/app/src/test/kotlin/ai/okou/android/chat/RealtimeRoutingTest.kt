package ai.okou.android.chat

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatListApiFixture
import ai.okou.android.TestOkouApplication
import ai.okou.android.TestRealtimeService
import ai.okou.android.api.generated.SessionOutputDelta
import ai.okou.android.chatEventWire
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.test.core.app.ApplicationProvider
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class RealtimeRoutingTest {
    @get:Rule val temporary = TemporaryFolder()

    private suspend fun TestScope.withReadyModel(
        block: suspend TestScope.(ChatListApiFixture, ChatListModel, TestRealtimeService) -> Unit
    ) {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val store = ViewModelStore()
        val cache =
            ChatCacheStore(
                ApplicationProvider.getApplicationContext(),
                temporary.newFolder(),
                dispatcher,
            )
        try {
            ChatListApiFixture().use { api ->
                val realtime = TestRealtimeService()
                val model =
                    ViewModelProvider(
                        store,
                        viewModelFactory {
                            initializer {
                                ChatListModel(
                                    api.service,
                                    cache,
                                    api.identity,
                                    { true },
                                    { throw it },
                                    dispatcher,
                                    realtime,
                                    { testScheduler.currentTime },
                                )
                            }
                        },
                    )[ChatListModel::class.java]
                model.updates.foreground(true)
                runCurrent()
                model.uiState.first {
                    it.listPhase == ChatReadPhase.Ready && it.indicatorsPhase == ChatReadPhase.Ready
                }
                model.refreshMetadata()
                suspend fun ready() {
                    model.uiState.first {
                        it.listPhase == ChatReadPhase.Ready &&
                            it.projectsPhase == ChatReadPhase.Ready &&
                            it.agentsPhase == ChatReadPhase.Ready &&
                            it.projectsSettingsPhase == ChatReadPhase.Ready &&
                            it.indicatorsPhase == ChatReadPhase.Ready
                    }
                }
                ready()
                model.history.open(model.uiState.value.threads.single { it.id == CHAT_PERSONAL })
                model.history.uiState.first { it.phase == HistoryPhase.Ready }
                runCurrent()
                block(api, model, realtime)
            }
        } finally {
            store.clear()
            cache.close()
            Dispatchers.resetMain()
        }
    }

    private fun record(api: ChatListApiFixture): ConcurrentLinkedQueue<String> =
        ConcurrentLinkedQueue<String>().also { paths ->
            api.commandResponse = { request ->
                paths.add(checkNotNull(request.requestUrl).encodedPath)
                null
            }
        }

    private fun indicators(api: ChatListApiFixture, stamp: String) {
        api.indicators = {
            jsonResponse(
                """{"agents":{},"threads":{"$CHAT_PERSONAL":"unread"},"unreadAt":{"$CHAT_PERSONAL":"$stamp"}}"""
            )
        }
    }

    private suspend fun ChatListModel.observedIndicators(stamp: String) {
        uiState.first {
            it.indicatorsPhase == ChatReadPhase.Ready &&
                it.indicators?.unreadAt?.get(CHAT_PERSONAL) == stamp
        }
    }

    @Test
    fun streamedOutputStaysTransientAndPersistenceRefreshesOnlyItsHistory() = runTest {
        withReadyModel { api, model, realtime ->
            val runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            val inputId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
            val eventId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
            val persisted = AtomicBoolean()
            api.historyRows = { request ->
                val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0
                val saved = persisted.get()
                val rows =
                    buildList {
                            if (since < 41)
                                add(
                                    historyEventWire(
                                        inputId,
                                        41,
                                        type = "input.prompt",
                                        payload =
                                            """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Start routed output"}]}}""",
                                        run = runId,
                                    )
                                )
                            if (saved && since < 42)
                                add(
                                    historyEventWire(
                                        eventId,
                                        42,
                                        payload = """{"content":"Saved routed answer"}""",
                                        run = runId,
                                    )
                                )
                        }
                        .joinToString(",")
                val lastId = if (saved) eventId else inputId
                val lastSeq = if (saved) 42 else 41
                jsonResponse(
                    """{"rows":[$rows],"cursor":{"lastEventId":"$lastId","lastSeqId":$lastSeq},"hasMore":false}"""
                )
            }
            checkNotNull(
                model.history.beginVisit(CHAT_PERSONAL, model.history.uiState.value.generation)
            )
            model.history.uiState.first { it.phase == HistoryPhase.Ready }
            val target = checkNotNull(realtime.target.first { it?.runId == runId })
            runCurrent()
            val confirmation = model.history.uiState.value.confirmation
            val paths = record(api)
            fun chunk(index: Long, text: String) =
                RunOutputSignal.Delta(
                    SessionOutputDelta(
                        target.threadId,
                        target.runId,
                        eventId,
                        "routed-output",
                        CHAT_DATE,
                        index,
                        text,
                    )
                )
            realtime.output(chunk(0, "Live routed "))
            realtime.output(chunk(2, "answer"))
            model.history.output.state.first {
                it.messages.singleOrNull()?.blocks?.singleOrNull()?.text == "Live routed answer"
            }
            runCurrent()
            assertEquals(confirmation, model.history.uiState.value.confirmation)
            assertEquals(HistoryPhase.Ready, model.history.uiState.value.phase)
            assertTrue(paths.isEmpty())

            persisted.set(true)
            realtime.invalidate(ChatChanges(threads = setOf(CHAT_PERSONAL)))
            val saved =
                model.history.uiState.first {
                    it.phase == HistoryPhase.Ready &&
                        it.transcript?.messages?.any { message -> message.id == eventId } == true
                }
            runCurrent()
            val messages =
                checkNotNull(saved.transcript)
                    .withOutput(model.history.output.state.value, CHAT_PERSONAL)
                    .filter { it.id == eventId }
            assertEquals("Saved routed answer", messages.single().blocks.single().text)
            assertTrue(model.history.output.state.value.messages.isEmpty())
            assertEquals(1, paths.count { it.endsWith("/event-rows") })
            assertTrue(paths.all { it.startsWith("/api/chat-threads/$CHAT_PERSONAL") })
        }
    }

    @Test
    fun unrelatedMessagesAndReadCursorsDoNotRefetchUnchangedListOrSelectedHistory() = runTest {
        withReadyModel { api, model, realtime ->
            val paths = record(api)
            val confirmation = model.history.uiState.value.confirmation
            realtime.invalidate(ChatChanges(threads = setOf(CHAT_IN_PROJECT)))
            runCurrent()
            assertEquals(confirmation, model.history.uiState.value.confirmation)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertTrue(paths.isEmpty())

            val stamp = "2026-11-13T00:00:01Z"
            indicators(api, stamp)
            realtime.invalidate(ChatChanges(readCursor = true))
            runCurrent()
            model.observedIndicators(stamp)
            runCurrent()
            assertEquals(listOf("/api/indicators"), paths.toList())
            assertEquals(confirmation, model.history.uiState.value.confirmation)
            assertEquals(HistoryPhase.Ready, model.history.uiState.value.phase)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
        }
    }

    @Test
    fun listSignalsRefreshProjectNavigationWithoutRefetchingHistoryOrIndicators() = runTest {
        withReadyModel { api, model, realtime ->
            val paths = record(api)
            val confirmation = model.history.uiState.value.confirmation
            api.events = { request ->
                val fresh =
                    (request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0) < 41
                jsonResponse(
                    """{"events":[${if (fresh) chatEventWire(seq = 41, id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind = "renamed", title = "Changed title") else ""}],"hasMore":false}"""
                )
            }
            api.projectEvents = {
                jsonResponse(
                    """{"events":[{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","seqId":41,"projectId":"$CHAT_PROJECT","kind":"renamed","name":"Changed project","createdAt":"2026-11-14T00:00:00Z"}],"hasMore":false}"""
                )
            }
            realtime.invalidate(ChatChanges(list = true))
            runCurrent()
            model.uiState.first {
                it.listPhase == ChatReadPhase.Ready &&
                    it.projectsPhase == ChatReadPhase.Ready &&
                    it.threads.any { row -> row.title == "Changed title" } &&
                    it.projects.any { row -> row.name == "Changed project" }
            }
            runCurrent()
            assertEquals(listOf("/api/chat-threads/events", "/api/projects/events"), paths.sorted())
            assertEquals(confirmation, model.history.uiState.value.confirmation)
        }
    }

    @Test
    fun runStateBurstsShareADeadlineAndReadCursorDemandWakesTheTrailingRefresh() = runTest {
        withReadyModel { api, model, realtime ->
            val paths = record(api)
            advanceTimeBy(1_000)
            val first = "2026-11-13T00:00:01Z"
            indicators(api, first)
            realtime.invalidate(ChatChanges(indicators = true))
            runCurrent()
            model.observedIndicators(first)
            runCurrent()
            assertEquals(1, paths.size)

            val second = "2026-11-13T00:00:02Z"
            indicators(api, second)
            repeat(20) {
                realtime.invalidate(ChatChanges(indicators = true))
                runCurrent()
            }
            advanceTimeBy(999)
            runCurrent()
            assertEquals(first, model.uiState.value.indicators?.unreadAt?.get(CHAT_PERSONAL))
            assertEquals(1, paths.size)
            advanceTimeBy(1)
            runCurrent()
            model.observedIndicators(second)
            runCurrent()
            assertEquals(2, paths.size)

            val third = "2026-11-13T00:00:03Z"
            val immediateAt = testScheduler.currentTime
            indicators(api, third)
            realtime.invalidate(ChatChanges(indicators = true))
            runCurrent()
            realtime.invalidate(ChatChanges(readCursor = true))
            runCurrent()
            model.observedIndicators(third)
            runCurrent()
            assertEquals(immediateAt, testScheduler.currentTime)
            assertEquals(3, paths.size)
            assertTrue(paths.all { it == "/api/indicators" })
        }
    }

    @Test
    fun laterStatusDemandCannotDowngradeAReadCursorQueuedBehindAnActiveRead() = runTest {
        withReadyModel { api, model, realtime ->
            val entered = CompletableDeferred<Unit>()
            val release = CountDownLatch(1)
            api.indicators = {
                entered.complete(Unit)
                release.await()
                jsonResponse("""{"agents":{},"threads":{},"unreadAt":{}}""")
            }
            try {
                advanceTimeBy(1_000)
                realtime.invalidate(ChatChanges(indicators = true))
                runCurrent()
                entered.await()
                val immediateAt = testScheduler.currentTime
                val stamp = "2026-11-13T00:00:04Z"
                indicators(api, stamp)
                realtime.invalidate(ChatChanges(readCursor = true))
                runCurrent()
                realtime.invalidate(ChatChanges(indicators = true))
                runCurrent()
                release.countDown()
                model.observedIndicators(stamp)
                assertEquals(immediateAt, testScheduler.currentTime)
            } finally {
                release.countDown()
            }
        }
    }

    @Test
    fun readCursorDuringAManualReadRetainsDemandFromTheThrottledWorker() = runTest {
        withReadyModel { api, model, realtime ->
            advanceTimeBy(1_000)
            val first = "2026-11-13T00:00:01Z"
            indicators(api, first)
            realtime.invalidate(ChatChanges(indicators = true))
            runCurrent()
            model.observedIndicators(first)
            runCurrent()
            realtime.invalidate(ChatChanges(indicators = true))
            runCurrent()
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            api.indicators = {
                entered.countDown()
                release.await()
                jsonResponse("""{"agents":{},"threads":{},"unreadAt":{}}""")
            }
            try {
                model.refreshIndicators()
                runCurrent()
                // The HTTP server runs off the test dispatcher. Rendezvous without advancing the
                // virtual throttle deadline while waiting for that real request to arrive.
                assertTrue(entered.await(10, TimeUnit.SECONDS))
                val stamp = "2026-11-13T00:00:05Z"
                indicators(api, stamp)
                realtime.invalidate(ChatChanges(readCursor = true))
                runCurrent()
                release.countDown()
                model.uiState.first { it.indicatorsPhase == ChatReadPhase.Ready }
                runCurrent()
                assertTrue(
                    "Read-cursor demand needs a new read after the held manual response",
                    model.uiState.value.indicatorsPhase == ChatReadPhase.Loading ||
                        model.uiState.value.indicators?.unreadAt?.get(CHAT_PERSONAL) == stamp,
                )
                model.observedIndicators(stamp)
            } finally {
                release.countDown()
            }
        }
    }

    @Test
    fun messageDemandDuringAHeldReadCatchesUpAgainWithoutRefreshingOtherResources() = runTest {
        withReadyModel { api, model, realtime ->
            val paths = record(api)
            val sequence = AtomicLong(41)
            val entered = CompletableDeferred<Unit>()
            val release = CountDownLatch(1)
            api.historyRows = { request ->
                val seq = sequence.get()
                if (seq == 41L) {
                    entered.complete(Unit)
                    release.await()
                }
                val id = "aaaaaaaa-aaaa-4aaa-8aaa-${seq.toString().padStart(12, '0')}"
                val fresh =
                    (request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0) < seq
                val row = historyEventWire(id, seq, payload = """{"content":"Message $seq"}""")
                jsonResponse(
                    """{"rows":[${if (fresh) row else ""}],"cursor":{"lastEventId":"$id","lastSeqId":$seq},"hasMore":false}"""
                )
            }
            try {
                realtime.invalidate(ChatChanges(threads = setOf(CHAT_PERSONAL)))
                runCurrent()
                entered.await()
                sequence.set(52)
                repeat(50) { realtime.invalidate(ChatChanges(threads = setOf(CHAT_PERSONAL))) }
                runCurrent()
                release.countDown()
                model.history.uiState.first {
                    it.phase == HistoryPhase.Ready &&
                        it.confirmation?.cursor?.seqId == 52L &&
                        it.transcript?.messages?.any { message ->
                            message.blocks.any { block -> block.text == "Message 52" }
                        } == true
                }
                runCurrent()
                assertEquals(2, paths.count { it.endsWith("/event-rows") })
                assertTrue(paths.all { it.startsWith("/api/chat-threads/$CHAT_PERSONAL") })
            } finally {
                release.countDown()
            }
        }
    }

    @Test
    fun queuedHistoryDemandKeepsItsSelectionGeneration() = runTest {
        withReadyModel { api, model, _ ->
            val paths = record(api)
            model.history.invalidate(CHAT_PERSONAL)
            model.history.open(model.uiState.value.threads.single { it.id == CHAT_IN_PROJECT })
            runCurrent()
            model.history.uiState.first { it.phase == HistoryPhase.Ready }
            runCurrent()
            assertEquals(HistoryPhase.Ready, model.history.uiState.value.phase)
            assertEquals(1, paths.count { it == "/api/chat-threads/$CHAT_IN_PROJECT" })
            assertEquals(CHAT_IN_PROJECT, model.history.uiState.value.thread?.id)
        }
    }
}
