package ai.okou.android.chat

import ai.okou.android.auth.WorkspaceIdentity
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import androidx.lifecycle.viewModelScope
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ProjectExpansionModelTest {
    private val identity = WorkspaceIdentity("https://api.okou.ai/", "user-a", "session-a", "org-a")

    @Test
    fun retryRecoversBothFailedProjectWrites() = runTest {
        val preferences = ControlledPreferences().apply { rejectWrites = true }
        withModel(ProjectExpansionStore(preferences)) { model ->
            model.setExpanded("project-a", true)
            model.setExpanded("project-b", true)
            runCurrent()
            assertEquals(
                mapOf("project-a" to true, "project-b" to true),
                model.state.value.failedWrites,
            )
            assertEquals(emptySet<String>(), model.state.value.expandedIds)

            preferences.rejectWrites = false
            model.retry()
            runCurrent()
            assertEquals(setOf("project-a", "project-b"), model.state.value.expandedIds)
            assertEquals(emptyMap<String, Boolean>(), model.state.value.failedWrites)
        }
    }

    @Test
    fun repeatedActionWaitsForReadbackEvenWhenAnotherOwnerSupersedesTheWrite() = runTest {
        val preferences = ControlledPreferences()
        val store = ProjectExpansionStore(preferences)
        withModel(store) { model ->
            runCurrent()
            val readback = CompletableDeferred<Unit>()
            preferences.readBarrier = readback
            model.setExpanded("project-a", true)
            runCurrent()
            assertEquals(emptySet<String>(), model.state.value.expandedIds)

            preferences.rejectWrites = true
            model.setExpanded("project-a", true)
            runCurrent()
            assertEquals(emptyMap<String, Boolean>(), model.state.value.failedWrites)

            preferences.rejectWrites = false
            store.setExpanded(identity, "project-a", false)
            runCurrent()
            readback.complete(Unit)
            runCurrent()
            assertEquals(emptySet<String>(), model.state.value.expandedIds)

            model.setExpanded("project-a", true)
            runCurrent()
            assertEquals(setOf("project-a"), model.state.value.expandedIds)

            preferences.rejectWrites = true
            model.setExpanded("project-a", true)
            runCurrent()
            assertEquals(emptyMap<String, Boolean>(), model.state.value.failedWrites)
        }
    }

    private suspend fun TestScope.withModel(
        store: ProjectExpansionStore,
        exercise: suspend (ProjectExpansionModel) -> Unit,
    ) {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val model = ProjectExpansionModel(store, identity)
        try {
            exercise(model)
        } finally {
            model.viewModelScope.cancel()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    private class ControlledPreferences : DataStore<Preferences> {
        private val persisted = MutableStateFlow(emptyPreferences())
        var readBarrier: CompletableDeferred<Unit>? = null
        var rejectWrites = false

        override val data =
            persisted.mapLatest { preferences ->
                readBarrier?.await()
                preferences
            }

        override suspend fun updateData(
            transform: suspend (Preferences) -> Preferences
        ): Preferences {
            if (rejectWrites) throw IOException("Storage unavailable")
            return transform(persisted.value).also { persisted.value = it }
        }
    }
}
