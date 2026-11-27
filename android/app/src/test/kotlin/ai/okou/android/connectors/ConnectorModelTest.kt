package ai.okou.android.connectors

import ai.okou.android.CONNECTOR_AUTHORIZATION_URL
import ai.okou.android.CONNECTOR_CALENDAR
import ai.okou.android.CONNECTOR_CALENDAR_PRIMARY
import ai.okou.android.CONNECTOR_CALENDAR_SECONDARY
import ai.okou.android.CONNECTOR_DEVICE_ACCOUNT
import ai.okou.android.CONNECTOR_DEVICE_EXAMPLE
import ai.okou.android.CONNECTOR_EXAMPLE_DEVICE_CODE
import ai.okou.android.CONNECTOR_GMAIL_ACCOUNT
import ai.okou.android.CONNECTOR_MANUAL_EXAMPLE
import ai.okou.android.CONNECTOR_SLACK_ACCOUNT
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.FixtureConnectorIcon
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TestTimeSource
import kotlin.time.TimeSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asCoroutineDispatcher
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
internal abstract class ConnectorModelTestFixture {
    protected fun withModel(
        slug: String,
        configure: (ConnectorApiFixture) -> Unit = {},
        includeGrantExamples: Boolean = false,
        clock: TimeSource = TimeSource.Monotonic,
        exercise: suspend (ConnectorApiFixture, ConnectorModel) -> Unit,
    ) = runBlocking {
        ConnectorApiFixture(includeGrantExamples).use { fixture ->
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
                                                { true },
                                                clock = clock,
                                                snapshotClock = clock,
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

    protected suspend fun ConnectorModel.await(predicate: (ConnectorUiState) -> Boolean) =
        withTimeout(10.seconds) { uiState.first(predicate) }
}

@OptIn(ExperimentalCoroutinesApi::class)
internal class ConnectorModelTest : ConnectorModelTestFixture() {
    @Test
    fun catalogDenialClearsTheVisibleCategoryAndReportsUnavailable() =
        withModel(CONNECTOR_CALENDAR) { fixture, model ->
            val email = ConnectorBrowseFilter(null, "email")
            model.setFilter(email)
            model.await { it.browse.data != null && it.matches?.entries?.data != null }

            fixture.denyDefaultDiscovery = true
            model.resume()
            val unavailable = model.await { it.browse.failure == ConnectorReadFailure.Unavailable }
            assertEquals(email, unavailable.matches?.filter)
            assertNull(unavailable.matches?.entries?.data)
            assertEquals(ConnectorReadFailure.Unavailable, unavailable.matches?.entries?.failure)
        }

    @Test
    fun openContentSurvivesExpiryButReentryWithholdsExpiredScopes() {
        val clock = TestTimeSource()
        withModel(CONNECTOR_CALENDAR, clock = clock) { _, model ->
            model.showPermissions()
            model.await {
                it.browse.data != null && it.permissions.data != null && it.connected.data != null
            }

            model.pause()
            clock += 9.minutes
            model.setOpen(false)
            model.setOpen(true)
            model.showPermissions()
            val restored = model.uiState.value
            assertEquals(CONNECTOR_CALENDAR, restored.detail.data?.entry?.slug)
            assertTrue(restored.accountsFor(CONNECTOR_CALENDAR).isNotEmpty())
            assertFalse(restored.canChangeAccounts)
            assertTrue(restored.permissions.data?.isNotEmpty() == true)

            clock += 1.minutes
            assertEquals(restored, model.uiState.value)

            model.enterDirectoryTab(connected = false)
            assertNull(model.uiState.value.browse.data)
            assertEquals(restored.connected, model.uiState.value.connected)
            assertEquals(restored.detail, model.uiState.value.detail)

            model.hidePermissions()
            model.showPermissions()
            assertNull(model.uiState.value.permissions.data)
            model.setOpen(false)
            model.setOpen(true)
            val expired = model.uiState.value
            assertNull(expired.browse.data)
            assertNull(expired.connected.data)
            assertNull(expired.detail.data)
            assertTrue(expired.accountsFor(CONNECTOR_CALENDAR).isEmpty())

            model.resume()
            model.await {
                it.detail.data?.entry?.slug == CONNECTOR_CALENDAR && it.canChangeAccounts
            }
        }
    }

    @Test
    fun returningToDirectoryScopesRestoresResultsIncludingConfirmedEmpty() {
        val clock = TestTimeSource()
        withModel(CONNECTOR_CALENDAR, clock = clock) { _, model ->
            val email = ConnectorBrowseFilter(null, "email")
            val missing = ConnectorBrowseFilter("no matching service", null)
            model.setFilter(email)
            val emailResult = model.await { it.matches?.entries?.data != null }.matches
            model.setFilter(missing)
            model.await { it.matches?.filter == missing && it.matches.entries.data != null }

            model.pause()
            model.setFilter(email)
            assertEquals(emailResult, model.uiState.value.matches)
            model.setFilter(missing)
            assertEquals(
                emptyList<ConnectorEntry>(),
                model.uiState.value.matches?.entries?.data?.entries,
            )

            clock += 10.minutes
            assertEquals(
                emptyList<ConnectorEntry>(),
                model.uiState.value.matches?.entries?.data?.entries,
            )
            model.setFilter(email)
            assertNull(model.uiState.value.matches?.entries?.data)
            model.setFilter(missing)
            assertNull(model.uiState.value.matches?.entries?.data)
        }
    }

    @Test
    fun returningToAFreshFilterShowsItsMatchesWhileRevalidating() {
        withModel(CONNECTOR_CALENDAR) { fixture, model ->
            val email = ConnectorBrowseFilter(null, "email")
            model.setFilter(email)
            val cached = checkNotNull(model.await { it.matches?.entries?.data != null }.matches)
            val entries = checkNotNull(cached.entries.data).entries
            assertTrue(entries.isNotEmpty())
            model.setFilter(null)
            fixture.unavailableCatalogSlugs = entries.map { it.slug }.toSet()

            model.setFilter(email)
            assertEquals(cached, model.uiState.value.matches)
            val updated = model.await { it.matches?.entries?.data?.entries?.isEmpty() == true }
            assertEquals(email, updated.matches?.filter)
        }
    }

    @Test
    fun returningToServiceKeepsPermissionsAndUsesTheLatestAccountOverview() {
        withModel(CONNECTOR_CALENDAR) { fixture, model ->
            model.showPermissions()
            val first = model.await { it.permissions.data != null }
            model.select("slack")
            model.await { it.detail.data?.entry?.slug == "slack" }
            fixture.removeAccount(CONNECTOR_CALENDAR_PRIMARY)
            model.resume()
            model.await { it.connected.data?.get(CONNECTOR_CALENDAR)?.accounts?.size == 1 }

            fixture.failAccountReads = true
            fixture.accountRetryAfterSeconds = 0
            model.select(CONNECTOR_CALENDAR)
            val revisited = model.uiState.value
            assertEquals(first.detail.data, revisited.detail.data)
            assertEquals(first.permissions.data, revisited.permissions.data)
            assertNull(revisited.accounts.data)
            assertFalse(
                revisited.accountsFor(CONNECTOR_CALENDAR).any {
                    it.id == CONNECTOR_CALENDAR_PRIMARY
                },
            )
            assertEquals(1, revisited.accountsFor(CONNECTOR_CALENDAR).size)

            val refreshing = model.await { it.accounts.failureRound != null }
            assertEquals(first.permissions.data, refreshing.permissions.data)
            model.startAuthorization(null, "oauth", emptyMap())
            assertNull(model.uiState.value.action)

            fixture.failAccountReads = false
            model.resume()
            val retrying = model.uiState.value
            assertEquals(refreshing.accounts.failureRound, retrying.accounts.failureRound)
            assertEquals(refreshing.selectedAccountContent, retrying.selectedAccountContent)
            assertFalse(retrying.canChangeAccounts)
            val confirmed = model.await { it.canChangeAccounts }
            assertNull(confirmed.accounts.failureRound)
            assertEquals(1, confirmed.selectedAccountContent?.size)
        }
    }

    @Test
    fun unavailableCatalogDetailDiscardsRetainedMetadataAndPermissions() {
        withModel("gmail") { fixture, model ->
            model.showPermissions()
            model.await { it.permissions.data != null }
            model.select("slack")
            model.await { it.detail.data?.entry?.slug == "slack" }
            fixture.unavailableCatalogSlugs = setOf("gmail")

            model.select("gmail")
            assertEquals("gmail", model.uiState.value.detail.data?.entry?.slug)
            val unavailable = model.await { it.detail.failure != null }
            assertNull(unavailable.detail.data)
            assertNull(unavailable.permissions.data)

            model.select("slack")
            model.pause()
            model.select("gmail")
            assertNull(model.uiState.value.detail.data)
            assertNull(model.uiState.value.permissions.data)
            assertEquals(ConnectorReadFailure.Unavailable, model.uiState.value.detail.failure)
            assertEquals(ConnectorReadFailure.Unavailable, model.uiState.value.permissions.failure)
        }
    }

    @Test
    fun aFailedRenameLeavesAnInFlightDirectoryLoadRunning() {
        val releaseDiscovery = CountDownLatch(1)
        withModel(CONNECTOR_CALENDAR, configure = { it.discoveryGate = releaseDiscovery }) {
            fixture,
            model ->
            model.await { it.connected.data != null }
            fixture.loseRenameReply = true
            model.rename(CONNECTOR_CALENDAR_PRIMARY, "Meeting calendar")
            model.await { it.action?.busy == false && it.action.problem == ConnectorProblem.Failed }
            releaseDiscovery.countDown()

            val directory = model.await { it.browse.data != null }
            val confirmed =
                directory.accountsFor(CONNECTOR_CALENDAR).single {
                    it.id == CONNECTOR_CALENDAR_PRIMARY
                }
            assertEquals("工作日历", confirmed.displayName)

            model.resume()
            val refreshed = model.await {
                it.accountsFor(CONNECTOR_CALENDAR).any { account ->
                    account.id == CONNECTOR_CALENDAR_PRIMARY &&
                        account.displayName == "Meeting calendar"
                }
            }
            val renamed =
                refreshed.accountsFor(CONNECTOR_CALENDAR).single {
                    it.id == CONNECTOR_CALENDAR_PRIMARY
                }
            assertEquals("Meeting calendar", renamed.displayName)
            assertEquals(1, fixture.renameRequests.get())
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
                it.browse.data == null &&
                    it.accountsFor("slack").singleOrNull()?.status ==
                        ConnectorAccountStatus.Reauthorize
            }

            assertNull(model.uiState.value.browse.failure)
            fixture.removeAccount(CONNECTOR_SLACK_ACCOUNT)
            model.resume()

            val refreshed = model.await { it.connected.data?.containsKey("slack") == false }
            assertEquals(2, refreshed.accountsFor(CONNECTOR_CALENDAR).size)
        }

    @Test
    fun accountReadKeepsNewArtworkFromTheConnectedOverview() =
        withModel(CONNECTOR_CALENDAR) { fixture, model ->
            val current = model.await { it.connected.data?.containsKey(CONNECTOR_CALENDAR) == true }
            val previousIcon = checkNotNull(current.detail.data?.entry?.icon)
            val updatedAsset = "calendar-v2"
            fixture.icons = mapOf(CONNECTOR_CALENDAR to FixtureConnectorIcon(updatedAsset))
            model.enterDirectoryTab(connected = true)
            val updated = model.await {
                it.connected.data
                    ?.get(CONNECTOR_CALENDAR)
                    ?.entry
                    ?.icon
                    ?.url
                    ?.pathSegments
                    ?.last() == "$updatedAsset.svg"
            }
            val updatedIcon =
                checkNotNull(updated.connected.data?.get(CONNECTOR_CALENDAR)?.entry?.icon)

            val releaseDetail = CountDownLatch(1)
            fixture.detailReplyGate = releaseDetail
            try {
                model.select(null)
                model.select(CONNECTOR_CALENDAR)
                val readback = model.await { it.accounts.data != null }
                assertEquals(previousIcon, readback.detail.data?.entry?.icon)
                assertEquals(
                    updatedIcon,
                    readback.connected.data?.get(CONNECTOR_CALENDAR)?.entry?.icon,
                )
            } finally {
                releaseDetail.countDown()
            }
            model.await { it.detail.data?.entry?.icon == updatedIcon }
        }

    @Test
    fun refreshKeepsTheLastResultsAndClearsTheErrorWhenItSucceeds() {
        withModel(CONNECTOR_CALENDAR) { fixture, model ->
            val cached = model.await { it.browse.data != null }.browse.data
            fixture.discoveryRetryAfterSeconds = 0
            fixture.failDiscovery = true
            model.pause()
            model.resume()
            val first = model.await { it.browse.failureRound != null }.browse
            model.pause()
            model.resume()
            val second = model.await { it.browse.failureRound != first.failureRound }.browse
            assertEquals(first.failure, second.failure)
            assertTrue(checkNotNull(second.failureRound) > checkNotNull(first.failureRound))
            assertEquals(cached, second.data)
            model.pause()

            val requested = CountDownLatch(1)
            val release = CountDownLatch(1)
            fixture.discoveryRequested = requested
            fixture.discoveryGate = release
            fixture.failDiscovery = false
            model.resume()
            try {
                withContext(Dispatchers.IO) { assertTrue(requested.await(10, TimeUnit.SECONDS)) }
                val refreshing = model.uiState.value
                assertEquals(cached, refreshing.browse.data)
                assertEquals(second.failureRound, refreshing.browse.failureRound)
            } finally {
                release.countDown()
            }
            assertEquals(cached, model.await { it.browse.failureRound == null }.browse.data)
        }
    }

    @Test
    fun aNewColdReadClearsThePreviousFailureWhileItsResponseIsPending() =
        withModel(
            CONNECTOR_CALENDAR,
            configure = {
                it.discoveryRetryAfterSeconds = 0
                it.failDiscovery = true
            },
        ) { fixture, model ->
            assertNull(model.await { it.browse.failureRound != null }.browse.data)
            model.pause()
            val requested = CountDownLatch(1)
            val release = CountDownLatch(1)
            fixture.discoveryRequested = requested
            fixture.discoveryGate = release
            fixture.failDiscovery = false
            try {
                model.resume()
                withContext(Dispatchers.IO) { assertTrue(requested.await(10, TimeUnit.SECONDS)) }
                val pending = model.uiState.value.browse
                assertNull(pending.failure)
                assertNull(pending.data)
            } finally {
                release.countDown()
            }
            assertNull(model.await { it.browse.data != null }.browse.failureRound)
        }
}

@OptIn(ExperimentalCoroutinesApi::class)
internal class ConnectorAccountModelTest : ConnectorModelTestFixture() {
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
            val pending = model.await {
                it.action?.problem == ConnectorProblem.AuthorizationIncomplete
            }
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
    fun browserStartLaunchAndReceiptCheckUseTheOriginalAttempt() {
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
            assertTrue(requireNotNull(model.uiState.value.action).browserOpened)

            fixture.authorizeGmail()
            model.checkAuthorization()
            val confirmed = model.await { it.action?.result == ConnectorResult.Authorized }
            assertEquals(CONNECTOR_GMAIL_ACCOUNT, confirmed.action?.target?.connectionId)
        }
    }

    @Test
    fun aDeviceCodeAndItsProviderPageRemainUsableAfterForegrounding() {
        withModel(CONNECTOR_DEVICE_EXAMPLE, includeGrantExamples = true) { _, model ->
            model.startAuthorization(null, "device-auth", emptyMap())
            val ready = model.await {
                it.action?.busy == false && it.action.authorization is ConnectorAuthorization.Device
            }
            val attempt = ready.action?.authorization as ConnectorAuthorization.Device
            assertEquals(CONNECTOR_EXAMPLE_DEVICE_CODE, attempt.code)

            model.pause()
            model.resume()
            model.openBrowser { url ->
                assertEquals(CONNECTOR_AUTHORIZATION_URL, url.toString())
                true
            }
            val opened = requireNotNull(model.uiState.value.action)
            assertTrue(opened.browserOpened)
            assertEquals(attempt, opened.authorization)
        }
    }

    @Test
    fun deviceDenialEndsTheAttemptAndRequiresAnExplicitRestart() =
        expectTerminalDeviceResult("denied", ConnectorProblem.DeviceAuthorizationDenied) {
            fixture,
            model ->
            model.startAuthorization(null, "device-auth", emptyMap())
            model.await {
                it.action?.busy == false && it.action.authorization is ConnectorAuthorization.Device
            }
            assertEquals(2, fixture.deviceStartRequests.get())
            assertEquals(1, fixture.devicePollRequests.get())
        }

    @Test
    fun providerDeviceExpiryEndsTheAttemptWithAnExpiredCode() =
        expectTerminalDeviceResult("expired", ConnectorProblem.DeviceCodeExpired) { _, _ -> }

    @Test
    fun providerDeviceFailureEndsTheAttemptWithFailure() =
        expectTerminalDeviceResult("error", ConnectorProblem.DeviceAuthorizationFailed) { _, _ -> }

    private fun expectTerminalDeviceResult(
        status: String,
        expected: ConnectorProblem,
        afterResult: suspend (ConnectorApiFixture, ConnectorModel) -> Unit,
    ) =
        withModel(
            CONNECTOR_DEVICE_EXAMPLE,
            configure = {
                it.devicePollStatus = status
                it.devicePollInterval = 1
            },
            includeGrantExamples = true,
        ) { fixture, model ->
            model.startAuthorization(null, "device-auth", emptyMap())
            model.await {
                it.action?.busy == false && it.action.authorization is ConnectorAuthorization.Device
            }
            model.openBrowser { true }

            val action = requireNotNull(model.await { it.action?.problem == expected }.action)
            assertNull(action.authorization)
            assertFalse(action.browserOpened)
            assertEquals(1, fixture.deviceStartRequests.get())
            assertEquals(1, fixture.devicePollRequests.get())
            afterResult(fixture, model)
        }

    @Test
    fun localDeviceDeadlineEndsWaitingBeforeTheNextPoll() =
        withModel(
            CONNECTOR_DEVICE_EXAMPLE,
            configure = {
                it.deviceExpiresIn = 2
                it.devicePollInterval = 30
            },
            includeGrantExamples = true,
        ) { fixture, model ->
            model.startAuthorization(null, "device-auth", emptyMap())
            model.await {
                it.action?.busy == false && it.action.authorization is ConnectorAuthorization.Device
            }
            model.openBrowser { true }
            assertTrue(model.uiState.value.action?.browserOpened == true)

            val action =
                requireNotNull(
                    model.await { it.action?.problem == ConnectorProblem.DeviceCodeExpired }.action,
                )
            assertNull(action.authorization)
            assertEquals(0, fixture.devicePollRequests.get())
        }

    @Test
    fun unusedDeviceCodeExpiresWithoutOpeningOrPollingTheProvider() =
        withModel(
            CONNECTOR_DEVICE_EXAMPLE,
            configure = { it.deviceExpiresIn = 2 },
            includeGrantExamples = true,
        ) { fixture, model ->
            model.startAuthorization(null, "device-auth", emptyMap())
            model.await {
                it.action?.busy == false && it.action.authorization is ConnectorAuthorization.Device
            }

            val action =
                requireNotNull(
                    model.await { it.action?.problem == ConnectorProblem.DeviceCodeExpired }.action,
                )
            assertNull(action.authorization)
            model.openBrowser { error("An expired device code cannot open its provider") }
            assertEquals(ConnectorProblem.DeviceCodeExpired, model.uiState.value.action?.problem)
            assertEquals(0, fixture.devicePollRequests.get())
        }

    @Test
    fun reopeningAtTheDeadlineDoesNotDiscardAnInFlightDeviceCompletion() {
        val clock = TestTimeSource()
        val reply = CountDownLatch(1)
        withModel(
            CONNECTOR_DEVICE_EXAMPLE,
            configure = {
                it.devicePollInterval = 1
                it.deviceExpiresIn = 30
                it.devicePollStatus = "complete"
                it.devicePollReplyGate = reply
            },
            includeGrantExamples = true,
            clock = clock,
        ) { fixture, model ->
            try {
                model.startAuthorization(null, "device-auth", emptyMap())
                model.await {
                    it.action?.busy == false &&
                        it.action.authorization is ConnectorAuthorization.Device
                }
                model.openBrowser { true }
                withContext(Dispatchers.IO) {
                    assertTrue(fixture.devicePollReplyStarted.await(10, TimeUnit.SECONDS))
                }

                clock += 30.seconds
                model.openBrowser { error("An expired device code must not reopen the provider") }
                assertNull(model.uiState.value.action?.problem)
            } finally {
                reply.countDown()
            }

            val result = model.await { it.action?.result == ConnectorResult.Authorized }
            assertEquals(CONNECTOR_DEVICE_ACCOUNT, result.action?.target?.connectionId)
            assertEquals(ConnectorAccountStatus.Connected, result.accounts.data?.single()?.status)
            assertEquals(1, fixture.deviceStartRequests.get())
            assertEquals(1, fixture.devicePollRequests.get())
        }
    }

    @Test
    fun lostDeviceCompletionIsReadBackOnTheOriginalSessionAfterExpiry() =
        withLostPollAtDeadline("complete") { fixture, model ->
            val result = model.await { it.action?.result == ConnectorResult.Authorized }
            assertEquals(CONNECTOR_DEVICE_ACCOUNT, result.action?.target?.connectionId)
            assertEquals(ConnectorAccountStatus.Connected, result.accounts.data?.single()?.status)
            assertEquals(1, fixture.deviceStartRequests.get())
            assertEquals(2, fixture.devicePollRequests.get())
        }

    @Test
    fun unconfirmedDeviceCheckRetainsTheAttemptUntilAnExplicitTerminalResult() =
        withLostPollAtDeadline("pending") { fixture, model ->
            val verifying = model.await {
                it.action?.authorization is ConnectorAuthorization.DeviceVerification &&
                    it.action.problem == ConnectorProblem.VerificationPending &&
                    !it.action.busy &&
                    fixture.devicePollRequests.get() == 2
            }
            assertFalse(verifying.canChangeAccounts)
            model.openBrowser { error("An expired device code must not reopen the provider") }
            model.startAuthorization(null, "device-auth", emptyMap())
            assertEquals(1, fixture.deviceStartRequests.get())
            fixture.devicePollStatus = "denied"
            model.checkAuthorization()
            val ended = model.await {
                it.action?.problem == ConnectorProblem.DeviceAuthorizationDenied && !it.action.busy
            }
            assertNull(ended.action?.authorization)
            assertTrue(ended.canChangeAccounts)
            assertEquals(3, fixture.devicePollRequests.get())
        }

    private fun withLostPollAtDeadline(
        status: String,
        verify: suspend (ConnectorApiFixture, ConnectorModel) -> Unit,
    ) {
        val clock = TestTimeSource()
        val reply = CountDownLatch(1)
        withModel(
            CONNECTOR_DEVICE_EXAMPLE,
            configure = {
                it.devicePollInterval = 1
                it.deviceExpiresIn = 30
                it.devicePollStatus = status
                it.loseFirstDevicePollReply = true
                it.devicePollReplyGate = reply
            },
            includeGrantExamples = true,
            clock = clock,
        ) { fixture, model ->
            try {
                model.startAuthorization(null, "device-auth", emptyMap())
                model.await {
                    it.action?.busy == false &&
                        it.action.authorization is ConnectorAuthorization.Device
                }
                model.openBrowser { true }
                withContext(Dispatchers.IO) {
                    assertTrue(fixture.devicePollReplyStarted.await(10, TimeUnit.SECONDS))
                }
                clock += 30.seconds
            } finally {
                reply.countDown()
            }
            verify(fixture, model)
        }
    }

    @Test
    fun anUnsentRenameRemainsEditableAndRefreshingDoesNotSendIt() {
        withModel(CONNECTOR_CALENDAR) { fixture, model ->
            fixture.rejectConnection = true
            model.rename(CONNECTOR_CALENDAR_PRIMARY, "Meeting calendar")
            val failed = model.await {
                it.action?.problem == ConnectorProblem.Network && !it.action.busy
            }
            assertTrue(failed.canChangeAccounts)
            assertEquals(0, fixture.renameRequests.get())

            fixture.rejectConnection = false
            model.resume()
            assertEquals(0, fixture.renameRequests.get())
            model.rename(CONNECTOR_CALENDAR_PRIMARY, "Meeting calendar")
            model.await { it.action?.result == ConnectorResult.Renamed }
            assertEquals(1, fixture.renameRequests.get())
        }
    }

    @Test
    fun aDirectAuthorizationWithoutAReceiptRequiresAFreshAccountReadBeforeAnotherAttempt() {
        withModel(CONNECTOR_MANUAL_EXAMPLE, includeGrantExamples = true) { fixture, model ->
            fixture.failAccountReads = true
            fixture.loseManualReply = true
            val values = mapOf("workspace" to "example")
            model.startAuthorization(null, "manual", values)
            val pending = model.await {
                it.action?.problem == ConnectorProblem.AuthorizationUnconfirmed && !it.action.busy
            }
            assertNull(pending.action?.result)
            assertFalse(pending.canChangeAccounts)
            model.startAuthorization(null, "manual", values)
            model.dismissAction()
            model.startAuthorization(null, "manual", values)
            assertNull(model.uiState.value.action)
            assertEquals(1, fixture.manualRequests.get())

            fixture.failAccountReads = false
            model.resume()
            val refreshed = model.await { it.accounts.data?.isNotEmpty() == true }
            assertEquals(
                "Example workspace",
                refreshed.accountsFor(CONNECTOR_MANUAL_EXAMPLE).single().displayName,
            )
            assertNull(refreshed.action?.result)
            assertEquals(1, fixture.manualRequests.get())
        }
    }

    @Test
    fun aDelayedRenameUsesNormalSyncAfterFailure() =
        withModel(CONNECTOR_CALENDAR) { fixture, model ->
            val scopedRead = "/api/connector-accounts/connections" to CONNECTOR_CALENDAR
            val initialReads = fixture.chatConnectorReads.count { it == scopedRead }
            val initial = model.uiState.value.accounts.data
            fixture.deferRenameCommit = true
            model.rename(CONNECTOR_CALENDAR_PRIMARY, "Meeting calendar")
            val failed = model.await {
                it.action?.problem == ConnectorProblem.Failed && !it.action.busy
            }
            assertTrue(failed.canChangeAccounts)
            assertEquals(initial, failed.accounts.data)
            assertNull(failed.action?.result)
            assertEquals(initialReads, fixture.chatConnectorReads.count { it == scopedRead })
            assertEquals(1, fixture.renameRequests.get())

            fixture.commitDeferredRename()
            model.resume()
            val refreshed = model.await {
                it.accounts.data?.any { account ->
                    account.id == CONNECTOR_CALENDAR_PRIMARY &&
                        account.displayName == "Meeting calendar"
                } == true
            }
            assertEquals(ConnectorProblem.Failed, refreshed.action?.problem)
            assertNull(refreshed.action?.result)
            assertEquals(1, fixture.renameRequests.get())
        }

    @Test
    fun aLostDisconnectResponseKeepsTheAccountUntilNormalSync() =
        withModel(CONNECTOR_CALENDAR) { fixture, model ->
            val scopedRead = "/api/connector-accounts/connections" to CONNECTOR_CALENDAR
            val initialReads = fixture.chatConnectorReads.count { it == scopedRead }
            fixture.loseDisconnectReply = true
            model.prepareDisconnect(CONNECTOR_CALENDAR_PRIMARY)
            model.await { it.impact?.read?.data != null }
            model.disconnect(CONNECTOR_CALENDAR_PRIMARY)
            val failed = model.await {
                it.action?.problem == ConnectorProblem.Failed && !it.action.busy
            }
            assertTrue(failed.canChangeAccounts)
            assertTrue(
                failed.accountsFor(CONNECTOR_CALENDAR).any { it.id == CONNECTOR_CALENDAR_PRIMARY },
            )
            assertEquals(initialReads, fixture.chatConnectorReads.count { it == scopedRead })

            model.resume()
            val refreshed = model.await {
                it.accounts.data?.map { account -> account.id } ==
                    listOf(CONNECTOR_CALENDAR_SECONDARY)
            }
            assertNull(refreshed.action?.result)
            assertEquals(CONNECTOR_CALENDAR, refreshed.slug)
            assertEquals(1, fixture.disconnectRequests.get())
        }

    @Test
    fun renameReplyDoesNotPromoteTheOverviewToAnExactAccountReadAfterReselection() =
        withModel(CONNECTOR_CALENDAR) { fixture, model ->
            model.await { it.connected.data != null }
            val reply = CountDownLatch(1)
            fixture.renameReplyGate = reply
            try {
                model.rename(CONNECTOR_CALENDAR_PRIMARY, "Meeting calendar")
                fixture.failAccountReads = true
                model.select("slack")
                model.select(CONNECTOR_CALENDAR)
                model.await { it.accounts.failure != null }
            } finally {
                reply.countDown()
            }
            val renamed = model.await { it.action?.result == ConnectorResult.Renamed }
            assertNull(renamed.accounts.data)
            assertEquals(
                "Meeting calendar",
                renamed
                    .accountsFor(CONNECTOR_CALENDAR)
                    .first { it.id == CONNECTOR_CALENDAR_PRIMARY }
                    .displayName,
            )
        }
}
