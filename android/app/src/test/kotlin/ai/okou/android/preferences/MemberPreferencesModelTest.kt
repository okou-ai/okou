package ai.okou.android.preferences

import ai.okou.android.TestChatService
import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesSupportedLocalesItem
import ai.okou.android.auth.WorkspaceBootstrap
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.chat.ChatListService
import ai.okou.android.testBootstrap
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
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class MemberPreferencesModelTest {
    private class Service : WorkspaceSession, ChatListService by TestChatService() {
        var stored = testBootstrap().preferences
        val requests = mutableListOf<UpdatePreferencesRequest>()
        var load: suspend () -> UserPreferences = { stored }
        var write: suspend (UpdatePreferencesRequest) -> UserPreferences = { request ->
            stored =
                stored.copy(
                    colorTheme =
                        request.colorTheme?.let { UserPreferencesColorTheme.valueOf(it.name) }
                            ?: stored.colorTheme,
                    locale =
                        request.locale?.let { UserPreferencesLocale.valueOf(it.name) }
                            ?: stored.locale,
                )
            stored
        }

        override suspend fun bootstrap() = WorkspaceBootstrap(testBootstrap().organization, stored)

        override suspend fun preferences() = load()

        override suspend fun updatePreferences(update: UpdatePreferencesRequest): UserPreferences {
            requests += update
            return write(update)
        }

        override fun close() = Unit
    }

    private fun check(
        service: Service = Service(),
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
                            MemberPreferencesModel(service.stored, service, { true }, {})
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
    fun heldSavePreviewsTheLocaleButDoesNotConfirmOrOverlapARefresh() {
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
            assertEquals(PreferenceStatus.Saving, model.uiState.value.status)
            gate.complete(Unit)
            runCurrent()
            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
            assertEquals(UserPreferencesLocale.ZH_HANT, model.uiState.value.confirmed.locale)
            assertNull(api.requests.single().colorTheme)
            assertNull(api.requests.single().theme)
            assertNull(api.requests.single().timezone)
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
            model.refresh()
            runCurrent()
            assertEquals(PreferenceStatus.Ready, model.uiState.value.status)
            assertEquals(
                UserPreferencesColorTheme.DEEP_LAGOON,
                model.uiState.value.confirmed.colorTheme,
            )
            assertNull(model.uiState.value.pending)
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
            model.retry()
            runCurrent()
            assertTrue(api.requests.isEmpty())
        }
    }
}
