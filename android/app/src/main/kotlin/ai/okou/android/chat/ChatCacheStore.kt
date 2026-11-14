package ai.okou.android.chat

import ai.okou.android.api.generated.ApiHeaders
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEventsEventsItem
import ai.okou.android.api.generated.ProjectArchive
import ai.okou.android.api.generated.ProjectEventsEventsItem
import ai.okou.android.auth.WorkspaceIdentity
import android.content.Context
import androidx.room.Room
import androidx.room.deferredTransaction
import androidx.room.immediateTransaction
import androidx.room.useReaderConnection
import androidx.room.useWriterConnection
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl

fun chatScopeHash(parts: List<String>): String =
    MessageDigest.getInstance("SHA-256")
        .digest(parts.joinToString("") { "${it.length}:$it" }.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

data class CachedChats(
    val checkpoint: ChatCheckpoint,
    val confirmedAt: Long,
    val navigation: CachedChatNavigation,
)

data class CachedProjects(val checkpoint: ProjectCheckpoint, val confirmedAt: Long)

data class CachedHistory(val checkpoint: HistoryCheckpoint, val confirmedAt: Long)

/** One application-owned Room database. Leases fence consumers, not database lifetime. */
class ChatCacheStore
internal constructor(
    private val directory: File,
    private val dispatcher: CoroutineDispatcher,
    private val createDatabase: (File) -> ChatCacheDatabase,
) {
    constructor(
        context: Context,
        directory: File = context.noBackupFilesDir.resolve("chat-list"),
        dispatcher: CoroutineDispatcher = Dispatchers.IO,
    ) : this(directory, dispatcher, chatDatabaseFactory(context.applicationContext, dispatcher))

    private val lock = Mutex()
    private val active = AtomicReference<Lease?>()
    private var database: ChatCacheDatabase? = null
    private val file = directory.resolve("chats.db")
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = true
        encodeDefaults = true
    }

    // Called only under the IO mutex. Never open SQLite during construction or on Main.
    private fun database(): ChatCacheDatabase {
        database?.let {
            return it
        }
        if (!directory.isDirectory && !directory.mkdirs())
            throw IOException("Cannot create chat cache")
        return createDatabase(file).also { database = it }
    }

    fun open(identity: WorkspaceIdentity, authorized: () -> Boolean): Lease {
        val origin = identity.apiOrigin.toHttpUrl().toString()
        val key = chatScopeHash(listOf(origin, identity.userId, identity.workspaceId))
        val replacement = Lease(key, identity.authorizationScope, authorized)
        active.getAndSet(replacement)?.retired = true
        return replacement
    }

    /** Close the application resource after its consumers stop (also used by test teardown). */
    suspend fun close() =
        withContext(Dispatchers.IO) {
            active.getAndSet(null)?.retired = true
            lock.withLock {
                database?.close()
                database = null
            }
        }

    inner class Lease
    internal constructor(
        private val key: String,
        private val authorization: String,
        private val authorized: () -> Boolean,
    ) : AutoCloseable {
        @Volatile internal var retired = false
        private var rebuild = false
        private var rebuildProjects = false
        private val rebuildHistories = hashSetOf<String>()

        private fun current() = !retired && active.get() === this && authorized()

        private fun checkCurrent() {
            if (!current()) throw CancellationException("Chat cache owner retired")
        }

        suspend fun loadHistory(threadId: String): CachedHistory? =
            withContext(dispatcher) {
                lock.withLock {
                    checkCurrent()
                    if (database == null && !file.exists()) return@withLock null
                    try {
                        database().useReaderConnection { connection ->
                            connection.deferredTransaction {
                                val dao = database().chats()
                                val stored =
                                    dao.historyScope(key, threadId)
                                        ?: return@deferredTransaction null
                                requireChatWire(
                                    stored.authorization == authorization &&
                                        stored.eventVersion == ApiHeaders.CHAT_EVENT_SCHEMA_VERSION
                                )
                                val rows =
                                    dao.historyEvents(key, threadId).map { entry ->
                                        HistoryEvent.decode(entry.payload).also {
                                            requireChatWire(
                                                it.id == entry.id && it.seqId == entry.seqId
                                            )
                                        }
                                    }
                                val checkpoint =
                                    HistoryCheckpoint(
                                        threadId,
                                        rows,
                                        HistoryCursor(stored.eventId, stored.seqId),
                                    )
                                checkpoint.validate()
                                currentCoroutineContext().ensureActive()
                                checkCurrent()
                                CachedHistory(checkpoint, stored.confirmedAt)
                            }
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        rebuildHistories.add(threadId)
                        throw error
                    }
                }
            }

        suspend fun saveHistory(checkpoint: HistoryCheckpoint, confirmedAt: Long) =
            withContext(dispatcher) {
                checkpoint.validate()
                require(confirmedAt > 0)
                persist(
                    clear = { it.deleteHistory(key, checkpoint.threadId) },
                    saved = { rebuildHistories.remove(checkpoint.threadId) },
                ) { dao ->
                    val threadId = checkpoint.threadId
                    val stored = dao.historyScope(key, threadId)
                    val replacement =
                        checkpoint.replaced ||
                            threadId in rebuildHistories ||
                            stored?.authorization != authorization ||
                            stored.eventVersion != ApiHeaders.CHAT_EVENT_SCHEMA_VERSION
                    if (!replacement && stored.seqId > checkpoint.cursor.seqId) return@persist false
                    if (!replacement && stored.seqId == checkpoint.cursor.seqId)
                        requireChatWire(stored.eventId == checkpoint.cursor.eventId)
                    if (replacement) dao.clearHistoryEvents(key, threadId)
                    dao.putHistoryScope(
                        HistoryScopeRecord(
                            key,
                            threadId,
                            authorization,
                            ApiHeaders.CHAT_EVENT_SCHEMA_VERSION,
                            confirmedAt,
                            checkpoint.cursor.eventId,
                            checkpoint.cursor.seqId,
                        )
                    )
                    dao.putHistoryEvents(
                        checkpoint.rows
                            .filter { replacement || it.seqId > checkNotNull(stored).seqId }
                            .map {
                                HistoryEventRecord(
                                    key,
                                    threadId,
                                    it.id,
                                    it.seqId,
                                    it.wire.toString(),
                                )
                            }
                    )
                    true
                }
            }

        suspend fun deleteHistory(threadId: String) =
            withContext(dispatcher) {
                persist(
                    clear = { it.deleteHistory(key, threadId) },
                    saved = { rebuildHistories.remove(threadId) },
                ) { dao ->
                    dao.deleteHistory(key, threadId)
                    true
                }
            }

        suspend fun load(): CachedChats? =
            withContext(dispatcher) {
                lock.withLock {
                    checkCurrent()
                    if (database == null && !file.exists()) return@withLock null
                    try {
                        database().useReaderConnection { connection ->
                            connection.deferredTransaction {
                                val dao = database().chats()
                                val scope = dao.scope(key) ?: return@deferredTransaction null
                                if (scope.authorization != authorization)
                                    throw IOException("Chat cache authorization changed")
                                val archive =
                                    ChatArchive(
                                        dao.snapshot(key).map {
                                            json.decodeFromString<ConfirmedChat>(it.payload)
                                        }
                                    )
                                val events =
                                    dao.events(key).map {
                                        json.decodeFromString<ChatEventsEventsItem>(it.payload)
                                    }
                                val snapshot =
                                    ChatCursor(scope.snapshotEventId, scope.snapshotSeqId)
                                val checkpoint =
                                    ChatCheckpoint(
                                        archive,
                                        snapshot,
                                        events,
                                        events.lastOrNull()?.cursor() ?: snapshot,
                                    )
                                val navigation =
                                    CachedChatNavigation(
                                        agents =
                                            if (scope.hasAgents)
                                                dao.agents(key).map {
                                                    json.decodeFromString(it.payload)
                                                }
                                            else null,
                                        projectsEnabled = scope.projectsEnabled,
                                    )
                                checkpoint.validate()
                                navigation.validate()
                                currentCoroutineContext().ensureActive()
                                checkCurrent()
                                CachedChats(checkpoint, scope.confirmedAt, navigation)
                            }
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        rebuild = true
                        throw error
                    }
                }
            }

        suspend fun loadProjects(): CachedProjects? =
            withContext(dispatcher) {
                lock.withLock {
                    checkCurrent()
                    if (database == null && !file.exists()) return@withLock null
                    try {
                        database().useReaderConnection { connection ->
                            connection.deferredTransaction {
                                val dao = database().chats()
                                val scope = dao.projectScope(key) ?: return@deferredTransaction null
                                if (scope.authorization != authorization)
                                    throw IOException("Project cache authorization changed")
                                val checkpoint =
                                    ProjectCheckpoint(
                                        ProjectArchive(
                                            dao.projects(key).map {
                                                json.decodeFromString<ConfirmedProject>(it.payload)
                                            },
                                            scope.snapshotEventId,
                                            scope.snapshotSeqId,
                                        ),
                                        dao.projectEvents(key).map {
                                            json.decodeFromString<ProjectEventsEventsItem>(
                                                it.payload
                                            )
                                        },
                                    )
                                replayProjects(checkpoint)
                                currentCoroutineContext().ensureActive()
                                checkCurrent()
                                CachedProjects(checkpoint, scope.confirmedAt)
                            }
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        rebuildProjects = true
                        throw error
                    }
                }
            }

        suspend fun save(
            checkpoint: ChatCheckpoint,
            confirmedAt: Long,
            navigation: CachedChatNavigation = CachedChatNavigation(),
        ) =
            withContext(dispatcher) {
                checkpoint.validate()
                navigation.validate()
                require(confirmedAt > 0)
                persist(clear = { it.deleteScope(key) }, saved = { rebuild = false }) { dao ->
                    val stored = dao.scope(key)
                    val sameAuthorization = stored?.authorization == authorization
                    val lastSeqId =
                        if (sameAuthorization)
                            dao.lastSeqId(key) ?: checkNotNull(stored).snapshotSeqId
                        else 0
                    if (sameAuthorization && !rebuild && lastSeqId > checkpoint.cursor.seqId)
                        return@persist false
                    val replacement =
                        rebuild ||
                            !sameAuthorization ||
                            stored.snapshotEventId != checkpoint.snapshotCursor.eventId ||
                            stored.snapshotSeqId != checkpoint.snapshotCursor.seqId
                    dao.putScope(
                        ChatScopeRecord(
                            key,
                            authorization,
                            confirmedAt,
                            checkpoint.snapshotCursor.eventId,
                            checkpoint.snapshotCursor.seqId,
                            navigation.agents != null,
                            navigation.projectsEnabled,
                        )
                    )
                    if (replacement) {
                        dao.clearEvents(key)
                        dao.clearSnapshot(key)
                        dao.putSnapshot(
                            checkpoint.archive.chatThreads.mapIndexed { position, row ->
                                ChatSnapshotRecord(key, row.id, position, json.encodeToString(row))
                            }
                        )
                    }
                    dao.putEvents(
                        checkpoint.events
                            .filter { replacement || it.cursor().seqId > lastSeqId }
                            .map {
                                val cursor = it.cursor()
                                ChatEventRecord(
                                    key,
                                    checkNotNull(cursor.eventId),
                                    cursor.seqId,
                                    json.encodeToString(it),
                                )
                            }
                    )
                    dao.clearAgents(key)
                    dao.putAgents(
                        navigation.agents.orEmpty().mapIndexed { position, row ->
                            ChatAgentRecord(key, row.agentId, position, json.encodeToString(row))
                        }
                    )
                    true
                }
            }

        suspend fun saveProjects(checkpoint: ProjectCheckpoint, confirmedAt: Long) =
            withContext(dispatcher) {
                checkpoint.validate()
                require(confirmedAt > 0)
                persist(
                    clear = { it.deleteProjectScope(key) },
                    saved = { rebuildProjects = false },
                ) { dao ->
                    val stored = dao.projectScope(key)
                    val sameAuthorization = stored?.authorization == authorization
                    val lastSeqId =
                        if (sameAuthorization)
                            dao.lastProjectSeqId(key) ?: checkNotNull(stored).snapshotSeqId
                        else 0
                    if (
                        sameAuthorization && !rebuildProjects && lastSeqId > checkpoint.cursor.seqId
                    )
                        return@persist false
                    val replacement =
                        rebuildProjects ||
                            !sameAuthorization ||
                            stored.snapshotEventId != checkpoint.snapshotCursor.eventId ||
                            stored.snapshotSeqId != checkpoint.snapshotCursor.seqId
                    dao.putProjectScope(
                        ProjectScopeRecord(
                            key,
                            authorization,
                            confirmedAt,
                            checkpoint.snapshotCursor.eventId,
                            checkpoint.snapshotCursor.seqId,
                        )
                    )
                    if (replacement) {
                        dao.clearProjectEvents(key)
                        dao.clearProjects(key)
                        dao.putProjects(
                            checkpoint.archive.projects.mapIndexed { position, row ->
                                ChatProjectRecord(key, row.id, position, json.encodeToString(row))
                            }
                        )
                    }
                    dao.putProjectEvents(
                        checkpoint.events
                            .filter { replacement || it.seqId > lastSeqId }
                            .map {
                                ProjectEventRecord(key, it.id, it.seqId, json.encodeToString(it))
                            }
                    )
                    true
                }
            }

        /** Both datasets observe physical commit/rollback before a replacement lease can read. */
        private suspend fun persist(
            clear: suspend (ChatCacheDao) -> Unit,
            saved: () -> Unit,
            write: suspend (ChatCacheDao) -> Boolean,
        ) {
            lock.withLock {
                checkCurrent()
                val db = database()
                val caller = currentCoroutineContext()
                var writing = false
                var committed = false
                withContext(NonCancellable) {
                    try {
                        db.useWriterConnection { connection ->
                            connection.immediateTransaction {
                                caller.ensureActive()
                                checkCurrent()
                                writing = write(db.chats())
                                caller.ensureActive()
                                checkCurrent()
                            }
                        }
                        committed = true
                        saved()
                    } finally {
                        if (writing && committed && !current()) clear(db.chats())
                    }
                }
                currentCoroutineContext().ensureActive()
                checkCurrent()
            }
        }

        override fun close() {
            retired = true
            active.compareAndSet(this, null)
        }
    }
}

private fun chatDatabaseFactory(
    application: Context,
    dispatcher: CoroutineDispatcher,
): (File) -> ChatCacheDatabase = { file ->
    Room.databaseBuilder(application, ChatCacheDatabase::class.java, file.absolutePath)
        // Native statements avoid CursorWindow's per-row limit for canonical metadata.
        .setDriver(BundledSQLiteDriver())
        .setQueryCoroutineContext(dispatcher)
        // Only rebuildable server data belongs here, never drafts or credentials.
        .fallbackToDestructiveMigration(dropAllTables = true)
        .build()
}
