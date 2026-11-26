package ai.okou.android.chat

import ai.okou.android.CHAT_DATE
import ai.okou.android.EmptyWorkspaceSearchService
import ai.okou.android.api.ApiFailure
import ai.okou.android.artifacts.ArtifactKind
import ai.okou.android.auth.WorkspaceIdentity
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.io.File
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class WorkspaceSearchModelTest {
    @get:Rule val temporary = TemporaryFolder()

    private val identity = WorkspaceIdentity("https://api.okou.ai/", "user", "session", "org")

    @Test
    fun obsoleteMessagesCannotPublishAndReturningToScopeRechecksOnlyTheCurrentKeyword() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        val requests = mutableListOf<String>()
        val pending = mutableMapOf<String, Continuation<List<SearchMessageHit>>>()
        val service =
            object : WorkspaceSearchService by EmptyWorkspaceSearchService {
                // Hold a response independently of cancellation to exercise the consumer's fence.
                override suspend fun searchMessages(keyword: String): List<SearchMessageHit> =
                    suspendCoroutine {
                        requests.add(keyword)
                        pending[keyword] = it
                    }
            }
        val model =
            ViewModelProvider(
                store,
                viewModelFactory {
                    initializer {
                        WorkspaceSearchModel(
                            service,
                            identity,
                            recents = null,
                            { true },
                            { throw it },
                        )
                    }
                },
            )[WorkspaceSearchModel::class.java]
        val hit = SearchMessageHit("thread", 23, "current", listOf(0..6))
        try {
            model.update("older", WorkspaceSearchType.All)
            advanceTimeBy(300)
            runCurrent()
            model.update("current", WorkspaceSearchType.Messages)
            advanceTimeBy(300)
            runCurrent()
            pending.remove("current")!!.resume(listOf(hit))
            pending.remove("older")!!.resume(listOf(hit.copy(content = "obsolete")))
            runCurrent()
            assertEquals(SearchRead.Ready(listOf(hit)), model.results.value.messages)
            model.update("current", WorkspaceSearchType.Chats)
            advanceTimeBy(300)
            assertEquals(listOf("older", "current"), requests)
            model.update("current", WorkspaceSearchType.Messages)
            advanceTimeBy(300)
            runCurrent()
            pending.remove("current")!!.resume(listOf(hit))
            runCurrent()
            assertEquals(listOf("older", "current", "current"), requests)
            assertEquals(SearchRead.Ready(listOf(hit)), model.results.value.messages)
        } finally {
            pending.values.forEach { it.resume(emptyList()) }
            store.clear()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun temporaryMessageReadRecoversForTheSameQueryWithServerBackoff() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        val requests = mutableListOf<String>()
        val hit = SearchMessageHit("thread", 23, "launch", listOf(0..5))
        val service =
            object : WorkspaceSearchService by EmptyWorkspaceSearchService {
                override suspend fun searchMessages(keyword: String): List<SearchMessageHit> {
                    requests.add(keyword)
                    return when (requests.size) {
                        1 -> throw ApiFailure.Http(503, null, null, 1L)
                        2 -> throw ApiFailure.Http(429, null, null, 12L)
                        else -> listOf(hit)
                    }
                }
            }
        val model =
            ViewModelProvider(
                store,
                viewModelFactory {
                    initializer {
                        WorkspaceSearchModel(service, identity, null, { true }, { throw it })
                    }
                },
            )[WorkspaceSearchModel::class.java]
        try {
            model.update("launch", WorkspaceSearchType.Messages)
            advanceTimeBy(300)
            runCurrent()
            assertEquals(listOf("launch"), requests)
            assertEquals(SearchRead.Retrying, model.results.value.messages)
            advanceTimeBy(999)
            runCurrent()
            assertEquals(1, requests.size)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(2, requests.size)
            assertEquals(SearchRead.Retrying, model.results.value.messages)
            advanceTimeBy(11_999)
            runCurrent()
            assertEquals(2, requests.size)

            model.update("launch", WorkspaceSearchType.Messages, visible = false)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(2, requests.size)
            assertEquals(SearchRead.Retrying, model.results.value.messages)

            model.update("launch", WorkspaceSearchType.Messages)
            runCurrent()
            assertEquals(listOf("launch", "launch", "launch"), requests)
            assertEquals(SearchRead.Ready(listOf(hit)), model.results.value.messages)
        } finally {
            store.clear()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun refreshKeepsConfirmedMessagesThroughTwoRetriesAndDropsThemWhenAccessIsLost() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        val hit = SearchMessageHit("thread", 23, "launch", listOf(0..5))
        var requests = 0
        val service =
            object : WorkspaceSearchService by EmptyWorkspaceSearchService {
                override suspend fun searchMessages(keyword: String): List<SearchMessageHit> =
                    when (++requests) {
                        1 -> listOf(hit)
                        in 2..4 -> throw ApiFailure.Http(503, null, null, null)
                        else -> throw ApiFailure.Http(403, null, null, null)
                    }
            }
        val model =
            ViewModelProvider(
                store,
                viewModelFactory {
                    initializer {
                        WorkspaceSearchModel(service, identity, null, { true }, { throw it })
                    }
                },
            )[WorkspaceSearchModel::class.java]
        try {
            model.update("launch", WorkspaceSearchType.Messages)
            advanceTimeBy(300)
            runCurrent()
            val confirmed = SearchRead.Ready(listOf(hit))
            assertEquals(confirmed, model.results.value.messages)

            model.update("launch", WorkspaceSearchType.Messages, visible = false)
            assertEquals(confirmed, model.results.value.messages)
            model.update("launch", WorkspaceSearchType.Messages)
            advanceTimeBy(300)
            runCurrent()
            assertEquals(2, requests)
            assertEquals(confirmed.copy(refreshing = true), model.results.value.messages)

            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(3, requests)
            assertEquals(confirmed.copy(refreshing = true), model.results.value.messages)

            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(4, requests)
            assertEquals(confirmed.copy(refreshFailed = true), model.results.value.messages)

            advanceTimeBy(60_000)
            assertEquals(4, requests)

            model.update("launch", WorkspaceSearchType.Messages, visible = false)
            model.update("launch", WorkspaceSearchType.Messages)
            advanceTimeBy(300)
            runCurrent()
            assertEquals(5, requests)
            assertEquals(SearchRead.AccessLost, model.results.value.messages)
        } finally {
            store.clear()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun artifactContinuationKeepsRowsWhileWaitingToRetryInItsScope() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        val first = SearchArtifactHit("first", "Release plan", ArtifactKind.File)
        val second = SearchArtifactHit("second", "Release site", ArtifactKind.Website)
        val third = SearchArtifactHit("third", "Release overview", ArtifactKind.Presentation)
        val calls = mutableListOf<Pair<String, String?>>()
        var continuationAttempts = 0
        var terminalAttempts = 0
        val finishRetry = CompletableDeferred<Unit>()
        val service =
            object : WorkspaceSearchService by EmptyWorkspaceSearchService {
                override suspend fun searchArtifacts(
                    keyword: String,
                    cursor: String?,
                ): SearchArtifactPage {
                    calls.add(keyword to cursor)
                    return when {
                        keyword != "release" -> SearchArtifactPage(emptyList(), null)
                        cursor == null -> SearchArtifactPage(listOf(first), "page-two")
                        cursor == "page-two" -> {
                            continuationAttempts++
                            if (continuationAttempts == 1)
                                throw ApiFailure.Http(503, null, null, null)
                            SearchArtifactPage(listOf(first, second), "page-three")
                        }
                        else -> {
                            terminalAttempts++
                            if (terminalAttempts == 1) throw ApiFailure.Http(400, null, null, null)
                            finishRetry.await()
                            SearchArtifactPage(listOf(third), null)
                        }
                    }
                }
            }
        val model =
            ViewModelProvider(
                store,
                viewModelFactory {
                    initializer {
                        WorkspaceSearchModel(service, identity, null, { true }, { throw it })
                    }
                },
            )[WorkspaceSearchModel::class.java]
        try {
            model.update(
                "release",
                WorkspaceSearchType.All,
                artifactsAvailable = true,
            )
            advanceTimeBy(300)
            runCurrent()
            assertEquals(SearchRead.Ready(listOf(first), "page-two"), model.results.value.artifacts)
            model.update(
                "release",
                WorkspaceSearchType.Artifacts,
                artifactsAvailable = true,
            )
            model.nextArtifacts("release", "page-two")
            model.nextArtifacts("release", "page-two")
            runCurrent()
            assertEquals(SearchRead.Ready(listOf(first), "page-two"), model.results.value.artifacts)
            assertEquals(ArtifactSearchPaging.Loading, model.results.value.artifactPaging)

            model.update(
                "release",
                WorkspaceSearchType.All,
                artifactsAvailable = true,
            )
            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(1, continuationAttempts)

            model.update(
                "release",
                WorkspaceSearchType.Artifacts,
                artifactsAvailable = true,
            )
            runCurrent()
            val loaded = SearchRead.Ready(listOf(first, second), "page-three")
            assertEquals(loaded, model.results.value.artifacts)
            assertEquals(ArtifactSearchPaging.Idle, model.results.value.artifactPaging)

            model.nextArtifacts("release", "page-three")
            runCurrent()
            assertEquals(loaded, model.results.value.artifacts)
            assertEquals(ArtifactSearchPaging.Failed, model.results.value.artifactPaging)

            model.update("release", WorkspaceSearchType.All, artifactsAvailable = true)
            model.update("release", WorkspaceSearchType.Artifacts, artifactsAvailable = true)
            assertEquals(loaded, model.results.value.artifacts)
            assertEquals(ArtifactSearchPaging.RetryAvailable, model.results.value.artifactPaging)
            model.nextArtifacts("release", "page-three")
            runCurrent()
            assertEquals(loaded, model.results.value.artifacts)
            assertEquals(ArtifactSearchPaging.Retrying, model.results.value.artifactPaging)
            finishRetry.complete(Unit)
            runCurrent()
            val complete = SearchRead.Ready(listOf(first, second, third))
            assertEquals(complete, model.results.value.artifacts)
            assertEquals(ArtifactSearchPaging.Idle, model.results.value.artifactPaging)

            model.update("release", WorkspaceSearchType.Chats, artifactsAvailable = true)
            model.update("release", WorkspaceSearchType.Artifacts, artifactsAvailable = true)
            advanceTimeBy(300)
            runCurrent()
            assertEquals(complete, model.results.value.artifacts)

            model.update(
                "history",
                WorkspaceSearchType.Artifacts,
                artifactsAvailable = true,
            )
            model.nextArtifacts("release", "page-two")
            advanceTimeBy(300)
            runCurrent()
            assertEquals(
                SearchRead.Ready(emptyList<SearchArtifactHit>()),
                model.results.value.artifacts,
            )
            assertEquals(
                listOf(
                    "release" to null,
                    "release" to "page-two",
                    "release" to "page-two",
                    "release" to "page-three",
                    "release" to "page-three",
                    "history" to null,
                ),
                calls,
            )
        } finally {
            store.clear()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun recentsAreBoundedAndStayInTheSameAccountAndWorkspaceAcrossSessions() = runTest {
        val file = temporary.root.resolve("recents.preferences_pb")
        withStore(file) { store ->
            repeat(10) { store.record(identity, "chat$it") }
            store.record(identity, "chat2")
            store.record(identity.copy(workspaceId = "other"), "other-chat")
        }
        withStore(file) { store ->
            assertEquals(
                listOf("chat2", "chat9", "chat8", "chat7", "chat6", "chat5", "chat4", "chat3"),
                store.observe(identity.copy(sessionId = "renewed")).first(),
            )
            assertEquals(
                listOf("other-chat"),
                store.observe(identity.copy(workspaceId = "other")).first(),
            )
            assertEquals(
                emptyList<String>(),
                store.observe(identity.copy(userId = "other")).first(),
            )
        }
    }

    @Test
    fun openingAnArchivedChatPreservesTheEightRecentVisits() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val models = ViewModelStore()
        try {
            withStore(temporary.root.resolve("recents.preferences_pb")) { store ->
                repeat(RecentSearchChatLimit) { store.record(identity, "chat$it") }
                val expected = store.observe(identity).first()
                val model =
                    ViewModelProvider(
                        models,
                        viewModelFactory {
                            initializer {
                                WorkspaceSearchModel(
                                    EmptyWorkspaceSearchService,
                                    identity,
                                    store,
                                    { true },
                                    { throw it },
                                )
                            }
                        },
                    )[WorkspaceSearchModel::class.java]
                val chat =
                    ConfirmedChat(
                        id = "archived",
                        title = "Archived chat",
                        sortAt = CHAT_DATE,
                        createdAt = CHAT_DATE,
                        updatedAt = CHAT_DATE,
                        pinnedAt = null,
                        archived = true,
                        renamedAt = null,
                    )
                model.opened(chat)
                runCurrent()
                assertEquals(expected, store.observe(identity).first())

                model.opened(chat.copy(archived = false))
                assertEquals(
                    listOf(chat.id) + expected.dropLast(1),
                    store.observe(identity).first { it.firstOrNull() == chat.id },
                )
            }
        } finally {
            models.clear()
            Dispatchers.resetMain()
        }
    }

    private suspend fun withStore(file: File, run: suspend (SearchRecentChatsStore) -> Unit) =
        coroutineScope {
            val job = Job(coroutineContext[Job])
            val store =
                SearchRecentChatsStore(
                    PreferenceDataStoreFactory.create(
                        scope = CoroutineScope(coroutineContext + job),
                    ) {
                        file
                    },
                )
            try {
                run(store)
            } finally {
                job.cancelAndJoin()
            }
        }
}
