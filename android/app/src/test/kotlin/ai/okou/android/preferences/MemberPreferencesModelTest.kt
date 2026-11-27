package ai.okou.android.preferences

import ai.okou.android.TestChatService
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UpdatePreferencesRequestTheme
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesSupportedLocalesItem
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.artifacts.ArtifactService
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.chat.ChatListService
import ai.okou.android.testOrganization
import ai.okou.android.testPreferences
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class MemberPreferencesModelTest {
    internal class Service :
        WorkspaceSession,
        ai.okou.android.chat.AssistantRecoveryService by ai.okou.android
            .TestAssistantRecoveryService(),
        ai.okou.android.chat.RealtimeService by ai.okou.android.TestRealtimeService(),
        ChatListService by TestChatService(),
        ai.okou.android.chat.WorkspaceSearchService by ai.okou.android.EmptyWorkspaceSearchService,
        ai.okou.android.chat.ChatComposerService by ai.okou.android.TestChatComposerService() {
        override val artifacts: ArtifactService
            get() = error("Artifacts are outside this fixture")

        override suspend fun usagePackCredits(): ai.okou.android.api.generated.UsagePackCredits =
            error("Credits are outside this fixture")

        override suspend fun defaultModelPreference():
            ai.okou.android.api.generated.DefaultModelPreference =
            error("Default model is outside this fixture")

        override suspend fun featureSwitches(): ai.okou.android.api.generated.FeatureSwitches =
            error("Feature switches are outside this fixture")

        override suspend fun updateDefaultModelPreference(
            update: ai.okou.android.api.generated.UpdateDefaultModelPreference,
        ): ai.okou.android.api.generated.DefaultModelPreference =
            error("Default model is outside this fixture")

        override suspend fun activateModelAccount(
            accountId: String,
        ): ai.okou.android.api.generated.ActivatedModelAccount =
            error("Accounts are outside this fixture")

        override suspend fun emailSubscription(): ai.okou.android.api.generated.EmailSubscription =
            error("Email subscriptions are outside this fixture")

        override suspend fun updateEmailSubscription(
            subscribed: Boolean,
        ): ai.okou.android.api.generated.EmailSubscriptionUpdate =
            error("Email subscriptions are outside this fixture")

        override suspend fun sendControl(
            request: ai.okou.android.api.generated.SendRequest,
        ): ai.okou.android.api.generated.AcceptedInput = error("No control backend in this fixture")

        override suspend fun personalInstructions():
            ai.okou.android.api.generated.PersonalInstructions =
            error("Instructions are not enabled in this fixture")

        override suspend fun updatePersonalInstructions(
            content: String,
            ifVersion: String,
        ): ai.okou.android.api.generated.PersonalInstructions =
            error("Instructions are not enabled in this fixture")

        var stored = testPreferences()
        val requests = mutableListOf<UpdatePreferencesRequest>()
        var load: suspend () -> UserPreferences = { stored }
        var write: suspend (UpdatePreferencesRequest) -> UserPreferences = { request ->
            stored =
                stored.copy(
                    theme =
                        request.theme?.let { UserPreferencesTheme.valueOf(it.name) }
                            ?: stored.theme,
                    colorTheme =
                        request.colorTheme?.let { UserPreferencesColorTheme.valueOf(it.name) }
                            ?: stored.colorTheme,
                    locale =
                        request.locale?.let { UserPreferencesLocale.valueOf(it.name) }
                            ?: stored.locale,
                    timezone = request.timezone ?: stored.timezone,
                    cloudBrowserEnabledByDefault =
                        request.cloudBrowserEnabledByDefault ?: stored.cloudBrowserEnabledByDefault,
                )
            stored
        }

        override suspend fun organization() = testOrganization()

        override suspend fun preferences() = load()

        override suspend fun updatePreferences(update: UpdatePreferencesRequest): UserPreferences {
            requests += update
            return write(update)
        }

        override fun close() = Unit
    }

    @Test
    fun preferenceRefreshKeepsConfirmedDataThroughTwoRetries() {
        check { model, service, _ ->
            Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
            val confirmed = model.uiState.value.confirmed
            val attempts = mutableListOf<Long>()
            service.load = {
                attempts += currentTime
                val retryAfter = if (attempts.size == 1) 0L else null
                throw ApiFailure.Http(503, null, null, retryAfter)
            }
            val started = currentTime
            model.refresh()
            runCurrent()
            assertEquals(listOf(started, started), attempts)
            advanceTimeBy(3_000)
            assertEquals(listOf(started, started), attempts)
            assertEquals(PreferenceStatus.Refreshing, model.uiState.value.status)
            assertEquals(confirmed, model.uiState.value.confirmed)

            runCurrent()
            assertEquals(listOf(started, started, started + 3_000), attempts)
            assertEquals(PreferenceStatus.RefreshFailed, model.uiState.value.status)
            assertEquals(confirmed, model.uiState.value.confirmed)
            advanceTimeBy(60_000)
            assertEquals(3, attempts.size)

            service.load = { confirmed.copy(locale = UserPreferencesLocale.JA_JP) }
            model.refresh()
            runCurrent()
            assertEquals(UserPreferencesLocale.JA_JP, model.uiState.value.confirmed.locale)
        }
    }

    @Test
    fun absentPaletteAndUnavailableSavedLocaleHaveDisplayDefaultsWithoutAWrite() {
        val service =
            Service().apply {
                stored =
                    stored.copy(
                        colorTheme = null,
                        locale = UserPreferencesLocale.JA_JP,
                        supportedLocales = listOf(UserPreferencesSupportedLocalesItem.EN_US),
                    )
            }
        check(service) { model, api, _ ->
            runCurrent()
            assertEquals(UserPreferencesColorTheme.DEFAULT, model.uiState.value.colorTheme)
            assertEquals(UserPreferencesLocale.EN_US, model.uiState.value.locale)
            assertNull(model.uiState.value.confirmed.colorTheme)
            model.selectLocale(UserPreferencesLocale.ZH_HANT)
            runCurrent()
            assertTrue(api.requests.isEmpty())
            assertEquals(UserPreferencesLocale.JA_JP, api.stored.locale)
        }
    }

    @Test
    fun missingServerTimezoneCanConfirmTheExistingLocalZone() = check { model, api, _ ->
        val timezone = model.uiState.value.timezone
        model.selectTimezone(timezone)
        runCurrent()
        assertTrue(api.requests.isEmpty())

        model.selectTimezone(timezone, missingOnServer = true)
        runCurrent()
        assertEquals(listOf(timezone), api.requests.map { it.timezone })
        assertEquals(timezone, model.uiState.value.confirmed.timezone)
        assertEquals(1L, model.uiState.value.timezoneConfirmation)
    }

    @Test
    fun rejectedTimezoneRestoresTheConfirmedValueAndAllowsAnotherSelection() =
        check { model, api, _ ->
            val confirmed = model.uiState.value.timezone
            val save = api.write
            api.write = { throw ApiFailure.Http(400, "BAD_REQUEST", null, null) }
            model.selectTimezone("Asia/Tokyo")
            assertEquals("Asia/Tokyo", model.uiState.value.timezone)
            runCurrent()

            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
            assertEquals(confirmed, model.uiState.value.timezone)
            assertNull(model.uiState.value.pending)
            assertEquals(listOf("Asia/Tokyo"), api.requests.map { it.timezone })

            api.write = save
            model.selectTimezone("Asia/Shanghai")
            runCurrent()
            assertEquals("Asia/Shanghai", api.stored.timezone)
            assertNull(model.uiState.value.pending)
        }

    @Test
    fun rejectionOfAnOlderTimezonePreservesNewerChoicesAndSendsThem() = check { model, api, _ ->
        val release = CompletableDeferred<Unit>()
        val save = api.write
        api.write = { update ->
            if (update.timezone == "Asia/Tokyo") {
                release.await()
                throw ApiFailure.Http(400, "BAD_REQUEST", null, null)
            }
            save(update)
        }
        model.selectTimezone("Asia/Tokyo")
        runCurrent()
        model.selectTimezone("Asia/Shanghai")
        model.selectTheme(UserPreferencesTheme.DARK)
        release.complete(Unit)
        runCurrent()

        assertEquals(
            listOf(
                UpdatePreferencesRequest(timezone = "Asia/Tokyo"),
                UpdatePreferencesRequest(
                    timezone = "Asia/Shanghai",
                    theme = UpdatePreferencesRequestTheme.DARK,
                ),
            ),
            api.requests,
        )
        assertEquals("Asia/Shanghai", api.stored.timezone)
        assertEquals(UserPreferencesTheme.DARK, api.stored.theme)
        assertNull(model.uiState.value.pending)
    }

    @Test
    fun rejectedTimezonePreservesThePreviousScheduleRepair() = check { model, api, _ ->
        val save = api.write
        api.write = { update ->
            save(update)
            throw ApiFailure.Http(409, "CONFLICT", null, null)
        }
        model.selectTimezone("Asia/Tokyo")
        runCurrent()
        assertEquals("Asia/Tokyo", model.uiState.value.confirmed.timezone)
        assertEquals(PreferenceStatus.SaveFailed, model.uiState.value.status)

        api.write = { update ->
            if (update.timezone == "Asia/Shanghai") {
                throw ApiFailure.Http(400, "BAD_REQUEST", null, null)
            }
            save(update)
        }
        model.selectTimezone("Asia/Shanghai")
        runCurrent()

        assertEquals(
            listOf("Asia/Tokyo", "Asia/Shanghai", "Asia/Tokyo"),
            api.requests.map { it.timezone },
        )
        assertEquals("Asia/Tokyo", model.uiState.value.timezone)
        assertNull(model.uiState.value.pending)
    }

    @Test
    fun heldSaveKeepsTheLatestChoicesAndSerializesTheNextPatch() {
        val gate = CompletableDeferred<Unit>()
        val service =
            Service().apply {
                val apply = write
                write = {
                    gate.await()
                    apply(it)
                }
            }
        check(service) { model, api, _ ->
            model.selectLocale(UserPreferencesLocale.ZH_HANT)
            runCurrent()
            assertEquals(PreferenceStatus.Saving, model.uiState.value.status)
            assertEquals(UserPreferencesLocale.ZH_HANT, model.uiState.value.locale)
            assertEquals(UserPreferencesLocale.EN_US, model.uiState.value.confirmed.locale)
            model.refresh()
            model.selectColorTheme(UserPreferencesColorTheme.BERRY_BLUSH)
            val cloudBrowser = !api.stored.cloudBrowserEnabledByDefault
            model.setCloudBrowser(cloudBrowser)
            model.selectLocale(UserPreferencesLocale.JA_JP)
            model.selectLocale(UserPreferencesLocale.ZH_HANS)
            assertEquals(PreferenceStatus.Saving, model.uiState.value.status)
            assertEquals(UserPreferencesLocale.ZH_HANS, model.uiState.value.locale)
            assertEquals(cloudBrowser, model.uiState.value.cloudBrowser)
            assertEquals(1, api.requests.size)
            gate.complete(Unit)
            runCurrent()
            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
            assertEquals(UserPreferencesLocale.ZH_HANS, model.uiState.value.confirmed.locale)
            assertEquals(
                UserPreferencesColorTheme.BERRY_BLUSH,
                model.uiState.value.confirmed.colorTheme,
            )
            assertEquals(2, api.requests.size)
            assertEquals(cloudBrowser, model.uiState.value.confirmed.cloudBrowserEnabledByDefault)
            assertEquals(cloudBrowser, api.requests.last().cloudBrowserEnabledByDefault)
            assertNull(api.requests.first().colorTheme)
            assertNull(api.requests.last().theme)
            assertNull(api.requests.last().timezone)
        }
    }

    @Test
    fun failureRetainsIntentAndAnExplicitSecondFieldMergesWithoutWritingAppearance() {
        val service = Service().apply { write = { throw IOException("offline") } }
        check(service) { model, api, _ ->
            model.selectColorTheme(UserPreferencesColorTheme.BERRY_BLUSH)
            runCurrent()
            assertEquals(PreferenceStatus.SaveFailed, model.uiState.value.status)
            assertEquals(UserPreferencesColorTheme.BERRY_BLUSH, model.uiState.value.colorTheme)
            assertEquals(
                UserPreferencesColorTheme.DEFAULT,
                model.uiState.value.confirmed.colorTheme,
            )
            model.foreground(true)
            runCurrent()
            assertEquals(PreferenceStatus.SaveFailed, model.uiState.value.status)
            assertEquals(UserPreferencesColorTheme.BERRY_BLUSH, model.uiState.value.colorTheme)
            api.write = { request ->
                api.stored
                    .copy(
                        colorTheme =
                            UserPreferencesColorTheme.valueOf(
                                checkNotNull(request.colorTheme).name,
                            ),
                        locale = UserPreferencesLocale.valueOf(checkNotNull(request.locale).name),
                    )
                    .also { api.stored = it }
            }
            model.selectLocale(UserPreferencesLocale.JA_JP)
            runCurrent()
            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
            assertEquals(UserPreferencesLocale.JA_JP, model.uiState.value.locale)
            assertEquals(
                UserPreferencesColorTheme.BERRY_BLUSH,
                model.uiState.value.confirmed.colorTheme,
            )
            assertNull(api.requests.last().theme)
            assertNull(model.uiState.value.pending)
        }
    }

    @Test
    fun retryOrCanonicalReadbackResolvesAWriteWhoseResponseWasLost() {
        val service =
            Service().apply {
                write = { request ->
                    stored =
                        stored.copy(
                            colorTheme =
                                UserPreferencesColorTheme.valueOf(
                                    checkNotNull(request.colorTheme).name,
                                ),
                        )
                    throw IOException("response lost")
                }
            }
        check(service) { model, api, _ ->
            val reads = mutableListOf<Long>()
            api.load = {
                reads += currentTime
                if (reads.size == 1) throw ApiFailure.Http(429, null, null, 1L)
                api.stored
            }
            model.selectColorTheme(UserPreferencesColorTheme.DEEP_LAGOON)
            runCurrent()
            assertEquals(PreferenceStatus.SaveFailed, model.uiState.value.status)
            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(listOf(3_000L), reads)
            val enabled = !api.stored.cloudBrowserEnabledByDefault
            api.write = { request ->
                api.stored
                    .copy(
                        cloudBrowserEnabledByDefault =
                            checkNotNull(request.cloudBrowserEnabledByDefault),
                    )
                    .also { api.stored = it }
            }
            advanceTimeBy(400)
            model.setCloudBrowser(enabled)
            model.retry()
            advanceTimeBy(599)
            runCurrent()
            assertEquals(listOf(3_000L), reads)
            assertEquals(1, api.requests.size)
            assertEquals(enabled, model.uiState.value.cloudBrowser)

            advanceTimeBy(1)
            runCurrent()
            assertEquals(listOf(3_000L, 4_000L), reads)
            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
            assertEquals(
                UserPreferencesColorTheme.DEEP_LAGOON,
                model.uiState.value.confirmed.colorTheme,
            )
            assertNull(model.uiState.value.pending)
            assertEquals(2, api.requests.size)
            assertNull(api.requests.last().colorTheme)
            assertEquals(enabled, model.uiState.value.confirmed.cloudBrowserEnabledByDefault)
            api.write = { throw IOException("offline") }
            model.selectLocale(UserPreferencesLocale.JA_JP)
            runCurrent()
            api.write = {
                api.stored.copy(locale = UserPreferencesLocale.JA_JP).also { api.stored = it }
            }
            model.retry()
            runCurrent()
            assertEquals(UserPreferencesLocale.JA_JP, model.uiState.value.confirmed.locale)
            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
        }
    }

    @Test
    fun retryReadsTheCanonicalPreferenceWhenTheSaveResponseCannotBeDecoded() {
        val service =
            Service().apply {
                val commit = write
                write = { request ->
                    commit(request)
                    throw ApiFailure.IncompatibleResponse()
                }
            }
        check(service) { model, api, _ ->
            model.selectColorTheme(UserPreferencesColorTheme.DEEP_LAGOON)
            runCurrent()
            assertEquals(PreferenceStatus.SaveFailed, model.uiState.value.status)
            assertEquals(UserPreferencesColorTheme.DEEP_LAGOON, model.uiState.value.colorTheme)

            model.retry()
            runCurrent()

            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
            assertEquals(
                UserPreferencesColorTheme.DEEP_LAGOON,
                model.uiState.value.confirmed.colorTheme,
            )
            assertNull(model.uiState.value.pending)
            assertEquals(1, api.requests.size)
        }
    }

    @Test
    fun timezoneConflictRetriesAndPreservesLaterAppearanceChanges() {
        val service = Service()
        val save = service.write
        service.write = { request ->
            save(request)
            throw ApiFailure.Http(409, "CONFLICT", null, null)
        }
        check(service) { model, api, _ ->
            val read = CompletableDeferred<Unit>()
            api.load = {
                read.await()
                api.stored
            }
            model.refresh()
            runCurrent()
            model.selectTheme(UserPreferencesTheme.DARK)
            model.selectTimezone("Asia/Tokyo")
            read.complete(Unit)
            runCurrent()
            assertEquals(PreferenceStatus.SaveFailed, model.uiState.value.status)
            assertEquals("Asia/Tokyo", api.stored.timezone)
            assertEquals(UserPreferencesTheme.DARK, api.stored.theme)

            api.stored = api.stored.copy(theme = UserPreferencesTheme.LIGHT)
            api.write = save
            model.retry()
            runCurrent()

            assertEquals(
                listOf(
                    UpdatePreferencesRequest(
                        timezone = "Asia/Tokyo",
                        theme = UpdatePreferencesRequestTheme.DARK,
                    ),
                    UpdatePreferencesRequest(timezone = "Asia/Tokyo"),
                ),
                api.requests,
            )
            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
            assertEquals(UserPreferencesTheme.LIGHT, model.uiState.value.confirmed.theme)
            assertNull(model.uiState.value.pending)
        }
    }

    @Test
    fun newerTimezoneSavesAfterAnEarlierScheduleConflict() = check { model, api, _ ->
        val release = CompletableDeferred<Unit>()
        val save = api.write
        api.write = { update ->
            if (update.timezone == "Asia/Tokyo") {
                release.await()
                save(update)
                throw ApiFailure.Http(409, "CONFLICT", null, null)
            }
            save(update)
        }
        model.selectTimezone("Asia/Tokyo")
        runCurrent()
        model.selectTimezone("Asia/Seoul")
        model.selectTimezone("Asia/Shanghai")
        release.complete(Unit)
        runCurrent()

        assertEquals(
            listOf("Asia/Tokyo", "Asia/Shanghai"),
            api.requests.map { it.timezone },
        )
        assertEquals("Asia/Shanghai", api.stored.timezone)
        assertEquals("Asia/Shanghai", model.uiState.value.confirmed.timezone)
        assertNull(model.uiState.value.pending)
    }

    @Test
    fun queuedAppearanceSavesWithoutRepeatingAnObsoleteTimezone() {
        check { model, api, _ ->
            val release = CompletableDeferred<Unit>()
            val readback = CompletableDeferred<Unit>()
            api.load = {
                readback.await()
                api.stored
            }
            val save = api.write
            api.write = { update ->
                if (update.timezone == "Asia/Tokyo") {
                    release.await()
                    save(update)
                    throw ApiFailure.Http(409, "CONFLICT", null, null)
                }
                save(update)
            }
            model.selectTimezone("Asia/Tokyo")
            runCurrent()
            model.selectTheme(UserPreferencesTheme.DARK)
            release.complete(Unit)
            runCurrent()
            assertEquals(1, api.requests.size)
            assertEquals("Asia/Tokyo", model.uiState.value.confirmed.timezone)

            api.stored = api.stored.copy(timezone = "Asia/Shanghai")
            readback.complete(Unit)
            runCurrent()

            assertEquals(
                listOf(
                    UpdatePreferencesRequest(timezone = "Asia/Tokyo"),
                    UpdatePreferencesRequest(theme = UpdatePreferencesRequestTheme.DARK),
                ),
                api.requests,
            )
            assertEquals("Asia/Shanghai", model.uiState.value.timezone)
            assertEquals(UserPreferencesTheme.DARK, api.stored.theme)
            assertNull(model.uiState.value.pending)
        }
    }

    @Test
    fun timezoneConflictRetryRespectsANewerSavedTimezone() {
        val service = Service()
        val save = service.write
        service.write = { request ->
            save(request)
            throw ApiFailure.Http(409, "CONFLICT", null, null)
        }
        check(service) { model, api, _ ->
            model.selectTimezone("Asia/Tokyo")
            runCurrent()
            assertEquals(PreferenceStatus.SaveFailed, model.uiState.value.status)

            api.stored = api.stored.copy(timezone = "Asia/Shanghai")
            api.write = save
            model.retry()
            runCurrent()

            assertEquals(listOf(UpdatePreferencesRequest(timezone = "Asia/Tokyo")), api.requests)
            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
            assertEquals("Asia/Shanghai", model.uiState.value.timezone)
            assertNull(model.uiState.value.pending)
        }
    }

    @Test
    fun lostTimezoneWriteResponseRetriesTheScheduleAfterReadingTheSavedValue() {
        val service = Service()
        val save = service.write
        service.write = { request ->
            save(request)
            throw IOException("response lost before schedule confirmation")
        }
        check(service) { model, api, _ ->
            model.selectTimezone("Asia/Tokyo")
            runCurrent()
            assertEquals(PreferenceStatus.SaveFailed, model.uiState.value.status)
            assertEquals("Asia/Tokyo", api.stored.timezone)

            api.write = save
            model.retry()
            runCurrent()

            val update = UpdatePreferencesRequest(timezone = "Asia/Tokyo")
            assertEquals(listOf(update, update), api.requests)
            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
            assertNull(model.uiState.value.pending)
        }
    }

    @Test
    fun choicesQueuedDuringAReadOnlySendTheLastValue() {
        check { model, api, _ ->
            val read = CompletableDeferred<Unit>()
            api.load = {
                read.await()
                api.stored
            }
            model.refresh()
            runCurrent()
            model.selectTheme(UserPreferencesTheme.DARK)
            model.selectTheme(UserPreferencesTheme.LIGHT)
            model.selectTimezone("Asia/Tokyo")
            model.selectTimezone("Asia/Shanghai")
            runCurrent()
            assertEquals(UserPreferencesTheme.LIGHT, model.uiState.value.theme)
            assertEquals("Asia/Shanghai", model.uiState.value.timezone)
            assertEquals("UTC", model.uiState.value.confirmed.timezone)
            assertTrue(api.requests.isEmpty())

            read.complete(Unit)
            runCurrent()
            assertEquals(UserPreferencesTheme.LIGHT, model.uiState.value.confirmed.theme)
            assertEquals(UpdatePreferencesRequestTheme.LIGHT, api.requests.single().theme)
            assertEquals("Asia/Shanghai", api.requests.single().timezone)
            assertEquals("Asia/Shanghai", model.uiState.value.confirmed.timezone)
        }
    }

    @Test
    fun exhaustedLocaleSaveUsesTwoThreeSecondRetriesAndRestoresConfirmedLocale() =
        check { model, api, _ ->
            val confirmed = model.uiState.value.locale
            val events = mutableListOf<Pair<String, Long>>()
            api.load = {
                events += "read" to currentTime
                api.stored
            }
            api.write = {
                events += "write" to currentTime
                throw IOException("request outcome unknown")
            }
            model.selectLocale(UserPreferencesLocale.JA_JP)
            runCurrent()
            advanceTimeBy(5_999)
            runCurrent()
            assertEquals(UserPreferencesLocale.JA_JP, model.uiState.value.locale)
            assertEquals(listOf("write" to 0L, "read" to 3_000L, "write" to 3_000L), events)

            advanceTimeBy(1)
            runCurrent()
            assertEquals(
                listOf(
                    "write" to 0L,
                    "read" to 3_000L,
                    "write" to 3_000L,
                    "read" to 6_000L,
                    "write" to 6_000L,
                    "read" to 6_000L,
                ),
                events,
            )
            assertEquals(confirmed, model.uiState.value.locale)
            assertNull(model.uiState.value.pending)
            val notice = model.notices.value.single() as PreferenceSaveNotice.Rejected
            assertTrue(notice.rolledBack)
            assertFalse(notice.keptAppearance)
            advanceTimeBy(60_000)
            runCurrent()
            assertEquals(3, api.requests.size)
        }

    @Test
    fun unconfirmedSaveWaitsForAuthoritativeReadWithoutReplayingTheWrite() =
        check { model, api, _ ->
            val save = api.write
            api.write = { request ->
                save(request)
                throw IOException("response lost")
            }
            api.load = { throw IOException("cannot confirm") }
            model.setCloudBrowser(true)
            runCurrent()
            advanceTimeBy(6_000)
            runCurrent()
            assertEquals(PreferenceStatus.SaveUnconfirmed, model.uiState.value.status)
            assertTrue(model.uiState.value.cloudBrowser)
            assertNull(model.pendingForWorkspaceRestore())
            assertTrue(model.notices.value.single() is PreferenceSaveNotice.Unconfirmed)

            api.load = { api.stored }
            model.foreground(true)
            runCurrent()
            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
            assertTrue(model.uiState.value.confirmed.cloudBrowserEnabledByDefault)
            assertNull(model.uiState.value.pending)
            assertTrue(model.notices.value.isEmpty())
            assertEquals(1, api.requests.size)
        }

    @Test
    fun sharedAppearanceReadsCanonicalModeAndKeepsLocalModeOnRejection() =
        check(Service().apply { stored = stored.copy(theme = null) }) { model, api, _ ->
            assertEquals(UserPreferencesTheme.SYSTEM, model.uiState.value.theme)
            assertTrue(api.requests.isEmpty())

            api.stored = api.stored.copy(theme = UserPreferencesTheme.DARK)
            model.refresh()
            runCurrent()
            assertEquals(UserPreferencesTheme.DARK, model.uiState.value.confirmed.theme)

            val save = api.write
            api.write = { throw ApiFailure.Http(400, "BAD_REQUEST", null, null) }
            model.selectTheme(UserPreferencesTheme.LIGHT)
            runCurrent()
            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
            assertEquals(UserPreferencesTheme.LIGHT, model.uiState.value.localSnapshot.theme)
            assertEquals(UserPreferencesTheme.DARK, model.uiState.value.confirmed.theme)
            assertNull(model.uiState.value.pending)
            val notice = model.notices.value.single() as PreferenceSaveNotice.Rejected
            assertFalse(notice.rolledBack)
            assertTrue(notice.keptAppearance)
            assertEquals(
                UpdatePreferencesRequest(theme = UpdatePreferencesRequestTheme.LIGHT),
                api.requests.single(),
            )

            api.write = save
            model.selectLocale(UserPreferencesLocale.JA_JP)
            runCurrent()
            assertNull(api.requests.last().theme)
            assertEquals(UserPreferencesTheme.LIGHT, model.uiState.value.theme)
            model.refresh()
            runCurrent()
            assertEquals(UserPreferencesTheme.DARK, model.uiState.value.theme)
        }

    @Test
    fun retiredOwnerRejectsNonCooperativeLateReadAndOldUiActions() {
        val gate = CompletableDeferred<Unit>()
        val service =
            Service().apply {
                load = {
                    withContext(NonCancellable) { gate.await() }
                    stored.copy(locale = UserPreferencesLocale.JA_JP)
                }
            }
        check(service) { model, api, store ->
            model.refresh()
            runCurrent()
            store.clear()
            gate.complete(Unit)
            runCurrent()
            assertEquals(UserPreferencesLocale.EN_US, model.uiState.value.confirmed.locale)
            model.selectColorTheme(UserPreferencesColorTheme.GOLDEN_HOUR)
            model.selectTheme(UserPreferencesTheme.DARK)
            model.retry()
            runCurrent()
            assertTrue(api.requests.isEmpty())
        }
    }
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class MemberPreferencesRefreshTest {
    @Test
    fun lostScheduleRepairResponseDoesNotRestoreAnObsoleteTimezone() = check { model, service, _ ->
        val commit = service.write
        service.write = { request ->
            commit(request)
            throw ApiFailure.Http(409, "CONFLICT", null, null)
        }
        model.selectTimezone("Asia/Tokyo")
        runCurrent()
        assertTrue(model.uiState.value.timezoneScheduleUpdatePending)

        service.write = { throw IOException("repair response lost") }
        model.retry()
        runCurrent()
        assertEquals(2, service.requests.size)

        service.stored = service.stored.copy(timezone = "Asia/Shanghai")
        service.write = commit
        advanceTimeBy(3_000)
        runCurrent()

        assertEquals(2, service.requests.size)
        assertEquals("Asia/Shanghai", service.stored.timezone)
        assertEquals("Asia/Shanghai", model.uiState.value.timezone)
        assertNull(model.uiState.value.pending)
    }

    @Test
    fun staleReadbackKeepsTheLatestSwitchChoice() = check { model, service, _ ->
        service.stored = service.stored.copy(cloudBrowserEnabledByDefault = false)
        model.refresh()
        runCurrent()
        val firstWrite = CompletableDeferred<Unit>()
        val commit = service.write
        var delayed: UpdatePreferencesRequest? = null
        service.write = { request ->
            if (request.cloudBrowserEnabledByDefault == true) {
                firstWrite.await()
                delayed = request
                throw IOException("response lost")
            }
            commit(request)
        }
        service.load = {
            val before = service.stored
            // The first write commits after the read takes its snapshot.
            delayed?.let { commit(it) }
            before
        }

        model.setCloudBrowser(true)
        runCurrent()
        model.setCloudBrowser(false)
        assertFalse(model.uiState.value.cloudBrowser)
        firstWrite.complete(Unit)
        runCurrent()
        advanceTimeBy(3_000)
        runCurrent()

        assertEquals(listOf(true, false), service.requests.map { it.cloudBrowserEnabledByDefault })
        assertFalse(service.stored.cloudBrowserEnabledByDefault)
        assertFalse(model.uiState.value.confirmed.cloudBrowserEnabledByDefault)
        assertNull(model.uiState.value.pending)
    }

    @Test
    fun overdueRefreshRunsOnResumeAndWaitsUntilTheSettingsVisitEnds() = check { model, service, _ ->
        val attempts = mutableListOf<Long>()
        service.load = {
            attempts += currentTime
            service.stored
        }
        model.foreground(true)
        advanceTimeBy(599_999)
        runCurrent()
        assertTrue(attempts.isEmpty())

        model.foreground(false)
        advanceTimeBy(10_001)
        assertTrue(attempts.isEmpty())
        model.foreground(true)
        runCurrent()
        assertEquals(listOf(610_000L), attempts)

        model.showSettings(true)
        advanceTimeBy(600_000)
        model.showSettings(true)
        model.foreground(false)
        model.foreground(true)
        runCurrent()
        assertEquals(listOf(610_000L), attempts)
        model.showSettings(false)
        runCurrent()
        assertEquals(listOf(610_000L, 1_210_000L), attempts)

        advanceTimeBy(600_000)
        runCurrent()
        assertEquals(listOf(610_000L, 1_210_000L, 1_810_000L), attempts)
    }

    @Test
    fun lateReadCannotPublishAndDueRefreshWaitsForThePendingWrite() = check { model, service, _ ->
        val readGate = CompletableDeferred<Unit>()
        val writeGate = CompletableDeferred<Unit>()
        var reads = 0
        service.load = {
            if (++reads == 1) {
                withContext(NonCancellable) { readGate.await() }
                service.stored.copy(locale = UserPreferencesLocale.JA_JP)
            } else service.stored
        }
        val persist = service.write
        service.write = { update ->
            writeGate.await()
            persist(update)
        }
        model.foreground(true)
        advanceTimeBy(600_000)
        runCurrent()
        assertEquals(1, reads)

        model.showSettings(true)
        model.setCloudBrowser(true)
        model.showSettings(false)
        runCurrent()
        assertTrue(model.uiState.value.cloudBrowser)
        assertTrue(service.requests.isEmpty())
        readGate.complete(Unit)
        runCurrent()
        assertEquals(UserPreferencesLocale.EN_US, model.uiState.value.locale)
        assertEquals(1, service.requests.size)
        assertEquals(1, reads)
        writeGate.complete(Unit)
        runCurrent()
        assertEquals(2, reads)
        assertTrue(model.uiState.value.confirmed.cloudBrowserEnabledByDefault)
    }

    @Test
    fun settingsEntryCancelsTheRetryWaitAndRetirementStopsTheNextRead() =
        check { model, service, store ->
            var reads = 0
            service.load = {
                reads++
                throw ApiFailure.Http(503, null, null, retryAfterSeconds = 1)
            }
            model.foreground(true)
            advanceTimeBy(600_000)
            runCurrent()
            assertEquals(1, reads)
            model.showSettings(true)
            advanceTimeBy(1_000)
            runCurrent()
            assertEquals(1, reads)
            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)

            service.load = { service.stored.also { reads++ } }
            model.showSettings(false)
            runCurrent()
            assertEquals(2, reads)
            store.clear()
            advanceTimeBy(600_000)
            runCurrent()
            assertEquals(2, reads)
        }

    @Test
    fun automaticRefreshKeepsItsRetryTimingAndBudgetAcrossPauses() = check { model, service, _ ->
        val attempts = mutableListOf<Long>()
        service.load = {
            attempts += currentTime
            when (attempts.size) {
                1 -> throw ApiFailure.Http(429, null, null, retryAfterSeconds = 30)
                2,
                3 -> throw IOException("offline")
                else -> service.stored
            }
        }
        model.foreground(true)
        advanceTimeBy(600_000)
        runCurrent()
        assertEquals(listOf(600_000L), attempts)

        model.showSettings(true)
        model.setCloudBrowser(true)
        runCurrent()
        assertTrue(model.uiState.value.confirmed.cloudBrowserEnabledByDefault)
        advanceTimeBy(1_000)
        model.showSettings(false)
        runCurrent()
        advanceTimeBy(28_999)
        runCurrent()
        assertEquals(listOf(600_000L), attempts)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf(600_000L, 630_000L), attempts)

        model.foreground(false)
        advanceTimeBy(1_000)
        model.foreground(true)
        runCurrent()
        advanceTimeBy(1_999)
        runCurrent()
        assertEquals(listOf(600_000L, 630_000L), attempts)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(PreferenceStatus.RefreshFailed, model.uiState.value.status)

        advanceTimeBy(599_999)
        runCurrent()
        assertEquals(listOf(600_000L, 630_000L, 633_000L), attempts)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf(600_000L, 630_000L, 633_000L, 1_233_000L), attempts)
        assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
    }

    @Test
    fun dueForegroundRefreshVerifiesAnUnconfirmedWriteWithoutResubmittingIt() =
        check { model, service, _ ->
            val save = service.write
            service.write = {
                save(it)
                throw IOException("response lost")
            }
            var reads = 0
            service.load = {
                reads++
                throw IOException("cannot confirm")
            }
            model.foreground(true)
            model.showSettings(true)
            model.setCloudBrowser(true)
            runCurrent()
            advanceTimeBy(6_000)
            runCurrent()
            assertEquals(PreferenceStatus.SaveUnconfirmed, model.uiState.value.status)
            val readsBeforeExit = reads

            model.showSettings(false)
            advanceTimeBy(599_999)
            runCurrent()
            assertEquals(readsBeforeExit, reads)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(readsBeforeExit + 1, reads)
            assertEquals(PreferenceStatus.SaveUnconfirmed, model.uiState.value.status)

            service.load = { service.stored.also { reads++ } }
            advanceTimeBy(600_000)
            runCurrent()
            assertEquals(readsBeforeExit + 2, reads)
            assertEquals(1, service.requests.size)
            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
            assertTrue(model.uiState.value.confirmed.cloudBrowserEnabledByDefault)
            assertNull(model.uiState.value.pending)
        }

    @Test
    fun foregroundRefreshContinuesWhileTimezoneScheduleRepairWaitsForRetry() =
        check { model, service, _ ->
            val save = service.write
            service.write = { update ->
                save(update)
                throw ApiFailure.Http(409, "CONFLICT", null, null)
            }
            model.foreground(true)
            model.showSettings(true)
            model.selectTimezone("Asia/Tokyo")
            runCurrent()
            assertEquals(PreferenceStatus.SaveFailed, model.uiState.value.status)
            model.showSettings(false)

            service.load = { throw IOException("offline") }
            advanceTimeBy(606_000)
            runCurrent()
            assertEquals(PreferenceStatus.SaveFailed, model.uiState.value.status)
            assertTrue(model.uiState.value.timezoneScheduleUpdatePending)
            assertEquals(1, service.requests.size)

            service.load = { service.stored }
            service.stored = service.stored.copy(cloudBrowserEnabledByDefault = true)
            advanceTimeBy(600_000)
            runCurrent()
            assertTrue(model.uiState.value.confirmed.cloudBrowserEnabledByDefault)
            assertTrue(model.uiState.value.timezoneScheduleUpdatePending)
            assertEquals(PreferenceStatus.SaveFailed, model.uiState.value.status)
            assertEquals(1, service.requests.size)

            service.stored = service.stored.copy(timezone = "Asia/Shanghai")
            advanceTimeBy(600_000)
            runCurrent()
            assertEquals("Asia/Shanghai", model.uiState.value.timezone)
            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
            assertNull(model.uiState.value.pending)
            assertEquals(1, service.requests.size)
        }

    @Test
    fun cancelledRefreshKeepsTimezoneScheduleRepairAvailableToRetry() = check { model, service, _ ->
        val save = service.write
        service.write = { update ->
            save(update)
            throw ApiFailure.Http(409, "CONFLICT", null, null)
        }
        model.foreground(true)
        model.showSettings(true)
        model.selectTimezone("Asia/Tokyo")
        runCurrent()
        model.showSettings(false)

        val lateRead = CompletableDeferred<Unit>()
        var reads = 0
        service.load = {
            if (++reads == 1) {
                withContext(NonCancellable) { lateRead.await() }
                service.stored.copy(timezone = "Asia/Shanghai")
            } else service.stored
        }
        advanceTimeBy(600_000)
        runCurrent()
        assertEquals(1, reads)

        model.showSettings(true)
        assertEquals(PreferenceStatus.SaveFailed, model.uiState.value.status)
        assertTrue(model.uiState.value.timezoneScheduleUpdatePending)
        service.write = save
        model.retry()
        assertEquals(1, service.requests.size)
        lateRead.complete(Unit)
        runCurrent()

        assertEquals(2, reads)
        assertEquals(listOf("Asia/Tokyo", "Asia/Tokyo"), service.requests.map { it.timezone })
        assertEquals("Asia/Tokyo", model.uiState.value.timezone)
        assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
        assertNull(model.uiState.value.pending)
    }
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
private fun check(
    service: MemberPreferencesModelTest.Service = MemberPreferencesModelTest.Service(),
    block:
        suspend TestScope.(
            MemberPreferencesModel,
            MemberPreferencesModelTest.Service,
            ViewModelStore,
        ) -> Unit,
) = runTest {
    Dispatchers.setMain(StandardTestDispatcher(testScheduler))
    val store = ViewModelStore()
    try {
        val model =
            ViewModelProvider(
                store,
                viewModelFactory {
                    initializer {
                        MemberPreferencesModel(
                            service.stored,
                            service,
                            { true },
                            {},
                            monotonicMillis = { testScheduler.currentTime },
                        )
                    }
                },
            )[MemberPreferencesModel::class.java]
        block(model, service, store)
    } finally {
        store.clear()
        runCurrent()
        Dispatchers.resetMain()
    }
}
