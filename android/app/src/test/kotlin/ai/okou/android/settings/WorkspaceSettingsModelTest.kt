package ai.okou.android.settings

import ai.okou.android.ChatListApiFixture
import ai.okou.android.SettingsApiFixture
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.CanonicalOptional
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
import kotlinx.coroutines.flow.MutableStateFlow
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class WorkspaceSettingsModelTest {
    @get:Rule val temporary = TemporaryFolder()
    private val presentationJobs = mutableListOf<Job>()

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
                assertEquals(invalidShortReset[1].resetAt, invalidShortReset[0].resetAt)
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
                assertTrue(unconfirmed.switchFailures.isEmpty())
                model.activate(SettingsApiFixture.alternateAccount)
                model.visible(null)
                accountReadsAvailable = true
                model.visible(SettingsDestination.ModelAccounts)
                val confirmed = model.uiState.first { it.switching.isEmpty() }
                assertEquals(accounts.map { it.id }, confirmed.accounts.value!!.map { it.id })
                assertTrue(confirmed.accounts.value[1].isActive == true)
                assertTrue(confirmed.switchFailures.isEmpty())
                assertEquals(listOf(SettingsApiFixture.alternateAccount), fixture.activations)

                store.clear()
                val reopened =
                    settings(reopenedStore, api, online = MutableStateFlow(false), cache = cache)
                reopened.visible(SettingsDestination.ModelAccounts)
                val restored = reopened.uiState.first { it.accounts.value != null }
                assertEquals(confirmed.accounts.value, restored.accounts.value)
            }
        } finally {
            closeOwners(store, reopenedStore)
        }
    }

    @Test
    fun creditsKeepTheMemberValueWhenTheWorkspaceReadFailsAndRefetchOnReconnect() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            ChatListApiFixture().use { api ->
                val fixture = SettingsApiFixture(api)
                fixture.billingStatus = 403
                val online = MutableStateFlow(true)
                val model = settings(store, api, admin = true, online = online)
                model.visible(SettingsDestination.CreditBalance)
                val initial =
                    model.uiState.first {
                        it.usagePack.value != null && it.workspaceCredits.unavailable
                    }
                assertEquals(860L, initial.usagePack.value!!.totalCredits)
                assertNull(initial.workspaceCredits.value)
                online.value = false
                runCurrent()
                assertTrue(model.uiState.value.offline)
                assertEquals(860L, model.uiState.value.usagePack.value!!.totalCredits)
                fixture.billingStatus = 200
                online.value = true
                val restored = model.uiState.first { it.workspaceCredits.value != null }
                assertFalse(restored.offline)
                assertEquals(2400.0, restored.workspaceCredits.value!!.credits, 0.0)
                assertEquals(2, fixture.billingReads.get())
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
                        online = MutableStateFlow(false),
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
                val reopened =
                    settings(reopenedStore, api, online = MutableStateFlow(false), cache = cache)
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
                val online = MutableStateFlow(false)
                var time = 600_000L
                val reply = CompletableDeferred<UsagePackCredits>()
                val service =
                    object : WorkspaceSession by api.service {
                        override suspend fun usagePackCredits() = reply.await()
                    }
                val model =
                    settings(store, api, online = online, cache = cache, service = service) { time }
                model.visible(SettingsDestination.CreditBalance)
                assertEquals(
                    saved,
                    model.uiState.first { it.usagePack.value != null }.usagePack.value,
                )
                online.value = true
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
                            throw ApiFailure.Http(503, null, null, null)
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

                advanceTimeBy(3_000L)
                runCurrent()
                assertEquals(listOf(0L, 3_000L), failedAttempts)
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
                assertEquals(listOf(0L, 3_000L, 6_000L), failedAttempts)
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
        online: MutableStateFlow<Boolean> = MutableStateFlow(true),
        cache: WorkspaceSettingsCache? = null,
        service: WorkspaceSession = api.service,
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
                            { true },
                            { throw it },
                            online,
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
