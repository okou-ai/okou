package ai.okou.android.chat

import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class AblyRealtimeConnectionTest {
    @Test
    fun slowConsumerGetsAnOrderedPrefixThenDiscontinuityWithoutBreakingInvalidations() = runTest {
        AblyProtocolFixture().use { remote ->
            withContext(Dispatchers.IO) {
                AblyRealtimeConnection(
                        "user-a",
                        "org-a",
                        coroutineContext,
                        clientFactory = remote::client,
                        token = remote::signedRequest,
                    )
                    .use { sdk ->
                        repeat(2) { remote.attach(remote.attachments.receive()) }
                        sdk.state.first { it.phase == RealtimePhase.Connected }
                        val target =
                            RunOutputTarget(
                                "11111111-1111-4111-8111-111111111111",
                                "99999999-9999-4999-8999-999999999999",
                                1,
                            )
                        val name = "run-output:user-a:org-a:${target.runId}"
                        val entered = CompletableDeferred<Unit>()
                        val release = CompletableDeferred<Unit>()
                        val received = mutableListOf<RunOutputSignal>()
                        val job = launch {
                            sdk.runOutput(target).collect {
                                received += it
                                if (received.size == 1) {
                                    entered.complete(Unit)
                                    release.await()
                                }
                            }
                        }
                        assertEquals(name, remote.attachments.receive())
                        remote.attach(name)
                        fun wire(index: Int) =
                            """{"threadId":"${target.threadId}","runId":"${target.runId}","eventId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","runEventId":"message","createdAt":"2026-11-16T00:00:00Z","chunkIndex":$index,"delta":"prefix"}"""
                        try {
                            remote.output(name, target.runId, wire(0))
                            entered.await()
                            remote.outputBurst(name, target.runId, (1..100).map(::wire))
                            assertEquals(name, remote.detachments.receive())
                            release.complete(Unit)
                            job.join()
                            assertEquals(RunOutputSignal.Discontinuity, received.last())
                            assertEquals(
                                (0L..64L).toList(),
                                received.filterIsInstance<RunOutputSignal.Delta>().map {
                                    it.value.chunkIndex
                                },
                            )
                            val revision = sdk.state.value.revision
                            remote.message("user:user-a", "threadListChanged")
                            sdk.state.first { it.revision > revision }
                            assertEquals(RealtimePhase.Connected, sdk.state.value.phase)
                        } finally {
                            release.complete(Unit)
                            job.cancelAndJoin()
                        }
                    }
            }
        }
    }

    @Test
    fun realSdkUsesExistingConnectionForOutputAndDetachesOnlyItsRunChannel() = runTest {
        AblyProtocolFixture().use { remote ->
            withContext(Dispatchers.IO) {
                AblyRealtimeConnection(
                        "user-a",
                        "org-a",
                        coroutineContext,
                        clientFactory = remote::client,
                        token = remote::signedRequest,
                    )
                    .use { sdk ->
                        repeat(2) { remote.attach(remote.attachments.receive()) }
                        sdk.state.first { it.phase == RealtimePhase.Connected }
                        val target =
                            RunOutputTarget(
                                "11111111-1111-4111-8111-111111111111",
                                "99999999-9999-4999-8999-999999999999",
                                1,
                            )
                        val name = "run-output:user-a:org-a:${target.runId}"
                        val values = Channel<RunOutputSignal>(8)
                        suspend fun next(label: String): RunOutputSignal =
                            try {
                                withTimeout(5_000) { values.receive() }
                            } catch (error: TimeoutCancellationException) {
                                throw AssertionError("No SDK output for $label", error)
                            }
                        val job = launch { sdk.runOutput(target).collect { values.send(it) } }
                        assertEquals(name, remote.attachments.receive())
                        remote.attach(name)
                        val wire =
                            """{"threadId":"${target.threadId}","runId":"${target.runId}","eventId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","runEventId":"message","createdAt":"2026-11-16T00:00:00Z","chunkIndex":0,"delta":"prefix"}"""
                        remote.output(name, "other-event", wire)
                        remote.output(name, target.runId, wire)
                        assertEquals(
                            "prefix",
                            (next("object payload") as RunOutputSignal.Delta).value.delta,
                        )
                        remote.output(
                            name,
                            target.runId,
                            wire.replace("\"chunkIndex\":0", "\"chunkIndex\":1"),
                            encoded = false,
                        )
                        assertEquals(
                            1L,
                            (next("string payload") as RunOutputSignal.Delta).value.chunkIndex,
                        )
                        remote.output(name, target.runId, """{"invalid":true}""")
                        assertEquals(RunOutputSignal.Discontinuity, next("malformed payload"))
                        remote.attach(name)
                        assertEquals(RunOutputSignal.Discontinuity, next("reattachment"))
                        job.cancelAndJoin()
                        assertEquals(name, remote.detachments.receive())
                        assertEquals(RealtimePhase.Connected, sdk.state.value.phase)
                        assertEquals(1, remote.nonces.size)
                        assertTrue(values.tryReceive().isFailure)
                        values.close()
                    }
            }
        }
    }

    @Test
    fun outputRefinementsRejectMalformedIdentityTimeAndOrder() {
        val wire =
            """{"threadId":"11111111-1111-4111-8111-111111111111","runId":"99999999-9999-4999-8999-999999999999","eventId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","runEventId":"message","createdAt":"2026-11-16T00:00:00Z","chunkIndex":0,"delta":""}"""
        assertEquals("", decodeRunOutput(wire).delta)
        assertEquals("", decodeRunOutput(wire.replace("00:00:00Z", "00:00:00.123456789123Z")).delta)
        for (invalid in
            listOf(
                wire.replace("11111111-1111-4111-8111-111111111111", "invalid"),
                wire.replace("2026-11-16", "2026-02-31"),
                wire.replace("\"message\"", "\"\""),
                wire.replace("\"chunkIndex\":0", "\"chunkIndex\":-1"),
                wire.replace("\"chunkIndex\":0", "\"chunkIndex\":9007199254740992"),
            )) assertThrows(Exception::class.java) { decodeRunOutput(invalid) }
    }

    @Test
    fun realSdkTracksBothAttachmentsInvalidationsRenewalAndOwnedClose() = runTest {
        AblyProtocolFixture().use { remote ->
            withContext(Dispatchers.IO) {
                AblyRealtimeConnection(
                        "user-a",
                        "org-a",
                        coroutineContext,
                        clientFactory = remote::client,
                        token = remote::signedRequest,
                    )
                    .use { sdk ->
                        val channels =
                            setOf(remote.attachments.receive(), remote.attachments.receive())
                        assertEquals(setOf("user:user-a", "user-org:user-a:org-a"), channels)
                        val connection = sdk.state.first { it.revision > 0 }
                        remote.attach("user:user-a")
                        val partial = sdk.state.first { it.revision > connection.revision }
                        assertEquals(RealtimePhase.Connecting, partial.phase)
                        remote.attach("user-org:user-a:org-a")
                        val ready = sdk.state.first { it.phase == RealtimePhase.Connected }
                        assertEquals(ChatChanges(resync = true), sdk.takeObservation().changes)
                        remote.message(
                            "user-org:user-a:org-a",
                            "chatThreadMessageCreated:11111111-1111-4111-8111-111111111111",
                        )
                        val changed = sdk.state.first { it.revision > ready.revision }
                        assertEquals(RealtimePhase.Connected, changed.phase)
                        assertEquals(
                            ChatChanges(threads = setOf("11111111-1111-4111-8111-111111111111")),
                            sdk.takeObservation().changes,
                        )
                        remote.attach(
                            "user-org:user-a:org-a"
                        ) // ATTACHED without resumed means a continuity gap.
                        val gap = sdk.state.first { it.revision > changed.revision }
                        assertEquals(RealtimePhase.Connected, gap.phase)
                        assertEquals(ChatChanges(resync = true), sdk.takeObservation().changes)
                        remote.renew()
                        assertEquals("sdk-token-2", remote.authorizations.receive())
                        assertEquals(2, remote.nonces.size)
                        assertNotEquals(remote.nonces[0], remote.nonces[1])
                        remote.fail("user-org:user-a:org-a")
                        assertEquals(
                            RealtimePhase.Unavailable,
                            sdk.state.first { it.phase == RealtimePhase.Unavailable }.phase,
                        )
                    }
                remote.closed.await()
            }
        }
    }

    @Test
    fun mixedSdkTopicsSurviveAConflatedWakeupAndDrainWithoutLosingLaterDemand() = runTest {
        AblyProtocolFixture().use { remote ->
            withContext(Dispatchers.IO) {
                AblyRealtimeConnection(
                        "user-a",
                        "org-a",
                        coroutineContext,
                        clientFactory = remote::client,
                        token = remote::signedRequest,
                    )
                    .use { sdk ->
                        repeat(2) { remote.attach(remote.attachments.receive()) }
                        sdk.state.first { it.phase == RealtimePhase.Connected }
                        val baseline = sdk.takeObservation().revision
                        val first = "11111111-1111-4111-8111-111111111111"
                        val second = "55555555-5555-4555-8555-555555555555"
                        val topics =
                            listOf(
                                "threadListChanged",
                                "chatIndicatorsChanged",
                                "chatThreadReadCursorUpdated",
                                "chatThreadMessageCreated:$first",
                                "chatThreadDetailChanged:$second",
                                "chatThreadMessageCreated:$first",
                            )
                        topics.forEach { remote.message("user-org:user-a:org-a", it) }
                        sdk.state.first { it.revision >= baseline + topics.size }
                        assertEquals(
                            ChatChanges(
                                list = true,
                                indicators = true,
                                readCursor = true,
                                threads = setOf(first, second),
                            ),
                            sdk.takeObservation().changes,
                        )
                        assertEquals(ChatChanges(), sdk.takeObservation().changes)
                        remote.message("user-org:user-a:org-a", "chatThreadMessageCreated:$second")
                        sdk.state.first { it.revision > baseline + topics.size }
                        assertEquals(
                            ChatChanges(threads = setOf(second)),
                            sdk.takeObservation().changes,
                        )
                    }
                remote.closed.await()
            }
        }
    }

    @Test
    fun canonicalTokenFailureSurvivesLaterSdkStateCallbacksUntilTheObservationCloses() = runTest {
        val denied = ApiFailure.Unauthenticated()
        withContext(Dispatchers.IO) {
            AblyRealtimeConnection("user-a", "org-a", coroutineContext) { throw denied }
                .use { sdk -> assertEquals(denied, sdk.state.first { it.failure != null }.failure) }
        }
    }

    @Test
    fun realAndroidSdkStartsWithoutPushAndClosesWhileCanonicalTokenIsHeld() = runTest {
        val started = CompletableDeferred<Unit>()
        val ended = CompletableDeferred<Unit>()
        withContext(Dispatchers.IO) {
            AblyRealtimeConnection("user-a", "org-a", coroutineContext) {
                    started.complete(Unit)
                    try {
                        awaitCancellation()
                    } finally {
                        ended.complete(Unit)
                    }
                }
                .use { sdk ->
                    started.await()
                    assertEquals(RealtimePhase.Connecting, sdk.state.value.phase)
                }
            ended.await()
        }
    }
}
