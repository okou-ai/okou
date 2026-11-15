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
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class AblyRealtimeConnectionTest {
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
