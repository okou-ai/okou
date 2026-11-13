package ai.okou.android.chat

import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEventsEventsItem
import ai.okou.android.auth.WorkspaceIdentity
import android.content.Context
import androidx.room.Room
import androidx.room.deferredTransaction
import androidx.room.immediateTransaction
import androidx.room.useReaderConnection
import androidx.room.useWriterConnection
import androidx.sqlite.driver.AndroidSQLiteDriver
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

        private fun current() = !retired && active.get() === this && authorized()

        private fun checkCurrent() {
            if (!current()) throw CancellationException("Chat cache owner retired")
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
                                        projects =
                                            if (scope.hasProjects)
                                                dao.projects(key).map {
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

        suspend fun save(
            checkpoint: ChatCheckpoint,
            confirmedAt: Long,
            navigation: CachedChatNavigation = CachedChatNavigation(),
        ) =
            withContext(dispatcher) {
                checkpoint.validate()
                navigation.validate()
                require(confirmedAt > 0)
                lock.withLock {
                    checkCurrent()
                    val db = database()
                    val caller = currentCoroutineContext()
                    var writing = false
                    var committed = false
                    // Observe physical commit before leaving this mutex. Check the caller at
                    // transaction boundaries so cancellation rolls back instead of losing a
                    // receipt.
                    withContext(NonCancellable) {
                        try {
                            db.useWriterConnection { connection ->
                                connection.immediateTransaction {
                                    caller.ensureActive()
                                    checkCurrent()
                                    val dao = db.chats()
                                    val stored = dao.scope(key)
                                    val sameAuthorization = stored?.authorization == authorization
                                    val lastSeqId =
                                        if (sameAuthorization) {
                                            dao.lastSeqId(key) ?: checkNotNull(stored).snapshotSeqId
                                        } else 0
                                    // Like Web's transaction: a slower sync cannot replace a newer
                                    // tail.
                                    if (
                                        sameAuthorization &&
                                            !rebuild &&
                                            lastSeqId > checkpoint.cursor.seqId
                                    )
                                        return@immediateTransaction
                                    writing = true
                                    val replacement =
                                        rebuild ||
                                            !sameAuthorization ||
                                            stored.snapshotEventId !=
                                                checkpoint.snapshotCursor.eventId ||
                                            stored.snapshotSeqId != checkpoint.snapshotCursor.seqId
                                    dao.putScope(
                                        ChatScopeRecord(
                                            key,
                                            authorization,
                                            confirmedAt,
                                            checkpoint.snapshotCursor.eventId,
                                            checkpoint.snapshotCursor.seqId,
                                            navigation.agents != null,
                                            navigation.projects != null,
                                            navigation.projectsEnabled,
                                        )
                                    )
                                    if (replacement) {
                                        dao.clearEvents(key)
                                        dao.clearSnapshot(key)
                                        dao.putSnapshot(
                                            checkpoint.archive.chatThreads.mapIndexed {
                                                position,
                                                row ->
                                                ChatSnapshotRecord(
                                                    key,
                                                    row.id,
                                                    position,
                                                    json.encodeToString(row),
                                                )
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
                                            ChatAgentRecord(
                                                key,
                                                row.agentId,
                                                position,
                                                json.encodeToString(row),
                                            )
                                        }
                                    )
                                    dao.clearProjects(key)
                                    dao.putProjects(
                                        navigation.projects.orEmpty().mapIndexed { position, row ->
                                            ChatProjectRecord(
                                                key,
                                                row.id,
                                                position,
                                                json.encodeToString(row),
                                            )
                                        }
                                    )
                                    caller.ensureActive()
                                    checkCurrent()
                                }
                            }
                            committed = true
                            rebuild = false
                        } finally {
                            // A commit may finish just as its owner retires. Clean up before a new
                            // lease can read it, even when coroutine cancellation accompanied
                            // retirement.
                            if (writing && committed && !current()) {
                                db.chats().deleteScope(key)
                            }
                        }
                    }
                    currentCoroutineContext().ensureActive()
                    checkCurrent()
                }
            }

        suspend fun invalidate() =
            withContext(dispatcher) {
                lock.withLock {
                    checkCurrent()
                    if (database == null && !file.exists()) return@withLock
                    database().useWriterConnection { connection ->
                        connection.immediateTransaction {
                            database().chats().deleteScope(key)
                            currentCoroutineContext().ensureActive()
                            checkCurrent()
                        }
                    }
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
        .setDriver(AndroidSQLiteDriver())
        .setQueryCoroutineContext(dispatcher)
        // Only rebuildable server data belongs here, never drafts or credentials.
        .fallbackToDestructiveMigration(dropAllTables = true)
        .build()
}
