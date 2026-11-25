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
import kotlinx.coroutines.test.advanceTimeBy
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
        var read: suspend () -> PersonalInstructions = { saved }
        var write: suspend (String, String) -> PersonalInstructions = { content, version ->
            if (version != saved.version) throw ApiFailure.Http(409, null, null, null)
            saved.copy(content = content, version = saved.version + "-next").also { saved = it }
        }

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
                nowMillis = { testScheduler.currentTime },
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
    fun freshReopenAllowsAnEditDuringRefreshAndExpiryAppliesOnNextOpen() =
        check { service, store, create, _ ->
            val model = create(false)
            model.open()
            runCurrent()
            advanceTimeBy(599_999)
            val response = CompletableDeferred<PersonalInstructions>()
            service.read = { response.await() }
            model.open()
            runCurrent()
            assertEquals("Original", model.uiState.value.content)
            assertTrue(model.uiState.value.canEdit)
            model.edit("Edit while refreshing")
            assertTrue(model.uiState.value.canSave)
            advanceTimeBy(1)
            assertEquals("Edit while refreshing", model.uiState.value.content)
            assertNull(store.load(identity).draft)
            response.complete(service.saved.copy(content = "Updated elsewhere", version = "v2"))
            runCurrent()
            assertEquals(InstructionsPhase.Ready, model.uiState.value.phase)
            assertEquals("Edit while refreshing", model.uiState.value.content)
            assertEquals("v2", model.uiState.value.saved?.version)
            assertTrue(model.uiState.value.canSave)
            assertTrue(model.discardEdits(checkNotNull(model.uiState.value.draft)))
            assertEquals("Updated elsewhere", model.uiState.value.content)

            advanceTimeBy(600_000)
            val next = CompletableDeferred<PersonalInstructions>()
            service.read = { next.await() }
            model.open()
            runCurrent()
            assertEquals(InstructionsPhase.Loading, model.uiState.value.phase)
            assertNull(model.uiState.value.saved)
            assertFalse(model.uiState.value.canEdit)
            next.complete(service.saved.copy(content = "Latest", version = "v3"))
            runCurrent()
            assertEquals("Latest", model.uiState.value.content)
        }

    @Test
    fun backgroundFailureKeepsFreshContentButAccessLossEvictsIt() = check { service, _, create, _ ->
        val model = create(false)
        model.open()
        runCurrent()
        service.read = { throw ApiFailure.Network(IOException("refresh unavailable")) }
        model.open()
        runCurrent()
        assertEquals(InstructionsPhase.Ready, model.uiState.value.phase)
        assertEquals(InstructionsRead.RefreshFailed, model.uiState.value.read)
        assertEquals("Original", model.uiState.value.content)
        model.edit("Edit from the confirmed value")
        assertTrue(model.uiState.value.canSave)
        assertTrue(model.discardEdits(checkNotNull(model.uiState.value.draft)))

        service.read = { throw ApiFailure.Http(403, null, null, null) }
        model.refresh()
        runCurrent()
        assertEquals(InstructionsPhase.Unavailable, model.uiState.value.phase)
        assertFalse(model.uiState.value.canEdit)

        val response = CompletableDeferred<PersonalInstructions>()
        service.read = { response.await() }
        model.open()
        runCurrent()
        assertEquals(InstructionsPhase.Loading, model.uiState.value.phase)
        assertNull(model.uiState.value.saved)
        response.completeExceptionally(ApiFailure.Network(IOException("cold read unavailable")))
        runCurrent()
        assertEquals(InstructionsPhase.Failed, model.uiState.value.phase)
    }

    @Test
    fun editsSurviveRefreshAndConditionalClearUsesTheLatestVersion() =
        check { service, store, create, _ ->
            val model = create(false)
            model.open()
            runCurrent()
            model.edit("本地 **draft** 👋\nsecond line")
            assertEquals("本地 **draft** 👋\nsecond line", model.uiState.value.content)
            service.saved = service.saved.copy(content = "Changed on Web", version = "external")
            model.refresh()
            runCurrent()
            assertEquals(InstructionsPhase.Ready, model.uiState.value.phase)
            assertEquals("本地 **draft** 👋\nsecond line", model.uiState.value.content)
            assertEquals("external", model.uiState.value.saved?.version)
            assertTrue(model.uiState.value.canSave)
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
    fun refreshClearsAnEditThatExactlyMatchesTheNewServerValue() =
        check { service, store, create, _ ->
            val model = create(false)
            model.open()
            runCurrent()
            model.edit("Same new text")
            service.saved = service.saved.copy(content = "Same new text", version = "v2")
            model.refresh()
            runCurrent()
            assertEquals("Same new text", model.uiState.value.content)
            assertEquals("v2", model.uiState.value.saved?.version)
            assertNull(model.uiState.value.draft)
            assertNull(store.load(identity).draft)
            assertFalse(model.uiState.value.canSave)
            model.save()
            runCurrent()
            assertTrue(service.writes.isEmpty())
        }

    @Test
    fun staleSaveRereadsTheLatestVersionAndResubmitsTheSameInputOnce() =
        check { service, store, create, _ ->
            val model = create(false)
            model.open()
            runCurrent()
            val old = service.saved
            service.saved = service.saved.copy(content = "Changed on Web", version = "v2")
            val heldRefresh = CompletableDeferred<PersonalInstructions>()
            var reads = 0
            service.read = { if (reads++ == 0) heldRefresh.await() else service.saved }
            val write = service.write
            service.write = { content, version ->
                val journal = checkNotNull(store.load(identity).draft)
                assertTrue(journal.attempted)
                assertEquals(version, journal.base.version)
                write(content, version)
            }
            model.refresh()
            runCurrent()
            model.edit("My local edit")
            assertTrue(model.uiState.value.canSave)
            model.save()
            runCurrent()
            heldRefresh.complete(old)
            runCurrent()
            assertEquals(listOf("My local edit" to "v1", "My local edit" to "v2"), service.writes)
            assertEquals("My local edit", model.uiState.value.content)
            assertEquals("My local edit", service.saved.content)
            assertNull(store.load(identity).draft)

            model.edit("New edit")
            service.write = { _, _ -> throw ApiFailure.Http(409, null, null, null) }
            model.save()
            runCurrent()
            assertEquals(4, service.writes.size)
            assertTrue(model.uiState.value.saveRejected)
            assertEquals("New edit", model.uiState.value.content)
            assertTrue(model.uiState.value.canSave)
            assertNull(store.load(identity).draft)
        }

    @Test
    fun discardConfirmationSurvivesARefreshButCannotClearNewInputInAnotherWindow() =
        check { service, store, create, _ ->
            val first = create(false)
            val second = create(false)
            first.open()
            runCurrent()
            first.edit("Original draft")
            val originalDraft = checkNotNull(first.uiState.value.draft)
            second.edit("New draft")
            assertFalse(first.discardEdits(originalDraft))
            assertEquals("New draft", first.uiState.value.content)
            val confirmedDraft = checkNotNull(second.uiState.value.draft)
            service.saved = service.saved.copy(content = "Changed on Web", version = "v2")
            second.refresh()
            runCurrent()
            assertEquals("New draft", first.uiState.value.content)
            assertTrue(second.uiState.value.canSave)
            assertTrue(first.discardEdits(confirmedDraft))
            assertEquals("Changed on Web", second.uiState.value.content)
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
            model.discardEdits(checkNotNull(model.uiState.value.draft))
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
    fun failedLocalPersistenceOnAnExplicitRetryKeepsTheEarlierAttemptUncertain() =
        check { service, store, create, _ ->
            var model = create(false)
            model.open()
            runCurrent()
            model.edit("Frozen intent")
            service.write = { _, _ -> throw ApiFailure.Network(IOException("unknown outcome")) }
            model.save()
            runCurrent()
            assertTrue(model.uiState.value.canRetrySave)
            val directory = temporary.root.listFiles()!!.single()
            val retained = temporary.root.resolve("retained-draft")
            assertTrue(directory.renameTo(retained))
            assertTrue(directory.createNewFile())
            model.save()
            runCurrent()
            assertEquals(InstructionsPhase.Uncertain, model.uiState.value.phase)
            assertTrue(model.uiState.value.localFailure)
            assertTrue(checkNotNull(model.uiState.value.draft).attempted)
            model.edit("Must not replace uncertain intent")
            model.discardEdits(checkNotNull(model.uiState.value.draft))
            runCurrent()
            assertEquals("Frozen intent", model.uiState.value.content)
            assertEquals(1, service.writes.size)
            model = create(true)
            model.open()
            runCurrent()
            assertEquals(InstructionsPhase.Uncertain, model.uiState.value.phase)
            assertTrue(checkNotNull(store.load(identity).draft).attempted)
            assertTrue(directory.delete())
            assertTrue(retained.renameTo(directory))
            service.write = { content, version ->
                assertEquals("v1", version)
                service.saved.copy(content = content, version = "v2").also { service.saved = it }
            }
            model.save()
            runCurrent()
            assertEquals(InstructionsPhase.Ready, model.uiState.value.phase)
            assertEquals("Frozen intent", service.saved.content)
            assertEquals(listOf("Frozen intent" to "v1", "Frozen intent" to "v1"), service.writes)
            assertNull(store.load(identity).draft)
        }

    @Test
    fun aRejectedRetryDoesNotResolveTheEarlierUnknownSave() = check { service, store, create, _ ->
        val model = create(false)
        model.open()
        runCurrent()
        model.edit("Original uncertain intent")
        service.write = { _, _ -> throw ApiFailure.Network(IOException("response lost")) }
        model.save()
        runCurrent()
        service.write = { _, _ -> throw ApiFailure.Http(400, null, null, null) }
        model.save()
        runCurrent()
        assertEquals(InstructionsPhase.Uncertain, model.uiState.value.phase)
        assertTrue(checkNotNull(model.uiState.value.draft).attempted)
        model.edit("Must not replace the earlier intent")
        model.discardEdits(checkNotNull(model.uiState.value.draft))
        runCurrent()
        assertEquals("Original uncertain intent", model.uiState.value.content)
        assertEquals(2, service.writes.size)
        assertTrue(checkNotNull(store.load(identity).draft).attempted)
        service.saved = service.saved.copy(content = "Original uncertain intent", version = "v2")
        model.refresh()
        runCurrent()
        assertEquals(InstructionsPhase.Ready, model.uiState.value.phase)
        assertNull(model.uiState.value.draft)
        assertNull(store.load(identity).draft)
        assertEquals(2, service.writes.size)
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
    fun localIntentRestoresWhenTheInstructionsReadFails() =
        check { service, store, create, failures ->
            var model = create(false)
            model.open()
            runCurrent()
            store.persist(identity, InstructionsDraft("Keep my offline draft 👋", service.saved))
            runCurrent()
            advanceTimeBy(600_000)
            model = create(true)
            service.read = { throw ApiFailure.Network(IOException("offline")) }
            model.open()
            runCurrent()
            assertEquals(InstructionsPhase.Failed, model.uiState.value.phase)
            assertEquals("Keep my offline draft 👋", model.uiState.value.content)
            assertEquals("v1", model.uiState.value.draft?.base?.version)
            model.edit(service.saved.content)
            runCurrent()
            assertEquals(service.saved.content, model.uiState.value.content)
            assertTrue(model.uiState.value.canEdit)
            assertNotNull(model.uiState.value.draft)
            service.read = { service.saved }
            model.refresh()
            runCurrent()
            assertEquals(InstructionsPhase.Ready, model.uiState.value.phase)
            assertNull(model.uiState.value.draft)
            assertNull(store.load(identity).draft)
            service.read = { throw ApiFailure.Network(IOException("offline again")) }
            model.refresh()
            runCurrent()
            model.edit("Continue editing offline")
            runCurrent()
            assertNull(store.load(identity).draft)
            assertTrue(service.writes.isEmpty())
            assertTrue(failures.isEmpty())
            service.read = { service.saved }
            model.refresh()
            runCurrent()
            model.save()
            runCurrent()
            assertEquals(listOf("Continue editing offline" to "v1"), service.writes)
            assertNull(store.load(identity).draft)
        }

    @Test
    fun aFailedAtomicCommitCannotAuthorizeARemoteSave() = check { service, store, create, _ ->
        val model = create(false)
        model.open()
        runCurrent()
        model.edit("Must be durable before save")
        runCurrent()
        assertEquals(InstructionsCommit.Committed, store.persist(identity, null).await())
        val directory = temporary.root.listFiles()!!.single()
        val document = directory.listFiles()!!.single()
        val retained = temporary.root.resolve("retained-instructions.json")
        assertTrue(document.renameTo(retained))
        assertTrue(document.mkdir())
        val obstruction = document.resolve("blocked")
        obstruction.writeText("The atomic destination cannot be replaced")

        model.save()
        runCurrent()
        assertTrue(service.writes.isEmpty())
        assertEquals("Original", service.saved.content)
        assertTrue(model.uiState.value.localFailure)
        assertEquals("Must be durable before save", model.uiState.value.content)
        assertNull(store.load(identity).draft)
        assertFalse(store.load(identity).durable)

        assertTrue(obstruction.delete())
        assertTrue(document.delete())
        assertTrue(retained.renameTo(document))
        model.retryLocalDraft()
        runCurrent()
        assertFalse(model.uiState.value.localFailure)
        model.save()
        runCurrent()
        assertEquals(listOf("Must be durable before save" to "v1"), service.writes)
        assertEquals("Must be durable before save", service.saved.content)
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
            model.save()
            runCurrent()
            assertTrue(service.writes.isEmpty())
            assertEquals("Never lose this", model.uiState.value.content)
            assertNull(store.load(identity).draft)
            assertFalse(store.load(identity).durable)
        }

    @Test
    fun neverDispatchedSaveDoesNotRestoreAnUnsubmittedDraftAfterOwnerReplacement() =
        check(true) { service, store, create, _ ->
            var model = create(false)
            model.open()
            runCurrent()
            model.edit("Never dispatched")
            model.save()
            runCurrent()
            assertTrue(service.writes.isEmpty())
            assertTrue(model.uiState.value.canEdit)
            assertNull(store.load(identity).draft)

            model = create(true)
            model.open()
            runCurrent()
            assertEquals("Original", model.uiState.value.content)
            assertTrue(model.uiState.value.canEdit)
            assertTrue(model.uiState.value.localFailure)
            model.edit("Continue editing")
            runCurrent()
            assertNull(store.load(identity).draft)
            assertTrue(service.writes.isEmpty())
        }

    @Test
    fun currentControllersShareTheFrozenSaveAndRetainTheNextAcceptedDraft() =
        check { service, store, create, _ ->
            val first = create(false)
            val second = create(false)
            first.open()
            second.open()
            runCurrent()
            first.edit("First draft")
            second.edit("Latest accepted draft")
            assertEquals("Latest accepted draft", first.uiState.value.content)

            val held = CompletableDeferred<Unit>()
            service.write = { content, version ->
                val durable = checkNotNull(store.load(identity).draft)
                assertTrue(durable.attempted)
                assertEquals(content, durable.content)
                assertEquals(version, durable.base.version)
                held.await()
                service.saved.copy(content = content, version = "v2").also { service.saved = it }
            }
            try {
                first.save()
                second.edit("Not accepted while saving")
                second.save()
                assertFalse(second.uiState.value.canEdit)
                runCurrent()
                assertEquals(listOf("Latest accepted draft" to "v1"), service.writes)
                val live = create(true)
                live.open()
                runCurrent()
                assertEquals(InstructionsPhase.Saving, live.uiState.value.phase)
                held.complete(Unit)
                runCurrent()
                assertEquals("Latest accepted draft", live.uiState.value.content)
                live.edit("Next accepted draft")
                runCurrent()
                assertEquals("Next accepted draft", first.uiState.value.content)
                assertNull(store.load(identity).draft)
                val replacement = create(true)
                replacement.open()
                runCurrent()
                assertEquals("Next accepted draft", replacement.uiState.value.content)
            } finally {
                held.complete(Unit)
            }
        }

    @Test
    fun retiringTheSendingControllerKeepsSharedRecoveryAndFencesItsLateResponse() =
        check { service, store, create, _ ->
            val observer = create(false)
            val sender = create(false)
            observer.open()
            runCurrent()
            sender.edit("Committed before cancellation")
            val response = CompletableDeferred<Unit>()
            service.write = { content, _ ->
                val committed = service.saved.copy(content = content, version = "v2")
                service.saved = committed
                withContext(NonCancellable) {
                    response.await()
                    committed
                }
            }
            try {
                sender.save()
                runCurrent()
                val replacement = create(true)
                assertEquals(InstructionsPhase.Uncertain, observer.uiState.value.phase)
                assertFalse(observer.uiState.value.canEdit)
                assertTrue(checkNotNull(store.load(identity).draft).attempted)
                replacement.refresh()
                runCurrent()
                assertEquals("Committed before cancellation", observer.uiState.value.content)
                assertTrue(observer.uiState.value.canEdit)
                observer.edit("Newer unsaved input")
                runCurrent()
                response.complete(Unit)
                runCurrent()
                assertEquals("Newer unsaved input", replacement.uiState.value.content)
                assertNull(store.load(identity).draft)
                assertEquals(1, service.writes.size)
            } finally {
                response.complete(Unit)
            }
        }

    @Test
    fun retirementBeforeDispatchUnfreezesTheSharedIntentWithoutLosingNewInput() =
        check { service, store, create, _ ->
            val first = create(false)
            first.open()
            runCurrent()
            first.edit("Save cancelled in preparation")
            first.save()
            // Retire before the IO dispatcher can acknowledge preparation or start HTTP.
            val replacement = create(true)
            replacement.open()
            runCurrent()
            assertTrue(replacement.uiState.value.canEdit)
            assertNull(store.load(identity).draft)
            replacement.edit("Replacement input")
            runCurrent()
            assertNull(store.load(identity).draft)
            assertTrue(service.writes.isEmpty())
        }

    @Test
    fun retiringARefreshKeepsAnOfflineUndoProvisionalForTheRemainingController() =
        check { service, store, create, _ ->
            val observer = create(false)
            val reader = create(false)
            observer.open()
            runCurrent()
            observer.edit("Local draft")
            val response = CompletableDeferred<PersonalInstructions>()
            service.read = { response.await() }
            try {
                reader.refresh()
                runCurrent()
                create(true)
                assertEquals(InstructionsPhase.Failed, observer.uiState.value.phase)
                observer.edit("Original")
                runCurrent()
                assertNotNull(observer.uiState.value.draft)
                assertNull(store.load(identity).draft)
                assertFalse(observer.uiState.value.canSave)
                service.saved = service.saved.copy(content = "Changed on Web", version = "v2")
                service.read = { service.saved }
                observer.refresh()
                runCurrent()
                assertEquals(InstructionsPhase.Ready, observer.uiState.value.phase)
                assertEquals("Original", observer.uiState.value.content)
                assertTrue(observer.uiState.value.canSave)
                assertTrue(service.writes.isEmpty())
            } finally {
                response.complete(service.saved)
            }
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
