package ai.okou.android.chat

import ai.okou.android.CHAT_AGENT
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_EVENT
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatListApiFixture
import ai.okou.android.TestOkouApplication
import ai.okou.android.TestRealtimeService
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.HistoryCatchUpRequest
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
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
class HistoryWarmingTest {
    @get:Rule val temporary = TemporaryFolder()

    private data class Ready(
        val api: ChatListApiFixture,
        val model: ChatListModel,
        val realtime: TestRealtimeService,
        val store: ViewModelStore,
        val cache: ChatCacheStore,
        val directory: File,
        val errors: MutableList<Exception>,
        val allowed: AtomicBoolean,
    )

    private suspend fun TestScope.withModel(
        prepare: (ChatListApiFixture) -> Unit = {},
        expectFailure: Boolean = false,
        block: suspend TestScope.(Ready) -> Unit,
    ) {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val store = ViewModelStore()
        val directory = temporary.newFolder()
        val cache =
            ChatCacheStore(ApplicationProvider.getApplicationContext(), directory, dispatcher)
        val errors = mutableListOf<Exception>()
        val allowed = AtomicBoolean(true)
        try {
            ChatListApiFixture().use { api ->
                prepare(api)
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
                                    allowed::get,
                                    errors::add,
                                    dispatcher,
                                    realtime,
                                    { testScheduler.currentTime },
                                )
                            }
                        },
                    )[ChatListModel::class.java]
                model.refresh()
                model.uiState.first {
                    it.listPhase == ChatReadPhase.Ready && it.indicatorsPhase == ChatReadPhase.Ready
                }
                model.history.open(model.uiState.value.threads.single { it.id == CHAT_PERSONAL })
                model.history.uiState.first { it.phase == HistoryPhase.Ready }
                model.updates.foreground(true)
                runCurrent()
                model.warming.state.first { it.phase == ChatReadPhase.Ready }
                model.uiState.first {
                    it.listPhase == ChatReadPhase.Ready && it.indicatorsPhase == ChatReadPhase.Ready
                }
                model.history.uiState.first { it.phase == HistoryPhase.Ready }
                runCurrent()
                block(Ready(api, model, realtime, store, cache, directory, errors, allowed))
                if (!expectFailure) assertTrue(errors.toString(), errors.isEmpty())
            }
        } finally {
            store.clear()
            cache.close()
            Dispatchers.resetMain()
        }
    }

    private fun cursors(request: RecordedRequest): Map<String, Long> =
        Json.parseToJsonElement(request.body.clone().readUtf8()).jsonArray.associate {
            it.jsonArray[0].jsonPrimitive.content to it.jsonArray[1].jsonPrimitive.long
        }

    private fun event(seq: Long, text: String = "Warmed $seq") =
        historyEventWire(
            "aaaaaaaa-aaaa-4aaa-8aaa-${seq.toString().padStart(12, '0')}",
            seq,
            CHAT_IN_PROJECT,
            payload = """{"content":"$text"}""",
        )

    private fun batch(seq: Long, text: String = "Warmed $seq") =
        jsonResponse(
            """{"events":{"$CHAT_IN_PROJECT":[${event(seq, text)}]},"notFoundThreads":[]}"""
        )

    private suspend fun TestScope.warm(ready: Ready) {
        val revision = ready.model.warming.state.value.revision
        ready.realtime.invalidate(ChatChanges(messageThreads = setOf(CHAT_IN_PROJECT)))
        advanceTimeBy(1_000)
        runCurrent()
        ready.model.warming.state.first {
            it.revision > revision && it.phase == ChatReadPhase.Ready
        }
    }

    private val recoveringThreads = listOf(CHAT_IN_PROJECT, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")

    private fun recoveryCohort(api: ChatListApiFixture) {
        api.historyThreadIds = api.historyThreadIds + recoveringThreads
        api.indicators = {
            jsonResponse(
                """{"agents":{},"threads":{${recoveringThreads.joinToString(",") { "\"$it\":\"active\"" }}},"unreadAt":{}}"""
            )
        }
    }

    private fun recoverSnapshots(
        api: ChatListApiFixture,
        seq: Long,
        beforeSnapshot: (String) -> MockResponse? = { null },
    ) {
        api.historyCatchUp = {
            jsonResponse(
                """{"events":{},"notFoundThreads":[${recoveringThreads.joinToString(",") { "\"$it\"" }}]}"""
            )
        }
        val rows = api.historyRows
        api.historyRows = { request ->
            val id = checkNotNull(request.requestUrl).pathSegments[2]
            if (id in recoveringThreads)
                jsonResponse(
                    """{"rows":[],"cursor":{"lastEventId":"$id","lastSeqId":$seq},"hasMore":false}"""
                )
            else rows(request)
        }
        api.commandResponse = { request ->
            val path = checkNotNull(request.requestUrl).encodedPath
            val id = recoveringThreads.firstOrNull { path.contains(it) }
            when {
                id == null -> null
                path.endsWith("/event-snapshot") ->
                    beforeSnapshot(id)
                        ?: jsonResponse(
                            """{"url":"${api.server.url("/recovery-archive/$id")}","expiresInSeconds":60,"lastEventId":"$id","lastSeqId":$seq}"""
                        )
                path.startsWith("/recovery-archive/") ->
                    MockResponse().setBody(historyEventWire(id, seq, id) + "\n")
                else -> null
            }
        }
    }

    @Test
    fun snapshotRecoveriesStartTogetherAndRetainSuccessfulSiblingsAfterAFailure() = runTest {
        withModel(prepare = ::recoveryCohort, expectFailure = true) { ready ->
            val (api, model, realtime) = ready
            val entered = CountDownLatch(recoveringThreads.size)
            val release = CountDownLatch(1)
            recoverSnapshots(api, 55) {
                entered.countDown()
                release.await()
                null
            }
            val revision = model.warming.state.value.revision
            val selected = model.history.uiState.value.confirmation
            realtime.invalidate(ChatChanges(messageThreads = recoveringThreads.toSet()))
            advanceTimeBy(1_000)
            runCurrent()
            try {
                withContext(Dispatchers.IO) { assertTrue(entered.await(10, TimeUnit.SECONDS)) }
                model.history.refresh()
                model.history.uiState.first {
                    it.phase == HistoryPhase.Ready && it.confirmation != selected
                }
                release.countDown()
                model.warming.state.first {
                    it.phase == ChatReadPhase.Ready && it.revision > revision
                }
                recoverSnapshots(api, 66) { id ->
                    if (id == recoveringThreads.first()) MockResponse().setResponseCode(503)
                    else null
                }
                val next = model.warming.state.value.revision
                realtime.invalidate(ChatChanges(messageThreads = recoveringThreads.toSet()))
                advanceTimeBy(1_000)
                runCurrent()
                model.warming.state.first { it.phase == ChatReadPhase.Failed && it.revision > next }
                assertEquals(503, (ready.errors.single() as ApiFailure.Http).status)
                ready.store.clear()
                val lease = ready.cache.open(api.identity) { true }
                assertEquals(55L, lease.loadHistory(recoveringThreads[0])!!.checkpoint.cursor.seqId)
                assertEquals(66L, lease.loadHistory(recoveringThreads[1])!!.checkpoint.cursor.seqId)
                assertEquals(HistoryPhase.Ready, model.history.uiState.value.phase)
                assertEquals(0, api.readRequests.get())
            } finally {
                release.countDown()
            }
        }
    }

    @Test
    fun stopAndAuthorizationRetirementCancelEverySnapshotRecoveryBeforePublication() = runTest {
        withModel(prepare = ::recoveryCohort) { ready ->
            val (api, model, realtime) = ready
            for (retireAuthorization in listOf(false, true)) {
                val entered = CountDownLatch(recoveringThreads.size)
                val release = CountDownLatch(1)
                val answered = CountDownLatch(recoveringThreads.size)
                recoverSnapshots(api, 55) {
                    entered.countDown()
                    release.await()
                    answered.countDown()
                    null
                }
                val revision = model.warming.state.value.revision
                realtime.invalidate(ChatChanges(messageThreads = recoveringThreads.toSet()))
                advanceTimeBy(1_000)
                runCurrent()
                try {
                    withContext(Dispatchers.IO) { assertTrue(entered.await(10, TimeUnit.SECONDS)) }
                    model.updates.foreground(false)
                    assertEquals(ChatReadPhase.Idle, model.warming.state.value.phase)
                    if (retireAuthorization) {
                        ready.allowed.set(false)
                        ready.store.clear()
                    } else {
                        api.historyCatchUp = { request ->
                            assertEquals(recoveringThreads.associateWith { 37L }, cursors(request))
                            jsonResponse(
                                """{"events":{${recoveringThreads.joinToString(",") { "\"$it\":[]" }}},"notFoundThreads":[]}"""
                            )
                        }
                        model.updates.foreground(true)
                        runCurrent()
                    }
                    release.countDown()
                    assertTrue(answered.await(10, TimeUnit.SECONDS))
                    if (!retireAuthorization)
                        model.warming.state.first {
                            it.phase == ChatReadPhase.Ready && it.revision > revision
                        }
                } finally {
                    release.countDown()
                }
            }
            val lease = ready.cache.open(api.identity) { true }
            for (id in recoveringThreads) assertEquals(
                37L,
                lease.loadHistory(id)!!.checkpoint.cursor.seqId,
            )
            val other =
                ready.cache.open(api.identity.copy(workspaceId = "other-workspace")) { true }
            for (id in recoveringThreads) assertNull(other.loadHistory(id))
        }
    }

    @Test
    fun batchUsesCachedCursorsAndLargeConfirmedRowsSurviveDiskReopenWithoutMarkingRead() = runTest {
        withModel { ready ->
            val (api, model) = ready
            val text = "界".repeat(800_000)
            api.historyCatchUp = { request ->
                assertEquals(mapOf(CHAT_IN_PROJECT to 37L), cursors(request))
                assertEquals("Bearer fixture-token", request.getHeader("Authorization"))
                batch(41, text)
            }
            val selected = model.history.uiState.value.confirmation
            warm(ready)
            assertEquals(selected, model.history.uiState.value.confirmation)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertEquals(0, api.readRequests.get())
            val thread = model.uiState.value.threads.single { it.id == CHAT_IN_PROJECT }
            ready.store.clear()
            ready.cache.close()
            val reopened =
                ChatCacheStore(
                    ApplicationProvider.getApplicationContext(),
                    ready.directory,
                    StandardTestDispatcher(testScheduler),
                )
            val history =
                ConversationHistoryModel(
                    api.service,
                    reopened.open(api.identity) { true },
                    backgroundScope,
                    { true },
                    {},
                    {},
                    StandardTestDispatcher(testScheduler),
                )
            try {
                api.historyRows = { MockResponse().setResponseCode(503) }
                history.open(thread)
                val shown =
                    history.uiState.first {
                        it.phase == HistoryPhase.Failed && it.source == ChatListSource.Cache
                    }
                assertTrue(
                    shown.transcript!!.messages.any { row -> row.blocks.any { it.text == text } }
                )
                assertEquals(0, api.readRequests.get())
            } finally {
                history.close()
                reopened.close()
            }
        }
    }

    @Test
    fun staleWarmResponseCannotReplaceAConversationReadInTheForeground() = runTest {
        withModel { ready ->
            val (api, model, realtime) = ready
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            api.historyCatchUp = {
                entered.countDown()
                release.await()
                batch(41)
            }
            val revision = model.warming.state.value.revision
            realtime.invalidate(ChatChanges(messageThreads = setOf(CHAT_IN_PROJECT)))
            advanceTimeBy(1_000)
            runCurrent()
            try {
                assertTrue(entered.await(10, TimeUnit.SECONDS))
                api.historyRows = { request ->
                    if (request.requestUrl!!.pathSegments[2] == CHAT_IN_PROJECT) {
                        val fresh =
                            request.requestUrl!!.queryParameter("sinceSeqId")!!.toLong() < 52
                        jsonResponse(
                            """{"rows":[${if (fresh) event(52, "Foreground 52") else ""}],"cursor":{"lastEventId":"aaaaaaaa-aaaa-4aaa-8aaa-000000000052","lastSeqId":52},"hasMore":false}"""
                        )
                    } else
                        jsonResponse(
                            """{"rows":[],"cursor":{"lastEventId":"88888888-8888-4888-8888-888888888888","lastSeqId":37},"hasMore":false}"""
                        )
                }
                model.history.open(model.uiState.value.threads.single { it.id == CHAT_IN_PROJECT })
                model.history.uiState.first {
                    it.phase == HistoryPhase.Ready && it.confirmation?.cursor?.seqId == 52L
                }
                // A different selection removes the selected-thread exclusion: the cursor guard
                // itself must still protect the newer persisted history.
                model.history.open(model.uiState.value.threads.single { it.id == CHAT_PERSONAL })
                model.history.uiState.first { it.phase == HistoryPhase.Ready }
                release.countDown()
                model.warming.state.first {
                    it.revision > revision && it.phase == ChatReadPhase.Ready
                }
                ready.store.clear()
                val saved = ready.cache.open(api.identity) { true }.loadHistory(CHAT_IN_PROJECT)!!
                assertEquals(52L, saved.checkpoint.cursor.seqId)
                assertTrue(
                    projectHistory(saved.checkpoint).messages.any { row ->
                        row.blocks.any { it.text == "Foreground 52" }
                    }
                )
            } finally {
                release.countDown()
            }
        }
    }

    @Test
    fun missingBatchCursorRebuildsFromSnapshotAndMissingThreadClearsOnlyItsCache() = runTest {
        withModel { ready ->
            val (api, model) = ready
            var expectedCursor = 37L
            api.historyCatchUp = { request ->
                assertEquals(mapOf(CHAT_IN_PROJECT to expectedCursor), cursors(request))
                jsonResponse("""{"events":{},"notFoundThreads":["$CHAT_IN_PROJECT"]}""")
            }
            api.historySnapshot = {
                jsonResponse(
                    """{"url":"${api.server.url("/history-archive")}","expiresInSeconds":60,"lastEventId":"aaaaaaaa-aaaa-4aaa-8aaa-000000000055","lastSeqId":55}"""
                )
            }
            api.historyArchive = { MockResponse().setBody(event(55) + "\n") }
            api.historyRows = {
                jsonResponse(
                    """{"rows":[],"cursor":{"lastEventId":"aaaaaaaa-aaaa-4aaa-8aaa-000000000055","lastSeqId":55},"hasMore":false}"""
                )
            }
            warm(ready)
            expectedCursor = 55L
            api.historySnapshot = {
                jsonResponse(
                        """{"error":{"code":"CHAT_THREAD_NOT_FOUND","message":"Missing thread"}}"""
                    )
                    .setResponseCode(404)
            }
            warm(ready)
            assertEquals(HistoryPhase.Ready, model.history.uiState.value.phase)
            ready.store.clear()
            val lease = ready.cache.open(api.identity) { true }
            assertNull(lease.loadHistory(CHAT_IN_PROJECT))
            assertEquals(37L, lease.loadHistory(CHAT_PERSONAL)!!.checkpoint.cursor.seqId)
            assertEquals(0, api.readRequests.get())
        }
    }

    @Test
    fun malformedBatchPartitionFailsWithoutPublishingRowsAndCanRecoverOnLaterDemand() = runTest {
        withModel(expectFailure = true) { ready ->
            val (api, model, realtime) = ready
            api.historyCatchUp = {
                jsonResponse(
                    """{"events":{"$CHAT_IN_PROJECT":[${event(41)}]},"notFoundThreads":["$CHAT_IN_PROJECT"]}"""
                )
            }
            val revision = model.warming.state.value.revision
            realtime.invalidate(ChatChanges(messageThreads = setOf(CHAT_IN_PROJECT)))
            advanceTimeBy(1_000)
            runCurrent()
            model.warming.state.first { it.revision > revision && it.phase == ChatReadPhase.Failed }
            assertTrue(ready.errors.single() is ApiFailure.IncompatibleResponse)
            assertEquals(HistoryPhase.Ready, model.history.uiState.value.phase)
            api.historyCatchUp = { request ->
                assertEquals(mapOf(CHAT_IN_PROJECT to 37L), cursors(request))
                batch(43)
            }
            warm(ready)
            assertNull(model.warming.state.value.failure)
        }
    }

    @Test
    fun stopRestartAndAuthorizationRetirementCancelHeldWarmingWithoutBlockingVisibleReads() =
        runTest {
            withModel { ready ->
                val (api, model, realtime) = ready
                val entered = CountDownLatch(1)
                val release = CountDownLatch(1)
                val calls = AtomicInteger()
                api.historyCatchUp = {
                    if (calls.incrementAndGet() == 1) {
                        entered.countDown()
                        release.await()
                        batch(41)
                    } else batch(61)
                }
                val revision = model.warming.state.value.revision
                realtime.invalidate(ChatChanges(messageThreads = setOf(CHAT_IN_PROJECT)))
                advanceTimeBy(1_000)
                runCurrent()
                try {
                    assertTrue(entered.await(10, TimeUnit.SECONDS))
                    model.history.refresh()
                    model.history.uiState.first { it.phase == HistoryPhase.Ready }
                    model.updates.foreground(false)
                    model.updates.foreground(true)
                    runCurrent()
                    model.warming.state.first {
                        it.phase == ChatReadPhase.Ready && it.revision > revision
                    }
                    release.countDown()
                    model.updates.foreground(false)
                    ready.allowed.set(false)
                    model.updates.foreground(true)
                    runCurrent()
                    assertEquals(2, calls.get())
                    assertTrue(ready.errors.isEmpty())
                } finally {
                    release.countDown()
                }
            }
        }

    @Test
    fun warmingCohortMatchesWebButDoesNotLimitReadingAnOlderConversation() = runTest {
        val recent = (1..102).map { "aaaaaaaa-aaaa-4aaa-8aaa-${it.toString().padStart(12, '0')}" }
        val hidden = "ffffffff-ffff-4fff-8fff-ffffffffffff"
        var requested: Set<String> = emptySet()
        withModel(
            prepare = { api ->
                val ids = recent + listOf(hidden, CHAT_PERSONAL, CHAT_IN_PROJECT)
                api.historyThreadIds = ids.toSet()
                api.snapshot = {
                    jsonResponse(
                        """{"url":"${api.server.url("/archive")}","expiresInSeconds":60,"latestEventId":"$CHAT_EVENT","latestSeqId":17}"""
                    )
                }
                api.archive = {
                    jsonResponse(
                        """{"chatThreads":[${ids.joinToString(",") { id -> """{"id":"$id","agentId":"$CHAT_AGENT","title":"History","sortAt":"$CHAT_DATE","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","pinnedAt":null,"archived":false,"hidden":${id == hidden},"renamedAt":null}""" }}]}"""
                    )
                }
                api.events = { jsonResponse("""{"events":[],"hasMore":false}""") }
                api.indicators = {
                    jsonResponse(
                        """{"agents":{},"threads":{"$CHAT_PERSONAL":"active","$CHAT_IN_PROJECT":"active"},"unreadAt":{}}"""
                    )
                }
                val original = api.historyCatchUp
                api.historyCatchUp = { request ->
                    requested = cursors(request).keys
                    original(request)
                }
            }
        ) { ready ->
            assertEquals(recent.sortedDescending().take(100).toSet() + CHAT_IN_PROJECT, requested)
            val model = ready.model
            model.history.open(model.uiState.value.threads.single { it.id == recent.first() })
            val history = model.history.uiState.first { it.phase == HistoryPhase.Ready }
            assertEquals(37L, history.confirmation!!.cursor.seqId)
            assertTrue(history.transcript!!.messages.isNotEmpty())
        }
    }

    @Test
    fun burstsShareOneDeadlineAndDemandDuringAHeldBatchGetsOneTrailingCatchUp() = runTest {
        withModel { ready ->
            val (api, model, realtime) = ready
            val calls = AtomicInteger()
            api.historyCatchUp = {
                calls.incrementAndGet()
                batch(41)
            }
            var revision = model.warming.state.value.revision
            repeat(20) {
                realtime.invalidate(ChatChanges(messageThreads = setOf(CHAT_IN_PROJECT)))
                runCurrent()
            }
            advanceTimeBy(999)
            runCurrent()
            assertEquals(0, calls.get())
            advanceTimeBy(1)
            runCurrent()
            model.warming.state.first { it.revision > revision && it.phase == ChatReadPhase.Ready }
            assertEquals(1, calls.get())
            revision = model.warming.state.value.revision
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            api.historyCatchUp = { request ->
                if (calls.incrementAndGet() == 2) {
                    entered.countDown()
                    release.await()
                    batch(52)
                } else {
                    assertEquals(mapOf(CHAT_IN_PROJECT to 52L), cursors(request))
                    batch(63)
                }
            }
            realtime.invalidate(ChatChanges(messageThreads = setOf(CHAT_IN_PROJECT)))
            advanceTimeBy(1_000)
            runCurrent()
            try {
                assertTrue(entered.await(10, TimeUnit.SECONDS))
                repeat(50) {
                    realtime.invalidate(ChatChanges(messageThreads = setOf(CHAT_IN_PROJECT)))
                }
                runCurrent()
                release.countDown()
                model.warming.state.first {
                    it.revision > revision && it.phase == ChatReadPhase.Ready
                }
                revision = model.warming.state.value.revision
                assertEquals(2, calls.get())
                advanceTimeBy(999)
                runCurrent()
                assertEquals(2, calls.get())
                advanceTimeBy(1)
                runCurrent()
                model.warming.state.first {
                    it.revision > revision && it.phase == ChatReadPhase.Ready
                }
                assertEquals(3, calls.get())
            } finally {
                release.countDown()
            }
        }
    }

    @Test
    fun retiredAuthorizationCannotPublishAHeldBatchIntoTheNextLease() = runTest {
        withModel { ready ->
            val (api, model, realtime) = ready
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            val answered = CountDownLatch(1)
            api.historyCatchUp = {
                entered.countDown()
                release.await()
                answered.countDown()
                batch(71)
            }
            realtime.invalidate(ChatChanges(messageThreads = setOf(CHAT_IN_PROJECT)))
            advanceTimeBy(1_000)
            runCurrent()
            try {
                assertTrue(entered.await(10, TimeUnit.SECONDS))
                ready.allowed.set(false)
                ready.store.clear()
                runCurrent()
                release.countDown()
                assertTrue(answered.await(10, TimeUnit.SECONDS))
                val same = ready.cache.open(api.identity) { true }.loadHistory(CHAT_IN_PROJECT)!!
                assertEquals(37L, same.checkpoint.cursor.seqId)
                val other =
                    ready.cache.open(api.identity.copy(workspaceId = "other-workspace")) { true }
                assertNull(other.loadHistory(CHAT_IN_PROJECT))
            } finally {
                release.countDown()
            }
        }
    }

    @Test
    fun rebuiltSnapshotPublicationChecksTheBaselineAndTheCurrentSelection() = runTest {
        withModel { ready ->
            ready.store.clear()
            val lease = ready.cache.open(ready.api.identity) { true }
            val original = lease.loadHistory(CHAT_IN_PROJECT)!!.checkpoint
            fun checkpoint(seq: Long) =
                original.copy(
                    rows = original.rows + HistoryEvent.decode(event(seq)),
                    cursor =
                        HistoryCursor(
                            "aaaaaaaa-aaaa-4aaa-8aaa-${seq.toString().padStart(12, '0')}",
                            seq,
                        ),
                    replaced = true,
                )
            lease.saveHistory(checkpoint(52), 10)
            lease.saveWarmedHistory(checkpoint(41), 20, original.cursor) { null }
            assertEquals(52L, lease.loadHistory(CHAT_IN_PROJECT)!!.checkpoint.cursor.seqId)
            val expected = checkpoint(52).cursor
            lease.saveWarmedHistory(checkpoint(61), 30, expected) { CHAT_IN_PROJECT }
            assertEquals(52L, lease.loadHistory(CHAT_IN_PROJECT)!!.checkpoint.cursor.seqId)
            lease.saveWarmedHistory(checkpoint(61), 40, expected) { null }
            assertEquals(61L, lease.loadHistory(CHAT_IN_PROJECT)!!.checkpoint.cursor.seqId)
        }
    }

    @Test
    fun canonicalTupleCodecRetainsArrayPositionsAndRejectsTruncatedOrExtendedArrays() {
        val wire = """[["$CHAT_IN_PROJECT",37]]"""
        assertEquals(
            wire,
            historyJson.encodeToString<HistoryCatchUpRequest>(historyJson.decodeFromString(wire)),
        )
        for (invalid in
            listOf("""[["$CHAT_IN_PROJECT"]]""", """[["$CHAT_IN_PROJECT",37,99]]""")) assertThrows(
            SerializationException::class.java
        ) {
            historyJson.decodeFromString<HistoryCatchUpRequest>(invalid)
        }
    }
}
