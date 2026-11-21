package ai.okou.android.chat

import ai.okou.android.auth.WorkspaceIdentity
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ProjectExpansionStoreTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun choicesSurviveReopeningAndStayWithTheirAccountWorkspaceAndOrigin() = runTest {
        val file = temporary.root.resolve("project-expansion.preferences_pb")
        val identity = WorkspaceIdentity("https://api.okou.ai/", "user-a", "session-a", "org-a")
        val otherWorkspace = identity.copy(workspaceId = "org-b")
        val otherAccount = identity.copy(userId = "user-b")
        val otherOrigin = identity.copy(apiOrigin = "https://preview.okou.ai/")
        withStore(file) { store ->
            assertEquals(emptySet<String>(), store.observe(identity).first())
            coroutineScope {
                launch { store.setExpanded(identity, "project-a", true) }
                launch { store.setExpanded(identity, "project-b", true) }
                launch { store.setExpanded(otherWorkspace, "project-b", true) }
            }
        }
        withStore(file) { store ->
            val newSession = identity.copy(sessionId = "session-b")
            assertEquals(setOf("project-a", "project-b"), store.observe(newSession).first())
            assertEquals(setOf("project-b"), store.observe(otherWorkspace).first())
            assertEquals(emptySet<String>(), store.observe(otherAccount).first())
            assertEquals(emptySet<String>(), store.observe(otherOrigin).first())
            store.setExpanded(newSession, "project-b", false)
        }
        withStore(file) { store ->
            assertEquals(setOf("project-a"), store.observe(identity).first())
            assertEquals(setOf("project-b"), store.observe(otherWorkspace).first())
        }
    }

    private suspend fun withStore(file: File, exercise: suspend (ProjectExpansionStore) -> Unit) =
        coroutineScope {
            val job = Job(coroutineContext[Job])
            val store =
                ProjectExpansionStore(
                    PreferenceDataStoreFactory.create(
                        scope = CoroutineScope(coroutineContext + job)
                    ) {
                        file
                    }
                )
            try {
                exercise(store)
            } finally {
                job.cancelAndJoin()
            }
        }
}
