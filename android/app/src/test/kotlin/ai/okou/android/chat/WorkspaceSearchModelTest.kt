package ai.okou.android.chat

import ai.okou.android.EmptyWorkspaceSearchService
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
    fun obsoleteMessagesCannotPublishAndReconnectRepeatsOnlyTheCurrentKeyword() = runTest {
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
        val hit = SearchMessageHit("thread", 23, "Okou", "current", listOf(0..6))
        try {
            model.update("older", WorkspaceSearchType.All, connected = true)
            advanceTimeBy(300)
            runCurrent()
            model.update("current", WorkspaceSearchType.Messages, connected = true)
            advanceTimeBy(300)
            runCurrent()
            pending.remove("current")!!.resume(listOf(hit))
            pending.remove("older")!!.resume(listOf(hit.copy(content = "obsolete")))
            runCurrent()
            assertEquals(SearchRead.Ready(listOf(hit)), model.results.value.messages)
            model.update("current", WorkspaceSearchType.Chats, connected = false)
            model.update("current", WorkspaceSearchType.Chats, connected = true)
            advanceTimeBy(300)
            assertEquals(listOf("older", "current"), requests)
            model.update("current", WorkspaceSearchType.Messages, connected = true)
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
    fun artifactContinuationKeepsRowsAndIgnoresObsoleteCursors() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        val first = SearchArtifactHit("first", "Release plan", ArtifactKind.File)
        val second = SearchArtifactHit("second", "Release site", ArtifactKind.Website)
        val calls = mutableListOf<Pair<String, String?>>()
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
                        else -> SearchArtifactPage(listOf(first, second), null)
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
                connected = true,
                artifactsAvailable = true,
            )
            advanceTimeBy(300)
            runCurrent()
            assertEquals(SearchRead.Ready(listOf(first), "page-two"), model.results.value.artifacts)
            model.update(
                "release",
                WorkspaceSearchType.Artifacts,
                connected = true,
                artifactsAvailable = true,
            )
            model.nextArtifacts("release", "page-two")
            model.nextArtifacts("release", "page-two")
            runCurrent()
            assertEquals(SearchRead.Ready(listOf(first, second)), model.results.value.artifacts)

            model.update(
                "history",
                WorkspaceSearchType.Artifacts,
                connected = true,
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
                listOf("release" to null, "release" to "page-two", "history" to null),
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

    private suspend fun withStore(file: File, run: suspend (SearchRecentChatsStore) -> Unit) =
        coroutineScope {
            val job = Job(coroutineContext[Job])
            val store =
                SearchRecentChatsStore(
                    PreferenceDataStoreFactory.create(
                        scope = CoroutineScope(coroutineContext + job)
                    ) {
                        file
                    }
                )
            try {
                run(store)
            } finally {
                job.cancelAndJoin()
            }
        }
}
