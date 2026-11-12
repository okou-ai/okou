package ai.okou.android.chat

import ai.okou.android.CHAT_AGENT
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_EVENT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatListApiFixture
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.*
import org.junit.Test

class ChatListSyncTest {
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
                                """{"events":[${chatEventWire(id = "77777777-7777-4777-8777-777777777777", seq = 16)}],"hasMore":false}"""
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
}
