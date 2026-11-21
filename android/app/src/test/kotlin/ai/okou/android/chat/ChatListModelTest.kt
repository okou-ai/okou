package ai.okou.android.chat

import ai.okou.android.CHAT_AGENT
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_EVENT
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.HISTORY_LAST_EVENT
import ai.okou.android.TestChatService
import ai.okou.android.TestOkouApplication
import ai.okou.android.TestRealtimeService
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.Agents
import ai.okou.android.api.generated.AgentsItem
import ai.okou.android.api.generated.AgentsItemVisibility
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.ChatSnapshot
import ai.okou.android.api.generated.ChatSnapshotVariant1
import ai.okou.android.api.generated.Indicators
import ai.okou.android.api.generated.IndicatorsThreadsValue
import ai.okou.android.api.generated.ProjectArchive
import ai.okou.android.api.generated.ProjectEvents
import ai.okou.android.api.generated.ProjectEventsEventsItem
import ai.okou.android.api.generated.ProjectEventsEventsItemKind
import ai.okou.android.api.generated.ProjectSnapshot
import ai.okou.android.api.generated.ProjectSnapshotVariant1
import ai.okou.android.api.generated.ProjectSnapshotVariant1ProjectsItem
import ai.okou.android.api.generated.ReadState
import ai.okou.android.api.generated.SendRequestVariant1
import ai.okou.android.api.generated.ThreadDetail
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.chatEventWire
import ai.okou.android.historyEventWire
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import org.junit.After
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
class ChatListModelTest {
    @get:Rule val temporary = TemporaryFolder()
    private val caches = mutableListOf<ChatCacheStore>()

    private fun cache(directory: File, dispatcher: CoroutineDispatcher = Dispatchers.IO) =
        ChatCacheStore(ApplicationProvider.getApplicationContext(), directory, dispatcher).also {
            caches += it
        }

    @After fun closeCaches() = runBlocking { caches.forEach { it.close() } }

    private fun execute(root: File, sql: String) {
        BundledSQLiteDriver().open(root.resolve("chats.db").path).use { connection ->
            connection.prepare(sql).use { it.step() }
        }
    }

    private val identity =
        WorkspaceIdentity("https://api.okou.ai/", "user-a", "session-a", "org-a", "member")
    private val json = Json { ignoreUnknownKeys = true }

    private fun page(seq: Long = 17) =
        json.decodeFromString<ChatEvents>(
            """{"events":[${chatEventWire(seq = seq)}],"hasMore":false}"""
        )

    private fun page(events: List<String>) =
        json.decodeFromString<ChatEvents>(
            """{"events":[${events.joinToString(",")}],"hasMore":false}"""
        )

    private open inner class Service : TestChatService() {
        var agentRead: suspend () -> Agents = {
            listOf(
                AgentsItem(
                    CHAT_AGENT,
                    true,
                    "user-a",
                    null,
                    "My Okou",
                    null,
                    null,
                    AgentsItemVisibility.PRIVATE,
                )
            )
        }
        var listRead: suspend () -> ChatEvents = { page() }
        var statusRead: suspend () -> Indicators = {
            Indicators(
                emptyMap(),
                mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                emptyMap(),
            )
        }

        override suspend fun chatSnapshot() =
            json.decodeFromString<ChatSnapshot>(
                """{"chatThreads":[],"latestEventId":null,"latestSeqId":null}"""
            )

        override suspend fun chatEvents(since: Long?) = listRead()

        override suspend fun agents() = agentRead()

        override suspend fun indicators() = statusRead()
    }

    private inner class ArchiveService : Service() {
        private val events =
            mutableListOf(
                17L to chatEventWire(),
                18L to
                    chatEventWire(
                        id = "77777777-7777-4777-8777-777777777777",
                        seq = 18,
                        thread = CHAT_IN_PROJECT,
                        title = "Second chat",
                    ),
            )
        var beforeArchive: suspend (String) -> Unit = {}
        var beforeUnarchive: suspend () -> Unit = {}
        var beforeEvents: suspend () -> Unit = {}

        override suspend fun chatEvents(since: Long?): ChatEvents {
            beforeEvents()
            return page(events.filter { it.first > (since ?: 0) }.map { it.second })
        }

        override suspend fun setArchived(threadId: String, archived: Boolean, eventId: String) {
            if (archived) beforeArchive(threadId) else beforeUnarchive()
            val seq = events.last().first + 1
            events.add(
                seq to
                    chatEventWire(
                        id = eventId,
                        seq = seq,
                        thread = threadId,
                        kind = if (archived) "archived" else "unarchived",
                    )
            )
        }
    }

    private suspend fun TestScope.withCatchUpModel(
        service: ChatListService,
        realtime: TestRealtimeService? = null,
        connectivity: MutableStateFlow<Boolean> = MutableStateFlow(true),
        authorized: () -> Boolean = { true },
        chatCache: ChatCacheStore? = null,
        exercise: suspend (ChatListModel) -> Unit,
    ) {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val store = ViewModelStore()
        try {
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            ChatListModel(
                                service,
                                chatCache ?: cache(temporary.newFolder(), dispatcher),
                                identity,
                                authorized,
                                {},
                                dispatcher,
                                realtime,
                                monotonicMillis = { testScheduler.currentTime },
                                connectivity = connectivity,
                            )
                        }
                    },
                )[ChatListModel::class.java]
            exercise(model)
        } finally {
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    private fun unreadModel(
        store: ViewModelStore,
        cache: ChatCacheStore,
        service: Service,
        dispatcher: CoroutineDispatcher,
        wallMillis: () -> Long,
    ) =
        ViewModelProvider(
            store,
            viewModelFactory {
                initializer {
                    ChatListModel(
                        service,
                        cache,
                        identity,
                        { true },
                        {},
                        dispatcher,
                        wallMillis = wallMillis,
                    )
                }
            },
        )[ChatListModel::class.java]

    @Test
    fun relaunchRestoresUnreadAndAnInFlightRefreshCannotUndoALocalRead() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val root = temporary.newFolder()
        val originalStore = ViewModelStore()
        val relaunchedStore = ViewModelStore()
        val initial =
            Indicators(
                emptyMap(),
                mapOf(
                    CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD,
                    CHAT_IN_PROJECT to IndicatorsThreadsValue.ACTIVE,
                ),
                mapOf(CHAT_PERSONAL to CHAT_DATE),
            )
        val stale = CompletableDeferred<Indicators>()
        val readback = CompletableDeferred<Indicators>()
        var indicatorReads = 0
        var readWrites = 0
        val service =
            object : Service() {
                    override suspend fun markRead(threadId: String): ReadState {
                        assertEquals(CHAT_PERSONAL, threadId)
                        readWrites++
                        return ReadState(CHAT_DATE)
                    }
                }
                .apply {
                    statusRead = {
                        when (++indicatorReads) {
                            1 -> initial
                            2 -> stale.await()
                            else -> readback.await()
                        }
                    }
                }
        try {
            val cache = cache(root, dispatcher)
            val original = unreadModel(originalStore, cache, service, dispatcher) { 1_000_000L }
            original.refresh()
            runCurrent()
            assertEquals(initial, original.uiState.value.indicators)
            originalStore.clear()
            runCurrent()
            cache.close()

            val relaunched =
                unreadModel(relaunchedStore, cache(root, dispatcher), service, dispatcher) {
                    1_010_000L
                }
            relaunched.refresh()
            relaunched.selectFilter(ChatListFilter.Unread)
            runCurrent()
            val restored = relaunched.uiState.value
            assertEquals(ChatReadPhase.Loading, restored.indicatorsPhase)
            assertNull(restored.indicators)
            assertEquals(setOf(CHAT_PERSONAL), restored.unreadChatIds())
            assertEquals(
                listOf(CHAT_PERSONAL),
                chatListGroups(restored).flatMap { it.threads }.map { it.id },
            )
            assertTrue(restored.markAllReadTargets().isEmpty())

            relaunched.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkRead)
            runCurrent()
            assertEquals(1, readWrites)
            assertFalse(relaunched.uiState.value.isUnread(CHAT_PERSONAL))
            stale.complete(initial)
            runCurrent()
            assertFalse(relaunched.uiState.value.isUnread(CHAT_PERSONAL))
            assertEquals(3, indicatorReads)

            val newer = "2099-01-01T00:00:00.000Z"
            readback.complete(initial.copy(unreadAt = mapOf(CHAT_PERSONAL to newer)))
            runCurrent()
            assertEquals(newer, relaunched.uiState.value.displayUnreadAt?.get(CHAT_PERSONAL))
            assertTrue(relaunched.uiState.value.isUnread(CHAT_PERSONAL))
            assertTrue(relaunched.uiState.value.readIntents.isEmpty())
            assertNull(relaunched.uiState.value.cachedUnread)
        } finally {
            originalStore.clear()
            relaunchedStore.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun unreadSnapshotExpiresDuringFailedRefreshAndIsUnknownOnTheNextLaunch() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val cache = cache(temporary.newFolder(), dispatcher)
        val first = ViewModelStore()
        val next = ViewModelStore()
        val confirmedAt = 1_000_000L
        val unread = mapOf(CHAT_PERSONAL to CHAT_DATE)
        val service = Service().apply { statusRead = { throw IOException("offline") } }
        val wallMillis = { confirmedAt + 119_990L + testScheduler.currentTime }
        try {
            cache
                .open(identity) { true }
                .use { assertTrue(it.saveUnread(CachedUnread(confirmedAt, unread))) }
            val model = unreadModel(first, cache, service, dispatcher, wallMillis)
            model.refresh()
            runCurrent()
            assertEquals(ChatReadPhase.Failed, model.uiState.value.indicatorsPhase)
            assertEquals(unread, model.uiState.value.displayUnreadAt)

            advanceTimeBy(10)
            runCurrent()
            assertNull(model.uiState.value.displayUnreadAt)
            first.clear()
            val relaunched = unreadModel(next, cache, service, dispatcher, wallMillis)
            relaunched.refresh()
            runCurrent()
            assertEquals(ChatReadPhase.Failed, relaunched.uiState.value.indicatorsPhase)
            assertNull(relaunched.uiState.value.displayUnreadAt)

            service.statusRead = { Indicators(emptyMap(), emptyMap(), emptyMap()) }
            relaunched.refreshIndicators()
            runCurrent()
            assertEquals(ChatReadPhase.Ready, relaunched.uiState.value.indicatorsPhase)
            assertEquals(emptyMap<String, String>(), relaunched.uiState.value.displayUnreadAt)
        } finally {
            first.clear()
            next.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun refreshDropsExpiredUnreadWhenOnlyWallTimeHasAdvanced() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val cache = cache(temporary.newFolder(), dispatcher)
        val store = ViewModelStore()
        var now = 1_000_000L
        val unread = mapOf(CHAT_PERSONAL to CHAT_DATE)
        val indicators = CompletableDeferred<Indicators>()
        val service = Service().apply { statusRead = { indicators.await() } }
        try {
            cache
                .open(identity) { true }
                .use { assertTrue(it.saveUnread(CachedUnread(now, unread))) }
            val model = unreadModel(store, cache, service, dispatcher) { now }
            model.refresh()
            runCurrent()
            assertEquals(unread, model.uiState.value.displayUnreadAt)

            // Device sleep advances wall time without running the scheduled timeout.
            now += 120_000L
            model.refresh()
            runCurrent()
            assertEquals(ChatReadPhase.Loading, model.uiState.value.indicatorsPhase)
            assertNull(model.uiState.value.displayUnreadAt)
        } finally {
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun aLaterRejectedArchiveDoesNotHideAnEarlierConfirmedUndo() = runTest {
        val firstArchive = CompletableDeferred<Unit>()
        val secondArchive = CompletableDeferred<Unit>()
        val indicators = CompletableDeferred<Indicators>()
        val source = ArchiveService()
        source.beforeArchive = { threadId ->
            if (threadId == CHAT_IN_PROJECT) {
                secondArchive.await()
                throw ApiFailure.Http(400, null, null, null)
            }
            firstArchive.await()
        }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            source.statusRead = { indicators.await() }
            model.performRowAction(CHAT_PERSONAL, ChatRowAction.Archive)
            model.performRowAction(CHAT_IN_PROJECT, ChatRowAction.Archive)
            runCurrent()
            firstArchive.complete(Unit)
            advanceUntilIdle()
            val undo = model.uiState.value.rowUndo
            assertEquals(ChatReadPhase.Loading, model.uiState.value.indicatorsPhase)
            assertEquals(CHAT_PERSONAL, undo?.threadId)

            secondArchive.complete(Unit)
            advanceUntilIdle()
            assertSame(undo, model.uiState.value.rowUndo)
            assertTrue(model.uiState.value.threads.single { it.id == CHAT_PERSONAL }.archived)
            assertFalse(model.uiState.value.threads.single { it.id == CHAT_IN_PROJECT }.archived)

            model.undoRowAction(checkNotNull(undo))
            advanceUntilIdle()
            assertFalse(model.uiState.value.threads.single { it.id == CHAT_PERSONAL }.archived)
            assertNull(model.uiState.value.rowUndo)
            indicators.complete(Indicators(emptyMap(), emptyMap(), emptyMap()))
            advanceUntilIdle()
        }
    }

    @Test
    fun archiveUndoWaitsForTheNetworkAndDistinguishesRejectionFromAnUnknownResult() = runTest {
        for (error in
            listOf(ApiFailure.Http(403, null, null, null), IOException("Lost response"))) {
            val connectivity = MutableStateFlow(true)
            val source = ArchiveService()
            val release = CompletableDeferred<Unit>()
            var inverseWrites = 0
            source.beforeUnarchive = {
                inverseWrites++
                release.await()
                throw error
            }
            withCatchUpModel(source, connectivity = connectivity) { model ->
                model.refresh()
                advanceUntilIdle()
                assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.Archive))
                advanceUntilIdle()
                val offer = checkNotNull(model.uiState.value.rowUndo)

                connectivity.value = false
                runCurrent()
                model.undoRowAction(offer)
                runCurrent()
                assertSame(offer, model.uiState.value.rowUndo)
                assertEquals(0, inverseWrites)

                connectivity.value = true
                advanceUntilIdle()
                assertSame(offer, model.uiState.value.rowUndo)
                assertEquals(0, inverseWrites)
                model.undoRowAction(offer)
                runCurrent()
                val checking = checkNotNull(model.uiState.value.rowUndo)
                assertEquals(ChatUndoPhase.Checking, checking.phase)
                assertEquals(offer.sequence, checking.sequence)
                model.undoRowAction(offer)
                model.undoRowAction(checking)
                assertEquals(1, inverseWrites)

                val rejected = error is ApiFailure.Http
                val readback = CompletableDeferred<Unit>()
                if (rejected) {
                    source.beforeEvents = {
                        readback.await()
                        throw IOException("Readback unavailable")
                    }
                }
                release.complete(Unit)
                if (rejected) {
                    runCurrent()
                    val state = model.uiState.value
                    assertEquals(ChatUndoPhase.Failed, state.rowUndo?.phase)
                    assertTrue(state.threads.single { it.id == CHAT_PERSONAL }.archived)
                    assertTrue(state.pendingRowActions.isEmpty())
                    readback.complete(Unit)
                }
                advanceUntilIdle()
                val state = model.uiState.value
                assertEquals(
                    if (rejected) ChatUndoPhase.Failed else ChatUndoPhase.Unconfirmed,
                    state.rowUndo?.phase,
                )
                if (rejected) assertTrue(state.threads.single { it.id == CHAT_PERSONAL }.archived)
                assertNull(state.failedRowAction)
                assertTrue(state.pendingRowActions.isEmpty())
                assertEquals(1, inverseWrites)
            }
        }
    }

    @Test
    fun aDefinitiveUnreadUndoSettlesWhileIndicatorsAreStillRefreshing() = runTest {
        val unread =
            Indicators(
                emptyMap(),
                mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                mapOf(CHAT_PERSONAL to CHAT_DATE),
            )
        val read = Indicators(emptyMap(), emptyMap(), emptyMap())
        for (rejected in listOf(false, true)) {
            val receipt = CompletableDeferred<ReadState>()
            val readback = CompletableDeferred<Indicators>()
            val source =
                object : Service() {
                        override suspend fun markRead(threadId: String) = ReadState(CHAT_DATE)

                        override suspend fun markUnread(threadId: String) = receipt.await()
                    }
                    .apply { statusRead = { unread } }
            withCatchUpModel(source) { model ->
                model.refresh()
                advanceUntilIdle()
                model.selectFilter(ChatListFilter.Unread)
                source.statusRead = { read }
                assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkRead))
                advanceUntilIdle()
                val offer = checkNotNull(model.uiState.value.rowUndo)
                source.statusRead = { readback.await() }
                model.undoRowAction(offer)
                runCurrent()
                assertEquals(ChatUndoPhase.Checking, model.uiState.value.rowUndo?.phase)

                if (rejected) receipt.completeExceptionally(ApiFailure.Http(403, null, null, null))
                else receipt.complete(ReadState(null))
                runCurrent()
                val settled = model.uiState.value
                assertEquals(ChatReadPhase.Loading, settled.indicatorsPhase)
                assertEquals(if (rejected) ChatUndoPhase.Failed else null, settled.rowUndo?.phase)
                assertFalse(CHAT_PERSONAL in settled.pendingRowActions)
                assertEquals(!rejected, settled.isUnread(CHAT_PERSONAL))

                readback.complete(if (rejected) read else unread)
                advanceUntilIdle()
                assertEquals(!rejected, model.uiState.value.isUnread(CHAT_PERSONAL))
            }
        }
    }

    @Test
    fun reconnectingBeforeAnUndoCanSendStillRequiresAnotherPress() = runTest {
        val connectivity = MutableStateFlow(true)
        val displayedRead = CompletableDeferred<Unit>()
        val unread =
            Indicators(
                emptyMap(),
                mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                mapOf(CHAT_PERSONAL to CHAT_DATE),
            )
        var latestReply = HistoryCursor(HISTORY_LAST_EVENT, 37)
        var reads = 0
        var inverseWrites = 0
        val source =
            object : Service() {
                    override suspend fun historySnapshot(threadId: String): Nothing =
                        throw ApiFailure.Http(404, "CHAT_EVENT_SNAPSHOT_NOT_FOUND", null, null)

                    override suspend fun historyRows(threadId: String, cursor: HistoryCursor) =
                        if (latestReply.seqId <= cursor.seqId)
                            HistoryPage(emptyList(), cursor, false)
                        else {
                            val event =
                                HistoryEvent.decode(
                                    historyEventWire(
                                        checkNotNull(latestReply.eventId),
                                        latestReply.seqId,
                                    )
                                )
                            HistoryPage(listOf(event), latestReply, false)
                        }

                    override suspend fun threadDetail(threadId: String) = ThreadDetail(null, false)

                    override suspend fun markRead(threadId: String): ReadState {
                        if (++reads == 2) displayedRead.await()
                        return ReadState(CHAT_DATE)
                    }

                    override suspend fun markUnread(threadId: String): ReadState {
                        inverseWrites++
                        return ReadState(null)
                    }
                }
                .apply { statusRead = { unread } }
        withCatchUpModel(source, connectivity = connectivity) { model ->
            model.refresh()
            advanceUntilIdle()
            model.selectFilter(ChatListFilter.Unread)
            source.statusRead = { Indicators(emptyMap(), emptyMap(), emptyMap()) }
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkRead))
            advanceUntilIdle()
            val offer = checkNotNull(model.uiState.value.rowUndo)
            val history = model.history
            history.open(model.uiState.value.threads.single())
            val visit =
                checkNotNull(history.beginVisit(CHAT_PERSONAL, history.uiState.value.generation))
            advanceUntilIdle()
            visit.confirmDisplayed(checkNotNull(history.uiState.value.confirmation))
            runCurrent()
            assertEquals(HistoryReadState.Pending, visit.readState.value)

            model.undoRowAction(offer)
            runCurrent()
            assertEquals(ChatUndoPhase.Checking, model.uiState.value.rowUndo?.phase)
            connectivity.value = false
            runCurrent()
            assertTrue(model.uiState.value.offline)
            connectivity.value = true
            runCurrent()
            assertFalse(model.uiState.value.offline)
            displayedRead.complete(Unit)
            advanceUntilIdle()
            assertSame(offer, model.uiState.value.rowUndo)
            assertEquals(0, inverseWrites)

            latestReply = HistoryCursor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 38)
            history.refresh()
            advanceUntilIdle()
            visit.confirmDisplayed(checkNotNull(history.uiState.value.confirmation))
            advanceUntilIdle()
            assertEquals(3, reads)
            assertEquals(0, inverseWrites)

            model.undoRowAction(offer)
            advanceUntilIdle()
            assertEquals(1, inverseWrites)
            assertNull(model.uiState.value.rowUndo)
        }
    }

    @Test
    fun anEarlierArchiveConfirmingLateKeepsTheNewerUndo() = runTest {
        val firstArchive = CompletableDeferred<Unit>()
        val source = ArchiveService()
        source.beforeArchive = { if (it == CHAT_PERSONAL) firstArchive.await() }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            model.performRowAction(CHAT_PERSONAL, ChatRowAction.Archive)
            model.performRowAction(CHAT_IN_PROJECT, ChatRowAction.Archive)
            advanceUntilIdle()
            val undo = model.uiState.value.rowUndo
            assertEquals(CHAT_IN_PROJECT, undo?.threadId)

            firstArchive.complete(Unit)
            advanceUntilIdle()
            assertTrue(model.uiState.value.threads.all { it.archived })
            assertSame(undo, model.uiState.value.rowUndo)

            model.undoRowAction(checkNotNull(undo))
            advanceUntilIdle()
            val archived = model.uiState.value.threads.filter { it.archived }
            assertEquals(listOf(CHAT_PERSONAL), archived.map { it.id })
        }
    }

    @Test
    fun deleteReconcilesExplicitRejectionLostResponseAndConcurrentDeletion() = runTest {
        for (status in listOf(400, 404, null)) {
            var deletion: String? = null
            val source =
                object : Service() {
                    override suspend fun chatEvents(since: Long?) =
                        when {
                            since == null -> page()
                            since < 18 -> page(listOfNotNull(deletion))
                            else -> page(emptyList())
                        }

                    override suspend fun deleteThread(threadId: String, eventId: String) {
                        if (status != 400) {
                            deletion =
                                chatEventWire(
                                    id =
                                        if (status == 404) "77777777-7777-4777-8777-777777777777"
                                        else eventId,
                                    seq = 18,
                                    thread = threadId,
                                    kind = "deleted",
                                )
                        }
                        if (status == null) throw IOException("Unavailable response")
                        throw ApiFailure.Http(status, null, null, null)
                    }
                }
            withCatchUpModel(source) { model ->
                model.refresh()
                advanceUntilIdle()
                model.performRowAction(CHAT_PERSONAL, ChatRowAction.Delete)
                advanceUntilIdle()
                val state = model.uiState.value
                assertTrue(state.pendingRowActions.isEmpty())
                assertNull(state.rowUndo)
                if (status == 400) {
                    assertEquals(CHAT_PERSONAL, state.threads.single().id)
                    assertEquals(ChatRowAction.Delete, state.failedRowAction?.action)
                    assertTrue(checkNotNull(state.failedRowAction).rejected)
                } else {
                    assertTrue(state.threads.isEmpty())
                    assertNull(state.failedRowAction)
                    model.refresh()
                    advanceUntilIdle()
                    assertTrue(model.uiState.value.threads.isEmpty())
                }
            }
        }
    }

    @Test
    fun rejectedDeleteRestoresTheRowWhileRefreshIsHeldAndLeavesOtherActionsUsable() = runTest {
        val refresh = CompletableDeferred<Unit>()
        val rejection = CompletableDeferred<Unit>()
        val events =
            mutableListOf(
                chatEventWire(),
                chatEventWire(id = HISTORY_LAST_EVENT, seq = 18, thread = CHAT_IN_PROJECT),
            )
        var reads = 0
        val source =
            object : Service() {
                override suspend fun chatEvents(since: Long?): ChatEvents {
                    if (since != null && ++reads == 1) {
                        refresh.await()
                        throw ApiFailure.Network(IOException("Unavailable list"))
                    }
                    return page(events)
                }

                override suspend fun deleteThread(threadId: String, eventId: String) {
                    rejection.await()
                    throw ApiFailure.Http(400, null, null, null)
                }

                override suspend fun setArchived(
                    threadId: String,
                    archived: Boolean,
                    eventId: String,
                ) {
                    events.add(
                        chatEventWire(id = eventId, seq = 19, thread = threadId, kind = "archived")
                    )
                }
            }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            model.refreshList()
            runCurrent()
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.Delete))
            runCurrent()
            assertTrue(model.uiState.value.threads.single { it.id == CHAT_PERSONAL }.hidden == true)

            rejection.complete(Unit)
            runCurrent()
            val rolledBack = model.uiState.value
            assertEquals(ChatReadPhase.Loading, rolledBack.listPhase)
            assertTrue(rolledBack.pendingRowActions.isEmpty())
            assertEquals(ChatRowAction.Delete, rolledBack.failedRowAction?.action)
            assertTrue(checkNotNull(rolledBack.failedRowAction).rejected)
            assertEquals(
                setOf(CHAT_PERSONAL, CHAT_IN_PROJECT),
                chatListGroups(rolledBack).flatMap { it.threads }.map { it.id }.toSet(),
            )

            refresh.complete(Unit)
            runCurrent()
            assertEquals(ChatListReadFailure.Retrying, model.uiState.value.listReadFailure)
            val group = chatListGroups(model.uiState.value).single()
            val sibling = group.threads.single { it.id == CHAT_IN_PROJECT }
            assertFalse(
                ChatRowAction.Pin in
                    model.uiState.value.rowActions(sibling, group, group.threads.indexOf(sibling))
            )
            assertTrue(model.performRowAction(CHAT_IN_PROJECT, ChatRowAction.Archive))
            runCurrent()
            assertEquals(CHAT_IN_PROJECT, model.uiState.value.rowUndo?.threadId)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
        }
    }

    @Test
    fun rejectedRenameRestoresTheTitleBeforeReadingTheMissingTarget() = runTest {
        val rejection = CompletableDeferred<Unit>()
        val readback = CompletableDeferred<Unit>()
        val source =
            object : Service() {
                override suspend fun chatEvents(since: Long?): ChatEvents {
                    if (since == null) return page()
                    readback.await()
                    return page(
                        listOf(chatEventWire(id = HISTORY_LAST_EVENT, seq = 18, kind = "deleted"))
                    )
                }

                override suspend fun renameThread(
                    threadId: String,
                    title: String,
                    eventId: String,
                ) {
                    rejection.await()
                    throw ApiFailure.Http(404, null, null, null)
                }
            }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            model.renameThread(CHAT_PERSONAL, "Optimistic title")
            runCurrent()
            assertEquals("Optimistic title", model.uiState.value.threads.single().title)

            rejection.complete(Unit)
            runCurrent()
            val rolledBack = model.uiState.value
            assertEquals(ChatReadPhase.Loading, rolledBack.listPhase)
            assertEquals("Personal chat", rolledBack.threads.single().title)
            assertTrue(rolledBack.pendingRowActions.isEmpty())
            assertEquals(ChatRowAction.Rename, rolledBack.failedRowAction?.action)
            assertTrue(checkNotNull(rolledBack.failedRowAction).rejected)

            readback.complete(Unit)
            runCurrent()
            assertTrue(model.uiState.value.threads.isEmpty())
        }
    }

    @Test
    fun aLostRenameResponseReconcilesItsEventIdOnBackgroundRetry() = runTest {
        val events = mutableListOf(chatEventWire())
        var attempts = 0
        val source =
            object : Service() {
                override suspend fun chatEvents(since: Long?): ChatEvents {
                    if (since != null && ++attempts == 1)
                        throw ApiFailure.Http(503, null, null, null)
                    return page(events)
                }

                override suspend fun renameThread(
                    threadId: String,
                    title: String,
                    eventId: String,
                ) {
                    events.add(
                        chatEventWire(id = eventId, seq = 18, kind = "renamed", title = title)
                    )
                    throw ApiFailure.Network(IOException("Response lost after commit"))
                }
            }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            model.renameThread(CHAT_PERSONAL, "Local title")
            runCurrent()
            val unconfirmed = model.uiState.value
            assertEquals("Local title", unconfirmed.threads.single().title)
            assertEquals(ChatListReadFailure.Retrying, unconfirmed.listReadFailure)
            assertEquals(ChatRowAction.Rename, unconfirmed.failedRowAction?.action)
            assertFalse(checkNotNull(unconfirmed.failedRowAction).rejected)

            events.add(
                chatEventWire(
                    id = HISTORY_LAST_EVENT,
                    seq = 19,
                    kind = "renamed",
                    title = "Newer title",
                )
            )
            advanceTimeBy(5_000)
            runCurrent()
            val settled = model.uiState.value
            assertEquals(ChatReadPhase.Ready, settled.listPhase)
            assertEquals("Newer title", settled.threads.single().title)
            assertNull(settled.failedRowAction)
            assertEquals(2, attempts)
        }
    }

    private fun tiedPinEvents(vararg threads: String): List<String> {
        fun id(seq: Long) = "${seq.toString().padStart(8, '0')}-0000-4000-8000-000000000000"
        return threads.flatMapIndexed { index, thread ->
            val created = 17L + 2 * index
            val pinned = created + 1
            listOf(
                chatEventWire(id = id(created), seq = created, thread = thread),
                chatEventWire(
                    id = id(pinned),
                    seq = pinned,
                    thread = thread,
                    kind = "pinned",
                    extra = ""","pinOrder":"a0"""",
                ),
            )
        }
    }

    @Test
    fun rejectedPinReorderKeepsTheSubmittedStepAndDiscardsTheUnsentStep() = runTest {
        val moved = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        val next = CHAT_IN_PROJECT
        val rejected = "33333333-3333-4333-8333-333333333333"
        val submitted = CHAT_PERSONAL
        val events = tiedPinEvents(moved, next, rejected, submitted).toMutableList()
        val hold = CompletableDeferred<Unit>()
        val readback = CompletableDeferred<Unit>()
        val requested = mutableListOf<String>()
        val source =
            object : Service() {
                override suspend fun chatEvents(since: Long?): ChatEvents {
                    if (since != null) readback.await()
                    return page(events)
                }

                override suspend fun reorderPinnedThread(
                    threadId: String,
                    pinOrder: String,
                    eventId: String,
                ) {
                    requested.add(threadId)
                    if (threadId == rejected) {
                        hold.await()
                        throw ApiFailure.Http(400, null, null, null)
                    }
                    events.add(
                        chatEventWire(
                            id = eventId,
                            seq = 25,
                            thread = threadId,
                            kind = "sort_touched",
                            extra = ""","pinOrder":"$pinOrder"""",
                        )
                    )
                }
            }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            assertTrue(model.performRowAction(moved, ChatRowAction.MovePinDown))
            runCurrent()
            assertEquals(
                listOf(next, moved, rejected, submitted),
                model.uiState.value.threads.map { it.id },
            )

            hold.complete(Unit)
            runCurrent()
            val partial = model.uiState.value
            assertEquals(ChatReadPhase.Loading, partial.listPhase)
            assertEquals(ChatRowAction.MovePinDown, partial.failedRowAction?.action)
            assertTrue(checkNotNull(partial.failedRowAction).rejected)
            assertEquals(listOf(submitted, rejected), requested)
            assertEquals(
                mapOf(moved to "a0", next to "a0", rejected to "a0", submitted to "a3"),
                partial.threads.associate { it.id to it.pinOrder },
            )

            events.add(
                chatEventWire(
                    id = HISTORY_LAST_EVENT,
                    seq = 26,
                    thread = submitted,
                    kind = "sort_touched",
                    extra = ""","pinOrder":"a4"""",
                )
            )
            readback.complete(Unit)
            runCurrent()
            assertTrue(model.uiState.value.pendingRowActions.isEmpty())
            assertEquals("a4", model.uiState.value.threads.single { it.id == submitted }.pinOrder)
        }
    }

    @Test
    fun unconfirmedPinReorderCanRecoverWhenExplicitRefreshFailsTemporarily() = runTest {
        val moved = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        val submitted = CHAT_PERSONAL
        val events = tiedPinEvents(moved, CHAT_IN_PROJECT, submitted)
        val attempted = mutableListOf<String>()
        var readUnavailable = false
        val source =
            object : Service() {
                override suspend fun chatEvents(since: Long?): ChatEvents {
                    if (since != null && readUnavailable)
                        throw ApiFailure.Http(503, null, null, null)
                    return page(events)
                }

                override suspend fun reorderPinnedThread(
                    threadId: String,
                    pinOrder: String,
                    eventId: String,
                ) {
                    attempted.add(threadId)
                    throw ApiFailure.Network(IOException("Response lost"))
                }
            }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            assertTrue(model.performRowAction(moved, ChatRowAction.MovePinDown))
            runCurrent()
            val partial = model.uiState.value
            val failure = checkNotNull(partial.failedRowAction)
            assertEquals(ChatRowAction.MovePinDown, failure.action)
            assertFalse(failure.rejected)
            assertEquals("a0", partial.threads.single { it.id == moved }.pinOrder)
            assertEquals("a2", partial.threads.single { it.id == submitted }.pinOrder)

            readUnavailable = true
            model.reloadAfterRowActionFailure()
            model.dismissRowActionFailure(failure)
            runCurrent()
            val retrying = model.uiState.value
            assertEquals(ChatListReadFailure.Retrying, retrying.listReadFailure)
            assertEquals("a2", retrying.threads.single { it.id == submitted }.pinOrder)

            readUnavailable = false
            advanceTimeBy(5_000)
            runCurrent()
            val recovered = model.uiState.value
            assertEquals(ChatReadPhase.Ready, recovered.listPhase)
            assertTrue(recovered.threads.all { it.pinOrder == "a0" })
            assertEquals(listOf(submitted), attempted)
        }
    }

    @Test
    fun deletionResponseCannotPublishAfterWorkspaceReplacement() = runTest {
        val release = CompletableDeferred<Unit>()
        var active = true
        var reads = 0
        val source =
            object : Service() {
                override suspend fun chatEvents(since: Long?): ChatEvents {
                    reads++
                    return if (since == null) page() else page(emptyList())
                }

                override suspend fun deleteThread(threadId: String, eventId: String) {
                    release.await()
                }
            }
        withCatchUpModel(source, authorized = { active }) { model ->
            model.refresh()
            advanceUntilIdle()
            model.performRowAction(CHAT_PERSONAL, ChatRowAction.Delete)
            runCurrent()
            val pending = model.uiState.value
            assertEquals(ChatRowAction.Delete, pending.pendingRowActions[CHAT_PERSONAL])
            val priorReads = reads
            active = false
            release.complete(Unit)
            advanceUntilIdle()
            assertSame(pending, model.uiState.value)
            assertEquals(priorReads, reads)
        }
    }

    @Test
    fun aRejectedUnarchiveDoesNotSettleAnEarlierUnconfirmedArchive() = runTest {
        val source =
            object : Service() {
                override suspend fun chatEvents(since: Long?) =
                    if (since == null) page() else page(emptyList())

                override suspend fun setArchived(
                    threadId: String,
                    archived: Boolean,
                    eventId: String,
                ) {
                    if (archived) throw IOException("Unavailable response")
                    throw ApiFailure.Http(400, null, null, null)
                }
            }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            model.performRowAction(CHAT_PERSONAL, ChatRowAction.Archive)
            advanceUntilIdle()
            assertTrue(model.uiState.value.threads.single().archived)

            model.performRowAction(CHAT_PERSONAL, ChatRowAction.Unarchive)
            advanceUntilIdle()
            assertTrue(model.uiState.value.threads.single().archived)
            assertEquals(ChatRowAction.Unarchive, model.uiState.value.failedRowAction?.action)
            assertNull(model.uiState.value.rowUndo)

            model.reloadAfterRowActionFailure()
            advanceUntilIdle()
            assertFalse(model.uiState.value.threads.single().archived)
        }
    }

    @Test
    fun anEarlierReadbackCannotSettleTheNextIntent() = runTest {
        val commitRead = CompletableDeferred<ReadState>()
        val stale = CompletableDeferred<Indicators>()
        val commitUnread = CompletableDeferred<ReadState>()
        fun status(time: String) =
            Indicators(
                emptyMap(),
                mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                mapOf(CHAT_PERSONAL to time),
            )
        val read = Indicators(emptyMap(), emptyMap(), emptyMap())
        val source =
            object : Service() {
                    override suspend fun markRead(threadId: String) = commitRead.await()

                    override suspend fun markUnread(threadId: String) = commitUnread.await()
                }
                .apply { statusRead = { status(CHAT_DATE) } }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkRead)
            runCurrent()
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))
            assertTrue(
                chatListGroups(model.uiState.value, ChatListFilter.Unread).all {
                    it.threads.isEmpty()
                }
            )

            source.statusRead = { stale.await() }
            commitRead.complete(ReadState(CHAT_DATE))
            runCurrent()
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))

            model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkUnread)
            runCurrent()
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))
            stale.complete(read)
            runCurrent()
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))
            source.statusRead = { read }
            commitUnread.completeExceptionally(ApiFailure.Http(404, null, null, null))
            advanceUntilIdle()
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))
            assertEquals(ChatRowAction.MarkUnread, model.uiState.value.failedRowAction?.action)
        }
    }

    @Test
    fun earlierUnreadReadbackCannotUndoAReadWithoutAPreviousWatermark() = runTest {
        val unreadReadback = CompletableDeferred<Indicators>()
        val readWrite = CompletableDeferred<ReadState>()
        val read = Indicators(emptyMap(), emptyMap(), emptyMap())
        val unread =
            Indicators(
                emptyMap(),
                mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                mapOf(CHAT_PERSONAL to CHAT_DATE),
            )
        val source =
            object : Service() {
                    override suspend fun markUnread(threadId: String) = ReadState(null)

                    override suspend fun markRead(threadId: String) = readWrite.await()
                }
                .apply { statusRead = { read } }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            source.statusRead = { unreadReadback.await() }
            model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkUnread)
            runCurrent()
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))

            model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkRead)
            runCurrent()
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))
            unreadReadback.complete(unread)
            runCurrent()
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))

            source.statusRead = { unread }
            readWrite.completeExceptionally(ApiFailure.Http(404, null, null, null))
            advanceUntilIdle()
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))
        }
    }

    @Test
    fun rejectedUnreadKeepsAnEarlierReadReceiptWhileIndicatorsArePending() = runTest {
        val readback = CompletableDeferred<Indicators>()
        val source =
            object : Service() {
                    override suspend fun markRead(threadId: String) = ReadState(CHAT_DATE)

                    override suspend fun markUnread(threadId: String): ReadState =
                        throw ApiFailure.Http(404, null, null, null)
                }
                .apply {
                    statusRead = {
                        Indicators(
                            emptyMap(),
                            mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                            mapOf(CHAT_PERSONAL to CHAT_DATE),
                        )
                    }
                }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            source.statusRead = { readback.await() }
            model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkRead)
            runCurrent()
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))

            model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkUnread)
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))
            runCurrent()
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))
            assertEquals(ChatRowAction.MarkUnread, model.uiState.value.failedRowAction?.action)

            model.dismissRowActionFailure(checkNotNull(model.uiState.value.failedRowAction))
            readback.completeExceptionally(IOException("status unavailable"))
            advanceUntilIdle()
            assertEquals(ChatReadPhase.Failed, model.uiState.value.indicatorsPhase)
            assertNull(model.uiState.value.failedRowAction)
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))

            source.statusRead = { Indicators(emptyMap(), emptyMap(), emptyMap()) }
            model.refreshIndicators()
            advanceUntilIdle()
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))
        }
    }

    @Test
    fun bulkReadShowsNewerUnreadActivityWhileWriteAndReadbackArePending() = runTest {
        val write = CompletableDeferred<ReadState>()
        val readback = CompletableDeferred<Indicators>()
        fun unread(time: String) =
            Indicators(
                emptyMap(),
                mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                mapOf(CHAT_PERSONAL to time),
            )
        val newer = unread("2026-11-13T00:01:00.000Z")
        val source =
            object : Service() {
                    override suspend fun markRead(threadId: String) = write.await()
                }
                .apply { statusRead = { unread(CHAT_DATE) } }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            model.markAllRead()
            runCurrent()
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))

            source.statusRead = { newer }
            model.refreshIndicators()
            runCurrent()
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))

            source.statusRead = { readback.await() }
            write.complete(ReadState(CHAT_DATE))
            runCurrent()
            assertTrue(model.uiState.value.markingAllRead)
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))

            readback.complete(newer)
            advanceUntilIdle()
            assertEquals(ChatMarkAllReadResult(1, 1), model.uiState.value.markAllReadResult)
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))
        }
    }

    @Test
    fun missingIndicatorDoesNotConfirmAnAmbiguousBulkWrite() = runTest {
        val source =
            object : Service() {
                    override suspend fun markRead(threadId: String): ReadState {
                        statusRead = { Indicators(emptyMap(), emptyMap(), emptyMap()) }
                        throw IOException("response lost")
                    }
                }
                .apply {
                    statusRead = {
                        Indicators(
                            emptyMap(),
                            mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                            mapOf(CHAT_PERSONAL to CHAT_DATE),
                        )
                    }
                }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            model.markAllRead()
            advanceUntilIdle()
            val state = model.uiState.value
            assertFalse(state.isUnread(CHAT_PERSONAL))
            assertEquals(ChatMarkAllReadResult(0, 1), state.markAllReadResult)
        }
    }

    @Test
    fun ambiguousUnreadWriteKeepsTheProjectionOfflineAndReconcilesAfterReconnect() = runTest {
        val response = CompletableDeferred<ReadState>()
        val source =
            object : Service() {
                    override suspend fun markUnread(threadId: String) = response.await()
                }
                .apply { statusRead = { Indicators(emptyMap(), emptyMap(), emptyMap()) } }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkUnread)
            runCurrent()
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))
            source.statusRead = { throw IOException("offline") }
            response.completeExceptionally(IOException("response lost"))
            advanceUntilIdle()
            assertEquals(ChatReadPhase.Failed, model.uiState.value.indicatorsPhase)
            assertEquals(ChatRowAction.MarkUnread, model.uiState.value.failedRowAction?.action)
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))

            source.statusRead = {
                Indicators(
                    emptyMap(),
                    mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                    mapOf(CHAT_PERSONAL to CHAT_DATE),
                )
            }
            model.refreshIndicators()
            advanceUntilIdle()
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))
            assertTrue(model.uiState.value.readIntents.isEmpty())
        }
    }

    @Test
    fun listRefreshNoticeUsesCompletedFailuresAndReconnectResetsTheAttemptWindow() = runTest {
        val connected = MutableStateFlow(true)
        var failing = false
        var attempts = 0
        val service =
            Service().apply {
                listRead = {
                    attempts++
                    if (failing) throw ApiFailure.Http(503, null, null, null)
                    page()
                }
            }
        withCatchUpModel(service, connectivity = connected) { model ->
            model.refresh()
            runCurrent()
            val cachedRows = model.uiState.value.threads
            assertTrue(cachedRows.isNotEmpty())
            failing = true
            val first = attempts
            model.refreshList()
            runCurrent()
            assertEquals(first + 1, attempts)
            assertFalse(model.uiState.value.sustainedRefreshFailure)
            advanceTimeBy(5_000)
            runCurrent()
            assertEquals(first + 2, attempts)
            assertFalse(model.uiState.value.sustainedRefreshFailure)
            advanceTimeBy(10_000)
            runCurrent()
            assertEquals(first + 3, attempts)
            assertFalse(model.uiState.value.sustainedRefreshFailure)
            advanceTimeBy(14_999)
            runCurrent()
            assertFalse(model.uiState.value.sustainedRefreshFailure)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(first + 3, attempts)
            assertTrue(model.uiState.value.sustainedRefreshFailure)
            advanceTimeBy(5_000)
            runCurrent()
            assertEquals(first + 4, attempts)
            assertTrue(model.uiState.value.sustainedRefreshFailure)
            assertEquals(cachedRows, model.uiState.value.threads)

            model.selectFilter(ChatListFilter.Inbox)
            assertTrue(model.uiState.value.sustainedRefreshFailure)
            model.selectFilter(ChatListFilter.Unread)
            assertFalse(model.uiState.value.sustainedRefreshFailure)

            connected.value = false
            runCurrent()
            assertTrue(model.uiState.value.offline)
            assertFalse(model.uiState.value.sustainedRefreshFailure)
            model.refresh()
            advanceTimeBy(40_000)
            runCurrent()
            assertEquals(first + 4, attempts)

            connected.value = true
            runCurrent()
            assertFalse(model.uiState.value.offline)
            assertEquals(first + 5, attempts)
            assertFalse(model.uiState.value.sustainedRefreshFailure)
            failing = false
            advanceTimeBy(5_000)
            runCurrent()
            assertEquals(first + 6, attempts)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertNull(model.uiState.value.listReadFailure)
        }
    }

    @Test
    fun listRetryKeepsTheServerDeadlineAfterHidingTheList() = runTest {
        var attempts = 0
        var indicatorsAvailable = false
        val service =
            object : Service() {
                override suspend fun chatSnapshot() =
                    ChatSnapshotVariant1("https://example.test/archive", 60, null, null)

                override suspend fun chatArchive(url: String): ChatArchive {
                    attempts++
                    if (attempts == 1) throw ChatSnapshotUnavailable(429, retryAfterSeconds = 20)
                    return ChatArchive(emptyList())
                }

                override suspend fun indicators(): Indicators {
                    if (!indicatorsAvailable) throw ApiFailure.Http(503, null, null, null)
                    return super.indicators()
                }
            }
        withCatchUpModel(service) { model ->
            model.refresh()
            runCurrent()
            assertEquals(1, attempts)
            assertEquals(ChatListReadFailure.Retrying, model.uiState.value.listReadFailure)
            assertEquals(ChatReadPhase.Failed, model.uiState.value.indicatorsPhase)

            model.listVisibilityChanged(false)
            advanceTimeBy(15_000)
            runCurrent()
            assertEquals(1, attempts)

            model.listVisibilityChanged(true)
            model.refreshList()
            advanceTimeBy(4_999)
            runCurrent()
            assertEquals(1, attempts)

            indicatorsAvailable = true
            advanceTimeBy(1)
            runCurrent()
            assertEquals(2, attempts)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.indicatorsPhase)
        }
    }

    @Test
    fun anInFlightFailureDoesNotCountAfterSwitchingAwayAndBackToTheSameFilter() = runTest {
        val first = CompletableDeferred<ChatEvents>()
        val service = Service()
        withCatchUpModel(service) { model ->
            model.refresh()
            runCurrent()
            val unavailable = ApiFailure.Http(503, null, null, null)
            service.listRead = { first.await() }
            model.refreshList()
            runCurrent()
            assertEquals(ChatReadPhase.Loading, model.uiState.value.listPhase)
            model.selectFilter(ChatListFilter.Unread)
            model.selectFilter(ChatListFilter.Inbox)

            service.listRead = { throw unavailable }
            first.completeExceptionally(unavailable)
            runCurrent()
            advanceTimeBy(30_000)
            runCurrent()
            assertFalse(model.uiState.value.sustainedRefreshFailure)

            advanceTimeBy(5_000)
            runCurrent()
            assertTrue(model.uiState.value.sustainedRefreshFailure)
        }
    }

    @Test
    fun realtimeReadStartedBeforeWriteResponseCanConfirmWithoutAnotherListRead() = runTest {
        val realtime = TestRealtimeService()
        val events = mutableListOf(chatEventWire())
        val writeResponse = CompletableDeferred<Unit>()
        val readResponse = CompletableDeferred<Unit>()
        val statusResponse = CompletableDeferred<Indicators>()
        var reads = 0
        val source =
            Service().apply {
                listRead = {
                    reads++
                    page(events)
                }
            }
        val service =
            object : ChatListService by source {
                override suspend fun setMuted(threadId: String, muted: Boolean, eventId: String) {
                    events.add(
                        chatEventWire(
                            id = eventId,
                            seq = 18,
                            thread = threadId,
                            kind = "sort_touched",
                            extra = ",\"muted\":$muted",
                        )
                    )
                    writeResponse.await()
                }
            }
        withCatchUpModel(service, realtime) { model ->
            model.refresh()
            model.updates.foreground(true)
            advanceUntilIdle()
            val initialReads = reads

            source.statusRead = { statusResponse.await() }
            model.refreshIndicators()
            model.performRowAction(CHAT_PERSONAL, ChatRowAction.Mute)
            runCurrent()

            source.listRead = {
                reads++
                val captured = page(events)
                readResponse.await()
                captured
            }
            realtime.invalidate(ChatChanges(list = true))
            runCurrent()
            assertEquals(initialReads + 1, reads)
            writeResponse.complete(Unit)
            runCurrent()
            readResponse.complete(Unit)
            runCurrent()
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertEquals(ChatReadPhase.Loading, model.uiState.value.indicatorsPhase)

            statusResponse.complete(Indicators(emptyMap(), emptyMap(), emptyMap()))
            advanceUntilIdle()
            assertEquals(initialReads + 1, reads)
            val state = model.uiState.value
            assertEquals(true, state.threads.single().muted)
            assertTrue(state.pendingRowActions.isEmpty())
            assertNull(state.failedRowAction)
        }
    }

    @Test
    fun mixedOptimisticRowsSurviveAnOlderReadAndSettleWithTheirOwnEvidence() = runTest {
        val other =
            chatEventWire(id = HISTORY_LAST_EVENT, seq = 18, thread = CHAT_IN_PROJECT)
                .replace(CHAT_DATE, "2026-11-14T00:00:00.000Z")
        val events = mutableListOf(chatEventWire(), other)
        var reads = 0
        val olderRead = CompletableDeferred<Unit>()
        val trailingRead = CompletableDeferred<Unit>()
        val preview = ProvisionalChat("cccccccc-cccc-4ccc-8ccc-cccccccccccc", CHAT_PROJECT)
        val sortEvent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        val outgoing =
            PendingText(
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                CHAT_PERSONAL,
                null,
                json.decodeFromString<SendRequestVariant1>(
                    """{"prompt":"Hello","threadId":"$CHAT_PERSONAL",
                            "userMessage":{"version":1,"parts":[{"type":"text","text":"Hello"}]},
                            "hasTextContent":true,"chatThreadSortEventId":"$sortEvent"}"""
                ),
                TextStage.Sending,
            )
        val source =
            Service().apply {
                listRead = {
                    reads++
                    page(events)
                }
            }
        val service =
            object : ChatListService by source {
                override suspend fun renameThread(
                    threadId: String,
                    title: String,
                    eventId: String,
                ) {
                    events.add(
                        chatEventWire(id = eventId, seq = 19, kind = "renamed", title = title)
                    )
                }
            }
        withCatchUpModel(service) { model ->
            model.refresh()
            advanceUntilIdle()
            assertEquals(CHAT_IN_PROJECT, model.uiState.value.threadsByRecency.first().id)
            val initialReads = reads
            source.listRead = {
                reads++
                val captured = page(events)
                when (reads - initialReads) {
                    1 -> olderRead.await()
                    2 -> trailingRead.await()
                }
                captured
            }

            model.refreshList()
            runCurrent()
            model.renameThread(CHAT_PERSONAL, "Local edit")
            model.showOutgoingActivity(outgoing)
            model.retainAcceptedNewChats(listOf(preview))
            model.reloadAfterRowActionFailure()
            runCurrent()
            assertEquals(initialReads + 1, reads)
            assertEquals(ChatRowAction.Rename, model.uiState.value.pendingRowActions[CHAT_PERSONAL])

            events.add(
                chatEventWire(
                    id = "77777777-7777-4777-8777-777777777777",
                    seq = 20,
                    thread = preview.threadId,
                    extra = ""","projectId":"$CHAT_PROJECT"""",
                )
            )
            olderRead.complete(Unit)
            runCurrent()
            assertEquals(initialReads + 2, reads)
            val held = model.uiState.value
            assertEquals("Local edit", held.threads.single { it.id == CHAT_PERSONAL }.title)
            assertEquals(listOf(preview), held.acceptedNewChats)
            assertEquals(CHAT_PERSONAL, held.threadsByRecency.first().id)

            trailingRead.complete(Unit)
            advanceUntilIdle()
            val confirmed = model.uiState.value
            assertTrue(confirmed.pendingRowActions.isEmpty())
            assertNull(confirmed.failedRowAction)
            assertTrue(confirmed.acceptedNewChats.isEmpty())
            assertEquals(
                CHAT_PROJECT,
                confirmed.threads.single { it.id == preview.threadId }.projectId,
            )
            assertEquals(CHAT_PERSONAL, confirmed.threadsByRecency.first().id)

            events.add(
                chatEventWire(
                    id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                    seq = 21,
                    kind = "renamed",
                    title = "Remote edit",
                )
            )
            model.refreshList()
            advanceUntilIdle()
            assertEquals(
                "Remote edit",
                model.uiState.value.threads.single { it.id == CHAT_PERSONAL }.title,
            )
            model.refreshAfterSendFailure(outgoing, rejected = true)
            assertEquals(CHAT_IN_PROJECT, model.uiState.value.threadsByRecency.first().id)
        }
    }

    @Test
    fun sendReceiptKeepsActivityUntilTheSortEventOrAnExplicitReconciliation() = runTest {
        val other =
            chatEventWire(
                    id = "77777777-7777-4777-8777-777777777777",
                    seq = 18,
                    thread = CHAT_IN_PROJECT,
                )
                .replace(CHAT_DATE, "2026-11-14T00:00:00.000Z")
        val service = Service().apply { listRead = { page(listOf(chatEventWire(), other)) } }
        val online = MutableStateFlow(true)
        val pending =
            PendingText(
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                CHAT_PERSONAL,
                null,
                json.decodeFromString<SendRequestVariant1>(
                    """{"prompt":"Hello","threadId":"$CHAT_PERSONAL",
                            "userMessage":{"version":1,"parts":[{"type":"text","text":"Hello"}]},
                            "hasTextContent":true,
                            "chatThreadSortEventId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}"""
                ),
                TextStage.Sending,
            )
        withCatchUpModel(service, connectivity = online) { model ->
            model.refresh()
            advanceUntilIdle()
            val baseline = model.uiState.value.threads.map { it.id }
            assertEquals(listOf(CHAT_IN_PROJECT, CHAT_PERSONAL), baseline)
            val older = CompletableDeferred<Unit>()
            val afterSend = CompletableDeferred<Unit>()
            var reads = 0
            service.listRead = {
                if (++reads == 1) older.await() else afterSend.await()
                page(emptyList())
            }
            model.showOutgoingActivity(pending)
            assertEquals(CHAT_PERSONAL, model.uiState.value.threads.first().id)
            model.refreshList()
            runCurrent()
            model.acknowledgeOutgoingActivity(pending)
            model.refreshAfterSend(pending.threadId)
            older.complete(Unit)
            runCurrent()
            assertEquals(2, reads)
            assertEquals(CHAT_PERSONAL, model.uiState.value.threads.first().id)
            afterSend.complete(Unit)
            advanceUntilIdle()
            assertEquals(CHAT_PERSONAL, model.uiState.value.threads.first().id)
            model.refresh()
            advanceUntilIdle()
            assertEquals(baseline, model.uiState.value.threads.map { it.id })

            model.showOutgoingActivity(pending)
            assertEquals(CHAT_PERSONAL, model.uiState.value.threads.first().id)
            model.refreshAfterSendFailure(pending, rejected = true)
            assertEquals(baseline, model.uiState.value.threads.map { it.id })
            advanceUntilIdle()

            model.showOutgoingActivity(pending)
            online.value = false
            runCurrent()
            model.refreshAfterSendFailure(pending, rejected = false)
            advanceUntilIdle()
            assertEquals(CHAT_PERSONAL, model.uiState.value.threads.first().id)
            service.listRead = {
                page(
                    listOf(
                        chatEventWire(
                            id = checkNotNull(pending.send.chatThreadSortEventId),
                            seq = 19,
                            kind = "sort_touched",
                        )
                    )
                )
            }
            online.value = true
            advanceUntilIdle()
            // The matching event is authoritative even when its server position differs.
            assertEquals(baseline, model.uiState.value.threads.map { it.id })
            model.showOutgoingActivity(pending)
            assertEquals(baseline, model.uiState.value.threads.map { it.id })
        }
    }

    @Test
    fun sendOrderReconciliationSurvivesBackoffAndFailedReads() = runTest {
        val other =
            chatEventWire(
                    id = "77777777-7777-4777-8777-777777777777",
                    seq = 18,
                    thread = CHAT_IN_PROJECT,
                )
                .replace(CHAT_DATE, "2026-11-14T00:00:00.000Z")
        val pending =
            PendingText(
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                CHAT_PERSONAL,
                null,
                json.decodeFromString<SendRequestVariant1>(
                    """{"prompt":"Hello","threadId":"$CHAT_PERSONAL",
                            "userMessage":{"version":1,"parts":[{"type":"text","text":"Hello"}]},
                            "hasTextContent":true,
                            "chatThreadSortEventId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}"""
                ),
                TextStage.Sending,
            )
        for (requestDuringBackoff in listOf(false, true)) {
            val service = Service().apply { listRead = { page(listOf(chatEventWire(), other)) } }
            withCatchUpModel(service) { model ->
                model.refresh()
                runCurrent()
                val baseline = model.uiState.value.threads.map { it.id }
                assertEquals(listOf(CHAT_IN_PROJECT, CHAT_PERSONAL), baseline)
                model.showOutgoingActivity(pending)
                model.acknowledgeOutgoingActivity(pending)
                var reads = 0
                service.listRead = {
                    if (++reads == 1) throw ApiFailure.Http(503, null, null, null)
                    page(emptyList())
                }
                if (requestDuringBackoff) model.refreshList() else model.refresh()
                runCurrent()
                assertEquals(ChatListReadFailure.Retrying, model.uiState.value.listReadFailure)
                if (requestDuringBackoff) model.refresh()
                advanceTimeBy(4_999)
                assertEquals(1, reads)
                assertEquals(CHAT_PERSONAL, model.uiState.value.threads.first().id)
                advanceTimeBy(1)
                runCurrent()
                assertEquals(2, reads)
                assertEquals(baseline, model.uiState.value.threads.map { it.id })

                model.showOutgoingActivity(pending)
                model.acknowledgeOutgoingActivity(pending)
                model.refreshList()
                runCurrent()
                assertEquals(CHAT_PERSONAL, model.uiState.value.threads.first().id)

                val held = CompletableDeferred<Unit>()
                service.listRead = {
                    held.await()
                    page(emptyList())
                }
                model.refresh()
                runCurrent()
                model.showOutgoingActivity(pending)
                held.complete(Unit)
                runCurrent()
                assertEquals(CHAT_PERSONAL, model.uiState.value.threads.first().id)
            }
        }
    }

    @Test
    fun restoredAcceptedChatWaitsForTheListWhenDetailConfirmsItExists() = runTest {
        val detail = CompletableDeferred<ThreadDetail>()
        var detailReads = 0
        val preview = ProvisionalChat(CHAT_IN_PROJECT, CHAT_PROJECT)
        val service =
            object : Service() {
                override suspend fun threadDetail(threadId: String): ThreadDetail {
                    assertEquals(preview.threadId, threadId)
                    if (++detailReads == 1) throw ApiFailure.Http(503, null, null, null)
                    return detail.await()
                }
            }
        withCatchUpModel(service) { model ->
            model.refresh()
            runCurrent()
            model.retainAcceptedNewChats(listOf(preview), restored = true)
            runCurrent()
            assertEquals(listOf(preview), model.uiState.value.acceptedNewChats)

            service.listRead = { page(emptyList()) }
            model.refreshList()
            runCurrent()
            model.refreshList()
            runCurrent()
            assertEquals(2, detailReads)
            detail.complete(ThreadDetail(null, false))
            runCurrent()
            assertEquals(listOf(preview), model.uiState.value.acceptedNewChats)

            service.listRead = {
                page(
                    listOf(
                        chatEventWire(id = HISTORY_LAST_EVENT, seq = 18, thread = preview.threadId)
                    )
                )
            }
            model.refreshList()
            runCurrent()
            assertTrue(model.uiState.value.threads.any { it.id == preview.threadId })
            assertTrue(model.uiState.value.acceptedNewChats.isEmpty())
            assertEquals(2, detailReads)
        }
    }

    @Test
    fun replacementDuringDetailReadRechecksAnUnmatchedAcceptedChat() = runTest {
        val previousDetail = CompletableDeferred<ThreadDetail>()
        val replacementDetail = CompletableDeferred<ThreadDetail>()
        val preview = ProvisionalChat(CHAT_IN_PROJECT, CHAT_PROJECT)
        var replacement: ChatSnapshot? = null
        var detailReads = 0
        val service =
            object : Service() {
                override suspend fun chatSnapshot() = replacement ?: super.chatSnapshot()

                override suspend fun chatArchive(url: String) = ChatArchive(emptyList())

                override suspend fun chatEvents(since: Long?) =
                    when (since) {
                        null -> page()
                        17L -> throw ApiFailure.Http(410, null, null, null)
                        40L -> page(emptyList())
                        else -> error("Unexpected cursor $since")
                    }

                override suspend fun threadDetail(threadId: String): ThreadDetail {
                    assertEquals(preview.threadId, threadId)
                    return if (++detailReads == 1) previousDetail.await()
                    else replacementDetail.await()
                }
            }
        withCatchUpModel(service) { model ->
            model.refresh()
            runCurrent()
            assertEquals(listOf(CHAT_PERSONAL), model.uiState.value.threads.map { it.id })
            model.retainAcceptedNewChats(listOf(preview), restored = true)
            runCurrent()
            assertEquals(1, detailReads)

            replacement =
                ChatSnapshotVariant1("https://fixture.test/archive", 60, HISTORY_LAST_EVENT, 40)
            model.refreshList()
            runCurrent()
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertTrue(model.uiState.value.threads.isEmpty())
            assertEquals(listOf(preview), model.uiState.value.acceptedNewChats)
            assertEquals(1, detailReads)

            previousDetail.complete(ThreadDetail(null, false))
            runCurrent()
            assertEquals(listOf(preview), model.uiState.value.acceptedNewChats)
            assertEquals(2, detailReads)

            replacementDetail.completeExceptionally(ApiFailure.Http(404, null, null, null))
            runCurrent()
            assertTrue(model.uiState.value.acceptedNewChats.isEmpty())
        }
    }

    @Test
    fun createAndDeleteInOneCatchUpRetireTheAcceptedPreview() = runTest {
        val service = Service().apply { listRead = { page(listOf(chatEventWire())) } }
        withCatchUpModel(service) { model ->
            model.refresh()
            advanceUntilIdle()
            val preview = ProvisionalChat(CHAT_IN_PROJECT, CHAT_PROJECT)
            model.retainAcceptedNewChats(listOf(preview))
            assertEquals(listOf(preview), model.uiState.value.acceptedNewChats)
            service.listRead = {
                page(
                    listOf(
                        chatEventWire(
                            id = "77777777-7777-4777-8777-777777777777",
                            seq = 18,
                            thread = preview.threadId,
                        ),
                        chatEventWire(
                            id = "88888888-8888-4888-8888-888888888888",
                            seq = 19,
                            thread = preview.threadId,
                            kind = "deleted",
                        ),
                    )
                )
            }
            model.refreshList()
            advanceUntilIdle()
            assertEquals(listOf(CHAT_PERSONAL), model.uiState.value.threads.map { it.id })
            assertTrue(model.uiState.value.acceptedNewChats.isEmpty())

            // A receipt arriving after the canonical deletion cannot restore the preview.
            model.retainAcceptedNewChats(listOf(preview))
            assertTrue(model.uiState.value.acceptedNewChats.isEmpty())
        }
    }

    @Test
    fun reconnectRetainsTrailingListDemandAndDoesNotBlockProjectsOrIndicators() = runTest {
        val realtime = TestRealtimeService()
        val events = mutableListOf(chatEventWire())
        val olderRead = CompletableDeferred<Unit>()
        var listReads = 0
        var projectReads = 0
        var indicatorReads = 0
        val source =
            Service().apply {
                listRead = {
                    listReads++
                    page(events)
                }
                statusRead = {
                    indicatorReads++
                    Indicators(emptyMap(), emptyMap(), emptyMap())
                }
            }
        val service =
            object : ChatListService by source {
                override suspend fun projectEvents(since: Long): ProjectEvents {
                    projectReads++
                    return ProjectEvents(emptyList(), false)
                }
            }
        withCatchUpModel(service, realtime) { model ->
            model.refresh()
            model.updates.foreground(true)
            advanceUntilIdle()
            val initialList = listReads
            val initialProjects = projectReads
            val initialIndicators = indicatorReads
            source.listRead = {
                listReads++
                val captured = page(events)
                if (listReads == initialList + 1) olderRead.await()
                captured
            }
            model.refreshList()
            runCurrent()

            events.add(
                chatEventWire(
                    id = "77777777-7777-4777-8777-777777777777",
                    seq = 18,
                    kind = "renamed",
                    title = "Seen after reconnect",
                )
            )
            model.updates.retry()
            model.refresh()
            runCurrent()
            assertEquals(initialList + 1, listReads)
            assertTrue(projectReads > initialProjects)
            assertTrue(indicatorReads > initialIndicators)

            olderRead.complete(Unit)
            advanceUntilIdle()
            assertEquals(initialList + 2, listReads)
            assertEquals("Seen after reconnect", model.uiState.value.threads.single().title)
        }
    }

    @Test
    fun confirmedSecondRenameSettlesEarlierUnconfirmedEdit() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val store = ViewModelStore()
        val tail = mutableListOf(chatEventWire())
        val source =
            Service().apply {
                listRead = {
                    json.decodeFromString(
                        """{"events":[${tail.joinToString(",")}],"hasMore":false}"""
                    )
                }
            }
        val service =
            object : ChatListService by source {
                override suspend fun renameThread(
                    threadId: String,
                    title: String,
                    eventId: String,
                ) {
                    if (title == "First edit") throw IOException("unconfirmed write")
                    tail.add(chatEventWire(id = eventId, seq = 18, kind = "renamed", title = title))
                }
            }
        try {
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            ChatListModel(
                                service,
                                cache(temporary.newFolder(), dispatcher),
                                identity,
                                { true },
                                {},
                                dispatcher,
                            )
                        }
                    },
                )[ChatListModel::class.java]
            model.refresh()
            advanceUntilIdle()

            model.renameThread(CHAT_PERSONAL, "First edit")
            advanceUntilIdle()
            assertEquals("First edit", model.uiState.value.threads.single().title)
            assertEquals(ChatRowAction.Rename, model.uiState.value.failedRowAction?.action)
            model.dismissRowActionFailure(checkNotNull(model.uiState.value.failedRowAction))

            model.renameThread(CHAT_PERSONAL, "Second edit")
            advanceUntilIdle()
            assertEquals("Second edit", model.uiState.value.threads.single().title)
            assertNull(model.uiState.value.failedRowAction)

            tail.add(
                chatEventWire(
                    id = "77777777-7777-4777-8777-777777777777",
                    seq = 19,
                    kind = "renamed",
                    title = "Remote edit",
                )
            )
            model.refreshList()
            advanceUntilIdle()
            assertEquals("Remote edit", model.uiState.value.threads.single().title)
        } finally {
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun aRejectedUnmuteKeepsItsReadReceiptWhileIndicatorsAreHeld() = runTest {
        val refresh = CompletableDeferred<Indicators>()
        val unread = Indicators(emptyMap(), emptyMap(), mapOf(CHAT_PERSONAL to CHAT_DATE))
        val source =
            object : Service() {
                override suspend fun chatEvents(since: Long?) =
                    page(
                        listOf(
                            chatEventWire(),
                            chatEventWire(
                                id = HISTORY_LAST_EVENT,
                                seq = 18,
                                kind = "sort_touched",
                                extra = ""","muted":true""",
                            ),
                        )
                    )

                override suspend fun markRead(threadId: String) = ReadState(CHAT_DATE)

                override suspend fun setMuted(threadId: String, muted: Boolean, eventId: String) {
                    throw ApiFailure.Http(400, null, null, null)
                }
            }
        source.statusRead = { unread }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))

            source.statusRead = { refresh.await() }
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.Unmute))
            runCurrent()
            val state = model.uiState.value
            assertTrue(state.threads.single().muted == true)
            assertFalse(state.isUnread(CHAT_PERSONAL))
            assertTrue(state.pendingRowActions.isEmpty())
            assertEquals(ChatReadPhase.Loading, state.indicatorsPhase)
            assertTrue(checkNotNull(state.failedRowAction).rejected)

            refresh.complete(unread.copy(unreadAt = emptyMap()))
            runCurrent()
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))
        }
    }

    @Test
    fun unmuteConfirmsListIndependentlyOfIndicatorReadbackFailure() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val store = ViewModelStore()
        val oldStatus = CompletableDeferred<Indicators>()
        val tail =
            mutableListOf(
                chatEventWire(),
                chatEventWire(
                    id = "77777777-7777-4777-8777-777777777777",
                    seq = 18,
                    kind = "sort_touched",
                    extra = ",\"muted\":true",
                ),
            )
        val source =
            Service().apply {
                listRead = {
                    json.decodeFromString(
                        """{"events":[${tail.joinToString(",")}],"hasMore":false}"""
                    )
                }
                statusRead = { Indicators(emptyMap(), emptyMap(), emptyMap()) }
            }
        val service =
            object : ChatListService by source {
                override suspend fun markRead(threadId: String) = ReadState(CHAT_DATE)

                override suspend fun setMuted(threadId: String, muted: Boolean, eventId: String) {
                    tail.add(
                        chatEventWire(
                            id = eventId,
                            seq = 19,
                            thread = threadId,
                            kind = "sort_touched",
                            extra = ",\"muted\":$muted",
                        )
                    )
                }
            }
        val cache = cache(temporary.newFolder(), dispatcher)
        try {
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            ChatListModel(service, cache, identity, { true }, {}, dispatcher)
                        }
                    },
                )[ChatListModel::class.java]
            model.refresh()
            advanceUntilIdle()

            source.statusRead = { oldStatus.await() }
            model.refreshIndicators()
            runCurrent()
            source.statusRead = { throw IOException("offline") }

            model.performRowAction(CHAT_PERSONAL, ChatRowAction.Unmute)
            runCurrent()
            assertEquals(ChatRowAction.Unmute, model.uiState.value.pendingRowActions[CHAT_PERSONAL])
            assertEquals(false, model.uiState.value.threads.single().muted)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            source.listRead = { throw IOException("offline") }

            oldStatus.complete(
                Indicators(
                    emptyMap(),
                    mapOf(
                        CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD,
                        CHAT_IN_PROJECT to IndicatorsThreadsValue.ACTIVE,
                    ),
                    mapOf(CHAT_PERSONAL to CHAT_DATE),
                )
            )
            advanceUntilIdle()

            val state = model.uiState.value
            assertEquals(false, state.threads.single().muted)
            assertTrue(state.pendingRowActions.isEmpty())
            assertEquals(ChatReadPhase.Ready, state.listPhase)
            assertEquals(ChatReadPhase.Failed, state.indicatorsPhase)
            assertNull(state.failedRowAction)
            val indicators = checkNotNull(state.indicators)
            assertEquals(
                mapOf(CHAT_IN_PROJECT to IndicatorsThreadsValue.ACTIVE),
                indicators.threads,
            )
            assertTrue(indicators.unreadAt.isEmpty())
        } finally {
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun heldListDoesNotBlockMetadataStatusRefreshAndItsFailureCanRetry() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val store = ViewModelStore()
        val gate = CompletableDeferred<ChatEvents>()
        val service = Service().apply { listRead = { gate.await() } }
        val cache = cache(temporary.newFolder(), dispatcher)
        try {
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            ChatListModel(service, cache, identity, { true }, {}, dispatcher)
                        }
                    },
                )[ChatListModel::class.java]
            model.refresh()
            runCurrent()
            assertEquals(ChatReadPhase.Loading, model.uiState.value.listPhase)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.agentsPhase)
            assertEquals(
                IndicatorsThreadsValue.UNREAD,
                model.uiState.value.indicators?.threads?.get(CHAT_PERSONAL),
            )
            service.statusRead = {
                Indicators(
                    emptyMap(),
                    mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.ACTIVE),
                    emptyMap(),
                )
            }
            model.refreshIndicators()
            runCurrent()
            assertEquals(
                IndicatorsThreadsValue.ACTIVE,
                model.uiState.value.indicators?.threads?.get(CHAT_PERSONAL),
            )
            service.statusRead = { throw IOException("offline") }
            model.refreshIndicators()
            runCurrent()
            assertEquals(ChatReadPhase.Failed, model.uiState.value.indicatorsPhase)
            assertEquals(
                IndicatorsThreadsValue.ACTIVE,
                model.uiState.value.indicators?.threads?.get(CHAT_PERSONAL),
            )
            gate.completeExceptionally(IOException("offline"))
            advanceUntilIdle()
            assertEquals(ChatReadPhase.Failed, model.uiState.value.listPhase)
            assertNull(model.uiState.value.confirmedAt)
            service.listRead = { page() }
            model.refreshList()
            advanceUntilIdle()
            assertEquals("Personal chat", model.uiState.value.threads.single().title)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertFalse(model.uiState.value.cacheUnavailable)
        } finally {
            gate.complete(page())
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun nonCooperativeRetiredResponseCannotPublishOrOverwriteTheReplacementCache() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val oldStore = ViewModelStore()
        val newStore = ViewModelStore()
        val cache = cache(temporary.newFolder(), dispatcher)
        val gate = CompletableDeferred<ChatEvents>()
        try {
            val oldService =
                Service().apply { listRead = { withContext(NonCancellable) { gate.await() } } }
            val old =
                ViewModelProvider(
                    oldStore,
                    viewModelFactory {
                        initializer {
                            ChatListModel(oldService, cache, identity, { true }, {}, dispatcher)
                        }
                    },
                )[ChatListModel::class.java]
            old.refresh()
            runCurrent()
            oldStore.clear()
            val newService = Service().apply { listRead = { page(23) } }
            val replacement =
                ViewModelProvider(
                    newStore,
                    viewModelFactory {
                        initializer {
                            ChatListModel(
                                newService,
                                cache,
                                identity.copy(sessionId = "new-session"),
                                { true },
                                {},
                                dispatcher,
                            )
                        }
                    },
                )[ChatListModel::class.java]
            replacement.refresh()
            advanceUntilIdle()
            assertEquals(ChatListSource.Network, replacement.uiState.value.source)
            gate.complete(page())
            advanceUntilIdle()
            assertNull(old.uiState.value.confirmedAt)
            assertEquals("Personal chat", replacement.uiState.value.threads.single().title)
            newStore.clear()
            cache
                .open(identity) { true }
                .use { assertEquals(23L, checkNotNull(it.load()).checkpoint.cursor.seqId) }
        } finally {
            gate.complete(page())
            oldStore.clear()
            newStore.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun cachedConfirmedDataIsExplicitWhileFreshNetworkIsHeldOrOffline() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val cache = cache(temporary.newFolder(), dispatcher)
        val checkpoint =
            ChatCheckpoint(
                ai.okou.android.api.generated.ChatArchive(emptyList()),
                ChatCursor(),
                page().events,
                ChatCursor(CHAT_EVENT, 17),
            )
        val store = ViewModelStore()
        val gate = CompletableDeferred<ChatEvents>()
        try {
            cache
                .open(identity) { true }
                .use {
                    it.save(checkpoint, 1234, CachedChatNavigation(agents = Service().agents()))
                }
            val service =
                Service().apply {
                    listRead = { gate.await() }
                    agentRead = { throw IOException("offline") }
                    statusRead = { throw IOException("offline") }
                }
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            ChatListModel(service, cache, identity, { true }, {}, dispatcher)
                        }
                    },
                )[ChatListModel::class.java]
            model.refresh()
            runCurrent()
            assertEquals(ChatListSource.Cache, model.uiState.value.source)
            assertEquals(1234L, model.uiState.value.confirmedAt)
            assertEquals("Personal chat", model.uiState.value.threads.single().title)
            assertEquals(
                "Personal chat",
                chatListGroups(model.uiState.value).last().threads.single().title,
            )
            assertEquals(ChatListSource.Cache, model.uiState.value.agentsSource)
            gate.completeExceptionally(IOException("offline"))
            advanceUntilIdle()
            assertEquals(ChatReadPhase.Failed, model.uiState.value.listPhase)
            assertEquals(ChatListSource.Cache, model.uiState.value.source)
        } finally {
            gate.complete(page())
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun unchangedRefreshAvoidsDiskWritesAndAnUnsavedUpdateRetriesPersistence() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val root = temporary.newFolder()
        val cache = cache(root, dispatcher)
        val store = ViewModelStore()
        try {
            val service = Service()
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            ChatListModel(service, cache, identity, { true }, {}, dispatcher)
                        }
                    },
                )[ChatListModel::class.java]
            model.refresh()
            advanceUntilIdle()
            val initial = model.uiState.value
            assertEquals(ChatReadPhase.Ready, initial.listPhase)
            assertFalse(initial.cacheUnavailable)
            execute(
                root,
                "CREATE TRIGGER fail_chat_write BEFORE INSERT ON chat_scopes BEGIN SELECT RAISE(ABORT, 'disk failure fixture'); END",
            )
            model.refresh()
            advanceUntilIdle()
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertFalse(model.uiState.value.cacheUnavailable)
            assertEquals(initial.confirmedAt, model.uiState.value.confirmedAt)
            assertSame(initial.threads, model.uiState.value.threads)
            assertSame(initial.threadsByRecency, model.uiState.value.threadsByRecency)
            service.listRead = {
                json.decodeFromString<ChatEvents>(
                    """{"events":[${chatEventWire(id = "77777777-7777-4777-8777-777777777777", seq = 23, kind = "renamed", title = "Updated")}],"hasMore":false}"""
                )
            }
            model.refreshList()
            advanceUntilIdle()
            val unsaved = model.uiState.value
            assertEquals("Updated", unsaved.threads.single().title)
            assertTrue(unsaved.cacheUnavailable)
            execute(root, "DROP TRIGGER fail_chat_write")
            model.refreshList()
            advanceUntilIdle()
            assertSame(unsaved.threads, model.uiState.value.threads)
            assertEquals(unsaved.confirmedAt, model.uiState.value.confirmedAt)
            assertFalse(model.uiState.value.cacheUnavailable)
            service.agentRead = { Service().agents().map { it.copy(displayName = "Updated Okou") } }
            model.refreshMetadata()
            advanceUntilIdle()
            store.clear()
            runCurrent()
            cache
                .open(identity) { true }
                .use {
                    val saved = checkNotNull(it.load())
                    assertEquals(23L, saved.checkpoint.cursor.seqId)
                    assertEquals("Updated", replayChats(saved.checkpoint).single().title)
                    assertEquals("Updated Okou", saved.navigation.agents?.single()?.displayName)
                }
        } finally {
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun cacheRejectionUsesNewerStoredCheckpointBeforePublishing() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val root = temporary.newFolder()
        val cache = cache(root, dispatcher)
        val store = ViewModelStore()
        try {
            val newer = page(listOf(chatEventWire(seq = 23, title = "Newer on disk"))).events
            val checkpoint =
                ChatCheckpoint(ChatArchive(emptyList()), ChatCursor(), newer, newer.last().cursor())
            cache.open(identity) { true }.use { it.save(checkpoint, 1234) }
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            ChatListModel(Service(), cache, identity, { true }, {}, dispatcher)
                        }
                    },
                )[ChatListModel::class.java]

            model.refreshList()
            advanceUntilIdle()

            val state = model.uiState.value
            assertEquals(ChatReadPhase.Ready, state.listPhase)
            assertEquals(listOf("Newer on disk"), state.threads.map { it.title })
            assertEquals(1234L, state.confirmedAt)
            assertFalse(state.cacheUnavailable)
        } finally {
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun backgroundRebaseYieldsToNewerReadsAndPreservesPendingMutationConfirmation() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val cache = cache(temporary.newFolder(), dispatcher)
        val store = ViewModelStore()
        val superseded = CompletableDeferred<ChatSnapshot>()
        val current = CompletableDeferred<ChatSnapshot>()
        val renameEventId = CompletableDeferred<String>()
        val renameResponse = CompletableDeferred<Unit>()
        fun eventId(seq: Int) = "${seq.toString().padStart(8, '0')}-0000-4000-8000-000000000000"
        fun renamed(seq: Int, title: String, id: String = eventId(seq)) =
            chatEventWire(id = id, seq = seq.toLong(), kind = "renamed", title = title)
        val tail =
            page(listOf(chatEventWire(seq = 1)) + (2..101).map { renamed(it, "Cached") }).events
        val checkpoint =
            ChatCheckpoint(ChatArchive(emptyList()), ChatCursor(), tail, tail.last().cursor())
        val row = replayChats(checkpoint).single()
        val oldSnapshot = ChatSnapshotVariant1("https://fixture.test/old", 60, eventId(103), 103)
        val newSnapshot = ChatSnapshotVariant1("https://fixture.test/new", 60, eventId(105), 105)
        var snapshotReads = 0
        val service =
            object : TestChatService() {
                override suspend fun chatSnapshot() =
                    if (++snapshotReads == 1) withContext(NonCancellable) { superseded.await() }
                    else current.await()

                override suspend fun chatArchive(url: String) =
                    ChatArchive(
                        listOf(
                            row.copy(
                                title = if (url == oldSnapshot.url) "Superseded" else "Other device"
                            )
                        )
                    )

                override suspend fun renameThread(
                    threadId: String,
                    title: String,
                    eventId: String,
                ) {
                    renameEventId.complete(eventId)
                    renameResponse.await()
                }

                override suspend fun chatEvents(since: Long?) =
                    when (since) {
                        101L -> page(listOf(renamed(102, "First increment")))
                        102L -> page(listOf(renamed(103, "Newest")))
                        103L ->
                            if (renameEventId.isCompleted)
                                page(
                                    listOf(
                                        renamed(104, "Local rename", renameEventId.await()),
                                        renamed(105, "Other device"),
                                    )
                                )
                            else page(emptyList())
                        105L -> page(emptyList())
                        else -> error("Unexpected cursor $since")
                    }
            }
        try {
            cache.open(identity) { true }.use { it.save(checkpoint, 1234) }
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            ChatListModel(service, cache, identity, { true }, {}, dispatcher)
                        }
                    },
                )[ChatListModel::class.java]
            model.refresh()
            runCurrent()
            assertEquals(1, snapshotReads)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertEquals("First increment", model.uiState.value.threads.single().title)

            model.refreshList()
            runCurrent()
            assertEquals(2, snapshotReads)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertEquals("Newest", model.uiState.value.threads.single().title)
            superseded.complete(oldSnapshot)
            runCurrent()
            assertEquals("Newest", model.uiState.value.threads.single().title)

            model.renameThread(CHAT_PERSONAL, "Local rename")
            runCurrent()
            assertTrue(renameEventId.isCompleted)
            current.complete(newSnapshot)
            runCurrent()
            assertEquals("Local rename", model.uiState.value.threads.single().title)

            renameResponse.complete(Unit)
            advanceUntilIdle()
            assertNull(model.uiState.value.failedRowAction)
            assertEquals("Other device", model.uiState.value.threads.single().title)
            store.clear()
            runCurrent()
            cache
                .open(identity) { true }
                .use {
                    val saved = checkNotNull(it.load()).checkpoint
                    assertEquals(ChatCursor(eventId(105), 105), saved.snapshotCursor)
                    assertTrue(saved.events.isEmpty())
                    assertEquals("Other device", replayChats(saved).single().title)
                }
        } finally {
            superseded.complete(oldSnapshot)
            current.complete(newSnapshot)
            renameResponse.complete(Unit)
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun rejectedCachedProjectRenameRestoresConfirmedNameWhileInitialReadIsHeld() = runTest {
        val initialRead = CompletableDeferred<Unit>()
        val service = HeldProjectRenameService(initialRead)
        withCachedProjectRename(service) { model, _ ->
            val projectReads = service.projectReads
            model.renameProject(CHAT_PROJECT, "Rejected")
            runCurrent()
            assertEquals("Rejected", model.uiState.value.projects.single().name)

            service.response.completeExceptionally(ApiFailure.Http(404, null, null, null))
            advanceUntilIdle()
            val state = model.uiState.value
            assertEquals("Before", state.projects.single().name)
            assertNull(state.renamingProjectId)
            assertEquals(
                ProjectRenameRejection(CHAT_PROJECT, service.sent.single()),
                state.projectRenameRejection,
            )
            assertTrue(state.unconfirmedProjectRenames.isEmpty())
            assertEquals(projectReads, service.projectReads)
            model.retryProjectRename(CHAT_PROJECT)
            runCurrent()
            assertEquals(1, service.sent.size)

            initialRead.complete(Unit)
            advanceUntilIdle()
            service.receipt =
                ProjectEventsEventsItem(
                    id = CHAT_EVENT,
                    seqId = 1,
                    projectId = CHAT_PROJECT,
                    kind = ProjectEventsEventsItemKind.DELETED,
                    name = null,
                    createdAt = CHAT_DATE,
                )
            model.refreshMetadata()
            advanceUntilIdle()
            assertTrue(model.uiState.value.projects.isEmpty())
        }
    }

    @Test
    fun cachedProjectRenameRecoversLostResponseAfterTheInitialRead() = runTest {
        val initialRead = CompletableDeferred<Unit>()
        val service = HeldProjectRenameService(initialRead)
        withCachedProjectRename(service) { model, diskCache ->
            model.renameProject(CHAT_PROJECT, "After")
            runCurrent()
            val eventId = service.sent.single()
            assertEquals("After", model.uiState.value.projects.single().name)
            diskCache
                .open(identity) { true }
                .use {
                    assertEquals(
                        "Before",
                        replayProjects(checkNotNull(it.loadProjects()).checkpoint).single().name,
                    )
                }
            service.receipt =
                ProjectEventsEventsItem(
                    id = eventId,
                    seqId = 1,
                    projectId = CHAT_PROJECT,
                    kind = ProjectEventsEventsItemKind.RENAMED,
                    name = "After",
                    createdAt = CHAT_DATE,
                )
            service.response.completeExceptionally(ApiFailure.Network(IOException("Lost response")))
            runCurrent()
            initialRead.complete(Unit)
            advanceUntilIdle()

            val state = model.uiState.value
            assertEquals(ChatListSource.Network, state.projectsSource)
            assertEquals("After", state.projects.single().name)
            assertNull(state.renamingProjectId)
            assertNull(state.projectRenameRejection)
            assertTrue(state.unconfirmedProjectRenames.isEmpty())
            diskCache
                .open(identity) { true }
                .use {
                    val saved = checkNotNull(it.loadProjects())
                    assertEquals(eventId, saved.checkpoint.cursor.eventId)
                    assertEquals("After", replayProjects(saved.checkpoint).single().name)
                }
        }
    }

    private suspend fun TestScope.withCachedProjectRename(
        service: HeldProjectRenameService,
        exercise: suspend (ChatListModel, ChatCacheStore) -> Unit,
    ) {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val root = temporary.newFolder()
        val diskCache = cache(root, dispatcher)
        diskCache
            .open(identity) { true }
            .use {
                val project = ConfirmedProject(CHAT_PROJECT, "Before", CHAT_DATE, CHAT_DATE)
                assertTrue(
                    it.saveProjects(
                        ProjectCheckpoint(ProjectArchive(listOf(project), null, 0)),
                        100,
                    )
                )
            }
        withCatchUpModel(service, chatCache = cache(root, dispatcher)) { model ->
            model.refresh()
            advanceUntilIdle()
            assertEquals(1, service.projectReads)
            assertEquals(ChatListSource.Cache, model.uiState.value.projectsSource)
            assertTrue(model.uiState.value.canRenameProject)
            exercise(model, diskCache)
        }
    }

    @Test
    fun unconfirmedProjectRenameRetriesWithTheOriginalIdAndIgnoresRetiredRejection() = runTest {
        val service = HeldProjectRenameService()
        var authorized = true
        withCatchUpModel(service, authorized = { authorized }) { model ->
            model.refresh()
            advanceUntilIdle()
            model.renameProject(CHAT_PROJECT, "After")
            runCurrent()
            val originalId = service.sent.single()
            service.response.completeExceptionally(ApiFailure.Network(IOException("Lost response")))
            advanceUntilIdle()
            assertEquals(setOf(CHAT_PROJECT), model.uiState.value.unconfirmedProjectRenames)
            assertNull(model.uiState.value.projectRenameRejection)

            service.response = CompletableDeferred()
            model.retryProjectRename(CHAT_PROJECT)
            runCurrent()
            assertEquals(listOf(originalId, originalId), service.sent)
            authorized = false
            val replacementStore = ViewModelStore()
            val dispatcher = StandardTestDispatcher(testScheduler)
            try {
                val replacement =
                    ViewModelProvider(
                        replacementStore,
                        viewModelFactory {
                            initializer {
                                ChatListModel(
                                    HeldProjectRenameService(projectName = "Other workspace"),
                                    cache(temporary.newFolder(), dispatcher),
                                    identity.copy(workspaceId = "org-b"),
                                    { true },
                                    {},
                                    dispatcher,
                                )
                            }
                        },
                    )[ChatListModel::class.java]
                replacement.refresh()
                advanceUntilIdle()
                val replacementProjects = replacement.uiState.value.projectList
                assertEquals("Other workspace", replacementProjects.rows.single().name)

                service.response.completeExceptionally(ApiFailure.Http(404, null, null, null))
                advanceUntilIdle()
                assertNull(model.uiState.value.projectRenameRejection)
                assertEquals(replacementProjects, replacement.uiState.value.projectList)
            } finally {
                replacementStore.clear()
                runCurrent()
            }
        }
    }

    @Test
    fun observedProjectRenameReceiptTakesPrecedenceOverRejectedRetry() = runTest {
        val service = HeldProjectRenameService()
        withCatchUpModel(service) { model ->
            model.refresh()
            advanceUntilIdle()
            model.renameProject(CHAT_PROJECT, "After")
            runCurrent()
            val originalId = service.sent.single()
            service.response.completeExceptionally(ApiFailure.Network(IOException("Lost response")))
            advanceUntilIdle()

            service.response = CompletableDeferred()
            model.retryProjectRename(CHAT_PROJECT)
            runCurrent()
            assertEquals(listOf(originalId, originalId), service.sent)
            service.receipt =
                ProjectEventsEventsItem(
                    id = CHAT_EVENT,
                    seqId = 1,
                    projectId = CHAT_PROJECT,
                    kind = ProjectEventsEventsItemKind.RENAMED,
                    name = "From another client",
                    createdAt = CHAT_DATE,
                )
            model.refreshMetadata()
            advanceUntilIdle()
            assertEquals("After", model.uiState.value.projects.single().name)
            assertEquals(CHAT_PROJECT, model.uiState.value.renamingProjectId)

            service.receipt =
                ProjectEventsEventsItem(
                    id = originalId,
                    seqId = 2,
                    projectId = CHAT_PROJECT,
                    kind = ProjectEventsEventsItemKind.RENAMED,
                    name = "After",
                    createdAt = CHAT_DATE,
                )
            model.refreshMetadata()
            advanceUntilIdle()
            service.response.completeExceptionally(ApiFailure.Http(409, "CONFLICT", null, null))
            advanceUntilIdle()

            val state = model.uiState.value
            assertEquals("After", state.projects.single().name)
            assertNull(state.projectRenameRejection)
            assertNull(state.renamingProjectId)
            assertTrue(state.unconfirmedProjectRenames.isEmpty())
        }
    }

    @Test
    fun laterProjectRenameReceiptClearsOnlyItsRejection() = runTest {
        val service = HeldProjectRenameService()
        withCatchUpModel(service) { model ->
            model.refresh()
            advanceUntilIdle()
            model.renameProject(CHAT_PROJECT, "After")
            runCurrent()
            val originalId = service.sent.single()
            service.response.completeExceptionally(ApiFailure.Network(IOException("Lost response")))
            advanceUntilIdle()
            assertEquals(setOf(CHAT_PROJECT), model.uiState.value.unconfirmedProjectRenames)

            service.response = CompletableDeferred()
            model.retryProjectRename(CHAT_PROJECT)
            runCurrent()
            assertEquals(listOf(originalId, originalId), service.sent)

            val unrelated =
                ProjectEventsEventsItem(
                    id = CHAT_EVENT,
                    seqId = 1,
                    projectId = CHAT_PROJECT,
                    kind = ProjectEventsEventsItemKind.RENAMED,
                    name = "After",
                    createdAt = CHAT_DATE,
                )
            val eventRead = CompletableDeferred<Unit>()
            service.receipt = unrelated
            service.nextProjectRead = eventRead
            model.refreshMetadata()
            runCurrent()

            service.response.completeExceptionally(ApiFailure.Http(409, "CONFLICT", null, null))
            runCurrent()
            val rejection = ProjectRenameRejection(CHAT_PROJECT, originalId)
            val rejected = model.uiState.value
            assertEquals(ChatReadPhase.Loading, rejected.projectsPhase)
            assertEquals("Before", rejected.projects.single().name)
            assertEquals(rejection, rejected.projectRenameRejection)

            eventRead.complete(Unit)
            advanceUntilIdle()
            val afterUnrelatedReceipt = model.uiState.value
            assertEquals("After", afterUnrelatedReceipt.projects.single().name)
            assertEquals(rejection, afterUnrelatedReceipt.projectRenameRejection)

            service.receipt = unrelated.copy(id = originalId, seqId = 2)
            model.refreshMetadata()
            advanceUntilIdle()
            val afterMatchingReceipt = model.uiState.value
            assertEquals("After", afterMatchingReceipt.projects.single().name)
            assertNull(afterMatchingReceipt.projectRenameRejection)
        }
    }

    private inner class HeldProjectRenameService(
        initialRead: CompletableDeferred<Unit>? = null,
        private val projectName: String = "Before",
    ) : Service() {
        var response = CompletableDeferred<Unit>()
        val sent = mutableListOf<String>()
        var projectReads = 0
        var nextProjectRead = initialRead
        var receipt: ProjectEventsEventsItem? = null

        override suspend fun projectSnapshot() =
            ProjectSnapshotVariant1(
                listOf(
                    ProjectSnapshotVariant1ProjectsItem(
                        CHAT_PROJECT,
                        projectName,
                        CHAT_DATE,
                        CHAT_DATE,
                    )
                ),
                latestEventId = null,
                latestSeqId = 0,
            )

        override suspend fun projectEvents(since: Long): ProjectEvents {
            projectReads++
            val result = ProjectEvents(listOfNotNull(receipt?.takeIf { it.seqId > since }), false)
            val read = nextProjectRead
            nextProjectRead = null
            read?.await()
            return result
        }

        override suspend fun renameProject(projectId: String, name: String, eventId: String) {
            sent += eventId
            response.await()
        }
    }

    @Test
    fun observedProjectRenameStaysConfirmedWhenTheResponseIsLostOffline() = runTest {
        val connected = MutableStateFlow(true)
        val response = CompletableDeferred<Unit>()
        var event: ProjectEventsEventsItem? = null
        val service =
            object : Service() {
                override suspend fun projectSnapshot() =
                    ProjectSnapshotVariant1(
                        listOf(
                            ProjectSnapshotVariant1ProjectsItem(
                                CHAT_PROJECT,
                                "Before",
                                CHAT_DATE,
                                CHAT_DATE,
                            )
                        ),
                        latestEventId = null,
                        latestSeqId = 0,
                    )

                override suspend fun renameProject(
                    projectId: String,
                    name: String,
                    eventId: String,
                ) {
                    event =
                        ProjectEventsEventsItem(
                            id = eventId,
                            seqId = 1,
                            projectId = projectId,
                            kind = ProjectEventsEventsItemKind.RENAMED,
                            name = name,
                            createdAt = CHAT_DATE,
                        )
                    response.await()
                }

                override suspend fun projectEvents(since: Long) =
                    ProjectEvents(listOfNotNull(event?.takeIf { it.seqId > since }), false)
            }
        withCatchUpModel(service, connectivity = connected) { model ->
            model.refresh()
            advanceUntilIdle()
            model.renameProject(CHAT_PROJECT, "After")
            runCurrent()
            assertNotNull(event)
            model.refreshMetadata()
            advanceUntilIdle()
            connected.value = false
            runCurrent()
            assertTrue(model.uiState.value.offline)
            response.completeExceptionally(ApiFailure.Network(IOException("Lost Project response")))
            advanceUntilIdle()

            val state = model.uiState.value
            assertEquals("After", state.projects.single().name)
            assertNull(state.renamingProjectId)
            assertTrue(state.unconfirmedProjectRenames.isEmpty())
        }
    }

    @Test
    fun unchangedProjectsSkipDiskButRetryAnEarlierFailedCommit() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val root = temporary.newFolder()
        val cache = cache(root, dispatcher)
        val store = ViewModelStore()
        var page = ProjectEvents(emptyList(), false)
        val service =
            object : TestChatService() {
                override suspend fun projectSnapshot() =
                    json.decodeFromString<ProjectSnapshot>(
                        """{"projects":[{"id":"$CHAT_PROJECT","name":"Before","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}],"latestEventId":null,"latestSeqId":0}"""
                    )

                override suspend fun projectEvents(since: Long) = page
            }
        try {
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            ChatListModel(service, cache, identity, { true }, {}, dispatcher)
                        }
                    },
                )[ChatListModel::class.java]
            model.refresh()
            advanceUntilIdle()
            assertEquals("Before", model.uiState.value.projects.single().name)
            assertFalse(model.uiState.value.projectCacheUnavailable)
            page =
                ProjectEvents(
                    listOf(
                        ProjectEventsEventsItem(
                            id = CHAT_EVENT,
                            seqId = 17,
                            projectId = CHAT_IN_PROJECT,
                            kind = ProjectEventsEventsItemKind.RENAMED,
                            name = "Missing project",
                            createdAt = CHAT_DATE,
                        )
                    ),
                    false,
                )
            model.refreshMetadata()
            advanceUntilIdle()
            assertEquals(ChatReadPhase.Failed, model.uiState.value.projectsPhase)
            assertEquals("Before", model.uiState.value.projects.single().name)
            page = ProjectEvents(emptyList(), false)
            execute(
                root,
                "CREATE TRIGGER fail_project_write BEFORE INSERT ON project_scopes BEGIN SELECT RAISE(ABORT, 'disk failure fixture'); END",
            )
            model.refreshMetadata()
            advanceUntilIdle()
            assertEquals(ChatReadPhase.Ready, model.uiState.value.projectsPhase)
            assertFalse(model.uiState.value.projectCacheUnavailable)
            page =
                json.decodeFromString<ProjectEvents>(
                    """{"events":[{"id":"$CHAT_EVENT","seqId":17,"projectId":"$CHAT_PROJECT","kind":"renamed","name":"After","createdAt":"$CHAT_DATE"}],"hasMore":false}"""
                )
            model.refreshMetadata()
            advanceUntilIdle()
            assertEquals("After", model.uiState.value.projects.single().name)
            assertTrue(model.uiState.value.projectCacheUnavailable)
            execute(root, "DROP TRIGGER fail_project_write")
            model.refreshMetadata()
            advanceUntilIdle()
            assertEquals("After", model.uiState.value.projects.single().name)
            assertFalse(model.uiState.value.projectCacheUnavailable)
            store.clear()
            runCurrent()
            cache
                .open(identity) { true }
                .use {
                    val saved = checkNotNull(it.loadProjects())
                    assertEquals(17L, saved.checkpoint.cursor.seqId)
                    assertEquals("After", replayProjects(saved.checkpoint).single().name)
                }
        } finally {
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun projectRefreshPublishesTheNewerCheckpointPreservedOnDisk() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val root = temporary.newFolder()
        val modelCache = cache(root, dispatcher)
        val diskCache = cache(root, dispatcher)
        val store = ViewModelStore()
        val project = ConfirmedProject(CHAT_PROJECT, "From disk", CHAT_DATE, CHAT_DATE)
        val service =
            object : TestChatService() {
                override suspend fun projectSnapshot(): ProjectSnapshot {
                    diskCache
                        .open(identity) { true }
                        .use {
                            assertTrue(
                                it.saveProjects(
                                    ProjectCheckpoint(
                                        ProjectArchive(listOf(project), CHAT_EVENT, 17)
                                    ),
                                    100,
                                )
                            )
                        }
                    return ProjectSnapshotVariant1(emptyList(), null, 0)
                }

                override suspend fun projectEvents(since: Long) = ProjectEvents(emptyList(), false)
            }
        try {
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            ChatListModel(service, modelCache, identity, { true }, {}, dispatcher)
                        }
                    },
                )[ChatListModel::class.java]
            model.refresh()
            advanceUntilIdle()
            assertEquals(listOf(project), model.uiState.value.projects)
            assertFalse(model.uiState.value.projectCacheUnavailable)
        } finally {
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun networkListBecomesVisibleOnlyAfterTheDiskWriteCommits() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val cache = cache(temporary.newFolder())
        val store = ViewModelStore()
        val entered = CompletableDeferred<Unit>()
        val release = CountDownLatch(1)
        val holdWrite = AtomicBoolean(false)
        var owner: Job? = null
        try {
            val service = Service().apply { listRead = { page().also { holdWrite.set(true) } } }
            val authorized = {
                if (
                    Thread.currentThread().name.startsWith("DefaultDispatcher") &&
                        holdWrite.compareAndSet(true, false)
                ) {
                    entered.complete(Unit)
                    release.await()
                }
                true
            }
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            ChatListModel(service, cache, identity, authorized, {}, dispatcher)
                        }
                    },
                )[ChatListModel::class.java]
            owner = model.viewModelScope.coroutineContext[Job]
            model.refreshList()
            entered.await()
            assertEquals(ChatReadPhase.Loading, model.uiState.value.listPhase)
            assertNull(model.uiState.value.source)
            assertTrue(model.uiState.value.threads.isEmpty())
            release.countDown()
            val published = model.uiState.first { it.listPhase == ChatReadPhase.Ready }
            assertEquals(ChatListSource.Network, published.source)
            assertEquals("Personal chat", published.threads.single().title)
            store.clear()
            owner?.join()
            cache
                .open(identity) { true }
                .use {
                    assertEquals(published.confirmedAt, it.load()?.confirmedAt)
                    assertEquals(published.threads, replayChats(checkNotNull(it.load()).checkpoint))
                }
        } finally {
            release.countDown()
            store.clear()
            owner?.join()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun persistenceFailureLeavesTheConfirmedNetworkListUsableAndExplicitlyUnsaved() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val store = ViewModelStore()
        try {
            val cache = cache(temporary.newFile(), dispatcher)
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            ChatListModel(
                                Service(),
                                cache,
                                identity,
                                { true },
                                { fail("Cache failure must not retire the workspace") },
                                dispatcher,
                            )
                        }
                    },
                )[ChatListModel::class.java]
            model.refresh()
            advanceUntilIdle()
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertEquals("Personal chat", model.uiState.value.threads.single().title)
            assertTrue(model.uiState.value.cacheUnavailable)
            assertEquals(ChatListSource.Network, model.uiState.value.source)
        } finally {
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun heldProjectSnapshotDoesNotBlockTheListAndFailureRetainsConfirmedContent() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val cache = cache(temporary.newFolder(), dispatcher)
        val store = ViewModelStore()
        val snapshot = CompletableDeferred<ProjectSnapshot>()
        try {
            val service =
                object : Service() {
                    override suspend fun projectSnapshot() = snapshot.await()
                }
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            ChatListModel(service, cache, identity, { true }, {}, dispatcher)
                        }
                    },
                )[ChatListModel::class.java]
            model.refresh()
            runCurrent()
            assertEquals(ChatListSource.Network, model.uiState.value.source)
            assertEquals("Personal chat", model.uiState.value.threads.single().title)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.agentsPhase)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.indicatorsPhase)
            snapshot.completeExceptionally(IOException("offline"))
            advanceUntilIdle()
            assertEquals(ChatReadPhase.Failed, model.uiState.value.projectsPhase)
            assertEquals("Personal chat", model.uiState.value.threads.single().title)
            store.clear()
            cache
                .open(identity) { true }
                .use {
                    assertEquals(
                        "Personal chat",
                        replayChats(checkNotNull(it.load()).checkpoint).single().title,
                    )
                }
        } finally {
            snapshot.cancel()
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun lateDiskRestoreDoesNotReplaceNetworkConfirmedAgentNames() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val cache = cache(temporary.newFolder())
        val checkpoint =
            ChatCheckpoint(
                ai.okou.android.api.generated.ChatArchive(emptyList()),
                ChatCursor(),
                page().events,
                ChatCursor(CHAT_EVENT, 17),
            )
        val store = ViewModelStore()
        val entered = CompletableDeferred<Unit>()
        val release = CountDownLatch(1)
        val list = CompletableDeferred<ChatEvents>()
        var owner: Job? = null
        try {
            cache
                .open(identity) { true }
                .use {
                    it.save(checkpoint, 1234, CachedChatNavigation(agents = Service().agents()))
                }
            val service =
                Service().apply {
                    listRead = { list.await() }
                    agentRead = { Service().agents().map { it.copy(displayName = "Updated Okou") } }
                }
            val authorized = {
                if (Thread.currentThread().name.startsWith("DefaultDispatcher")) {
                    entered.complete(Unit)
                    release.await()
                }
                true
            }
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            ChatListModel(service, cache, identity, authorized, {}, dispatcher)
                        }
                    },
                )[ChatListModel::class.java]
            owner = model.viewModelScope.coroutineContext[Job]
            model.refresh()
            entered.await()
            model.uiState.first { it.agentsSource == ChatListSource.Network }
            release.countDown()
            val restored = model.uiState.first { it.source == ChatListSource.Cache }
            assertEquals("Updated Okou", restored.agents.single().displayName)
            assertEquals(ChatListSource.Network, restored.agentsSource)
        } finally {
            release.countDown()
            list.completeExceptionally(IOException("offline"))
            store.clear()
            owner?.join()
            runCurrent()
            Dispatchers.resetMain()
        }
    }
}
