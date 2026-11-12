package ai.okou.android.chat

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatListApiFixture
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
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

    private fun checkpoint(events: String = chatEventWire()): ChatCheckpoint {
        val page = json.decodeFromString<ChatEvents>("""{"events":[$events],"hasMore":false}""")
        return ChatCheckpoint(
            ChatArchive(emptyList()),
            ChatCursor(),
            page.events,
            page.events.last().cursor(),
        )
    }

    @Test
    fun fullTailAndCursorReopenTogetherAndRetainDeferredProjectMembership() = runTest {
        val root = temporary.newFolder()
        ChatListApiFixture().use { fixture ->
            val deferred =
                checkpoint(
                    chatEventWire(
                        kind = "project_updated",
                        extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                    )
                )
            ChatCacheStore(root).open(identity) { true }.use { it.save(deferred, 1234) }
            val reopened =
                ChatCacheStore(root).open(identity.copy(sessionId = "renewed-session")) { true }
            try {
                val saved = checkNotNull(reopened.load())
                assertEquals(deferred.cursor, saved.checkpoint.cursor)
                assertEquals(1234L, saved.confirmedAt)
                fixture.events = {
                    jsonResponse(
                        """{"events":[${chatEventWire(id = "77777777-7777-4777-8777-777777777777", seq = 23)}],"hasMore":false}"""
                    )
                }
                val confirmed = ChatListSync(fixture.service).synchronize(saved.checkpoint)
                assertEquals(CHAT_PROJECT, replayChats(confirmed).single().projectId)
                assertEquals(CHAT_PERSONAL, replayChats(confirmed).single().id)
                reopened.save(confirmed, 2345)
            } finally {
                reopened.close()
            }
            ChatCacheStore(root)
                .open(identity) { true }
                .use { final ->
                    assertEquals(23L, checkNotNull(final.load()).checkpoint.cursor.seqId)
                }
        }
    }

    @Test
    fun scopeAndAuthorizationChangesCannotRestoreAnotherOwnersContent() = runTest {
        val root = temporary.newFolder()
        ChatCacheStore(root).open(identity) { true }.use { it.save(checkpoint(), 1234) }
        for (other in
            listOf(
                identity.copy(apiOrigin = "https://preview.okou.ai"),
                identity.copy(userId = "user-b"),
                identity.copy(workspaceId = "org-b"),
            )) {
            ChatCacheStore(root).open(other) { true }.use { assertNull(it.load()) }
        }
        ChatCacheStore(root)
            .open(identity.copy(authorizationScope = "restricted")) { true }
            .use { assertTrue(runCatching { it.load() }.exceptionOrNull() is IOException) }
    }

    @Test
    fun retiredLeaseCannotOverwriteReplacementEvenForTheSameDurableScope() = runTest {
        val root = temporary.newFolder()
        val store = ChatCacheStore(root)
        val old = store.open(identity) { true }
        val replacement = store.open(identity.copy(sessionId = "new-session")) { true }
        try {
            val newer =
                checkpoint(chatEventWire(id = "77777777-7777-4777-8777-777777777777", seq = 23))
            replacement.save(newer, 2345)
            assertTrue(
                runCatching { old.save(checkpoint(), 1234) }.exceptionOrNull()
                    is CancellationException
            )
            assertEquals(newer.cursor, checkNotNull(replacement.load()).checkpoint.cursor)
        } finally {
            old.close()
            replacement.close()
        }
    }

    @Test
    fun corruptOrUnsupportedFormatsNeverRestoreAndAnOversizeWriteKeepsThePreviousCheckpoint() =
        runTest {
            val root = temporary.newFolder()
            val lease = ChatCacheStore(root).open(identity) { true }
            try {
                val original = checkpoint()
                lease.save(original, 1234)
                val file = checkNotNull(root.listFiles()).single { it.name.endsWith(".json") }
                val body = file.readText()
                file.writeText(body.replace("\"format\":1", "\"format\":2"))
                assertTrue(runCatching { lease.load() }.exceptionOrNull() is IOException)
                file.writeText("{")
                assertTrue(runCatching { lease.load() }.isFailure)
                lease.save(original, 1234)
                val huge =
                    original.copy(
                        archive =
                            ChatArchive(
                                listOf(
                                    replayChats(original)
                                        .single()
                                        .copy(title = "x".repeat(MAX_CHAT_CACHE_BYTES.toInt()))
                                )
                            )
                    )
                assertTrue(runCatching { lease.save(huge, 2345) }.exceptionOrNull() is IOException)
                assertEquals(original, checkNotNull(lease.load()).checkpoint)
            } finally {
                lease.close()
            }
        }

    @Test
    fun retentionFailureCannotPublishAFifthScope() = runTest {
        val root = temporary.newFolder()
        repeat(4) { index ->
            // A damaged old AtomicFile group cannot be deleted as a regular cache file.
            val old = root.resolve("${index.toString().padStart(64, '0')}.json")
            check(old.mkdir())
            old.resolve("unexpected-child").writeText("unavailable cache")
        }
        ChatCacheStore(root)
            .open(identity) { true }
            .use { lease ->
                assertTrue(
                    runCatching { lease.save(checkpoint(), 1234) }.exceptionOrNull() is IOException
                )
                assertNull(lease.load())
            }
        assertEquals(4, checkNotNull(root.listFiles()).size)
    }

    @Test
    fun retentionEvictsWholeOldScopesWithinTheFourScopeBudget() = runTest {
        val root = temporary.newFolder()
        val store = ChatCacheStore(root)
        repeat(5) { index ->
            store
                .open(identity.copy(workspaceId = "org-$index")) { true }
                .use { it.save(checkpoint(), 1234) }
        }
        assertEquals(4, checkNotNull(root.listFiles()).count { it.name.endsWith(".json") })
        store.open(identity.copy(workspaceId = "org-4")) { true }.use { assertNotNull(it.load()) }
    }
}
