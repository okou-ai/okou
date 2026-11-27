package ai.okou.android.instructions

import ai.okou.android.MemorySnapshotClock
import ai.okou.android.api.generated.PersonalInstructions
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.workspaceStorageKey
import ai.okou.android.isFreshMemorySnapshot
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

@Serializable
data class InstructionsDraft(
    val content: String,
    val base: PersonalInstructions,
    val attempted: Boolean = false,
)

data class RestoredInstructionsDraft(val draft: InstructionsDraft?, val durable: Boolean)

enum class InstructionsCommit {
    Committed,
    Superseded,
}

@Serializable
private data class InstructionsDocument(val format: Int, val draft: InstructionsDraft?)

/**
 * Retains workspace editors and confirmed snapshots, and commits save intent across editor
 * lifetimes.
 */
class PersonalInstructionsDraftStore(
    context: Context,
    private val directory: File = context.noBackupFilesDir.resolve("personal-instructions"),
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val nowMillis: () -> Long = MemorySnapshotClock::nowMillis,
) {
    private data class Confirmed(val value: PersonalInstructions, val atMillis: Long)

    private class Write(val value: InstructionsDraft?) {
        val done = CompletableDeferred<InstructionsCommit>()
    }

    private val owner = SupervisorJob()
    private val scope = CoroutineScope(owner + dispatcher)
    private val io = Mutex()
    private val guard = Any()
    private val latest = mutableMapOf<String, Write>()
    private val editors = mutableMapOf<String, PersonalInstructionsOwner>()
    private val confirmed = mutableMapOf<String, Confirmed>()
    private var closed = false
    private val json = Json {
        encodeDefaults = true
        explicitNulls = true
    }

    // Like the editor registry, the confirmed snapshots are accessed on Main.
    internal fun freshConfirmed(identity: WorkspaceIdentity): PersonalInstructions? {
        val key = identity.workspaceStorageKey()
        val snapshot = confirmed[key] ?: return null
        if (snapshot.atMillis.isFreshMemorySnapshot(nowMillis())) return snapshot.value
        confirmed.remove(key)
        return null
    }

    internal fun rememberConfirmed(identity: WorkspaceIdentity, value: PersonalInstructions) {
        val now = nowMillis()
        confirmed.values.removeAll { !it.atMillis.isFreshMemorySnapshot(now) }
        confirmed[identity.workspaceStorageKey()] = Confirmed(value, now)
    }

    internal fun forgetConfirmed(identity: WorkspaceIdentity) {
        confirmed.remove(identity.workspaceStorageKey())
    }

    // Presentation controllers attach on Main. Only attached identities retain a shared editor.
    internal fun attach(
        identity: WorkspaceIdentity,
        connection: PersonalInstructionsOwner.Connection,
    ): PersonalInstructionsOwner =
        editors
            .getOrPut(identity.workspaceStorageKey()) { PersonalInstructionsOwner(this, identity) }
            .also { it.attach(connection) }

    internal fun detach(
        identity: WorkspaceIdentity,
        connection: PersonalInstructionsOwner.Connection,
        editor: PersonalInstructionsOwner,
    ) {
        if (editor.detach(connection)) editors.remove(identity.workspaceStorageKey(), editor)
    }

    internal fun persist(
        identity: WorkspaceIdentity,
        value: InstructionsDraft?,
    ): Deferred<InstructionsCommit> {
        val key = identity.workspaceStorageKey()
        val write = Write(value)
        synchronized(guard) {
            check(!closed) { "Instructions store is closed" }
            latest[key] = write
            scope.launch {
                try {
                    val committed = io.withLock {
                        // Skip obsolete queued edits, but finish the write already in progress.
                        if (synchronized(guard) { latest[key] === write }) {
                            withContext(dispatcher) { write(key, value) }
                            InstructionsCommit.Committed
                        } else InstructionsCommit.Superseded
                    }
                    synchronized(guard) { if (latest[key] === write) latest.remove(key) }
                    write.done.complete(committed)
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
        val key = identity.workspaceStorageKey()
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
