package ai.okou.android.connectors

import ai.okou.android.api.ApiFailure
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancelAndJoin
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
    fun cachedEmptyResultsGetARefreshNoticeAfterThreeFailuresAndThirtySeconds() = runTest {
        var failing = true
        var attempts = 0
        var state = ConnectorRead(emptyList<String>())
        val read = launch {
            retryConnectorRead(
                read = {
                    attempts++
                    if (failing) throw unavailable()
                    listOf("Google Calendar")
                },
                canRead = { true },
                onError = {},
                publish = { state = it.retaining(state) },
            )
        }

        runCurrent()
        assertEquals(1, attempts)
        advanceTimeBy(5_000)
        runCurrent()
        assertEquals(2, attempts)
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(3, attempts)
        assertEquals(ConnectorRead(emptyList<String>(), ConnectorReadFailure.Recent), state)

        advanceTimeBy(14_999)
        runCurrent()
        assertEquals(ConnectorReadFailure.Recent, state.failure)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(3, attempts)
        assertEquals(ConnectorRead(emptyList<String>(), ConnectorReadFailure.Sustained), state)

        failing = false
        advanceTimeBy(5_000)
        read.join()
        assertEquals(4, attempts)
        assertEquals(listOf("Google Calendar"), state.data)
        assertNull(state.failure)
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
        assertEquals(ConnectorReadFailure.Recent, failure)

        thirdRead.complete(Unit)
        runCurrent()
        assertEquals(ConnectorReadFailure.Sustained, failure)
        read.cancelAndJoin()
        advanceTimeBy(60_000)
        assertEquals(3, attempts)
    }

    private fun unavailable() = ApiFailure.Http(503, null, null, null)
}
