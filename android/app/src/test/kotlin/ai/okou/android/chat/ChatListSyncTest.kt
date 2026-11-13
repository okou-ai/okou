package ai.okou.android.chat

import ai.okou.android.CHAT_AGENT
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_EVENT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatListApiFixture
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.*
import org.junit.Test

class ChatListSyncTest {
    private fun eventId(seq: Int) = "${seq.toString().padStart(8, '0')}-0000-4000-8000-000000000000"

    private fun longTail(): ChatCheckpoint {
        val events =
            (1..101).joinToString(",") {
                chatEventWire(
                    id = eventId(it),
                    seq = it.toLong(),
                    kind = if (it == 1) "created" else "renamed",
                    title = "Title $it",
                )
            }
        val page = Json.decodeFromString<ChatEvents>("""{"events":[$events],"hasMore":false}""")
        return ChatCheckpoint(
            ChatArchive(emptyList()),
            ChatCursor(),
            page.events,
            page.events.last().cursor(),
        )
    }

    @Test
    fun signedStorageExpirationIsNotAWorkspaceAuthorizationFailure() = runTest {
        ChatListApiFixture().use { fixture ->
            fixture.archive = { MockResponse().setResponseCode(403) }
            assertTrue(
                runCatching {
                        fixture.service.chatArchive(fixture.server.url("/archive").toString())
                    }
                    .exceptionOrNull() is ChatSnapshotUnavailable
            )
        }
    }

    @Test
    fun signedSnapshotAndGapTolerantTailUseRealCanonicalReadersWithoutCredentialsOnStorage() =
        runTest {
            ChatListApiFixture().use { fixture ->
                fixture.snapshot = {
                    jsonResponse(
                        """{"url":"${fixture.server.url("/archive?signature=private").toString()}","expiresInSeconds":60,"latestEventId":"$CHAT_EVENT","latestSeqId":17}"""
                    )
                }
                fixture.archive = {
                    jsonResponse(
                        """{"chatThreads":[{"id":"$CHAT_PERSONAL","agentId":"$CHAT_AGENT","title":"Saved chat","sortAt":"$CHAT_DATE","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","pinnedAt":null,"archived":false,"renamedAt":null,"serviceTier":"ultrafast"}]}"""
                    )
                }
                fixture.events = {
                    jsonResponse(
                        """{"events":[${chatEventWire(id = "77777777-7777-4777-8777-777777777777", seq = 23, kind = "renamed", title = "Renamed chat")}],"hasMore":false}"""
                    )
                }
                val confirmed = ChatListSync(fixture.service).synchronize(null)
                assertEquals(23L, confirmed.cursor.seqId)
                val row = replayChats(confirmed).single()
                assertEquals("Renamed chat", row.title)
                assertEquals(CHAT_AGENT, row.agentId)
                assertNull(row.serviceTier)
                val snapshot = fixture.server.takeRequest()
                val archive = fixture.server.takeRequest()
                val tail = fixture.server.takeRequest()
                assertEquals("Bearer fixture-token", snapshot.getHeader("Authorization"))
                assertEquals("/archive?signature=private", archive.path)
                assertNull(archive.getHeader("Authorization"))
                assertNull(archive.getHeader("X-Client-Type"))
                assertEquals("/api/chat-threads/events?sinceSeqId=17", tail.path)
                assertFalse(
                    kotlinx.serialization.json.Json.encodeToString(confirmed).contains("signature")
                )
            }
        }

    @Test
    fun explicitEmptyScopeOmitsTheZeroCursor() = runTest {
        ChatListApiFixture().use { fixture ->
            fixture.events = { jsonResponse("""{"events":[],"hasMore":false}""") }
            val confirmed = ChatListSync(fixture.service).synchronize(null)
            assertTrue(replayChats(confirmed).isEmpty())
            assertEquals(ChatCursor(), confirmed.cursor)
            assertEquals("/api/chat-threads/snapshot", fixture.server.takeRequest().path)
            assertEquals("/api/chat-threads/events", fixture.server.takeRequest().path)
        }
    }

    @Test
    fun expiredCursorRebuildsOnceAndASecondExpirationEscapes() = runTest {
        ChatListApiFixture().use { fixture ->
            val cursor = ChatCursor(CHAT_EVENT, 17)
            val previous = ChatCheckpoint(ChatArchive(emptyList()), cursor, emptyList(), cursor)
            fixture.events = { MockResponse().setResponseCode(410) }
            val error =
                runCatching { ChatListSync(fixture.service).synchronize(previous) }
                    .exceptionOrNull()
            assertTrue(error is ApiFailure.Http && error.status == 410)
            assertEquals(
                "/api/chat-threads/events?sinceSeqId=17",
                fixture.server.takeRequest().path,
            )
            assertEquals("/api/chat-threads/snapshot", fixture.server.takeRequest().path)
            assertEquals("/api/chat-threads/events", fixture.server.takeRequest().path)
            fixture.events = { jsonResponse("""{"events":[],"hasMore":false}""") }
            val restored = ChatListSync(fixture.service).synchronize(previous)
            assertEquals(ChatCursor(CHAT_EVENT, 17), restored.cursor)
        }
    }

    @Test
    fun emptyMorePageRepeatedIdentityAndBackwardsSequenceDoNotBecomeConfirmedData() = runTest {
        for (invalid in listOf("empty-more", "identity", "sequence")) {
            ChatListApiFixture().use { fixture ->
                fixture.events = { request ->
                    when {
                        invalid == "empty-more" -> jsonResponse("""{"events":[],"hasMore":true}""")
                        request.requestUrl?.queryParameter("sinceSeqId") == null ->
                            jsonResponse("""{"events":[${chatEventWire()}],"hasMore":true}""")
                        invalid == "identity" ->
                            jsonResponse(
                                """{"events":[${chatEventWire(seq = 23)}],"hasMore":false}"""
                            )
                        else ->
                            jsonResponse(
                                """{"events":[${chatEventWire(id = "77777777-7777-4777-8777-777777777777", seq = 16)}],"hasMore":true}"""
                            )
                    }
                }
                assertTrue(
                    runCatching { ChatListSync(fixture.service).synchronize(null) }
                        .exceptionOrNull() is ApiFailure.IncompatibleResponse
                )
            }
        }
    }

    @Test
    fun overlapIsIgnoredButTheNewTailStillAdvances() = runTest {
        ChatListApiFixture().use { fixture ->
            val cursor = ChatCursor(CHAT_EVENT, 17)
            val previous = ChatCheckpoint(ChatArchive(emptyList()), cursor, emptyList(), cursor)
            fixture.events = {
                jsonResponse(
                    """{"events":[${chatEventWire()},${chatEventWire(id = eventId(23), seq = 23, kind = "renamed")}],"hasMore":false}"""
                )
            }
            val confirmed = ChatListSync(fixture.service).synchronize(previous)
            assertEquals(listOf(23L), confirmed.events.map { it.cursor().seqId })
            assertEquals(23L, confirmed.cursor.seqId)
        }
    }

    @Test
    fun largeTailCatchesUpBeforeRebasingAndIncludesEventsAfterTheNewSnapshot() = runTest {
        ChatListApiFixture().use { fixture ->
            val previous = longTail()
            fixture.events = {
                jsonResponse(
                    """{"events":[${chatEventWire(id = eventId(102), seq = 102, kind = "renamed", title = "Newest title")}],"hasMore":false}"""
                )
            }
            fixture.snapshot = {
                jsonResponse(
                    """{"url":"${fixture.server.url("/archive")}","expiresInSeconds":60,"latestEventId":"${eventId(101)}","latestSeqId":101}"""
                )
            }
            fixture.archive = {
                jsonResponse(Json.encodeToString(ChatArchive(replayChats(previous))))
            }
            val confirmed = ChatListSync(fixture.service).synchronize(previous)
            assertEquals(101L, confirmed.snapshotCursor.seqId)
            assertEquals(listOf(102L), confirmed.events.map { it.cursor().seqId })
            assertEquals("Newest title", replayChats(confirmed).single().title)
            assertEquals(
                "/api/chat-threads/events?sinceSeqId=101",
                fixture.server.takeRequest().path,
            )
            assertEquals("/api/chat-threads/snapshot", fixture.server.takeRequest().path)
            assertEquals("/archive", fixture.server.takeRequest().path)
            assertEquals(
                "/api/chat-threads/events?sinceSeqId=101",
                fixture.server.takeRequest().path,
            )
        }
    }

    @Test
    fun optionalRebaseServerFailureKeepsTheAlreadySynchronizedTail() = runTest {
        for (failure in listOf("descriptor", "archive")) {
            ChatListApiFixture().use { fixture ->
                val previous = longTail()
                fixture.events = {
                    jsonResponse(
                        """{"events":[${chatEventWire(id = eventId(102), seq = 102, kind = "renamed", title = "Newest title")}],"hasMore":false}"""
                    )
                }
                fixture.snapshot = {
                    if (failure == "descriptor") MockResponse().setResponseCode(503)
                    else
                        jsonResponse(
                            """{"url":"${fixture.server.url("/archive")}","expiresInSeconds":60,"latestEventId":"${eventId(101)}","latestSeqId":101}"""
                        )
                }
                fixture.archive = { MockResponse().setResponseCode(503) }
                val confirmed = ChatListSync(fixture.service).synchronize(previous)
                assertEquals(102L, confirmed.cursor.seqId)
                assertEquals("Newest title", replayChats(confirmed).single().title)
                assertEquals(
                    "/api/chat-threads/events?sinceSeqId=101",
                    fixture.server.takeRequest().path,
                )
            }
        }
    }

    @Test
    fun rebaseAuthorizationFailureIsNotHiddenByTheConfirmedTail() = runTest {
        ChatListApiFixture().use { fixture ->
            fixture.events = { jsonResponse("""{"events":[],"hasMore":false}""") }
            fixture.snapshot = { MockResponse().setResponseCode(401) }
            val error =
                runCatching { ChatListSync(fixture.service).synchronize(longTail()) }
                    .exceptionOrNull()
            assertTrue(error is ApiFailure.Http && error.status == 401)
        }
    }

    @Test
    fun emptyCachedCursorReloadsCompactedSnapshotBeyondFormerSizeAndRowCutoffs() = runTest {
        ChatListApiFixture().use { fixture ->
            val row =
                Json.decodeFromString<ChatArchive>(
                        """{"chatThreads":[{"id":"$CHAT_PERSONAL","agentId":"$CHAT_AGENT","title":"Saved","sortAt":"$CHAT_DATE","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","pinnedAt":null,"archived":false,"renamedAt":null}]}"""
                    )
                    .chatThreads
                    .single()
            val rows =
                (1..10_001).map {
                    row.copy(id = eventId(it), title = "Title $it " + "x".repeat(900))
                }
            fixture.snapshot = {
                jsonResponse(
                    """{"url":"${fixture.server.url("/archive")}","expiresInSeconds":60,"latestEventId":"$CHAT_EVENT","latestSeqId":17}"""
                )
            }
            fixture.archive = { jsonResponse(Json.encodeToString(ChatArchive(rows))) }
            fixture.events = { jsonResponse("""{"events":[],"hasMore":false}""") }
            val empty =
                ChatCheckpoint(ChatArchive(emptyList()), ChatCursor(), emptyList(), ChatCursor())
            val confirmed = ChatListSync(fixture.service).synchronize(empty)
            assertEquals(10_001, replayChats(confirmed).size)
            assertEquals(rows.last().title, confirmed.archive.chatThreads.last().title)
            assertEquals(17L, confirmed.cursor.seqId)
        }
    }

    @Test
    fun catchesUpMoreThanOneHundredPagesWhenEveryPageAdvances() = runTest {
        ChatListApiFixture().use { fixture ->
            fixture.events = { request ->
                val seq = (request.requestUrl?.queryParameter("sinceSeqId")?.toInt() ?: 0) + 1
                jsonResponse(
                    """{"events":[${chatEventWire(id = eventId(seq), seq = seq.toLong(), kind = if (seq == 1) "created" else "renamed", title = "Title $seq")}],"hasMore":${seq < 101}}"""
                )
            }
            val confirmed = ChatListSync(fixture.service).synchronize(null)
            assertEquals(101L, confirmed.cursor.seqId)
            assertEquals("Title 101", replayChats(confirmed).single().title)
        }
    }

    @Test
    fun cursorCanRebuildAgainAfterRealProgressLikeWeb() = runTest {
        ChatListApiFixture().use { fixture ->
            var snapshotSeq = 20
            fixture.snapshot = {
                jsonResponse(
                    """{"url":"${fixture.server.url("/archive")}","expiresInSeconds":60,"latestEventId":"${eventId(snapshotSeq)}","latestSeqId":$snapshotSeq}"""
                )
            }
            val original = longTail().archive.copy(chatThreads = replayChats(longTail()))
            fixture.archive = { jsonResponse(Json.encodeToString(original)) }
            fixture.events = { request ->
                when (val seq = request.requestUrl?.queryParameter("sinceSeqId")?.toInt()) {
                    17 -> MockResponse().setResponseCode(410)
                    21 -> {
                        snapshotSeq = 40
                        MockResponse().setResponseCode(410)
                    }
                    else -> {
                        val next = checkNotNull(seq) + 1
                        jsonResponse(
                            """{"events":[${chatEventWire(id = eventId(next), seq = next.toLong(), kind = "renamed", title = "Title $next")}],"hasMore":${next == 21}}"""
                        )
                    }
                }
            }
            val cursor = ChatCursor(CHAT_EVENT, 17)
            val previous = ChatCheckpoint(original, cursor, emptyList(), cursor)
            val confirmed = ChatListSync(fixture.service).synchronize(previous)
            assertEquals(41L, confirmed.cursor.seqId)
            assertEquals("Title 41", replayChats(confirmed).single().title)
        }
    }
}
