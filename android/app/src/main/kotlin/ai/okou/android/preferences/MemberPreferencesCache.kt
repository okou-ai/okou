package ai.okou.android.preferences

import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.workspaceStorageKey
import android.util.AtomicFile
import android.util.Log
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

@Serializable
data class CachedMemberPreferences(
    val theme: UserPreferencesTheme,
    val colorTheme: UserPreferencesColorTheme,
    val locale: UserPreferencesLocale? = null,
    val timezone: String? = null,
    val cloudBrowser: Boolean? = null,
)

/** Restores applied appearance and confirmed settings on the next workspace open. */
class MemberPreferencesCache(
    private val directory: () -> File,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val io = Mutex()

    suspend fun load(identity: WorkspaceIdentity): CachedMemberPreferences? =
        withContext(dispatcher) { io.withLock { read(file(identity)) } }

    suspend fun save(identity: WorkspaceIdentity, preferences: CachedMemberPreferences): Unit =
        withContext(dispatcher) {
            io.withLock {
                val file = file(identity)
                if (read(file) == preferences) return@withLock
                val data = Json.encodeToString(preferences).encodeToByteArray()
                try {
                    val output = file.startWrite()
                    try {
                        output.write(data)
                        file.finishWrite(output)
                    } catch (error: IOException) {
                        file.failWrite(output)
                        throw error
                    }
                } catch (_: IOException) {
                    Log.w("MemberPreferencesCache", "Could not update the preferences cache")
                }
            }
        }

    private fun file(identity: WorkspaceIdentity): AtomicFile =
        AtomicFile(directory().resolve("${identity.workspaceStorageKey()}.json"))

    private fun read(file: AtomicFile): CachedMemberPreferences? =
        try {
            Json.decodeFromString<CachedMemberPreferences>(file.readFully().decodeToString())
        } catch (_: FileNotFoundException) {
            null
        } catch (_: IOException) {
            Log.w("MemberPreferencesCache", "Could not read the preferences cache")
            null
        } catch (_: SerializationException) {
            Log.w("MemberPreferencesCache", "Could not decode the preferences cache")
            null
        }
}
