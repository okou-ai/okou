package ai.okou.android.chat

import ai.okou.android.auth.WorkspaceIdentity
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import androidx.lifecycle.viewModelScope
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ProjectExpansionModelTest {
    @Test
    fun retryRecoversBothFailedProjectWrites() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        var rejectWrites = true
        val dataStore =
            object : DataStore<Preferences> {
                override val data = MutableStateFlow(emptyPreferences())

                override suspend fun updateData(
                    transform: suspend (Preferences) -> Preferences
                ): Preferences {
                    if (rejectWrites) throw IOException("Storage unavailable")
                    return transform(data.value).also { data.value = it }
                }
            }
        val model =
            ProjectExpansionModel(
                ProjectExpansionStore(dataStore),
                WorkspaceIdentity("https://api.okou.ai/", "user-a", "session-a", "org-a"),
            )
        try {
            model.setExpanded("project-a", true)
            model.setExpanded("project-b", true)
            runCurrent()
            assertEquals(
                mapOf("project-a" to true, "project-b" to true),
                model.state.value.failedWrites,
            )
            assertEquals(emptySet<String>(), model.state.value.expandedIds)

            rejectWrites = false
            model.retry()
            runCurrent()
            assertEquals(setOf("project-a", "project-b"), model.state.value.expandedIds)
            assertEquals(emptyMap<String, Boolean>(), model.state.value.failedWrites)
        } finally {
            model.viewModelScope.cancel()
            runCurrent()
            Dispatchers.resetMain()
        }
    }
}
