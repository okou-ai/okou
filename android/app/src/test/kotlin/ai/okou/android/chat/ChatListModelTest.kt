package ai.okou.android.chat

import ai.okou.android.CHAT_AGENT
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_EVENT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.TestChatService
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.Agents
import ai.okou.android.api.generated.AgentsItem
import ai.okou.android.api.generated.AgentsItemVisibility
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.ChatSnapshot
import ai.okou.android.api.generated.FeatureSwitches
import ai.okou.android.api.generated.Indicators
import ai.okou.android.api.generated.IndicatorsThreadsValue
import ai.okou.android.api.generated.ProjectEvents
import ai.okou.android.api.generated.ProjectSnapshot
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
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
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

    private inner class Service : TestChatService() {
        var flagsRead: suspend () -> FeatureSwitches = { FeatureSwitches(emptyMap(), emptyMap()) }
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

        override suspend fun featureSwitches() = flagsRead()

        override suspend fun chatSnapshot() =
            json.decodeFromString<ChatSnapshot>(
                """{"chatThreads":[],"latestEventId":null,"latestSeqId":null}"""
            )

        override suspend fun chatEvents(since: Long?) = listRead()

        override suspend fun agents() = agentRead()

        override suspend fun indicators() = statusRead()
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
                    flagsRead = { throw IOException("offline") }
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
            assertEquals(ChatReadPhase.Failed, model.uiState.value.projectsSettingsPhase)
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
            service.listRead = {
                json.decodeFromString<ChatEvents>(
                    """{"events":[${chatEventWire(id = "77777777-7777-4777-8777-777777777777", seq = 23, kind = "renamed", title = "Updated")}],"hasMore":false}"""
                )
            }
            model.refreshList()
            advanceUntilIdle()
            assertEquals("Updated", model.uiState.value.threads.single().title)
            assertTrue(model.uiState.value.cacheUnavailable)
            execute(root, "DROP TRIGGER fail_chat_write")
            model.refreshList()
            advanceUntilIdle()
            assertEquals("Updated", model.uiState.value.threads.single().title)
            assertFalse(model.uiState.value.cacheUnavailable)
            service.agentRead = { Service().agents().map { it.copy(displayName = "Updated Okou") } }
            service.flagsRead = { FeatureSwitches(emptyMap(), mapOf("projects" to true)) }
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
                    assertTrue(saved.navigation.projectsEnabled)
                }
        } finally {
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
                override suspend fun featureSwitches() =
                    FeatureSwitches(emptyMap(), mapOf("projects" to true))

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
    fun networkListBecomesVisibleOnlyAfterTheDiskWriteAndReadbackComplete() = runTest {
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
    fun heldProjectsSettingsDoNotBlockTheListAndFailureRetainsConfirmedContent() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val cache = cache(temporary.newFolder(), dispatcher)
        val store = ViewModelStore()
        val flags = CompletableDeferred<FeatureSwitches>()
        try {
            val service = Service().apply { flagsRead = { flags.await() } }
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
            flags.completeExceptionally(IOException("offline"))
            advanceUntilIdle()
            assertEquals(ChatReadPhase.Failed, model.uiState.value.projectsSettingsPhase)
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
            flags.complete(FeatureSwitches(emptyMap(), emptyMap()))
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
