package ai.okou.android.chat

import ai.okou.android.CHAT_AGENT
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatListApiFixture
import ai.okou.android.HISTORY_RUN
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
class RunControlsModelTest {
    @get:Rule val temporary = TemporaryFolder()
    private val secondRun = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private val automation = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

    private fun eventId(label: String) = UUID.nameUUIDFromBytes(label.toByteArray()).toString()

    private fun thread(id: String = CHAT_PERSONAL) =
        Json.decodeFromString<ChatArchive>(
                """{"chatThreads":[{"id":"$id","agentId":"$CHAT_AGENT","projectId":null,"title":"Thread","sortAt":"$CHAT_DATE","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","pinnedAt":null,"archived":false,"renamedAt":null}]}"""
            )
            .chatThreads
            .single()

    private fun input(
        id: String,
        seq: Long,
        run: String? = HISTORY_RUN,
        type: String = "input.prompt",
    ) =
        historyEventWire(
            if (id.length == 36) id else eventId(id),
            seq,
            type = type,
            payload =
                """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Keep all input"}]}}""",
            run = run,
        )

    private class Remote(api: ChatListApiFixture) {
        val rows = AtomicReference<List<HistoryEvent>>(emptyList())
        val posts = ConcurrentLinkedQueue<JsonObject>()
        val requests = ConcurrentLinkedQueue<RecordedRequest>()
        val failRows = AtomicBoolean()
        @Volatile
        var write: (JsonObject) -> MockResponse = {
            jsonResponse("""{"threadId":"$CHAT_PERSONAL"}""").setResponseCode(201)
        }

        fun set(vararg values: String) {
            rows.set(values.map(HistoryEvent::decode))
        }

        init {
            api.historyRows = { request ->
                if (failRows.get())
                    jsonResponse(
                            """{"error":{"code":"READ_FAILED","message":"Read unavailable"}}"""
                        )
                        .setResponseCode(503)
                else {
                    val id = checkNotNull(request.requestUrl).pathSegments[2]
                    val selected = rows.get().filter { it.threadId == id }
                    val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLong() ?: 0
                    val tail =
                        selected.filter { it.seqId > since }.joinToString(",") { it.archiveJson() }
                    val last = selected.lastOrNull()
                    jsonResponse(
                        """{"rows":[$tail],"cursor":{"lastEventId":${last?.let { "\"${it.id}\"" } ?: "null"},"lastSeqId":${last?.seqId ?: 0}},"hasMore":false}"""
                    )
                }
            }
            api.commandResponse = { request ->
                if (
                    request.method == "POST" &&
                        request.requestUrl?.encodedPath == "/api/chat/events"
                ) {
                    val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                    posts += body
                    requests += request
                    write(body)
                } else null
            }
        }
    }

    private class Fixture(
        val api: ChatListApiFixture,
        val remote: Remote,
        val history: ConversationHistoryModel,
        val controls: RunControlsModel,
        val store: RunControlJournalStore,
        val owners: ViewModelStore,
        val authorized: AtomicBoolean,
        val retired: CompletableDeferred<Unit>,
        val dispatcher: kotlinx.coroutines.CoroutineDispatcher,
        val cache: ChatCacheStore,
    )

    private suspend fun TestScope.withControls(
        directory: File = temporary.newFolder(),
        initial: List<String> = listOf(input("input", 1)),
        saved: RunControlJournal? = null,
        retireOnFailure: Boolean = false,
        block: suspend TestScope.(Fixture) -> Unit,
    ) {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val context = ApplicationProvider.getApplicationContext<TestOkouApplication>()
        val cache = ChatCacheStore(context, temporary.newFolder(), dispatcher)
        val store = RunControlJournalStore(context, directory, dispatcher)
        val owners = ViewModelStore()
        val auth = AtomicBoolean(true)
        val retired = CompletableDeferred<Unit>()
        try {
            ChatListApiFixture().use { api ->
                val remote = Remote(api)
                remote.set(*initial.toTypedArray())
                saved?.let { store.persist(api.identity, it).await() }
                val lease = cache.open(api.identity) { auth.get() }
                val history =
                    ConversationHistoryModel(
                        api.service,
                        lease,
                        backgroundScope,
                        { auth.get() },
                        { throw it },
                        {},
                        dispatcher,
                    )
                try {
                    val controls =
                        ViewModelProvider(
                            owners,
                            viewModelFactory {
                                initializer {
                                    RunControlsModel(
                                        api.service,
                                        store,
                                        api.identity,
                                        history,
                                        { auth.get() },
                                        {
                                            if (!retireOnFailure) throw it
                                            auth.set(false)
                                            owners.clear()
                                            retired.complete(Unit)
                                        },
                                        dispatcher,
                                    )
                                }
                            },
                        )[RunControlsModel::class.java]
                    history.open(thread())
                    history.uiState.first { it.phase == HistoryPhase.Ready }
                    controls.uiState.first { it.persistence == RunControlPersistence.Durable }
                    history.uiState.first { it.detailPhase == ChatReadPhase.Ready }
                    runCurrent()
                    block(
                        Fixture(
                            api,
                            remote,
                            history,
                            controls,
                            store,
                            owners,
                            auth,
                            retired,
                            dispatcher,
                            cache,
                        )
                    )
                } finally {
                    owners.clear()
                    history.close()
                    lease.close()
                }
            }
        } finally {
            store.close()
            cache.close()
            Dispatchers.resetMain()
        }
    }

    private suspend fun Fixture.refresh() {
        val old = history.uiState.value.confirmation?.revision ?: 0
        history.invalidate(CHAT_PERSONAL)
        history.uiState.first {
            it.phase == HistoryPhase.Ready && (it.confirmation?.revision ?: 0) > old
        }
    }

    private class Peer(
        val controls: RunControlsModel,
        val history: ConversationHistoryModel,
        val owners: ViewModelStore,
    )

    private suspend fun TestScope.withPeer(
        fixture: Fixture,
        store: RunControlJournalStore = fixture.store,
        block: suspend TestScope.(Peer) -> Unit,
    ) {
        val lease = fixture.cache.open(fixture.api.identity) { true }
        val history =
            ConversationHistoryModel(
                fixture.api.service,
                lease,
                backgroundScope,
                { true },
                { throw it },
                {},
                fixture.dispatcher,
            )
        val owners = ViewModelStore()
        try {
            val controls =
                ViewModelProvider(
                    owners,
                    viewModelFactory {
                        initializer {
                            RunControlsModel(
                                fixture.api.service,
                                store,
                                fixture.api.identity,
                                history,
                                { true },
                                { throw it },
                                fixture.dispatcher,
                            )
                        }
                    },
                )[RunControlsModel::class.java]
            history.open(thread())
            history.uiState.first { it.phase == HistoryPhase.Ready }
            controls.uiState.first { it.persistence == RunControlPersistence.Durable }
            history.uiState.first { it.detailPhase == ChatReadPhase.Ready }
            runCurrent()
            block(Peer(controls, history, owners))
        } finally {
            owners.clear()
            history.close()
            lease.close()
        }
    }

    @Test
    fun currentControllersPreserveBothUnknownCommandsAfterFreshStoreRestoration() = runTest {
        val directory = temporary.newFolder()
        withControls(
            directory = directory,
            initial = listOf(input("first", 1), input("second", 2, secondRun)),
        ) { f ->
            f.remote.write = {
                jsonResponse("""{"error":{"code":"UNAVAILABLE","message":"Unknown outcome"}}""")
                    .setResponseCode(503)
            }
            val expected = mutableListOf<RunControlIntent>()
            withPeer(f) { peer ->
                assertTrue(f.controls.uiState.value.journal!!.pending.isEmpty())
                assertTrue(peer.controls.uiState.value.journal!!.pending.isEmpty())
                f.controls.stop(CHAT_PERSONAL, listOf(HISTORY_RUN))
                val a =
                    f.controls.uiState
                        .first {
                            it.persistence == RunControlPersistence.Durable &&
                                it.phases.values.singleOrNull() == RunControlPhase.Unknown
                        }
                        .journal!!
                        .pending
                        .single()
                expected += a
                assertEquals(listOf(a), f.store.load(f.api.identity).journal.pending)
                peer.controls.stop(CHAT_PERSONAL, listOf(secondRun))
                val shared =
                    peer.controls.uiState.first {
                        it.journal?.pending?.size == 2 &&
                            it.persistence == RunControlPersistence.Durable &&
                            it.phases.values.all { phase -> phase == RunControlPhase.Unknown }
                    }
                expected += shared.journal!!.pending.single { it.targetId == secondRun }
                assertEquals(expected, shared.journal.pending)
                assertEquals(
                    expected,
                    f.controls.uiState.first { it.journal?.pending?.size == 2 }.journal!!.pending,
                )
                assertEquals(expected, f.store.load(f.api.identity).journal.pending)
                assertEquals(2, f.remote.posts.size)
            }
            f.owners.clear()
            f.store.close()
            val fresh =
                RunControlJournalStore(
                    ApplicationProvider.getApplicationContext(),
                    directory,
                    f.dispatcher,
                )
            try {
                withPeer(f, fresh) { restored ->
                    assertEquals(expected, restored.controls.uiState.value.journal!!.pending)
                    assertTrue(
                        restored.controls.uiState.value.phases.values.all {
                            it == RunControlPhase.Unknown
                        }
                    )
                    runCurrent()
                    assertEquals(2, f.remote.posts.size)
                }
            } finally {
                fresh.close()
            }
        }
    }

    @Test
    fun peerDeduplicatesHeldTargetAndCanRetryItsOriginalCommandAfterInitiatorRetires() = runTest {
        withControls(initial = listOf(input("first", 1), input("second", 2, secondRun))) { f ->
            withPeer(f) { peer ->
                val entered = CompletableDeferred<Unit>()
                val release = CountDownLatch(1)
                val first = AtomicBoolean(true)
                f.remote.write = { body ->
                    if (
                        body["interruptsRunId"]?.jsonPrimitive?.content == HISTORY_RUN &&
                            first.getAndSet(false)
                    ) {
                        entered.complete(Unit)
                        release.await()
                    }
                    jsonResponse("""{"threadId":"$CHAT_PERSONAL"}""").setResponseCode(201)
                }
                try {
                    f.controls.stop(CHAT_PERSONAL, listOf(HISTORY_RUN))
                    entered.await()
                    val a = f.controls.uiState.value.journal!!.pending.single()
                    peer.controls.stop(CHAT_PERSONAL, listOf(HISTORY_RUN, secondRun))
                    peer.controls.uiState.first { state ->
                        state.journal?.pending?.size == 2 &&
                            state.journal.pending
                                .filter { it.targetId == secondRun }
                                .all { state.phases[it.id] == RunControlPhase.Accepted }
                    }
                    assertEquals(2, f.remote.posts.size)
                    assertEquals(
                        1,
                        f.remote.posts.count {
                            it["interruptsRunId"]?.jsonPrimitive?.content == HISTORY_RUN
                        },
                    )
                    f.owners.clear()
                    peer.controls.uiState.first { it.phases[a.id] == RunControlPhase.Unknown }
                    peer.controls.check(CHAT_PERSONAL)
                    peer.controls.uiState.first { it.phases[a.id] == RunControlPhase.Retryable }
                    peer.controls.retry(a.id)
                    peer.controls.retry(a.id)
                    peer.controls.uiState.first { it.phases[a.id] == RunControlPhase.Accepted }
                    assertEquals(3, f.remote.posts.size)
                    val repeated =
                        f.remote.posts.filter {
                            it["interruptsRunId"]?.jsonPrimitive?.content == HISTORY_RUN
                        }
                    assertEquals(2, repeated.size)
                    assertEquals(repeated.first(), repeated.last())
                    assertEquals(a.id, repeated.last()["clientEventId"]?.jsonPrimitive?.content)
                    release.countDown()
                    runCurrent()
                    assertEquals(RunControlPhase.Accepted, peer.controls.uiState.value.phases[a.id])
                    assertEquals(2, f.store.load(f.api.identity).journal.pending.size)
                } finally {
                    release.countDown()
                }
            }
        }
    }

    @Test
    fun oneControllersCanonicalSettlementPreservesThePeersUnknownIntent() = runTest {
        withControls(initial = listOf(input("first", 1), input("second", 2, secondRun))) { f ->
            withPeer(f) { peer ->
                f.remote.write = {
                    jsonResponse("""{"error":{"code":"UNAVAILABLE","message":"Unknown outcome"}}""")
                        .setResponseCode(503)
                }
                f.controls.stop(CHAT_PERSONAL, listOf(HISTORY_RUN))
                val a =
                    f.controls.uiState
                        .first { it.phases.values.singleOrNull() == RunControlPhase.Unknown }
                        .journal!!
                        .pending
                        .single()
                peer.controls.stop(CHAT_PERSONAL, listOf(secondRun))
                val b =
                    peer.controls.uiState
                        .first {
                            it.journal?.pending?.size == 2 &&
                                it.phases.values.all { p -> p == RunControlPhase.Unknown }
                        }
                        .journal!!
                        .pending
                        .single { it.targetId == secondRun }
                f.remote.set(
                    input("first", 1),
                    input("second", 2, secondRun),
                    historyEventWire(
                        eventId("first-settled"),
                        3,
                        type = "run.completed",
                        payload = "null",
                        run = HISTORY_RUN,
                    ),
                )
                peer.controls.check(CHAT_PERSONAL)
                val settled =
                    peer.controls.uiState.first {
                        it.journal?.pending == listOf(b) &&
                            it.persistence == RunControlPersistence.Durable
                    }
                assertFalse(a.id in settled.phases)
                assertEquals(
                    listOf(b),
                    f.controls.uiState.first { it.journal?.pending == listOf(b) }.journal!!.pending,
                )
                assertEquals(listOf(b), f.store.load(f.api.identity).journal.pending)
                assertEquals(2, f.remote.posts.size)
            }
        }
    }

    @Test
    fun retiringAnOutcomeReaderReleasesThePeerWithoutLosingEitherCommand() = runTest {
        val original =
            RunControlIntent(
                eventId("retired-reader"),
                CHAT_PERSONAL,
                CHAT_AGENT,
                RunControlKind.Interrupt,
                HISTORY_RUN,
            )
        withControls(
            initial = listOf(input("first", 1), input("second", 2, secondRun)),
            saved = RunControlJournal(pending = listOf(original)),
        ) { f ->
            withPeer(f) { peer ->
                val entered = CompletableDeferred<Unit>()
                val release = CountDownLatch(1)
                val held = AtomicReference<RecordedRequest>()
                val first = AtomicBoolean(true)
                val rows = f.api.historyRows
                f.api.beforeHistoryResponse = { request ->
                    if (
                        request.requestUrl?.pathSegments?.last() == "event-rows" &&
                            first.getAndSet(false)
                    ) {
                        held.set(request)
                        entered.complete(Unit)
                        release.await()
                    }
                }
                f.api.historyRows = { request ->
                    if (request === held.get())
                        jsonResponse(
                                """{"error":{"code":"UNAVAILABLE","message":"Old read failed"}}"""
                            )
                            .setResponseCode(503)
                    else rows(request)
                }
                try {
                    f.controls.check(CHAT_PERSONAL)
                    entered.await()
                    peer.controls.stop(CHAT_PERSONAL, listOf(secondRun))
                    val newer =
                        peer.controls.uiState
                            .first { state ->
                                state.journal!!.pending.any {
                                    it.targetId == secondRun &&
                                        state.phases[it.id] == RunControlPhase.Accepted
                                }
                            }
                            .journal!!
                            .pending
                            .single { it.targetId == secondRun }
                    f.owners.clear()
                    assertEquals(
                        RunControlPhase.Unknown,
                        peer.controls.uiState.value.phases[original.id],
                    )
                    assertEquals(
                        RunControlPhase.Accepted,
                        peer.controls.uiState.value.phases[newer.id],
                    )
                    peer.controls.check(CHAT_PERSONAL)
                    peer.controls.uiState.first {
                        it.phases[original.id] == RunControlPhase.Retryable
                    }
                    release.countDown()
                    runCurrent()
                    assertEquals(
                        RunControlPhase.Retryable,
                        peer.controls.uiState.value.phases[original.id],
                    )
                    assertEquals(
                        setOf(original, newer),
                        f.store.load(f.api.identity).journal.pending.toSet(),
                    )
                    assertEquals(1, f.remote.posts.size)
                    peer.controls.retry(original.id)
                    peer.controls.uiState.first {
                        it.phases[original.id] == RunControlPhase.Accepted
                    }
                    assertEquals(2, f.remote.posts.size)
                    assertEquals(
                        original.id,
                        f.remote.posts.last()["clientEventId"]?.jsonPrimitive?.content,
                    )
                } finally {
                    release.countDown()
                }
            }
        }
    }

    @Test
    fun sharedCommandsKeepEachControllersSelectedThreadMetadataIndependent() = runTest {
        withControls { f ->
            withPeer(f) { peer ->
                f.api.historyDetail = {
                    jsonResponse(
                            """{"error":{"code":"UNAVAILABLE","message":"Metadata unavailable"}}"""
                        )
                        .setResponseCode(503)
                }
                f.controls.refreshRecovery(CHAT_PERSONAL)
                f.history.uiState.first { it.detailPhase == ChatReadPhase.Failed }
                f.api.historyDetail = {
                    jsonResponse("""{"lastReadAt":null,"cancellationRecoveryPending":true}""")
                }
                peer.history.open(thread(CHAT_IN_PROJECT))
                peer.history.uiState.first {
                    it.thread?.id == CHAT_IN_PROJECT && it.phase == HistoryPhase.Ready
                }
                val metadata =
                    peer.history.uiState.first {
                        it.thread?.id == CHAT_IN_PROJECT && it.detailPhase == ChatReadPhase.Ready
                    }
                assertEquals(true, metadata.detail?.cancellationRecoveryPending)
                val requested = CompletableDeferred<Unit>()
                f.api.historyDetail = {
                    requested.complete(Unit)
                    jsonResponse("""{"lastReadAt":null,"cancellationRecoveryPending":true}""")
                }
                peer.controls.check(CHAT_IN_PROJECT)
                requested.await()
                peer.history.uiState.first { it.detailPhase == ChatReadPhase.Ready }
                f.controls.refreshRecovery(CHAT_IN_PROJECT)
                assertEquals(CHAT_PERSONAL, f.history.uiState.value.thread?.id)
                assertEquals(ChatReadPhase.Failed, f.history.uiState.value.detailPhase)
                assertEquals(CHAT_IN_PROJECT, peer.history.uiState.value.thread?.id)
                assertTrue(f.remote.posts.isEmpty())
                f.api.historyDetail = {
                    jsonResponse("""{"lastReadAt":null,"cancellationRecoveryPending":false}""")
                }
                f.controls.refreshRecovery(CHAT_PERSONAL)
                assertEquals(
                    false,
                    f.history.uiState
                        .first { it.detailPhase == ChatReadPhase.Ready }
                        .detail
                        ?.cancellationRecoveryPending,
                )
                assertEquals(true, peer.history.uiState.value.detail?.cancellationRecoveryPending)
            }
        }
    }

    @Test
    fun completedScopeCancellationBeforeOnClearedLeavesPeerCommandsRecoverable() = runTest {
        val saved =
            RunControlIntent(
                eventId("cancelled-before-cleared"),
                CHAT_PERSONAL,
                CHAT_AGENT,
                RunControlKind.Interrupt,
                HISTORY_RUN,
            )
        for (checking in listOf(false, true)) {
            withControls(
                initial = listOf(input("first", 1), input("second", 2, secondRun)),
                saved = if (checking) RunControlJournal(pending = listOf(saved)) else null,
            ) { f ->
                withPeer(f) { peer ->
                    val entered = CompletableDeferred<Unit>()
                    val release = CountDownLatch(1)
                    val first = AtomicBoolean(true)
                    if (checking)
                        f.api.beforeHistoryResponse = { request ->
                            if (
                                request.requestUrl?.pathSegments?.last() == "event-rows" &&
                                    first.getAndSet(false)
                            ) {
                                entered.complete(Unit)
                                release.await()
                            }
                        }
                    else
                        f.remote.write = {
                            entered.complete(Unit)
                            release.await()
                            jsonResponse("""{"threadId":"$CHAT_PERSONAL"}""").setResponseCode(201)
                        }
                    try {
                        if (checking) f.controls.check(CHAT_PERSONAL)
                        else f.controls.stop(CHAT_PERSONAL, listOf(HISTORY_RUN))
                        entered.await()
                        val intent = peer.controls.uiState.value.journal!!.pending.single()
                        checkNotNull(f.controls.viewModelScope.coroutineContext[Job])
                            .cancelAndJoin()
                        assertEquals(
                            RunControlPhase.Unknown,
                            peer.controls.uiState.value.phases[intent.id],
                        )
                        f.controls.stop(CHAT_PERSONAL, listOf(secondRun))
                        runCurrent()
                        assertEquals(listOf(intent), peer.controls.uiState.value.journal!!.pending)
                        f.owners.clear()
                        release.countDown()
                        peer.controls.check(CHAT_PERSONAL)
                        peer.controls.uiState.first {
                            it.phases[intent.id] == RunControlPhase.Retryable
                        }
                        peer.controls.retry(intent.id)
                        peer.controls.uiState.first {
                            it.phases[intent.id] == RunControlPhase.Accepted
                        }
                        assertEquals(
                            intent.id,
                            f.remote.posts.last()["clientEventId"]?.jsonPrimitive?.content,
                        )
                        assertEquals(listOf(intent), f.store.load(f.api.identity).journal.pending)
                    } finally {
                        release.countDown()
                    }
                }
            }
        }
    }

    @Test
    fun stopSnapshotsAllDisplayedRunsAnd201DoesNotConfirmCompletion() = runTest {
        withControls(initial = listOf(input("first", 1), input("second", 2, secondRun))) { f ->
            val runs = f.history.uiState.value.controlRunIds(f.history.output.state.value)
            f.controls.stop(CHAT_PERSONAL, runs)
            f.controls.stop(CHAT_PERSONAL, runs)
            f.controls.uiState.first {
                it.journal?.pending?.size == 2 &&
                    it.phases.values.all { p -> p == RunControlPhase.Accepted }
            }
            assertEquals(
                setOf(HISTORY_RUN, secondRun),
                f.remote.posts.map { it.getValue("interruptsRunId").jsonPrimitive.content }.toSet(),
            )
            assertEquals(2, f.remote.posts.size)
            assertEquals(
                2,
                f.remote.posts
                    .map { it.getValue("clientEventId").jsonPrimitive.content }
                    .distinct()
                    .size,
            )
            assertTrue(
                f.remote.requests.all { it.getHeader("Authorization") == "Bearer fixture-token" }
            )
            assertTrue(f.remote.posts.none { "prompt" in it || "revokesEventId" in it })
            assertEquals(2, f.store.load(f.api.identity).journal.pending.size)
            assertEquals(HistoryExecution.Running, f.history.uiState.value.transcript?.execution)
        }
    }

    @Test
    fun unknownOutcomeRetryRechecksAndKeepsTheEntireOriginalRequest() = runTest {
        withControls { f ->
            f.remote.write = {
                jsonResponse("""{"error":{"code":"UNAVAILABLE","message":"Unknown after write"}}""")
                    .setResponseCode(503)
            }
            f.controls.stop(CHAT_PERSONAL, listOf(HISTORY_RUN))
            val unknown =
                f.controls.uiState.first {
                    it.phases.values.singleOrNull() == RunControlPhase.Unknown
                }
            val intent = unknown.journal!!.pending.single()
            f.refresh()
            f.controls.check(CHAT_PERSONAL)
            f.controls.uiState.first { it.phases[intent.id] == RunControlPhase.Retryable }
            assertEquals(1, f.remote.posts.size)
            f.remote.write = {
                jsonResponse("""{"threadId":"$CHAT_PERSONAL"}""").setResponseCode(201)
            }
            f.controls.retry(intent.id)
            f.controls.retry(intent.id)
            f.controls.uiState.first { it.phases[intent.id] == RunControlPhase.Accepted }
            assertEquals(2, f.remote.posts.size)
            assertEquals(f.remote.posts.first(), f.remote.posts.last())
        }
    }

    @Test
    fun anotherActorsInterruptSettlesTheTargetWithoutReplayingOurUnknownRequest() = runTest {
        withControls { f ->
            f.controls.stop(CHAT_PERSONAL, listOf(HISTORY_RUN))
            f.controls.uiState.first { it.phases.values.singleOrNull() == RunControlPhase.Accepted }
            f.remote.set(
                input("input", 1),
                historyEventWire(
                    eventId("other-actor"),
                    2,
                    type = "control.interrupt",
                    payload = "null",
                ),
            )
            f.controls.check(CHAT_PERSONAL)
            val done =
                f.controls.uiState.first {
                    it.journal?.pending?.isEmpty() == true && it.notice != null
                }
            assertEquals(RunControlNoticeKind.TargetSettled, done.notice!!.kind)
            assertEquals(1, f.remote.posts.size)
        }
    }

    @Test
    fun supersedingRunAndStaleDisplayedThreadCannotInheritAnOldStop() = runTest {
        withControls { f ->
            f.remote.set(
                input("input", 1),
                historyEventWire(eventId("terminal"), 2, type = "run.completed", payload = "null"),
                input("new", 3, secondRun),
            )
            f.refresh()
            f.controls.stop(CHAT_PERSONAL, listOf(HISTORY_RUN))
            assertTrue(f.remote.posts.isEmpty())
            f.history.open(thread(CHAT_IN_PROJECT))
            f.controls.stop(CHAT_PERSONAL, listOf(secondRun))
            assertTrue(f.remote.posts.isEmpty())
        }
    }

    @Test
    fun retryOfAnOldRunThatEndedCannotStopTheReplacementRun() = runTest {
        withControls { f ->
            f.controls.stop(CHAT_PERSONAL, listOf(HISTORY_RUN))
            val intent =
                f.controls.uiState
                    .first { it.phases.values.singleOrNull() == RunControlPhase.Accepted }
                    .journal!!
                    .pending
                    .single()
            f.refresh()
            f.controls.check(CHAT_PERSONAL)
            f.controls.uiState.first { it.phases[intent.id] == RunControlPhase.Retryable }
            f.remote.set(
                input("input", 1),
                historyEventWire(eventId("end"), 2, type = "run.completed", payload = "null"),
                input("replacement", 3, secondRun),
            )
            f.controls.retry(intent.id)
            f.controls.uiState.first { it.journal?.pending?.isEmpty() == true }
            assertEquals(1, f.remote.posts.size)
        }
    }

    @Test
    fun skipUsesOnlyCanonicalAutomationIdentityIncludingEmptyMessageData() = runTest {
        val manual = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        withControls(
            initial =
                listOf(
                    input("input", 1),
                    input(manual, 2, null),
                    historyEventWire(
                        automation,
                        3,
                        type = "input.automation",
                        payload = "null",
                        run = null,
                    ),
                )
        ) { f ->
            assertEquals(listOf(automation), f.history.uiState.value.transcript?.queuedEventIds)
            f.controls.skip(CHAT_PERSONAL, manual)
            assertTrue(f.remote.posts.isEmpty())
            f.controls.skip(CHAT_PERSONAL, automation)
            f.controls.uiState.first { it.phases.values.singleOrNull() == RunControlPhase.Accepted }
            assertEquals(
                automation,
                f.remote.posts.single().getValue("revokesEventId").jsonPrimitive.content,
            )
            assertFalse("interruptsRunId" in f.remote.posts.single())
            f.remote.set(
                input("input", 1),
                input(manual, 2, null),
                historyEventWire(
                    automation,
                    3,
                    type = "input.automation",
                    payload = "null",
                    run = null,
                ),
                historyEventWire(
                    eventId("consumed"),
                    4,
                    type = "input.automation",
                    payload = "null",
                    run = secondRun,
                    revoke = automation,
                ),
            )
            f.controls.check(CHAT_PERSONAL)
            f.controls.uiState.first { it.journal?.pending?.isEmpty() == true }
            assertEquals(1, f.remote.posts.size)
        }
    }

    @Test
    fun controlReadFailureIsIndependentOfOrdinaryHistoryAndDoesNotPermitRetry() = runTest {
        withControls { f ->
            f.controls.stop(CHAT_PERSONAL, listOf(HISTORY_RUN))
            val intent =
                f.controls.uiState
                    .first { it.phases.values.singleOrNull() == RunControlPhase.Accepted }
                    .journal!!
                    .pending
                    .single()
            f.refresh()
            f.remote.failRows.set(true)
            f.controls.check(CHAT_PERSONAL)
            f.controls.uiState.first { it.notice?.kind == RunControlNoticeKind.ReadFailed }
            assertEquals(RunControlPhase.Unknown, f.controls.uiState.value.phases[intent.id])
            f.remote.failRows.set(false)
            f.controls.retry(intent.id)
            f.refresh()
            assertEquals(HistoryPhase.Ready, f.history.uiState.value.phase)
            assertEquals(1, f.remote.posts.size)
        }
    }

    @Test
    fun outcomeReadFailureDoesNotCancelAnIndependentPendingMetadataQuery() = runTest {
        val intent =
            RunControlIntent(
                eventId("retry-read-failure"),
                CHAT_PERSONAL,
                CHAT_AGENT,
                RunControlKind.Interrupt,
                HISTORY_RUN,
            )
        for (retry in listOf(false, true)) withControls(
            saved = RunControlJournal(pending = listOf(intent))
        ) { f ->
            f.api.historyDetail = {
                jsonResponse("""{"lastReadAt":null,"cancellationRecoveryPending":true}""")
            }
            if (retry) {
                val before = f.history.uiState.value.confirmation!!.revision
                f.controls.check(CHAT_PERSONAL)
                f.controls.uiState.first { it.phases[intent.id] == RunControlPhase.Retryable }
                f.history.uiState.first {
                    it.phase == HistoryPhase.Ready && it.confirmation!!.revision > before
                }
                runCurrent()
                f.controls.refreshRecovery(CHAT_PERSONAL)
                f.history.uiState.first {
                    it.detailPhase == ChatReadPhase.Ready &&
                        it.detail?.cancellationRecoveryPending == true
                }
            }
            val entered = CompletableDeferred<Unit>()
            val release = CountDownLatch(1)
            val first = AtomicBoolean(true)
            f.api.historyDetail = {
                if (first.getAndSet(false)) {
                    entered.complete(Unit)
                    release.await()
                }
                jsonResponse("""{"lastReadAt":null,"cancellationRecoveryPending":true}""")
            }
            try {
                f.controls.refreshRecovery(CHAT_PERSONAL)
                entered.await()
                f.remote.failRows.set(true)
                if (retry) f.controls.retry(intent.id) else f.controls.check(CHAT_PERSONAL)
                val failed =
                    f.controls.uiState.first {
                        if (retry) it.phases[intent.id] == RunControlPhase.Unknown
                        else it.notice?.kind == RunControlNoticeKind.ReadFailed
                    }
                assertEquals(ChatReadPhase.Loading, f.history.uiState.value.detailPhase)
                assertEquals(RunControlPhase.Unknown, failed.phases[intent.id])
                release.countDown()
                val recovered = f.history.uiState.first { it.detailPhase == ChatReadPhase.Ready }
                assertEquals(true, recovered.detail?.cancellationRecoveryPending)
                assertEquals(RunControlPhase.Unknown, f.controls.uiState.value.phases[intent.id])
                assertEquals(listOf(intent), f.controls.uiState.value.journal!!.pending)
                assertTrue(f.remote.posts.isEmpty())
            } finally {
                f.remote.failRows.set(false)
                release.countDown()
            }
        }
    }

    @Test
    fun metadataFailureFinishesWhileOutcomeReadIsPendingAndDoesNotPreventReconciliation() =
        runTest {
            val intent =
                RunControlIntent(
                    eventId("independent-metadata-failure"),
                    CHAT_PERSONAL,
                    CHAT_AGENT,
                    RunControlKind.Interrupt,
                    HISTORY_RUN,
                )
            withControls(saved = RunControlJournal(pending = listOf(intent))) { f ->
                val entered = CompletableDeferred<Unit>()
                val release = CountDownLatch(1)
                val first = AtomicBoolean(true)
                f.api.beforeHistoryResponse = { request ->
                    if (
                        request.requestUrl?.pathSegments?.last() == "event-rows" &&
                            first.getAndSet(false)
                    ) {
                        entered.complete(Unit)
                        release.await()
                    }
                }
                try {
                    f.controls.check(CHAT_PERSONAL)
                    entered.await()
                    f.api.historyDetail = {
                        jsonResponse(
                                """{"error":{"code":"UNAVAILABLE","message":"Metadata unavailable"}}"""
                            )
                            .setResponseCode(503)
                    }
                    f.controls.refreshRecovery(CHAT_PERSONAL)
                    f.history.uiState.first { it.detailPhase == ChatReadPhase.Failed }
                    val failed = f.controls.uiState.value
                    assertEquals(RunControlPhase.Checking, failed.phases[intent.id])
                    assertEquals(listOf(intent), failed.journal!!.pending)
                    f.api.historyDetail = {
                        jsonResponse("""{"lastReadAt":null,"cancellationRecoveryPending":true}""")
                    }
                    release.countDown()
                    f.controls.uiState.first { it.phases[intent.id] == RunControlPhase.Retryable }
                    f.controls.refreshRecovery(CHAT_PERSONAL)
                    f.history.uiState.first { it.detailPhase == ChatReadPhase.Ready }
                    assertTrue(f.remote.posts.isEmpty())
                } finally {
                    release.countDown()
                }
            }
        }

    @Test
    fun newerRecoveryReadSurvivesAnOlderOutcomeReadFailure() = runTest {
        val intent =
            RunControlIntent(
                eventId("older-recovery-read"),
                CHAT_PERSONAL,
                CHAT_AGENT,
                RunControlKind.Interrupt,
                HISTORY_RUN,
            )
        withControls(saved = RunControlJournal(pending = listOf(intent))) { f ->
            val entered = CompletableDeferred<Unit>()
            val release = CountDownLatch(1)
            val firstRead = AtomicBoolean(true)
            f.api.historyDetail = {
                jsonResponse("""{"lastReadAt":null,"cancellationRecoveryPending":true}""")
            }
            f.api.beforeHistoryResponse = { request ->
                if (
                    request.requestUrl?.pathSegments?.last() == "event-rows" &&
                        firstRead.getAndSet(false)
                ) {
                    entered.complete(Unit)
                    release.await()
                }
            }
            try {
                f.controls.check(CHAT_PERSONAL)
                entered.await()
                f.controls.refreshRecovery(CHAT_PERSONAL)
                f.history.uiState.first {
                    it.detailPhase == ChatReadPhase.Ready &&
                        it.detail?.cancellationRecoveryPending == true
                }
                f.remote.failRows.set(true)
                release.countDown()
                val failed =
                    f.controls.uiState.first { it.notice?.kind == RunControlNoticeKind.ReadFailed }
                assertEquals(ChatReadPhase.Ready, f.history.uiState.value.detailPhase)
                assertEquals(true, f.history.uiState.value.detail?.cancellationRecoveryPending)
                assertEquals(RunControlPhase.Unknown, failed.phases[intent.id])
                assertEquals(listOf(intent), failed.journal!!.pending)
                assertTrue(f.remote.posts.isEmpty())
            } finally {
                release.countDown()
            }
        }
    }

    @Test
    fun heldControlReadDoesNotBlockOrdinaryHistoryOrDispatchAnotherWrite() = runTest {
        val intent =
            RunControlIntent(
                eventId("restored-control"),
                CHAT_PERSONAL,
                CHAT_AGENT,
                RunControlKind.Interrupt,
                HISTORY_RUN,
            )
        withControls(saved = RunControlJournal(pending = listOf(intent))) { f ->
            val entered = CompletableDeferred<Unit>()
            val release = CountDownLatch(1)
            val hold = AtomicBoolean(true)
            f.api.beforeHistoryResponse = { request ->
                if (
                    request.requestUrl?.pathSegments?.last() == "event-rows" &&
                        hold.getAndSet(false)
                ) {
                    entered.complete(Unit)
                    release.await()
                }
            }
            try {
                f.controls.check(CHAT_PERSONAL)
                entered.await()
                f.refresh()
                assertEquals(HistoryPhase.Ready, f.history.uiState.value.phase)
                assertEquals(RunControlPhase.Checking, f.controls.uiState.value.phases[intent.id])
                assertEquals(
                    "Keep all input",
                    f.history.uiState.value.transcript!!.messages.single().blocks.single().text,
                )
                assertTrue(f.remote.posts.isEmpty())
            } finally {
                release.countDown()
            }
            f.controls.uiState.first { it.phases[intent.id] == RunControlPhase.Retryable }
        }
    }

    @Test
    fun olderOutcomeReadCannotReplaceANewerCommandsSendingState() = runTest {
        for (readFails in listOf(false, true)) {
            val original =
                RunControlIntent(
                    eventId("original-control"),
                    CHAT_PERSONAL,
                    CHAT_AGENT,
                    RunControlKind.Interrupt,
                    HISTORY_RUN,
                )
            withControls(
                initial = listOf(input("first", 1), input("second", 2, secondRun)),
                saved = RunControlJournal(pending = listOf(original)),
            ) { f ->
                val readEntered = CompletableDeferred<Unit>()
                val releaseRead = CountDownLatch(1)
                val firstRead = AtomicBoolean(true)
                val postEntered = CompletableDeferred<Unit>()
                val releasePost = CountDownLatch(1)
                f.api.beforeHistoryResponse = { request ->
                    if (
                        request.requestUrl?.pathSegments?.last() == "event-rows" &&
                            firstRead.getAndSet(false)
                    ) {
                        readEntered.complete(Unit)
                        releaseRead.await()
                    }
                }
                f.remote.write = {
                    postEntered.complete(Unit)
                    releasePost.await()
                    jsonResponse("""{"threadId":"$CHAT_PERSONAL"}""").setResponseCode(201)
                }
                try {
                    f.controls.check(CHAT_PERSONAL)
                    readEntered.await()
                    f.controls.stop(CHAT_PERSONAL, listOf(secondRun))
                    postEntered.await()
                    val newer =
                        f.controls.uiState.value.journal!!.pending.single {
                            it.targetId == secondRun
                        }
                    assertEquals(RunControlPhase.Sending, f.controls.uiState.value.phases[newer.id])
                    f.remote.failRows.set(readFails)
                    releaseRead.countDown()
                    val checked =
                        f.controls.uiState.first {
                            if (readFails) it.notice?.kind == RunControlNoticeKind.ReadFailed
                            else it.phases[original.id] == RunControlPhase.Retryable
                        }
                    assertEquals(RunControlPhase.Sending, checked.phases[newer.id])
                    assertEquals(1, f.remote.posts.size)
                    f.remote.failRows.set(false)
                    releasePost.countDown()
                    f.controls.uiState.first { it.phases[newer.id] == RunControlPhase.Accepted }
                } finally {
                    f.remote.failRows.set(false)
                    releaseRead.countDown()
                    releasePost.countDown()
                }
            }
        }
    }

    @Test
    fun unauthorizedReadRetiresItsOwnerBeforePublishingAnyFailureState() = runTest {
        val intent =
            RunControlIntent(
                eventId("unauthorized-control"),
                CHAT_PERSONAL,
                CHAT_AGENT,
                RunControlKind.Interrupt,
                HISTORY_RUN,
            )
        withControls(saved = RunControlJournal(pending = listOf(intent)), retireOnFailure = true) {
            f ->
            f.api.historyRows = {
                jsonResponse("""{"error":{"code":"UNAUTHENTICATED","message":"Session expired"}}""")
                    .setResponseCode(401)
            }
            f.controls.check(CHAT_PERSONAL)
            val before = f.controls.uiState.value
            f.retired.await()
            runCurrent()
            assertEquals(
                before.copy(phases = before.phases.mapValues { RunControlPhase.Unknown }),
                f.controls.uiState.value,
            )
            assertTrue(f.remote.posts.isEmpty())
        }
    }

    @Test
    fun diskFailureRetainsIntentAndNeverPostsAnUndurableCommand() = runTest {
        withControls(directory = temporary.newFile()) { f ->
            f.controls.stop(CHAT_PERSONAL, listOf(HISTORY_RUN))
            val failed = f.controls.uiState.first { it.persistence == RunControlPersistence.Failed }
            assertEquals(1, failed.journal!!.pending.size)
            assertFalse(f.store.load(f.api.identity).durable)
            assertTrue(f.remote.posts.isEmpty())
        }
    }

    @Test
    fun unversionedJournalCannotRestoreAsEmptyIntentOrEnableAnotherCommand() = runTest {
        val directory = temporary.newFolder()
        val intent =
            RunControlIntent(
                eventId("unreadable-control"),
                CHAT_PERSONAL,
                CHAT_AGENT,
                RunControlKind.Interrupt,
                HISTORY_RUN,
            )
        withControls(directory = directory, saved = RunControlJournal(pending = listOf(intent))) { f
            ->
            f.owners.clear()
            f.store.close()
            checkNotNull(directory.listFiles()).single { it.extension == "json" }.writeText("{}")
            val store =
                RunControlJournalStore(
                    ApplicationProvider.getApplicationContext(),
                    directory,
                    f.dispatcher,
                )
            val owners = ViewModelStore()
            try {
                val restored =
                    ViewModelProvider(
                        owners,
                        viewModelFactory {
                            initializer {
                                RunControlsModel(
                                    f.api.service,
                                    store,
                                    f.api.identity,
                                    f.history,
                                    { true },
                                    { throw it },
                                    f.dispatcher,
                                )
                            }
                        },
                    )[RunControlsModel::class.java]
                val state =
                    restored.uiState.first { it.persistence != RunControlPersistence.Loading }
                assertEquals(RunControlPersistence.Failed, state.persistence)
                assertNull(state.journal)
                assertEquals(HistoryPhase.Ready, f.history.uiState.value.phase)
                restored.stop(CHAT_PERSONAL, listOf(HISTORY_RUN))
                runCurrent()
                assertTrue(f.remote.posts.isEmpty())
            } finally {
                owners.clear()
                store.close()
            }
        }
    }

    @Test
    fun restoredIntentKeepsItsIdAndQueriesWithoutAutomaticDispatch() = runTest {
        val directory = temporary.newFolder()
        withControls(directory = directory) { f ->
            f.controls.stop(CHAT_PERSONAL, listOf(HISTORY_RUN))
            val intent =
                f.controls.uiState
                    .first { it.phases.values.singleOrNull() == RunControlPhase.Accepted }
                    .journal!!
                    .pending
                    .single()
            f.owners.clear()
            f.store.close()
            val restoredStore =
                RunControlJournalStore(
                    ApplicationProvider.getApplicationContext(),
                    directory,
                    f.dispatcher,
                )
            val restoredOwners = ViewModelStore()
            try {
                val restored =
                    ViewModelProvider(
                        restoredOwners,
                        viewModelFactory {
                            initializer {
                                RunControlsModel(
                                    f.api.service,
                                    restoredStore,
                                    f.api.identity,
                                    f.history,
                                    { true },
                                    { throw it },
                                    f.dispatcher,
                                )
                            }
                        },
                    )[RunControlsModel::class.java]
                val state =
                    restored.uiState.first { it.persistence == RunControlPersistence.Durable }
                assertEquals(listOf(intent), state.journal!!.pending)
                assertEquals(RunControlPhase.Unknown, state.phases[intent.id])
                runCurrent()
                assertEquals(1, f.remote.posts.size)
                restored.check(CHAT_PERSONAL)
                restored.uiState.first { it.phases[intent.id] == RunControlPhase.Retryable }
                assertEquals(1, f.remote.posts.size)
                assertTrue(
                    restoredStore
                        .load(f.api.identity.copy(userId = "another-member"))
                        .journal
                        .pending
                        .isEmpty()
                )
            } finally {
                restoredOwners.clear()
                restoredStore.close()
            }
        }
    }

    @Test
    fun retiredAuthorizationCannotPublishALateAcceptanceOrIssueAnotherControl() = runTest {
        withControls { f ->
            val entered = CompletableDeferred<Unit>()
            val release = CountDownLatch(1)
            f.remote.write = {
                entered.complete(Unit)
                release.await()
                jsonResponse("""{"threadId":"$CHAT_PERSONAL"}""").setResponseCode(201)
            }
            try {
                f.controls.stop(CHAT_PERSONAL, listOf(HISTORY_RUN))
                entered.await()
                val before = f.controls.uiState.value
                f.authorized.set(false)
                f.owners.clear()
                release.countDown()
                runCurrent()
                f.controls.stop(CHAT_PERSONAL, listOf(HISTORY_RUN))
                assertEquals(
                    before.copy(phases = before.phases.mapValues { RunControlPhase.Unknown }),
                    f.controls.uiState.value,
                )
                assertEquals(1, f.remote.posts.size)
                assertEquals(1, f.store.load(f.api.identity).journal.pending.size)
            } finally {
                release.countDown()
            }
        }
    }
}
