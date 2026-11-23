package ai.okou.android.settings

import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.workspaceStorageKey
import androidx.datastore.core.DataStore
import androidx.datastore.core.handlers.ReplaceFileCorruptionHandler
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

@Serializable internal data class ConfirmedSetting<T>(val value: T, val readAt: Long)

/** Last confirmed settings data. Android keeps it out of device backups. */
class WorkspaceSettingsCache
internal constructor(
    private val preferences: DataStore<Preferences>,
    private val scope: CoroutineScope,
) {
    private val access = Mutex()

    internal companion object {
        fun create(scope: CoroutineScope, file: () -> File) =
            WorkspaceSettingsCache(
                PreferenceDataStoreFactory.create(
                    corruptionHandler = ReplaceFileCorruptionHandler { emptyPreferences() },
                    scope = scope,
                    produceFile = file,
                ),
                scope,
            )
    }

    internal suspend fun <T> load(
        identity: WorkspaceIdentity,
        resource: String,
        serializer: KSerializer<T>,
    ): ConfirmedSetting<T>? = access.withLock {
        try {
            preferences.data.first()[key(identity, resource)]?.let {
                Json.decodeFromString(ConfirmedSetting.serializer(serializer), it)
            }
        } catch (_: IOException) {
            null
        } catch (_: SerializationException) {
            null
        }
    }

    internal fun <T> save(
        identity: WorkspaceIdentity,
        resource: String,
        serializer: KSerializer<T>,
        data: ConfirmedSetting<T>?,
    ) {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            // Queue accepted writes ahead of later restores, even when the page is closed.
            access.withLock {
                try {
                    preferences.edit {
                        val key = key(identity, resource)
                        if (data == null) it.remove(key)
                        else
                            it[key] =
                                Json.encodeToString(ConfirmedSetting.serializer(serializer), data)
                    }
                } catch (_: IOException) {
                    // The server remains authoritative when device storage is unavailable.
                }
            }
        }
    }

    private fun key(identity: WorkspaceIdentity, resource: String) =
        stringPreferencesKey(
            "${identity.workspaceStorageKey()}-${identity.authorizationScope}-$resource",
        )
}
