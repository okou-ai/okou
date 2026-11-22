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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class MemberPreferencesModelTest {
    private class Service :
        WorkspaceSession,
        ai.okou.android.chat.AssistantRecoveryService by ai.okou.android
            .TestAssistantRecoveryService(),
        ai.okou.android.chat.RealtimeService by ai.okou.android.TestRealtimeService(),
        ChatListService by TestChatService(),
        ai.okou.android.chat.ChatComposerService by ai.okou.android.TestChatComposerService() {
        override val artifacts: ArtifactService
            get() = error("Artifacts are outside this fixture")

        override suspend fun usagePackCredits(): ai.okou.android.api.generated.UsagePackCredits =
            error("Credits are outside this fixture")

        override suspend fun activateModelAccount(
            accountId: String
        ): ai.okou.android.api.generated.ActivatedModelAccount =
            error("Accounts are outside this fixture")

        override suspend fun sendControl(
            request: ai.okou.android.api.generated.SendRequest
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

    private fun check(
        service: Service = Service(),
        online: MutableStateFlow<Boolean> = MutableStateFlow(true),
        block: suspend TestScope.(MemberPreferencesModel, Service, ViewModelStore) -> Unit,
    ) = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            MemberPreferencesModel(service.stored, service, { true }, {}, online)
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
            model.refreshFromForeground()
            runCurrent()
            assertEquals(PreferenceStatus.SaveFailed, model.uiState.value.status)
            assertEquals(UserPreferencesColorTheme.BERRY_BLUSH, model.uiState.value.colorTheme)
            api.write = { request ->
                api.stored
                    .copy(
                        colorTheme =
                            UserPreferencesColorTheme.valueOf(
                                checkNotNull(request.colorTheme).name
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
                                    checkNotNull(request.colorTheme).name
                                )
                        )
                    throw IOException("response lost")
                }
            }
        check(service) { model, api, _ ->
            model.selectColorTheme(UserPreferencesColorTheme.DEEP_LAGOON)
            runCurrent()
            assertEquals(PreferenceStatus.SaveFailed, model.uiState.value.status)
            model.retry()
            runCurrent()
            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
            assertEquals(
                UserPreferencesColorTheme.DEEP_LAGOON,
                model.uiState.value.confirmed.colorTheme,
            )
            assertNull(model.uiState.value.pending)
            assertEquals(1, api.requests.size)
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
    fun timezoneConflictRetriesAfterReconnectAndPreservesLaterAppearanceChanges() {
        val online = MutableStateFlow(false)
        val service = Service()
        val save = service.write
        service.write = { request ->
            save(request)
            throw ApiFailure.Http(409, "CONFLICT", null, null)
        }
        check(service, online) { model, api, _ ->
            runCurrent()
            model.selectTheme(UserPreferencesTheme.DARK)
            model.selectTimezone("Asia/Tokyo")
            online.value = true
            runCurrent()
            assertEquals(PreferenceStatus.SaveFailed, model.uiState.value.status)
            assertEquals("Asia/Tokyo", api.stored.timezone)
            assertEquals(UserPreferencesTheme.DARK, api.stored.theme)

            api.stored = api.stored.copy(theme = UserPreferencesTheme.LIGHT)
            api.write = save
            online.value = false
            runCurrent()
            model.retry()
            runCurrent()
            assertEquals(1, api.requests.size)

            online.value = true
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
    fun offlineChoicesStayLocalUntilReconnectAndOnlyTheLastValueIsSent() {
        val online = MutableStateFlow(false)
        check(online = online) { model, api, _ ->
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

            online.value = true
            runCurrent()
            assertEquals(UserPreferencesTheme.LIGHT, model.uiState.value.confirmed.theme)
            assertEquals(UpdatePreferencesRequestTheme.LIGHT, api.requests.single().theme)
            assertEquals("Asia/Shanghai", api.requests.single().timezone)
            assertEquals("Asia/Shanghai", model.uiState.value.confirmed.timezone)
        }
    }

    @Test
    fun sharedAppearanceReadsCanonicalModeAndRetriesASave() =
        check(Service().apply { stored = stored.copy(theme = null) }) { model, api, _ ->
            assertEquals(UserPreferencesTheme.SYSTEM, model.uiState.value.theme)
            assertTrue(api.requests.isEmpty())

            api.stored = api.stored.copy(theme = UserPreferencesTheme.DARK)
            model.refreshFromForeground()
            runCurrent()
            assertEquals(UserPreferencesTheme.DARK, model.uiState.value.confirmed.theme)

            val save = api.write
            api.write = { throw IOException("offline") }
            model.selectTheme(UserPreferencesTheme.LIGHT)
            runCurrent()
            assertEquals(PreferenceStatus.SaveFailed, model.uiState.value.status)
            assertEquals(UserPreferencesTheme.LIGHT, model.uiState.value.theme)
            assertEquals(UserPreferencesTheme.DARK, model.uiState.value.confirmed.theme)
            assertEquals(
                UpdatePreferencesRequest(theme = UpdatePreferencesRequestTheme.LIGHT),
                api.requests.single(),
            )

            api.write = save
            model.retry()
            runCurrent()
            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
            assertEquals(UserPreferencesTheme.LIGHT, model.uiState.value.confirmed.theme)
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
