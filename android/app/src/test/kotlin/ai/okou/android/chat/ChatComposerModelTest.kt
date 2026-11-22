package ai.okou.android.chat

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.AcceptedInput
import ai.okou.android.api.generated.CreateThreadRequest
import ai.okou.android.api.generated.CreatedThread
import ai.okou.android.api.generated.SendRequestVariant1
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
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
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
class ChatComposerModelTest {
    @get:Rule val temporary = TemporaryFolder()
    private val identity = WorkspaceIdentity("https://api.example/", "user-a", "session-a", "org-a")
    private val existing = ComposerTarget(threadId = CHAT_PERSONAL)

    private class Service : ChatComposerService {
        val requests = mutableListOf<SendRequestVariant1>()
        val creates = mutableListOf<CreateThreadRequest>()
        val accepted = mutableMapOf<String, SendRequestVariant1>()
        val gates = mutableListOf<CompletableDeferred<Unit>>()
        var readinessFailure: Exception? = null
        val drafts = mutableMapOf<ServerDraftTarget, ai.okou.android.api.generated.ComposerDraft>()
        val saves = mutableListOf<Pair<ServerDraftTarget, String>>()
        var draftRead: suspend (ServerDraftTarget) -> ai.okou.android.api.generated.ComposerDraft =
            {
                drafts[it] ?: plainDraftDocument("")
            }
        var draftWrite: suspend (ServerDraftTarget, String) -> Unit = { target, text ->
            drafts[target] = plainDraftDocument(text)
        }
        var create: suspend (CreateThreadRequest) -> CreatedThread = { request ->
            CreatedThread(
                checkNotNull(request.clientThreadId),
                request.projectId,
                null,
                CHAT_DATE,
                null,
                null,
            )
        }
        var write: suspend (SendRequestVariant1) -> AcceptedInput = { request ->
            accepted[checkNotNull(request.clientEventId)] = request
            AcceptedInput(checkNotNull(request.threadId))
        }
        var read: suspend (String, String) -> InputObservation = { thread, event ->
            InputObservation(thread, event, if (event in accepted) TextDisposition.Queued else null)
        }

        override suspend fun newChatReady(): Boolean {
            readinessFailure?.let { throw it }
            return true
        }

        override suspend fun composerDraft(target: ServerDraftTarget) = draftRead(target)

        override suspend fun saveComposerDraft(target: ServerDraftTarget, text: String) {
            saves += target to text
            draftWrite(target, text)
        }

        override suspend fun createThread(request: CreateThreadRequest): CreatedThread {
            creates += request
            return create(request)
        }

        override suspend fun sendInput(request: SendRequestVariant1): AcceptedInput {
            requests += request
            return write(request)
        }

        override suspend fun observeInput(threadId: String, eventId: String) =
            read(threadId, eventId)

        fun gate() = CompletableDeferred<Unit>().also { gates += it }
    }

    private fun check(
        blockedDisk: Boolean = false,
        action:
            suspend TestScope.(
                Service, ComposerJournalStore, (Boolean, WorkspaceIdentity) -> ChatComposerModel,
            ) -> Unit,
    ) = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val service = Service()
        val store =
            ComposerJournalStore(
                ApplicationProvider.getApplicationContext(),
                if (blockedDisk) temporary.newFile() else temporary.newFolder(),
                dispatcher,
            )
        val owners = mutableListOf<ViewModelStore>()
        fun model(replace: Boolean, scope: WorkspaceIdentity): ChatComposerModel {
            if (replace) owners.lastOrNull()?.clear()
            val owner = ViewModelStore().also { owners += it }
            return ViewModelProvider(
                owner,
                viewModelFactory {
                    initializer { ChatComposerModel(service, store, scope, { true }, {}, {}) }
                },
            )[ChatComposerModel::class.java]
        }
        try {
            action(service, store, ::model)
        } finally {
            owners.forEach { it.clear() }
            service.gates.forEach { it.complete(Unit) }
            runCurrent()
            store.close()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun heldHydrationKeepsEditsAndDebouncesTheCanonicalFullValue() =
        check { service, store, create ->
            val gate = service.gate()
            val remote = ServerDraftTarget(CHAT_PERSONAL)
            service.draftRead = {
                gate.await()
                plainDraftDocument("Web draft")
            }
            val model = create(false, identity)
            model.open(existing)
            runCurrent()
            assertEquals(ComposerSync.Loading, model.uiState.value.sync(existing))
            model.edit(existing, "本地新输入 👋\n**verbatim**")
            runCurrent()
            assertEquals(
                "本地新输入 👋\n**verbatim**",
                store.load(identity).journal.drafts[remote.key]!!.text,
            )
            gate.complete(Unit)
            runCurrent()
            assertEquals("本地新输入 👋\n**verbatim**", model.uiState.value.entry(existing).text)
            advanceTimeBy(250)
            model.edit(existing, "Latest input restarts the debounce")
            runCurrent()
            advanceTimeBy(499)
            assertTrue(service.saves.isEmpty())
            advanceTimeBy(1)
            runCurrent()
            assertEquals("Latest input restarts the debounce", service.drafts[remote]!!.plainText())
            assertFalse(store.load(identity).journal.drafts[remote.key]!!.dirty)
        }

    @Test
    fun webWhitespaceStaysLocalAndDoesNotAuthorizeSend() = check { service, store, create ->
        val model = create(false, identity)
        model.open(existing)
        runCurrent()
        val whitespace = " \t\n\u00a0\ufeff"
        model.edit(existing, whitespace)
        assertFalse(model.uiState.value.canSend(existing))
        model.send(existing)
        advanceUntilIdle()
        assertTrue(service.requests.isEmpty())
        assertEquals(whitespace, store.load(identity).journal.drafts[existing.key]!!.text)
        assertEquals("", service.drafts[ServerDraftTarget(CHAT_PERSONAL)]!!.plainText())
    }

    @Test
    fun newerEditsAndClearWaitForOlderPatchWithoutLosingTheirIntent() =
        check { service, _, create ->
            val remote = ServerDraftTarget(CHAT_PERSONAL)
            val gate = service.gate()
            service.draftWrite = { target, text ->
                if (text == "older") gate.await()
                service.drafts[target] = plainDraftDocument(text)
            }
            val model = create(false, identity)
            model.open(existing)
            runCurrent()
            model.edit(existing, "older")
            advanceTimeBy(500)
            runCurrent()
            model.edit(existing, "newer")
            model.edit(existing, "")
            gate.complete(Unit)
            runCurrent()
            assertEquals("", model.uiState.value.entry(existing).text)
            assertEquals("", service.drafts[remote]!!.plainText())
            assertEquals(listOf("older", ""), service.saves.map { it.second })
        }

    @Test
    fun workflowPrefillWaitsForTheQueuedReadAndRequiresAReadyWorkspace() =
        check { service, _, create ->
            val target = ComposerTarget()
            val initial = CompletableDeferred<Unit>()
            val refresh = CompletableDeferred<Unit>()
            var reads = 0
            service.draftRead = {
                when (++reads) {
                    1 -> {
                        initial.await()
                        plainDraftDocument("Initial draft")
                    }
                    else -> {
                        refresh.await()
                        plainDraftDocument("Current draft")
                    }
                }
            }
            val model = create(false, identity)
            model.open(target)
            runCurrent()
            val prefill = async { model.prefillNew("/release-review ") }
            runCurrent()
            initial.complete(Unit)
            runCurrent()
            assertFalse(prefill.isCompleted)

            refresh.complete(Unit)
            runCurrent()
            assertTrue(prefill.await())
            assertEquals("/release-review Current draft", model.uiState.value.entry(target).text)
            advanceTimeBy(500)
            runCurrent()

            service.readinessFailure =
                ApiFailure.Network(IOException("Could not check workspace readiness"))
            val failed = async { model.prefillNew("/another-workflow ") }
            runCurrent()
            assertFalse(failed.await())
            assertEquals("/release-review Current draft", model.uiState.value.entry(target).text)
        }

    @Test
    fun failedAndRichReadsNeverPublishEmptyOrPartialDrafts() = check { service, store, create ->
        val model = create(false, identity)
        service.draftRead = { throw IOException("offline") }
        model.open(existing)
        runCurrent()
        model.edit(existing, "Durable local candidate")
        runCurrent()
        assertEquals(ComposerSync.Failed, model.uiState.value.sync(existing))
        assertTrue(service.saves.isEmpty())
        assertTrue(store.load(identity).journal.drafts[existing.key]!!.dirty)
        service.draftRead = {
            kotlinx.serialization.json.Json.parseToJsonElement(
                    """{"draftUserMessage":{"version":1,"parts":[{"type":"text","text":"Web rich","marks":["bold"]}]},"draftAttachments":null}"""
                )
                .let { it as kotlinx.serialization.json.JsonObject }
        }
        model.retrySync(existing)
        runCurrent()
        assertEquals(ComposerSync.Unsupported, model.uiState.value.sync(existing))
        assertTrue(service.saves.isEmpty())
        assertEquals("Durable local candidate", model.uiState.value.entry(existing).text)
        service.draftRead = { plainDraftDocument("") }
        model.retrySync(existing)
        advanceUntilIdle()
        assertEquals(ComposerSync.Saved, model.uiState.value.sync(existing))
        assertEquals("Durable local candidate", service.saves.single().second)
    }

    @Test
    fun myOkouAndProjectsShareOneWorkspaceDraftButKeepCreateContext() =
        check { service, _, create ->
            val personal = ComposerTarget()
            val project = ComposerTarget(projectId = CHAT_PROJECT)
            val model = create(false, identity)
            service.drafts[ServerDraftTarget()] = plainDraftDocument("From Web")
            model.open(personal)
            runCurrent()
            assertEquals("From Web", model.uiState.value.entry(project).text)
            model.edit(project, "Same shared draft")
            assertEquals("Same shared draft", model.uiState.value.entry(personal).text)
            model.send(project)
            advanceUntilIdle()
            assertEquals(CHAT_PROJECT, service.creates.single().projectId)
            assertEquals("Same shared draft", service.requests.single().prompt)
            assertEquals("", service.drafts[ServerDraftTarget()]!!.plainText())
        }

    @Test
    fun legacyProjectCandidatesSurviveMigrationUntilExplicitRestore() = check { _, store, create ->
        val a = ComposerTarget(projectId = "a")
        val b = ComposerTarget(projectId = "b")
        store
            .persist(
                identity,
                ComposerJournal(
                    entries =
                        mapOf(
                            a.key to ComposerEntry(text = "A"),
                            b.key to ComposerEntry(text = "B"),
                        )
                ),
            )
            .await()
        val model = create(false, identity)
        model.open(a)
        runCurrent()
        assertEquals(setOf("A", "B"), model.uiState.value.journal!!.retainedDrafts.values.toSet())
        assertEquals("", model.uiState.value.entry(a).text)
        model.restoreDraft(a, a.key)
        runCurrent()
        assertEquals("A", model.uiState.value.entry(b).text)
        assertEquals(listOf("B"), store.load(identity).journal.retainedDrafts.values.toList())
        model.restoreDraft(b, b.key)
        assertEquals("A", model.uiState.value.entry(b).text)
    }

    @Test
    fun retiringHydrationCannotPublishOrSaveIntoAnotherWorkspace() =
        check { service, store, create ->
            val gate = service.gate()
            var reads = 0
            service.draftRead = {
                if (++reads == 1)
                    withContext(NonCancellable) {
                        gate.await()
                        plainDraftDocument("Obsolete workspace")
                    }
                else plainDraftDocument("")
            }
            val old = create(false, identity)
            old.open(existing)
            runCurrent()
            old.edit(existing, "First workspace private draft")
            runCurrent()
            val otherIdentity = identity.copy(workspaceId = "another-workspace")
            val current = create(true, otherIdentity)
            current.open(existing)
            runCurrent()
            current.edit(existing, "Second workspace draft")
            gate.complete(Unit)
            advanceUntilIdle()
            assertEquals("Second workspace draft", current.uiState.value.entry(existing).text)
            assertEquals(
                "First workspace private draft",
                store.load(identity).journal.drafts[existing.key]!!.text,
            )
            assertEquals(listOf("Second workspace draft"), service.saves.map { it.second })
        }

    @Test
    fun failedPatchRetainsDirtyIntentAndExplicitRetrySavesLatestText() =
        check { service, store, create ->
            val model = create(false, identity)
            model.open(existing)
            runCurrent()
            service.draftWrite = { _, _ -> throw IOException("lost save response") }
            model.edit(existing, "Retry this exact editable input")
            advanceUntilIdle()
            assertEquals(ComposerSync.Failed, model.uiState.value.sync(existing))
            assertTrue(store.load(identity).journal.drafts[existing.key]!!.dirty)
            service.draftWrite = { target, text ->
                service.drafts[target] = plainDraftDocument(text)
            }
            model.retrySync(existing)
            advanceUntilIdle()
            assertEquals(
                "Retry this exact editable input",
                service.drafts[ServerDraftTarget(CHAT_PERSONAL)]!!.plainText(),
            )
            assertFalse(store.load(identity).journal.drafts[existing.key]!!.dirty)
            assertTrue(service.requests.isEmpty())
        }

    @Test
    fun remainingControllerKeepsWorkspaceDraftAndSavesAfterTheReaderRetires() =
        check { service, _, create ->
            val remaining = create(false, identity)
            val retiring = create(false, identity)
            val target = ComposerTarget()
            retiring.open(target)
            remaining.open(target)
            runCurrent()
            assertEquals(ComposerContext.Ready, remaining.uiState.value.context)
            retiring.edit(target, "Shared input survives its fetching window")
            runCurrent()
            create(true, identity)
            advanceUntilIdle()
            assertEquals(ComposerContext.Ready, remaining.uiState.value.context)
            assertTrue(remaining.uiState.value.canSend(target))
            assertEquals(ComposerSync.Saved, remaining.uiState.value.sync(target))
            assertEquals(
                "Shared input survives its fetching window",
                service.drafts[ServerDraftTarget()]!!.plainText(),
            )
        }

    @Test
    fun olderProjectSendCannotConsumeAnotherNewChatEditorsInput() = check { service, _, create ->
        val model = create(false, identity)
        val project = ComposerTarget(projectId = CHAT_PROJECT)
        val personal = ComposerTarget()
        val gate = service.gate()
        service.write = { request ->
            gate.await()
            AcceptedInput(checkNotNull(request.threadId))
        }
        model.open(project)
        runCurrent()
        model.edit(project, "Frozen Project send")
        model.send(project)
        runCurrent()
        model.edit(personal, "A different new conversation draft")
        gate.complete(Unit)
        advanceUntilIdle()
        assertEquals("A different new conversation draft", model.uiState.value.entry(personal).text)
        assertEquals(
            "",
            model.uiState.value.entry(ComposerTarget(service.creates.single().clientThreadId)).text,
        )
        assertEquals(
            "A different new conversation draft",
            service.drafts[ServerDraftTarget()]!!.plainText(),
        )
    }

    @Test
    fun newProjectSubmissionIsDurableBeforeDispatchAndMovesNewerEditsAtomically() =
        check { service, store, create ->
            val target = ComposerTarget(projectId = CHAT_PROJECT)
            val first = create(false, identity)
            val second = create(false, identity)
            first.open(target)
            runCurrent()
            first.edit(target, "原始 **text** 👋\nsecond line")
            val gate = service.gate()
            service.create = { request ->
                val disk = store.load(identity)
                assertTrue(disk.durable)
                assertEquals(request, disk.journal.entries[target.key]!!.pending!!.create)
                CreatedThread(
                    checkNotNull(request.clientThreadId),
                    request.projectId,
                    null,
                    CHAT_DATE,
                    null,
                    null,
                )
            }
            service.write = { request ->
                val disk = store.load(identity)
                assertTrue(disk.durable)
                assertEquals(request, disk.journal.entries[target.key]!!.pending!!.send)
                gate.await()
                AcceptedInput(checkNotNull(request.threadId))
            }
            first.send(target)
            second.send(target)
            first.edit(target, "Newer input stays editable")
            runCurrent()
            assertEquals(1, service.creates.size)
            assertEquals(1, service.requests.size)
            assertEquals("原始 **text** 👋\nsecond line", service.requests.single().prompt)
            gate.complete(Unit)
            runCurrent()
            val real = ComposerTarget(service.requests.single().threadId, CHAT_PROJECT)
            assertEquals("Newer input stays editable", second.uiState.value.entry(real).text)
            assertNull(second.uiState.value.entry(real).pending)
            assertEquals(
                TextDisposition.Accepted,
                second.uiState.value.entry(real).receipt!!.disposition,
            )
            assertEquals(second.uiState.value.journal, store.load(identity).journal)
        }

    @Test
    fun unavailableReadNeverReplaysAndExplicitRecoveryKeepsTheExactFrozenRequest() =
        check { service, _, create ->
            var model = create(false, identity)
            model.open(existing)
            runCurrent()
            model.edit(existing, "immutable submission")
            service.write = { request ->
                service.accepted[checkNotNull(request.clientEventId)] = request
                throw ApiFailure.Network(IOException("response disconnected after acceptance"))
            }
            model.send(existing)
            runCurrent()
            val frozen = service.requests.single()
            model.edit(existing, "next draft")
            model = create(true, identity.copy(sessionId = "renewed"))
            model.open(existing)
            runCurrent()
            service.read = { thread, event -> InputObservation(thread, event, null) }
            model.observe(existing)
            runCurrent()
            assertEquals(1, service.requests.size)
            assertEquals(frozen, model.uiState.value.entry(existing).pending!!.send)
            val restored = model.uiState.value.messagesFor(checkNotNull(existing.threadId)).single()
            assertEquals(frozen.clientEventId, restored.eventId)
            assertEquals("immutable submission", restored.text)
            assertNull(restored.disposition)
            assertFalse(restored.sending)
            assertTrue(existing.key in model.uiState.value.unobserved)
            service.write = { request ->
                assertEquals(frozen, request)
                assertEquals(frozen, service.accepted[request.clientEventId])
                AcceptedInput(checkNotNull(request.threadId))
            }
            model.retry(existing)
            runCurrent()
            assertEquals(2, service.requests.size)
            assertEquals(1, service.accepted.size)
            assertEquals("next draft", model.uiState.value.entry(existing).text)
        }

    @Test
    fun authoritativeRejectionSettlesOnlyOriginalInputAndPreservesTheNextDraft() =
        check { service, _, create ->
            val model = create(false, identity)
            model.open(existing)
            runCurrent()
            model.edit(existing, "submitted")
            service.write = { throw ApiFailure.Network(IOException("lost")) }
            model.send(existing)
            runCurrent()
            model.edit(existing, "later edit")
            service.read = { thread, event ->
                InputObservation(thread, event, TextDisposition.Rejected)
            }
            model.observe(existing)
            runCurrent()
            assertNull(model.uiState.value.entry(existing).pending)
            assertEquals(
                TextDisposition.Rejected,
                model.uiState.value.entry(existing).receipt!!.disposition,
            )
            assertEquals("later edit", model.uiState.value.entry(existing).text)
            val rejected = model.uiState.value.messagesFor(checkNotNull(existing.threadId)).single()
            assertEquals("submitted", rejected.text)
            assertEquals(TextDisposition.Rejected, rejected.disposition)
            assertEquals(1, service.requests.size)
        }

    @Test
    fun retirementBeforeDispatchDoesNotWriteRemotelyOrLoseTheFrozenInput() =
        check { service, _, create ->
            var model = create(false, identity)
            model.open(existing)
            runCurrent()
            model.edit(existing, "kept before dispatch")
            model.send(existing)
            model = create(true, identity)
            model.open(existing)
            runCurrent()
            assertTrue(service.requests.isEmpty())
            assertEquals(
                "kept before dispatch",
                model.uiState.value.entry(existing).pending!!.send.prompt,
            )
            model.retry(existing)
            runCurrent()
            assertEquals(1, service.requests.size)
        }

    @Test
    fun uncancellableOldResponseCannotSettleAReplacementEditorsNewInput() =
        check { service, _, create ->
            var model = create(false, identity)
            model.open(existing)
            runCurrent()
            val gate = service.gate()
            service.write = { request ->
                withContext(NonCancellable) {
                    gate.await()
                    AcceptedInput(checkNotNull(request.threadId))
                }
            }
            model.edit(existing, "old message")
            model.send(existing)
            runCurrent()
            model = create(true, identity)
            model.open(existing)
            runCurrent()
            model.edit(existing, "replacement draft")
            gate.complete(Unit)
            runCurrent()
            assertEquals("replacement draft", model.uiState.value.entry(existing).text)
            assertNotNull(model.uiState.value.entry(existing).pending)
            assertNull(model.uiState.value.entry(existing).receipt)
        }

    @Test
    fun failedDiskNeverAuthorizesDispatchAndReplacementRetainsBothInputs() =
        check(blockedDisk = true) { service, _, create ->
            var model = create(false, identity)
            model.open(existing)
            runCurrent()
            model.edit(existing, "frozen on failed storage")
            model.send(existing)
            model.edit(existing, "newer unsaved draft")
            runCurrent()
            assertTrue(service.requests.isEmpty())
            assertEquals(ComposerPersistence.Failed, model.uiState.value.persistence)
            model = create(true, identity)
            model.open(existing)
            runCurrent()
            assertEquals("newer unsaved draft", model.uiState.value.entry(existing).text)
            assertEquals(
                "frozen on failed storage",
                model.uiState.value.entry(existing).pending!!.send.prompt,
            )
            assertFalse(model.uiState.value.canSend(existing))
        }

    @Test
    fun anOlderReceiptsHeldReadCannotBlockOrOverwriteTheNextSend() = check { service, _, create ->
        val model = create(false, identity)
        model.open(existing)
        runCurrent()
        model.edit(existing, "first input")
        model.send(existing)
        runCurrent()
        val gate = service.gate()
        service.read = { thread, event ->
            withContext(NonCancellable) {
                gate.await()
                InputObservation(thread, event, TextDisposition.Rejected)
            }
        }
        model.observe(existing)
        runCurrent()
        model.edit(existing, "second input")
        assertTrue(model.uiState.value.canSend(existing))
        model.send(existing)
        runCurrent()
        assertEquals(2, service.requests.size)
        val second = service.requests.last().clientEventId
        assertEquals(second, model.uiState.value.entry(existing).receipt!!.eventId)
        assertEquals(
            service.requests.map { it.clientEventId },
            model.uiState.value.messagesFor(checkNotNull(existing.threadId)).map { it.eventId },
        )
        gate.complete(Unit)
        runCurrent()
        assertEquals(second, model.uiState.value.entry(existing).receipt!!.eventId)
        assertEquals(
            TextDisposition.Accepted,
            model.uiState.value.entry(existing).receipt!!.disposition,
        )
    }

    @Test
    fun concurrentNewTargetsKeepTheirOwnDurableHandoffAndLateTextFollowsItsThread() =
        check { service, store, create ->
            val model = create(false, identity)
            val a = ComposerTarget(projectId = CHAT_PROJECT)
            val b = ComposerTarget()
            val first = service.gate()
            val second = service.gate()
            service.write = { request ->
                if (service.creates.first().clientThreadId == request.threadId) first.await()
                else second.await()
                AcceptedInput(checkNotNull(request.threadId))
            }
            model.open(a)
            runCurrent()
            model.edit(a, "Project input")
            model.send(a)
            runCurrent()
            model.open(b)
            runCurrent()
            model.edit(b, "Personal input")
            model.send(b)
            runCurrent()
            val aId = service.creates[0].clientThreadId
            val bId = service.creates[1].clientThreadId
            second.complete(Unit)
            runCurrent()
            assertEquals(bId, model.uiState.value.entry(b).createdThreadId)
            first.complete(Unit)
            runCurrent()
            assertEquals(aId, model.uiState.value.entry(a).createdThreadId)
            assertEquals(bId, model.uiState.value.entry(b).createdThreadId)
            assertEquals(bId, store.load(identity).journal.entries[b.key]!!.createdThreadId)
            model.edit(b, "Typed while navigation catches up")
            runCurrent()
            assertEquals(
                "Typed while navigation catches up",
                model.uiState.value.entry(ComposerTarget(bId)).text,
            )
            model.acknowledge(checkNotNull(bId))
            runCurrent()
            assertNull(model.uiState.value.entry(b).createdThreadId)
            assertEquals(aId, model.uiState.value.entry(a).createdThreadId)
        }

    @Test
    fun realDiskReopenKeepsTargetsAndAccountsSeparateAndCorruptionDoesNotResetInput() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val root = temporary.newFolder()
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        var store = ComposerJournalStore(context, root, dispatcher)
        val journal =
            ComposerJournal(
                entries =
                    mapOf(
                        existing.key to ComposerEntry("saved existing"),
                        "new:$CHAT_PROJECT" to ComposerEntry("项目 draft"),
                    )
            )
        store.persist(identity, journal)
        runCurrent()
        store.close()
        store = ComposerJournalStore(context, root, dispatcher)
        assertEquals(journal, store.load(identity.copy(sessionId = "another")).journal)
        for (other in
            listOf(
                identity.copy(userId = "user-b"),
                identity.copy(workspaceId = "org-b"),
                identity.copy(apiOrigin = "https://other.example/"),
            )) assertTrue(store.load(other).journal.entries.isEmpty())
        store.close()
        val file = checkNotNull(root.listFiles()).single { it.extension == "json" }
        file.writeText("broken input evidence")
        store = ComposerJournalStore(context, root, dispatcher)
        try {
            store.load(identity)
            fail("Corrupt intent cannot be reset")
        } catch (_: Exception) {}
        assertEquals("broken input evidence", file.readText())
        store.close()
    }
}
