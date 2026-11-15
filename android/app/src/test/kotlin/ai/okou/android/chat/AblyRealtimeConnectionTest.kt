package ai.okou.android.chat

import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class AblyRealtimeConnectionTest {
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
                        remote.message(
                            "user-org:user-a:org-a",
                            "chatThreadMessageCreated:11111111-1111-4111-8111-111111111111",
                        )
                        val changed = sdk.state.first { it.revision > ready.revision }
                        assertEquals(RealtimePhase.Connected, changed.phase)
                        remote.attach(
                            "user-org:user-a:org-a"
                        ) // ATTACHED without resumed means a continuity gap.
                        val gap = sdk.state.first { it.revision > changed.revision }
                        assertEquals(RealtimePhase.Connected, gap.phase)
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
