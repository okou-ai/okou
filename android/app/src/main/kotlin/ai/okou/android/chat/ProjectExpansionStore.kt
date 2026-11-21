package ai.okou.android.chat

import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.storage.workspaceStorageKey
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringSetPreferencesKey
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

class ProjectExpansionStore internal constructor(private val preferences: DataStore<Preferences>) {
    internal fun observe(identity: WorkspaceIdentity): Flow<Set<String>> {
        val key = key(identity)
        return preferences.data.map { it[key].orEmpty() }.distinctUntilChanged()
    }

    internal suspend fun setExpanded(
        identity: WorkspaceIdentity,
        projectId: String,
        expanded: Boolean,
    ) {
        val key = key(identity)
        preferences.edit { values ->
            val previous = values[key].orEmpty()
            val next = if (expanded) previous + projectId else previous - projectId
            if (next.isEmpty()) values.remove(key) else values[key] = next
        }
    }

    private fun key(identity: WorkspaceIdentity) =
        stringSetPreferencesKey(identity.workspaceStorageKey())
}
