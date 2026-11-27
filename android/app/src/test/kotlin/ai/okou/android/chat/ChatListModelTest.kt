package ai.okou.android.chat

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
import java.net.ConnectException
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
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

private val ChatListUiState.failedRowAction
    get() = rowActionFailures.lastOrNull()
private val ChatListUiState.markAllReadResult
    get() = markAllReadResults.lastOrNull()

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
internal abstract class ChatListModelTestFixture {
    @get:Rule val temporary = TemporaryFolder()
    private val caches = mutableListOf<ChatCacheStore>()

    protected fun cache(directory: File, dispatcher: CoroutineDispatcher = Dispatchers.IO) =
        ChatCacheStore(ApplicationProvider.getApplicationContext(), directory, dispatcher).also {
            caches += it
        }

    @After fun closeCaches() = runBlocking { caches.forEach { it.close() } }

    protected fun execute(root: File, sql: String) {
        BundledSQLiteDriver().open(root.resolve("chats.db").path).use { connection ->
            connection.prepare(sql).use { it.step() }
        }
    }

    protected val identity =
        WorkspaceIdentity("https://api.okou.ai/", "user-a", "session-a", "org-a", "member")
    protected val json = Json { ignoreUnknownKeys = true }

    protected fun page(seq: Long = 17) =
        json.decodeFromString<ChatEvents>(
            """{"events":[${chatEventWire(seq = seq)}],"hasMore":false}""",
        )

    protected fun page(events: List<String>) =
        json.decodeFromString<ChatEvents>(
            """{"events":[${events.joinToString(",")}],"hasMore":false}""",
        )

    protected open inner class Service : TestChatService() {
        var listRead: suspend () -> ChatEvents = { page() }
        var statusRead: suspend () -> Indicators = {
            Indicators(mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD), emptyMap())
        }

        override suspend fun chatSnapshot() =
            json.decodeFromString<ChatSnapshot>(
                """{"chatThreads":[],"latestEventId":null,"latestSeqId":null}""",
            )

        override suspend fun chatEvents(since: Long?) = listRead()

        override suspend fun indicators() = statusRead()
    }

    protected inner class ArchiveService : Service() {
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
        var afterUnarchive: () -> Unit = {}
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
                    ),
            )
            if (!archived) afterUnarchive()
        }
    }

    protected suspend fun TestScope.withCatchUpModel(
        service: ChatListService,
        realtime: TestRealtimeService? = null,
        authorized: () -> Boolean = { true },
        chatCache: ChatCacheStore? = null,
        wallMillis: () -> Long = System::currentTimeMillis,
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
                                wallMillis = wallMillis,
                                monotonicMillis = { testScheduler.currentTime },
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

    protected fun unreadModel(
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

    protected fun pinnedEvents(
        vararg threads: String,
        pinOrder: (Int) -> String = { "a0" },
    ): List<String> {
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
                    extra = ""","pinOrder":"${pinOrder(index)}"""",
                ),
            )
        }
    }

    protected suspend fun TestScope.withCachedProjectRename(
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
                    ),
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

    protected inner class ProjectOrganizationService(
        private val additionalProjectId: String? = null,
    ) : Service() {
        private val events =
            mutableListOf(
                17L to chatEventWire(),
                18L to
                    chatEventWire(
                        id = "00000018-0000-4000-8000-000000000000",
                        seq = 18,
                        thread = CHAT_IN_PROJECT,
                        extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                    ),
                19L to
                    chatEventWire(
                        id = "00000019-0000-4000-8000-000000000000",
                        seq = 19,
                        kind = "pinned",
                        extra = ",\"pinOrder\":\"a0\"",
                    ),
                20L to
                    chatEventWire(
                        id = "00000020-0000-4000-8000-000000000000",
                        seq = 20,
                        thread = CHAT_IN_PROJECT,
                        kind = "pinned",
                        extra = ",\"pinOrder\":\"a2\"",
                    ),
            )
        private val projectEvents = mutableListOf<ProjectEventsEventsItem>()
        var chatReadUnavailable = false
        val moveIds = mutableListOf<String>()
        val deleteIds = mutableListOf<String>()
        var moveResponse: suspend (String, String?, String) -> Unit = { _, _, _ ->
            error("Unexpected move")
        }
        var deleteResponse: suspend (String) -> Unit = { error("Unexpected deletion") }

        override suspend fun indicators() =
            Indicators(mapOf(CHAT_IN_PROJECT to IndicatorsThreadsValue.ACTIVE), emptyMap())

        override suspend fun chatEvents(since: Long?): ChatEvents {
            if (chatReadUnavailable) throw ApiFailure.Http(503, null, null, null)
            return page(events.filter { it.first > (since ?: 0) }.map { it.second })
        }

        override suspend fun projectSnapshot() =
            ProjectSnapshotVariant1(
                listOfNotNull(
                    ProjectSnapshotVariant1ProjectsItem(
                        CHAT_PROJECT,
                        "Research",
                        CHAT_DATE,
                        CHAT_DATE,
                    ),
                    additionalProjectId?.let {
                        ProjectSnapshotVariant1ProjectsItem(it, "Operations", CHAT_DATE, CHAT_DATE)
                    },
                ),
                null,
                0,
            )

        override suspend fun projectEvents(since: Long) =
            ProjectEvents(projectEvents.filter { it.seqId > since }, false)

        override suspend fun moveThreadToProject(
            threadId: String,
            projectId: String?,
            eventId: String,
        ) {
            moveIds += eventId
            moveResponse(threadId, projectId, eventId)
        }

        override suspend fun deleteProject(projectId: String, eventId: String) {
            assertEquals(CHAT_PROJECT, projectId)
            deleteIds += eventId
            deleteResponse(eventId)
        }

        fun publishMembership(thread: String, project: String?, event: String) {
            val sequence = events.last().first + 1
            val target = project?.let { "\"$it\"" } ?: "null"
            events +=
                sequence to
                    chatEventWire(
                        id = event,
                        seq = sequence,
                        thread = thread,
                        kind = "project_updated",
                        extra = ",\"projectId\":$target",
                    )
        }

        fun publishRename(event: String, name: String) {
            publishProjectEvent(event, ProjectEventsEventsItemKind.RENAMED, name)
        }

        fun publishDeletion(event: String) {
            publishProjectEvent(event, ProjectEventsEventsItemKind.DELETED, null)
            publishMembership(CHAT_IN_PROJECT, null, "00000021-0000-4000-8000-000000000000")
        }

        private fun publishProjectEvent(
            event: String,
            kind: ProjectEventsEventsItemKind,
            name: String?,
        ) {
            projectEvents +=
                ProjectEventsEventsItem(
                    id = event,
                    seqId = projectEvents.size.toLong() + 1,
                    projectId = CHAT_PROJECT,
                    kind = kind,
                    name = name,
                    createdAt = CHAT_DATE,
                )
        }
    }

    protected inner class HeldProjectRenameService(
        initialRead: CompletableDeferred<Unit>? = null,
        private val projectName: String = "Before",
    ) : Service() {
        var response = CompletableDeferred<Unit>()
        val sent = mutableListOf<String>()
        var projectReads = 0
        var nextProjectRead = initialRead
        var projectSnapshots = 0
        var collectionUnavailable = false
        var receipt: ProjectEventsEventsItem? = null
        var responseName: String? = null

        override suspend fun projectSnapshot(): ProjectSnapshotVariant1 {
            projectSnapshots++
            return ProjectSnapshotVariant1(
                listOf(
                    ProjectSnapshotVariant1ProjectsItem(
                        CHAT_PROJECT,
                        projectName,
                        CHAT_DATE,
                        CHAT_DATE,
                    ),
                ),
                latestEventId = null,
                latestSeqId = 0,
            )
        }

        override suspend fun projectEvents(since: Long): ProjectEvents {
            projectReads++
            if (collectionUnavailable) throw ApiFailure.Http(404, null, null, null)
            val result = ProjectEvents(listOfNotNull(receipt?.takeIf { it.seqId > since }), false)
            val read = nextProjectRead
            nextProjectRead = null
            read?.await()
            return result
        }

        override suspend fun renameProject(
            projectId: String,
            name: String,
            eventId: String,
        ): ConfirmedProject {
            sent += eventId
            response.await()
            return ConfirmedProject(projectId, responseName ?: name, CHAT_DATE, CHAT_DATE, "a0")
        }
    }
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
internal class ChatListModelTest : ChatListModelTestFixture() {
    @Test
    fun anUnconfirmedRenameBackToAnOlderTitleNeedsNewEvidence() = runTest {
        val events = mutableListOf<String>()
        var showEvents = false
        val source =
            object : Service() {
                override suspend fun chatEvents(since: Long?): ChatEvents =
                    when {
                        since == null -> page()
                        showEvents -> page(events)
                        else -> throw ApiFailure.Http(503, null, null, null)
                    }

                override suspend fun renameThread(
                    threadId: String,
                    title: String,
                    eventId: String,
                ) {
                    events +=
                        chatEventWire(
                            id = eventId,
                            seq = 18 + events.size.toLong(),
                            kind = "renamed",
                            title = title,
                        )
                    if (events.size == 2) throw ApiFailure.Http(503, null, null, null)
                }
            }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            val first = checkNotNull(model.renameThread(CHAT_PERSONAL, "Confirmed title"))
            runCurrent()
            assertEquals("Confirmed title", model.uiState.value.threads.single().title)

            val second = checkNotNull(model.renameThread(CHAT_PERSONAL, "Personal chat"))
            runCurrent()
            val unconfirmed = model.uiState.value
            assertEquals("Confirmed title", unconfirmed.threads.single().title)
            assertEquals(second, unconfirmed.unconfirmedRenames[CHAT_PERSONAL])
            assertEquals(first.eventId, unconfirmed.confirmedRenameIds[CHAT_PERSONAL])
            assertNull(model.renameThread(CHAT_PERSONAL, "Duplicate edit"))

            showEvents = true
            model.checkChatRename(CHAT_PERSONAL)
            runCurrent()
            val confirmed = model.uiState.value
            assertEquals("Personal chat", confirmed.threads.single().title)
            assertTrue(confirmed.unconfirmedRenames.isEmpty())
            assertEquals(second.eventId, confirmed.confirmedRenameIds[CHAT_PERSONAL])
        }
    }

    @Test
    fun anAmbiguousRenameSettlesWhenTheServerAlreadyShowsTheSubmittedTitle() = runTest {
        var tail = page(emptyList())
        val service =
            object : Service() {
                override suspend fun chatEvents(since: Long?) = if (since == null) page() else tail

                override suspend fun renameThread(
                    threadId: String,
                    title: String,
                    eventId: String,
                ) {
                    tail =
                        page(
                            listOf(
                                chatEventWire(
                                    id = HISTORY_LAST_EVENT,
                                    seq = 18,
                                    kind = "renamed",
                                    title = title,
                                ),
                            ),
                        )
                    throw ApiFailure.Http(503, null, null, null)
                }
            }
        withCatchUpModel(service) { model ->
            model.refresh()
            advanceUntilIdle()
            assertNotNull(model.renameThread(CHAT_PERSONAL, "Requested title"))
            advanceUntilIdle()

            val settled = model.uiState.value
            assertEquals("Requested title", settled.threads.single().title)
            assertTrue(settled.unconfirmedRenames.isEmpty())
            assertNull(settled.failedRowAction)
        }
    }

    @Test
    fun chatRenameKeepsItsReceiptUntilAnEarlierSnapshotReadFinishes() = runTest {
        val write = CompletableDeferred<Unit>()
        val earlierRead = CompletableDeferred<Unit>()
        val readback = CompletableDeferred<Unit>()
        val initialEvents = page().events
        val initialRows =
            replayChats(
                ChatCheckpoint(
                    ChatArchive(emptyList()),
                    ChatCursor(),
                    initialEvents,
                    initialEvents.single().cursor(),
                ),
            )
        val earlierSnapshot =
            ChatSnapshotVariant1("https://fixture.test/earlier", 60, HISTORY_LAST_EVENT, 18)
        val laterSnapshot =
            ChatSnapshotVariant1(
                "https://fixture.test/later",
                60,
                "00000020-0000-4000-8000-000000000000",
                20,
            )
        var snapshotReads = 0
        var earlierTailRead = false
        val service =
            object : Service() {
                override suspend fun chatSnapshot() =
                    when (++snapshotReads) {
                        1 -> super.chatSnapshot()
                        2 -> earlierSnapshot
                        else -> {
                            readback.await()
                            laterSnapshot
                        }
                    }

                override suspend fun chatArchive(url: String): ChatArchive {
                    val title =
                        if (url == earlierSnapshot.url) "Earlier remote title" else "Later title"
                    return ChatArchive(listOf(initialRows.single().copy(title = title)))
                }

                override suspend fun chatEvents(since: Long?) =
                    when {
                        since == null -> page()
                        since == 18L && !earlierTailRead -> {
                            earlierTailRead = true
                            earlierRead.await()
                            page(emptyList())
                        }
                        since == 20L -> page(emptyList())
                        else -> throw ApiFailure.Http(410, null, null, null)
                    }

                override suspend fun renameThread(
                    threadId: String,
                    title: String,
                    eventId: String,
                ) {
                    write.await()
                }
            }
        withCatchUpModel(service) { model ->
            model.refresh()
            advanceUntilIdle()
            assertNotNull(model.renameThread(CHAT_PERSONAL, "Receipt title"))
            model.refreshList()
            runCurrent()
            assertTrue(earlierTailRead)

            write.complete(Unit)
            runCurrent()
            assertEquals("Receipt title", model.uiState.value.threads.single().title)
            earlierRead.complete(Unit)
            runCurrent()
            assertEquals("Receipt title", model.uiState.value.threads.single().title)
            assertEquals(ChatReadPhase.Loading, model.uiState.value.listPhase)

            readback.complete(Unit)
            advanceUntilIdle()
            assertEquals("Later title", model.uiState.value.threads.single().title)
            assertTrue(model.uiState.value.unconfirmedRenames.isEmpty())
        }
    }

    @Test
    fun confirmedChatRenameKeepsANewerWritePendingOnLateRejection() = runTest {
        val firstResponse = CompletableDeferred<Unit>()
        val secondResponse = CompletableDeferred<Unit>()
        var event: String? = null
        val service =
            object : Service() {
                override suspend fun chatEvents(since: Long?): ChatEvents =
                    when {
                        since == null -> page()
                        since < 18 -> page(listOfNotNull(event))
                        else -> page(emptyList())
                    }

                override suspend fun renameThread(
                    threadId: String,
                    title: String,
                    eventId: String,
                ) {
                    if (title == "First title") firstResponse.await() else secondResponse.await()
                }
            }
        withCatchUpModel(service) { model ->
            model.refresh()
            advanceUntilIdle()
            val first = checkNotNull(model.renameThread(CHAT_PERSONAL, "First title"))
            runCurrent()
            event = chatEventWire(first.eventId, 18, kind = "renamed", title = first.name)
            model.refreshList()
            advanceUntilIdle()
            assertNull(model.uiState.value.pendingRowActions[CHAT_PERSONAL])

            val second = checkNotNull(model.renameThread(CHAT_PERSONAL, "Second title"))
            runCurrent()
            firstResponse.completeExceptionally(ApiFailure.Http(400, null, null, null))
            runCurrent()
            val pending = model.uiState.value
            assertEquals(ChatRowAction.Rename, pending.pendingRowActions[CHAT_PERSONAL])
            assertEquals(first.name, pending.threads.single().title)
            assertNull(pending.failedRowAction)

            secondResponse.complete(Unit)
            advanceUntilIdle()
            val confirmed = model.uiState.value
            assertEquals(second.eventId, confirmed.confirmedRenameIds[CHAT_PERSONAL])
            assertEquals(second.name, confirmed.threads.single().title)
            assertNull(confirmed.pendingRowActions[CHAT_PERSONAL])
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
        val pending =
            PendingText(
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                CHAT_PERSONAL,
                null,
                json.decodeFromString<SendRequestVariant1>(
                    """{"prompt":"Hello","threadId":"$CHAT_PERSONAL",
                            "userMessage":{"version":1,"parts":[{"type":"text","text":"Hello"}]},
                            "hasTextContent":true,
                            "chatThreadSortEventId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}""",
                ),
                TextStage.Sending,
            )
        withCatchUpModel(service) { model ->
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
                        ),
                    ),
                )
            }
            model.refreshList()
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
                            "chatThreadSortEventId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}""",
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
                advanceTimeBy(2_999)
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
    fun archiveReadbackUsesItsRetryAfterForTheNextListAttempt() = runTest {
        val source = ArchiveService()
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()

            val startedAt = testScheduler.currentTime
            val reads = mutableListOf<Long>()
            source.beforeEvents = {
                reads.add(testScheduler.currentTime - startedAt)
                when (reads.size) {
                    1 -> throw ApiFailure.Http(503, null, null, 30)
                    2 -> throw ApiFailure.Http(503, null, null, 1)
                    else -> Unit
                }
            }

            model.refreshList()
            runCurrent()
            assertEquals(listOf(0L), reads)

            advanceTimeBy(1_000)
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.Archive))
            runCurrent()
            assertEquals(listOf(0L, 1_000L), reads)
            assertEquals(ChatListReadFailure.Retrying, model.uiState.value.listReadFailure)

            advanceTimeBy(999)
            runCurrent()
            assertEquals(listOf(0L, 1_000L), reads)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(listOf(0L, 1_000L, 2_000L), reads)
            assertTrue(
                model.uiState.value.confirmedThreads.single { it.id == CHAT_PERSONAL }.archived,
            )
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)

            advanceTimeBy(28_000)
            runCurrent()
            assertEquals(listOf(0L, 1_000L, 2_000L), reads)
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
                        chatEventWire(id = HISTORY_LAST_EVENT, seq = 18, thread = preview.threadId),
                    ),
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
                    ),
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
            cache.open(identity) { true }.use { it.save(checkpoint, 1234) }
            val service =
                Service().apply {
                    listRead = { gate.await() }
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
    fun cachedChatsStayInTheirScopeUntilProjectMetadataAndChatMembershipConverge() = runTest {
        val root = temporary.newFolder()
        val cache = cache(root, StandardTestDispatcher(testScheduler))
        val project = ConfirmedProject(CHAT_PROJECT, "Research", CHAT_DATE, CHAT_DATE)
        val cachedEvents =
            page(
                    listOf(
                        chatEventWire(),
                        chatEventWire(
                            id = "77777777-7777-4777-8777-777777777777",
                            seq = 18,
                            thread = CHAT_IN_PROJECT,
                            extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                        ),
                    ),
                )
                .events
        cache
            .open(identity) { true }
            .use {
                it.save(
                    ChatCheckpoint(
                        ChatArchive(emptyList()),
                        ChatCursor(),
                        cachedEvents,
                        cachedEvents.last().cursor(),
                    ),
                    100,
                )
                it.saveProjects(ProjectCheckpoint(ProjectArchive(listOf(project), null, 0)), 100)
            }
        execute(root, "UPDATE project_snapshot SET payload = 'invalid JSON'")

        val projectResponse = CompletableDeferred<ProjectSnapshot>()
        val chatResponse = CompletableDeferred<ChatEvents>()
        var projectTail = ProjectEvents(emptyList(), false)
        val service =
            object : Service() {
                override suspend fun chatEvents(since: Long?) = chatResponse.await()

                override suspend fun projectSnapshot() = projectResponse.await()

                override suspend fun projectEvents(since: Long) = projectTail
            }
        withCatchUpModel(service, chatCache = cache) { model ->
            model.refresh()
            runCurrent()
            val cached = model.uiState.value
            assertEquals(ChatListSource.Cache, cached.source)
            assertEquals(ChatReadPhase.Loading, cached.projectsPhase)
            assertNull(cached.projectsSource)
            assertTrue(cached.projectCacheUnavailable)
            val (awaitingProject, outside) = chatListGroups(cached)
            assertNull(awaitingProject.project)
            assertEquals(CHAT_PROJECT, awaitingProject.projectId)
            assertEquals(CHAT_IN_PROJECT, awaitingProject.threads.single().id)
            assertEquals(CHAT_PERSONAL, outside.threads.single().id)

            projectResponse.complete(
                ProjectSnapshotVariant1(
                    listOf(
                        ProjectSnapshotVariant1ProjectsItem(
                            CHAT_PROJECT,
                            "Research",
                            CHAT_DATE,
                            CHAT_DATE,
                        ),
                    ),
                    null,
                    0,
                ),
            )
            runCurrent()
            val ready = model.uiState.value
            assertEquals(project, chatListGroups(ready).first().project)
            assertEquals(ChatListSource.Cache, ready.source)
            assertFalse(ready.projectCacheUnavailable)

            projectTail =
                ProjectEvents(
                    listOf(
                        ProjectEventsEventsItem(
                            id = "99999999-9999-4999-8999-999999999999",
                            seqId = 1,
                            projectId = CHAT_PROJECT,
                            kind = ProjectEventsEventsItemKind.DELETED,
                            name = project.name,
                            createdAt = CHAT_DATE,
                        ),
                    ),
                    false,
                )
            model.refreshMetadata()
            runCurrent()
            val afterDeletion = model.uiState.value
            assertEquals(ChatReadPhase.Ready, afterDeletion.projectsPhase)
            assertEquals(ChatListSource.Network, afterDeletion.projectsSource)
            assertEquals(awaitingProject, chatListGroups(afterDeletion).first())
            assertEquals(outside, chatListGroups(afterDeletion).last())

            chatResponse.complete(
                page(
                    listOf(
                        chatEventWire(
                            id = HISTORY_LAST_EVENT,
                            seq = 19,
                            thread = CHAT_IN_PROJECT,
                            kind = "project_updated",
                            extra = ",\"projectId\":null",
                        ),
                    ),
                ),
            )
            runCurrent()
            val detached = chatListGroups(model.uiState.value).single()
            assertNull(detached.projectId)
            assertEquals(
                setOf(CHAT_IN_PROJECT, CHAT_PERSONAL),
                detached.threads.map { it.id }.toSet(),
            )
        }
    }
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
internal class ChatListUnreadModelTest : ChatListModelTestFixture() {
    @Test
    fun relaunchRestoresUnreadAndAnInFlightRefreshCannotUndoALocalRead() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val root = temporary.newFolder()
        val originalStore = ViewModelStore()
        val relaunchedStore = ViewModelStore()
        val initial =
            Indicators(
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
    fun anOldUnreadSnapshotAndItsConfirmedEmptyReplacementSurviveRelaunch() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val cache = cache(temporary.newFolder(), dispatcher)
        val first = ViewModelStore()
        val next = ViewModelStore()
        val afterConfirmation = ViewModelStore()
        val confirmedAt = 1_000_000L
        val unread = mapOf(CHAT_PERSONAL to CHAT_DATE)
        val service = Service().apply { statusRead = { throw IOException("offline") } }
        val wallMillis = { confirmedAt + 86_400_000L + testScheduler.currentTime }
        try {
            cache
                .open(identity) { true }
                .use { assertTrue(it.saveUnread(CachedUnread(confirmedAt, unread))) }
            val model = unreadModel(first, cache, service, dispatcher, wallMillis)
            model.refresh()
            runCurrent()
            assertEquals(ChatReadPhase.Failed, model.uiState.value.indicatorsPhase)
            assertEquals(unread, model.uiState.value.displayUnreadAt)

            first.clear()
            val relaunched = unreadModel(next, cache, service, dispatcher, wallMillis)
            relaunched.refresh()
            runCurrent()
            assertEquals(ChatReadPhase.Failed, relaunched.uiState.value.indicatorsPhase)
            assertEquals(unread, relaunched.uiState.value.displayUnreadAt)

            service.statusRead = { Indicators(emptyMap(), emptyMap()) }
            relaunched.refreshIndicators()
            runCurrent()
            assertEquals(ChatReadPhase.Ready, relaunched.uiState.value.indicatorsPhase)
            val emptyUnread = emptyMap<String, String>()
            assertEquals(emptyUnread, relaunched.uiState.value.displayUnreadAt)

            next.clear()
            val pendingReply = CompletableDeferred<Indicators>()
            service.statusRead = { pendingReply.await() }
            val reopened = unreadModel(afterConfirmation, cache, service, dispatcher, wallMillis)
            reopened.refresh()
            reopened.selectFilter(ChatListFilter.Unread)
            runCurrent()
            val restored = reopened.uiState.value
            assertEquals(ChatReadPhase.Loading, restored.indicatorsPhase)
            assertEquals(emptyUnread, restored.displayUnreadAt)
            assertFalse(restored.waitingForUnreadIndicators)
        } finally {
            first.clear()
            next.clear()
            afterConfirmation.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun wallClockJumpDuringRefreshKeepsTheUnreadSnapshot() = runTest {
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

            // Advance wall time without advancing the coroutine test clock.
            now += 3_600_000L
            model.refresh()
            runCurrent()
            assertEquals(ChatReadPhase.Loading, model.uiState.value.indicatorsPhase)
            assertEquals(unread, model.uiState.value.displayUnreadAt)
        } finally {
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun aDefinitiveUnreadUndoSettlesWhileIndicatorsAreStillRefreshing() = runTest {
        val unread =
            Indicators(
                mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                mapOf(CHAT_PERSONAL to CHAT_DATE),
            )
        val read = Indicators(emptyMap(), emptyMap())
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
                val applying = model.uiState.value
                assertEquals(ChatUndoPhase.Applying, applying.rowUndo?.phase)
                assertTrue(applying.isUnread(CHAT_PERSONAL))
                assertFalse(CHAT_PERSONAL in checkNotNull(applying.indicators).unreadAt)

                if (rejected) receipt.completeExceptionally(ApiFailure.Http(403, null, null, null))
                else receipt.complete(ReadState(null))
                runCurrent()
                val settled = model.uiState.value
                assertEquals(ChatReadPhase.Loading, settled.indicatorsPhase)
                assertNull(settled.rowUndo)
                assertEquals(rejected, settled.rowActionFailures.singleOrNull()?.fromUndo == true)
                assertFalse(CHAT_PERSONAL in settled.pendingRowActions)
                assertEquals(!rejected, settled.isUnread(CHAT_PERSONAL))

                readback.complete(if (rejected) read else unread)
                advanceUntilIdle()
                assertEquals(!rejected, model.uiState.value.isUnread(CHAT_PERSONAL))
            }
        }
    }

    @Test
    fun anUnreadUndoWithALostResponseSettlesTheOriginalReadProjection() = runTest {
        val earlierReadback = CompletableDeferred<Indicators>()
        val unread =
            Indicators(
                mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                mapOf(CHAT_PERSONAL to CHAT_DATE),
            )
        val source =
            object : Service() {
                    override suspend fun markRead(threadId: String) = ReadState(CHAT_DATE)

                    override suspend fun markUnread(threadId: String): ReadState {
                        statusRead = { unread }
                        throw ApiFailure.Network(IOException("Response lost"))
                    }
                }
                .apply { statusRead = { unread } }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            model.selectFilter(ChatListFilter.Unread)
            source.statusRead = { earlierReadback.await() }
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkRead))
            runCurrent()

            model.undoRowAction(checkNotNull(model.uiState.value.rowUndo))
            runCurrent()
            assertEquals(ChatUndoPhase.Applying, model.uiState.value.rowUndo?.phase)
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))

            earlierReadback.complete(Indicators(emptyMap(), emptyMap()))
            advanceUntilIdle()
            assertNull(model.uiState.value.rowUndo)
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))
        }
    }

    @Test
    fun anUnconfirmedUnreadUndoRollsBackAndAcceptsLaterReadback() = runTest {
        val read = Indicators(emptyMap(), emptyMap())
        val unread =
            Indicators(
                mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                mapOf(CHAT_PERSONAL to CHAT_DATE),
            )
        var inverseWrites = 0
        val source =
            object : Service() {
                    override suspend fun markRead(threadId: String) = ReadState(CHAT_DATE)

                    override suspend fun markUnread(threadId: String): ReadState {
                        inverseWrites++
                        throw ApiFailure.Network(IOException("Response lost"))
                    }

                    override suspend fun threadDetail(threadId: String) =
                        ThreadDetail(CHAT_DATE, false)
                }
                .apply { statusRead = { unread } }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            model.selectFilter(ChatListFilter.Unread)
            source.statusRead = { read }
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkRead))
            advanceUntilIdle()
            model.undoRowAction(checkNotNull(model.uiState.value.rowUndo))
            advanceUntilIdle()

            val pending = model.uiState.value
            assertNull(pending.rowUndo)
            assertTrue(pending.rowActionFailures.single().fromUndo)
            assertEquals(read, pending.indicators)
            assertFalse(pending.isUnread(CHAT_PERSONAL))

            source.statusRead = { unread }
            model.refreshIndicators()
            advanceUntilIdle()
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))
            assertNull(model.uiState.value.rowUndo)
            assertEquals(1, inverseWrites)
        }
    }

    @Test
    fun reopeningAChatSettlesAnEarlierUnconfirmedUnreadUndo() = runTest {
        var lastReadAt: String? = null
        val latestReply = HistoryCursor(HISTORY_LAST_EVENT, 37)
        val reply = HistoryEvent.decode(historyEventWire(HISTORY_LAST_EVENT, latestReply.seqId))
        val source =
            object : Service() {
                override suspend fun indicators() =
                    if (lastReadAt == null)
                        Indicators(
                            mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                            mapOf(CHAT_PERSONAL to CHAT_DATE),
                        )
                    else Indicators(emptyMap(), emptyMap())

                override suspend fun threadDetail(threadId: String) =
                    ThreadDetail(lastReadAt, false)

                override suspend fun historySnapshot(threadId: String): Nothing =
                    throw ApiFailure.Http(404, "CHAT_EVENT_SNAPSHOT_NOT_FOUND", null, null)

                override suspend fun historyRows(threadId: String, cursor: HistoryCursor) =
                    if (cursor.seqId < latestReply.seqId)
                        HistoryPage(listOf(reply), latestReply, false)
                    else HistoryPage(emptyList(), cursor, false)

                override suspend fun markRead(threadId: String): ReadState {
                    lastReadAt = CHAT_DATE
                    return ReadState(lastReadAt)
                }

                override suspend fun markUnread(threadId: String): ReadState =
                    throw ApiFailure.Network(IOException("Response lost"))
            }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            model.selectFilter(ChatListFilter.Unread)
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkRead))
            advanceUntilIdle()
            assertTrue(model.undoRowAction(checkNotNull(model.uiState.value.rowUndo)))
            advanceUntilIdle()
            val awaitingReadback = model.uiState.value
            assertFalse(awaitingReadback.isUnread(CHAT_PERSONAL))
            assertNull(awaitingReadback.rowUndo)
            assertTrue(awaitingReadback.rowActionFailures.single().fromUndo)

            val history = model.history
            history.open(awaitingReadback.threads.single())
            val visit =
                checkNotNull(history.beginVisit(CHAT_PERSONAL, history.uiState.value.generation))
            advanceUntilIdle()
            visit.confirmDisplayed(checkNotNull(history.uiState.value.confirmation))
            advanceUntilIdle()

            assertEquals(HistoryReadState.Confirmed, visit.readState.value)
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))
            assertNull(model.uiState.value.rowUndo)
        }
    }

    @Test
    fun undoWaitsForAnEarlierReadBeforeSubmittingTheInverse() = runTest {
        val displayedRead = CompletableDeferred<Unit>()
        val unread =
            Indicators(
                mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                mapOf(CHAT_PERSONAL to CHAT_DATE),
            )
        val latestReply = HistoryCursor(HISTORY_LAST_EVENT, 37)
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
                                    ),
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
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            model.selectFilter(ChatListFilter.Unread)
            source.statusRead = { Indicators(emptyMap(), emptyMap()) }
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
            assertEquals(ChatUndoPhase.Applying, model.uiState.value.rowUndo?.phase)
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))
            assertEquals(0, inverseWrites)
            displayedRead.complete(Unit)
            advanceUntilIdle()
            assertEquals(1, inverseWrites)
            assertNull(model.uiState.value.rowUndo)
        }
    }

    @Test
    fun bulkReadCompletesWhileIndicatorsRefreshAndKeepsNewerUnreadActivity() = runTest {
        val write = CompletableDeferred<ReadState>()
        val readback = CompletableDeferred<Indicators>()
        val readbackStarted = CompletableDeferred<Unit>()
        fun unread(time: String) =
            Indicators(
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

            source.statusRead = { throw ApiFailure.Http(503, null, null, null) }
            model.refreshIndicators()
            runCurrent()
            source.statusRead = {
                readbackStarted.complete(Unit)
                readback.await()
            }
            write.complete(ReadState(CHAT_DATE))
            runCurrent()
            val settled = model.uiState.value
            assertTrue(readbackStarted.isCompleted)
            assertEquals(ChatReadPhase.Loading, settled.indicatorsPhase)
            assertFalse(settled.markingAllRead)
            assertEquals(ChatMarkAllReadResult(1, 1), settled.markAllReadResult)
            assertTrue(settled.isUnread(CHAT_PERSONAL))

            readback.complete(newer)
            advanceUntilIdle()
            assertEquals(ChatMarkAllReadResult(1, 1), model.uiState.value.markAllReadResult)
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))
        }
    }

    @Test
    fun bulkReadUpdatesEachConfirmedChatAndReportsPartialSuccess() = runTest {
        val personal = CompletableDeferred<ReadState>()
        val other = CompletableDeferred<ReadState>()
        val unreadBefore =
            Indicators(
                mapOf(
                    CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD,
                    CHAT_IN_PROJECT to IndicatorsThreadsValue.UNREAD,
                ),
                mapOf(CHAT_PERSONAL to CHAT_DATE, CHAT_IN_PROJECT to CHAT_DATE),
            )
        val unreadAfter =
            Indicators(
                mapOf(CHAT_IN_PROJECT to IndicatorsThreadsValue.UNREAD),
                mapOf(CHAT_IN_PROJECT to CHAT_DATE),
            )
        val source =
            object : Service() {
                    override suspend fun markRead(threadId: String) =
                        if (threadId == CHAT_PERSONAL) personal.await() else other.await()
                }
                .apply {
                    statusRead = { unreadBefore }
                    listRead = {
                        page(
                            listOf(
                                chatEventWire(),
                                chatEventWire(
                                    id = "77777777-7777-4777-8777-777777777777",
                                    seq = 18,
                                    thread = CHAT_IN_PROJECT,
                                ),
                            ),
                        )
                    }
                }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            model.selectFilter(ChatListFilter.Unread)
            model.markAllRead()
            runCurrent()
            assertTrue(model.uiState.value.unreadChatIds().isEmpty())

            personal.complete(ReadState(CHAT_DATE))
            runCurrent()
            val partial = model.uiState.value
            assertTrue(partial.markingAllRead)
            assertTrue(partial.unreadChatIds().isEmpty())

            source.statusRead = { unreadAfter }
            other.completeExceptionally(ApiFailure.Http(409, null, null, null))
            advanceUntilIdle()
            val settled = model.uiState.value
            assertEquals(setOf(CHAT_IN_PROJECT), settled.unreadChatIds())
            assertEquals(ChatMarkAllReadResult(1, 2), settled.markAllReadResult)
        }
    }

    @Test
    fun bulkReadRetainsAmbiguousWriteThroughAnInterveningRefresh() = runTest {
        val otherWrite = CompletableDeferred<ReadState>()
        val lookedUp = mutableListOf<String>()
        val source =
            object : Service() {
                    override suspend fun markRead(threadId: String): ReadState {
                        if (threadId == CHAT_PERSONAL)
                            throw ApiFailure.Network(IOException("response lost"))
                        return otherWrite.await()
                    }

                    override suspend fun threadDetail(threadId: String): ThreadDetail {
                        lookedUp.add(threadId)
                        return ThreadDetail(CHAT_DATE, false)
                    }
                }
                .apply {
                    statusRead = {
                        Indicators(
                            mapOf(
                                CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD,
                                CHAT_IN_PROJECT to IndicatorsThreadsValue.UNREAD,
                            ),
                            mapOf(CHAT_PERSONAL to CHAT_DATE, CHAT_IN_PROJECT to CHAT_DATE),
                        )
                    }
                    listRead = {
                        page(
                            listOf(
                                chatEventWire(),
                                chatEventWire(
                                    id = "77777777-7777-4777-8777-777777777777",
                                    seq = 18,
                                    thread = CHAT_IN_PROJECT,
                                ),
                            ),
                        )
                    }
                }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            model.markAllRead()
            runCurrent()

            model.refreshIndicators()
            runCurrent()
            assertTrue(model.uiState.value.markingAllRead)
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))
            assertTrue(lookedUp.isEmpty())

            source.statusRead = { Indicators(emptyMap(), emptyMap()) }
            otherWrite.complete(ReadState(CHAT_DATE))
            advanceUntilIdle()
            assertEquals(listOf(CHAT_PERSONAL), lookedUp)
            assertEquals(ChatMarkAllReadResult(2, 2), model.uiState.value.markAllReadResult)
        }
    }

    @Test
    fun bulkReadDistinguishesFailedConnectionFromMissingReadbackEvidence() = runTest {
        for (connectionFailed in listOf(false, true)) {
            val source =
                object : Service() {
                        override suspend fun markRead(threadId: String): ReadState {
                            if (connectionFailed) throw ApiFailure.Network(ConnectException())
                            statusRead = { Indicators(emptyMap(), emptyMap()) }
                            throw IOException("response lost")
                        }
                    }
                    .apply {
                        statusRead = {
                            Indicators(
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
                assertEquals(connectionFailed, state.isUnread(CHAT_PERSONAL))
                assertEquals(
                    ChatMarkAllReadResult(0, 1),
                    state.markAllReadResult,
                )
            }
        }
    }

    @Test
    fun bulkReadCountsAnAmbiguousWriteWhenTheServerCursorConfirmsIt() = runTest {
        val lookedUp = mutableListOf<String>()
        val source =
            object : Service() {
                    override suspend fun markRead(threadId: String): ReadState {
                        throw ApiFailure.Network(IOException("response lost"))
                    }

                    override suspend fun threadDetail(threadId: String): ThreadDetail {
                        lookedUp.add(threadId)
                        return ThreadDetail(CHAT_DATE, false)
                    }
                }
                .apply {
                    statusRead = {
                        Indicators(
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
            assertEquals(listOf(CHAT_PERSONAL), lookedUp)
            assertEquals(ChatMarkAllReadResult(1, 1), model.uiState.value.markAllReadResult)
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))
        }
    }

    @Test
    fun aBulkReadConnectionFailureCannotPublishAnEarlierUnconfirmedRead() = runTest {
        var attempts = 0
        val source =
            object : Service() {
                    override suspend fun markRead(threadId: String): ReadState {
                        if (++attempts == 1) throw ApiFailure.Network(IOException("Response lost"))
                        throw ApiFailure.Network(ConnectException("Unreachable"))
                    }
                }
                .apply {
                    statusRead = {
                        Indicators(
                            mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                            mapOf(CHAT_PERSONAL to CHAT_DATE),
                        )
                    }
                }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            source.statusRead = { throw IOException("Status unavailable") }
            model.markAllRead()
            advanceUntilIdle()
            assertEquals(ChatMarkAllReadResult(0, 1), model.uiState.value.markAllReadResult)
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))

            model.markAllRead()
            advanceUntilIdle()
            assertEquals(2, attempts)
            assertEquals(
                ChatMarkAllReadResult(0, 1),
                model.uiState.value.markAllReadResult,
            )
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))
        }
    }
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
internal class ChatListRowActionsModelTest : ChatListModelTestFixture() {
    @Test
    fun archiveRetriesUndeliveredWritesAtThreeSecondIntervalsUsingTheSameEvent() = runTest {
        val events = mutableListOf(chatEventWire())
        val writes = mutableListOf<Pair<Long, String>>()
        val source =
            object : Service() {
                override suspend fun chatEvents(since: Long?) = page(events)

                override suspend fun setArchived(
                    threadId: String,
                    archived: Boolean,
                    eventId: String,
                ) {
                    writes.add(testScheduler.currentTime to eventId)
                    if (writes.size < 3) throw ApiFailure.Network(ConnectException())
                    events.add(chatEventWire(id = eventId, seq = 18, kind = "archived"))
                }
            }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            val started = testScheduler.currentTime
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.Archive))
            runCurrent()
            assertTrue(model.uiState.value.threads.single().archived)
            assertEquals(
                ChatRowAction.Archive,
                model.uiState.value.pendingRowActions[CHAT_PERSONAL],
            )
            assertNull(model.uiState.value.rowUndo)
            advanceTimeBy(2_999)
            runCurrent()
            assertEquals(1, writes.size)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(2, writes.size)
            assertFalse(model.performRowAction(CHAT_PERSONAL, ChatRowAction.Unarchive))
            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(listOf(0L, 3_000L, 6_000L), writes.map { it.first - started })
            assertEquals(1, writes.map { it.second }.distinct().size)
            assertEquals(ChatRowAction.Archive, model.uiState.value.rowUndo?.action)
        }
    }

    @Test
    fun crossClientArchiveDuringRetrySettlesWithoutAnotherWriteOrUndo() = runTest {
        val events = mutableListOf(chatEventWire())
        var writes = 0
        val source =
            object : Service() {
                override suspend fun chatEvents(since: Long?) = page(events)

                override suspend fun setArchived(
                    threadId: String,
                    archived: Boolean,
                    eventId: String,
                ) {
                    writes++
                    throw ApiFailure.Network(ConnectException())
                }
            }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            model.performRowAction(CHAT_PERSONAL, ChatRowAction.Archive)
            runCurrent()
            events.add(chatEventWire(id = HISTORY_LAST_EVENT, seq = 18, kind = "archived"))
            model.refreshList()
            runCurrent()
            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(1, writes)
            assertTrue(model.uiState.value.threads.single().archived)
            assertTrue(model.uiState.value.pendingRowActions.isEmpty())
            assertNull(model.uiState.value.rowUndo)
            assertNull(model.uiState.value.failedRowAction)
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
            indicators.complete(Indicators(emptyMap(), emptyMap()))
            advanceUntilIdle()
        }
    }

    @Test
    fun archiveUndoAttemptsTheWriteAndDistinguishesRejectionFromAnUnknownResult() = runTest {
        for (error in
            listOf(ApiFailure.Http(403, null, null, null), IOException("Lost response"))) {
            val source = ArchiveService()
            val release = CompletableDeferred<Unit>()
            var inverseWrites = 0
            source.beforeUnarchive = {
                inverseWrites++
                release.await()
                throw error
            }
            withCatchUpModel(source) { model ->
                model.refresh()
                advanceUntilIdle()
                assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.Archive))
                advanceUntilIdle()
                val offer = checkNotNull(model.uiState.value.rowUndo)

                model.undoRowAction(offer)
                runCurrent()
                val applying = model.uiState.value
                val pendingUndo = checkNotNull(applying.rowUndo)
                assertEquals(ChatUndoPhase.Applying, pendingUndo.phase)
                assertEquals(offer.sequence, pendingUndo.sequence)
                assertFalse(applying.threads.single { it.id == CHAT_PERSONAL }.archived)
                assertTrue(applying.confirmedThreads.single { it.id == CHAT_PERSONAL }.archived)
                model.undoRowAction(offer)
                model.undoRowAction(pendingUndo)
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
                    assertNull(state.rowUndo)
                    assertTrue(state.rowActionFailures.single().fromUndo)
                    assertTrue(state.threads.single { it.id == CHAT_PERSONAL }.archived)
                    assertTrue(state.pendingRowActions.isEmpty())
                    readback.complete(Unit)
                }
                advanceUntilIdle()
                val state = model.uiState.value
                assertNull(state.rowUndo)
                assertTrue(state.threads.single { it.id == CHAT_PERSONAL }.archived)
                assertTrue(state.rowActionFailures.single().fromUndo)
                assertTrue(state.pendingRowActions.isEmpty())
                assertEquals(1, inverseWrites)
            }
        }
    }

    @Test
    fun undoRetriesKnownDeliveryFailuresAndRollsBackWhenTheBudgetEnds() = runTest {
        val source = ArchiveService()
        var inverseWrites = 0
        source.beforeUnarchive = {
            inverseWrites++
            throw ApiFailure.Network(ConnectException("Unreachable"))
        }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.Archive))
            advanceUntilIdle()

            val offer = checkNotNull(model.uiState.value.rowUndo)
            model.undoRowAction(offer)
            runCurrent()
            assertEquals(1, inverseWrites)
            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(2, inverseWrites)
            assertFalse(model.uiState.value.threads.first { it.id == CHAT_PERSONAL }.archived)
            advanceUntilIdle()
            val failed = model.uiState.value.rowActionFailures.single()
            assertTrue(failed.fromUndo)
            assertNull(model.uiState.value.rowUndo)
            assertTrue(model.uiState.value.threads.first { it.id == CHAT_PERSONAL }.archived)
            assertEquals(3, inverseWrites)

            assertSame(failed, model.uiState.value.rowActionFailures.single())
            model.undoRowAction(offer)
            advanceUntilIdle()
            assertEquals(3, inverseWrites)
        }
    }

    @Test
    fun archiveAndUndoUseSuccessfulReceiptsWhenListVerificationFails() = runTest {
        for (responseLost in listOf(false, true)) {
            val source = ArchiveService()
            var inverseWrites = 0
            source.beforeUnarchive = { inverseWrites++ }
            source.afterUnarchive = {
                if (responseLost) throw ApiFailure.Network(IOException("Lost response"))
            }
            withCatchUpModel(source) { model ->
                model.refresh()
                advanceUntilIdle()
                source.beforeEvents = { throw IOException("Readback unavailable") }
                assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.Archive))
                advanceUntilIdle()

                val offer =
                    checkNotNull(model.uiState.value.rowUndo) {
                        "An acknowledged archive can be undone while list verification is unavailable"
                    }
                assertEquals(ChatRowAction.Archive, offer.action)
                model.undoRowAction(offer)
                advanceUntilIdle()
                val settled = model.uiState.value
                assertNull(settled.rowUndo)
                assertEquals(
                    responseLost,
                    settled.rowActionFailures.singleOrNull()?.fromUndo == true,
                )
                assertEquals(
                    responseLost,
                    settled.threads.first { it.id == CHAT_PERSONAL }.archived,
                )
                assertEquals(1, inverseWrites)

                source.beforeEvents = {}
                model.refreshList()
                advanceUntilIdle()
                assertNull(model.uiState.value.rowUndo)
                assertFalse(model.uiState.value.threads.first { it.id == CHAT_PERSONAL }.archived)
                assertEquals(1, inverseWrites)
            }
        }
    }

    @Test
    fun aRejectedUndoKeepsItsFeedbackAfterANewerArchiveConfirms() = runTest {
        val releaseInverse = CompletableDeferred<Unit>()
        val source = ArchiveService()
        source.beforeUnarchive = {
            releaseInverse.await()
            throw ApiFailure.Http(403, null, null, null)
        }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.Archive))
            advanceUntilIdle()
            val firstUndo = checkNotNull(model.uiState.value.rowUndo)
            model.undoRowAction(firstUndo)
            runCurrent()
            assertEquals(ChatUndoPhase.Applying, model.uiState.value.rowUndo?.phase)

            assertTrue(model.performRowAction(CHAT_IN_PROJECT, ChatRowAction.Archive))
            advanceUntilIdle()
            val newerUndo = checkNotNull(model.uiState.value.rowUndo)
            assertEquals(CHAT_IN_PROJECT, newerUndo.threadId)

            releaseInverse.complete(Unit)
            advanceUntilIdle()
            val state = model.uiState.value
            assertSame(newerUndo, state.rowUndo)
            assertTrue(state.threads.single { it.id == CHAT_PERSONAL }.archived)
            val failure = state.rowActionFailures.single()
            assertTrue(failure.rejected && failure.fromUndo)
            assertEquals(ChatRowAction.Unarchive, failure.action)
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
                        chatEventWire(id = eventId, seq = 19, thread = threadId, kind = "archived"),
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
                    model.uiState.value.rowActions(sibling, group, group.threads.indexOf(sibling)),
            )
            assertTrue(model.performRowAction(CHAT_IN_PROJECT, ChatRowAction.Archive))
            runCurrent()
            assertEquals(CHAT_IN_PROJECT, model.uiState.value.rowUndo?.threadId)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
        }
    }

    @Test
    fun chatRenameKeepsItsReceiptWhileEarlierFeedResponsesArrive() = runTest {
        val write = CompletableDeferred<Unit>()
        val earlierRead = CompletableDeferred<Unit>()
        val read = CompletableDeferred<Unit>()
        var tail = page(emptyList())
        val writes = mutableListOf<String>()
        val service =
            object : Service() {
                override suspend fun chatEvents(since: Long?): ChatEvents {
                    if (since == null) return page()
                    if (since < 18) {
                        earlierRead.await()
                        return page(
                            listOf(
                                chatEventWire(
                                    id = "00000018-0000-4000-8000-000000000000",
                                    seq = 18,
                                    kind = "renamed",
                                    title = "Earlier remote title",
                                ),
                            ),
                        )
                    }
                    read.await()
                    return tail
                }

                override suspend fun renameThread(
                    threadId: String,
                    title: String,
                    eventId: String,
                ) {
                    writes += eventId
                    write.await()
                }
            }
        withCatchUpModel(service) { model ->
            model.refresh()
            runCurrent()
            assertNotNull(model.renameThread(CHAT_PERSONAL, "Receipt title"))
            runCurrent()
            assertEquals("Personal chat", model.uiState.value.threads.single().title)
            model.refreshList()
            runCurrent()
            assertEquals(ChatReadPhase.Loading, model.uiState.value.listPhase)
            write.complete(Unit)
            runCurrent()
            assertEquals("Receipt title", model.uiState.value.threadsByRecency.single().title)
            assertNull(model.uiState.value.pendingRowActions[CHAT_PERSONAL])
            assertNotNull(model.renameThread(CHAT_PERSONAL, "Second title"))
            runCurrent()
            assertEquals(2, writes.size)
            assertEquals("Second title", model.uiState.value.threadsByRecency.single().title)
            earlierRead.complete(Unit)
            runCurrent()
            assertEquals("Second title", model.uiState.value.threadsByRecency.single().title)
            assertEquals(ChatReadPhase.Loading, model.uiState.value.listPhase)

            tail =
                page(
                    listOf(
                        chatEventWire(
                            id = writes.first(),
                            seq = 19,
                            kind = "renamed",
                            title = "Receipt title",
                        ),
                    ),
                )
            read.complete(Unit)
            advanceUntilIdle()
            assertEquals("Second title", model.uiState.value.threads.single().title)

            tail =
                page(
                    listOf(
                        chatEventWire(
                            id = writes.last(),
                            seq = 20,
                            kind = "renamed",
                            title = "Second title",
                        ),
                        chatEventWire(
                            id = HISTORY_LAST_EVENT,
                            seq = 21,
                            kind = "renamed",
                            title = "Remote title",
                        ),
                    ),
                )
            model.refreshList()
            advanceUntilIdle()
            assertEquals("Remote title", model.uiState.value.threads.single().title)
            assertTrue(model.uiState.value.unconfirmedRenames.isEmpty())
        }
    }

    @Test
    fun rejectedRenameKeepsTheTitleWhileReadingTheMissingTarget() = runTest {
        val rejection = CompletableDeferred<Unit>()
        val readback = CompletableDeferred<Unit>()
        val source =
            object : Service() {
                override suspend fun chatEvents(since: Long?): ChatEvents {
                    if (since == null) return page()
                    readback.await()
                    return page(
                        listOf(chatEventWire(id = HISTORY_LAST_EVENT, seq = 18, kind = "deleted")),
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
            model.renameThread(CHAT_PERSONAL, "Requested title")
            runCurrent()
            assertEquals("Personal chat", model.uiState.value.threads.single().title)

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
                        chatEventWire(id = eventId, seq = 18, kind = "renamed", title = title),
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
            assertEquals("Personal chat", unconfirmed.threads.single().title)
            assertEquals(ChatListReadFailure.Retrying, unconfirmed.listReadFailure)
            assertEquals(ChatRowAction.Rename, unconfirmed.failedRowAction?.action)
            assertFalse(checkNotNull(unconfirmed.failedRowAction).rejected)

            events.add(
                chatEventWire(
                    id = HISTORY_LAST_EVENT,
                    seq = 19,
                    kind = "renamed",
                    title = "Newer title",
                ),
            )
            advanceTimeBy(3_000)
            runCurrent()
            val settled = model.uiState.value
            assertEquals(ChatReadPhase.Ready, settled.listPhase)
            assertEquals("Newer title", settled.threads.single().title)
            assertNull(settled.failedRowAction)
            assertEquals(2, attempts)
        }
    }

    @Test
    fun aLateRowRejectionCannotPublishOrScheduleReadbackForARetiredWorkspace() = runTest {
        val response = CompletableDeferred<Unit>()
        var authorized = true
        var reads = 0
        val source =
            ArchiveService().apply {
                beforeEvents = { reads++ }
                beforeArchive = {
                    withContext(NonCancellable) {
                        response.await()
                        throw ApiFailure.Http(404, null, null, null)
                    }
                }
            }
        withCatchUpModel(source, authorized = { authorized }) { model ->
            try {
                model.refresh()
                runCurrent()
                assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.Archive))
                runCurrent()
                val pending = model.uiState.value
                val readsBeforeRetirement = reads
                assertTrue(pending.threads.single { it.id == CHAT_PERSONAL }.archived)
                assertEquals(ChatRowAction.Archive, pending.pendingRowActions[CHAT_PERSONAL])

                authorized = false
                response.complete(Unit)
                runCurrent()

                assertSame(pending, model.uiState.value)
                assertEquals(readsBeforeRetirement, reads)
            } finally {
                response.complete(Unit)
            }
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
    fun anUnconfirmedArchiveRestoresTheConfirmedRowAndClearsThePendingAction() = runTest {
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
            assertFalse(model.uiState.value.threads.single().archived)

            assertFalse(model.performRowAction(CHAT_PERSONAL, ChatRowAction.Unarchive))
            advanceUntilIdle()
            assertFalse(model.uiState.value.threads.single().archived)
            assertEquals(ChatRowAction.Archive, model.uiState.value.failedRowAction?.action)
            assertTrue(model.uiState.value.pendingRowActions.isEmpty())
            assertNull(model.uiState.value.rowUndo)

            model.reloadAfterRowActionFailure()
            advanceUntilIdle()
            assertFalse(model.uiState.value.threads.single().archived)
            assertFalse(model.uiState.value.confirmedThreads.single().archived)
        }
    }

    @Test
    fun uncertainArchiveAndUnarchiveEachRollBackUntilCanonicalEventsArrive() = runTest {
        val events = mutableListOf(chatEventWire())
        val requests = mutableListOf<String>()
        val source =
            object : Service() {
                override suspend fun chatEvents(since: Long?) = page(events)

                override suspend fun setArchived(
                    threadId: String,
                    archived: Boolean,
                    eventId: String,
                ) {
                    requests.add(eventId)
                    throw ApiFailure.Network(IOException("Response lost"))
                }
            }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.Archive))
            runCurrent()
            assertFalse(model.uiState.value.threads.single().archived)
            assertEquals(ChatRowAction.Archive, model.uiState.value.failedRowAction?.action)

            events.add(chatEventWire(id = requests.first(), seq = 18, kind = "archived"))
            model.refreshList()
            runCurrent()
            assertTrue(model.uiState.value.confirmedThreads.single().archived)
            assertTrue(model.uiState.value.threads.single().archived)
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.Unarchive))
            runCurrent()
            assertEquals(ChatRowAction.Unarchive, model.uiState.value.failedRowAction?.action)
            assertTrue(model.uiState.value.threads.single().archived)

            events.add(chatEventWire(id = HISTORY_LAST_EVENT, seq = 19, kind = "unarchived"))
            model.refreshList()
            runCurrent()
            assertFalse(model.uiState.value.confirmedThreads.single().archived)
            assertFalse(model.uiState.value.threads.single().archived)
            assertNull(model.uiState.value.rowUndo)
            assertEquals(2, requests.size)
        }
    }

    @Test
    fun anEarlierReadbackCannotSettleTheNextIntent() = runTest {
        val commitRead = CompletableDeferred<ReadState>()
        val stale = CompletableDeferred<Indicators>()
        val commitUnread = CompletableDeferred<ReadState>()
        fun status(time: String) =
            Indicators(
                mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                mapOf(CHAT_PERSONAL to time),
            )
        val read = Indicators(emptyMap(), emptyMap())
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
                },
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
                            "hasTextContent":true,"chatThreadSortEventId":"$sortEvent"}""",
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
                        chatEventWire(id = eventId, seq = 19, kind = "renamed", title = title),
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
            assertNull(model.uiState.value.pendingRowActions[CHAT_PERSONAL])

            events.add(
                chatEventWire(
                    id = "77777777-7777-4777-8777-777777777777",
                    seq = 20,
                    thread = preview.threadId,
                    extra = ""","projectId":"$CHAT_PROJECT"""",
                ),
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
                ),
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
    fun inconclusiveReadbackKeepsTheOriginalRenameUntilItsEventArrives() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val store = ViewModelStore()
        val tail = mutableListOf(chatEventWire())
        val source =
            Service().apply {
                listRead = {
                    json.decodeFromString(
                        """{"events":[${tail.joinToString(",")}],"hasMore":false}""",
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
                    tail.add(chatEventWire(id = eventId, seq = 19, kind = "renamed", title = title))
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
            assertEquals("Personal chat", model.uiState.value.threads.single().title)
            assertEquals(ChatRowAction.Rename, model.uiState.value.failedRowAction?.action)
            val notice = checkNotNull(model.uiState.value.failedRowAction)
            val firstId = notice.edits.single().eventId
            model.dismissRowActionFailure(notice)

            assertNull(model.renameThread(CHAT_PERSONAL, "Second edit"))
            assertTrue(CHAT_PERSONAL in model.uiState.value.unconfirmedRenames)
            model.checkChatRename(CHAT_PERSONAL)
            advanceUntilIdle()
            assertEquals("Personal chat", model.uiState.value.threads.single().title)
            assertEquals("First edit", model.uiState.value.unconfirmedRenames[CHAT_PERSONAL]?.name)
            model.reloadAfterRowActionFailure()
            advanceUntilIdle()
            assertNull(model.renameThread(CHAT_PERSONAL, "Second edit"))

            tail.add(chatEventWire(id = firstId, seq = 18, kind = "renamed", title = "First edit"))
            model.checkChatRename(CHAT_PERSONAL)
            advanceUntilIdle()
            assertEquals("First edit", model.uiState.value.threads.single().title)
            assertTrue(model.uiState.value.unconfirmedRenames.isEmpty())

            assertNotNull(model.renameThread(CHAT_PERSONAL, "Second edit"))
            advanceUntilIdle()
            assertEquals("Second edit", model.uiState.value.threads.single().title)
            assertNull(model.uiState.value.failedRowAction)

            tail.add(
                chatEventWire(
                    id = "77777777-7777-4777-8777-777777777777",
                    seq = 20,
                    kind = "renamed",
                    title = "Remote edit",
                ),
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
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
internal class ChatListProjectCreationModelTest : ChatListModelTestFixture() {
    @Test
    fun temporaryCreateFailuresUseTheSameOperationAndLookItUpBeforeRetrying() = runTest {
        val calls = mutableListOf<Pair<String, String>>()
        val service =
            object : TestChatService() {
                override suspend fun createProject(
                    projectId: String,
                    name: String,
                ): ConfirmedProject {
                    calls += "POST" to projectId
                    assertEquals("Research", name)
                    if (calls.count { it.first == "POST" } == 1)
                        throw ApiFailure.Http(503, null, null, null)
                    return ConfirmedProject(projectId, name, CHAT_DATE, CHAT_DATE, "a0")
                }

                override suspend fun projectDetail(projectId: String): ConfirmedProject {
                    calls += "GET" to projectId
                    throw ApiFailure.Http(404, null, null, null)
                }
            }
        withCatchUpModel(service) { model ->
            runCurrent()
            model.createProject(" Research ")
            runCurrent()
            val creation = checkNotNull(model.uiState.value.projectList.creation)
            assertEquals(ProjectCreatePhase.Creating, creation.phase)
            assertTrue(model.uiState.value.projects.isEmpty())
            model.createProject("Another project")
            runCurrent()
            assertEquals(listOf("POST" to creation.id), calls)
            advanceUntilIdle()
            assertEquals(
                listOf("POST" to creation.id, "GET" to creation.id, "POST" to creation.id),
                calls,
            )
            assertEquals(
                ProjectCreation(creation.id, ProjectCreatePhase.Confirmed),
                model.uiState.value.projectList.creation,
            )
            assertEquals(creation.id, model.uiState.value.projects.single().id)
        }
    }

    @Test
    fun matchingProjectEventConfirmsWhileTheHttpReceiptIsStillPending() =
        confirmFromEventWhileRequestIsHeld(lookupPending = false)

    @Test
    fun matchingProjectEventPreventsReplayAfterAnEarlierLookupCompletes() =
        confirmFromEventWhileRequestIsHeld(lookupPending = true)

    private fun confirmFromEventWhileRequestIsHeld(lookupPending: Boolean) = runTest {
        val pendingReceipt = CompletableDeferred<ConfirmedProject>()
        val realtime = TestRealtimeService()
        val calls = mutableListOf<String>()
        var receipt: ProjectEventsEventsItem? = null
        val service =
            object : TestChatService() {
                override suspend fun createProject(
                    projectId: String,
                    name: String,
                ): ConfirmedProject {
                    calls += "POST"
                    if (lookupPending) throw ApiFailure.Http(503, null, null, null)
                    return pendingReceipt.await()
                }

                override suspend fun projectDetail(projectId: String): ConfirmedProject {
                    calls += "GET"
                    return pendingReceipt.await()
                }

                override suspend fun projectEvents(since: Long) =
                    ProjectEvents(listOfNotNull(receipt).filter { it.seqId > since }, false)
            }
        withCatchUpModel(service, realtime) { model ->
            model.updates.foreground(true)
            advanceUntilIdle()
            model.createProject("Research")
            advanceUntilIdle()
            val attempt = checkNotNull(model.uiState.value.projectList.creation)
            val expectedCalls = if (lookupPending) listOf("POST", "GET") else listOf("POST")
            assertEquals(expectedCalls, calls)
            receipt =
                ProjectEventsEventsItem(
                    id = attempt.id,
                    seqId = 1,
                    projectId = attempt.id,
                    kind = ProjectEventsEventsItemKind.CREATED,
                    name = "Research",
                    createdAt = CHAT_DATE,
                    sortOrder = "a0",
                )
            realtime.invalidate(ChatChanges(list = true))
            advanceUntilIdle()
            assertEquals(
                ProjectCreatePhase.Confirmed,
                model.uiState.value.projectList.creation?.phase,
            )
            assertEquals("Research", model.uiState.value.projects.single().name)

            model.dismissProjectCreation()
            if (lookupPending) {
                pendingReceipt.completeExceptionally(ApiFailure.Http(404, null, null, null))
            } else {
                pendingReceipt.complete(
                    ConfirmedProject(attempt.id, "Research", CHAT_DATE, CHAT_DATE, "a0"),
                )
            }
            advanceUntilIdle()
            assertNull(model.uiState.value.projectList.creation)
            assertEquals(attempt.id, model.uiState.value.projects.single().id)
            assertEquals(expectedCalls, calls)
        }
    }
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
internal class ChatListProjectRenameModelTest : ChatListModelTestFixture() {
    @Test
    fun projectRenamePublishesTheReturnedNameBeforeAnEarlierReadFinishes() = runTest {
        val earlierRead = CompletableDeferred<Unit>()
        val readback = CompletableDeferred<Unit>()
        val service = HeldProjectRenameService().apply { responseName = "Current name" }
        withCatchUpModel(service) { model ->
            model.refresh()
            advanceUntilIdle()
            val submission = checkNotNull(model.renameProject(CHAT_PROJECT, "Submitted name"))
            runCurrent()
            val exactEvent =
                ProjectEventsEventsItem(
                    id = submission.eventId,
                    seqId = 1,
                    projectId = CHAT_PROJECT,
                    kind = ProjectEventsEventsItemKind.RENAMED,
                    name = submission.name,
                    createdAt = CHAT_DATE,
                )
            service.receipt = exactEvent
            service.nextProjectRead = earlierRead
            model.refreshMetadata()
            runCurrent()
            service.response.complete(Unit)
            runCurrent()
            assertEquals("Current name", model.uiState.value.projects.single().name)
            assertEquals(
                submission.eventId,
                model.uiState.value.projectList.confirmedRenameIds[CHAT_PROJECT],
            )

            service.receipt = exactEvent.copy(id = CHAT_EVENT, seqId = 2, name = "Latest name")
            service.nextProjectRead = readback
            earlierRead.complete(Unit)
            runCurrent()
            assertEquals("Current name", model.uiState.value.projects.single().name)

            readback.complete(Unit)
            advanceUntilIdle()
            val settled = model.uiState.value
            assertEquals("Latest name", settled.projects.single().name)
            assertTrue(settled.unconfirmedProjectRenames.isEmpty())
        }
    }

    @Test
    fun projectRenameKeepsItsReceiptWhileAnEarlierFeedResponseArrives() = runTest {
        val earlierRead = CompletableDeferred<Unit>()
        val readback = CompletableDeferred<Unit>()
        val service = HeldProjectRenameService(earlierRead)
        val earlierEvent =
            ProjectEventsEventsItem(
                id = CHAT_EVENT,
                seqId = 1,
                projectId = CHAT_PROJECT,
                kind = ProjectEventsEventsItemKind.RENAMED,
                name = "Earlier remote name",
                createdAt = CHAT_DATE,
            )
        // An earlier rename and the write receipt can share the same wire timestamp.
        service.receipt = earlierEvent
        withCachedProjectRename(service) { model, _ ->
            assertNotNull(model.renameProject(CHAT_PROJECT, "After"))
            runCurrent()
            assertEquals("Before", model.uiState.value.projects.single().name)
            service.response.complete(Unit)
            runCurrent()
            assertEquals(ChatReadPhase.Loading, model.uiState.value.projectsPhase)
            assertEquals("After", model.uiState.value.projects.single().name)
            service.nextProjectRead = readback
            service.receipt =
                earlierEvent.copy(id = service.sent.single(), seqId = 2, name = "After")
            earlierRead.complete(Unit)
            runCurrent()
            assertEquals(ChatReadPhase.Loading, model.uiState.value.projectsPhase)
            assertEquals("After", model.uiState.value.projects.single().name)
            readback.complete(Unit)
            advanceUntilIdle()
            assertEquals("After", model.uiState.value.projects.single().name)
            assertTrue(model.uiState.value.unconfirmedProjectRenames.isEmpty())
        }
    }

    @Test
    fun rejectedCachedProjectRenameKeepsConfirmedNameWhileInitialReadIsHeld() = runTest {
        val initialRead = CompletableDeferred<Unit>()
        val service = HeldProjectRenameService(initialRead)
        withCachedProjectRename(service) { model, _ ->
            val projectReads = service.projectReads
            model.renameProject(CHAT_PROJECT, "Rejected")
            runCurrent()
            assertEquals("Before", model.uiState.value.projects.single().name)

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
            model.checkProjectRename(CHAT_PROJECT)
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
    fun unchangedProjectRefreshKeepsPendingRenameAndHidesAnUnavailableCollection() = runTest {
        val initialRead = CompletableDeferred<Unit>()
        val service = HeldProjectRenameService(initialRead)
        withCachedProjectRename(service) { model, _ ->
            model.renameProject(CHAT_PROJECT, "Pending")
            runCurrent()
            assertEquals("Before", model.uiState.value.projects.single().name)

            initialRead.complete(Unit)
            advanceUntilIdle()
            val refreshed = model.uiState.value
            assertEquals(ChatReadPhase.Ready, refreshed.projectsPhase)
            assertEquals(ChatListSource.Network, refreshed.projectsSource)
            assertEquals("Before", refreshed.projects.single().name)
            assertEquals(CHAT_PROJECT, refreshed.renamingProjectId)

            service.collectionUnavailable = true
            model.refreshMetadata()
            advanceUntilIdle()
            val unavailable = model.uiState.value
            assertEquals(ChatReadPhase.Failed, unavailable.projectsPhase)
            assertNull(unavailable.projectsSource)
            assertTrue(unavailable.projects.isEmpty())
            assertFalse(unavailable.canRenameProject)

            service.response.completeExceptionally(ApiFailure.Network(IOException("Lost response")))
            advanceUntilIdle()
            val settled = model.uiState.value
            assertTrue(settled.projects.isEmpty())
            assertTrue(settled.unconfirmedProjectRenames.isEmpty())
            assertNull(settled.renamingProjectId)

            service.collectionUnavailable = false
            model.refreshMetadata()
            advanceUntilIdle()
            val recovered = model.uiState.value
            assertEquals(ChatReadPhase.Ready, recovered.projectsPhase)
            assertEquals("Before", recovered.projects.single().name)
            assertTrue(recovered.canRenameProject)
            assertEquals(0, service.projectSnapshots)
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
            assertEquals("Before", model.uiState.value.projects.single().name)
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

    @Test
    fun projectRenameIgnoresARejectionFromARetiredWorkspace() = runTest {
        val service = HeldProjectRenameService()
        var authorized = true
        withCatchUpModel(service, authorized = { authorized }) { model ->
            model.refresh()
            advanceUntilIdle()
            model.renameProject(CHAT_PROJECT, "After")
            runCurrent()
            assertEquals(1, service.sent.size)
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
    fun observedProjectRenameReceiptTakesPrecedenceOverLateRejection() = runTest {
        val service = HeldProjectRenameService()
        val firstResponse = service.response
        withCatchUpModel(service) { model ->
            model.refresh()
            advanceUntilIdle()
            model.renameProject(CHAT_PROJECT, "After")
            runCurrent()
            val originalId = service.sent.single()
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
            assertEquals("From another client", model.uiState.value.projects.single().name)
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
            assertNull(model.uiState.value.renamingProjectId)

            service.response = CompletableDeferred()
            assertNotNull(model.renameProject(CHAT_PROJECT, "Second name"))
            runCurrent()
            firstResponse.completeExceptionally(ApiFailure.Http(409, "CONFLICT", null, null))
            runCurrent()
            assertEquals(CHAT_PROJECT, model.uiState.value.renamingProjectId)
            assertNull(model.uiState.value.projectRenameRejection)
            assertEquals("After", model.uiState.value.projects.single().name)

            service.response.complete(Unit)
            advanceUntilIdle()

            val state = model.uiState.value
            assertEquals("Second name", state.projects.single().name)
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
            assertNull(afterUnrelatedReceipt.projectList.confirmedRenameIds[CHAT_PROJECT])

            service.receipt = unrelated.copy(id = originalId, seqId = 2)
            model.refreshMetadata()
            advanceUntilIdle()
            val afterMatchingReceipt = model.uiState.value
            assertEquals("After", afterMatchingReceipt.projects.single().name)
            assertNull(afterMatchingReceipt.projectRenameRejection)
            assertEquals(
                originalId,
                afterMatchingReceipt.projectList.confirmedRenameIds[CHAT_PROJECT],
            )
        }
    }

    @Test
    fun projectRenameKeepsTheAttemptedNameAfterAConnectionFailure() = runTest {
        val service = HeldProjectRenameService()
        withCatchUpModel(service) { model ->
            model.refresh()
            advanceUntilIdle()
            model.renameProject(CHAT_PROJECT, "Field notes")
            runCurrent()
            assertEquals("Before", model.uiState.value.projects.single().name)
            service.response.completeExceptionally(ApiFailure.Network(ConnectException()))
            advanceUntilIdle()
            val failed = model.uiState.value
            assertEquals("Before", failed.projects.single().name)
            assertEquals(setOf(CHAT_PROJECT), failed.projectList.connectionFailedRenames)
            val eventId = service.sent.single()

            service.receipt =
                ProjectEventsEventsItem(
                    id = CHAT_EVENT,
                    seqId = 1,
                    projectId = CHAT_PROJECT,
                    kind = ProjectEventsEventsItemKind.RENAMED,
                    name = "Field notes",
                    createdAt = CHAT_DATE,
                )
            service.response = CompletableDeferred(Unit)
            val next = checkNotNull(model.renameProject(CHAT_PROJECT, "Field notes"))
            advanceUntilIdle()
            assertNotEquals(eventId, next.eventId)
            assertEquals(listOf(eventId, next.eventId), service.sent)
            assertEquals("Field notes", model.uiState.value.projects.single().name)
            assertTrue(model.uiState.value.unconfirmedProjectRenames.isEmpty())
        }
    }

    @Test
    fun observedProjectRenameStaysConfirmedWhenTheResponseIsLost() = runTest {
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
                            ),
                        ),
                        latestEventId = null,
                        latestSeqId = 0,
                    )

                override suspend fun renameProject(
                    projectId: String,
                    name: String,
                    eventId: String,
                ): ConfirmedProject {
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
                    return ConfirmedProject(projectId, name, CHAT_DATE, CHAT_DATE, "a0")
                }

                override suspend fun projectEvents(since: Long) =
                    ProjectEvents(listOfNotNull(event?.takeIf { it.seqId > since }), false)
            }
        withCatchUpModel(service) { model ->
            model.refresh()
            advanceUntilIdle()
            model.renameProject(CHAT_PROJECT, "After")
            runCurrent()
            assertNotNull(event)
            model.refreshMetadata()
            advanceUntilIdle()
            response.completeExceptionally(ApiFailure.Network(IOException("Lost Project response")))
            advanceUntilIdle()

            val state = model.uiState.value
            assertEquals("After", state.projects.single().name)
            assertNull(state.renamingProjectId)
            assertTrue(state.unconfirmedProjectRenames.isEmpty())
        }
    }
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
internal class ChatListProjectMembershipModelTest : ChatListModelTestFixture() {
    @Test
    fun projectMoveShowsTheDestinationImmediatelyAndSettlesALostResponseFromTheExactEvent() =
        runTest {
            val source = ProjectOrganizationService()
            val response = CompletableDeferred<Unit>()
            source.moveResponse = { thread, project, event ->
                response.await()
                source.publishMembership(thread, project, event)
                throw ApiFailure.Network(IOException("Response lost after commit"))
            }
            withCatchUpModel(source) { model ->
                model.refresh()
                runCurrent()
                val before = model.uiState.value.threads.single { it.id == CHAT_PERSONAL }
                assertFalse(model.moveThreadToProject(CHAT_PERSONAL, CHAT_IN_PROJECT))
                assertTrue(model.moveThreadToProject(CHAT_PERSONAL, CHAT_PROJECT))
                runCurrent()
                val pending = model.uiState.value
                assertEquals(
                    listOf(CHAT_PERSONAL, CHAT_IN_PROJECT),
                    chatListGroups(pending).first().threads.map { it.id },
                )
                assertEquals(
                    before.copy(projectId = CHAT_PROJECT),
                    pending.threads.single { it.id == CHAT_PERSONAL },
                )
                assertFalse(model.moveThreadToProject(CHAT_PERSONAL, null))
                assertEquals(7, UUID.fromString(source.moveIds.single()).version())
                response.complete(Unit)
                runCurrent()
                val confirmed = model.uiState.value
                assertEquals(
                    CHAT_PROJECT,
                    confirmed.threads.single { it.id == CHAT_PERSONAL }.projectId,
                )
                assertEquals(
                    before.pinOrder,
                    confirmed.threads.single { it.id == CHAT_PERSONAL }.pinOrder,
                )
                assertEquals("Research", confirmed.chatMoveNotice?.projectName)
                assertNull(confirmed.failedRowAction)
            }
        }

    @Test
    fun rejectedProjectMoveRestoresTheSourceScopeAndPinRank() = runTest {
        val source = ProjectOrganizationService()
        source.moveResponse = { _, _, _ -> throw ApiFailure.Http(409, null, null, null) }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            assertTrue(model.moveThreadToProject(CHAT_PERSONAL, CHAT_PROJECT))
            runCurrent()
            val state = model.uiState.value
            assertEquals(ChatRowAction.MoveProject, state.failedRowAction?.action)
            assertTrue(checkNotNull(state.failedRowAction).rejected)
            val chat = state.threads.single { it.id == CHAT_PERSONAL }
            assertNull(chat.projectId)
            assertEquals("a0", chat.pinOrder)
            assertNull(state.chatMoveNotice)
        }
    }

    @Test
    fun projectDeleteKeepsChatsUntilConfirmedAndRetriesWithTheOriginalOperationIdentity() =
        runTest {
            val source = ProjectOrganizationService()
            val response = CompletableDeferred<Unit>()
            source.deleteResponse = {
                throw ApiFailure.Network(IOException("Response unavailable"))
            }
            withCatchUpModel(source) { model ->
                model.refresh()
                runCurrent()
                val original = model.uiState.value.threads.associateBy { it.id }
                model.deleteProject(CHAT_PROJECT)
                runCurrent()
                val feedback = model.uiState.value.projectList.deleteFeedback.single()
                assertEquals(ProjectDeleteStatus.Unconfirmed, feedback.status)
                assertEquals(7, UUID.fromString(source.deleteIds.single()).version())
                assertEquals(listOf("Research"), model.uiState.value.projects.map { it.name })
                assertEquals(original, model.uiState.value.threads.associateBy { it.id })

                source.deleteResponse = { id ->
                    response.await()
                    source.publishDeletion(id)
                    throw ApiFailure.Network(IOException("Response lost after commit"))
                }
                model.retryProjectDelete(feedback)
                runCurrent()
                assertEquals(CHAT_PROJECT, model.uiState.value.projectList.deletingId)
                assertEquals(original, model.uiState.value.threads.associateBy { it.id })
                model.deleteProject(CHAT_PROJECT)
                runCurrent()
                assertEquals(listOf(feedback.eventId, feedback.eventId), source.deleteIds)
                response.complete(Unit)
                runCurrent()

                val confirmed = model.uiState.value
                assertTrue(confirmed.projects.isEmpty())
                assertNull(confirmed.projectList.deletingId)
                assertEquals(
                    ProjectDeleteStatus.Confirmed,
                    confirmed.projectList.deleteFeedback.single().status,
                )
                assertEquals(
                    listOf(CHAT_PERSONAL, CHAT_IN_PROJECT),
                    chatListGroups(confirmed).single().threads.map { it.id },
                )
                assertEquals(
                    original[CHAT_IN_PROJECT]?.pinOrder,
                    confirmed.threads.single { it.id == CHAT_IN_PROJECT }.pinOrder,
                )
                assertEquals(
                    IndicatorsThreadsValue.ACTIVE,
                    confirmed.indicators?.threads?.get(CHAT_IN_PROJECT),
                )
            }
        }

    @Test
    fun confirmedProjectDeletionKeepsMembershipAfterAnUnconfirmedMoveRollsBack() = runTest {
        val source = ProjectOrganizationService()
        source.moveResponse = { _, _, _ ->
            throw ApiFailure.Network(IOException("Move response unavailable"))
        }
        source.deleteResponse = source::publishDeletion
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            val original = model.uiState.value.threads.single { it.id == CHAT_PERSONAL }

            assertTrue(model.moveThreadToProject(CHAT_PERSONAL, CHAT_PROJECT))
            runCurrent()
            val moving = model.uiState.value
            assertEquals(original, moving.threads.single { it.id == CHAT_PERSONAL })
            assertEquals(ChatRowAction.MoveProject, moving.failedRowAction?.action)
            model.dismissRowActionFailure(checkNotNull(moving.failedRowAction))

            model.deleteProject(CHAT_PROJECT)
            runCurrent()

            val deleted = model.uiState.value
            assertEquals(
                ProjectDeleteStatus.Confirmed,
                deleted.projectList.deleteFeedback.single().status,
            )
            assertEquals(original, deleted.threads.single { it.id == CHAT_PERSONAL })
            assertEquals(
                listOf(CHAT_PERSONAL, CHAT_IN_PROJECT),
                chatListGroups(deleted).single().threads.map { it.id },
            )
            assertNull(deleted.failedRowAction)
        }
    }

    @Test
    fun deletionWaitsForConfirmedRegroupingWhenAnEarlierMoveIsUnconfirmed() = runTest {
        val destination = "bcf53013-dfc9-4136-9de3-d3d070d8c488"
        val source = ProjectOrganizationService(additionalProjectId = destination)
        source.moveResponse = { _, _, _ ->
            throw ApiFailure.Network(IOException("Move response unavailable"))
        }
        source.deleteResponse = source::publishDeletion
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            assertTrue(model.moveThreadToProject(CHAT_IN_PROJECT, destination))
            runCurrent()
            val uncertainMove = model.uiState.value
            assertEquals(
                CHAT_PROJECT,
                uncertainMove.threads.single { it.id == CHAT_IN_PROJECT }.projectId,
            )
            val failure = checkNotNull(uncertainMove.failedRowAction)
            assertEquals(ChatRowAction.MoveProject, failure.action)

            source.chatReadUnavailable = true
            model.deleteProject(CHAT_PROJECT)
            runCurrent()
            val waiting = model.uiState.value
            assertEquals(listOf(destination), waiting.projects.map { it.id })
            assertEquals(
                ProjectDeleteStatus.Confirmed,
                waiting.projectList.deleteFeedback.single().status,
            )
            assertTrue(waiting.projectDeleteFeedback.isEmpty())

            source.chatReadUnavailable = false
            model.retryList()
            runCurrent()
            val regrouped = model.uiState.value
            val outside = chatListGroups(regrouped).single { it.projectId == null }
            assertEquals(listOf(CHAT_PERSONAL, CHAT_IN_PROJECT), outside.threads.map { it.id })
            assertEquals("a2", outside.threads.single { it.id == CHAT_IN_PROJECT }.pinOrder)
            assertEquals(
                ProjectDeleteStatus.Confirmed,
                regrouped.projectDeleteFeedback.single().status,
            )
            assertSame(failure, regrouped.failedRowAction)
            assertNull(regrouped.chatMoveNotice)
            model.dismissRowActionFailure(failure)

            val originalMove = source.moveIds.single()
            source.publishMembership(CHAT_IN_PROJECT, destination, originalMove)
            model.refreshList()
            runCurrent()
            val committed = model.uiState.value
            assertEquals(
                destination,
                committed.threads.single { it.id == CHAT_IN_PROJECT }.projectId,
            )
            assertNull(committed.failedRowAction)
            assertEquals(listOf(originalMove), source.moveIds)
        }
    }

    @Test
    fun anUnconfirmedMoveYieldsToMembershipObservedWhileItWasInFlight() = runTest {
        val otherProject = "bcf53013-dfc9-4136-9de3-d3d070d8c488"
        val source = ProjectOrganizationService(additionalProjectId = otherProject)
        val response = CompletableDeferred<Unit>()
        source.moveResponse = { _, _, _ ->
            response.await()
            throw ApiFailure.Network(IOException("Move response unavailable"))
        }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            assertTrue(model.moveThreadToProject(CHAT_IN_PROJECT, null))
            runCurrent()

            source.publishMembership(
                CHAT_IN_PROJECT,
                otherProject,
                "00000021-0000-4000-8000-000000000000",
            )
            model.refreshList()
            runCurrent()
            assertNull(model.uiState.value.threads.single { it.id == CHAT_IN_PROJECT }.projectId)

            response.complete(Unit)
            runCurrent()
            val unconfirmed = model.uiState.value
            assertEquals(
                otherProject,
                unconfirmed.threads.single { it.id == CHAT_IN_PROJECT }.projectId,
            )
            assertEquals(ChatRowAction.MoveProject, unconfirmed.failedRowAction?.action)
            assertNull(unconfirmed.chatMoveNotice)

            source.publishMembership(
                CHAT_IN_PROJECT,
                CHAT_PROJECT,
                "00000022-0000-4000-8000-000000000000",
            )
            model.refreshList()
            runCurrent()
            assertEquals(
                CHAT_PROJECT,
                model.uiState.value.threads.single { it.id == CHAT_IN_PROJECT }.projectId,
            )
        }
    }

    @Test
    fun moveToProjectDeletedDuringTheRequestKeepsTheConfirmedMembership() = runTest {
        val source = ProjectOrganizationService()
        val response = CompletableDeferred<Unit>()
        source.moveResponse = { _, _, _ ->
            response.await()
            throw ApiFailure.Network(IOException("Move response unavailable"))
        }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            val original = model.uiState.value.threads.single { it.id == CHAT_PERSONAL }

            assertTrue(model.moveThreadToProject(CHAT_PERSONAL, CHAT_PROJECT))
            runCurrent()
            source.publishDeletion("00000022-0000-4000-8000-000000000000")
            model.refreshMetadata()
            runCurrent()
            val pending = model.uiState.value
            assertTrue(pending.projects.isEmpty())
            assertEquals(ChatRowAction.MoveProject, pending.pendingRowActions[CHAT_PERSONAL])

            response.complete(Unit)
            runCurrent()

            val settled = model.uiState.value
            assertEquals(original, settled.threads.single { it.id == CHAT_PERSONAL })
            assertNull(settled.pendingRowActions[CHAT_PERSONAL])
            assertEquals(ChatRowAction.MoveProject, settled.rowActionFailures.single().action)
        }
    }

    @Test
    fun aLateMoveResponseDoesNotAnnounceADeletedDestination() = runTest {
        val source = ProjectOrganizationService()
        val response = CompletableDeferred<Unit>()
        source.moveResponse = { thread, project, event ->
            source.publishMembership(thread, project, event)
            response.await()
        }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            assertTrue(model.moveThreadToProject(CHAT_PERSONAL, CHAT_PROJECT))
            runCurrent()

            source.publishDeletion("00000022-0000-4000-8000-000000000000")
            source.publishMembership(CHAT_PERSONAL, null, "00000023-0000-4000-8000-000000000000")
            model.refresh()
            runCurrent()
            val detached = model.uiState.value
            assertTrue(detached.projects.isEmpty())
            assertNull(detached.threads.single { it.id == CHAT_PERSONAL }.projectId)
            assertEquals(ChatRowAction.MoveProject, detached.pendingRowActions[CHAT_PERSONAL])

            response.complete(Unit)
            runCurrent()
            val settled = model.uiState.value
            assertNull(settled.pendingRowActions[CHAT_PERSONAL])
            assertNull(settled.chatMoveNotice)
            assertNull(settled.failedRowAction)
        }
    }

    @Test
    fun aQueuedMoveConfirmationClearsAfterTheChatMovesAgain() = runTest {
        val source = ProjectOrganizationService()
        source.moveResponse = source::publishMembership
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            assertTrue(model.moveThreadToProject(CHAT_PERSONAL, CHAT_PROJECT))
            runCurrent()
            assertEquals("Research", model.uiState.value.chatMoveNotice?.projectName)

            source.publishMembership(CHAT_PERSONAL, null, "00000022-0000-4000-8000-000000000000")
            model.refresh()
            runCurrent()

            val state = model.uiState.value
            assertEquals("Research", state.projects.single().name)
            assertNull(state.threads.single { it.id == CHAT_PERSONAL }.projectId)
            assertNull(state.chatMoveNotice)
        }
    }

    @Test
    fun queuedMoveConfirmationUsesTheCurrentProjectName() = runTest {
        val source = ProjectOrganizationService()
        source.moveResponse = source::publishMembership
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            assertTrue(model.moveThreadToProject(CHAT_PERSONAL, CHAT_PROJECT))
            runCurrent()
            val original = checkNotNull(model.uiState.value.chatMoveNotice)
            assertEquals("Research", original.projectName)

            source.publishRename("00000022-0000-4000-8000-000000000000", "Field research")
            model.refreshMetadata()
            runCurrent()
            val updated = checkNotNull(model.uiState.value.chatMoveNotice)
            assertEquals("Field research", updated.projectName)
            assertEquals(original.eventId, updated.eventId)
            model.dismissChatMoveNotice(original)
            assertEquals(updated, model.uiState.value.chatMoveNotice)
        }
    }

    @Test
    fun projectCommandsWaitForTheirOwnConnectionFailure() = runTest {
        val source = ProjectOrganizationService()
        source.moveResponse = { _, _, _ -> throw ApiFailure.Network(ConnectException()) }
        source.deleteResponse = { throw ApiFailure.Network(ConnectException()) }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            assertTrue(model.uiState.value.canRenameProject)
            assertTrue(model.moveThreadToProject(CHAT_PERSONAL, CHAT_PROJECT))
            advanceUntilIdle()
            assertEquals(3, source.moveIds.size)
            assertEquals(1, source.moveIds.distinct().size)
            val personal = model.uiState.value.threads.single { it.id == CHAT_PERSONAL }
            assertNull(personal.projectId)
            assertTrue(model.uiState.value.failedRowAction?.connectionFailed == true)

            model.deleteProject(CHAT_PROJECT)
            advanceUntilIdle()
            val failed = model.uiState.value
            assertEquals(1, source.deleteIds.size)
            assertEquals(
                ProjectDeleteStatus.ConnectionFailed,
                failed.projectDeleteFeedback.single().status,
            )
            assertEquals(CHAT_PROJECT, failed.projects.single().id)
            assertTrue(failed.canDeleteProject)

            source.deleteResponse = { source.publishDeletion(it) }
            model.deleteProject(CHAT_PROJECT)
            advanceUntilIdle()
            assertEquals(2, source.deleteIds.size)
            assertTrue(model.uiState.value.projects.isEmpty())
            assertEquals(
                ProjectDeleteStatus.Confirmed,
                model.uiState.value.projectDeleteFeedback.single().status,
            )
        }
    }
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
internal class ChatListProjectMetadataModelTest : ChatListModelTestFixture() {
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
                        """{"projects":[{"id":"$CHAT_PROJECT","name":"Before","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}],"latestEventId":null,"latestSeqId":0}""",
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
                        ),
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
                    """{"events":[{"id":"$CHAT_EVENT","seqId":17,"projectId":"$CHAT_PROJECT","kind":"renamed","name":"After","createdAt":"$CHAT_DATE"}],"hasMore":false}""",
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
    fun projectRefreshReplaysAReplacementAfterTheCachedCursorExpires() = runTest {
        val project =
            ProjectSnapshotVariant1ProjectsItem(CHAT_PROJECT, "Before", CHAT_DATE, CHAT_DATE)
        var snapshot = ProjectSnapshotVariant1(listOf(project), null, 0)
        val service =
            object : Service() {
                override suspend fun projectSnapshot() = snapshot

                override suspend fun projectEvents(since: Long): ProjectEvents {
                    if (since < snapshot.latestSeqId) throw ApiFailure.Http(410, null, null, null)
                    return ProjectEvents(emptyList(), false)
                }
            }
        withCatchUpModel(service) { model ->
            model.refresh()
            advanceUntilIdle()
            assertEquals("Before", model.uiState.value.projects.single().name)

            snapshot =
                ProjectSnapshotVariant1(listOf(project.copy(name = "Replacement")), CHAT_EVENT, 17)
            model.refreshMetadata()
            advanceUntilIdle()
            val replaced = model.uiState.value
            assertEquals(ChatReadPhase.Ready, replaced.projectsPhase)
            assertEquals("Replacement", replaced.projects.single().name)

            model.refreshMetadata()
            advanceUntilIdle()
            assertEquals(replaced.projectList, model.uiState.value.projectList)
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
                                        ProjectArchive(listOf(project), CHAT_EVENT, 17),
                                    ),
                                    100,
                                ),
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
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
internal class ChatListPinModelTest : ChatListModelTestFixture() {
    @Test
    fun unreadFilterMovesNextToTheVisiblePinAndPreservesOtherRanks() = runTest {
        val first = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        val hidden = CHAT_IN_PROJECT
        val last = CHAT_PERSONAL
        val events = pinnedEvents(first, hidden, last).toMutableList()
        val writes = mutableListOf<String>()
        val source =
            object : Service() {
                    override suspend fun chatEvents(since: Long?) = page(events)

                    override suspend fun reorderPinnedThread(
                        threadId: String,
                        pinOrder: String,
                        eventId: String,
                    ) {
                        writes.add(threadId)
                        events.add(
                            chatEventWire(
                                id = eventId,
                                seq = 23,
                                thread = threadId,
                                kind = "sort_touched",
                                extra = ""","pinOrder":"$pinOrder"""",
                            ),
                        )
                    }
                }
                .apply {
                    statusRead = {
                        Indicators(
                            mapOf(
                                first to IndicatorsThreadsValue.UNREAD,
                                last to IndicatorsThreadsValue.UNREAD,
                            ),
                            mapOf(first to CHAT_DATE, last to CHAT_DATE),
                        )
                    }
                }
        withCatchUpModel(source) { model ->
            model.refresh()
            advanceUntilIdle()
            model.selectFilter(ChatListFilter.Unread)
            assertEquals(
                listOf(first, last),
                chatListGroups(model.uiState.value).single().threads.map { it.id },
            )
            assertTrue(model.performRowAction(last, ChatRowAction.MovePinUp))
            advanceUntilIdle()
            val state = model.uiState.value
            assertEquals(listOf(last), writes)
            assertEquals(listOf(last, first), chatListGroups(state).single().threads.map { it.id })
            assertEquals(listOf(last, first, hidden), state.threads.map { it.id })
            assertEquals("a0", state.threads.single { it.id == hidden }.pinOrder)
        }
    }

    @Test
    fun aPinMoveRetryUsesTheConfirmedOrderAndAcceptsAnAuthoritativeRank() = runTest {
        val first = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        val middle = CHAT_IN_PROJECT
        val last = CHAT_PERSONAL
        val events = pinnedEvents(first, middle, last, pinOrder = { "a$it" }).toMutableList()
        val requested = mutableListOf<String>()
        val source =
            object : Service() {
                override suspend fun chatEvents(since: Long?) = page(events)

                override suspend fun reorderPinnedThread(
                    threadId: String,
                    pinOrder: String,
                    eventId: String,
                ) {
                    assertEquals(first, threadId)
                    requested.add(pinOrder)
                    if (requested.size == 1) throw ApiFailure.Network(IOException("Response lost"))
                    throw ApiFailure.Network(ConnectException("Request not delivered"))
                }
            }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            assertTrue(model.performRowAction(first, ChatRowAction.MovePinDown))
            runCurrent()
            assertEquals(listOf(first, middle, last), model.uiState.value.threads.map { it.id })
            assertEquals(ChatRowAction.MovePinDown, model.uiState.value.failedRowAction?.action)
            model.dismissRowActionFailure(checkNotNull(model.uiState.value.failedRowAction))

            assertTrue(model.performRowAction(first, ChatRowAction.MovePinDown))
            runCurrent()
            events.add(
                chatEventWire(
                    id = HISTORY_LAST_EVENT,
                    seq = 23,
                    thread = first,
                    kind = "sort_touched",
                    extra = ""","pinOrder":"a1V"""",
                ),
            )
            model.refreshList()
            runCurrent()
            advanceTimeBy(3_000)
            runCurrent()

            val confirmed = model.uiState.value
            assertEquals(listOf("a1V", "a1V"), requested)
            assertEquals(listOf(middle, first, last), confirmed.threads.map { it.id })
            assertNull(confirmed.failedRowAction)
        }
    }

    @Test
    fun rejectedPinReorderKeepsTheSubmittedStepAndDiscardsTheUnsentStep() = runTest {
        val moved = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        val next = CHAT_IN_PROJECT
        val rejected = "33333333-3333-4333-8333-333333333333"
        val submitted = CHAT_PERSONAL
        val events = pinnedEvents(moved, next, rejected, submitted).toMutableList()
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
                        ),
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
                ),
            )
            readback.complete(Unit)
            runCurrent()
            assertTrue(model.uiState.value.pendingRowActions.isEmpty())
            assertEquals("a4", model.uiState.value.threads.single { it.id == submitted }.pinOrder)
        }
    }

    @Test
    fun aPartialPinMoveRestoresItsUnknownRankAndAppliesTheLateEvent() = runTest {
        val moved = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        val submitted = CHAT_PERSONAL
        val events = pinnedEvents(moved, CHAT_IN_PROJECT, submitted).toMutableList()
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
            assertTrue(failure.rejected)
            assertEquals("a0", partial.threads.single { it.id == moved }.pinOrder)
            assertEquals("a0", partial.threads.single { it.id == submitted }.pinOrder)

            readUnavailable = true
            model.refreshList()
            model.dismissRowActionFailure(failure)
            runCurrent()
            val retrying = model.uiState.value
            assertEquals(ChatListReadFailure.Retrying, retrying.listReadFailure)
            assertEquals("a0", retrying.threads.single { it.id == submitted }.pinOrder)

            readUnavailable = false
            advanceTimeBy(3_000)
            runCurrent()
            val recovered = model.uiState.value
            assertEquals(ChatReadPhase.Ready, recovered.listPhase)
            assertEquals("a0", recovered.threads.single { it.id == submitted }.pinOrder)
            assertEquals("a0", recovered.confirmedThreads.single { it.id == submitted }.pinOrder)

            events.add(
                chatEventWire(
                    id = HISTORY_LAST_EVENT,
                    seq = 23,
                    thread = submitted,
                    kind = "sort_touched",
                    extra = ""","pinOrder":"a2"""",
                ),
            )
            model.refreshList()
            runCurrent()
            assertEquals(
                "a2",
                model.uiState.value.confirmedThreads.single { it.id == submitted }.pinOrder,
            )
            assertEquals(listOf(submitted), attempted)
        }
    }
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
internal class ChatListUnreadReconciliationModelTest : ChatListModelTestFixture() {
    @Test
    fun earlierUnreadReadbackCannotUndoAReadWithoutAPreviousWatermark() = runTest {
        val unreadReadback = CompletableDeferred<Indicators>()
        val readWrite = CompletableDeferred<ReadState>()
        val read = Indicators(emptyMap(), emptyMap())
        val unread =
            Indicators(
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

            source.statusRead = { Indicators(emptyMap(), emptyMap()) }
            model.refreshIndicators()
            advanceUntilIdle()
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))
        }
    }

    @Test
    fun lostReadResponseRollsBackAndLaterAcceptsAnAuthoritativeWatermark() = runTest {
        val realtime = TestRealtimeService()
        var confirmedAt: String? = null
        var writes = 0
        val source =
            object : Service() {
                    override suspend fun markRead(threadId: String): ReadState {
                        writes++
                        throw ApiFailure.Network(IOException("Response lost"))
                    }

                    override suspend fun threadDetail(threadId: String) =
                        ThreadDetail(confirmedAt, false)
                }
                .apply {
                    statusRead = {
                        Indicators(
                            mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                            mapOf(CHAT_PERSONAL to CHAT_DATE),
                        )
                    }
                }
        withCatchUpModel(source, realtime) { model ->
            model.refresh()
            model.updates.foreground(true)
            advanceUntilIdle()
            model.selectFilter(ChatListFilter.Unread)
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkRead))
            advanceUntilIdle()
            val pending = model.uiState.value
            assertTrue(pending.isUnread(CHAT_PERSONAL))
            assertTrue(pending.readIntents.isEmpty())
            assertEquals(ChatRowAction.MarkRead, pending.failedRowAction?.action)
            assertNull(pending.rowUndo)
            model.dismissRowActionFailure(checkNotNull(pending.failedRowAction))

            confirmedAt = CHAT_DATE
            realtime.invalidate(ChatChanges(readCursor = true))
            advanceUntilIdle()
            val confirmed = model.uiState.value
            assertEquals(1, writes)
            assertFalse(confirmed.isUnread(CHAT_PERSONAL))
            assertTrue(confirmed.readIntents.isEmpty())
            assertNull(confirmed.failedRowAction)
            assertNull(confirmed.rowUndo)
        }
    }

    @Test
    fun indicatorRefreshConfirmsALostUnreadResponseOutsideTheUnreadWindow() = runTest {
        var lastReadAt: String? = CHAT_DATE
        var writes = 0
        val source =
            object : Service() {
                    override suspend fun markUnread(threadId: String): ReadState {
                        writes++
                        throw ApiFailure.Network(IOException("Response lost"))
                    }

                    override suspend fun threadDetail(threadId: String) =
                        ThreadDetail(lastReadAt, false)
                }
                .apply { statusRead = { Indicators(emptyMap(), emptyMap()) } }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkUnread))
            runCurrent()
            val pending = model.uiState.value
            assertFalse(pending.isUnread(CHAT_PERSONAL))
            assertEquals(ChatRowAction.MarkUnread, pending.failedRowAction?.action)
            model.dismissRowActionFailure(checkNotNull(pending.failedRowAction))

            lastReadAt = null
            model.refreshIndicators()
            runCurrent()
            val confirmed = model.uiState.value
            assertTrue(confirmed.readIntents.isEmpty())
            assertNull(confirmed.failedRowAction)
            assertNull(confirmed.rowUndo)
            assertEquals(1, writes)
        }
    }

    @Test
    fun anOldUnreadSnapshotCannotConfirmTheInverseOfAnUnconfirmedRead() = runTest {
        var lastReadAt: String? = null
        val firstReadback = CompletableDeferred<Indicators>()
        val source =
            object : Service() {
                    override suspend fun markRead(threadId: String): ReadState =
                        throw ApiFailure.Network(IOException("Read response lost"))

                    override suspend fun markUnread(threadId: String): ReadState =
                        throw ApiFailure.Network(IOException("Unread response lost"))

                    override suspend fun threadDetail(threadId: String) =
                        ThreadDetail(lastReadAt, false)
                }
                .apply {
                    statusRead = {
                        Indicators(
                            mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                            mapOf(CHAT_PERSONAL to CHAT_DATE),
                        )
                    }
                }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            val unreadSnapshot = source.statusRead
            source.statusRead = { firstReadback.await() }
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkRead))
            runCurrent()
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))

            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkUnread))
            runCurrent()
            source.statusRead = unreadSnapshot
            firstReadback.complete(unreadSnapshot())
            runCurrent()
            val pending = checkNotNull(model.uiState.value.failedRowAction)
            assertEquals(ChatRowAction.MarkUnread, pending.action)
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))

            // The first write appears after the indicator snapshot was taken.
            lastReadAt = CHAT_DATE
            model.refreshIndicators()
            runCurrent()
            assertSame(pending, model.uiState.value.failedRowAction)
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))

            lastReadAt = null
            model.dismissRowActionFailure(pending)
            model.refreshIndicators()
            runCurrent()
            val confirmed = model.uiState.value
            assertTrue(confirmed.isUnread(CHAT_PERSONAL))
            assertTrue(confirmed.readIntents.isEmpty())
            assertNull(confirmed.failedRowAction)
            assertNull(confirmed.rowUndo)
        }
    }

    @Test
    fun aConfirmedUnreadWriteWinsOverAnEarlierPendingReadback() = runTest {
        val firstReadback = CompletableDeferred<Indicators>()
        val source =
            object : Service() {
                    override suspend fun markRead(threadId: String): ReadState =
                        throw ApiFailure.Network(IOException("Response lost"))

                    override suspend fun markUnread(threadId: String) = ReadState(null)

                    override suspend fun threadDetail(threadId: String) = ThreadDetail(null, false)
                }
                .apply {
                    statusRead = {
                        Indicators(
                            mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                            mapOf(CHAT_PERSONAL to CHAT_DATE),
                        )
                    }
                }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            val unreadSnapshot = source.statusRead
            source.statusRead = { firstReadback.await() }
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkRead))
            runCurrent()
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))

            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkUnread))
            runCurrent()
            source.statusRead = unreadSnapshot
            firstReadback.complete(Indicators(emptyMap(), emptyMap()))
            runCurrent()
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))
            assertTrue(model.uiState.value.readIntents.isEmpty())
            assertNull(model.uiState.value.failedRowAction)
        }
    }

    @Test
    fun anUnconfirmedReadCannotCancelAnUndeliveredUnreadWrite() = runTest {
        var unreadWrites = 0
        val firstReadback = CompletableDeferred<Indicators>()
        val source =
            object : Service() {
                    override suspend fun markRead(threadId: String): ReadState =
                        throw ApiFailure.Network(IOException("Response lost"))

                    override suspend fun markUnread(threadId: String): ReadState {
                        if (++unreadWrites == 1)
                            throw ApiFailure.Network(ConnectException("Request not delivered"))
                        return ReadState(null)
                    }

                    override suspend fun threadDetail(threadId: String) = ThreadDetail(null, false)
                }
                .apply {
                    statusRead = {
                        Indicators(
                            mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                            mapOf(CHAT_PERSONAL to CHAT_DATE),
                        )
                    }
                }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            val unreadSnapshot = source.statusRead
            source.statusRead = { firstReadback.await() }
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkRead))
            runCurrent()
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))

            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkUnread))
            runCurrent()
            assertEquals(1, unreadWrites)
            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(2, unreadWrites)
            source.statusRead = unreadSnapshot
            firstReadback.complete(unreadSnapshot())
            runCurrent()
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))
            assertNull(model.uiState.value.failedRowAction)
        }
    }

    @Test
    fun aRetryPreflightCannotEraseANewerUnreadSnapshot() = runTest {
        var confirmedReadAt: String? = null
        var writes = 0
        val source =
            object : Service() {
                    override suspend fun markRead(threadId: String): ReadState {
                        writes++
                        throw ApiFailure.Network(ConnectException("Request not delivered"))
                    }

                    override suspend fun threadDetail(threadId: String): ThreadDetail {
                        val snapshot = ThreadDetail(confirmedReadAt, false)
                        // Another client marks unread before the trailing indicators request.
                        confirmedReadAt = null
                        return snapshot
                    }
                }
                .apply {
                    statusRead = {
                        if (confirmedReadAt == null)
                            Indicators(
                                mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD),
                                mapOf(CHAT_PERSONAL to CHAT_DATE),
                            )
                        else Indicators(emptyMap(), emptyMap())
                    }
                }
        withCatchUpModel(source) { model ->
            model.refresh()
            runCurrent()
            model.selectFilter(ChatListFilter.Unread)
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkRead))
            runCurrent()
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))

            confirmedReadAt = CHAT_DATE
            advanceTimeBy(3_000)
            runCurrent()

            val settled = model.uiState.value
            assertEquals(1, writes)
            assertTrue(settled.isUnread(CHAT_PERSONAL))
            assertTrue(settled.readIntents.isEmpty())
            assertNull(settled.rowUndo)
        }
    }

    @Test
    fun ambiguousUnreadWriteRollsBackOfflineAndReconcilesAfterReconnect() = runTest {
        val response = CompletableDeferred<ReadState>()
        val source =
            object : Service() {
                    override suspend fun markUnread(threadId: String) = response.await()
                }
                .apply { statusRead = { Indicators(emptyMap(), emptyMap()) } }
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
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))

            source.statusRead = {
                Indicators(
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
                        ),
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

            statusResponse.complete(Indicators(emptyMap(), emptyMap()))
            advanceUntilIdle()
            assertEquals(initialReads + 1, reads)
            val state = model.uiState.value
            assertEquals(true, state.threads.single().muted)
            assertTrue(state.pendingRowActions.isEmpty())
            assertNull(state.failedRowAction)
        }
    }

    @Test
    fun aRejectedUnmuteKeepsItsReadReceiptWhileIndicatorsAreHeld() = runTest {
        val refresh = CompletableDeferred<Indicators>()
        val unread = Indicators(emptyMap(), mapOf(CHAT_PERSONAL to CHAT_DATE))
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
                        ),
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
                        """{"events":[${tail.joinToString(",")}],"hasMore":false}""",
                    )
                }
                statusRead = { Indicators(emptyMap(), emptyMap()) }
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
                        ),
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
                    mapOf(
                        CHAT_PERSONAL to IndicatorsThreadsValue.UNREAD,
                        CHAT_IN_PROJECT to IndicatorsThreadsValue.ACTIVE,
                    ),
                    mapOf(CHAT_PERSONAL to CHAT_DATE),
                ),
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
    fun failedIndicatorWriteReadbackContinuesTheExistingBackoff() = runTest {
        val unread = Indicators(emptyMap(), mapOf(CHAT_PERSONAL to CHAT_DATE))
        val confirmedRead = Indicators(emptyMap(), emptyMap())
        val attempts = mutableListOf<Long>()
        val service =
            object : Service() {
                    override suspend fun markRead(threadId: String) = ReadState(CHAT_DATE)
                }
                .apply { statusRead = { unread } }
        withCatchUpModel(service, wallMillis = { 1_000L }) { model ->
            model.refresh()
            model.selectFilter(ChatListFilter.Unread)
            runCurrent()
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))
            val startedAt = testScheduler.currentTime
            service.statusRead = {
                attempts.add(testScheduler.currentTime - startedAt)
                when (attempts.size) {
                    1,
                    2,
                    4 -> throw ApiFailure.Http(503, null, null, null)
                    3 -> throw ApiFailure.Http(429, null, null, 5)
                    else -> confirmedRead
                }
            }

            model.refreshIndicators()
            runCurrent()
            advanceTimeBy(4_000)
            assertEquals(listOf(0L, 3_000L), attempts)
            assertFalse(model.uiState.value.indicatorsRefreshProgressVisible)
            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkRead))
            runCurrent()

            assertEquals(listOf(0L, 3_000L, 4_000L), attempts)
            assertTrue(model.uiState.value.indicatorsRefreshProgressVisible)
            assertFalse(model.uiState.value.listRefreshProgressVisible)
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))
            assertFalse(CHAT_PERSONAL in model.uiState.value.pendingRowActions)
            model.selectFilter(ChatListFilter.Archived)
            model.selectFilter(ChatListFilter.Unread)
            advanceTimeBy(4_999)
            runCurrent()
            assertEquals(3, attempts.size)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(listOf(0L, 3_000L, 4_000L, 9_000L), attempts)

            advanceTimeBy(11_999)
            runCurrent()
            assertEquals(4, attempts.size)
            assertTrue(model.uiState.value.indicatorsRefreshProgressVisible)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(listOf(0L, 3_000L, 4_000L, 9_000L, 21_000L), attempts)
            assertEquals(emptyMap<String, String>(), model.uiState.value.displayUnreadAt)
            assertFalse(model.uiState.value.indicatorsRefreshProgressVisible)
        }
    }
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
internal class ChatListRefreshModelTest : ChatListModelTestFixture() {
    @Test
    fun savedLocalDraftsFillTheListUntilTheIndexBecomesAuthoritative() {
        val drafts =
            mapOf(
                "thread:$CHAT_PERSONAL" to EditableComposerDraft("Cached draft"),
                "thread:$CHAT_IN_PROJECT" to EditableComposerDraft("\u00a0", dirty = true),
                "thread:edited" to EditableComposerDraft("New edits", dirty = true),
                "new:" to EditableComposerDraft("New chat draft", dirty = true),
            )
        assertEquals(setOf(CHAT_PERSONAL, "edited"), draftThreadIdsForList(null, drafts))
        assertEquals(
            setOf("remote-draft", "edited"),
            draftThreadIdsForList(setOf(CHAT_IN_PROJECT, "remote-draft"), drafts),
        )
        assertEquals(setOf("edited"), draftThreadIdsForList(emptySet(), drafts))
    }

    @Test
    fun draftIndexDoesNotGateRowsAndKeepsSavesMadeDuringTheRead() = runTest {
        val reply = CompletableDeferred<List<String>>()
        var requests = 0
        val service =
            object : Service() {
                override suspend fun draftThreadIds(): List<String> {
                    if (++requests == 1) return reply.await()
                    throw ApiFailure.Network(IOException("No response"))
                }
            }
        withCatchUpModel(service) { model ->
            val earlierDetailRead = model.draftIndexRequestVersion
            model.refresh()
            runCurrent()
            assertTrue(model.uiState.value.threads.isNotEmpty())
            assertNull(model.uiState.value.draftThreadIds)
            model.refresh()
            runCurrent()
            assertEquals(1, requests)

            model.confirmDraftPresence(CHAT_PERSONAL, true)
            model.confirmDraftPresence(CHAT_IN_PROJECT, false)
            model.confirmDraftPresence("opened-thread", true, model.draftIndexRequestVersion)
            reply.complete(listOf(CHAT_IN_PROJECT, "unrelated-thread"))
            runCurrent()
            model.confirmDraftPresence("unrelated-thread", false, earlierDetailRead)
            assertEquals(
                setOf(CHAT_PERSONAL, "opened-thread", "unrelated-thread"),
                model.uiState.value.draftThreadIds,
            )

            model.refresh()
            runCurrent()
            assertEquals(2, requests)
            assertEquals(
                setOf(CHAT_PERSONAL, "opened-thread", "unrelated-thread"),
                model.uiState.value.draftThreadIds,
            )
        }
    }

    @Test
    fun listRetriesUseTheDesignScheduleAndResetAfterSuccess() = runTest {
        var now = 1_000L
        val service = Service()
        withCatchUpModel(service, wallMillis = { now }) { model ->
            model.refresh()
            runCurrent()
            val cachedRows = model.uiState.value.threads
            assertTrue(cachedRows.isNotEmpty())

            val firstAttempt = CompletableDeferred<ChatEvents>()
            val recovery = CompletableDeferred<ChatEvents>()
            val unavailable = ApiFailure.Http(503, null, null, null)
            val attempts = mutableListOf<Long>()
            val retryTimes =
                listOf(3_000L, 6_000L, 12_000L, 24_000L, 48_000L, 96_000L, 144_000L, 192_000L)
            val startedAt = testScheduler.currentTime
            service.listRead = {
                attempts.add(testScheduler.currentTime - startedAt)
                when (attempts.size) {
                    1 -> firstAttempt.await()
                    in 2..retryTimes.size -> throw unavailable
                    else -> recovery.await()
                }
            }
            now += 600_000L
            model.refreshList()
            runCurrent()
            assertEquals(listOf(0L), attempts)
            assertFalse(model.uiState.value.listRefreshProgressVisible)
            now++
            assertFalse(model.uiState.value.listRefreshProgressVisible)
            firstAttempt.completeExceptionally(unavailable)
            runCurrent()
            for ((index, time) in retryTimes.withIndex()) {
                val state = model.uiState.value
                assertEquals(ChatListReadFailure.Retrying, state.listReadFailure)
                assertEquals(index >= 2, state.listRefreshProgressVisible)
                assertEquals(cachedRows, state.threads)

                advanceTimeBy(startedAt + time - testScheduler.currentTime - 1)
                runCurrent()
                assertEquals(index + 1, attempts.size)
                advanceTimeBy(1)
                runCurrent()
                assertEquals(index + 2, attempts.size)
            }
            assertEquals(listOf(0L) + retryTimes, attempts)
            assertEquals(ChatReadPhase.Loading, model.uiState.value.listPhase)
            assertTrue(model.uiState.value.listRetryProgressVisible)

            recovery.complete(page())
            runCurrent()
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertNull(model.uiState.value.listReadFailure)
            assertFalse(model.uiState.value.listRetryProgressVisible)

            var subsequentAttempts = 0
            service.listRead = {
                if (++subsequentAttempts == 1) throw ApiFailure.Http(503, null, null, null)
                page()
            }
            model.refreshList()
            runCurrent()
            assertFalse(model.uiState.value.listRetryProgressVisible)
            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(2, subsequentAttempts)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
        }
    }

    @Test
    fun serverDelaysOverrideOnlyTheCurrentListAndIndicatorRetrySlots() = runTest {
        var fail = false
        val startedAt = testScheduler.currentTime
        val listAttempts = mutableListOf<Long>()
        val indicatorAttempts = mutableListOf<Long>()
        val service =
            Service().apply {
                listRead = {
                    if (fail) {
                        listAttempts.add(testScheduler.currentTime - startedAt)
                        when (listAttempts.size) {
                            1 -> throw ApiFailure.Http(503, null, null, 1)
                            2 -> throw ApiFailure.Http(429, null, null, 0)
                            3 -> throw ApiFailure.Http(503, null, null, null)
                        }
                    }
                    page()
                }
                statusRead = {
                    if (fail) {
                        indicatorAttempts.add(testScheduler.currentTime - startedAt)
                        when (indicatorAttempts.size) {
                            1 -> throw ApiFailure.Http(503, null, null, 2)
                            2 -> throw ApiFailure.Http(429, null, null, 0)
                            3 -> throw ApiFailure.Http(503, null, null, -1)
                        }
                    }
                    Indicators(emptyMap(), emptyMap())
                }
            }
        withCatchUpModel(service) { model ->
            model.refresh()
            runCurrent()
            fail = true
            model.refresh()
            runCurrent()
            assertEquals(listOf(0L), listAttempts)
            assertEquals(listOf(0L), indicatorAttempts)

            advanceTimeBy(999)
            runCurrent()
            assertEquals(listOf(0L), listAttempts)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(listOf(0L, 1_000L, 1_000L), listAttempts)
            assertEquals(listOf(0L), indicatorAttempts)
            assertTrue(model.uiState.value.listRefreshProgressVisible)
            assertFalse(model.uiState.value.indicatorsRefreshProgressVisible)

            advanceTimeBy(1_000)
            runCurrent()
            assertEquals(listOf(0L, 2_000L, 2_000L), indicatorAttempts)
            assertTrue(model.uiState.value.indicatorsRefreshProgressVisible)
            advanceTimeBy(4_999)
            runCurrent()
            assertEquals(3, listAttempts.size)
            assertEquals(3, indicatorAttempts.size)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(listOf(0L, 1_000L, 1_000L, 7_000L), listAttempts)
            assertFalse(model.uiState.value.listRefreshProgressVisible)
            assertTrue(model.uiState.value.indicatorsRefreshProgressVisible)
            advanceTimeBy(1_000)
            runCurrent()
            assertEquals(listOf(0L, 2_000L, 2_000L, 8_000L), indicatorAttempts)
            assertFalse(model.uiState.value.indicatorsRefreshProgressVisible)
        }
    }

    @Test
    fun aStaleConfirmedEmptyListKeepsProgressAfterTheFirstFailure() = runTest {
        var now = 1_000L
        val firstAttempt = CompletableDeferred<ChatEvents>()
        val recovery = CompletableDeferred<ChatEvents>()
        val service = Service().apply { listRead = { page(emptyList()) } }
        withCatchUpModel(service, wallMillis = { now }) { model ->
            model.refresh()
            runCurrent()
            val confirmed = model.uiState.value
            assertEquals(now, confirmed.confirmedAt)
            assertTrue(confirmed.threads.isEmpty())
            now += 600_001L

            service.listRead = { firstAttempt.await() }
            model.refreshList()
            runCurrent()
            assertEquals(ChatReadPhase.Loading, model.uiState.value.listPhase)
            assertTrue(model.uiState.value.listRefreshProgressVisible)

            service.listRead = { recovery.await() }
            firstAttempt.completeExceptionally(ApiFailure.Http(503, null, null, null))
            runCurrent()
            assertEquals(ChatReadPhase.Failed, model.uiState.value.listPhase)
            assertTrue(model.uiState.value.listRetryProgressVisible)
            assertTrue(model.uiState.value.threads.isEmpty())

            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(ChatReadPhase.Loading, model.uiState.value.listPhase)
            assertTrue(model.uiState.value.listRetryProgressVisible)

            recovery.complete(page(emptyList()))
            runCurrent()
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertEquals(now, model.uiState.value.confirmedAt)
            assertFalse(model.uiState.value.listRefreshProgressVisible)
        }
    }

    @Test
    fun aColdListKeepsRetryingWithoutShowingRefreshProgress() = runTest {
        var attempts = 0
        val service =
            Service().apply {
                listRead = {
                    when (++attempts) {
                        1 -> throw ApiFailure.Http(503, null, null, 0)
                        2 -> throw ApiFailure.Http(503, null, null, 1)
                        3 -> throw ApiFailure.Http(503, null, null, null)
                    }
                    page()
                }
            }
        withCatchUpModel(service) { model ->
            model.refresh()
            runCurrent()
            assertEquals(2, attempts)
            advanceTimeBy(999)
            runCurrent()
            assertEquals(2, attempts)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(3, attempts)
            assertEquals(ChatListReadFailure.Retrying, model.uiState.value.listReadFailure)
            assertNull(model.uiState.value.confirmedAt)
            assertFalse(model.uiState.value.listRetryProgressVisible)

            advanceTimeBy(6_000)
            runCurrent()
            assertEquals(4, attempts)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertTrue(model.uiState.value.threads.isNotEmpty())
        }
    }

    @Test
    fun endingTheListScopeDiscardsBothServerRetryDeadlines() = runTest {
        var attempts = 0
        var indicatorAttempts = 0
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
                    if (++indicatorAttempts == 1) throw ApiFailure.Http(503, null, null, 18)
                    return super.indicators()
                }
            }
        withCatchUpModel(service) { model ->
            model.refresh()
            runCurrent()
            assertEquals(1, attempts)
            assertEquals(1, indicatorAttempts)
            assertEquals(ChatListReadFailure.Retrying, model.uiState.value.listReadFailure)
            assertEquals(ChatReadPhase.Loading, model.uiState.value.indicatorsPhase)

            advanceTimeBy(1_000)
            model.selectFilter(ChatListFilter.Archived)
            model.selectFilter(ChatListFilter.Unread)
            runCurrent()
            assertEquals(1, attempts)
            assertEquals(1, indicatorAttempts)
            model.listVisibilityChanged(false)
            assertNull(model.uiState.value.listReadFailure)
            assertEquals(ChatReadPhase.Idle, model.uiState.value.indicatorsPhase)

            advanceTimeBy(4_000)
            model.listVisibilityChanged(true)
            runCurrent()
            assertEquals(2, attempts)
            assertEquals(2, indicatorAttempts)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.indicatorsPhase)
            advanceTimeBy(20_000)
            runCurrent()
            assertEquals(2, attempts)
            assertEquals(2, indicatorAttempts)
        }
    }

    @Test
    fun projectAndIndicatorReadsRecoverIndependentlyAndKeepConfirmedContent() = runTest {
        val projectAttempts = mutableListOf<Long>()
        val indicatorAttempts = mutableListOf<Long>()
        val realtime = TestRealtimeService()
        var failing = false
        val unread = mapOf(CHAT_PERSONAL to CHAT_DATE)
        val service =
            object : Service() {
                override suspend fun projectEvents(since: Long): ProjectEvents {
                    if (failing) {
                        projectAttempts.add(testScheduler.currentTime)
                        if (projectAttempts.size == 1) throw ApiFailure.Http(429, null, null, 5)
                    }
                    return super.projectEvents(since)
                }

                override suspend fun indicators(): Indicators {
                    if (!failing) return Indicators(emptyMap(), unread)
                    indicatorAttempts.add(testScheduler.currentTime)
                    if (indicatorAttempts.size <= 3)
                        throw ApiFailure.Network(IOException("No response"))
                    return Indicators(emptyMap(), emptyMap())
                }
            }
        withCatchUpModel(service, realtime) { model ->
            model.refresh()
            model.updates.foreground(true)
            runCurrent()
            val confirmed = model.uiState.value
            assertNotNull(confirmed.projectsSource)
            assertEquals(unread, confirmed.displayUnreadAt)
            assertFalse(confirmed.threads.isEmpty())

            failing = true
            val start = testScheduler.currentTime
            model.refresh()
            runCurrent()
            realtime.invalidate(ChatChanges(list = true, indicators = true))
            runCurrent()
            advanceTimeBy(2_999)
            runCurrent()
            assertEquals(listOf(start), projectAttempts)
            assertEquals(listOf(start), indicatorAttempts)
            assertEquals(ChatReadPhase.Loading, model.uiState.value.projectsPhase)
            assertEquals(ChatReadPhase.Loading, model.uiState.value.indicatorsPhase)
            assertEquals(confirmed.projects, model.uiState.value.projects)
            assertEquals(confirmed.threads, model.uiState.value.threads)
            assertEquals(unread, model.uiState.value.displayUnreadAt)

            advanceTimeBy(1)
            runCurrent()
            assertEquals(listOf(start, start + 3_000), indicatorAttempts)
            assertEquals(listOf(start), projectAttempts)
            advanceTimeBy(2_000)
            runCurrent()
            assertEquals(listOf(start, start + 5_000), projectAttempts)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.projectsPhase)
            assertEquals(ChatReadPhase.Loading, model.uiState.value.indicatorsPhase)
            advanceTimeBy(1_000)
            runCurrent()
            assertEquals(ChatReadPhase.Loading, model.uiState.value.indicatorsPhase)
            assertTrue(model.uiState.value.indicatorsRetryProgressVisible)
            assertEquals(unread, model.uiState.value.displayUnreadAt)
            advanceTimeBy(9_000)
            runCurrent()
            assertEquals(
                listOf(start, start + 3_000, start + 6_000, start + 12_000),
                indicatorAttempts,
            )
            assertEquals(ChatReadPhase.Ready, model.uiState.value.indicatorsPhase)
            assertEquals(emptyMap<String, String>(), model.uiState.value.displayUnreadAt)
            assertEquals(listOf(start, start + 5_000), projectAttempts)
        }
    }

    @Test
    fun switchingFiltersKeepsIndicatorBackoffUntilTheFourthAttemptSucceeds() = runTest {
        var now = 1_000L
        val unread = mapOf(CHAT_PERSONAL to CHAT_DATE)
        val refreshedUnread = Indicators(emptyMap(), unread)
        val firstAttempt = CompletableDeferred<Indicators>()
        val unavailable = ApiFailure.Http(503, null, null, null)
        val attempts = mutableListOf<Long>()
        var failing = false
        val service =
            Service().apply {
                statusRead = {
                    if (failing) {
                        attempts.add(testScheduler.currentTime)
                        if (attempts.size == 1) firstAttempt.await()
                        if (attempts.size <= 3) throw unavailable
                    }
                    refreshedUnread
                }
            }
        withCatchUpModel(service, wallMillis = { now }) { model ->
            model.refresh()
            runCurrent()
            assertEquals(unread, model.uiState.value.displayUnreadAt)
            val start = testScheduler.currentTime
            failing = true
            now += 600_000L
            model.refreshIndicators()
            runCurrent()
            assertFalse(model.uiState.value.indicatorsRefreshProgressVisible)
            now++
            assertFalse(model.uiState.value.indicatorsRefreshProgressVisible)
            firstAttempt.completeExceptionally(ApiFailure.Http(503, null, null, 1L))
            runCurrent()
            assertFalse(model.uiState.value.indicatorsRefreshProgressVisible)
            advanceTimeBy(500)
            model.selectFilter(ChatListFilter.Archived)
            advanceTimeBy(1_500)
            model.selectFilter(ChatListFilter.Unread)
            advanceTimeBy(1_999)
            runCurrent()
            assertEquals(listOf(start, start + 1_000), attempts)
            assertFalse(model.uiState.value.indicatorsRefreshProgressVisible)
            advanceTimeBy(1)
            runCurrent()
            assertTrue(model.uiState.value.indicatorsRefreshProgressVisible)
            assertEquals(unread, model.uiState.value.displayUnreadAt)
            assertEquals(ChatReadPhase.Loading, model.uiState.value.indicatorsPhase)
            model.selectFilter(ChatListFilter.Muted)
            advanceTimeBy(5_999)
            runCurrent()
            assertEquals(3, attempts.size)
            assertTrue(model.uiState.value.indicatorsRetryProgressVisible)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(listOf(start, start + 1_000, start + 4_000, start + 10_000), attempts)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.indicatorsPhase)
            assertFalse(model.uiState.value.indicatorsRefreshProgressVisible)
        }
    }

    @Test
    fun reopeningTheListRestartsBackoffAndKeepsConfirmedUnread() = runTest {
        var listAttempts = 0
        var indicatorAttempts = 0
        var failing = false
        val unread = mapOf(CHAT_PERSONAL to CHAT_DATE)
        val service =
            Service().apply {
                listRead = {
                    if (failing) {
                        listAttempts++
                        throw ApiFailure.Http(503, null, null, null)
                    }
                    page()
                }
                statusRead = {
                    if (failing) {
                        indicatorAttempts++
                        throw ApiFailure.Http(503, null, null, null)
                    }
                    Indicators(emptyMap(), unread)
                }
            }
        withCatchUpModel(service) { model ->
            model.refresh()
            runCurrent()
            failing = true
            model.refresh()
            runCurrent()
            advanceTimeBy(6_000)
            runCurrent()
            assertEquals(3, listAttempts)
            assertEquals(3, indicatorAttempts)
            assertEquals(ChatReadPhase.Loading, model.uiState.value.indicatorsPhase)
            assertTrue(model.uiState.value.listRetryProgressVisible)
            assertTrue(model.uiState.value.indicatorsRetryProgressVisible)
            model.listVisibilityChanged(false)
            advanceTimeBy(60_000)
            runCurrent()
            assertEquals(3, listAttempts)
            assertEquals(3, indicatorAttempts)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.indicatorsPhase)
            assertFalse(model.uiState.value.listRetryProgressVisible)
            assertFalse(model.uiState.value.indicatorsRetryProgressVisible)
            assertEquals(unread, model.uiState.value.displayUnreadAt)

            model.listVisibilityChanged(true)
            runCurrent()
            assertEquals(4, listAttempts)
            assertEquals(4, indicatorAttempts)
            assertFalse(model.uiState.value.listRetryProgressVisible)
            assertFalse(model.uiState.value.indicatorsRetryProgressVisible)
            assertEquals(unread, model.uiState.value.displayUnreadAt)
            failing = false
            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.indicatorsPhase)
        }
    }

    @Test
    fun rowWriteVerificationDoesNotWaitForBackgroundIndicatorRetry() = runTest {
        var now = 1_000L
        val verification = CompletableDeferred<Indicators>()
        val unread = mapOf(CHAT_PERSONAL to CHAT_DATE)
        var attempts = 0
        val service =
            object : Service() {
                override suspend fun indicators(): Indicators =
                    when (++attempts) {
                        1 -> Indicators(emptyMap(), unread)
                        2 -> throw ApiFailure.Http(503, null, null, null)
                        else -> verification.await()
                    }

                override suspend fun markRead(threadId: String) = ReadState(CHAT_DATE)
            }
        withCatchUpModel(service, wallMillis = { now }) { model ->
            model.refresh()
            runCurrent()
            assertTrue(model.uiState.value.isUnread(CHAT_PERSONAL))
            now += 600_001L
            model.refreshIndicators()
            runCurrent()
            assertEquals(2, attempts)
            assertEquals(ChatReadPhase.Loading, model.uiState.value.indicatorsPhase)
            assertTrue(model.uiState.value.indicatorsRefreshProgressVisible)
            assertFalse(model.uiState.value.listRefreshProgressVisible)

            assertTrue(model.performRowAction(CHAT_PERSONAL, ChatRowAction.MarkRead))
            runCurrent()
            assertEquals(3, attempts)
            assertTrue(model.uiState.value.indicatorsRefreshProgressVisible)
            verification.complete(Indicators(emptyMap(), emptyMap()))
            runCurrent()
            assertFalse(model.uiState.value.isUnread(CHAT_PERSONAL))
            assertNull(model.uiState.value.failedRowAction)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.indicatorsPhase)
            assertFalse(model.uiState.value.indicatorsRefreshProgressVisible)
            advanceTimeBy(6_000)
            runCurrent()
            assertEquals(3, attempts)
        }
    }

    @Test
    fun aConfirmedWorkspaceAccessFailureStopsListRetries() = runTest {
        val service = Service()
        withCatchUpModel(service) { model ->
            model.refresh()
            runCurrent()
            var attempts = 0
            service.listRead = {
                val status = if (++attempts <= 3) 503 else 403
                throw ApiFailure.Http(status, null, null, null)
            }
            model.refreshList()
            runCurrent()
            advanceTimeBy(6_000)
            runCurrent()
            assertTrue(model.uiState.value.listRetryProgressVisible)
            advanceTimeBy(6_000)
            runCurrent()
            assertEquals(ChatListReadFailure.NeedsRetry, model.uiState.value.listReadFailure)
            assertFalse(model.uiState.value.listRetryProgressVisible)
            advanceTimeBy(60_000)
            runCurrent()
            assertEquals(4, attempts)
        }
    }

    @Test
    fun listRetriesContinueAcrossFilterChanges() = runTest {
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

            var attempts = 1
            service.listRead = {
                attempts++
                throw unavailable
            }
            first.completeExceptionally(unavailable)
            runCurrent()
            advanceTimeBy(5_999)
            runCurrent()
            assertFalse(model.uiState.value.listRetryProgressVisible)

            advanceTimeBy(1)
            runCurrent()
            assertEquals(3, attempts)
            assertTrue(model.uiState.value.listRetryProgressVisible)
            model.selectFilter(ChatListFilter.Archived)
            assertTrue(model.uiState.value.listRetryProgressVisible)

            service.listRead = {
                attempts++
                page()
            }
            advanceTimeBy(6_000)
            runCurrent()
            assertEquals(4, attempts)
            assertEquals(ChatListFilter.Archived, model.uiState.value.filter)
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertFalse(model.uiState.value.listRetryProgressVisible)
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
                    Indicators(emptyMap(), emptyMap())
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
                ),
            )
            realtime.invalidate()
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
            assertEquals(
                IndicatorsThreadsValue.UNREAD,
                model.uiState.value.indicators?.threads?.get(CHAT_PERSONAL),
            )
            service.statusRead = {
                Indicators(mapOf(CHAT_PERSONAL to IndicatorsThreadsValue.ACTIVE), emptyMap())
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
    fun unchangedRefreshRenewsTimeAndRetriesUnsavedRows() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val root = temporary.newFolder()
        val cache = cache(root, dispatcher)
        val store = ViewModelStore()
        var confirmedAt = 10_000L
        try {
            val service = Service()
            val model =
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
                                wallMillis = { confirmedAt },
                            )
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
            confirmedAt += 1_000L
            model.refresh()
            advanceUntilIdle()
            assertEquals(ChatReadPhase.Ready, model.uiState.value.listPhase)
            assertFalse(model.uiState.value.cacheUnavailable)
            assertEquals(confirmedAt, model.uiState.value.confirmedAt)
            assertSame(initial.threads, model.uiState.value.threads)
            assertSame(initial.threadsByRecency, model.uiState.value.threadsByRecency)
            cache(root, dispatcher)
                .open(identity) { true }
                .use { assertEquals(confirmedAt, it.load()?.confirmedAt) }
            service.listRead = {
                json.decodeFromString<ChatEvents>(
                    """{"events":[${chatEventWire(id = "77777777-7777-4777-8777-777777777777", seq = 23, kind = "renamed", title = "Updated")}],"hasMore":false}""",
                )
            }
            model.refreshList()
            advanceUntilIdle()
            val unsaved = model.uiState.value
            assertEquals("Updated", unsaved.threads.single().title)
            assertTrue(unsaved.cacheUnavailable)
            execute(root, "DROP TRIGGER fail_chat_write")
            confirmedAt += 1_000L
            model.refreshList()
            advanceUntilIdle()
            assertSame(unsaved.threads, model.uiState.value.threads)
            assertEquals(confirmedAt, model.uiState.value.confirmedAt)
            assertFalse(model.uiState.value.cacheUnavailable)
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
                                title =
                                    if (url == oldSnapshot.url) "Superseded" else "Other device",
                            ),
                        ),
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
                                    ),
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
            assertEquals("Newest", model.uiState.value.threads.single().title)

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
}
