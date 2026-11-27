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
import java.util.concurrent.atomic.AtomicInteger
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
    private val target = ComposerTarget(threadId = CHAT_PERSONAL)

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
        val controls: RunControlsModel,
        val list: ChatListModel?,
    )

    private suspend fun TestScope.withRecovery(
        directory: File = temporary.newFolder(),
        withList: Boolean = false,
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
        val controlOwners = RunControlOwners()
        val owners = ViewModelStore()
        val auth = AtomicBoolean(true)
        val retired = CompletableDeferred<Unit>()
        try {
            ChatListApiFixture().use { api ->
                val remote = RecoveryApiFixture(api)
                remote.set(RecoveryApiFixture.input(), RecoveryApiFixture.failure())
                before(api, remote, journal)
                val failure: (Exception) -> Unit = {
                    auth.set(false)
                    owners.clear()
                    retired.complete(Unit)
                }
                val list =
                    if (withList)
                        ChatListModel(
                                api.service,
                                cache,
                                api.identity,
                                auth::get,
                                failure,
                                dispatcher,
                            )
                            .also { owners.put("list", it) }
                    else null
                val lease = if (list == null) cache.open(api.identity, auth::get) else null
                val history =
                    list?.history
                        ?: ConversationHistoryModel(
                            api.service,
                            checkNotNull(lease),
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
                                        controlOwners,
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
                            chatList = list,
                        )
                    owners.put("composer", composer)
                    val thread =
                        Json.decodeFromString<ChatArchive>(
                                """{"chatThreads":[{"id":"$CHAT_PERSONAL","projectId":null,"title":"Thread","sortAt":"$CHAT_DATE","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","pinnedAt":null,"archived":false,"renamedAt":null,"selectedModel":"gpt-recovery","serviceTier":"priority"}]}""",
                            )
                            .chatThreads
                            .single()
                    history.open(thread)
                    history.uiState.first {
                        it.phase == HistoryPhase.Ready && it.detailPhase == ChatReadPhase.Ready
                    }
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
                            controls,
                            list,
                        ),
                    )
                } finally {
                    owners.clear()
                    if (lease != null) {
                        history.close()
                        lease.close()
                    }
                }
            }
        } finally {
            journal.close()
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
    fun undeliveredContinueCanExplicitlyAddResetWithoutChangingInputIdentity() = runTest {
        withRecovery { f ->
            val previous = f.api.commandResponse
            val reads = AtomicInteger()
            f.api.commandResponse = { request ->
                if (
                    request.requestUrl?.encodedPath == "/api/model-catalog" &&
                        reads.incrementAndGet() == 2
                ) {
                    jsonResponse(
                            """{"error":{"code":"UNAVAILABLE","message":"Final preflight failed"}}""",
                        )
                        .setResponseCode(503)
                } else previous(request)
            }
            f.composer.edit(target, "Keep this draft")
            f.composer.recover(target, RecoveryApiFixture.FAILURE)
            f.idle()
            val original = f.composer.uiState.value.entry(target).recovery!!
            assertNull(original.reset)
            assertNull(f.composer.uiState.value.entry(target).pending)
            assertTrue(f.remote.inputs.isEmpty())
            f.api.commandResponse = previous
            f.composer.recover(target, RecoveryApiFixture.FAILURE, true)
            f.idle()
            assertEquals(1, f.remote.resets.size)
            assertEquals(
                original.send.clientEventId,
                f.remote.inputs.single().getValue("clientEventId").jsonPrimitive.content,
            )
            assertEquals("Keep this draft", f.composer.uiState.value.entry(target).text)
        }
    }

    @Test
    fun definitiveNoCreditCanStartNewResetOnlyAfterExplicitChoiceWithFreshCredits() = runTest {
        withRecovery { f ->
            f.remote.reset = {
                f.remote.credits = 0
                jsonResponse("""{"outcome":"noCredit"}""")
            }
            f.composer.recover(target, RecoveryApiFixture.FAILURE, true)
            f.idle()
            val original = f.composer.uiState.value.entry(target).recovery!!
            assertEquals(ResetSubscriptionResultOutcome.NOCREDIT, original.outcome)
            f.recovery.refresh()
            f.recovery.uiState.first { it.phase == ChatReadPhase.Ready }
            f.composer.recover(target, RecoveryApiFixture.FAILURE, true)
            f.idle()
            assertEquals(1, f.remote.resets.size)
            assertTrue(f.remote.inputs.isEmpty())
            f.remote.credits = 1
            f.recovery.refresh()
            f.recovery.uiState.first { it.phase == ChatReadPhase.Ready }
            runCurrent()
            assertEquals(1, f.remote.resets.size)
            f.remote.reset = { jsonResponse("""{"outcome":"reset"}""") }
            f.composer.recover(target, RecoveryApiFixture.FAILURE, true)
            f.idle()
            assertEquals(2, f.remote.resets.size)
            assertNotEquals(
                f.remote.resets[0].second.getValue("idempotencyKey"),
                f.remote.resets[1].second.getValue("idempotencyKey"),
            )
            assertEquals(
                original.send.clientEventId,
                f.remote.inputs.single().getValue("clientEventId").jsonPrimitive.content,
            )
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
            assertEquals(
                frozen.selection,
                f.composer.uiState.value.recoveryFailures[target.key],
            )
            assertFalse(target.key in f.composer.uiState.value.failed)
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
            f.composer.checkRecoveryReset(target, RecoveryApiFixture.FAILURE, "stale-key")
            f.idle()
            assertEquals(1, f.remote.resets.size)
            f.composer.checkRecoveryReset(
                target,
                RecoveryApiFixture.FAILURE,
                checkNotNull(frozen.reset).idempotencyKey,
            )
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
    fun resetConfirmationCannotSpendFromAnAccountThatReplacedTheDisplayedOne() = runTest {
        withRecovery { f ->
            val displayedAccount = checkNotNull(f.recovery.uiState.value.data?.resetAccount).id
            f.remote.account = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
            f.recovery.refresh()
            f.recovery.uiState.first { it.phase == ChatReadPhase.Ready }

            f.composer.confirmRecoveryReset(target, RecoveryApiFixture.FAILURE, displayedAccount)
            f.idle()
            assertTrue(f.remote.resets.isEmpty())
            assertTrue(f.remote.inputs.isEmpty())
            f.composer.confirmRecoveryReset(target, RecoveryApiFixture.FAILURE, f.remote.account)
            f.idle()
            assertEquals(f.remote.account, f.remote.resets.single().first)
            assertEquals(1, f.remote.inputs.size)
        }
    }

    @Test
    fun accountChangedDuringResetRequiresANewDisplayedChoice() = runTest {
        for (resetAgain in listOf(false, true)) withRecovery { f ->
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
                val first = f.composer.uiState.value.entry(target).recovery!!
                f.recovery.refresh()
                f.recovery.uiState.first { it.phase == ChatReadPhase.Ready }
                assertEquals(f.remote.account, f.recovery.uiState.value.data!!.account!!.id)
                f.composer.recover(target, RecoveryApiFixture.FAILURE, resetAgain)
                f.idle()
                assertEquals(1, f.remote.inputs.size)
                assertNotEquals(
                    first.send.clientEventId,
                    f.remote.inputs.single().getValue("clientEventId").jsonPrimitive.content,
                )
                if (resetAgain) {
                    assertEquals(2, f.remote.resets.size)
                    assertEquals(f.remote.account, f.remote.resets.last().first)
                    assertNotEquals(
                        f.remote.resets.first().second.getValue("idempotencyKey"),
                        f.remote.resets.last().second.getValue("idempotencyKey"),
                    )
                } else {
                    assertEquals(1, f.remote.resets.size)
                    assertNull(f.composer.uiState.value.entry(target).recovery!!.reset)
                }
            } finally {
                release.countDown()
            }
        }
    }

    @Test
    fun resetCancelledBeforeDispatchDoesNotBlockFreshFailureRecovery() = runTest {
        withRecovery { f ->
            val original = f.history.uiState.value.thread!!
            f.composer.recover(target, RecoveryApiFixture.FAILURE, true)
            f.composer.uiState.first { it.entry(target).recovery?.reset != null }
            f.history.open(original.copy(selectedModel = "another-model"))
            f.idle()
            assertTrue(f.remote.resets.isEmpty())
            assertTrue(f.remote.inputs.isEmpty())

            f.history.open(original)
            f.history.uiState.first { it.phase == HistoryPhase.Ready }
            val nextFailure = UUID.randomUUID().toString()
            val nextRun = UUID.randomUUID().toString()
            val earlier = f.remote.rows.get().map(HistoryEvent::archiveJson).toTypedArray()
            f.remote.set(
                *earlier,
                RecoveryApiFixture.input(3, run = nextRun),
                RecoveryApiFixture.failure(seq = 4, id = nextFailure, run = nextRun),
            )
            f.refresh()
            f.recovery.uiState.first {
                it.phase == ChatReadPhase.Ready && it.selection?.failureId == nextFailure
            }
            f.composer.recover(target, nextFailure, true)
            f.idle()
            assertEquals(1, f.remote.resets.size)
            assertEquals(1, f.remote.inputs.size)
        }
    }

    @Test
    fun retiringBeforeResetDispatchRestoresUnsentContinueAndDraft() = runTest {
        withRecovery { f ->
            val original = f.history.uiState.value.thread!!
            f.composer.edit(target, "Keep the unsent draft")
            f.composer.recover(target, RecoveryApiFixture.FAILURE)
            f.composer.uiState.first { it.entry(target).recovery != null }
            f.history.open(original.copy(selectedModel = "another-model"))
            f.idle()
            val before = f.composer.uiState.value.entry(target).recovery!!
            assertNull(before.reset)
            assertTrue(f.remote.inputs.isEmpty())

            f.history.open(original)
            f.recovery.uiState.first {
                it.phase == ChatReadPhase.Ready && it.selection?.model == original.selectedModel
            }
            f.composer.recover(target, RecoveryApiFixture.FAILURE, true)
            f.composer.uiState.first { it.entry(target).recovery?.reset != null }
            f.owners.clear()
            val saved = f.journal.load(f.api.identity).journal
            assertEquals(before, saved.entries.getValue(target.key).recovery)
            assertEquals("Keep the unsent draft", saved.drafts.getValue(target.key).text)
            assertNull(saved.entries.getValue(target.key).pending)
            assertTrue(f.remote.resets.isEmpty())
            assertTrue(f.remote.inputs.isEmpty())
        }
    }

    @Test
    fun recoveredInputStopsPromotingTheRowAfterCanonicalRefresh() = runTest {
        withRecovery(withList = true) { f ->
            val list = checkNotNull(f.list)
            val other =
                chatEventWire(
                        id = "77777777-7777-4777-8777-777777777777",
                        seq = 18,
                        thread = CHAT_IN_PROJECT,
                    )
                    .replace(CHAT_DATE, "2026-11-14T00:00:00.000Z")
            f.api.events = { request ->
                if (request.requestUrl?.queryParameter("sinceSeqId") == null)
                    jsonResponse("""{"events":[${chatEventWire()},$other],"hasMore":false}""")
                else jsonResponse("""{"events":[],"hasMore":false}""")
            }
            list.refresh()
            list.uiState.first { it.listPhase == ChatReadPhase.Ready }
            val baseline = list.uiState.value.threads.map { it.id }
            assertEquals(listOf(CHAT_IN_PROJECT, CHAT_PERSONAL), baseline)

            f.remote.send = {
                jsonResponse("""{"error":{"code":"UNKNOWN","message":"Lost response"}}""")
                    .setResponseCode(503)
            }
            f.composer.recover(target, RecoveryApiFixture.FAILURE)
            f.idle()
            runCurrent()
            list.uiState.first { it.listPhase == ChatReadPhase.Ready }
            assertNotNull(f.composer.uiState.value.entry(target).pending)
            assertEquals(CHAT_PERSONAL, list.uiState.value.threads.first().id)
            val previous = f.api.commandResponse
            f.api.commandResponse = { request ->
                val path = request.requestUrl!!.pathSegments
                if (path.getOrNull(3) == "inputs") {
                    val id = path[4]
                    jsonResponse(
                        """{"threadId":"$CHAT_PERSONAL","eventId":"$id","input":{"eventId":"$id","seqId":3,"createdAt":"$CHAT_DATE"},"replacement":null,"status":"queued","runId":null,"terminal":null}""",
                    )
                } else previous(request)
            }
            f.composer.retry(target)
            f.idle()
            assertEquals(
                TextDisposition.Queued,
                f.composer.uiState.value.entry(target).receipt?.disposition,
            )
            assertEquals(1, f.remote.inputs.size)
            assertEquals(CHAT_PERSONAL, list.uiState.value.threads.first().id)
            val refreshed = async {
                list.uiState.first { it.listPhase == ChatReadPhase.Loading }
                list.uiState.first { it.listPhase == ChatReadPhase.Ready }
            }
            runCurrent()
            list.refresh()
            assertEquals(baseline, refreshed.await().threads.map { it.id })
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
                            entries = mapOf(target.key to ComposerEntry(text = "Old draft")),
                        ),
                    )
                    .await()
            },
        ) { f ->
            assertEquals(3, f.journal.load(f.api.identity).journal.format)
            f.composer.recover(target, RecoveryApiFixture.FAILURE)
            f.idle()
            val saved = f.journal.load(f.api.identity).journal
            assertEquals(3, saved.format)
            assertEquals("Old draft", saved.drafts[target.key]!!.text)
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
            val billingAttempts = AtomicInteger()
            withRecovery(
                before = { api, remote, _ ->
                    remote.set(RecoveryApiFixture.input(), RecoveryApiFixture.failure(reason))
                    val canonical = api.commandResponse
                    api.commandResponse = { request ->
                        if (
                            request.requestUrl?.encodedPath == "/api/billing/status" &&
                                billingAttempts.incrementAndGet() <= 2
                        ) {
                            jsonResponse(
                                    """{"error":{"code":"UNAVAILABLE","message":"Unavailable"}}""",
                                )
                                .setResponseCode(503)
                        } else canonical(request)
                    }
                },
            ) { f ->
                val data = f.recovery.uiState.value.data!!
                assertFalse(data.classification.canContinue)
                if (reason == "insufficient_credits") {
                    assertEquals(3, billingAttempts.get())
                    assertEquals(0.0, data.billing!!.credits, 0.0)
                } else assertEquals(0, billingAttempts.get())
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
    fun stopStartedDuringHeldRecoveryReadPreventsResetAndContinue() = runTest {
        val liveRun = "abababab-abab-4bab-8bab-abababababab"
        withRecovery(
            before = { _, remote, _ ->
                remote.set(
                    RecoveryApiFixture.input(1, run = liveRun),
                    RecoveryApiFixture.input(2),
                    RecoveryApiFixture.failure(seq = 3),
                )
            },
        ) { f ->
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
                f.controls.stop(CHAT_PERSONAL, listOf(liveRun))
                f.controls.uiState.first {
                    it.phases.values.singleOrNull() == RunControlPhase.Accepted
                }
                release.countDown()
                f.idle()
                assertTrue(f.remote.resets.isEmpty())
                assertEquals(
                    liveRun,
                    f.remote.inputs.single().getValue("interruptsRunId").jsonPrimitive.content,
                )
                assertNull(f.composer.uiState.value.entry(target).pending)
            } finally {
                release.countDown()
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
                ),
            )
        }
        val input = RecoveryApiFixture.input()
        val failure = RecoveryApiFixture.failure()
        val lateLegacy =
            historyEventWire(
                "late-legacy",
                3,
                type = "output.error",
                payload = """{"error":"Ordinary output error"}""",
            )
        assertEquals(
            AssistantFailure.Run(RecoveryApiFixture.FAILURE, "usage_limit"),
            latest(input, failure),
        )
        assertEquals(latest(input, failure), latest(input, failure, lateLegacy))
        assertEquals(
            latest(input, failure),
            latest(
                input,
                failure,
                historyEventWire("blank", 3, payload = """{"content":" \n"}"""),
            ),
        )
        assertEquals(
            AssistantFailure.Output("late-legacy", "Ordinary output error"),
            latest(
                input,
                failure,
                RecoveryApiFixture.input(3),
                historyEventWire(
                    "late-legacy",
                    4,
                    type = "output.error",
                    payload = """{"error":"Ordinary output error"}""",
                ),
            ),
        )
        assertEquals(
            AssistantFailure.Output("output", "Ordinary output error"),
            latest(
                input,
                historyEventWire(
                    "output",
                    3,
                    type = "output.error",
                    payload = """{"error":"Ordinary output error"}""",
                ),
            ),
        )
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
            ),
        )
    }

    @Test
    fun structuredReasonsWithoutContinueStayIneligibleOnPersonalRoutes() {
        for (reason in
            listOf(
                "invalid_credentials",
                "insufficient_credits",
                "context_window_exceeded",
                "terms_acceptance_required",
                "input_too_large",
                "provider_image_too_large",
                "safety_policy_refusal",
                "future_reason",
            )) {
            assertFalse(
                classifyFailure(AssistantFailure.Run("id", reason), RecoveryFramework.Codex)
                    .canContinue,
            )
        }
        assertTrue(
            classifyFailure(AssistantFailure.Run("id", "provider_server_error"), null).canContinue,
        )
        val legacySafety =
            classifyFailure(
                AssistantFailure.Output(
                    "id",
                    """Bad request: {"error":{"code":"content_policy_violation"}}""",
                ),
                RecoveryFramework.Codex,
            )
        assertEquals(FailureKind.Safety, legacySafety.kind)
        assertFalse(legacySafety.canContinue)
        val model =
            classifyFailure(
                AssistantFailure.Output("id", "You've hit your usage limit for gpt-5"),
                RecoveryFramework.Codex,
            )
        assertEquals(RecoveryLimit.Model, model.limit)
        for (space in listOf('\u00a0', '\u2009', '\ufeff')) {
            val diagnostic = "You've${space}hit your usage limit"
            val failure = AssistantFailure.Output("id", diagnostic)
            assertEquals(FailureKind.Usage, classifyFailure(failure, RecoveryFramework.Codex).kind)
            assertEquals(diagnostic, failure.error)
        }
    }
}
