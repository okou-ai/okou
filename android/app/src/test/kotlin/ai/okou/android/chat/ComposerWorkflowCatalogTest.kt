package ai.okou.android.chat

import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ComposerWorkflows
import ai.okou.android.api.generated.ComposerWorkflowsItem
import ai.okou.android.auth.WorkspaceIdentity
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class ComposerWorkflowCatalogTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun showsTheCatalogWhileRecentHistoryIsStillLoading() = runTest {
        val workflow = ComposerWorkflowsItem("release", "release-check", null, null)
        val recentRequested = CompletableDeferred<Unit>()
        val recentResponse = CompletableDeferred<List<String>>()
        coroutineScope {
            val service =
                Service(
                    recent = {
                        recentRequested.complete(Unit)
                        recentResponse.await()
                    },
                ) {
                    listOf(workflow)
                }
            val catalog =
                ComposerWorkflowCatalog(service, temporary.newFile(), this, { true }, { throw it })
            catalog.refresh()
            try {
                recentRequested.await()
                assertEquals(listOf(workflow), catalog.state.value.snapshot?.workflows)
            } finally {
                recentResponse.complete(listOf(workflow.id))
            }
            assertEquals(
                listOf(workflow.id),
                catalog.state.first { it.snapshot?.recent?.isNotEmpty() == true }.snapshot?.recent,
            )
        }
    }

    @Test
    @OptIn(ExperimentalCoroutinesApi::class)
    fun recordsAnAcceptedCommandFromTheCatalogRefreshAlreadyInFlight() = runTest {
        val existing = ComposerWorkflowsItem("review", "review-changes", null, null)
        val added = ComposerWorkflowsItem("release", "release-check", null, null)
        val refreshStarted = CompletableDeferred<Unit>()
        val refreshResponse = CompletableDeferred<List<ComposerWorkflowsItem>>()
        val writes = mutableListOf<List<String>>()
        val file = temporary.newFile()
        coroutineScope {
            val service = Service { listOf(existing) }
            ComposerWorkflowCatalog(service, file, this, { true }, { throw it }).refresh()
        }
        coroutineScope {
            val service =
                Service(
                    record = { ids ->
                        writes += ids
                        ids
                    },
                ) {
                    refreshStarted.complete(Unit)
                    refreshResponse.await()
                }
            val catalog = ComposerWorkflowCatalog(service, file, this, { true }, { throw it })
            catalog.refresh()
            try {
                refreshStarted.await()
                catalog.accepted("/release-check")
                runCurrent()
            } finally {
                refreshResponse.complete(listOf(existing, added))
            }
        }
        assertEquals(listOf(listOf(added.id)), writes)
    }

    @Test
    fun failedRecentWritePromotesLocallyAndReopensWithTheConfirmedOrder() = runTest {
        val existing = ComposerWorkflowsItem("review", "review-changes", null, null)
        val used = ComposerWorkflowsItem("release", "release-check", null, null)
        val workflows = listOf(existing, used)
        val confirmed = listOf(existing.id)
        val file = temporary.newFile()
        coroutineScope {
            val service =
                Service(
                    recent = { confirmed },
                    record = { throw ApiFailure.Http(503, null, null, null) },
                ) {
                    workflows
                }
            val catalog = ComposerWorkflowCatalog(service, file, this, { true }, { throw it })
            catalog.refresh()
            catalog.state.first { it.snapshot?.recent == confirmed }
            catalog.accepted("/release-check")
            assertEquals(
                listOf(used.id, existing.id),
                catalog.state
                    .first { it.snapshot?.recent?.firstOrNull() == used.id }
                    .snapshot
                    ?.recent,
            )
        }
        val refreshStarted = CompletableDeferred<Unit>()
        val refreshResponse = CompletableDeferred<Unit>()
        coroutineScope {
            val service =
                Service(recent = { confirmed }) {
                    refreshStarted.complete(Unit)
                    refreshResponse.await()
                    workflows
                }
            val reopened = ComposerWorkflowCatalog(service, file, this, { true }, { throw it })
            reopened.refresh()
            try {
                refreshStarted.await()
                assertEquals(
                    ComposerWorkflowSnapshot(workflows, confirmed),
                    reopened.state.value.snapshot,
                )
            } finally {
                refreshResponse.complete(Unit)
            }
        }
    }

    @Test
    fun restoresConfirmedCatalogForTheSameScopeAndClearsItOnDeniedRead() = runTest {
        val store =
            ComposerJournalStore(ApplicationProvider.getApplicationContext(), temporary.root)
        val identity =
            WorkspaceIdentity("https://api.example/", "user-a", "session-a", "org-a", "scope-a")
        val file = store.workflowCacheFile(identity)
        val item = ComposerWorkflowsItem("workflow", "release-check", "Release check", null)
        val available = Service { listOf(item) }
        try {
            coroutineScope {
                ComposerWorkflowCatalog(available, file, this, { true }, { throw it }).refresh()
            }

            val allowResponse = CompletableDeferred<Unit>()
            val reads = Channel<Unit>(3)
            val denied = Service {
                reads.send(Unit)
                allowResponse.await()
                throw ApiFailure.Http(403, null, null, null)
            }
            coroutineScope {
                val reopened =
                    ComposerWorkflowCatalog(
                        denied,
                        store.workflowCacheFile(identity.copy(sessionId = "session-b")),
                        this,
                        { true },
                        { throw it },
                    )
                val otherAccount =
                    ComposerWorkflowCatalog(
                        denied,
                        store.workflowCacheFile(identity.copy(userId = "user-b")),
                        this,
                        { true },
                        { throw it },
                    )
                val otherAccess =
                    ComposerWorkflowCatalog(
                        denied,
                        store.workflowCacheFile(identity.copy(authorizationScope = "scope-b")),
                        this,
                        { true },
                        { throw it },
                    )
                reopened.refresh()
                otherAccount.refresh()
                otherAccess.refresh()
                try {
                    repeat(3) { reads.receive() }
                    val restored = reopened.state.first { it.snapshot != null }
                    assertEquals(
                        ComposerWorkflowSnapshot(listOf(item), listOf(item.id)),
                        restored.snapshot,
                    )
                    assertNull(otherAccount.state.value.snapshot)
                    assertNull(otherAccess.state.value.snapshot)
                } finally {
                    allowResponse.complete(Unit)
                    reads.close()
                }
                assertNull(reopened.state.first { it.failed }.snapshot)
            }
            assertFalse(file.exists())
        } finally {
            store.close()
        }
    }

    private class Service(
        private val recent: suspend () -> List<String> = { listOf("workflow") },
        private val record: suspend (List<String>) -> List<String> = { it },
        private val read: suspend () -> ComposerWorkflows,
    ) : ComposerWorkflowService {
        override suspend fun composerWorkflows() = read()

        override suspend fun recentComposerWorkflows() = recent()

        override suspend fun recordComposerWorkflowUse(ids: List<String>) = record(ids)
    }
}
