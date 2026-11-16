package ai.okou.android.chat

import ai.okou.android.TestRealtimeService
import ai.okou.android.api.ApiFailure
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ChatUpdatesModelTest {
    @Test
    fun disconnectRecoveryAndRetryInvalidateWithoutOwningTheCanonicalReads() = runTest {
        val external = TestRealtimeService()
        var reads = 0
        val owner = ChatUpdatesModel(external, backgroundScope, { true }, { throw it }) { reads++ }
        owner.foreground(true)
        runCurrent()
        val initial = reads
        repeat(100) { external.invalidate() }
        external.snapshot.value = external.snapshot.value.copy(phase = RealtimePhase.Unavailable)
        runCurrent()
        assertEquals(RealtimePhase.Unavailable, owner.phase.value)
        assertTrue(reads > initial)
        val disconnected = reads
        external.snapshot.value =
            external.snapshot.value.copy(
                phase = RealtimePhase.Connected,
                revision = external.snapshot.value.revision + 1,
                changes = ChatChanges(resync = true),
            )
        runCurrent()
        assertEquals(RealtimePhase.Connected, owner.phase.value)
        assertTrue(reads > disconnected)
        owner.close()
        runCurrent()
        assertEquals(external.opened.get(), external.closed.get())
    }

    @Test
    fun restartWaitsForOwnedCleanupAndRejectsOldCallbacksAndRetiredAuthorization() = runTest {
        val cleanup = CompletableDeferred<Unit>()
        val observers = mutableListOf<suspend (RealtimeSnapshot) -> Unit>()
        var active = true
        var reads = 0
        val service =
            object : RealtimeService {
                override suspend fun observeRealtime(
                    observe: suspend (RealtimeSnapshot) -> Unit
                ): Nothing {
                    observers += observe
                    try {
                        awaitCancellation()
                    } finally {
                        if (observers.size == 1) withContext(NonCancellable) { cleanup.await() }
                    }
                }
            }
        val owner = ChatUpdatesModel(service, backgroundScope, { active }, { throw it }) { reads++ }
        owner.foreground(true)
        runCurrent()
        owner.foreground(false)
        owner.foreground(true)
        owner.retry()
        owner.retry()
        runCurrent()
        assertEquals(1, observers.size)
        val old = observers.single()
        old(RealtimeSnapshot(RealtimePhase.Unavailable, 99, IOException("late")))
        assertEquals(RealtimePhase.Connecting, owner.phase.value)
        cleanup.complete(Unit)
        runCurrent()
        assertEquals(2, observers.size)
        observers.last()(RealtimeSnapshot(RealtimePhase.Connected, 1))
        runCurrent()
        assertEquals(RealtimePhase.Connected, owner.phase.value)
        val before = reads
        active = false
        observers.last()(
            RealtimeSnapshot(RealtimePhase.Unavailable, 2, ApiFailure.Unauthenticated())
        )
        runCurrent()
        assertEquals(before, reads)
        owner.close()
        assertEquals(RealtimePhase.Stopped, owner.phase.value)
    }

    @Test
    fun tokenFailureDoesNotPreventCanonicalForegroundReadAndKeepsAuthFailureOwned() = runTest {
        val errors = mutableListOf<Exception>()
        var reads = 0
        val owner =
            ChatUpdatesModel(
                object : RealtimeService {
                    override suspend fun observeRealtime(
                        observe: suspend (RealtimeSnapshot) -> Unit
                    ): Nothing = throw ApiFailure.Unauthenticated()
                },
                backgroundScope,
                { true },
                errors::add,
            ) {
                reads++
            }
        owner.foreground(true)
        runCurrent()
        assertEquals(1, reads)
        assertEquals(RealtimePhase.Unavailable, owner.phase.value)
        assertTrue(errors.single() is ApiFailure.Unauthenticated)
        owner.close()
    }

    @Test
    fun onlyCanonicalChatTopicsInvalidateConfirmedReads() {
        assertEquals(ChatChanges(list = true), chatChanges("threadListChanged"))
        assertEquals(ChatChanges(indicators = true), chatChanges("chatIndicatorsChanged"))
        assertEquals(ChatChanges(readCursor = true), chatChanges("chatThreadReadCursorUpdated"))
        val thread = "11111111-1111-4111-8111-111111111111"
        assertEquals(
            ChatChanges(threads = setOf(thread)),
            chatChanges("chatThreadMessageCreated:$thread"),
        )
        assertEquals(
            ChatChanges(threads = setOf(thread)),
            chatChanges("chatThreadDetailChanged:$thread"),
        )
        assertNull(chatChanges("chatThreadMessageCreated:not-a-thread"))
        assertNull(chatChanges("connector:changed"))
        assertNull(chatChanges(null))
    }
}
