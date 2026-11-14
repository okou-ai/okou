package ai.okou.android.instructions

import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.PersonalInstructions
import ai.okou.android.auth.WorkspaceIdentity
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.test.core.app.ApplicationProvider
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
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
class PersonalInstructionsModelTest {
    @get:Rule val temporary = TemporaryFolder()
    private val identity = WorkspaceIdentity("https://api.example/", "user-a", "session-a", "org-a")

    private class Service : PersonalInstructionsService {
        var saved =
            PersonalInstructions("org-a", "user-a", "Original", "2026-11-14T00:00:00Z", "v1")
        val writes = mutableListOf<Pair<String, String>>()
        var availability: suspend () -> Boolean = { true }
        var read: suspend () -> PersonalInstructions = { saved }
        var write: suspend (String, String) -> PersonalInstructions = { content, version ->
            if (version != saved.version) throw ApiFailure.Http(409, null, null, null)
            saved.copy(content = content, version = saved.version + "-next").also { saved = it }
        }

        override suspend fun personalInstructionsEnabled() = availability()

        override suspend fun personalInstructions() = read()

        override suspend fun updatePersonalInstructions(
            content: String,
            ifVersion: String,
        ): PersonalInstructions {
            writes += content to ifVersion
            return write(content, ifVersion)
        }
    }

    private fun check(
        blockedDisk: Boolean = false,
        action:
            suspend TestScope.(
                Service,
                PersonalInstructionsDraftStore,
                (Boolean) -> PersonalInstructionsModel,
                MutableList<Exception>,
            ) -> Unit,
    ) = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val service = Service()
        val store =
            PersonalInstructionsDraftStore(
                ApplicationProvider.getApplicationContext(),
                if (blockedDisk) temporary.newFile() else temporary.newFolder(),
                dispatcher,
            )
        val viewModels = mutableListOf<ViewModelStore>()
        val failures = mutableListOf<Exception>()
        fun model(clearPrevious: Boolean): PersonalInstructionsModel {
            if (clearPrevious) viewModels.lastOrNull()?.clear()
            val owner = ViewModelStore().also { viewModels += it }
            return ViewModelProvider(
                owner,
                viewModelFactory {
                    initializer {
                        PersonalInstructionsModel(service, store, identity, { true }, failures::add)
                    }
                },
            )[PersonalInstructionsModel::class.java]
        }
        try {
            action(service, store, ::model, failures)
        } finally {
            viewModels.forEach { it.clear() }
            runCurrent()
            store.close()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun dirtyRefreshAndConflictPreserveTextAndConditionalClearUsesLatestVersion() =
        check { service, store, create, _ ->
            var model = create(false)
            model.open()
            runCurrent()
            model.edit("本地 **draft** 👋\nsecond line")
            model = create(true)
            model.open()
            runCurrent()
            assertEquals("本地 **draft** 👋\nsecond line", model.uiState.value.content)
            service.saved = service.saved.copy(content = "Changed on Web", version = "external")
            model.refresh()
            runCurrent()
            assertEquals(InstructionsPhase.Conflict, model.uiState.value.phase)
            assertEquals("本地 **draft** 👋\nsecond line", model.uiState.value.content)
            assertEquals("v1", model.uiState.value.draft?.base?.version)
            model.save()
            runCurrent()
            assertTrue(service.writes.isEmpty())
            model.discard()
            runCurrent()
            assertEquals("Changed on Web", model.uiState.value.content)
            model.edit("")
            service.write = { content, version ->
                val durable = checkNotNull(store.load(identity).draft)
                assertTrue(durable.attempted)
                assertEquals(content, durable.content)
                assertEquals(version, durable.base.version)
                service.saved.copy(content = content, version = "cleared").also {
                    service.saved = it
                }
            }
            model.save()
            model.save()
            runCurrent()
            assertEquals(listOf("" to "external"), service.writes)
            assertEquals("", service.saved.content)
            assertNull(model.uiState.value.draft)
            assertNull(store.load(identity).draft)
        }

    @Test
    fun anAcceptedButDisconnectedSaveReconcilesWithoutReplayingTheWrite() =
        check { service, store, create, _ ->
            val model = create(false)
            model.open()
            runCurrent()
            model.edit("New Instructions")
            service.write = { content, _ ->
                service.saved = service.saved.copy(content = content, version = "committed")
                throw ApiFailure.Network(IOException("response lost"))
            }
            model.save()
            runCurrent()
            assertEquals(InstructionsPhase.Ready, model.uiState.value.phase)
            assertEquals("New Instructions", model.uiState.value.content)
            assertNull(model.uiState.value.draft)
            assertNull(store.load(identity).draft)
            assertEquals(1, service.writes.size)
        }

    @Test
    fun unresolvedIntentSurvivesRetirementAndNeedsAReadBeforeExplicitConditionalRetry() =
        check { service, store, create, _ ->
            var model = create(false)
            model.open()
            runCurrent()
            model.edit("Frozen intent")
            service.write = { _, _ -> throw ApiFailure.Network(IOException("unknown outcome")) }
            service.read = { throw ApiFailure.Network(IOException("read unavailable")) }
            model.save()
            runCurrent()
            assertEquals(InstructionsPhase.Uncertain, model.uiState.value.phase)
            assertFalse(model.uiState.value.canRetrySave)
            model.edit("Replacement must not erase recovery")
            model.discard()
            model.save()
            runCurrent()
            assertEquals("Frozen intent", model.uiState.value.content)
            assertEquals(1, service.writes.size)
            model = create(true)
            model.open()
            runCurrent()
            assertTrue(checkNotNull(store.load(identity).draft).attempted)
            service.read = { service.saved }
            model.refresh()
            runCurrent()
            assertTrue(model.uiState.value.canRetrySave)
            val held = CompletableDeferred<Unit>()
            service.write = { content, version ->
                held.await()
                assertEquals("v1", version)
                service.saved.copy(content = content, version = "retry-committed").also {
                    service.saved = it
                }
            }
            model.save()
            model.save()
            runCurrent()
            assertEquals(2, service.writes.size)
            held.complete(Unit)
            runCurrent()
            assertNull(model.uiState.value.draft)
            assertEquals("Frozen intent", service.saved.content)
        }

    @Test
    fun featureLocal403DoesNotRetireWorkspaceAndNulNeverBecomesASave() =
        check { service, _, create, failures ->
            val model = create(false)
            service.read = { throw ApiFailure.Http(403, "FORBIDDEN", "Unavailable", null) }
            model.open()
            runCurrent()
            assertEquals(InstructionsPhase.Unavailable, model.uiState.value.phase)
            assertTrue(failures.isEmpty())
            service.read = { service.saved }
            model.refresh()
            runCurrent()
            model.edit("bad\u0000text")
            model.save()
            runCurrent()
            assertFalse(model.uiState.value.canSave)
            assertTrue(service.writes.isEmpty())
            service.read = { throw ApiFailure.Http(401, null, null, null) }
            model.refresh()
            runCurrent()
            assertEquals(1, failures.size)
        }

    @Test
    fun localIntentRestoresWhenTheOptionalAvailabilityRequestFails() =
        check { service, store, create, failures ->
            var model = create(false)
            model.open()
            runCurrent()
            model.edit("Keep my offline draft 👋")
            runCurrent()
            model = create(true)
            service.availability = { throw ApiFailure.Network(IOException("offline")) }
            model.open()
            runCurrent()
            assertEquals(InstructionsPhase.Failed, model.uiState.value.phase)
            assertEquals("Keep my offline draft 👋", model.uiState.value.content)
            assertEquals("v1", model.uiState.value.draft?.base?.version)
            model.edit(service.saved.content)
            runCurrent()
            assertEquals(service.saved.content, model.uiState.value.content)
            assertTrue(model.uiState.value.canEdit)
            model.edit("Continue editing offline")
            runCurrent()
            assertEquals("Continue editing offline", store.load(identity).draft?.content)
            assertTrue(service.writes.isEmpty())
            assertTrue(failures.isEmpty())
            service.availability = { true }
            model.refresh()
            runCurrent()
            model.save()
            runCurrent()
            assertEquals(listOf("Continue editing offline" to "v1"), service.writes)
            assertNull(store.load(identity).draft)
        }

    @Test
    fun persistenceFailureKeepsTheOnlyIntentAndPreventsRemoteMutation() =
        check(true) { service, store, create, _ ->
            val model = create(false)
            model.open()
            runCurrent()
            model.edit("Never lose this")
            runCurrent()
            assertTrue(model.uiState.value.localFailure)
            model.save()
            runCurrent()
            assertTrue(service.writes.isEmpty())
            assertEquals("Never lose this", model.uiState.value.content)
            assertEquals("Never lose this", store.load(identity).draft?.content)
            assertFalse(store.load(identity).durable)
        }

    @Test
    fun retiredSaveCannotClearAReplacementEditorsRecoveryDocument() =
        check { service, store, create, _ ->
            val old = create(false)
            old.open()
            runCurrent()
            old.edit("Accepted later")
            val held = CompletableDeferred<Unit>()
            service.write = { content, _ ->
                withContext(NonCancellable) {
                    held.await()
                    service.saved.copy(content = content, version = "late-server").also {
                        service.saved = it
                    }
                }
            }
            try {
                old.save()
                runCurrent()
                val fresh = create(true)
                fresh.open()
                runCurrent()
                assertEquals(InstructionsPhase.Uncertain, fresh.uiState.value.phase)
                held.complete(Unit)
                runCurrent()
                assertTrue(checkNotNull(store.load(identity).draft).attempted)
                fresh.refresh()
                runCurrent()
                assertEquals("Accepted later", fresh.uiState.value.content)
                assertNull(fresh.uiState.value.draft)
                assertNull(store.load(identity).draft)
                assertEquals(1, service.writes.size)
            } finally {
                held.complete(Unit)
                runCurrent()
            }
        }
}
