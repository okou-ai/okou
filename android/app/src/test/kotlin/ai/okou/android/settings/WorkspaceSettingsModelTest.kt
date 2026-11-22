package ai.okou.android.settings

import ai.okou.android.ChatListApiFixture
import ai.okou.android.SettingsApiFixture
import ai.okou.android.api.generated.CanonicalOptional
import ai.okou.android.state.SettingsDestination
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WorkspaceSettingsModelTest {
    @Test
    fun usesTheReportedWindowsAndReconcilesAnAmbiguousActivationWithoutResending() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            ChatListApiFixture().use { api ->
                val fixture = SettingsApiFixture(api)
                val online = MutableStateFlow(true)
                val model = settings(store, api, online = online)
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
                val invalidShortReset =
                    claude
                        .copy(
                            subscriptionUsage =
                                usage.copy(
                                    fiveHour =
                                        checkNotNull(usage.fiveHour).copy(resetAt = "unavailable")
                                )
                        )
                        .quotas()
                assertEquals(invalidShortReset[1].resetAt, invalidShortReset[0].resetAt)
                val alternate = accounts.single { it.id == SettingsApiFixture.alternateAccount }
                val credits = alternate.subscriptionCredits
                check(credits is CanonicalOptional.Present)
                assertEquals(120.0, credits.value!!.balance!!, 0.0)
                assertEquals(CanonicalOptional.Present(null), accounts.first().subscriptionCredits)
                assertEquals(CanonicalOptional.Absent, claude.subscriptionCredits)

                fixture.activationStatus = 500
                fixture.activateBeforeError = true
                model.activate(SettingsApiFixture.alternateAccount)
                model.activate(SettingsApiFixture.alternateAccount)
                val pending = model.uiState.value
                assertEquals(
                    SettingsApiFixture.alternateAccount,
                    pending.switching[ModelAccountProvider.ChatGPT],
                )
                assertTrue(pending.accounts.value!!.first().isActive == true)
                val confirmed = model.uiState.first { it.switching.isEmpty() }
                assertEquals(accounts.map { it.id }, confirmed.accounts.value!!.map { it.id })
                assertTrue(confirmed.accounts.value[1].isActive == true)
                assertTrue(confirmed.switchFailures.isEmpty())
                assertEquals(listOf(SettingsApiFixture.alternateAccount), fixture.activations)
            }
        } finally {
            store.clear()
            Dispatchers.resetMain()
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
            store.clear()
            Dispatchers.resetMain()
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
            store.clear()
            Dispatchers.resetMain()
        }
    }

    private fun settings(
        store: ViewModelStore,
        api: ChatListApiFixture,
        admin: Boolean = false,
        online: MutableStateFlow<Boolean> = MutableStateFlow(true),
    ): WorkspaceSettingsModel =
        ViewModelProvider(
            store,
            viewModelFactory {
                initializer {
                    WorkspaceSettingsModel(api.service, admin, { true }, { throw it }, online)
                }
            },
        )[WorkspaceSettingsModel::class.java]
}
