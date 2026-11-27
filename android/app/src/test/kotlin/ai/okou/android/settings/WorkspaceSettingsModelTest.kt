package ai.okou.android.settings

import ai.okou.android.ChatListApiFixture
import ai.okou.android.SettingsApiFixture
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.CanonicalOptional
import ai.okou.android.api.generated.RecoverySubscriptions
import ai.okou.android.api.generated.UsagePackCredits
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.state.SettingsDestination
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class WorkspaceSettingsModelTest {
    @get:Rule val temporary = TemporaryFolder()
    private val presentationJobs = mutableListOf<Job>()

    @Test
    fun failedRefreshRetainsConfirmedEmptyAccountsAndReportsOnlyForThisVisit() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            ChatListApiFixture().use { api ->
                var fail = false
                val service =
                    object : WorkspaceSession by api.service {
                        override suspend fun recoverySubscriptions(): RecoverySubscriptions {
                            if (fail) throw ApiFailure.Http(400, null, null, null)
                            return RecoverySubscriptions(emptyList())
                        }
                    }
                val model = settings(store, api, service = service)
                model.visible(SettingsDestination.ModelAccounts)
                runCurrent()
                assertEquals(emptyList<Any>(), model.uiState.value.accounts.value)
                assertNull(model.uiState.value.accounts.refreshFailure)

                model.visible(null)
                fail = true
                model.visible(SettingsDestination.ModelAccounts)
                runCurrent()
                val failed = model.uiState.value.accounts
                assertEquals(emptyList<Any>(), failed.value)
                assertTrue(failed.refreshFailure != null)
                assertFalse(failed.initialFailure)

                model.visible(null)
                assertNull(model.uiState.value.accounts.refreshFailure)
                model.visible(SettingsDestination.ModelAccounts)
                runCurrent()
                val nextFailure = checkNotNull(model.uiState.value.accounts.refreshFailure)
                assertTrue(nextFailure !== failed.refreshFailure)
            }
        } finally {
            closeOwners(store)
        }
    }

    @Test
    fun preservesAccountOrderAndReconcilesAnUnconfirmedSwitchWithoutResending() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        val reopenedStore = ViewModelStore()
        try {
            ChatListApiFixture().use { api ->
                val fixture = SettingsApiFixture(api)
                val file = temporary.newFolder().resolve("workspace-settings.preferences_pb")
                val cache = WorkspaceSettingsCache.create(backgroundScope) { file }
                var accountReadsAvailable = true
                val service =
                    object : WorkspaceSession by api.service {
                        override suspend fun recoverySubscriptions() =
                            if (accountReadsAvailable) api.service.recoverySubscriptions()
                            else throw ApiFailure.Http(503, null, null, null)
                    }
                val model = settings(store, api, cache = cache, service = service)
                runCurrent()
                assertEquals(0, fixture.accountReads.get())
                model.visible(SettingsDestination.ModelAccounts)
                val accounts = model.uiState.first { it.accounts.value != null }.accounts.value!!
                assertEquals(
                    listOf(QuotaPeriod.Week),
                    accounts
                        .single { it.id == SettingsApiFixture.alternateAccount }
                        .quotas()
                        .map { it.period },
                )
                val claude = accounts.single { it.provider == ModelAccountProvider.Claude }
                assertEquals(listOf(0.0, 0.0), claude.quotas().map { it.remaining })
                val usage = checkNotNull(claude.subscriptionUsage)
                val shortWindow = checkNotNull(usage.fiveHour)
                val invalidShortReset =
                    claude
                        .copy(
                            subscriptionUsage =
                                usage.copy(fiveHour = shortWindow.copy(resetAt = "unavailable")),
                        )
                        .quotas()
                assertNull(invalidShortReset[0].resetAt)
                assertEquals(claude.quotas()[1].resetAt, invalidShortReset[1].resetAt)
                assertEquals(0.0, invalidShortReset[0].remaining)
                val resetOnly =
                    claude
                        .copy(
                            subscriptionUsage = null,
                            subscriptionResetPeriod = "5-hour window",
                            subscriptionNextResetAt = shortWindow.resetAt,
                        )
                        .quotas()
                        .single()
                assertEquals(QuotaPeriod.Short, resetOnly.period)
                assertNull(resetOnly.remaining)
                val alternate = accounts.single { it.id == SettingsApiFixture.alternateAccount }
                val credits = alternate.subscriptionCredits
                check(credits is CanonicalOptional.Present)
                assertEquals(120.0, credits.value!!.balance!!, 0.0)
                assertEquals(CanonicalOptional.Present(null), accounts.first().subscriptionCredits)
                assertEquals(CanonicalOptional.Absent, claude.subscriptionCredits)

                fixture.activationStatus = 500
                fixture.activateBeforeError = true
                accountReadsAvailable = false
                model.activate(SettingsApiFixture.alternateAccount)
                model.activate(SettingsApiFixture.alternateAccount)
                val pending = model.uiState.value
                assertEquals(
                    SettingsApiFixture.alternateAccount,
                    pending.switching[ModelAccountProvider.ChatGPT]?.accountId,
                )
                assertTrue(pending.accounts.value!!.first().isActive == true)
                val unconfirmed =
                    model.uiState.first {
                        it.switching[ModelAccountProvider.ChatGPT]?.phase ==
                            AccountSwitchPhase.Unconfirmed
                    }
                assertTrue(unconfirmed.accounts.value!!.first().isActive == true)
                assertNull(unconfirmed.accounts.refreshFailure)
                assertEquals(
                    SettingsNotice.ModelAccountSwitchFailed,
                    model.uiState.value.actionFailures.single().value,
                )
                model.activate(SettingsApiFixture.alternateAccount)
                model.visible(null)
                accountReadsAvailable = true
                model.visible(SettingsDestination.ModelAccounts)
                val confirmed = model.uiState.first { it.switching.isEmpty() }
                assertEquals(accounts.map { it.id }, confirmed.accounts.value!!.map { it.id })
                assertTrue(confirmed.accounts.value[1].isActive == true)
                assertEquals(listOf(SettingsApiFixture.alternateAccount), fixture.activations)

                store.clear()
                val reopened = settings(reopenedStore, api, cache = cache)
                reopened.visible(SettingsDestination.ModelAccounts)
                val restored = reopened.uiState.first { it.accounts.value != null }
                assertEquals(confirmed.accounts.value, restored.accounts.value)
            }
        } finally {
            closeOwners(store, reopenedStore)
        }
    }

    @Test
    fun failedSwitchVerificationDoesNotReportTheSameFailureAfterReconciliation() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            ChatListApiFixture().use { api ->
                val fixture = SettingsApiFixture(api)
                var accountReadsAvailable = true
                val service =
                    object : WorkspaceSession by api.service {
                        override suspend fun recoverySubscriptions() =
                            if (accountReadsAvailable) api.service.recoverySubscriptions()
                            else throw ApiFailure.Http(503, null, null, null)
                    }
                val model = settings(store, api, service = service)
                model.visible(SettingsDestination.ModelAccounts)
                val confirmed = model.uiState.first { it.accounts.value != null }.accounts.value
                fixture.activationStatus = 500
                accountReadsAvailable = false
                model.activate(SettingsApiFixture.alternateAccount)
                val failed = model.uiState.first { it.actionFailures.isNotEmpty() }
                val notice = failed.actionFailures.single()
                assertEquals(SettingsNotice.ModelAccountSwitchFailed, notice.value)
                assertEquals(confirmed, failed.accounts.value)
                assertNull(failed.accounts.refreshFailure)

                model.visible(SettingsDestination.Overview)
                accountReadsAvailable = true
                model.visible(SettingsDestination.ModelAccounts)
                val reconciled = model.uiState.first { it.switching.isEmpty() }
                assertEquals(confirmed, reconciled.accounts.value)
                assertEquals(listOf(notice), model.uiState.value.actionFailures)
                assertEquals(listOf(SettingsApiFixture.alternateAccount), fixture.activations)
            }
        } finally {
            closeOwners(store)
        }
    }

    @Test
    fun rejectedAccountSwitchReportsOnceAndKeepsTheConfirmedAccount() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            ChatListApiFixture().use { api ->
                val fixture = SettingsApiFixture(api)
                val model = settings(store, api)
                model.visible(SettingsDestination.ModelAccounts)
                model.uiState.first { it.accounts.value != null }
                fixture.activationStatus = 400
                model.activate(SettingsApiFixture.alternateAccount)
                val receipt =
                    model.uiState.first { it.actionFailures.isNotEmpty() }.actionFailures.single()
                assertEquals(SettingsNotice.ModelAccountSwitchFailed, receipt.value)
                assertTrue(model.uiState.value.switching.isEmpty())
                assertEquals(
                    SettingsApiFixture.primaryAccount,
                    model.uiState.value.accounts.value!!.first { it.isActive == true }.id,
                )
                model.activate(SettingsApiFixture.alternateAccount)
                val pending = model.uiState.first { it.actionFailures.size == 2 }.actionFailures
                val later = pending.last()
                assertSame(receipt, pending.first())
                assertTrue(receipt.order < later.order)
                model.dismissActionFailure(receipt)
                assertEquals(listOf(later), model.uiState.value.actionFailures)
                model.visible(null)
                assertTrue(model.uiState.value.actionFailures.isEmpty())
                assertEquals(List(2) { SettingsApiFixture.alternateAccount }, fixture.activations)
            }
        } finally {
            closeOwners(store)
        }
    }

    @Test
    fun creditsKeepTheMemberValueWhenTheWorkspaceReadFailsAndRefetchOnReentry() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            ChatListApiFixture().use { api ->
                val fixture = SettingsApiFixture(api)
                fixture.billingStatus = 403
                val model = settings(store, api, admin = true)
                model.visible(SettingsDestination.CreditBalance)
                val initial =
                    model.uiState.first {
                        it.usagePack.value != null && it.workspaceCredits.unavailable
                    }
                assertEquals(860L, initial.usagePack.value!!.totalCredits)
                assertNull(initial.workspaceCredits.value)
                model.visible(null)
                runCurrent()
                assertEquals(860L, model.uiState.value.usagePack.value!!.totalCredits)
                fixture.billingStatus = 200
                model.visible(SettingsDestination.CreditBalance)
                val restored = model.uiState.first { it.workspaceCredits.value != null }
                assertEquals(2400.0, restored.workspaceCredits.value!!.credits, 0.0)
                assertEquals(2, fixture.billingReads.get())
            }
        } finally {
            closeOwners(store)
        }
    }

    @Test
    fun bothCachedCreditReadFailuresShareOneNoticePerRefresh() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            ChatListApiFixture().use { api ->
                val fixture = SettingsApiFixture(api)
                var pendingWorkspaceRoleCheck: CompletableDeferred<Unit>? = null
                val model =
                    settings(
                        store,
                        api,
                        admin = true,
                        readWorkspaceAdmin = {
                            pendingWorkspaceRoleCheck?.await()
                            true
                        },
                    )
                model.visible(SettingsDestination.CreditBalance)
                val confirmed =
                    model.uiState.first {
                        it.usagePack.value != null && it.workspaceCredits.value != null
                    }

                var previousFailure: SettingsRefreshFailure? = null
                repeat(2) {
                    model.visible(null)
                    assertNull(model.uiState.value.creditRefreshFailure)
                    fixture.usagePackStatus = 400
                    fixture.billingStatus = 400
                    // Observe the personal failure before StateFlow can conflate both failures.
                    val releaseWorkspaceRole = CompletableDeferred<Unit>()
                    pendingWorkspaceRoleCheck = releaseWorkspaceRole
                    model.visible(SettingsDestination.CreditBalance)
                    val personalFailure =
                        checkNotNull(
                            model.uiState
                                .first { it.creditRefreshFailure != null }
                                .creditRefreshFailure,
                        )
                    assertNotSame(previousFailure, personalFailure)
                    model.dismissRefreshFailure(personalFailure)
                    releaseWorkspaceRole.complete(Unit)
                    val failed =
                        model.uiState.first {
                            it.usagePack.unavailable && it.workspaceCredits.unavailable
                        }
                    runCurrent()
                    assertEquals(confirmed.usagePack.value, failed.usagePack.value)
                    assertEquals(confirmed.workspaceCredits.value, failed.workspaceCredits.value)
                    assertNull(model.uiState.value.creditRefreshFailure)
                    previousFailure = personalFailure
                    // The next visible refresh starts with successful, confirmed reads.
                    model.visible(null)
                    pendingWorkspaceRoleCheck = null
                    fixture.usagePackStatus = 200
                    fixture.billingStatus = 200
                    model.visible(SettingsDestination.CreditBalance)
                    model.uiState.first {
                        !it.usagePack.unavailable && !it.workspaceCredits.unavailable
                    }
                    assertNull(model.uiState.value.creditRefreshFailure)
                }
            }
        } finally {
            closeOwners(store)
        }
    }

    @Test
    fun aDeniedBalanceIsRemovedFromDiskEvenWhenThePageClosesDuringTheWrite() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        val reopenedStore = ViewModelStore()
        val releaseStore = CompletableDeferred<Unit>()
        try {
            ChatListApiFixture().use { api ->
                SettingsApiFixture(api)
                val file = temporary.newFolder().resolve("workspace-settings.preferences_pb")
                val preferences =
                    PreferenceDataStoreFactory.create(scope = backgroundScope) { file }
                val cache = WorkspaceSettingsCache(preferences, backgroundScope)
                val cached = WorkspaceCreditSummary(2_400.0, emptyList())
                cache.save(
                    api.identity,
                    "workspace-credits",
                    WorkspaceCreditSummary.serializer(),
                    ConfirmedSetting(cached, 0),
                )
                val deny = CompletableDeferred<Unit>()
                val service =
                    object : WorkspaceSession by api.service {
                        override suspend fun recoveryBilling(): Nothing {
                            deny.await()
                            throw ApiFailure.Http(403, null, null, null)
                        }
                    }
                val model = settings(store, api, admin = true, cache = cache, service = service)
                model.visible(SettingsDestination.CreditBalance)
                val initial =
                    model.uiState.first {
                        it.usagePack.value != null && it.workspaceCredits.value != null
                    }
                assertEquals(cached, initial.workspaceCredits.value)

                val storeOccupied = CompletableDeferred<Unit>()
                val pendingWrite = backgroundScope.launch {
                    preferences.edit {
                        storeOccupied.complete(Unit)
                        releaseStore.await()
                    }
                }
                storeOccupied.await()
                deny.complete(Unit)
                model.uiState.first { it.workspaceCredits.initialFailure }
                model.visible(null)
                store.clear()
                releaseStore.complete(Unit)
                pendingWrite.join()

                val reopened =
                    settings(
                        reopenedStore,
                        api,
                        admin = true,
                        cache = cache,
                    )
                reopened.visible(SettingsDestination.CreditBalance)
                val restored = reopened.uiState.first { it.usagePack.value != null }
                assertEquals(initial.usagePack.value, restored.usagePack.value)
                assertNull(restored.workspaceCredits.value)
            }
        } finally {
            releaseStore.complete(Unit)
            closeOwners(store, reopenedStore)
        }
    }

    @Test
    fun confirmedBalancesRepopulateACorruptSettingsFile() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        val reopenedStore = ViewModelStore()
        try {
            ChatListApiFixture().use { api ->
                SettingsApiFixture(api)
                val file = temporary.newFolder().resolve("workspace-settings.preferences_pb")
                file.writeBytes(byteArrayOf(0x0a, 0x04, 0x0a))
                val cache = WorkspaceSettingsCache.create(backgroundScope) { file }
                val model = settings(store, api, cache = cache)
                model.visible(SettingsDestination.CreditBalance)
                val confirmed = model.uiState.first { it.usagePack.value != null }.usagePack.value
                store.clear()
                val reopened = settings(reopenedStore, api, cache = cache)
                reopened.visible(SettingsDestination.CreditBalance)
                val restored = reopened.uiState.first { it.usagePack.value != null }
                assertEquals(confirmed, restored.usagePack.value)
            }
        } finally {
            closeOwners(store, reopenedStore)
        }
    }

    @Test
    fun restoredCreditRemainsVisibleAndOnlyAStaleReadShowsProgress() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            ChatListApiFixture().use { api ->
                val file = temporary.newFolder().resolve("workspace-settings.preferences_pb")
                val creditsSerializer = UsagePackCredits.serializer()
                val saved = UsagePackCredits(100, 90, 10)
                val writerScope = CoroutineScope(StandardTestDispatcher(testScheduler))
                try {
                    val writer = WorkspaceSettingsCache.create(writerScope) { file }
                    writer.save(
                        api.identity,
                        "usage-pack",
                        creditsSerializer,
                        ConfirmedSetting(saved, 0),
                    )
                    assertEquals(
                        saved,
                        writer.load(api.identity, "usage-pack", creditsSerializer)?.value,
                    )
                } finally {
                    writerScope.cancel()
                }
                runCurrent()
                val cache = WorkspaceSettingsCache.create(backgroundScope) { file }
                val otherScopes =
                    listOf(
                        api.identity.copy(userId = "other-user"),
                        api.identity.copy(workspaceId = "other-workspace"),
                        api.identity.copy(authorizationScope = "other-access"),
                    )
                for (identity in otherScopes) {
                    assertNull(cache.load(identity, "usage-pack", creditsSerializer))
                }
                var time = 600_000L
                val reply = CompletableDeferred<UsagePackCredits>()
                val service =
                    object : WorkspaceSession by api.service {
                        override suspend fun usagePackCredits() = reply.await()
                    }
                val model = settings(store, api, cache = cache, service = service) { time }
                model.visible(SettingsDestination.CreditBalance)
                assertEquals(
                    saved,
                    model.uiState.first { it.usagePack.value != null }.usagePack.value,
                )
                runCurrent()
                assertFalse(model.uiState.value.usagePack.refreshing)
                model.visible(null)
                runCurrent()
                time += 1
                model.visible(SettingsDestination.CreditBalance)
                val stale = model.uiState.first { it.usagePack.refreshing }
                assertEquals(saved, stale.usagePack.value)
                reply.complete(UsagePackCredits(200, 180, 20))
                val fresh = model.uiState.first { it.usagePack.value?.totalCredits == 200L }
                assertFalse(fresh.usagePack.refreshing)
                assertNull(fresh.workspaceCredits.value)
            }
        } finally {
            closeOwners(store)
        }
    }

    @Test
    fun staleCreditKeepsProgressThroughTwoRetriesAndKeepsTheBalanceAfterFailure() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            ChatListApiFixture().use { api ->
                val confirmed = UsagePackCredits(860, 800, 60)
                val failedAttempts = mutableListOf<Long>()
                var available = true
                var time = 0L
                val service =
                    object : WorkspaceSession by api.service {
                        override suspend fun usagePackCredits(): UsagePackCredits {
                            if (available) return confirmed
                            failedAttempts += testScheduler.currentTime
                            val retryAfter = if (failedAttempts.size == 1) 1L else null
                            throw ApiFailure.Http(503, null, null, retryAfter)
                        }
                    }
                val model = settings(store, api, service = service) { time }
                model.visible(SettingsDestination.CreditBalance)
                runCurrent()
                assertEquals(confirmed, model.uiState.value.usagePack.value)

                model.visible(null)
                available = false
                time = 600_001L
                model.visible(SettingsDestination.CreditBalance)
                runCurrent()
                assertEquals(listOf(0L), failedAttempts)
                assertTrue(model.uiState.value.usagePack.refreshing)
                assertFalse(model.uiState.value.usagePack.unavailable)

                advanceTimeBy(999L)
                runCurrent()
                assertEquals(listOf(0L), failedAttempts)
                advanceTimeBy(1L)
                runCurrent()
                assertEquals(listOf(0L, 1_000L), failedAttempts)
                assertTrue(model.uiState.value.usagePack.refreshing)
                assertFalse(model.uiState.value.usagePack.unavailable)

                advanceTimeBy(3_000L)
                runCurrent()
                val failed = model.uiState.value.usagePack
                assertEquals(confirmed, failed.value)
                assertFalse(failed.refreshing)
                assertTrue(failed.unavailable)

                advanceTimeBy(60_000L)
                runCurrent()
                assertEquals(listOf(0L, 1_000L, 4_000L), failedAttempts)
            }
        } finally {
            closeOwners(store)
        }
    }

    @Test
    fun closingCreditBalanceCancelsItsRetryWait() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            ChatListApiFixture().use { api ->
                val attempts = mutableListOf<Long>()
                val service =
                    object : WorkspaceSession by api.service {
                        override suspend fun usagePackCredits(): UsagePackCredits {
                            attempts += testScheduler.currentTime
                            throw ApiFailure.Http(503, null, null, 1L)
                        }
                    }
                val model = settings(store, api, service = service)
                model.visible(SettingsDestination.CreditBalance)
                runCurrent()
                assertEquals(listOf(0L), attempts)
                advanceTimeBy(500L)
                model.visible(null)
                advanceTimeBy(10_000L)
                runCurrent()
                assertEquals(listOf(0L), attempts)
            }
        } finally {
            closeOwners(store)
        }
    }

    @Test
    fun reopeningThePageRecoversAnInitialCreditFailure() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            ChatListApiFixture().use { api ->
                val fixture = SettingsApiFixture(api)
                fixture.usagePackStatus = 400
                val model = settings(store, api, admin = true)
                model.visible(SettingsDestination.CreditBalance)
                model.uiState.first {
                    it.usagePack.initialFailure && it.workspaceCredits.value != null
                }
                fixture.usagePackStatus = 200
                model.visible(null)
                model.visible(SettingsDestination.CreditBalance)
                val recovered = model.uiState.first { it.usagePack.value != null }
                assertEquals(860L, recovered.usagePack.value!!.totalCredits)
                assertEquals(2, fixture.usagePackReads.get())
                assertFalse(recovered.usagePack.unavailable)
            }
        } finally {
            closeOwners(store)
        }
    }

    @Test
    fun memberNeverRequestsWorkspaceBalance() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            ChatListApiFixture().use { api ->
                val fixture = SettingsApiFixture(api)
                val model = settings(store, api)
                model.visible(SettingsDestination.CreditBalance)
                assertEquals(
                    860L,
                    model.uiState
                        .first { it.usagePack.value != null }
                        .usagePack
                        .value!!
                        .totalCredits,
                )
                assertEquals(0, fixture.billingReads.get())
            }
        } finally {
            closeOwners(store)
        }
    }

    @Test
    fun losingAdminWhileAwayDropsTheCachedBalanceAndDiscardsTheOldResponse() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        val releaseOldRead = CompletableDeferred<Unit>()
        try {
            ChatListApiFixture().use { api ->
                val fixture = SettingsApiFixture(api)
                val file = temporary.newFolder().resolve("workspace-settings.preferences_pb")
                val cache = WorkspaceSettingsCache.create(backgroundScope) { file }
                val cached = WorkspaceCreditSummary(120.0, emptyList())
                cache.save(
                    api.identity,
                    "workspace-credits",
                    WorkspaceCreditSummary.serializer(),
                    ConfirmedSetting(cached, 0L),
                )
                val oldReadStarted = CompletableDeferred<Unit>()
                val newRole = CompletableDeferred<Boolean>()
                var roleReads = 0
                val service =
                    object : WorkspaceSession by api.service {
                        override suspend fun recoveryBilling() =
                            withContext(NonCancellable) {
                                oldReadStarted.complete(Unit)
                                releaseOldRead.await()
                                api.service.recoveryBilling()
                            }
                    }
                val model =
                    settings(
                        store,
                        api,
                        admin = true,
                        cache = cache,
                        service = service,
                        readWorkspaceAdmin = {
                            if (++roleReads == 1) true else newRole.await()
                        },
                    )
                model.visible(SettingsDestination.CreditBalance)
                oldReadStarted.await()
                assertEquals(cached, model.uiState.value.workspaceCredits.value)

                model.visible(null)
                model.visible(SettingsDestination.CreditBalance)
                val personal = model.uiState.first { it.usagePack.value != null }
                assertTrue(personal.showWorkspaceCredits)
                assertEquals(cached, personal.workspaceCredits.value)
                newRole.complete(false)
                val revoked = model.uiState.first { !it.showWorkspaceCredits }
                assertNull(revoked.workspaceCredits.value)
                assertEquals(860L, revoked.usagePack.value?.totalCredits)

                releaseOldRead.complete(Unit)
                model.visible(null)
                store.clear()
                presentationJobs.joinAll()
                assertEquals(1, fixture.billingReads.get())
                assertNull(model.uiState.value.workspaceCredits.value)
                assertNull(
                    cache.load(
                        api.identity,
                        "workspace-credits",
                        WorkspaceCreditSummary.serializer(),
                    ),
                )
            }
        } finally {
            releaseOldRead.complete(Unit)
            closeOwners(store)
        }
    }

    @Test
    fun failedRoleLookupKeepsConfirmedAdminBalanceUntilLaterRefresh() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            ChatListApiFixture().use { api ->
                val fixture = SettingsApiFixture(api)
                var unavailable = false
                var roleReads = 0
                val model =
                    settings(
                        store,
                        api,
                        readWorkspaceAdmin = {
                            roleReads++
                            if (unavailable) throw ApiFailure.Http(503, null, null, null)
                            true
                        },
                    )
                model.visible(SettingsDestination.CreditBalance)
                val confirmed = model.uiState.first { it.workspaceCredits.value != null }
                assertTrue(confirmed.showWorkspaceCredits)

                unavailable = true
                model.visible(null)
                model.visible(SettingsDestination.CreditBalance)
                val failed = model.uiState.first { it.workspaceCredits.unavailable }
                assertEquals(4, roleReads)
                assertTrue(failed.showWorkspaceCredits)
                assertEquals(confirmed.workspaceCredits.value, failed.workspaceCredits.value)
                assertTrue(
                    model.uiState.first { it.creditRefreshFailure != null }.showWorkspaceCredits,
                )
                assertEquals(1, fixture.billingReads.get())

                unavailable = false
                model.visible(null)
                model.visible(SettingsDestination.CreditBalance)
                val recovered =
                    model.uiState.first {
                        !it.workspaceCredits.unavailable && it.workspaceCredits.value != null
                    }
                assertTrue(recovered.showWorkspaceCredits)
                assertEquals(5, roleReads)
                assertEquals(2, fixture.billingReads.get())
            }
        } finally {
            closeOwners(store)
        }
    }

    private suspend fun closeOwners(vararg stores: ViewModelStore) {
        try {
            withContext(NonCancellable) {
                stores.forEach { it.clear() }
                presentationJobs.joinAll()
            }
        } finally {
            Dispatchers.resetMain()
        }
    }

    private fun TestScope.settings(
        store: ViewModelStore,
        api: ChatListApiFixture,
        admin: Boolean = false,
        cache: WorkspaceSettingsCache? = null,
        service: WorkspaceSession = api.service,
        readWorkspaceAdmin: suspend () -> Boolean = { admin },
        nowMillis: () -> Long = System::currentTimeMillis,
    ): WorkspaceSettingsModel =
        ViewModelProvider(
                store,
                viewModelFactory {
                    initializer {
                        val file = temporary.newFolder().resolve("default-model.preferences_pb")
                        val defaultModelStore =
                            DefaultModelStore(
                                PreferenceDataStoreFactory.create(scope = backgroundScope) { file },
                                backgroundScope,
                            )
                        WorkspaceSettingsModel(
                            service,
                            api.identity,
                            defaultModelStore,
                            admin,
                            readWorkspaceAdmin,
                            { true },
                            { throw it },
                            cache,
                            nowMillis,
                        )
                    }
                },
            )[WorkspaceSettingsModel::class.java]
            .also {
                presentationJobs += checkNotNull(it.viewModelScope.coroutineContext[Job])
            }
}
