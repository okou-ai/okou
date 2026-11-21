package ai.okou.android.chat

import ai.okou.android.CHAT_AGENT
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_EVENT
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
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
import ai.okou.android.api.generated.ProjectEvents
import ai.okou.android.api.generated.ProjectSnapshot
import ai.okou.android.api.generated.ReadState
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.chatEventWire
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

    private suspend fun TestScope.withCatchUpModel(
        service: ChatListService,
        realtime: TestRealtimeService? = null,
        connectivity: MutableStateFlow<Boolean> = MutableStateFlow(true),
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
                                cache(temporary.newFolder(), dispatcher),
                                identity,
                                { true },
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
            assertEquals(ChatRowAction.MarkUnread, model.uiState.value.failedRowAction)
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
            assertEquals(ChatRowAction.MarkUnread, model.uiState.value.failedRowAction)

            model.dismissRowActionFailure(ChatRowAction.MarkUnread)
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
            assertEquals(ChatRowAction.MarkUnread, model.uiState.value.failedRowAction)
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
    fun writeDuringOlderReadGetsOneTrailingReadWhenNotificationIsMissed() = runTest {
        val events = mutableListOf(chatEventWire())
        var reads = 0
        val olderRead = CompletableDeferred<Unit>()
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
                        chatEventWire(id = eventId, seq = 18, kind = "renamed", title = title)
                    )
                }
            }
        withCatchUpModel(service) { model ->
            model.refresh()
            advanceUntilIdle()
            val initialReads = reads
            source.listRead = {
                reads++
                val captured = page(events)
                if (reads == initialReads + 1) olderRead.await()
                captured
            }

            model.refreshList()
            runCurrent()
            model.renameThread(CHAT_PERSONAL, "Local edit")
            model.reloadAfterRowActionFailure()
            runCurrent()
            assertEquals(initialReads + 1, reads)
            assertEquals(ChatRowAction.Rename, model.uiState.value.pendingRowActions[CHAT_PERSONAL])

            olderRead.complete(Unit)
            advanceUntilIdle()
            assertEquals(initialReads + 2, reads)
            assertTrue(model.uiState.value.pendingRowActions.isEmpty())
            assertNull(model.uiState.value.failedRowAction)

            events.add(
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
            assertEquals(ChatRowAction.Rename, model.uiState.value.failedRowAction)
            model.dismissRowActionFailure(ChatRowAction.Rename)

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
