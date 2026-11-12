package ai.okou.android.chat

import ai.okou.android.api.generated.Agents
import ai.okou.android.api.generated.ProjectsProjectsItem
import ai.okou.android.auth.WorkspaceIdentity
import android.util.AtomicFile
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl

const val MAX_CHAT_CACHE_BYTES = 8L * 1024 * 1024

fun chatScopeHash(parts: List<String>): String =
    MessageDigest.getInstance("SHA-256")
        .digest(parts.joinToString("") { "${it.length}:$it" }.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

@Serializable
private data class ChatCacheEnvelope(
    val format: Int,
    val scope: String,
    val authorization: String,
    val confirmedAt: Long,
    val checkpoint: ChatCheckpoint,
    val navigation: CachedChatNavigation = CachedChatNavigation(),
)

@Serializable
data class CachedChatNavigation(
    val agents: Agents? = null,
    val projects: List<ProjectsProjectsItem>? = null,
    val projectsEnabled: Boolean = false,
) {
    fun validate() {
        agents?.let { records ->
            requireChatWire(
                records.size <= MAX_CHAT_THREADS &&
                    records.map { it.agentId }.distinct().size == records.size &&
                    records.count { it.isDefaultAgent } <= 1
            )
            records.forEach { requireChatId(it.agentId) }
        }
        projects?.let { records ->
            requireChatWire(
                records.size <= MAX_CHAT_THREADS &&
                    records.map { it.id }.distinct().size == records.size
            )
            records.forEach {
                requireChatId(it.id)
                chatTime(it.createdAt)
            }
        }
    }
}

data class CachedChats(
    val checkpoint: ChatCheckpoint,
    val confirmedAt: Long,
    val navigation: CachedChatNavigation,
)

/**
 * Process-owned, private/no-backup confirmed storage. A lease also fences same-scope replacement.
 */
class ChatCacheStore(
    private val directory: File,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val lock = Any()
    private val active = AtomicReference<Lease?>()
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = true
        encodeDefaults = true
    }

    fun open(identity: WorkspaceIdentity, authorized: () -> Boolean): Lease {
        val origin = identity.apiOrigin.toHttpUrl().toString()
        val key = chatScopeHash(listOf(origin, identity.userId, identity.workspaceId))
        val replacement = Lease(key, identity.authorizationScope, authorized)
        active.getAndSet(replacement)?.retired = true
        return replacement
    }

    inner class Lease
    internal constructor(
        private val key: String,
        private val authorization: String,
        private val authorized: () -> Boolean,
    ) : AutoCloseable {
        @Volatile internal var retired = false

        private fun checkCurrent() {
            val allowed = authorized()
            if (retired || active.get() !== this || !allowed)
                throw CancellationException("Chat cache owner retired")
        }

        suspend fun load(): CachedChats? =
            withContext(dispatcher) {
                val context = currentCoroutineContext()
                synchronized(lock) {
                    context.ensureActive()
                    checkCurrent()
                    val file = AtomicFile(File(directory, "$key.json"))
                    val bytes =
                        try {
                            file.openRead().use { input ->
                                val output = ByteArrayOutputStream()
                                val buffer = ByteArray(8192)
                                while (true) {
                                    val count = input.read(buffer)
                                    if (count == -1) break
                                    if (output.size().toLong() + count > MAX_CHAT_CACHE_BYTES)
                                        throw IOException("Chat cache exceeds its size budget")
                                    output.write(buffer, 0, count)
                                }
                                output.toByteArray()
                            }
                        } catch (missing: FileNotFoundException) {
                            if (
                                directory.exists() &&
                                    (file.baseFile.exists() ||
                                        File(directory, "$key.json.bak").exists())
                            )
                                throw missing
                            return@synchronized null
                        }
                    val value =
                        json.decodeFromString<ChatCacheEnvelope>(
                            bytes.decodeToString(throwOnInvalidSequence = true)
                        )
                    if (
                        value.format != 1 ||
                            value.scope != key ||
                            value.authorization != authorization ||
                            value.confirmedAt <= 0
                    )
                        throw IOException("Chat cache format or authorization changed")
                    value.checkpoint.validate()
                    value.navigation.validate()
                    context.ensureActive()
                    checkCurrent()
                    if (!file.baseFile.setLastModified(System.currentTimeMillis()))
                        throw IOException("Cannot update chat cache retention")
                    CachedChats(value.checkpoint, value.confirmedAt, value.navigation)
                }
            }

        suspend fun save(
            checkpoint: ChatCheckpoint,
            confirmedAt: Long,
            navigation: CachedChatNavigation = CachedChatNavigation(),
        ) =
            withContext(dispatcher) {
                checkpoint.validate()
                checkCurrent()
                navigation.validate()
                val bytes =
                    json
                        .encodeToString(
                            ChatCacheEnvelope(
                                1,
                                key,
                                authorization,
                                confirmedAt,
                                checkpoint,
                                navigation,
                            )
                        )
                        .toByteArray(Charsets.UTF_8)
                if (bytes.size > MAX_CHAT_CACHE_BYTES)
                    throw IOException("Chat cache exceeds its size budget")
                val context = currentCoroutineContext()
                synchronized(lock) {
                    context.ensureActive()
                    checkCurrent()
                    if (!directory.isDirectory && !directory.mkdirs())
                        throw IOException("Cannot create chat cache")
                    reserveScope(key)
                    val file = AtomicFile(File(directory, "$key.json"))
                    val output = file.startWrite()
                    try {
                        output.write(bytes)
                        context.ensureActive()
                        checkCurrent()
                        file.finishWrite(output)
                        // AtomicFile can log a rename/sync failure rather than throwing it.
                        // Confirm the committed bytes before reporting persistence success.
                        val committed =
                            file.openRead().use { input ->
                                val saved = ByteArray(bytes.size)
                                var offset = 0
                                while (offset < saved.size) {
                                    val read = input.read(saved, offset, saved.size - offset)
                                    if (read == -1) break
                                    offset += read
                                }
                                offset == saved.size &&
                                    input.read() == -1 &&
                                    saved.contentEquals(bytes)
                            }
                        if (!committed)
                            throw IOException("Chat cache commit could not be confirmed")
                        // Replacement never waits for disk on Main. The shared IO lock keeps
                        // the next owner from observing a retired commit before its removal.
                        try {
                            checkCurrent()
                        } catch (cancelled: CancellationException) {
                            file.delete()
                            throw cancelled
                        }
                    } catch (error: Exception) {
                        file.failWrite(output)
                        throw error
                    }
                }
            }

        override fun close() {
            retired = true
            active.compareAndSet(this, null)
        }

        suspend fun invalidate() =
            withContext(dispatcher) {
                val context = currentCoroutineContext()
                synchronized(lock) {
                    context.ensureActive()
                    checkCurrent()
                    val name = "$key.json"
                    AtomicFile(File(directory, name)).delete()
                    if (listOf("", ".new", ".bak").any { File(directory, name + it).exists() })
                        throw IOException("Cannot invalidate chat cache")
                }
            }
    }

    /** Called under the IO lock, before publishing a new scope or creating its temporary file. */
    private fun reserveScope(key: String) {
        val groups =
            directory
                .listFiles()
                ?.filter { Regex("[0-9a-f]{64}\\.json(?:\\.new|\\.bak)?").matches(it.name) }
                ?.groupBy { it.name.substringBefore(".json") + ".json" }
                ?: throw IOException("Cannot inspect chat cache retention")
        groups.entries
            .filter { it.key != "$key.json" }
            .sortedByDescending { (_, files) -> files.maxOf { it.lastModified() } }
            .drop(3)
            .forEach { (name, _) ->
                AtomicFile(File(directory, name)).delete()
                if (listOf("", ".new", ".bak").any { File(directory, name + it).exists() }) {
                    throw IOException("Cannot evict an old chat cache scope")
                }
            }
    }
}
