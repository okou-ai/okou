package ai.okou.android.instructions

import ai.okou.android.api.generated.PersonalInstructions
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.chat.chatScopeHash
import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromStream
import kotlinx.serialization.json.encodeToStream
import okhttp3.HttpUrl.Companion.toHttpUrl

@Serializable
data class InstructionsDraft(
    val content: String,
    val base: PersonalInstructions,
    val attempted: Boolean = false,
)

data class RestoredInstructionsDraft(val draft: InstructionsDraft?, val durable: Boolean)

@Serializable
private data class InstructionsDocument(val format: Int, val draft: InstructionsDraft?)

/** User intent, not a rebuildable cache. Accepted local writes outlive a retired editor. */
class PersonalInstructionsDraftStore(
    context: Context,
    private val directory: File = context.noBackupFilesDir.resolve("personal-instructions"),
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private class Write(val value: InstructionsDraft?) {
        val done = CompletableDeferred<Unit>()
    }

    private val owner = SupervisorJob()
    private val scope = CoroutineScope(owner + dispatcher)
    private val io = Mutex()
    private val guard = Any()
    private val latest = mutableMapOf<String, Write>()
    private var closed = false
    private val json = Json {
        encodeDefaults = true
        explicitNulls = true
    }

    private fun key(identity: WorkspaceIdentity) =
        chatScopeHash(
            listOf(identity.apiOrigin.toHttpUrl().toString(), identity.userId, identity.workspaceId)
        )

    fun persist(identity: WorkspaceIdentity, value: InstructionsDraft?): Deferred<Unit> {
        val key = key(identity)
        val write = Write(value)
        synchronized(guard) {
            check(!closed) { "Instructions store is closed" }
            latest[key] = write
            scope.launch {
                try {
                    io.withLock {
                        // Skip obsolete queued edits, but finish the write already in progress.
                        if (synchronized(guard) { latest[key] === write })
                            withContext(dispatcher) { write(key, value) }
                    }
                    synchronized(guard) { if (latest[key] === write) latest.remove(key) }
                    write.done.complete(Unit)
                } catch (cancelled: CancellationException) {
                    write.done.cancel(cancelled)
                    throw cancelled
                } catch (error: Exception) {
                    // Keep the accepted latest value available to a replacement editor.
                    write.done.completeExceptionally(error)
                }
            }
        }
        return write.done
    }

    suspend fun load(identity: WorkspaceIdentity): RestoredInstructionsDraft {
        val key = key(identity)
        while (true) {
            val pending = synchronized(guard) { latest[key] }
            if (pending != null) {
                try {
                    pending.done.await()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    if (synchronized(guard) { latest[key] === pending })
                        return RestoredInstructionsDraft(pending.value, false)
                }
                continue
            }
            val saved = io.withLock { withContext(dispatcher) { read(key) } }
            if (synchronized(guard) { latest[key] == null }) {
                if (
                    saved != null &&
                        (saved.base.orgId != identity.workspaceId ||
                            saved.base.userId != identity.userId)
                )
                    throw IOException("Instructions draft belongs to another owner")
                return RestoredInstructionsDraft(saved, true)
            }
        }
    }

    @OptIn(ExperimentalSerializationApi::class)
    private fun read(key: String): InstructionsDraft? {
        val file = AtomicFile(directory.resolve("$key.json"))
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return null
        return file.openRead().use { stream ->
            val value = json.decodeFromStream<InstructionsDocument>(stream)
            check(value.format == 1) { "Unsupported Instructions draft format" }
            value.draft
        }
    }

    @OptIn(ExperimentalSerializationApi::class)
    private fun write(key: String, value: InstructionsDraft?) {
        if (!directory.isDirectory && !directory.mkdirs())
            throw IOException("Cannot create Instructions store")
        val file = AtomicFile(directory.resolve("$key.json"))
        val stream = file.startWrite()
        try {
            json.encodeToStream(InstructionsDocument(1, value), stream)
            // AtomicFile logs some sync/commit failures instead of throwing them.
            stream.fd.sync()
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
        // Verify the committed value outside rollback: finishWrite has closed the transaction.
        if (read(key) != value) throw IOException("Instructions draft was not committed")
    }

    suspend fun close() {
        synchronized(guard) {
            closed = true
            owner.complete()
        }
        owner.join()
    }
}
