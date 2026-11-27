package ai.okou.android.connectors

import ai.okou.android.CONNECTOR_CALENDAR
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.api.ApiFailure
import ai.okou.android.chat.ComposerTarget
import java.util.concurrent.CountDownLatch
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TestTimeSource
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ConnectorReadTest {
    @Test
    fun openingAServiceChecksAccountAndPolicyExpiryIndependently() = runBlocking {
        ConnectorApiFixture().use { fixture ->
            fixture.memberAccess = true
            val clock = TestTimeSource()
            val owner = SupervisorJob(coroutineContext.job)
            val options =
                ChatConnectorOptions(
                    fixture.service,
                    CoroutineScope(coroutineContext + owner),
                    { true },
                    clock,
                ) {
                    throw AssertionError(it)
                }
            val target = ComposerTarget()
            val slug = CONNECTOR_CALENDAR
            val gate = CountDownLatch(1)
            val secondPolicyReply = CountDownLatch(1)
            fixture.policyReadReplyGate = gate
            val accountRead = "/api/connector-accounts/connections" to slug
            val policyRead = "/api/connector-account-access/policies" to slug

            suspend fun awaitDetails(predicate: (ChatConnectorDetails) -> Boolean) =
                withTimeout(10.seconds) {
                    options.state
                        .first { it.details[slug]?.let(predicate) == true }
                        .details
                        .getValue(slug)
                }

            try {
                options.activate(target.key)
                options.showOverview(target, opening = true)
                withTimeout(10.seconds) { options.state.first { it.overview.data != null } }
                options.showAccounts(target, slug, opening = true)
                val accountSnapshot = awaitDetails { it.accounts.data != null }.accounts
                clock += 1.minutes
                gate.countDown()
                val policySnapshot = awaitDetails { it.policies.data != null }.policies

                clock += 9.minutes
                assertEquals(accountSnapshot, options.state.value.details[slug]?.accounts)
                options.showAccounts(target, slug, opening = true)
                val refreshingAccounts = awaitDetails { it.accounts.data == null }
                assertEquals(policySnapshot, refreshingAccounts.policies)
                val renewed = awaitDetails { it.accounts.data != null }
                assertEquals(2, fixture.chatConnectorReads.count { it == accountRead })
                assertEquals(1, fixture.chatConnectorReads.count { it == policyRead })

                clock += 1.minutes
                fixture.policyReadReplyGate = secondPolicyReply
                options.showAccounts(target, slug, opening = true)
                val refreshingPolicies = awaitDetails { it.policies.data == null }
                assertEquals(renewed.accounts, refreshingPolicies.accounts)

                clock += 9.minutes
                options.showAccounts(target, slug, opening = true)
                assertNull(options.state.value.details[slug]?.accounts?.data)
                awaitDetails { it.accounts.data != null }
                secondPolicyReply.countDown()
                val final = awaitDetails { it.policies.data != null }
                assertNotNull(final.policies.confirmedAt)
                assertTrue(final.policies != policySnapshot)
                assertEquals(3, fixture.chatConnectorReads.count { it == accountRead })
                assertEquals(2, fixture.chatConnectorReads.count { it == policyRead })
            } finally {
                gate.countDown()
                secondPolicyReply.countDown()
                owner.cancelAndJoin()
            }
        }
    }

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
    fun serverDelayCanBeLongerOrShorterThanTheDefault() = runTest {
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
        advanceTimeBy(1_001)
        runCurrent()
        read.join()
        assertEquals(listOf(0L, 8_000L, 9_000L), attempts)
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
