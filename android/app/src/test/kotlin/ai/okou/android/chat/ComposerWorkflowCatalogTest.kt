package ai.okou.android.chat

import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ComposerWorkflows
import ai.okou.android.api.generated.ComposerWorkflowsItem
import ai.okou.android.auth.WorkspaceIdentity
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
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

    private class Service(private val read: suspend () -> ComposerWorkflows) :
        ComposerWorkflowService {
        override suspend fun composerWorkflows() = read()

        override suspend fun recentComposerWorkflows() = listOf("workflow")

        override suspend fun recordComposerWorkflowUse(ids: List<String>) = ids
    }
}
