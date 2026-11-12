package ai.okou.android

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.preferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class AppearanceModelTest {
    @get:Rule val files = TemporaryFolder()

    private suspend fun TestScope.withModel(
        store: DataStore<Preferences>,
        check: suspend TestScope.(AppearanceModel) -> Unit,
    ) {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val owner = ViewModelStore()
        try {
            val model =
                ViewModelProvider(
                    owner,
                    viewModelFactory { initializer { AppearanceModel(store) } },
                )[AppearanceModel::class.java]
            check(model)
        } finally {
            owner.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun delayedReadAndCommitObservationHaveExplicitPhases() = runTest {
        val store = TestPreferencesStore().apply { initialRead = CompletableDeferred() }
        withModel(store) { model ->
            runCurrent()
            assertEquals(AppearanceStatus.Loading, model.uiState.value.status)
            assertFalse(model.uiState.value.canSelect)
            store.initialRead.complete(Unit)
            runCurrent()
            assertEquals(
                AppearanceUiState(AppearanceMode.System, AppearanceStatus.Ready),
                model.uiState.value,
            )
            store.publishWrite = false
            model.selectMode(AppearanceMode.Dark)
            runCurrent()
            assertEquals(
                AppearanceStatus.AwaitingConfirmation(AppearanceMode.Dark),
                model.uiState.value.status,
            )
            assertFalse(model.uiState.value.canSelect)
            // An older observed mode must not make an intervening choice look already saved.
            model.selectMode(AppearanceMode.System)
            store.values.value = requireNotNull(store.pending)
            runCurrent()
            assertEquals(
                AppearanceUiState(AppearanceMode.Dark, AppearanceStatus.Ready),
                model.uiState.value,
            )
            store.publishWrite = true
            model.selectMode(AppearanceMode.System)
            runCurrent()
            assertEquals(
                AppearanceUiState(AppearanceMode.System, AppearanceStatus.Ready),
                model.uiState.value,
            )
        }
    }

    @Test
    fun readAndWriteFailuresRemainRecoverableAndDoNotClaimASave() = runTest {
        val store = TestPreferencesStore().apply { readFailure = true }
        withModel(store) { model ->
            runCurrent()
            assertEquals(AppearanceStatus.ReadFailed, model.uiState.value.status)
            store.readFailure = false
            model.retry()
            runCurrent()
            assertTrue(model.uiState.value.canSelect)
            store.writeFailure = true
            model.selectMode(AppearanceMode.Light)
            runCurrent()
            assertEquals(AppearanceMode.System, model.uiState.value.mode)
            assertEquals(
                AppearanceStatus.WriteFailed(AppearanceMode.Light),
                model.uiState.value.status,
            )
            store.writeFailure = false
            model.retry()
            runCurrent()
            assertEquals(
                AppearanceUiState(AppearanceMode.Light, AppearanceStatus.Ready),
                model.uiState.value,
            )
        }
    }

    @Test
    fun clearingOwnerCancelsPendingReadsWithoutPublishingFailure() = runTest {
        val store = TestPreferencesStore().apply { initialRead = CompletableDeferred() }
        lateinit var retired: AppearanceModel
        withModel(store) { model ->
            retired = model
            runCurrent()
        }
        store.values.value = preferencesOf(stringPreferencesKey("mode") to "dark")
        store.initialRead.complete(Unit)
        runCurrent()
        assertEquals(AppearanceStatus.Loading, retired.uiState.value.status)
    }

    @Test
    fun preferencesSurviveStorageAndPresentationOwnerRecreation() = runTest {
        val file = File(files.root, "appearance.preferences_pb")
        val diskJob = SupervisorJob()
        val store =
            PreferenceDataStoreFactory.create(
                scope = CoroutineScope(diskJob + StandardTestDispatcher(testScheduler)),
                produceFile = { file },
            )
        try {
            withModel(store) { model ->
                advanceUntilIdle()
                model.selectMode(AppearanceMode.Dark)
                advanceUntilIdle()
                assertEquals(
                    AppearanceUiState(AppearanceMode.Dark, AppearanceStatus.Ready),
                    model.uiState.value,
                )
            }
        } finally {
            diskJob.cancelAndJoin()
        }
        val reopenedJob = SupervisorJob()
        val reopened =
            PreferenceDataStoreFactory.create(
                scope = CoroutineScope(reopenedJob + StandardTestDispatcher(testScheduler)),
                produceFile = { file },
            )
        try {
            withModel(reopened) { model ->
                advanceUntilIdle()
                assertEquals(
                    AppearanceUiState(AppearanceMode.Dark, AppearanceStatus.Ready),
                    model.uiState.value,
                )
                model.selectMode(AppearanceMode.System)
                advanceUntilIdle()
                assertEquals(AppearanceMode.System, model.uiState.value.mode)
            }
        } finally {
            reopenedJob.cancelAndJoin()
        }
    }
}
