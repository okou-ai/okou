package ai.okou.android.settings

import ai.okou.android.ChatListApiFixture
import ai.okou.android.SettingsApiFixture
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.EmailSubscription
import ai.okou.android.api.generated.EmailSubscriptionDeliveryStatus
import ai.okou.android.api.generated.EmailSubscriptionUpdate
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceSession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class EmailSubscriptionSettingsTest {
    @get:Rule val temporary = TemporaryFolder()
    private val notices = mutableListOf<SettingsNotice>()
    private val initial =
        EmailSubscription(
            false,
            SettingsApiFixture.emailAddress,
            EmailSubscriptionDeliveryStatus.AVAILABLE,
        )

    @Test
    fun quickDismissAndReentryStillReadsTheSubscription() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = SettingsApiFixture(api)
            val model = model(api)
            model.visible(true)
            model.visible(false)
            model.visible(true)
            assertEquals(initial, model.state.first { it.read.value != null }.read.value)
            assertEquals(1, fixture.emailReads.get())
        }
    }

    @Test
    fun onlyReadsWhenOpenedAndChecksAnAmbiguousHttpWriteWithoutRepeatingIt() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = SettingsApiFixture(api)
            val model = model(api)
            runCurrent()
            assertEquals(0, fixture.emailReads.get())
            assertNull(model.state.value.checked)

            model.visible(true)
            assertEquals(initial, model.state.first { it.read.value != null }.read.value)
            fixture.emailWriteStatus = 503
            fixture.applySubscriptionBeforeError = true
            model.subscribe(true)
            assertEquals(true, model.state.value.checked)
            assertEquals(initial, model.state.value.read.value)
            val confirmed = model.state.first { it.read.value?.subscribed == true }
            assertNull(confirmed.desired)
            assertEquals(listOf(true), fixture.emailWrites)
            assertEquals(2, fixture.emailReads.get())
            assertTrue(notices.isEmpty())
        }
    }

    @Test
    fun pendingToggleDisablesFurtherWritesAndCanFinishAfterThePanelCloses() = runTest {
        ChatListApiFixture().use { api ->
            val writes = mutableListOf<Boolean>()
            val release = CompletableDeferred<Unit>()
            var server = initial
            val service =
                object : WorkspaceSession by api.service {
                    override suspend fun emailSubscription() = server

                    override suspend fun updateEmailSubscription(
                        subscribed: Boolean,
                    ): EmailSubscriptionUpdate {
                        writes += subscribed
                        if (subscribed) release.await()
                        server = server.copy(subscribed = subscribed)
                        return EmailSubscriptionUpdate(subscribed)
                    }
                }
            val model = model(api, service)
            model.visible(true)
            runCurrent()
            model.subscribe(true)
            runCurrent()
            assertEquals(true, model.state.value.checked)
            assertFalse(model.state.value.canChange)
            model.subscribe(false)
            assertEquals(true, model.state.value.checked)
            assertEquals(listOf(true), writes)

            model.visible(false)
            release.complete(Unit)
            runCurrent()
            assertEquals(listOf(true), writes)
            assertEquals(initial.copy(subscribed = true), server)
            assertNull(model.state.value.desired)
            assertTrue(model.state.value.canChange)
            assertTrue(notices.isEmpty())
        }
    }

    @Test
    fun rejectedToggleRollsBackAndReportsFailureWhereTheUserIs() = runTest {
        ChatListApiFixture().use { api ->
            var release = CompletableDeferred<Unit>()
            val service =
                object : WorkspaceSession by api.service {
                    override suspend fun emailSubscription() = initial

                    override suspend fun updateEmailSubscription(subscribed: Boolean): Nothing {
                        release.await()
                        throw ApiFailure.Http(400, null, null, null)
                    }
                }
            val model = model(api, service)
            model.setPanelOpen(true)
            model.visible(true)
            runCurrent()

            model.subscribe(true)
            runCurrent()
            release.complete(Unit)
            runCurrent()
            assertEquals(false, model.state.value.checked)
            assertTrue(model.state.value.canChange)
            assertTrue(model.state.value.updateFailed)
            assertTrue(notices.isEmpty())

            model.setPanelOpen(false)
            model.visible(false)
            assertFalse(model.state.value.updateFailed)
            assertTrue(notices.isEmpty())

            model.setPanelOpen(true)
            model.visible(true)
            runCurrent()
            release = CompletableDeferred()
            model.subscribe(true)
            runCurrent()
            model.setPanelOpen(false)
            model.visible(false)
            release.complete(Unit)
            runCurrent()
            assertEquals(false, model.state.value.checked)
            assertTrue(model.state.value.canChange)
            assertFalse(model.state.value.updateFailed)
            assertEquals(listOf(SettingsNotice.EmailSubscriptionFailed), notices)
        }
    }

    @Test
    fun aLostWriteAndFailedReadbackDoNotPermitAnotherWriteUntilRecovered() = runTest {
        ChatListApiFixture().use { api ->
            var failReads = false
            var writes = 0
            val service =
                object : WorkspaceSession by api.service {
                    override suspend fun emailSubscription(): EmailSubscription {
                        if (failReads) throw ApiFailure.Http(503, null, null, null)
                        return initial
                    }

                    override suspend fun updateEmailSubscription(
                        subscribed: Boolean,
                    ): EmailSubscriptionUpdate {
                        writes++
                        failReads = true
                        throw ApiFailure.Http(503, null, null, null)
                    }
                }
            val model = model(api, service)
            model.visible(true)
            runCurrent()
            model.subscribe(true)
            runCurrent()
            advanceTimeBy(6_000)
            runCurrent()
            assertFalse(model.state.value.canChange)
            assertEquals(true, model.state.value.checked)
            assertEquals(initial, model.state.value.read.value)
            assertEquals(listOf(SettingsNotice.EmailSubscriptionUnconfirmed), notices)
            model.subscribe(false)
            runCurrent()
            assertEquals(1, writes)

            model.visible(false)
            failReads = false
            model.visible(true)
            runCurrent()
            assertTrue(model.state.value.canChange)
            assertEquals(false, model.state.value.checked)
            assertEquals(
                listOf(
                    SettingsNotice.EmailSubscriptionUnconfirmed,
                    SettingsNotice.EmailSubscriptionFailed,
                ),
                notices,
            )
            assertEquals(1, writes)
        }
    }

    @Test
    fun restoresOnlyTheSameAccountAcrossWorkspacesAndKeepsStaleStateBetweenRetries() = runTest {
        ChatListApiFixture().use { api ->
            val path = temporary.newFolder().resolve("settings.preferences_pb")
            val cache = WorkspaceSettingsCache.create(backgroundScope) { path }
            cache.saveEmail(api.identity, ConfirmedSetting(initial, 1L))
            val otherWorkspace =
                api.identity.copy(workspaceId = "workspace-b", sessionId = "session-b")
            assertEquals(initial, cache.loadEmail(otherWorkspace)?.value)
            assertNull(cache.loadEmail(otherWorkspace.copy(userId = "other-account")))
            assertNull(
                cache.loadEmail(otherWorkspace.copy(apiOrigin = "https://another.example.com/")),
            )
            val reads = mutableListOf<Long>()
            var readFailure = 503
            val service =
                object : WorkspaceSession by api.service {
                    override suspend fun emailSubscription(): EmailSubscription {
                        reads += testScheduler.currentTime
                        throw ApiFailure.Http(readFailure, null, null, null)
                    }
                }
            val model = model(api, service, otherWorkspace, cache) { 600_002L }
            model.visible(true)
            assertEquals(initial, model.state.first { it.read.value != null }.read.value)
            runCurrent()
            assertTrue(model.state.value.read.refreshing)
            advanceTimeBy(5_999)
            runCurrent()
            assertEquals(listOf(0L, 3_000L), reads)
            assertTrue(model.state.value.read.refreshing)
            assertEquals(initial, model.state.value.read.value)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(listOf(0L, 3_000L, 6_000L), reads)
            assertTrue(model.state.value.read.unavailable)
            assertFalse(model.state.value.read.refreshing)
            assertEquals(initial, model.state.value.read.value)
            model.visible(false)
            readFailure = 403
            model.visible(true)
            runCurrent()
            assertTrue(model.state.value.read.initialFailure)
            assertNull(model.state.value.checked)
            assertNull(cache.loadEmail(otherWorkspace))
        }
    }

    @Test
    fun retiredOwnerCannotPublishALateRecipientAndSuppressedDeliveryCannotBeToggled() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = SettingsApiFixture(api)
            fixture.emailDelivery = "suppressed"
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val delayed =
                object : WorkspaceSession by api.service {
                    override suspend fun emailSubscription(): EmailSubscription {
                        entered.complete(Unit)
                        withContext(NonCancellable) { release.await() }
                        return initial
                    }
                }
            var authorized = true
            val retired = model(api, delayed, authorized = { authorized })
            retired.visible(true)
            entered.await()
            authorized = false
            release.complete(Unit)
            runCurrent()
            assertNull(retired.state.value.read.value)

            val active = model(api)
            active.visible(true)
            val loaded = active.state.first { it.read.value != null }
            assertEquals(
                EmailSubscriptionDeliveryStatus.SUPPRESSED,
                loaded.read.value?.deliveryStatus,
            )
            assertFalse(loaded.canChange)
            active.subscribe(true)
            runCurrent()
            assertTrue(fixture.emailWrites.isEmpty())
        }
    }

    private fun TestScope.model(
        api: ChatListApiFixture,
        service: WorkspaceSession = api.service,
        identity: WorkspaceIdentity = api.identity,
        cache: WorkspaceSettingsCache? = null,
        authorized: () -> Boolean = { true },
        nowMillis: () -> Long = { testScheduler.currentTime },
    ) =
        EmailSubscriptionSettings(
            this,
            service,
            identity,
            cache,
            authorized,
            {},
            nowMillis,
            notices::add,
        )
}
