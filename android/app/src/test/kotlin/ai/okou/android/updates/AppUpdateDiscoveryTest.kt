package ai.okou.android.updates

import ai.okou.android.api.generated.AndroidUpdates
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AppUpdateDiscoveryTest {
    @Test
    fun automaticChecksUseLastSuccessfulDiscoveryAcrossProcesses() = runTest {
        val store = MemoryUpdateStore()
        val original =
            ControlledUpdates().apply { response = AndroidUpdates(null, updateRelease("0.12.0")) }
        val dispatcher = StandardTestDispatcher(testScheduler)
        var now = 100_000L
        AppUpdates(original, store, "0.12.0", 35, dispatcher, { now }).use { owner ->
            owner.check(false)
            advanceUntilIdle()
            assertEquals(UpdateCheck.Checked, owner.state.value.check)
        }
        runCurrent()
        val service = ControlledUpdates().apply { heldCheck = CompletableDeferred() }
        AppUpdates(service, store, "0.12.0", 35, dispatcher, { now }).use { owner ->
            owner.check(false)
            runCurrent()
            assertEquals(UpdateCheck.Checked, owner.state.value.check)
            assertEquals(0, service.checks)
            now += 600_000
            owner.check(false)
            runCurrent()
            assertEquals(UpdateCheck.Checking, owner.state.value.check)
            assertEquals("0.12.0", owner.state.value.displayedRelease?.version)
            service.heldCheck!!.complete(Unit)
            advanceUntilIdle()
            assertTrue(owner.state.value.canDownload)
            assertEquals("0.13.0", owner.state.value.displayedRelease?.version)

            service.response = AndroidUpdates(null, updateRelease("0.14.0"))
            now += 599_999
            owner.check(false)
            advanceUntilIdle()
            assertEquals("0.13.0", owner.state.value.displayedRelease?.version)

            now += 1
            service.failCheck = true
            owner.check(false)
            advanceUntilIdle()
            assertEquals(UpdateCheck.Failed, owner.state.value.check)
            assertTrue(owner.state.value.canDownload)
            assertEquals("0.13.0", owner.state.value.displayedRelease?.version)

            service.failCheck = false
            owner.check(false)
            advanceUntilIdle()
            assertEquals(UpdateCheck.Checked, owner.state.value.check)
            assertEquals("0.14.0", owner.state.value.displayedRelease?.version)
        }
        runCurrent()
    }

    @Test
    fun coldStartRefreshesStaleDiscovery() = runTest {
        val store =
            MemoryUpdateStore(
                UpdateRecord(
                    "0.12.0",
                    AndroidUpdates(null, updateRelease("0.12.0")),
                    checkedAt = 99_000,
                ),
            )
        val discovery = CompletableDeferred<Unit>()
        val service = ControlledUpdates().apply { heldCheck = discovery }
        AppUpdates(
                service,
                store,
                "0.12.0",
                35,
                StandardTestDispatcher(testScheduler),
                now = { 100_000 + 86_400_000 },
            )
            .use { owner ->
                owner.check(false)
                runCurrent()
                assertEquals(1, service.checks)
                assertEquals(UpdateCheck.Checking, owner.state.value.check)
                assertFalse(owner.state.value.available)

                discovery.complete(Unit)
                advanceUntilIdle()
                assertTrue(owner.state.value.canDownload)
                assertEquals("0.13.0", owner.state.value.displayedRelease?.version)
            }
        runCurrent()
    }

    @Test
    fun manualCheckDuringInitializationRefreshesARecentSavedResult() = runTest {
        val current = "0.12.0"
        val now = 100_000L
        val saved =
            UpdateRecord(current, AndroidUpdates(null, updateRelease(current)), checkedAt = now)
        val initialization = CompletableDeferred<Unit>()
        val service = ControlledUpdates().apply { heldInitialization = initialization }
        AppUpdates(
                service,
                MemoryUpdateStore(saved),
                current,
                35,
                StandardTestDispatcher(testScheduler),
                now = { now },
            )
            .use { owner ->
                owner.check(manual = false)
                runCurrent()
                owner.check()
                initialization.complete(Unit)
                runCurrent()
                assertEquals(UpdateCheck.Checked, owner.state.value.check)
                assertEquals(service.response.release, owner.state.value.candidate)
                assertEquals(1, service.checks)
            }
    }
}
