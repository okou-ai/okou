package ai.okou.android.chat

import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.workspaceStorageKey
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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromStream
import kotlinx.serialization.json.encodeToStream

enum class ComposerCommit {
    Committed,
    Superseded,
}

data class RestoredComposer(val journal: ComposerJournal, val durable: Boolean)

/** App-owned accepted writes survive presentation retirement. This is user intent, never cache. */
class ComposerJournalStore(
    context: Context,
    private val directory: File = context.noBackupFilesDir.resolve("chat-input"),
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private class Write(val journal: ComposerJournal) {
        val done = CompletableDeferred<ComposerCommit>()
    }

    private val owner = SupervisorJob()
    private val scope = CoroutineScope(owner + dispatcher)
    private val io = Mutex()
    private val guard = Any()
    private val latest = mutableMapOf<String, Write>()
    private val editors = mutableMapOf<String, ChatComposerOwner>()
    private var closed = false
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = false
        explicitNulls = true
    }

    internal fun attach(identity: WorkspaceIdentity, connection: ChatComposerOwner.Connection) =
        editors
            .getOrPut(identity.workspaceStorageKey()) { ChatComposerOwner(this, identity) }
            .also { it.attach(connection) }

    internal fun detach(
        identity: WorkspaceIdentity,
        connection: ChatComposerOwner.Connection,
        editor: ChatComposerOwner,
    ) {
        if (editor.detach(connection)) editors.remove(identity.workspaceStorageKey(), editor)
    }

    internal fun persist(
        identity: WorkspaceIdentity,
        journal: ComposerJournal,
    ): Deferred<ComposerCommit> {
        val key = identity.workspaceStorageKey()
        val write = Write(journal)
        synchronized(guard) {
            check(!closed) { "Composer journal is closed" }
            latest[key] = write
            scope.launch {
                try {
                    val result =
                        io.withLock {
                            if (synchronized(guard) { latest[key] === write }) {
                                withContext(dispatcher) { write(key, journal) }
                                ComposerCommit.Committed
                            } else ComposerCommit.Superseded
                        }
                    synchronized(guard) { if (latest[key] === write) latest.remove(key) }
                    write.done.complete(result)
                } catch (cancelled: CancellationException) {
                    write.done.cancel(cancelled)
                    throw cancelled
                } catch (error: Exception) {
                    // Retain the accepted value for a replacement controller on IO failure.
                    write.done.completeExceptionally(error)
                }
            }
        }
        return write.done
    }

    suspend fun load(identity: WorkspaceIdentity): RestoredComposer {
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
                        return RestoredComposer(pending.journal, false)
                }
                continue
            }
            val saved = io.withLock { withContext(dispatcher) { read(key) } }
            if (synchronized(guard) { latest[key] == null }) return RestoredComposer(saved, true)
        }
    }

    @OptIn(ExperimentalSerializationApi::class)
    private fun read(key: String): ComposerJournal {
        val file = AtomicFile(directory.resolve("$key.json"))
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists())
            return ComposerJournal()
        return file
            .openRead()
            .use { stream -> json.decodeFromStream<ComposerJournal>(stream) }
            .also {
                if (
                    it.format !in 1..3 ||
                        it.format == 1 &&
                            it.entries.values.any { entry -> entry.recovery != null } ||
                        it.format < 3 && (it.drafts.isNotEmpty() || it.retainedDrafts.isNotEmpty())
                )
                    throw IOException("Unsupported composer journal format")
            }
    }

    @OptIn(ExperimentalSerializationApi::class)
    private fun write(key: String, journal: ComposerJournal) {
        if (!directory.isDirectory && !directory.mkdirs())
            throw IOException("Cannot create composer journal")
        val file = AtomicFile(directory.resolve("$key.json"))
        val stream = file.startWrite()
        try {
            json.encodeToStream(journal, stream)
            stream.fd.sync()
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
        if (read(key) != journal) throw IOException("Composer journal was not committed")
    }

    suspend fun close() {
        synchronized(guard) {
            closed = true
            owner.complete()
        }
        owner.join()
    }
}
