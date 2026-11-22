package ai.okou.android.connectors

import ai.okou.android.CONNECTOR_AUTHORIZATION_URL
import ai.okou.android.CONNECTOR_CALENDAR
import ai.okou.android.CONNECTOR_CALENDAR_PRIMARY
import ai.okou.android.CONNECTOR_GMAIL_ACCOUNT
import ai.okou.android.CONNECTOR_SLACK_ACCOUNT
import ai.okou.android.ConnectorApiFixture
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ConnectorModelTest {
    @Test
    fun browserReturnPublishesOnlyTheConfirmedAccount() =
        withModel("gmail") { fixture, model ->
            model.startAuthorization(null, "oauth", emptyMap())
            model.await {
                it.action?.busy == false &&
                    it.action.authorization is ConnectorAuthorization.Browser
            }
            model.openBrowser { url ->
                assertEquals(CONNECTOR_AUTHORIZATION_URL, url.toString())
                true
            }
            model.resume()
            val pending =
                model.await { it.action?.problem == ConnectorProblem.AuthorizationIncomplete }
            assertNull(pending.action?.result)
            assertFalse(pending.accountsFor("gmail").any { it.id == CONNECTOR_GMAIL_ACCOUNT })

            fixture.authorizeGmail()
            model.resume()
            val connected = model.await { it.action?.result == ConnectorResult.Authorized }
            assertEquals(CONNECTOR_GMAIL_ACCOUNT, connected.action?.target?.connectionId)
            assertEquals(
                ConnectorAccountStatus.Connected,
                connected.accountsFor("gmail").single().status,
            )
        }

    @Test
    fun aTemporaryBrowserReceiptReadFailureRetriesTheSameAuthorization() =
        withModel("gmail") { fixture, model ->
            model.startAuthorization(null, "oauth", emptyMap())
            model.await {
                it.action?.busy == false &&
                    it.action.authorization is ConnectorAuthorization.Browser
            }
            model.openBrowser { true }
            fixture.failOauthCompletion = true
            model.resume()
            model.await {
                it.action?.busy == false &&
                    it.action.problem == ConnectorProblem.VerificationPending
            }

            fixture.authorizeGmail()
            fixture.failOauthCompletion = false
            val connected = model.await { it.action?.result == ConnectorResult.Authorized }
            assertEquals(CONNECTOR_GMAIL_ACCOUNT, connected.action?.target?.connectionId)
        }

    @Test
    fun renameWithLostResponseSettlesThroughAccountReadback() =
        withModel(CONNECTOR_CALENDAR) { fixture, model ->
            fixture.loseRenameReply = true
            model.rename(CONNECTOR_CALENDAR_PRIMARY, "Meeting calendar")
            val renamed = model.await { it.action?.result == ConnectorResult.Renamed }
            assertEquals(
                "Meeting calendar",
                renamed
                    .accountsFor(CONNECTOR_CALENDAR)
                    .first { it.id == CONNECTOR_CALENDAR_PRIMARY }
                    .displayName,
            )
            assertEquals(2, renamed.accountsFor(CONNECTOR_CALENDAR).size)
        }

    @Test
    fun delayedAccountReadbackRestartsTheDirectoryLoad() {
        val releaseDiscovery = CountDownLatch(1)
        withModel(CONNECTOR_CALENDAR, configure = { it.discoveryGate = releaseDiscovery }) {
            fixture,
            model ->
            fixture.loseRenameReply = true
            fixture.failAccountReads = true
            model.rename(CONNECTOR_CALENDAR_PRIMARY, "Meeting calendar")
            model.await {
                it.action?.busy == false &&
                    it.action.problem == ConnectorProblem.VerificationPending
            }

            fixture.failAccountReads = false
            model.resume()
            model.await { it.action?.result == ConnectorResult.Renamed }
            releaseDiscovery.countDown()

            val directory = model.await { it.browse.data != null }
            val renamed =
                directory.accountsFor(CONNECTOR_CALENDAR).single {
                    it.id == CONNECTOR_CALENDAR_PRIMARY
                }
            assertEquals("Meeting calendar", renamed.displayName)
        }
    }

    @Test
    fun disconnectingTheLastAccountKeepsTheSelectedService() =
        withModel("slack") { _, model ->
            model.await { it.connected.data?.containsKey("slack") == true }
            model.prepareDisconnect(CONNECTOR_SLACK_ACCOUNT)
            model.await { it.impact?.read?.data != null }

            model.disconnect(CONNECTOR_SLACK_ACCOUNT)

            val disconnected = model.await { it.action?.result == ConnectorResult.Disconnected }
            assertEquals("slack", disconnected.detail.data?.entry?.slug)
            assertEquals(emptyList<ConnectorSavedAccount>(), disconnected.accountsFor("slack"))
            assertFalse(requireNotNull(disconnected.connected.data).containsKey("slack"))
        }

    @Test
    fun connectedAccountsRefreshWhileDiscoveryIsRetrying() =
        withModel(CONNECTOR_CALENDAR, configure = { it.failDiscovery = true }) { fixture, model ->
            model.await {
                it.browse.failure != null &&
                    it.accountsFor("slack").singleOrNull()?.status ==
                        ConnectorAccountStatus.Reauthorize
            }

            fixture.removeAccount(CONNECTOR_SLACK_ACCOUNT)
            model.resume()

            val refreshed = model.await { it.connected.data?.containsKey("slack") == false }
            assertEquals(2, refreshed.accountsFor(CONNECTOR_CALENDAR).size)
        }

    @Test
    fun reconnectClearsTheReadFailureWhileKeepingTheLastResultsDuringRefresh() {
        val online = MutableStateFlow(true)
        withModel(CONNECTOR_CALENDAR, connectivity = online) { fixture, model ->
            val cached = model.await { it.browse.data != null }.browse.data
            fixture.failDiscovery = true
            model.resume()
            model.await { it.browse.failure != null }
            online.value = false
            model.await { it.offline }

            val requested = CountDownLatch(1)
            val release = CountDownLatch(1)
            fixture.discoveryRequested = requested
            fixture.discoveryGate = release
            fixture.failDiscovery = false
            online.value = true
            try {
                withContext(Dispatchers.IO) { assertTrue(requested.await(10, TimeUnit.SECONDS)) }
                val refreshing = model.uiState.value
                assertFalse(refreshing.offline)
                assertEquals(cached, refreshing.browse.data)
                assertNull(refreshing.browse.failure)
            } finally {
                release.countDown()
            }
        }
    }

    private fun withModel(
        slug: String,
        configure: (ConnectorApiFixture) -> Unit = {},
        connectivity: Flow<Boolean> = emptyFlow(),
        exercise: suspend (ConnectorApiFixture, ConnectorModel) -> Unit,
    ) = runBlocking {
        ConnectorApiFixture().use { fixture ->
            configure(fixture)
            Executors.newSingleThreadExecutor().asCoroutineDispatcher().use { main ->
                Dispatchers.setMain(main)
                try {
                    withContext(main) {
                        val store = ViewModelStore()
                        val model =
                            ViewModelProvider.create(
                                    store,
                                    viewModelFactory {
                                        initializer {
                                            ConnectorModel(
                                                fixture.service,
                                                connectivity,
                                                { true },
                                            ) {
                                                throw AssertionError(
                                                    "Unexpected session failure",
                                                    it,
                                                )
                                            }
                                        }
                                    },
                                )[ConnectorModel::class]
                        val modelJob = model.viewModelScope.coroutineContext.job
                        try {
                            model.setOpen(true)
                            model.select(slug)
                            model.await { it.detail.data != null && it.accounts.data != null }
                            exercise(fixture, model)
                        } finally {
                            store.clear()
                            withContext(NonCancellable) { modelJob.join() }
                        }
                    }
                } finally {
                    Dispatchers.resetMain()
                }
            }
        }
    }

    private suspend fun ConnectorModel.await(predicate: (ConnectorUiState) -> Boolean) =
        withTimeout(10.seconds) { uiState.first(predicate) }
}
