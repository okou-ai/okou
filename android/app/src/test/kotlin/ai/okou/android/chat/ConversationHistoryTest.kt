package ai.okou.android.chat

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatListApiFixture
import ai.okou.android.HISTORY_LAST_EVENT
import ai.okou.android.HISTORY_RUN
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
import java.io.IOException
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

    @Test
    fun readingAnchorSurvivesReopenAndStaysScopedToAccountWorkspaceAndThread() = runTest {
        val directory = temporary.newFolder()
        val anchor = ConversationAnchor(HISTORY_LAST_EVENT, -27f)
        val original = cache(directory)
        original.open(identity) { true }.saveReadingAnchor(CHAT_PERSONAL, anchor)
        original.close()

        val reopened = cache(directory)
        assertNull(
            reopened
                .open(identity.copy(userId = "other-user")) { true }
                .loadReadingAnchor(CHAT_PERSONAL)
        )
        assertNull(
            reopened
                .open(identity.copy(workspaceId = "other-workspace")) { true }
                .loadReadingAnchor(CHAT_PERSONAL)
        )
        val lease = reopened.open(identity.copy(sessionId = "renewed")) { true }
        assertNull(lease.loadReadingAnchor(CHAT_IN_PROJECT))
        assertEquals(anchor, lease.loadReadingAnchor(CHAT_PERSONAL))
        lease.saveReadingAnchor(CHAT_PERSONAL, null)
        assertNull(lease.loadReadingAnchor(CHAT_PERSONAL))
    }

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
                """{"chatThreads":[{"id":"$id","projectId":"project-original","title":"History thread","sortAt":"$CHAT_DATE","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","pinnedAt":null,"archived":false,"renamedAt":null}]}"""
            )
            .chatThreads
            .single()

    private open class Service : TestChatService() {
        val requested = mutableListOf<HistoryCursor>()
        val marked = CompletableDeferred<Unit>()
        var markCount = 0
        var threadStatus: Int? = null
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
            threadStatus?.let { throw ApiFailure.Http(it, null, null, null) }
            return ThreadDetail(null, false)
        }

        override suspend fun historySnapshot(threadId: String): HistorySnapshot {
            threadStatus?.let { throw ApiFailure.Http(it, "CHAT_THREAD_NOT_FOUND", null, null) }
            throw ApiFailure.Http(404, "CHAT_EVENT_SNAPSHOT_NOT_FOUND", null, null)
        }

        override suspend fun historyRows(threadId: String, cursor: HistoryCursor): HistoryPage {
            threadStatus?.let { throw ApiFailure.Http(it, "CHAT_THREAD_NOT_FOUND", null, null) }
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
            val requests = List(4) { fixture.server.takeRequest() }
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
        service.threadStatus = 404
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
        val value =
            HistoryCheckpoint(
                CHAT_PERSONAL,
                listOf(row(type = "run.failed", payload = """{"error":"private diagnostic"}""")),
                HistoryCursor(HISTORY_LAST_EVENT, 37),
            )
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
    fun historyReadbackReusesCommittedRowsAndLoadsARebuiltPrefix() = runTest {
        val lease = cache().open(identity) { true }
        val incoming = checkpoint().copy(replaced = true)
        val initialWrite = checkNotNull(lease.saveHistory(incoming, 100))
        val matching = checkNotNull(lease.loadHistory(CHAT_PERSONAL, initialWrite))
        assertSame(incoming.rows, matching.checkpoint.rows)
        assertFalse(matching.checkpoint.replaced)
        assertEquals(100L, matching.confirmedAt)

        val addition = row(id = "another-event", seq = 38)
        val newer =
            matching.checkpoint.copy(
                rows = incoming.rows + addition,
                cursor = HistoryCursor(addition.id, addition.seqId),
            )
        val append = checkNotNull(lease.saveHistory(newer, 200, matching))
        assertSame(newer.rows, lease.loadHistory(CHAT_PERSONAL, append)?.checkpoint?.rows)

        val archived = row(id = "archived-event", seq = 36)
        val rebuilt = newer.copy(rows = listOf(archived) + newer.rows, replaced = true)
        lease.saveWarmedHistory(rebuilt, 200, newer.cursor) { null }
        val adopted = checkNotNull(lease.loadHistory(CHAT_PERSONAL, append))
        assertEquals(rebuilt.copy(replaced = false), adopted.checkpoint)
        assertEquals(200L, adopted.confirmedAt)

        val tail = row(id = "tail-event", seq = 39)
        val staleAppend =
            newer.copy(rows = newer.rows + tail, cursor = HistoryCursor(tail.id, tail.seqId))
        val staleWrite = lease.saveHistory(staleAppend, 300, append)
        assertNull(staleWrite)
        val persisted = checkNotNull(lease.loadHistory(CHAT_PERSONAL))
        assertEquals(rebuilt.rows + tail, persisted.checkpoint.rows)
    }

    @Test
    fun unchangedCatchUpReusesTheCachedTranscriptAndProjectsNewEvents() = runTest {
        val baseline = checkpoint()
        val started = CompletableDeferred<HistoryCursor>()
        val response = CompletableDeferred<HistoryPage>()
        val service =
            Service().apply {
                rowsRead = { _, cursor ->
                    started.complete(cursor)
                    response.await()
                }
            }
        val lease = cache().open(identity) { true }
        lease.saveHistory(baseline, 100)
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
            assertEquals(baseline.cursor, started.await())
            val cached = model.uiState.value
            val transcript = checkNotNull(cached.transcript)
            assertEquals(ChatListSource.Cache, cached.source)
            assertNull(cached.confirmation)

            response.complete(HistoryPage(emptyList(), baseline.cursor, false))
            val unchanged = model.uiState.first { it.phase == HistoryPhase.Ready }
            assertSame(transcript, unchanged.transcript)
            assertEquals(ChatListSource.Network, unchanged.source)
            assertEquals(baseline.cursor, unchanged.confirmation?.cursor)

            val added = row(id = "tail-event", seq = 38)
            val cursor = HistoryCursor(added.id, added.seqId)
            service.rowsRead = { _, _ -> HistoryPage(listOf(added), cursor, false) }
            model.refresh()
            val changed = model.uiState.first { it.phase == HistoryPhase.Ready }
            assertNotSame(transcript, changed.transcript)
            assertEquals(
                listOf(HISTORY_LAST_EVENT, added.id),
                changed.transcript?.messages?.map { it.id },
            )
            assertEquals(cursor, changed.confirmation?.cursor)
        } finally {
            model.close()
            lease.close()
        }
    }

    @Test
    fun reopeningAdoptsThePrefixRebuiltByWarmingAtTheSameCursor() = runTest {
        val baseline = checkpoint()
        val archived = row(id = "archived-event", seq = 36)
        val warmed = baseline.copy(rows = listOf(archived) + baseline.rows, replaced = true)
        val service = Service()
        val lease = cache().open(identity) { true }
        lease.saveHistory(baseline, 100)
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
            val initial = model.uiState.first { it.phase == HistoryPhase.Ready }
            model.open(thread(CHAT_IN_PROJECT))
            model.uiState.first { it.phase == HistoryPhase.Ready }
            lease.saveWarmedHistory(warmed, 200, baseline.cursor) { model.uiState.value.thread?.id }

            model.open(thread())
            assertSame(initial.transcript, model.uiState.value.transcript)
            val published = model.uiState.first { it.phase == HistoryPhase.Ready }
            assertEquals(baseline.cursor, service.requested.last())
            assertNotSame(initial.transcript, published.transcript)
            assertEquals(warmed.rows.map { it.id }, published.transcript?.messages?.map { it.id })
            assertEquals(baseline.cursor, published.confirmation?.cursor)
        } finally {
            model.close()
            lease.close()
        }
    }

    @Test
    fun anInFlightCatchUpPublishesTheNewerStoredCursor() = runTest {
        val received = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val baseline = checkpoint()
        val older = row(id = "older-event", seq = 38)
        val newer = row(id = "newer-event", seq = 39)
        val service =
            Service().apply {
                rowsRead = { _, _ ->
                    received.complete(Unit)
                    release.await()
                    HistoryPage(listOf(older), HistoryCursor(older.id, older.seqId), false)
                }
            }
        val lease = cache().open(identity) { true }
        lease.saveHistory(baseline, 100)
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
            received.await()
            val stored =
                baseline.copy(
                    rows = baseline.rows + listOf(older, newer),
                    cursor = HistoryCursor(newer.id, newer.seqId),
                )
            lease.saveHistory(stored, 200)
            release.complete(Unit)
            val published = model.uiState.first { it.phase == HistoryPhase.Ready }
            assertEquals(stored.cursor, published.confirmation?.cursor)
            assertEquals(stored, model.checkpoint(CHAT_PERSONAL))
            assertEquals(stored, lease.loadHistory(CHAT_PERSONAL)?.checkpoint)
        } finally {
            model.close()
            lease.close()
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
        assertEquals(CHAT_PERSONAL, model.uiState.value.thread!!.id)
        val visit = checkNotNull(model.beginVisit(CHAT_PERSONAL, model.uiState.value.generation))
        model.uiState.first { it.phase == HistoryPhase.Ready }
        runCurrent()
        assertEquals(0, service.markCount)
        visit.confirmDisplayed(checkNotNull(model.uiState.value.confirmation))
        service.marked.await()
        runCurrent()
        assertEquals(1, service.markCount)
        assertEquals(1, indicators)
        visit.close()
        service.threadStatus = 404
        model.refresh()
        model.uiState.first { it.phase == HistoryPhase.Missing }
        assertNull(model.uiState.value.transcript)
        assertTrue(failures.isEmpty())
        model.close()
        lease.close()
    }

    @Test
    fun cachedRunSubscribesBeforeNetworkAndOldVisitCleanupCannotRetireItsReplacement() = runTest {
        val held = CompletableDeferred<Unit>()
        val service = Service()
        service.rowsRead = { _, cursor ->
            held.await()
            HistoryPage(emptyList(), cursor, false)
        }
        val lease = cache().open(identity) { true }
        lease.saveHistory(checkpoint(), 100)
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
            val first =
                checkNotNull(model.beginVisit(CHAT_PERSONAL, model.uiState.value.generation))
            model.uiState.first { it.source == ChatListSource.Cache }
            assertEquals(HISTORY_RUN, model.output.target.value?.runId)
            held.complete(Unit)
            model.uiState.first { it.phase == HistoryPhase.Ready }
            assertEquals(HISTORY_RUN, model.output.target.value?.runId)
            val second =
                checkNotNull(model.beginVisit(CHAT_PERSONAL, model.uiState.value.generation))
            val target = model.output.target.value
            assertEquals(ChatListSource.Network, model.uiState.value.source)
            model.endVisit(first)
            assertEquals(target, model.output.target.value)
            model.uiState.first { it.phase == HistoryPhase.Ready }
            assertEquals(target, model.output.target.value)
            service.rowsRead = { id, cursor ->
                if (cursor.seqId == 0L)
                    HistoryPage(
                        listOf(row(thread = id)),
                        HistoryCursor(HISTORY_LAST_EVENT, 37),
                        false,
                    )
                else HistoryPage(emptyList(), cursor, false)
            }
            model.open(thread(CHAT_IN_PROJECT))
            model.uiState.first { it.phase == HistoryPhase.Ready }
            assertNull(model.output.target.value)
            model.endVisit(second)
            assertNull(model.output.target.value)
            val third =
                checkNotNull(model.beginVisit(CHAT_IN_PROJECT, model.uiState.value.generation))
            assertEquals(CHAT_IN_PROJECT, model.output.target.value?.threadId)
            model.endVisit(third)
            assertNull(model.output.target.value)
        } finally {
            held.complete(Unit)
            model.close()
            lease.close()
        }
    }

    @Test
    fun reopeningUnchangedHistoryConfirmsReadStateClearedElsewhere() = runTest {
        var serverReadAt: String? = null
        val service =
            object : Service() {
                override suspend fun threadDetail(threadId: String) =
                    ThreadDetail(serverReadAt, false)

                override suspend fun markRead(threadId: String): ReadState {
                    serverReadAt = CHAT_DATE
                    return super.markRead(threadId)
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
                {},
                StandardTestDispatcher(testScheduler),
            )
        try {
            model.open(thread())
            var visit =
                checkNotNull(model.beginVisit(CHAT_PERSONAL, model.uiState.value.generation))
            model.uiState.first { it.phase == HistoryPhase.Ready }
            visit.confirmDisplayed(checkNotNull(model.uiState.value.confirmation))
            service.marked.await()
            runCurrent()
            assertEquals(CHAT_DATE, serverReadAt)
            val previous = model.uiState.value

            visit.close()
            // The canonical mark-unread endpoint clears this without changing history rows.
            serverReadAt = null
            visit = checkNotNull(model.beginVisit(CHAT_PERSONAL, model.uiState.value.generation))
            val refreshed = model.uiState.first { it.phase == HistoryPhase.Ready }
            val previousConfirmation = checkNotNull(previous.confirmation)
            val newConfirmation = checkNotNull(refreshed.confirmation)
            assertSame(previous.transcript, refreshed.transcript)
            assertEquals(previousConfirmation.cursor, newConfirmation.cursor)
            assertTrue(newConfirmation.revision > previousConfirmation.revision)
            assertNull(serverReadAt)
            visit.confirmDisplayed(newConfirmation)
            runCurrent()
            assertEquals(CHAT_DATE, serverReadAt)
            assertEquals(2, service.markCount)
            visit.confirmDisplayed(checkNotNull(model.uiState.value.confirmation))
            runCurrent()
            assertEquals(2, service.markCount)
        } finally {
            model.close()
            lease.close()
        }
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
            val visit =
                checkNotNull(model.beginVisit(CHAT_PERSONAL, model.uiState.value.generation))
            model.uiState.first { it.phase == HistoryPhase.Ready }
            visit.confirmDisplayed(checkNotNull(model.uiState.value.confirmation))
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
            visit.confirmDisplayed(checkNotNull(model.uiState.value.confirmation))
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
    fun explicitUnreadWaitsForAcknowledgementAndStopsTheVisibleVisitOnly() = runTest {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val explicitWrite = CompletableDeferred<Unit>()
        val service =
            object : Service() {
                override suspend fun markRead(threadId: String): ReadState {
                    started.complete(Unit)
                    release.await()
                    return super.markRead(threadId)
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
                {},
                StandardTestDispatcher(testScheduler),
                precedingReadWrite = { if (started.isCompleted) explicitWrite else null },
            )
        try {
            model.open(thread())
            val visit =
                checkNotNull(model.beginVisit(CHAT_PERSONAL, model.uiState.value.generation))
            model.uiState.first { it.phase == HistoryPhase.Ready }
            visit.confirmDisplayed(checkNotNull(model.uiState.value.confirmation))
            started.await()
            val stopped = checkNotNull(visit.pendingAutomaticRead)
            visit.stopAutomaticRead()
            assertFalse(stopped.isCompleted)

            val nextId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            service.rowsRead = { id, cursor ->
                if (cursor.seqId >= 53) HistoryPage(emptyList(), cursor, false)
                else HistoryPage(listOf(row(nextId, 53, id)), HistoryCursor(nextId, 53), false)
            }
            model.refresh()
            model.uiState.first { it.phase == HistoryPhase.Ready }
            visit.confirmDisplayed(checkNotNull(model.uiState.value.confirmation))
            release.complete(Unit)
            stopped.join()
            runCurrent()
            assertEquals(1, service.markCount)

            model.endVisit(visit)
            val next = checkNotNull(model.beginVisit(CHAT_PERSONAL, model.uiState.value.generation))
            model.uiState.first { it.phase == HistoryPhase.Ready }
            next.confirmDisplayed(checkNotNull(model.uiState.value.confirmation))
            runCurrent()
            assertEquals(1, service.markCount)
            explicitWrite.complete(Unit)
            runCurrent()
            assertEquals(2, service.markCount)
        } finally {
            release.complete(Unit)
            explicitWrite.complete(Unit)
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
            val visit =
                checkNotNull(model.beginVisit(CHAT_PERSONAL, model.uiState.value.generation))
            model.uiState.first { it.phase == HistoryPhase.Ready }
            val previous = checkNotNull(model.uiState.value.confirmation)
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
            visit.confirmDisplayed(previous)
            runCurrent()
            assertEquals(0, service.markCount)
            visit.confirmDisplayed(checkNotNull(model.uiState.value.confirmation))
            visit.readState.first { it == HistoryReadState.Failed }
            runCurrent()
            assertEquals(1, service.markCount)
            visit.confirmDisplayed(checkNotNull(model.uiState.value.confirmation))
            runCurrent()
            assertEquals(1, service.markCount)
            assertTrue(failures.isEmpty())
            failRead = false
            model.refresh()
            model.uiState.first { it.phase == HistoryPhase.Ready }
            visit.confirmDisplayed(checkNotNull(model.uiState.value.confirmation))
            service.marked.await()
            runCurrent()
            assertEquals(2, service.markCount)
            assertEquals(HistoryReadState.Confirmed, visit.readState.value)
        } finally {
            model.close()
            lease.close()
        }
    }

    @Test
    fun revisitingImmediatelyShowsTheConfirmedTimelineWhileCatchUpIsHeld() = runTest {
        val lease = cache().open(identity) { true }
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
        val started = CompletableDeferred<HistoryCursor>()
        val response = CompletableDeferred<HistoryPage>()
        try {
            model.open(thread())
            val original = model.uiState.first { it.phase == HistoryPhase.Ready }
            model.open(thread(CHAT_IN_PROJECT))
            model.uiState.first { it.phase == HistoryPhase.Ready }
            val read = service.rowsRead
            service.rowsRead = { id, cursor ->
                if (id == CHAT_PERSONAL) {
                    started.complete(cursor)
                    response.await()
                } else read(id, cursor)
            }

            model.open(thread())
            val revisited = model.uiState.value
            assertSame(original.transcript, revisited.transcript)
            assertEquals(ChatListSource.Cache, revisited.source)
            assertNull(revisited.confirmation)
            val visit = checkNotNull(model.beginVisit(CHAT_PERSONAL, revisited.generation))
            visit.confirmDisplayed(checkNotNull(original.confirmation))
            assertEquals(original.confirmation.cursor, started.await())
            assertEquals(0, service.markCount)

            response.completeExceptionally(IOException("history unavailable"))
            val failed = model.uiState.first { it.phase == HistoryPhase.Failed }
            assertSame(original.transcript, failed.transcript)
            assertNull(failed.confirmation)
            service.rowsRead = read
            model.refresh()
            val refreshed = model.uiState.first { it.phase == HistoryPhase.Ready }
            assertEquals(revisited.generation, checkNotNull(refreshed.confirmation).generation)
            assertEquals(0, service.markCount)
        } finally {
            model.close()
            lease.close()
        }
    }

    @Test
    fun onlyRecentAccessibleTimelinesAreRestoredImmediately() = runTest {
        val lease = cache().open(identity) { true }
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
        try {
            for (id in listOf(CHAT_PERSONAL, CHAT_IN_PROJECT, "third", "fourth", "fifth")) {
                model.open(thread(id))
                model.uiState.first { it.phase == HistoryPhase.Ready }
            }
            model.open(thread())
            assertNull(model.uiState.value.transcript)
            model.uiState.first { it.phase == HistoryPhase.Ready }
            model.open(thread("fifth"))
            assertNotNull(model.uiState.value.transcript)
            model.uiState.first { it.phase == HistoryPhase.Ready }
            model.forgetWarmedHistory(CHAT_PERSONAL)
            model.open(thread())
            assertNull(model.uiState.value.transcript)
            model.uiState.first { it.phase == HistoryPhase.Ready }

            service.threadStatus = 403
            model.refresh()
            assertNull(model.uiState.first { it.phase == HistoryPhase.Missing }.transcript)
            model.open(thread("fifth"))
            model.open(thread())
            assertNull(model.uiState.value.transcript)
        } finally {
            model.close()
            lease.close()
        }
        assertNull(model.uiState.value.transcript)
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
            var visit =
                checkNotNull(model.beginVisit(CHAT_PERSONAL, model.uiState.value.generation))
            model.uiState.first { it.phase == HistoryPhase.Ready }
            val previous = checkNotNull(model.uiState.value.confirmation)
            val earlierVisit = visit
            model.open(thread(CHAT_IN_PROJECT))
            model.open(thread())
            visit = checkNotNull(model.beginVisit(CHAT_PERSONAL, model.uiState.value.generation))
            model.uiState.first { it.phase == HistoryPhase.Ready }
            earlierVisit.confirmDisplayed(checkNotNull(model.uiState.value.confirmation))
            visit.confirmDisplayed(previous)
            runCurrent()
            assertEquals(0, service.markCount)
            visit.confirmDisplayed(checkNotNull(model.uiState.value.confirmation))
            service.marked.await()
            runCurrent()
            assertEquals(1, service.markCount)
        } finally {
            model.close()
            lease.close()
        }
    }

    @Test
    fun aClosedVisitCannotAcknowledgeOrPublishIntoAReopenedVisit() = runTest {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var publications = 0
        val service =
            object : Service() {
                override suspend fun markRead(threadId: String): ReadState {
                    markCount++
                    if (markCount == 1)
                        withContext(NonCancellable) {
                            started.complete(Unit)
                            release.await()
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
                { publications++ },
                StandardTestDispatcher(testScheduler),
            )
        try {
            model.open(thread())
            val old = checkNotNull(model.beginVisit(CHAT_PERSONAL, model.uiState.value.generation))
            model.uiState.first { it.phase == HistoryPhase.Ready }
            val transcript = model.uiState.value.transcript
            old.confirmDisplayed(checkNotNull(model.uiState.value.confirmation))
            started.await()
            old.close()
            val next = checkNotNull(model.beginVisit(CHAT_PERSONAL, model.uiState.value.generation))
            model.uiState.first { it.phase == HistoryPhase.Ready }
            assertEquals(transcript, model.uiState.value.transcript)
            val displayed = checkNotNull(model.uiState.value.confirmation)
            old.confirmDisplayed(displayed)
            runCurrent()
            assertEquals(1, service.markCount)
            next.confirmDisplayed(displayed)
            next.readState.first { it == HistoryReadState.Confirmed }
            assertEquals(2, service.markCount)
            assertEquals(1, publications)
            release.complete(Unit)
            runCurrent()
            assertEquals(1, publications)
            assertEquals(HistoryReadState.Confirmed, next.readState.value)
        } finally {
            release.complete(Unit)
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
        val unsaved = model.uiState.first { it.phase == HistoryPhase.Ready }
        assertTrue(unsaved.cacheUnavailable)
        assertEquals(
            "**Native history** reply",
            unsaved.transcript!!.messages.single().blocks.single().text,
        )
        assertTrue(root.delete())
        assertTrue(root.mkdir())
        model.refresh()
        val repaired = model.uiState.first { it.phase == HistoryPhase.Ready }
        assertFalse(repaired.cacheUnavailable)
        assertEquals(unsaved.transcript, repaired.transcript)
        assertEquals(checkpoint().cursor, repaired.confirmation?.cursor)
        assertEquals(
            repaired.confirmation?.cursor,
            lease.loadHistory(CHAT_PERSONAL)?.checkpoint?.cursor,
        )
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
        assertEquals("run.cancelled", result.messages.last().status)
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
        val table =
            conversationMarkdownForCopy("| Check | Status |\n| --- | --- |\n| Links | Done |")
        assertEquals("Check\tStatus\nLinks\tDone", table)
    }

    @Test
    fun artifactMarkdownKeepsTightListsAndParagraphBreaks() {
        val source = "1. First\n2. Second\n\nA paragraph.\n\nAnother paragraph."
        assertEquals(
            "1. First\n2. Second\n\nA paragraph.\n\nAnother paragraph.",
            renderHistoryMarkdown(source, compactLists = true).text,
        )
        assertTrue(renderHistoryMarkdown(source).text.contains("First\n\n2. Second"))
        assertTrue(
            renderHistoryMarkdown("# Checklist", compactLists = true).spanStyles.isNotEmpty()
        )
    }
}
