package ai.okou.android.settings

import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.workspaceStorageKey
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.IOException
import kotlinx.coroutines.flow.first
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

@Serializable internal data class ConfirmedSetting<T>(val value: T, val readAt: Long)

/** Last confirmed settings data. Android keeps it out of device backups. */
class WorkspaceSettingsCache internal constructor(private val preferences: DataStore<Preferences>) {
    internal suspend fun <T> load(
        identity: WorkspaceIdentity,
        resource: String,
        serializer: KSerializer<T>,
    ): ConfirmedSetting<T>? =
        try {
            preferences.data.first()[key(identity, resource)]?.let {
                Json.decodeFromString(ConfirmedSetting.serializer(serializer), it)
            }
        } catch (_: IOException) {
            null
        } catch (_: SerializationException) {
            null
        }

    internal suspend fun <T> save(
        identity: WorkspaceIdentity,
        resource: String,
        serializer: KSerializer<T>,
        data: ConfirmedSetting<T>?,
    ) {
        try {
            preferences.edit {
                val key = key(identity, resource)
                if (data == null) it.remove(key)
                else it[key] = Json.encodeToString(ConfirmedSetting.serializer(serializer), data)
            }
        } catch (_: IOException) {
            // The confirmed data is still available to the current workspace owner.
        }
    }

    private fun key(identity: WorkspaceIdentity, resource: String) =
        stringPreferencesKey(
            "${identity.workspaceStorageKey()}-${identity.authorizationScope}-$resource",
        )
}
