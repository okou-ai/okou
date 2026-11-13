package ai.okou.android.chat

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatListApiFixture
import ai.okou.android.HISTORY_LAST_EVENT
import ai.okou.android.TestChatService
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.HistorySnapshot
import ai.okou.android.api.generated.ReadState
import ai.okou.android.api.generated.ThreadDetail
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import androidx.test.core.app.ApplicationProvider
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.MockResponse
import okio.Buffer
import okio.GzipSink
import okio.buffer
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class ConversationHistoryTest {
    @get:Rule val temporary = TemporaryFolder()
    private val stores = mutableListOf<ChatCacheStore>()
    private val identity =
        WorkspaceIdentity("https://api.okou.ai/", "user", "session", "workspace", "member")

    private fun cache(root: File = temporary.newFolder()) =
        ChatCacheStore(ApplicationProvider.getApplicationContext(), root).also { stores += it }

    @After fun close() = runBlocking { stores.forEach { it.close() } }

    private fun row(
        id: String = HISTORY_LAST_EVENT,
        seq: Long = 37,
        thread: String = CHAT_PERSONAL,
        type: String = "output.message",
        payload: String = "{\"content\":\"reply\"}",
        revoke: String? = null,
    ) = HistoryEvent.decode(historyEventWire(id, seq, thread, type, payload, revoke = revoke))

    private fun checkpoint(thread: String = CHAT_PERSONAL) =
        HistoryCheckpoint(
            thread,
            listOf(row(thread = thread)),
            HistoryCursor(HISTORY_LAST_EVENT, 37),
        )

    private fun thread(id: String = CHAT_PERSONAL): ConfirmedChat =
        Json.decodeFromString<ChatArchive>(
                """{"chatThreads":[{"id":"$id","agentId":"agent-original","projectId":"project-original","title":"History thread","sortAt":"$CHAT_DATE","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","pinnedAt":null,"archived":false,"renamedAt":null}]}"""
            )
            .chatThreads
            .single()

    private open class Service : TestChatService() {
        val requested = mutableListOf<HistoryCursor>()
        val marked = CompletableDeferred<Unit>()
        var markCount = 0
        var detailStatus: Int? = null
        var rowsRead: suspend (String, HistoryCursor) -> HistoryPage = { id, cursor ->
            if (cursor.seqId == 0L)
                HistoryPage(
                    listOf(HistoryEvent.decode(historyEventWire(thread = id))),
                    HistoryCursor(HISTORY_LAST_EVENT, 37),
                    false,
                )
            else HistoryPage(emptyList(), cursor, false)
        }

        override suspend fun threadDetail(threadId: String): ThreadDetail {
            detailStatus?.let { throw ApiFailure.Http(it, null, null, null) }
            return ThreadDetail(null, false)
        }

        override suspend fun historySnapshot(threadId: String): HistorySnapshot =
            throw ApiFailure.Http(404, "CHAT_EVENT_SNAPSHOT_NOT_FOUND", null, null)

        override suspend fun historyRows(threadId: String, cursor: HistoryCursor): HistoryPage {
            requested += cursor
            return rowsRead(threadId, cursor)
        }

        override suspend fun markRead(threadId: String): ReadState {
            markCount++
            marked.complete(Unit)
            return ReadState(CHAT_DATE)
        }
    }

    @Test
    fun actualGzipNdjsonTransportAndCanonicalPairedTailDoNotLeakApiCredentials() = runTest {
        ChatListApiFixture().use { fixture ->
            val wire = historyEventWire()
            fixture.historySnapshot = {
                jsonResponse(
                    """{"url":"${fixture.server.url("/history-archive")}","expiresInSeconds":60,"lastEventId":"$HISTORY_LAST_EVENT","lastSeqId":37}"""
                )
            }
            fixture.historyArchive = {
                val compressed = Buffer()
                GzipSink(compressed).buffer().use { it.writeUtf8("$wire\n") }
                MockResponse().setHeader("Content-Encoding", "gzip").setBody(compressed)
            }
            val result = ConversationHistorySync(fixture.service).synchronize(CHAT_PERSONAL, null)
            assertEquals(listOf(HISTORY_LAST_EVENT), result.rows.map { it.id })
            assertEquals(HistoryCursor(HISTORY_LAST_EVENT, 37), result.cursor)
            val requests = List(5) { fixture.server.takeRequest() }
            val signed = requests.single { it.path == "/history-archive" }
            assertNull(signed.getHeader("Authorization"))
            assertNull(signed.getHeader("X-Client-Type"))
            val tails =
                requests.filter { it.requestUrl?.encodedPath?.endsWith("/event-rows") == true }
            assertEquals(2, tails.size)
            assertTrue(
                tails.all {
                    it.requestUrl!!.queryParameter("sinceEventId") == HISTORY_LAST_EVENT &&
                        it.requestUrl!!.queryParameter("sinceSeqId") == "37"
                }
            )
            assertEquals(0, fixture.readRequests.get())
            fixture.historyArchive = { MockResponse().setBody(wire) }
            assertThrows(ApiFailure.IncompatibleResponse::class.java) {
                runBlocking {
                    ConversationHistorySync(fixture.service).synchronize(CHAT_PERSONAL, null)
                }
            }
        }
    }

    @Test
    fun largeUnicodeHistoryRowStreamsAndReopensWithoutCursorWindowLimits() = runTest {
        ChatListApiFixture().use { fixture ->
            val content = "界".repeat(800_000)
            val wire = historyEventWire(payload = """{"content":"$content"}""")
            fixture.historySnapshot = {
                jsonResponse(
                    """{"url":"${fixture.server.url("/history-archive")}","expiresInSeconds":60,"lastEventId":"$HISTORY_LAST_EVENT","lastSeqId":37}"""
                )
            }
            fixture.historyArchive = { MockResponse().setBody("$wire\n") }
            val checkpoint =
                ConversationHistorySync(fixture.service).synchronize(CHAT_PERSONAL, null)
            val root = temporary.newFolder()
            val first = cache(root)
            first.open(fixture.identity) { true }.saveHistory(checkpoint, 100)
            first.close()
            val restored =
                checkNotNull(cache(root).open(fixture.identity) { true }.loadHistory(CHAT_PERSONAL))
            assertEquals(
                content,
                projectHistory(restored.checkpoint).messages.single().blocks.single().text,
            )
        }
    }

    @Test
    fun missingSnapshotStartsAtZeroButMissingConversationNeverDoes() = runTest {
        val service = Service()
        val result = ConversationHistorySync(service).synchronize(CHAT_PERSONAL, null)
        assertEquals(
            listOf(HistoryCursor(), HistoryCursor(HISTORY_LAST_EVENT, 37)),
            service.requested,
        )
        assertEquals(37L, result.cursor.seqId)
        assertEquals(0, service.markCount)
        service.detailStatus = 404
        val before = service.requested.size
        try {
            ConversationHistorySync(service).synchronize(CHAT_PERSONAL, null)
            fail("Missing conversation must fail")
        } catch (error: ApiFailure.Http) {
            assertEquals(404, error.status)
        }
        assertEquals(before, service.requested.size)
    }

    @Test
    fun expiredCachedCursorRebuildsOnceAndMalformedProgressDoesNotPublishPartialHistory() =
        runTest {
            val service = Service()
            var expired = true
            service.rowsRead = { id, cursor ->
                if (expired) {
                    expired = false
                    throw ApiFailure.Http(410, null, null, null)
                }
                if (cursor.seqId == 0L)
                    HistoryPage(
                        listOf(row(thread = id)),
                        HistoryCursor(HISTORY_LAST_EVENT, 37),
                        false,
                    )
                else HistoryPage(emptyList(), cursor, false)
            }
            assertTrue(
                ConversationHistorySync(service).synchronize(CHAT_PERSONAL, checkpoint()).replaced
            )
            service.rowsRead = { _, _ -> throw ApiFailure.Http(410, null, null, null) }
            try {
                ConversationHistorySync(service).synchronize(CHAT_PERSONAL, null)
                fail("An immediately expired snapshot is invalid")
            } catch (_: ApiFailure.IncompatibleResponse) {}
            service.rowsRead = { _, cursor -> HistoryPage(emptyList(), cursor, true) }
            try {
                ConversationHistorySync(service).synchronize(CHAT_PERSONAL, checkpoint())
                fail("No-progress page must fail")
            } catch (_: ApiFailure.IncompatibleResponse) {}
            service.rowsRead = { _, _ ->
                HistoryPage(
                    listOf(row(thread = CHAT_IN_PROJECT)),
                    HistoryCursor(HISTORY_LAST_EVENT, 37),
                    false,
                )
            }
            try {
                ConversationHistorySync(service).synchronize(CHAT_PERSONAL, null)
                fail("Wrong-thread data must fail")
            } catch (_: ApiFailure.IncompatibleResponse) {}
        }

    @Test
    fun historyUsesRealDiskReopenAndRetiredWorkspaceCannotReadIt() = runTest {
        val root = temporary.newFolder()
        val store = cache(root)
        val lease = store.open(identity) { true }
        val value = checkpoint()
        lease.saveHistory(value, 100)
        assertEquals(value.rows, lease.loadHistory(CHAT_PERSONAL)!!.checkpoint.rows)
        store.close()
        val reopened = cache(root)
        val current = reopened.open(identity.copy(sessionId = "renewed")) { true }
        assertEquals(value, current.loadHistory(CHAT_PERSONAL)!!.checkpoint)
        val other = reopened.open(identity.copy(userId = "another")) { true }
        assertNull(other.loadHistory(CHAT_PERSONAL))
        try {
            current.saveHistory(value, 200)
            fail("Retired lease cannot write")
        } catch (_: kotlinx.coroutines.CancellationException) {}
        val revoked = reopened.open(identity.copy(authorizationScope = "changed")) { true }
        assertThrows(ApiFailure.IncompatibleResponse::class.java) {
            runBlocking { revoked.loadHistory(CHAT_PERSONAL) }
        }
    }

    @Test
    fun visibleReadEffectsAreSeparateFromLoadingAndThreadFailuresStayLocal() = runTest {
        val service = Service()
        val lease = cache().open(identity) { true }
        val failures = mutableListOf<Exception>()
        var indicators = 0
        val model =
            ConversationHistoryModel(
                service,
                lease,
                backgroundScope,
                { true },
                { failures += it },
                { indicators++ },
                StandardTestDispatcher(testScheduler),
            )
        model.open(thread())
        model.uiState.first { it.phase == HistoryPhase.Ready }
        assertEquals(0, service.markCount)
        assertEquals("agent-original", model.uiState.value.thread!!.agentId)
        model.setVisible(CHAT_PERSONAL, true)
        model.uiState.first { it.phase == HistoryPhase.Ready }
        model.setVisible(CHAT_PERSONAL, true)
        runCurrent()
        assertEquals(0, service.markCount)
        model.confirmDisplayed(CHAT_PERSONAL, model.uiState.value.confirmation)
        service.marked.await()
        runCurrent()
        assertEquals(1, service.markCount)
        assertEquals(1, indicators)
        model.setVisible(CHAT_PERSONAL, false)
        service.detailStatus = 404
        model.refresh()
        model.uiState.first { it.phase == HistoryPhase.Missing }
        assertNull(model.uiState.value.transcript)
        assertTrue(failures.isEmpty())
        model.close()
        lease.close()
    }

    @Test
    fun aNewlyDisplayedCheckpointIsMarkedAfterAnOlderReadRequestCompletes() = runTest {
        val firstRead = CompletableDeferred<Unit>()
        val releaseRead = CompletableDeferred<Unit>()
        val firstConfirmed = CompletableDeferred<Unit>()
        val service =
            object : Service() {
                override suspend fun markRead(threadId: String): ReadState {
                    markCount++
                    if (markCount == 1) {
                        firstRead.complete(Unit)
                        releaseRead.await()
                    }
                    return ReadState(CHAT_DATE)
                }
            }
        val lease = cache().open(identity) { true }
        val model =
            ConversationHistoryModel(
                service,
                lease,
                backgroundScope,
                { true },
                {},
                { firstConfirmed.complete(Unit) },
                StandardTestDispatcher(testScheduler),
            )
        try {
            model.open(thread())
            model.setVisible(CHAT_PERSONAL, true)
            model.uiState.first { it.phase == HistoryPhase.Ready }
            model.confirmDisplayed(CHAT_PERSONAL, model.uiState.value.confirmation)
            firstRead.await()
            val nextId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            service.rowsRead = { id, _ ->
                HistoryPage(
                    listOf(row(nextId, 53, id, payload = """{"content":"New reply"}""")),
                    HistoryCursor(nextId, 53),
                    false,
                )
            }
            model.refresh()
            model.uiState.first { it.phase == HistoryPhase.Ready }
            assertEquals(
                "New reply",
                model.uiState.value.transcript!!.messages.last().blocks.single().text,
            )
            model.confirmDisplayed(CHAT_PERSONAL, model.uiState.value.confirmation)
            assertEquals(1, service.markCount)
            releaseRead.complete(Unit)
            firstConfirmed.await()
            runCurrent()
            assertEquals(2, service.markCount)
        } finally {
            releaseRead.complete(Unit)
            model.close()
            lease.close()
        }
    }

    @Test
    fun staleDisplayReceiptsCannotMarkNewContentAndReadFailuresWaitForExplicitRetry() = runTest {
        var failRead = true
        val service =
            object : Service() {
                override suspend fun markRead(threadId: String): ReadState {
                    markCount++
                    if (failRead) throw ApiFailure.Http(503, null, null, null)
                    marked.complete(Unit)
                    return ReadState(CHAT_DATE)
                }
            }
        val lease = cache().open(identity) { true }
        val failures = mutableListOf<Exception>()
        val model =
            ConversationHistoryModel(
                service,
                lease,
                backgroundScope,
                { true },
                { failures += it },
                {},
                StandardTestDispatcher(testScheduler),
            )
        try {
            model.open(thread())
            model.setVisible(CHAT_PERSONAL, true)
            model.uiState.first { it.phase == HistoryPhase.Ready }
            val previous = model.uiState.value.confirmation
            val nextId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            service.rowsRead = { id, cursor ->
                if (cursor.seqId < 53)
                    HistoryPage(
                        listOf(row(nextId, 53, id, payload = """{"content":"New reply"}""")),
                        HistoryCursor(nextId, 53),
                        false,
                    )
                else HistoryPage(emptyList(), cursor, false)
            }
            model.refresh()
            model.uiState.first { it.phase == HistoryPhase.Ready }
            model.confirmDisplayed(CHAT_PERSONAL, previous)
            runCurrent()
            assertEquals(0, service.markCount)
            model.confirmDisplayed(CHAT_PERSONAL, model.uiState.value.confirmation)
            model.uiState.first { it.readFailed }
            runCurrent()
            assertEquals(1, service.markCount)
            assertTrue(failures.isEmpty())
            failRead = false
            model.refresh()
            model.uiState.first { it.phase == HistoryPhase.Ready }
            model.confirmDisplayed(CHAT_PERSONAL, model.uiState.value.confirmation)
            service.marked.await()
            runCurrent()
            assertEquals(2, service.markCount)
            assertFalse(model.uiState.value.readFailed)
        } finally {
            model.close()
            lease.close()
        }
    }

    @Test
    fun aDisplayReceiptFromAnEarlierSelectionCannotConfirmTheReopenedThread() = runTest {
        val service = Service()
        val lease = cache().open(identity) { true }
        val model =
            ConversationHistoryModel(
                service,
                lease,
                backgroundScope,
                { true },
                {},
                {},
                StandardTestDispatcher(testScheduler),
            )
        try {
            model.open(thread())
            model.setVisible(CHAT_PERSONAL, true)
            model.uiState.first { it.phase == HistoryPhase.Ready }
            val previous = model.uiState.value.confirmation
            model.open(thread(CHAT_IN_PROJECT))
            model.open(thread())
            model.setVisible(CHAT_PERSONAL, true)
            model.uiState.first { it.phase == HistoryPhase.Ready }
            model.confirmDisplayed(CHAT_PERSONAL, previous)
            runCurrent()
            assertEquals(0, service.markCount)
            model.confirmDisplayed(CHAT_PERSONAL, model.uiState.value.confirmation)
            service.marked.await()
            runCurrent()
            assertEquals(1, service.markCount)
        } finally {
            model.close()
            lease.close()
        }
    }

    @Test
    fun failedDiskWriteKeepsConfirmedMessagesAndRetriesWithoutADataLossFallback() = runTest {
        val root = temporary.newFile()
        val lease = cache(root).open(identity) { true }
        val service = Service()
        val model =
            ConversationHistoryModel(
                service,
                lease,
                backgroundScope,
                { true },
                {},
                {},
                StandardTestDispatcher(testScheduler),
            )
        model.open(thread())
        model.uiState.first { it.phase == HistoryPhase.Ready }
        assertTrue(model.uiState.value.cacheUnavailable)
        assertEquals(
            "**Native history** reply",
            model.uiState.value.transcript!!.messages.single().blocks.single().text,
        )
        assertTrue(root.delete())
        assertTrue(root.mkdir())
        model.refresh()
        model.uiState.first { it.phase == HistoryPhase.Ready }
        assertFalse(model.uiState.value.cacheUnavailable)
        assertEquals(37L, lease.loadHistory(CHAT_PERSONAL)!!.checkpoint.cursor.seqId)
        model.close()
        lease.close()
    }

    @Test
    fun replacedConversationIgnoresLateUncancellableResults() = runTest {
        val held = CompletableDeferred<Unit>()
        val started = CompletableDeferred<Unit>()
        val service = Service()
        service.rowsRead = { id, cursor ->
            if (id == CHAT_PERSONAL)
                withContext(NonCancellable) {
                    started.complete(Unit)
                    held.await()
                }
            if (cursor.seqId == 0L)
                HistoryPage(listOf(row(thread = id)), HistoryCursor(HISTORY_LAST_EVENT, 37), false)
            else HistoryPage(emptyList(), cursor, false)
        }
        val lease = cache().open(identity) { true }
        val model =
            ConversationHistoryModel(
                service,
                lease,
                backgroundScope,
                { true },
                {},
                {},
                StandardTestDispatcher(testScheduler),
            )
        model.open(thread())
        started.await()
        model.open(thread(CHAT_IN_PROJECT))
        model.uiState.first { it.phase == HistoryPhase.Ready }
        held.complete(Unit)
        runCurrent()
        assertEquals(CHAT_IN_PROJECT, model.uiState.value.thread!!.id)
        assertEquals(0, service.markCount)
        model.close()
        lease.close()
    }

    @Test
    fun projectionPreservesStructuredUnknownsRejectionsAndRevocationAndMarkdownCode() {
        val input =
            row(
                "input",
                2,
                type = "input.prompt",
                payload =
                    """{"userMessage":{"version":1,"parts":[{"type":"text","text":"hello"},{"type":"future","data":[null,7]}]}}""",
            )
        val rejected =
            row(
                "rejected",
                7,
                type = "input.rejected",
                payload =
                    """{"userMessage":{"version":1,"parts":[{"type":"text","text":"rejected content"}]},"error":"Not admitted"}""",
                revoke = "input",
            )
        val stopped =
            row(seq = 17, type = "run.cancelled", payload = """{"error":"Stopped by user"}""")
        val result =
            projectHistory(
                HistoryCheckpoint(
                    CHAT_PERSONAL,
                    listOf(input, rejected, stopped),
                    HistoryCursor(HISTORY_LAST_EVENT, 17),
                )
            )
        assertEquals(listOf("rejected", HISTORY_LAST_EVENT), result.messages.map { it.id })
        assertTrue(result.messages.first().rejected)
        assertEquals(HistoryExecution.Cancelled, result.execution)
        assertEquals("Stopped by user", result.messages.last().blocks.single().text)
        val raw =
            projectHistory(
                HistoryCheckpoint(CHAT_PERSONAL, listOf(input), HistoryCursor("input", 2))
            )
        assertEquals(HistoryBlockKind.Unsupported, raw.messages.single().blocks.last().kind)
        assertTrue(raw.messages.single().blocks.last().text.contains("future"))
        val terminal =
            row(seq = 17, type = "run.completed", payload = """{"content":"Final answer"}""")
        val budget =
            row(
                "budget",
                7,
                type = "input.budget",
                payload =
                    """{"userMessage":{"version":1,"parts":[{"type":"text","text":"More budget"}]}}""",
            )
        val content =
            projectHistory(
                HistoryCheckpoint(
                    CHAT_PERSONAL,
                    listOf(budget, terminal),
                    HistoryCursor(HISTORY_LAST_EVENT, 17),
                )
            )
        assertEquals(listOf("Final answer"), content.messages.flatMap { it.blocks }.map { it.text })
        val usage = row(type = "usage.recorded", payload = """{"usage":{"futureMetric":5}}""")
        assertEquals(
            "{\"futureMetric\":5}",
            projectHistory(
                    HistoryCheckpoint(
                        CHAT_PERSONAL,
                        listOf(usage),
                        HistoryCursor(HISTORY_LAST_EVENT, 37),
                    )
                )
                .messages
                .single()
                .blocks
                .single()
                .text,
        )
        val rendered =
            renderHistoryMarkdown(
                "# Heading\n\n**bold** and `code`\n\n```kotlin\nval x = 1\n```\n<script>literal</script>"
            )
        assertTrue(rendered.text.contains("Heading"))
        assertTrue(rendered.text.contains("val x = 1"))
        assertTrue(rendered.text.contains("<script>literal</script>"))
        assertTrue(rendered.spanStyles.isNotEmpty())
        val numbered = renderHistoryMarkdown("3. first\n    7. nested\n4. second\n")
        assertTrue(numbered.text.contains("3. first"))
        assertTrue(numbered.text.contains("7. nested"))
        assertTrue(numbered.text.contains("4. second"))
    }
}
