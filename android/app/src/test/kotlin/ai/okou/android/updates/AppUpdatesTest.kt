package ai.okou.android.updates

import ai.okou.android.api.RequiredUpdate
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.AndroidUpdatesRelease
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

internal fun updateRelease(version: String = "0.13.0") =
    AndroidUpdatesRelease(
        version,
        androidVersionCode(version)!!,
        24,
        1234,
        "a".repeat(64),
        "https://static.okou.io/android-updates/releases/$version/${"a".repeat(64)}.apk",
        "A useful update",
    )

internal class MemoryUpdateStore(var record: UpdateRecord? = null) : UpdateStore {
    var fail = false

    override suspend fun load() = record

    override suspend fun save(record: UpdateRecord) {
        if (fail) throw IOException("disk")
        this.record = record
    }
}

internal class ControlledUpdates : UpdateService {
    override suspend fun initialize() = Unit

    var response = AndroidUpdates(null, updateRelease())
    var heldCheck: CompletableDeferred<Unit>? = null
    var failCheck = false
    var checks = 0
    var downloaded: File? = null
    var transfer = CompletableDeferred<File>()
    var progress: ((Long) -> Unit)? = null
    var recoverFailure: UpdateProblem? = null
    var heldRecovery: CompletableDeferred<Unit>? = null

    override suspend fun check(): AndroidUpdates {
        checks++
        heldCheck?.await()
        if (failCheck) throw IOException("network")
        return response
    }

    override suspend fun recover(release: AndroidUpdatesRelease?): File? {
        heldRecovery?.await()
        recoverFailure?.let { throw UpdateException(it) }
        return downloaded
    }

    override suspend fun download(release: AndroidUpdatesRelease, progress: (Long) -> Unit): File {
        this.progress = progress
        return transfer.await().also { downloaded = it }
    }

    override fun close() = Unit
}

@OptIn(ExperimentalCoroutinesApi::class)
class AppUpdatesTest {
    @Test
    fun discoveryRetainsActiveTransfersAndRetriesTheLatestReleaseAfterFailure() = runTest {
        val service = ControlledUpdates()
        val owner =
            AppUpdates(
                service,
                MemoryUpdateStore(),
                "0.12.0",
                35,
                StandardTestDispatcher(testScheduler),
            )
        try {
            owner.check()
            advanceUntilIdle()
            owner.download()
            runCurrent()
            service.response = AndroidUpdates(null, updateRelease("0.14.0"))
            owner.check()
            advanceUntilIdle()
            assertEquals("0.13.0", owner.state.value.release!!.version)
            assertEquals(UpdateTransfer.Downloading, owner.state.value.transfer)
            service.transfer.completeExceptionally(IOException("The old download is unavailable"))
            advanceUntilIdle()
            assertEquals(UpdateTransfer.Failed, owner.state.value.transfer)
            assertEquals("0.14.0", owner.state.value.release!!.version)
            service.transfer = CompletableDeferred()
            owner.download()
            runCurrent()
            assertEquals("0.14.0", owner.state.value.target!!.version)
            assertEquals(UpdateTransfer.Downloading, owner.state.value.transfer)
            service.transfer.complete(File("new.apk"))
            advanceUntilIdle()
            service.response = AndroidUpdates(null, updateRelease("0.15.0"))
            owner.check()
            advanceUntilIdle()
            assertEquals(UpdateTransfer.Ready, owner.state.value.transfer)
            assertEquals("0.14.0", owner.state.value.release!!.version)
        } finally {
            owner.close()
            runCurrent()
        }
    }

    @Test
    fun obsoleteInstallVerificationCannotFailANewerDownload() = runTest {
        val service = ControlledUpdates()
        val owner =
            AppUpdates(
                service,
                MemoryUpdateStore(),
                "0.12.0",
                35,
                StandardTestDispatcher(testScheduler),
            )
        try {
            owner.check()
            advanceUntilIdle()
            owner.download()
            runCurrent()
            service.transfer.complete(File("old.apk"))
            advanceUntilIdle()
            service.heldRecovery = CompletableDeferred()
            val oldInstall = async { owner.installationFile() }
            runCurrent()
            service.response = AndroidUpdates("0.14.0", updateRelease("0.14.0"))
            owner.requireUpdate(RequiredUpdate("0.14.0"))
            advanceUntilIdle()
            service.transfer = CompletableDeferred()
            owner.download()
            runCurrent()
            service.recoverFailure = UpdateProblem.Integrity
            service.heldRecovery!!.complete(Unit)
            runCurrent()
            assertNull(oldInstall.await())
            assertEquals("0.14.0", owner.state.value.release!!.version)
            assertEquals(UpdateTransfer.Downloading, owner.state.value.transfer)
            assertNull(owner.state.value.problem)
        } finally {
            owner.close()
            runCurrent()
        }
    }

    @Test
    fun checksAreNonblockingThrottledAndDeferralIsPerRelease() = runTest {
        val service = ControlledUpdates().apply { heldCheck = CompletableDeferred() }
        val store = MemoryUpdateStore()
        val owner =
            AppUpdates(
                service,
                store,
                "0.12.0",
                35,
                StandardTestDispatcher(testScheduler),
                { 100_000 },
            )
        try {
            owner.check(false)
            runCurrent()
            assertEquals(UpdateCheck.Checking, owner.state.value.check)
            assertFalse(owner.state.value.required)
            assertFalse(owner.state.value.available)
            service.heldCheck!!.complete(Unit)
            advanceUntilIdle()
            assertTrue(owner.state.value.announce)
            owner.defer()
            advanceUntilIdle()
            assertFalse(owner.state.value.announce)
            owner.check(false)
            advanceUntilIdle()
            assertEquals(1, service.checks)
            owner.check()
            advanceUntilIdle()
            assertEquals(2, service.checks)
            service.response = AndroidUpdates(null, updateRelease("0.14.0"))
            owner.check()
            advanceUntilIdle()
            assertTrue(owner.state.value.announce)
            assertEquals("0.13.0", store.record!!.deferred)
        } finally {
            owner.close()
            runCurrent()
        }
    }

    @Test
    fun explicitRejectionSurvivesFailedDiscoveryAndOptionalOrMalformedPolicy() = runTest {
        val service = ControlledUpdates().apply { failCheck = true }
        val store = MemoryUpdateStore()
        val owner = AppUpdates(service, store, "0.12.0", 35, StandardTestDispatcher(testScheduler))
        try {
            owner.requireUpdate(RequiredUpdate("0.13.0"))
            advanceUntilIdle()
            assertTrue(owner.state.value.required)
            assertEquals(UpdateCheck.Failed, owner.state.value.check)
            service.failCheck = false
            owner.check()
            advanceUntilIdle()
            assertTrue(owner.state.value.required)
            assertEquals("0.13.0", owner.state.value.minimum)
            owner.requireUpdate(RequiredUpdate(null))
            owner.defer()
            advanceUntilIdle()
            assertTrue(store.record!!.blocked)
            assertNull(store.record!!.deferred)
        } finally {
            owner.close()
            runCurrent()
        }
    }

    @Test
    fun incompatibleOrUnavailablePackageNeverOffersInstallation() = runTest {
        val service =
            ControlledUpdates().apply { response = AndroidUpdates("0.14.0", updateRelease()) }
        val owner =
            AppUpdates(
                service,
                MemoryUpdateStore(),
                "0.12.0",
                35,
                StandardTestDispatcher(testScheduler),
            )
        try {
            owner.check()
            advanceUntilIdle()
            assertTrue(owner.state.value.required)
            assertFalse(owner.state.value.suitable)
            owner.download()
            advanceUntilIdle()
            assertEquals(UpdateTransfer.Idle, owner.state.value.transfer)
            assertNull(owner.installationFile())
        } finally {
            owner.close()
            runCurrent()
        }
    }

    @Test
    fun cancellationRetiresProgressAndReadyStateRequiresActualCompletion() = runTest {
        val service = ControlledUpdates()
        val store = MemoryUpdateStore()
        val owner = AppUpdates(service, store, "0.12.0", 35, StandardTestDispatcher(testScheduler))
        try {
            owner.check()
            advanceUntilIdle()
            owner.download()
            runCurrent()
            service.progress!!(500)
            assertEquals(500L, owner.state.value.downloadedBytes)
            val staleProgress = service.progress!!
            owner.cancelDownload()
            runCurrent()
            staleProgress(1000)
            assertEquals(UpdateTransfer.Idle, owner.state.value.transfer)
            assertEquals(0L, owner.state.value.downloadedBytes)
            service.transfer = CompletableDeferred()
            owner.download()
            runCurrent()
            service.transfer.complete(File("verified.apk"))
            advanceUntilIdle()
            assertEquals(UpdateTransfer.Ready, owner.state.value.transfer)
            assertEquals(File("verified.apk"), owner.installationFile())
            owner.installFailed()
            assertEquals(UpdateTransfer.Ready, owner.state.value.transfer)
            assertEquals(UpdateProblem.Install, owner.state.value.problem)
            service.downloaded = null
            assertNull(owner.installationFile())
            assertEquals(UpdateTransfer.Failed, owner.state.value.transfer)
        } finally {
            owner.close()
            runCurrent()
        }
    }

    @Test
    fun restoredDownloadIsRevalidatedAndNewInstalledBuildInvalidatesOldState() = runTest {
        val saved =
            UpdateRecord(
                "0.12.0",
                AndroidUpdates(null, updateRelease()),
                true,
                "0.13.0",
                target = updateRelease(),
            )
        for (complete in listOf(false, true)) {
            val service =
                ControlledUpdates().apply { if (complete) downloaded = File("verified.apk") }
            val owner =
                AppUpdates(
                    service,
                    MemoryUpdateStore(saved),
                    "0.12.0",
                    35,
                    StandardTestDispatcher(testScheduler),
                )
            try {
                advanceUntilIdle()
                assertTrue(owner.state.value.required)
                assertEquals(
                    if (complete) UpdateTransfer.Ready else UpdateTransfer.Interrupted,
                    owner.state.value.transfer,
                )
                service.response = AndroidUpdates(null, updateRelease("0.14.0"))
                owner.check()
                advanceUntilIdle()
                assertEquals(
                    if (complete) "0.13.0" else "0.14.0",
                    owner.state.value.release!!.version,
                )
            } finally {
                owner.close()
                runCurrent()
            }
        }
        val updated =
            AppUpdates(
                ControlledUpdates(),
                MemoryUpdateStore(saved),
                "0.13.0",
                35,
                StandardTestDispatcher(testScheduler),
            )
        try {
            advanceUntilIdle()
            assertFalse(updated.state.value.required)
            assertNull(updated.state.value.target)
        } finally {
            updated.close()
            runCurrent()
        }
    }

    @Test
    fun strongerRequirementCancelsAnInadequateTransferWithoutClearingTheGate() = runTest {
        val service = ControlledUpdates()
        val owner =
            AppUpdates(
                service,
                MemoryUpdateStore(),
                "0.12.0",
                35,
                StandardTestDispatcher(testScheduler),
            )
        try {
            owner.check()
            advanceUntilIdle()
            owner.download()
            runCurrent()
            owner.requireUpdate(RequiredUpdate("0.14.0"))
            advanceUntilIdle()
            assertTrue(owner.state.value.required)
            assertFalse(owner.state.value.suitable)
            assertEquals(UpdateTransfer.Idle, owner.state.value.transfer)
        } finally {
            owner.close()
            runCurrent()
        }
    }

    @Test
    fun saveFailureCannotRelaxAnExplicitRequirement() = runTest {
        val store = MemoryUpdateStore().apply { fail = true }
        val owner =
            AppUpdates(
                ControlledUpdates(),
                store,
                "0.12.0",
                35,
                StandardTestDispatcher(testScheduler),
            )
        try {
            owner.requireUpdate(RequiredUpdate(null))
            advanceUntilIdle()
            assertTrue(owner.state.value.required)
            assertEquals(UpdateCheck.Failed, owner.state.value.check)
        } finally {
            owner.close()
            runCurrent()
        }
    }
}
