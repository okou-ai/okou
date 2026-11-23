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
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ProjectExpansionModelTest {
    private val identity = WorkspaceIdentity("https://api.okou.ai/", "user-a", "session-a", "org-a")

    @Test
    fun retriesSaveTheLatestChoicesForTwoProjects() = runTest {
        val preferences = ControlledPreferences().apply { rejectWrites = true }
        val store = ProjectExpansionStore(preferences)
        withModel(store) { model ->
            model.toggle("project-a")
            model.toggle("project-b")
            assertEquals(setOf("project-a", "project-b"), model.state.value.expandedIds)
            runCurrent()
            assertEquals(2, preferences.writeAttempts)
            assertFalse(model.state.value.writeFailed)

            model.toggle("project-a")
            assertEquals(setOf("project-b"), model.state.value.expandedIds)
            advanceTimeBy(2_999)
            runCurrent()
            assertEquals(2, preferences.writeAttempts)

            preferences.rejectWrites = false
            advanceTimeBy(1)
            runCurrent()
            assertEquals(4, preferences.writeAttempts)
            assertEquals(setOf("project-b"), model.state.value.expandedIds)
            assertEquals(setOf("project-b"), store.observe(identity).first())
            assertFalse(model.state.value.writeFailed)
        }
    }

    @Test
    fun exhaustedSaveKeepsTheVisibleChoiceAndAllowsAnotherToggle() = runTest {
        val preferences = ControlledPreferences().apply { rejectWrites = true }
        val store = ProjectExpansionStore(preferences)
        withModel(store) { model ->
            model.toggle("project-a")
            runCurrent()
            advanceTimeBy(5_999)
            runCurrent()
            assertEquals(2, preferences.writeAttempts)
            assertFalse(model.state.value.writeFailed)
            advanceTimeBy(1)
            runCurrent()
            assertTrue(model.state.value.writeFailed)
            assertEquals(setOf("project-a"), model.state.value.expandedIds)
            assertEquals(emptySet<String>(), store.observe(identity).first())
            advanceTimeBy(12_000)
            runCurrent()
            assertEquals(3, preferences.writeAttempts)

            preferences.rejectWrites = false
            model.toggle("project-a")
            runCurrent()
            assertEquals(emptySet<String>(), model.state.value.expandedIds)
            assertFalse(model.state.value.writeFailed)
        }
    }

    @Test
    fun aNewChoiceSurvivesAnOlderWriteThatWasAlreadyInFlight() = runTest {
        val preferences = ControlledPreferences()
        val store = ProjectExpansionStore(preferences)
        withModel(store) { model ->
            runCurrent()
            val write = CompletableDeferred<Unit>()
            preferences.writeBarrier = write
            model.toggle("project-a")
            runCurrent()
            assertEquals(setOf("project-a"), model.state.value.expandedIds)
            model.toggle("project-a")
            assertEquals(emptySet<String>(), model.state.value.expandedIds)
            runCurrent()
            assertEquals(1, preferences.writeAttempts)

            write.complete(Unit)
            runCurrent()
            assertEquals(2, preferences.writeAttempts)
            assertEquals(emptySet<String>(), model.state.value.expandedIds)
            assertEquals(emptySet<String>(), store.observe(identity).first())
        }
    }

    @Test
    fun readRetriesKeepConfirmedExpansionAndRecoverBeforeReportingFailure() = runTest {
        val preferences = ControlledPreferences()
        val store = ProjectExpansionStore(preferences)
        store.setExpanded(identity, "project-a", true)
        withModel(store) { model ->
            runCurrent()
            preferences.rejectReads.value = true
            runCurrent()
            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(2, preferences.readAttempts)
            assertFalse(model.state.value.readFailed)
            assertEquals(setOf("project-a"), model.state.value.expandedIds)

            preferences.rejectReads.value = false
            store.setExpanded(identity, "project-b", true)
            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(3, preferences.readAttempts)
            assertEquals(setOf("project-a", "project-b"), model.state.value.expandedIds)
            assertFalse(model.state.value.readFailed)
        }
    }

    @Test
    fun anExhaustedReadPreservesTheVisibleChoicesUntilAPostSaveReadSucceeds() = runTest {
        val preferences = ControlledPreferences().apply { rejectReads.value = true }
        val store = ProjectExpansionStore(preferences)
        withModel(store) { model ->
            runCurrent()
            advanceTimeBy(6_000)
            runCurrent()
            assertEquals(3, preferences.readAttempts)
            assertTrue(model.state.value.readFailed)
            assertEquals(null, model.state.value.expandedIds)

            preferences.rejectReads.value = false
            val readback = CompletableDeferred<Unit>()
            preferences.readBarrier = readback
            model.toggle("project-a")
            runCurrent()
            assertEquals(setOf("project-a"), model.state.value.expandedIds)
            assertTrue(model.state.value.readFailed)
            store.setExpanded(identity, "project-a", false)
            runCurrent()
            readback.complete(Unit)
            runCurrent()
            assertEquals(emptySet<String>(), model.state.value.expandedIds)
            assertFalse(model.state.value.readFailed)
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
        var writeBarrier: CompletableDeferred<Unit>? = null
        val rejectReads = MutableStateFlow(false)
        var rejectWrites = false
        var readAttempts = 0
            private set

        var writeAttempts = 0
            private set

        override val data = flow {
            readAttempts++
            emitAll(
                combine(persisted, rejectReads) { preferences, reject ->
                        if (reject) throw IOException("Storage unavailable")
                        preferences
                    }
                    .mapLatest { preferences ->
                        readBarrier?.await()
                        preferences
                    },
            )
        }

        override suspend fun updateData(
            transform: suspend (Preferences) -> Preferences,
        ): Preferences {
            writeAttempts++
            writeBarrier?.await()
            if (rejectWrites) throw IOException("Storage unavailable")
            return transform(persisted.value).also { persisted.value = it }
        }
    }
}
