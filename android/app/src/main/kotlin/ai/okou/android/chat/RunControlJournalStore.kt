package ai.okou.android.chat

import ai.okou.android.auth.WorkspaceIdentity
import android.content.Context
import android.util.AtomicFile
import java.io.File
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
import okhttp3.HttpUrl.Companion.toHttpUrl

data class RestoredRunControls(val journal: RunControlJournal, val durable: Boolean)

/** App-owned disk writes outlive a retired presentation; no text or confirmed events live here. */
class RunControlJournalStore(
    context: Context,
    private val directory: File = context.noBackupFilesDir.resolve("chat-controls"),
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private class Write(val journal: RunControlJournal) {
        val done = CompletableDeferred<Unit>()
    }

    private val owner = SupervisorJob()
    private val scope = CoroutineScope(owner + dispatcher)
    private val io = Mutex()
    private val guard = Any()
    private val latest = mutableMapOf<String, Write>()
    private val json = Json { encodeDefaults = false }
    private var closed = false

    private fun key(identity: WorkspaceIdentity) =
        chatScopeHash(
            listOf(identity.apiOrigin.toHttpUrl().toString(), identity.userId, identity.workspaceId)
        )

    fun persist(identity: WorkspaceIdentity, journal: RunControlJournal): Deferred<Unit> {
        journal.validate()
        val key = key(identity)
        val value = Write(journal)
        synchronized(guard) {
            check(!closed)
            latest[key] = value
            scope.launch {
                try {
                    io.withLock {
                        if (synchronized(guard) { latest[key] === value }) write(key, journal)
                    }
                    synchronized(guard) { if (latest[key] === value) latest.remove(key) }
                    value.done.complete(Unit)
                } catch (cancelled: CancellationException) {
                    value.done.cancel(cancelled)
                    throw cancelled
                } catch (error: Exception) {
                    // The accepted value remains available to a replacement owner on disk failure.
                    value.done.completeExceptionally(error)
                }
            }
        }
        return value.done
    }

    suspend fun load(identity: WorkspaceIdentity): RestoredRunControls {
        val key = key(identity)
        while (true) {
            val value = synchronized(guard) { latest[key] }
            if (value != null) {
                try {
                    value.done.await()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    if (synchronized(guard) { latest[key] === value })
                        return RestoredRunControls(value.journal, false)
                }
                continue
            }
            val saved = io.withLock { withContext(dispatcher) { read(key) } }
            if (synchronized(guard) { latest[key] == null }) return RestoredRunControls(saved, true)
        }
    }

    @OptIn(ExperimentalSerializationApi::class)
    private fun read(key: String): RunControlJournal {
        val file = AtomicFile(directory.resolve("$key.json"))
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists())
            return RunControlJournal()
        return file
            .openRead()
            .use { json.decodeFromStream<RunControlJournal>(it) }
            .also { it.validate() }
    }

    @OptIn(ExperimentalSerializationApi::class)
    private fun write(key: String, journal: RunControlJournal) {
        check(directory.isDirectory || directory.mkdirs()) { "Cannot create control journal" }
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
        check(read(key) == journal) { "Control intent was not committed" }
    }

    suspend fun close() {
        synchronized(guard) {
            closed = true
            owner.complete()
        }
        owner.join()
    }
}
