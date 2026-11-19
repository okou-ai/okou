package ai.okou.android.preferences

import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.chat.chatScopeHash
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
import okhttp3.HttpUrl.Companion.toHttpUrl

@Serializable
data class MemberAppearance(
    val theme: UserPreferencesTheme,
    val colorTheme: UserPreferencesColorTheme,
)

internal val UserPreferences.appearance: MemberAppearance
    get() =
        MemberAppearance(
            theme ?: UserPreferencesTheme.SYSTEM,
            colorTheme ?: UserPreferencesColorTheme.DEFAULT,
        )

/** A disposable first-display cache. Only confirmed workspace appearance reaches disk. */
class MemberAppearanceCache(
    private val directory: () -> File,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val io = Mutex()

    suspend fun load(identity: WorkspaceIdentity): MemberAppearance? =
        withContext(dispatcher) { io.withLock { read(file(identity)) } }

    suspend fun save(identity: WorkspaceIdentity, appearance: MemberAppearance): Unit =
        withContext(dispatcher) {
            io.withLock {
                val file = file(identity)
                if (read(file) == appearance) return@withLock
                val data = Json.encodeToString(appearance).encodeToByteArray()
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
                    Log.w("MemberAppearanceCache", "Could not update the appearance cache")
                }
            }
        }

    private fun file(identity: WorkspaceIdentity): AtomicFile {
        val key =
            chatScopeHash(
                listOf(
                    identity.apiOrigin.toHttpUrl().toString(),
                    identity.userId,
                    identity.workspaceId,
                )
            )
        return AtomicFile(directory().resolve("$key.json"))
    }

    private fun read(file: AtomicFile): MemberAppearance? =
        try {
            Json.decodeFromString<MemberAppearance>(file.readFully().decodeToString())
        } catch (_: FileNotFoundException) {
            null
        } catch (_: IOException) {
            Log.w("MemberAppearanceCache", "Could not read the appearance cache")
            null
        } catch (_: SerializationException) {
            Log.w("MemberAppearanceCache", "Could not decode the appearance cache")
            null
        }
}
