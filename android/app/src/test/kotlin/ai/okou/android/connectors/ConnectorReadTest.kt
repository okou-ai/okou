package ai.okou.android.connectors

import ai.okou.android.api.ApiFailure
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ConnectorReadTest {
    @Test
    fun theThirdFailureEndsTheReadAndKeepsConfirmedEmptyContent() = runTest {
        var attempts = 0
        var state = ConnectorRead(emptyList<String>())
        val read = launch {
            retryConnectorRead<List<String>>(
                read = {
                    attempts++
                    throw unavailable()
                },
                canRead = { true },
                onError = {},
                publish = { state = it.retaining(state) },
            )
        }

        runCurrent()
        assertEquals(1, attempts)
        advanceTimeBy(2_999)
        runCurrent()
        assertEquals(1, attempts)
        assertNull(state.failure)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(2, attempts)
        assertNull(state.failure)
        advanceTimeBy(3_000)
        runCurrent()
        read.join()
        assertEquals(3, attempts)
        assertEquals(ConnectorRead(emptyList<String>(), ConnectorReadFailure.Sustained), state)
        advanceTimeBy(60_000)
        assertEquals(3, attempts)
    }

    @Test
    fun aPendingThirdReadDoesNotCountAsAFailure() = runTest {
        val thirdRead = CompletableDeferred<Unit>()
        var attempts = 0
        var failure: ConnectorReadFailure? = null
        val read = launch {
            retryConnectorRead<List<String>>(
                read = {
                    if (++attempts == 3) thirdRead.await()
                    throw unavailable()
                },
                canRead = { true },
                onError = {},
                publish = { failure = it.failure },
            )
        }
        advanceTimeBy(30_000)
        runCurrent()
        assertEquals(3, attempts)
        assertNull(failure)

        thirdRead.complete(Unit)
        runCurrent()
        assertEquals(ConnectorReadFailure.Sustained, failure)
        read.join()
        advanceTimeBy(60_000)
        assertEquals(3, attempts)
    }

    private fun unavailable() = ApiFailure.Http(503, null, null, null)
}
