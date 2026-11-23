package ai.okou.android.chat

import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.workspaceStorageKey
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

class SearchRecentChatsStore internal constructor(private val preferences: DataStore<Preferences>) {
    internal fun observe(identity: WorkspaceIdentity) =
        preferences.data.map { decode(it[key(identity)]) }.distinctUntilChanged()

    internal suspend fun record(identity: WorkspaceIdentity, threadId: String) {
        val key = key(identity)
        preferences.edit { values ->
            val previous = decode(values[key])
            val next = (listOf(threadId) + (previous - threadId)).take(RecentSearchChatLimit)
            if (next != previous) values[key] = Json.encodeToString(next)
        }
    }

    private fun key(identity: WorkspaceIdentity) =
        stringPreferencesKey(identity.workspaceStorageKey())

    private fun decode(wire: String?): List<String> =
        if (wire == null) emptyList()
        else
            try {
                Json.decodeFromString<List<String>>(wire)
            } catch (_: SerializationException) {
                emptyList()
            }
}
