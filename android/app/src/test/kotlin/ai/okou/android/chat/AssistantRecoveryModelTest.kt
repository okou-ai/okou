package ai.okou.android.chat

import ai.okou.android.*
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ResetSubscriptionResultOutcome
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class AssistantRecoveryModelTest {
    @get:Rule val temporary = TemporaryFolder()
    private val target = ComposerTarget(threadId = CHAT_PERSONAL, agentId = CHAT_AGENT)

    private class Fixture(
        val api: ChatListApiFixture,
        val remote: RecoveryApiFixture,
        val history: ConversationHistoryModel,
        val recovery: AssistantRecoveryModel,
        val composer: ChatComposerModel,
        val journal: ComposerJournalStore,
        val owners: ViewModelStore,
        val auth: AtomicBoolean,
        val retired: CompletableDeferred<Unit>,
    )

    private suspend fun TestScope.withRecovery(
        directory: File = temporary.newFolder(),
        before: suspend (ChatListApiFixture, RecoveryApiFixture, ComposerJournalStore) -> Unit =
            { _, _, _ ->
            },
        block: suspend TestScope.(Fixture) -> Unit,
    ) {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val context = ApplicationProvider.getApplicationContext<TestOkouApplication>()
        val cache = ChatCacheStore(context, temporary.newFolder(), dispatcher)
        val journal = ComposerJournalStore(context, directory, dispatcher)
        val controlsStore = RunControlJournalStore(context, temporary.newFolder(), dispatcher)
        val owners = ViewModelStore()
        val auth = AtomicBoolean(true)
        val retired = CompletableDeferred<Unit>()
        try {
            ChatListApiFixture().use { api ->
                val remote = RecoveryApiFixture(api)
                remote.set(RecoveryApiFixture.input(), RecoveryApiFixture.failure())
                before(api, remote, journal)
                val lease = cache.open(api.identity) { auth.get() }
                val failure: (Exception) -> Unit = {
                    auth.set(false)
                    owners.clear()
                    retired.complete(Unit)
                }
                val history =
                    ConversationHistoryModel(
                        api.service,
                        lease,
                        backgroundScope,
                        { auth.get() },
                        failure,
                        {},
                        dispatcher,
                    )
                try {
                    val provider =
                        ViewModelProvider(
                            owners,
                            viewModelFactory {
                                initializer {
                                    RunControlsModel(
                                        api.service,
                                        controlsStore,
                                        api.identity,
                                        history,
                                        { auth.get() },
                                        failure,
                                        dispatcher,
                                    )
                                }
                            },
                        )
                    val controls = provider[RunControlsModel::class.java]
                    val recovery =
                        AssistantRecoveryModel(
                            api.service,
                            history,
                            controls,
                            { auth.get() },
                            failure,
                            dispatcher,
                        )
                    owners.put("recovery", recovery)
                    val composer =
                        ChatComposerModel(
                            api.service,
                            journal,
                            api.identity,
                            { auth.get() },
                            failure,
                            {},
                            recovery,
                        )
                    owners.put("composer", composer)
                    val thread =
                        Json.decodeFromString<ChatArchive>(
                                """{"chatThreads":[{"id":"$CHAT_PERSONAL","agentId":"$CHAT_AGENT","projectId":null,"title":"Thread","sortAt":"$CHAT_DATE","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","pinnedAt":null,"archived":false,"renamedAt":null,"selectedModel":"gpt-recovery","serviceTier":"priority"}]}"""
                            )
                            .chatThreads
                            .single()
                    history.open(thread)
                    history.uiState.first {
                        it.phase == HistoryPhase.Ready && it.detailPhase == ChatReadPhase.Ready
                    }
                    controls.uiState.first { it.persistence == RunControlPersistence.Durable }
                    recovery.uiState.first {
                        it.phase in setOf(ChatReadPhase.Ready, ChatReadPhase.Failed)
                    }
                    composer.open(target)
                    composer.uiState.first { it.persistence != ComposerPersistence.Loading }
                    block(
                        Fixture(
                            api,
                            remote,
                            history,
                            recovery,
                            composer,
                            journal,
                            owners,
                            auth,
                            retired,
                        )
                    )
                } finally {
                    owners.clear()
                    history.close()
                    lease.close()
                }
            }
        } finally {
            journal.close()
            controlsStore.close()
            cache.close()
            Dispatchers.resetMain()
        }
    }

    private suspend fun Fixture.idle() {
        composer.uiState.first {
            target.key !in it.busy && it.persistence != ComposerPersistence.Pending
        }
    }

    private suspend fun Fixture.refresh() {
        val revision = history.uiState.value.confirmation!!.revision
        history.invalidate(CHAT_PERSONAL)
        history.uiState.first {
            it.phase == HistoryPhase.Ready && (it.confirmation?.revision ?: 0) > revision
        }
    }

    @Test
    fun continueIsANewFrozenInputPreservesDraftAndRejectsDuplicateTaps() = runTest {
        withRecovery { f ->
            f.composer.edit(target, "Preserve 草稿\n🙂")
            f.composer.recover(target, RecoveryApiFixture.FAILURE)
            f.composer.recover(target, RecoveryApiFixture.FAILURE)
            f.idle()
            val wire = f.remote.inputs.single()
            assertEquals("continue", wire.getValue("prompt").jsonPrimitive.content)
            assertEquals("Preserve 草稿\n🙂", f.composer.uiState.value.entry(target).text)
            assertNotEquals(
                RecoveryApiFixture.FAILURE,
                wire.getValue("clientEventId").jsonPrimitive.content,
            )
            UUID.fromString(wire.getValue("clientEventId").jsonPrimitive.content)
            assertFalse("model" in wire)
            assertEquals(
                "fast",
                wire
                    .getValue("runOptions")
                    .jsonObject
                    .getValue("codexServiceTier")
                    .jsonPrimitive
                    .content,
            )
            val model =
                wire
                    .getValue("userMessage")
                    .jsonObject
                    .getValue("parts")
                    .jsonArray
                    .last()
                    .jsonObject
            assertEquals("gpt-recovery", model.getValue("selectedModel").jsonPrimitive.content)
            f.composer.recover(target, RecoveryApiFixture.FAILURE)
            runCurrent()
            assertEquals(1, f.remote.inputs.size)
        }
    }

    @Test
    fun uncertainResetRequiresExplicitSameKeyRetryEvenWhenCreditsDisappear() = runTest {
        withRecovery { f ->
            f.remote.reset = {
                jsonResponse("""{"error":{"code":"UNKNOWN","message":"Lost outcome"}}""")
                    .setResponseCode(503)
            }
            f.composer.recover(target, RecoveryApiFixture.FAILURE, true)
            f.idle()
            val frozen = f.composer.uiState.value.entry(target).recovery!!
            assertNull(frozen.outcome)
            assertTrue(f.remote.inputs.isEmpty())
            assertEquals(
                frozen,
                f.journal.load(f.api.identity).journal.entries[target.key]!!.recovery,
            )
            f.remote.credits = 0
            f.recovery.refresh()
            f.recovery.uiState.first { it.phase == ChatReadPhase.Ready }
            runCurrent()
            assertEquals(1, f.remote.resets.size)
            f.composer.recover(target, RecoveryApiFixture.FAILURE)
            f.idle()
            assertEquals(1, f.remote.resets.size)
            f.remote.reset = { jsonResponse("""{"outcome":"alreadyRedeemed"}""") }
            f.composer.recover(target, RecoveryApiFixture.FAILURE, true)
            f.idle()
            assertEquals(2, f.remote.resets.size)
            assertEquals(f.remote.resets[0], f.remote.resets[1])
            assertEquals(
                frozen.send.clientEventId,
                f.remote.inputs.single().getValue("clientEventId").jsonPrimitive.content,
            )
            assertEquals(
                ResetSubscriptionResultOutcome.ALREADYREDEEMED,
                f.composer.uiState.value.entry(target).recovery!!.outcome,
            )
        }
    }

    @Test
    fun accountChangedDuringResetRetainsReceiptWithoutSendingContinue() = runTest {
        withRecovery { f ->
            val entered = CompletableDeferred<Unit>()
            val release = CountDownLatch(1)
            f.remote.reset = {
                entered.complete(Unit)
                release.await()
                jsonResponse("""{"outcome":"reset"}""")
            }
            try {
                f.composer.recover(target, RecoveryApiFixture.FAILURE, true)
                entered.await()
                f.remote.account = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
                release.countDown()
                f.idle()
                assertTrue(f.remote.inputs.isEmpty())
                assertNull(f.composer.uiState.value.entry(target).pending)
                assertEquals(
                    ResetSubscriptionResultOutcome.RESET,
                    f.composer.uiState.value.entry(target).recovery!!.outcome,
                )
                assertEquals(1, f.remote.resets.size)
            } finally {
                release.countDown()
            }
        }
    }

    @Test
    fun genericRetryCannotSendRecoveryForASupersededFailure() = runTest {
        withRecovery { f ->
            f.remote.send = {
                jsonResponse("""{"error":{"code":"UNKNOWN","message":"Lost response"}}""")
                    .setResponseCode(503)
            }
            f.composer.recover(target, RecoveryApiFixture.FAILURE)
            f.idle()
            val pending = f.composer.uiState.value.entry(target).pending!!
            f.remote.set(
                RecoveryApiFixture.input(),
                RecoveryApiFixture.failure(),
                RecoveryApiFixture.input(3),
            )
            f.refresh()
            f.composer.retry(target)
            f.idle()
            assertEquals(1, f.remote.inputs.size)
            assertEquals(pending, f.composer.uiState.value.entry(target).pending)
        }
    }

    @Test
    fun readFailuresLeaveHistoryAndDraftEditingUsableAndAuthFailureRetires() = runTest {
        withRecovery { f ->
            f.remote.readStatus = 503
            f.recovery.refresh()
            f.recovery.uiState.first { it.phase == ChatReadPhase.Failed }
            f.composer.edit(target, "Editable during read failure")
            assertEquals(HistoryPhase.Ready, f.history.uiState.value.phase)
            assertEquals(
                "Editable during read failure",
                f.composer.uiState.value.entry(target).text,
            )
            f.composer.recover(target, RecoveryApiFixture.FAILURE, true)
            f.idle()
            assertTrue(f.remote.resets.isEmpty())
            f.remote.readStatus = 401
            f.recovery.refresh()
            f.retired.await()
            assertFalse(f.auth.get())
            assertTrue(f.remote.inputs.isEmpty())
        }
    }

    @Test
    fun formatOneDraftSurvivesUpgradeAndUndurableRecoveryNeverPosts() = runTest {
        withRecovery(
            before = { api, _, journal ->
                journal
                    .persist(
                        api.identity,
                        ComposerJournal(
                            entries = mapOf(target.key to ComposerEntry(text = "Old draft"))
                        ),
                    )
                    .await()
            }
        ) { f ->
            assertEquals(1, f.journal.load(f.api.identity).journal.format)
            f.composer.recover(target, RecoveryApiFixture.FAILURE)
            f.idle()
            val saved = f.journal.load(f.api.identity).journal
            assertEquals(2, saved.format)
            assertEquals("Old draft", saved.entries[target.key]!!.text)
        }
        withRecovery(directory = temporary.newFile()) { f ->
            f.composer.recover(target, RecoveryApiFixture.FAILURE, true)
            runCurrent()
            assertTrue(f.remote.resets.isEmpty())
            assertTrue(f.remote.inputs.isEmpty())
        }
    }

    @Test
    fun billingAndSettingsFailuresNeverBlindlyContinueOrReset() = runTest {
        for (reason in listOf("insufficient_credits", "invalid_credentials")) {
            withRecovery(
                before = { _, remote, _ ->
                    remote.set(RecoveryApiFixture.input(), RecoveryApiFixture.failure(reason))
                }
            ) { f ->
                val data = f.recovery.uiState.value.data!!
                assertFalse(data.classification.canContinue)
                if (reason == "insufficient_credits") assertEquals(0.0, data.billing!!.credits, 0.0)
                f.composer.recover(target, RecoveryApiFixture.FAILURE)
                f.idle()
                f.composer.recover(target, RecoveryApiFixture.FAILURE, true)
                f.idle()
                assertTrue(f.remote.resets.isEmpty())
                assertTrue(f.remote.inputs.isEmpty())
            }
        }
    }

    @Test
    fun modelReplacementDuringHeldAccountReadKeepsHistoryAndDraftUsable() = runTest {
        withRecovery { f ->
            val previous = f.api.commandResponse
            val hold = AtomicBoolean(true)
            val entered = CompletableDeferred<Unit>()
            val release = CountDownLatch(1)
            f.api.commandResponse = { request ->
                if (
                    request.requestUrl?.encodedPath == "/api/me/3rd-party-subscriptions" &&
                        hold.getAndSet(false)
                ) {
                    entered.complete(Unit)
                    release.await()
                }
                previous(request)
            }
            try {
                f.composer.recover(target, RecoveryApiFixture.FAILURE, true)
                entered.await()
                f.composer.edit(target, "Edited while recovery waits")
                assertEquals(HistoryPhase.Ready, f.history.uiState.value.phase)
                val original = f.history.uiState.value.thread!!
                f.history.open(original.copy(selectedModel = "another-model"))
                f.recovery.uiState.first { it.selection?.model == "another-model" }
                f.history.open(original)
                f.recovery.uiState.first { it.selection?.model == original.selectedModel }
                release.countDown()
                f.idle()
                assertTrue(f.remote.resets.isEmpty())
                assertTrue(f.remote.inputs.isEmpty())
                assertEquals(
                    "Edited while recovery waits",
                    f.composer.uiState.value.entry(target).text,
                )
            } finally {
                release.countDown()
            }
        }
    }

    @Test
    fun noCreditStopsResetFlowButSeparateContinueDoesNotSpendAgain() = runTest {
        withRecovery { f ->
            f.remote.reset = { jsonResponse("""{"outcome":"noCredit"}""") }
            f.composer.recover(target, RecoveryApiFixture.FAILURE, true)
            f.idle()
            assertEquals(
                ResetSubscriptionResultOutcome.NOCREDIT,
                f.composer.uiState.value.entry(target).recovery!!.outcome,
            )
            assertNull(f.composer.uiState.value.entry(target).pending)
            assertTrue(f.remote.inputs.isEmpty())
            f.composer.recover(target, RecoveryApiFixture.FAILURE)
            f.idle()
            assertEquals(1, f.remote.resets.size)
            assertEquals(1, f.remote.inputs.size)
        }
    }

    @Test
    fun restoredUnknownResetKeepsAccountKeyAndInputWithoutAutomaticReplay() = runTest {
        val directory = temporary.newFolder()
        withRecovery(directory = directory) { f ->
            f.remote.reset = {
                jsonResponse("""{"error":{"code":"UNKNOWN","message":"Lost outcome"}}""")
                    .setResponseCode(503)
            }
            f.composer.edit(target, "Restore this draft")
            f.composer.recover(target, RecoveryApiFixture.FAILURE, true)
            f.idle()
            val before = f.journal.load(f.api.identity).journal
            f.owners.clear()
            f.journal.close()
            val reopened =
                ComposerJournalStore(
                    ApplicationProvider.getApplicationContext(),
                    directory,
                    StandardTestDispatcher(testScheduler),
                )
            val owners = ViewModelStore()
            try {
                val restored =
                    ChatComposerModel(
                        f.api.service,
                        reopened,
                        f.api.identity,
                        { true },
                        { throw it },
                        {},
                    )
                owners.put("composer", restored)
                restored.open(target)
                restored.uiState.first { it.persistence == ComposerPersistence.Durable }
                assertEquals(before, restored.uiState.value.journal)
                assertEquals("Restore this draft", restored.uiState.value.entry(target).text)
                runCurrent()
                assertEquals(1, f.remote.resets.size)
                assertTrue(f.remote.inputs.isEmpty())
            } finally {
                owners.clear()
                reopened.close()
            }
        }
    }

    @Test
    fun sharedControllersAndStaleFailureCannotDispatchASecondReset() = runTest {
        withRecovery { f ->
            val peer =
                ChatComposerModel(
                    f.api.service,
                    f.journal,
                    f.api.identity,
                    { f.auth.get() },
                    { throw it },
                    {},
                    f.recovery,
                )
            f.owners.put("peer", peer)
            peer.open(target)
            val entered = CompletableDeferred<Unit>()
            val release = CountDownLatch(1)
            f.remote.reset = {
                entered.complete(Unit)
                release.await()
                jsonResponse("""{"outcome":"reset"}""")
            }
            try {
                f.composer.recover(target, RecoveryApiFixture.FAILURE, true)
                entered.await()
                peer.recover(target, RecoveryApiFixture.FAILURE, true)
                f.remote.set(
                    RecoveryApiFixture.input(),
                    RecoveryApiFixture.failure(),
                    RecoveryApiFixture.input(3),
                )
                f.refresh()
                release.countDown()
                f.idle()
                assertEquals(1, f.remote.resets.size)
                assertTrue(f.remote.inputs.isEmpty())
                assertEquals(
                    ResetSubscriptionResultOutcome.RESET,
                    peer.uiState.value.entry(target).recovery!!.outcome,
                )
            } finally {
                release.countDown()
            }
        }
    }

    @Test
    fun latestRenderableFailureRespectsCanonicalTurnsAndQueuedAutomation() {
        fun latest(vararg wire: String): AssistantFailure? {
            val rows = wire.map(HistoryEvent::decode)
            return latestAssistantFailure(
                HistoryCheckpoint(
                    CHAT_PERSONAL,
                    rows,
                    HistoryCursor(rows.last().id, rows.last().seqId),
                )
            )
        }
        val input = RecoveryApiFixture.input()
        val failure = RecoveryApiFixture.failure()
        assertEquals(RecoveryApiFixture.FAILURE, latest(input, failure)?.id)
        assertNull(latest(input, failure, RecoveryApiFixture.input(3)))
        assertEquals(
            RecoveryApiFixture.FAILURE,
            latest(
                    input,
                    failure,
                    historyEventWire(
                        "queued",
                        3,
                        type = "input.automation",
                        payload =
                            """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Queued work"}]}}""",
                        run = null,
                    ),
                )
                ?.id,
        )
        assertNull(
            latest(
                input,
                failure,
                historyEventWire("answer", 3, payload = """{"content":"Later answer"}"""),
            )
        )
    }

    @Test
    fun structuredReasonsExcludeSettingsBillingAndUnknownDespitePersonalRoute() {
        for (reason in
            listOf(
                "invalid_credentials",
                "insufficient_credits",
                "context_window_exceeded",
                "terms_acceptance_required",
                "input_too_large",
                "future_reason",
            )) {
            assertFalse(
                classifyFailure(
                        AssistantFailure("id", "You've hit your usage limit", reason, true),
                        RecoveryFramework.Codex,
                    )
                    .canContinue
            )
        }
        assertTrue(
            classifyFailure(
                    AssistantFailure("id", "Provider diagnostic", "provider_server_error", true),
                    null,
                )
                .canContinue
        )
        val model =
            classifyFailure(
                AssistantFailure("id", "You've hit your usage limit for gpt-5", null, false),
                RecoveryFramework.Codex,
            )
        assertEquals(RecoveryLimit.Model, model.limit)
    }
}
