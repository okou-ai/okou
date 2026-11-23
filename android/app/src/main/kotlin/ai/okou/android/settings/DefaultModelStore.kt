package ai.okou.android.settings

import ai.okou.android.api.generated.DefaultModelPreference
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.workspaceStorageKey
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonIgnoreUnknownKeys

@OptIn(ExperimentalSerializationApi::class)
// Earlier builds included optimistic edits in this record. Only confirmed values restore.
@JsonIgnoreUnknownKeys
@Serializable
internal data class DefaultModelRecord(
    val confirmed: DefaultModelPreference = DefaultModelPreference(null, null, emptyMap()),
    val lastRefreshMillis: Long? = null,
    val confirmedLabel: String? = null,
)

/** The application can finish an accepted cache write after its workspace view is retired. */
class DefaultModelStore
internal constructor(
    private val preferences: DataStore<Preferences>,
    private val scope: CoroutineScope,
) {
    private val access = Mutex()

    internal suspend fun load(identity: WorkspaceIdentity): DefaultModelRecord =
        access.withLock {
            try {
                preferences.data.first()[key(identity)]?.let { Json.decodeFromString(it) }
                    ?: DefaultModelRecord()
            } catch (_: IOException) {
                DefaultModelRecord()
            } catch (_: SerializationException) {
                DefaultModelRecord()
            }
        }

    internal fun save(identity: WorkspaceIdentity, record: DefaultModelRecord) {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            // Enter the same queue as later restores before the caller can retire this owner.
            access.withLock {
                try {
                    preferences.edit { it[key(identity)] = Json.encodeToString(record) }
                } catch (_: IOException) {
                    // The next successful preference read can refresh this cache.
                }
            }
        }
    }

    private fun key(identity: WorkspaceIdentity) =
        stringPreferencesKey(identity.workspaceStorageKey())
}
