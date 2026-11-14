package ai.okou.android.instructions

import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.PersonalInstructions
import ai.okou.android.auth.WorkspaceIdentity
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class PersonalInstructionsStorageTest {
    @get:Rule val temporary = TemporaryFolder()
    private val identity = WorkspaceIdentity("https://api.example/", "user-a", "session-a", "org-a")
    private val base =
        PersonalInstructions("org-a", "user-a", "Saved", "2026-11-14T00:00:00Z", "v1")

    @Test
    fun supersededPreparationIsNotADurableReceiptForTheAttempt() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val store =
            PersonalInstructionsDraftStore(
                ApplicationProvider.getApplicationContext(),
                temporary.newFolder(),
                dispatcher,
            )
        try {
            val attempt =
                store.persist(identity, InstructionsDraft("Attempt", base, attempted = true))
            val newer = store.persist(identity, InstructionsDraft("Newer draft", base))
            assertEquals(InstructionsCommit.Superseded, attempt.await())
            assertEquals(InstructionsCommit.Committed, newer.await())
            val restored = store.load(identity)
            assertEquals("Newer draft", restored.draft?.content)
            assertFalse(checkNotNull(restored.draft).attempted)
            assertTrue(restored.durable)
        } finally {
            store.close()
        }
    }

    @Test
    fun latestScopedIntentReopensWithoutBundleOrSqliteRowLimits() = runTest {
        val directory = temporary.newFolder()
        val dispatcher = StandardTestDispatcher(testScheduler)
        var store =
            PersonalInstructionsDraftStore(
                ApplicationProvider.getApplicationContext(),
                directory,
                dispatcher,
            )
        val large = "指令👋".repeat(350_000)
        val other = identity.copy(workspaceId = "org-b")
        try {
            repeat(30) { store.persist(identity, InstructionsDraft("edit-$it", base)) }
            store.persist(identity, null)
            store.persist(identity, InstructionsDraft(large, base, attempted = true)).await()
            store
                .persist(other, InstructionsDraft("Other workspace", base.copy(orgId = "org-b")))
                .await()
            store.close()
            store =
                PersonalInstructionsDraftStore(
                    ApplicationProvider.getApplicationContext(),
                    directory,
                    dispatcher,
                )
            val restored = store.load(identity.copy(sessionId = "new-session"))
            assertTrue(restored.durable)
            assertEquals(large, restored.draft?.content)
            assertTrue(checkNotNull(restored.draft).attempted)
            assertEquals("v1", restored.draft.base.version)
            assertEquals("Other workspace", store.load(other).draft?.content)
            assertNull(store.load(identity.copy(userId = "someone-else")).draft)
            assertNull(store.load(identity.copy(apiOrigin = "https://other.example/")).draft)
            store.persist(identity, null).await()
            assertNull(store.load(identity).draft)
            assertEquals("Other workspace", store.load(other).draft?.content)
        } finally {
            store.close()
        }
    }

    @Test
    fun unreadableDocumentDoesNotBecomeAnEmptyOverwrite() = runTest {
        val directory = temporary.newFolder()
        val dispatcher = StandardTestDispatcher(testScheduler)
        var store =
            PersonalInstructionsDraftStore(
                ApplicationProvider.getApplicationContext(),
                directory,
                dispatcher,
            )
        try {
            store.persist(identity, InstructionsDraft("Only copy", base)).await()
            store.close()
            val document = directory.listFiles()!!.single()
            document.writeText("interrupted-or-corrupt-document")
            store =
                PersonalInstructionsDraftStore(
                    ApplicationProvider.getApplicationContext(),
                    directory,
                    dispatcher,
                )
            var failure: Exception? = null
            try {
                store.load(identity)
            } catch (error: Exception) {
                failure = error
            }
            assertNotNull(failure)
            assertEquals("interrupted-or-corrupt-document", document.readText())
        } finally {
            store.close()
        }
    }
}
