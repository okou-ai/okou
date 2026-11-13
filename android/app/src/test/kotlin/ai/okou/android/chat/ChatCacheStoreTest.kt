package ai.okou.android.chat

import ai.okou.android.CHAT_AGENT
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatListApiFixture
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.AgentsItem
import ai.okou.android.api.generated.AgentsItemVisibility
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.ProjectsProjectsItem
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.sqlite.SQLiteConnection
import androidx.sqlite.SQLiteDriver
import androidx.sqlite.SQLiteStatement
import androidx.sqlite.driver.AndroidSQLiteDriver
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class ChatCacheStoreTest {
    @get:Rule val temporary = TemporaryFolder()
    private val identity =
        WorkspaceIdentity("https://api.okou.ai/", "user-a", "session-a", "org-a", "member")
    private val json = Json { ignoreUnknownKeys = true }
    private val caches = mutableListOf<ChatCacheStore>()

    private fun cache(root: File) =
        ChatCacheStore(ApplicationProvider.getApplicationContext(), root).also { caches += it }

    @After fun closeCaches() = runBlocking { caches.forEach { it.close() } }

    private fun checkpoint(events: String = chatEventWire()): ChatCheckpoint {
        val page = json.decodeFromString<ChatEvents>("""{"events":[$events],"hasMore":false}""")
        return ChatCheckpoint(
            ChatArchive(emptyList()),
            ChatCursor(),
            page.events,
            page.events.last().cursor(),
        )
    }

    private fun navigation() =
        CachedChatNavigation(
            agents =
                listOf(
                    AgentsItem(
                        CHAT_AGENT,
                        true,
                        "user-a",
                        null,
                        "My Okou",
                        null,
                        null,
                        AgentsItemVisibility.PRIVATE,
                    )
                ),
            projects = listOf(ProjectsProjectsItem(CHAT_PROJECT, "Research", CHAT_DATE, CHAT_DATE)),
            projectsEnabled = true,
        )

    @Test
    fun fullTailCursorAndReferencesReopenTogetherAndRetainDeferredProjectMembership() = runTest {
        val root = temporary.newFolder()
        val first = cache(root)
        val deferred =
            checkpoint(
                chatEventWire(kind = "project_updated", extra = ",\"projectId\":\"$CHAT_PROJECT\"")
            )
        first.open(identity) { true }.use { it.save(deferred, 1234, navigation()) }
        first.close()
        val reopened = cache(root)
        reopened
            .open(identity.copy(sessionId = "renewed-session")) { true }
            .use { lease ->
                val saved = checkNotNull(lease.load())
                assertEquals(deferred.cursor, saved.checkpoint.cursor)
                assertEquals(1234L, saved.confirmedAt)
                assertEquals(navigation(), saved.navigation)
                ChatListApiFixture().use { fixture ->
                    fixture.events = {
                        jsonResponse(
                            """{"events":[${chatEventWire(id = "77777777-7777-4777-8777-777777777777", seq = 23)}],"hasMore":false}"""
                        )
                    }
                    val confirmed = ChatListSync(fixture.service).synchronize(saved.checkpoint)
                    assertEquals(CHAT_PROJECT, replayChats(confirmed).single().projectId)
                    assertEquals(CHAT_PERSONAL, replayChats(confirmed).single().id)
                    lease.save(confirmed, 2345, saved.navigation)
                }
            }
        reopened.close()
        cache(root)
            .open(identity) { true }
            .use { assertEquals(23L, checkNotNull(it.load()).checkpoint.cursor.seqId) }
    }

    @Test
    fun scopesStayIndependentAndAuthorizationChangesRequireCanonicalRebuild() = runTest {
        val store = cache(temporary.newFolder())
        store.open(identity) { true }.use { it.save(checkpoint(), 1234) }
        for (other in
            listOf(
                identity.copy(apiOrigin = "https://preview.okou.ai"),
                identity.copy(userId = "user-b"),
                identity.copy(workspaceId = "org-b"),
            )) {
            store
                .open(other) { true }
                .use {
                    assertNull(it.load())
                    it.save(checkpoint(), 2345)
                }
        }
        store.open(identity) { true }.use { assertEquals(1234L, it.load()?.confirmedAt) }
        store
            .open(identity.copy(authorizationScope = "restricted")) { true }
            .use {
                assertTrue(runCatching { it.load() }.exceptionOrNull() is IOException)
                val rebuilt =
                    checkpoint(chatEventWire(id = "77777777-7777-4777-8777-777777777777", seq = 23))
                it.save(rebuilt, 3456)
                assertEquals(rebuilt, checkNotNull(it.load()).checkpoint)
            }
    }

    @Test
    fun retiredLeaseCannotOverwriteReplacementEvenForTheSameDurableScope() = runTest {
        val store = cache(temporary.newFolder())
        val old = store.open(identity) { true }
        store
            .open(identity.copy(sessionId = "new-session")) { true }
            .use { replacement ->
                val newer =
                    checkpoint(chatEventWire(id = "77777777-7777-4777-8777-777777777777", seq = 23))
                replacement.save(newer, 2345)
                assertTrue(
                    runCatching { old.save(checkpoint(), 1234) }.exceptionOrNull()
                        is CancellationException
                )
                assertEquals(newer.cursor, checkNotNull(replacement.load()).checkpoint.cursor)
            }
        old.close()
    }

    @Test
    fun olderSyncCannotReplaceNewerTailAndRebaseReplacesTheSnapshotAndTailTogether() = runTest {
        val store = cache(temporary.newFolder())
        store
            .open(identity) { true }
            .use { lease ->
                val original = checkpoint()
                lease.save(original, 1234)
                val newer =
                    checkpoint(
                        chatEventWire() +
                            "," +
                            chatEventWire(
                                id = "77777777-7777-4777-8777-777777777777",
                                seq = 23,
                                kind = "renamed",
                                title = "New title",
                            )
                    )
                lease.save(newer, 2345)
                lease.save(original, 1234)
                assertEquals(newer, checkNotNull(lease.load()).checkpoint)
                val rebased =
                    ChatCheckpoint(
                        ChatArchive(replayChats(newer)),
                        newer.cursor,
                        emptyList(),
                        newer.cursor,
                    )
                lease.save(rebased, 3456)
                store.close()
                store
                    .open(identity) { true }
                    .use {
                        val saved = checkNotNull(it.load())
                        assertEquals(rebased, saved.checkpoint)
                        assertEquals("New title", replayChats(saved.checkpoint).single().title)
                    }
            }
    }

    @Test
    fun failedTransactionKeepsPreviousSnapshotTailCursorAndReferences() = runTest {
        val root = temporary.newFolder()
        val store = cache(root)
        val original = checkpoint()
        store.open(identity) { true }.use { it.save(original, 1234, navigation()) }
        store.close()
        // Fault at the real disk boundary after the transaction has begun replacing its snapshot.
        SQLiteDatabase.openDatabase(
                root.resolve("chats.db").path,
                null,
                SQLiteDatabase.OPEN_READWRITE,
            )
            .use {
                it.execSQL(
                    "CREATE TRIGGER fail_event BEFORE INSERT ON chat_thread_events BEGIN SELECT RAISE(ABORT, 'disk failure fixture'); END"
                )
            }
        store
            .open(identity) { true }
            .use { lease ->
                val cursor = original.cursor
                val tail =
                    checkpoint(
                        chatEventWire(
                            id = "77777777-7777-4777-8777-777777777777",
                            seq = 23,
                            kind = "renamed",
                            title = "New title",
                        )
                    )
                val replacement =
                    tail.copy(archive = ChatArchive(replayChats(original)), snapshotCursor = cursor)
                assertTrue(runCatching { lease.save(replacement, 2345) }.isFailure)
                val saved = checkNotNull(lease.load())
                assertEquals(original, saved.checkpoint)
                assertEquals(1234L, saved.confirmedAt)
                assertEquals(navigation(), saved.navigation)
            }
    }

    @Test
    fun retirementDuringAWriteRollsBackWithoutDeletingThePreviousConfirmedCache() = runTest {
        val root = temporary.newFolder()
        val entered = CompletableDeferred<Unit>()
        val release = CountDownLatch(1)
        val holdInsert = AtomicBoolean(false)
        val native = AndroidSQLiteDriver()
        val driver =
            object : SQLiteDriver by native {
                override fun open(fileName: String): SQLiteConnection {
                    val connection = native.open(fileName)
                    return object : SQLiteConnection by connection {
                        override fun prepare(sql: String): SQLiteStatement {
                            val statement = connection.prepare(sql)
                            return object : SQLiteStatement by statement {
                                override fun step(): Boolean {
                                    if (
                                        sql.contains("INSERT") &&
                                            sql.contains("chat_thread_events") &&
                                            holdInsert.compareAndSet(true, false)
                                    ) {
                                        entered.complete(Unit)
                                        release.await()
                                    }
                                    return statement.step()
                                }
                            }
                        }
                    }
                }
            }
        val store =
            ChatCacheStore(root, Dispatchers.IO) { file ->
                    Room.databaseBuilder(
                            ApplicationProvider.getApplicationContext(),
                            ChatCacheDatabase::class.java,
                            file.path,
                        )
                        .setDriver(driver)
                        .setQueryCoroutineContext(Dispatchers.IO)
                        .build()
                }
                .also { caches += it }
        val original = checkpoint()
        val old = store.open(identity) { true }
        try {
            old.save(original, 1234)
            holdInsert.set(true)
            val writer =
                async(Dispatchers.IO) {
                    runCatching {
                        old.save(
                            checkpoint(
                                chatEventWire() +
                                    "," +
                                    chatEventWire(
                                        id = "77777777-7777-4777-8777-777777777777",
                                        seq = 23,
                                        kind = "renamed",
                                    )
                            ),
                            2345,
                        )
                    }
                }
            entered.await()
            store
                .open(identity.copy(sessionId = "replacement")) { true }
                .use { replacement ->
                    release.countDown()
                    assertTrue(writer.await().exceptionOrNull() is CancellationException)
                    assertEquals(original, checkNotNull(replacement.load()).checkpoint)
                }
        } finally {
            release.countDown()
            old.close()
        }
    }

    @Test
    fun unreadableCacheCanBeRebuiltAndUnsupportedDatabaseVersionIsDisposable() = runTest {
        val root = temporary.newFolder()
        val store = cache(root)
        val original = checkpoint()
        store.open(identity) { true }.use { it.save(original, 1234) }
        store.close()
        SQLiteDatabase.openDatabase(
                root.resolve("chats.db").path,
                null,
                SQLiteDatabase.OPEN_READWRITE,
            )
            .use { it.execSQL("UPDATE chat_thread_events SET payload = '{'") }
        store
            .open(identity) { true }
            .use { lease ->
                assertTrue(runCatching { lease.load() }.isFailure)
                lease.save(original, 2345)
                assertEquals(original, checkNotNull(lease.load()).checkpoint)
            }
        store.close()
        SQLiteDatabase.openDatabase(
                root.resolve("chats.db").path,
                null,
                SQLiteDatabase.OPEN_READWRITE,
            )
            .use { it.version = 99 }
        store
            .open(identity) { true }
            .use {
                assertNull(it.load())
                it.save(original, 3456)
                assertEquals(original, checkNotNull(it.load()).checkpoint)
            }
    }

    @Test
    fun largeSnapshotSpansCursorWindowsAndInvalidatingOneScopeKeepsOtherScopes() = runTest {
        val root = temporary.newFolder()
        val store = cache(root)
        val row = replayChats(checkpoint()).single()
        val rows =
            (1..300).map {
                row.copy(
                    id = "${it.toString().padStart(8, '0')}-0000-4000-8000-000000000000",
                    title = "Title $it " + "x".repeat(12_000),
                )
            }
        val snapshot = ChatCheckpoint(ChatArchive(rows), ChatCursor(), emptyList(), ChatCursor())
        store.open(identity) { true }.use { it.save(snapshot, 1234) }
        store
            .open(identity.copy(workspaceId = "org-b")) { true }
            .use { it.save(checkpoint(), 2345) }
        store.close()
        store
            .open(identity) { true }
            .use {
                val restored = checkNotNull(it.load()).checkpoint
                assertEquals(rows.map { it.id }, restored.archive.chatThreads.map { it.id })
                assertTrue(
                    restored.archive.chatThreads.zip(rows).all { (saved, expected) ->
                        saved == expected
                    }
                )
                it.invalidate()
                assertNull(it.load())
            }
        store
            .open(identity.copy(workspaceId = "org-b")) { true }
            .use {
                assertEquals(
                    "Personal chat",
                    replayChats(checkNotNull(it.load()).checkpoint).single().title,
                )
            }
    }
}
