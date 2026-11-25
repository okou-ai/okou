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

    @Test
    fun serverDelayExtendsOnlyTheAttemptThatSuppliesIt() = runTest {
        val attempts = mutableListOf<Long>()
        var result: ConnectorRead<String>? = null
        val read = launch {
            retryConnectorRead(
                read = {
                    attempts += testScheduler.currentTime
                    when (attempts.size) {
                        1 -> throw ApiFailure.Http(429, null, null, 8)
                        2 -> throw ApiFailure.Http(408, null, null, 1)
                        else -> "ready"
                    }
                },
                canRead = { true },
                onError = {},
                publish = { result = it },
            )
        }

        advanceTimeBy(7_999)
        runCurrent()
        assertEquals(listOf(0L), attempts)
        advanceTimeBy(3_001)
        runCurrent()
        read.join()
        assertEquals(listOf(0L, 8_000L, 11_000L), attempts)
        assertEquals(ConnectorRead("ready"), result)
    }

    @Test
    fun cancellingTheRetryWaitStopsAttemptsAndPublication() = runTest {
        var attempts = 0
        var result: ConnectorRead<String>? = null
        val read = launch {
            retryConnectorRead<String>(
                read = {
                    attempts++
                    throw unavailable()
                },
                canRead = { true },
                onError = {},
                publish = { result = it },
            )
        }

        runCurrent()
        read.cancelAndJoin()
        advanceTimeBy(30_000)
        assertEquals(1, attempts)
        assertNull(result)
    }

    @Test
    fun authorizationAndIncompatibleResponsesAreTerminal() = runTest {
        val failures =
            listOf(
                ApiFailure.Http(401, null, null, 8) to ConnectorReadFailure.Sustained,
                ApiFailure.Http(403, null, null, 8) to ConnectorReadFailure.Unavailable,
                ApiFailure.Http(404, null, null, 8) to ConnectorReadFailure.Unavailable,
                ApiFailure.IncompatibleResponse() to ConnectorReadFailure.Sustained,
            )
        for ((failure, expected) in failures) {
            val startedAt = testScheduler.currentTime
            val reported = mutableListOf<Exception>()
            val published = mutableListOf<ConnectorRead<String>>()
            retryConnectorRead<String>(
                read = { throw failure },
                canRead = { true },
                onError = { reported += it },
                publish = { published += it },
            )
            assertEquals(listOf(failure), reported)
            assertEquals(listOf(ConnectorRead<String>(failure = expected)), published)
            assertEquals(startedAt, testScheduler.currentTime)
        }
    }

    @Test
    fun retiringTheReadScopeStopsRetriesAndPublication() = runTest {
        var current = true
        var attempts = 0
        var result: ConnectorRead<String>? = null
        val read = launch {
            retryConnectorRead<String>(
                read = {
                    attempts++
                    throw unavailable()
                },
                canRead = { current },
                onError = {},
                publish = { result = it },
            )
        }
        runCurrent()
        current = false
        advanceTimeBy(3_000)
        read.join()
        assertEquals(1, attempts)
        assertNull(result)
    }

    private fun unavailable() = ApiFailure.Http(503, null, null, null)
}
