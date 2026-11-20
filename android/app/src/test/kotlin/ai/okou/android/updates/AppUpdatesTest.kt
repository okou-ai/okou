package ai.okou.android.updates

import ai.okou.android.api.RequiredUpdate
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.AndroidUpdatesRelease
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

internal fun updateRelease(version: String = "0.13.0") =
    AndroidUpdatesRelease(
        version,
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
    val downloadedReleases = mutableListOf<AndroidUpdatesRelease>()

    override suspend fun check(): AndroidUpdates {
        checks++
        heldCheck?.await()
        if (failCheck) throw IOException("network")
        return response
    }

    override suspend fun recover(release: AndroidUpdatesRelease): File? {
        heldRecovery?.await()
        recoverFailure?.let { throw UpdateException(it) }
        return downloaded
    }

    override suspend fun download(release: AndroidUpdatesRelease, progress: (Long) -> Unit): File {
        downloadedReleases += release
        this.progress = progress
        return transfer.await().also { downloaded = it }
    }

    override fun close() = Unit
}

@OptIn(ExperimentalCoroutinesApi::class)
class AppUpdatesTest {
    @Test
    fun policyComparesVersionComponentsAndRespectsTheFloorAndDevice() {
        val release = updateRelease("0.10.0")
        val state =
            UpdateUiState(
                "0.9.0",
                AndroidUpdates("0.10.0", release),
                minimum = "0.10.0",
                transfer = UpdateTransfer.Idle,
                sdk = 35,
            )
        assertTrue(state.available)
        assertTrue(state.canDownload)
        assertFalse(state.copy(installedVersion = "0.10.0").available)
        assertFalse(state.copy(minimum = "0.10.1").canDownload)
        assertFalse(state.copy(sdk = 23).canDownload)
        assertTrue(state.copy(info = AndroidUpdates(null, updateRelease("0.1000.0"))).canDownload)
    }

    @Test
    fun pendingRecoveryDoesNotAnnounceADifferentDownloadCandidate() = runTest {
        val store = MemoryUpdateStore()
        val original = ControlledUpdates().apply { transfer.complete(File("verified.apk")) }
        AppUpdates(original, store, "0.12.0", 35, StandardTestDispatcher(testScheduler)).use { owner
            ->
            owner.check()
            advanceUntilIdle()
            owner.download(updateRelease())
            advanceUntilIdle()
            original.response = AndroidUpdates(null, updateRelease("0.14.0"))
            owner.check()
            advanceUntilIdle()
        }
        runCurrent()
        val saved = checkNotNull(store.record)
        for (complete in listOf(false, true)) {
            val recovery =
                ControlledUpdates().apply {
                    if (complete) downloaded = File("verified.apk")
                    heldRecovery = CompletableDeferred()
                }
            AppUpdates(
                    recovery,
                    MemoryUpdateStore(saved),
                    "0.12.0",
                    35,
                    StandardTestDispatcher(testScheduler),
                )
                .use { owner ->
                    runCurrent()
                    assertTrue(owner.state.value.preparing)
                    assertFalse(owner.state.value.announce)
                    assertFalse(owner.state.value.canDownload)
                    assertFalse(owner.state.value.canInstall)
                    assertEquals("0.13.0", owner.state.value.displayedRelease!!.version)
                    assertEquals("0.14.0", owner.state.value.candidate!!.version)
                    owner.download(updateRelease("0.14.0"))
                    owner.defer(updateRelease())
                    assertNull(owner.installationFile(updateRelease()))
                    runCurrent()
                    assertTrue(owner.state.value.preparing)
                    assertTrue(recovery.downloadedReleases.isEmpty())
                    recovery.heldRecovery!!.complete(Unit)
                    advanceUntilIdle()
                    assertFalse(owner.state.value.preparing)
                    assertTrue(recovery.downloadedReleases.isEmpty())
                    if (complete) {
                        assertEquals(
                            UpdateTransfer.Ready(updateRelease()),
                            owner.state.value.transfer,
                        )
                        assertTrue(owner.state.value.canInstall)
                        assertEquals("0.13.0", owner.state.value.displayedRelease!!.version)
                        assertNull(owner.installationFile(updateRelease("0.14.0")))
                        assertEquals(File("verified.apk"), owner.installationFile(updateRelease()))
                    } else {
                        assertEquals(UpdateTransfer.Interrupted, owner.state.value.transfer)
                        assertTrue(owner.state.value.canDownload)
                        assertEquals("0.14.0", owner.state.value.displayedRelease!!.version)
                        owner.download(updateRelease("0.14.0"))
                        runCurrent()
                        assertEquals(listOf(updateRelease("0.14.0")), recovery.downloadedReleases)
                    }
                }
            runCurrent()
        }
    }

    @Test
    fun coldStartRefreshesRecentDiscoveryAndWarmChecksKeepTheirCooldown() = runTest {
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
            assertEquals(UpdateCheck.Checking, owner.state.value.check)
            assertEquals("0.12.0", owner.state.value.displayedRelease?.version)
            service.heldCheck!!.complete(Unit)
            advanceUntilIdle()
            assertTrue(owner.state.value.announce)
            assertEquals("0.13.0", owner.state.value.displayedRelease?.version)

            service.response = AndroidUpdates(null, updateRelease("0.14.0"))
            now += 86_400_000 - 1
            owner.check(false)
            advanceUntilIdle()
            assertEquals("0.13.0", owner.state.value.displayedRelease?.version)

            now += 1
            service.failCheck = true
            owner.check(false)
            advanceUntilIdle()
            assertEquals(UpdateCheck.Failed, owner.state.value.check)
            assertTrue(owner.state.value.announce)
            assertEquals("0.13.0", owner.state.value.displayedRelease?.version)

            service.failCheck = false
            owner.check(false)
            advanceUntilIdle()
            assertEquals(UpdateCheck.Failed, owner.state.value.check)

            now += 60_000
            owner.check(false)
            advanceUntilIdle()
            assertEquals("0.14.0", owner.state.value.displayedRelease?.version)
        }
        runCurrent()
    }

    @Test
    fun offlineColdStartRefreshesRecentDiscoveryOnReconnect() = runTest {
        val store =
            MemoryUpdateStore(
                UpdateRecord(
                    "0.12.0",
                    AndroidUpdates(null, updateRelease("0.12.0")),
                    checkedAt = 99_000,
                )
            )
        val connectivity = MutableStateFlow(false)
        AppUpdates(
                ControlledUpdates(),
                store,
                "0.12.0",
                35,
                StandardTestDispatcher(testScheduler),
                now = { 100_000 },
                connectivity = connectivity,
            )
            .use { owner ->
                owner.check(false)
                advanceUntilIdle()
                assertTrue(owner.state.value.offline)
                assertFalse(owner.state.value.available)

                connectivity.value = true
                advanceUntilIdle()
                assertTrue(owner.state.value.announce)
                assertEquals("0.13.0", owner.state.value.displayedRelease?.version)
            }
        runCurrent()
    }

    @Test
    fun invalidRecoveredPackageFinishesPreparationAndRetainsRequiredPolicy() = runTest {
        val selected = updateRelease()
        val latest = updateRelease("0.14.0")
        val recovery =
            ControlledUpdates().apply {
                heldRecovery = CompletableDeferred()
                recoverFailure = UpdateProblem.Integrity
            }
        val store =
            MemoryUpdateStore(
                UpdateRecord(
                    "0.12.0",
                    AndroidUpdates(null, latest),
                    true,
                    "0.13.0",
                    target = selected,
                )
            )
        AppUpdates(recovery, store, "0.12.0", 35, StandardTestDispatcher(testScheduler)).use { owner
            ->
            runCurrent()
            assertTrue(owner.state.value.preparing)
            assertTrue(owner.state.value.required)
            recovery.heldRecovery!!.complete(Unit)
            advanceUntilIdle()
            assertFalse(owner.state.value.preparing)
            assertTrue(owner.state.value.required)
            assertEquals(UpdateProblem.Integrity, owner.state.value.problem)
            assertTrue(owner.state.value.canDownload)
            assertFalse(owner.state.value.canInstall)
            owner.download(latest)
            runCurrent()
            assertEquals(listOf(latest), recovery.downloadedReleases)
        }
        runCurrent()
    }

    @Test
    fun actionsFromAnOlderPresentationCannotChangeTheCurrentPackage() = runTest {
        val old = updateRelease()
        val latest = updateRelease("0.14.0")
        val service = ControlledUpdates()
        val store = MemoryUpdateStore()
        AppUpdates(service, store, "0.12.0", 35, StandardTestDispatcher(testScheduler)).use { owner
            ->
            owner.check()
            advanceUntilIdle()
            service.response = AndroidUpdates(null, latest)
            owner.check()
            advanceUntilIdle()
            owner.download(old)
            owner.defer(old)
            runCurrent()
            assertTrue(service.downloadedReleases.isEmpty())
            assertNull(owner.state.value.deferred)
            owner.download(latest)
            runCurrent()
            assertEquals(UpdateTransfer.Downloading(latest), owner.state.value.transfer)
            service.transfer.complete(File("latest.apk"))
            advanceUntilIdle()
            assertNull(owner.installationFile(old))
            owner.installFailed(old)
            assertNull(owner.state.value.problem)
            assertEquals(File("latest.apk"), owner.installationFile(latest))
            assertEquals(latest, store.record!!.target)
        }
        runCurrent()
    }

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
            owner.download(updateRelease())
            runCurrent()
            service.response = AndroidUpdates(null, updateRelease("0.14.0"))
            owner.check()
            advanceUntilIdle()
            assertEquals("0.13.0", owner.state.value.displayedRelease!!.version)
            assertTrue(owner.state.value.transfer is UpdateTransfer.Downloading)
            service.transfer.completeExceptionally(IOException("The old download is unavailable"))
            advanceUntilIdle()
            assertEquals(UpdateTransfer.Failed, owner.state.value.transfer)
            assertEquals("0.14.0", owner.state.value.displayedRelease!!.version)
            service.transfer = CompletableDeferred()
            owner.download(updateRelease("0.14.0"))
            runCurrent()
            assertEquals("0.14.0", owner.state.value.selectedRelease!!.version)
            assertTrue(owner.state.value.transfer is UpdateTransfer.Downloading)
            service.transfer.complete(File("new.apk"))
            advanceUntilIdle()
            service.response = AndroidUpdates(null, updateRelease("0.15.0"))
            owner.check()
            advanceUntilIdle()
            assertTrue(owner.state.value.transfer is UpdateTransfer.Ready)
            assertEquals("0.14.0", owner.state.value.displayedRelease!!.version)
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
            owner.download(updateRelease())
            runCurrent()
            service.transfer.complete(File("old.apk"))
            advanceUntilIdle()
            service.heldRecovery = CompletableDeferred()
            val oldInstall = async { owner.installationFile(updateRelease()) }
            runCurrent()
            service.response = AndroidUpdates("0.14.0", updateRelease("0.14.0"))
            owner.requireUpdate(RequiredUpdate("0.14.0"))
            advanceUntilIdle()
            service.transfer = CompletableDeferred()
            owner.download(updateRelease("0.14.0"))
            runCurrent()
            service.recoverFailure = UpdateProblem.Integrity
            service.heldRecovery!!.complete(Unit)
            runCurrent()
            assertNull(oldInstall.await())
            assertEquals("0.14.0", owner.state.value.displayedRelease!!.version)
            assertTrue(owner.state.value.transfer is UpdateTransfer.Downloading)
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
            owner.defer(updateRelease())
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
            owner.defer(updateRelease())
            advanceUntilIdle()
            assertTrue(store.record!!.blocked)
            assertNull(store.record!!.deferred)
        } finally {
            owner.close()
            runCurrent()
        }
    }

    @Test
    fun offlineRequiredUpdateChecksOnReconnectAndLeavesDownloadsToTheUser() = runTest {
        val service = ControlledUpdates()
        val connectivity = MutableStateFlow(false)
        val owner =
            AppUpdates(
                service,
                MemoryUpdateStore(),
                "0.12.0",
                35,
                StandardTestDispatcher(testScheduler),
                connectivity = connectivity,
            )
        try {
            owner.requireUpdate(RequiredUpdate("0.13.0"))
            advanceUntilIdle()
            assertTrue(owner.state.value.required && owner.state.value.offline)
            assertNull(owner.state.value.displayedRelease)
            assertEquals(0, service.checks)

            connectivity.value = true
            advanceUntilIdle()
            assertEquals(1, service.checks)
            assertTrue(owner.state.value.canDownload)

            connectivity.value = false
            runCurrent()
            assertFalse(owner.download(updateRelease()))
            connectivity.value = true
            advanceUntilIdle()
            assertEquals(1, service.checks)
            assertTrue(service.downloadedReleases.isEmpty())
            assertTrue(owner.download(updateRelease()))
            runCurrent()
            assertEquals(listOf(updateRelease()), service.downloadedReleases)
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
            assertFalse(owner.state.value.canDownload)
            owner.download(updateRelease())
            advanceUntilIdle()
            assertEquals(UpdateTransfer.Idle, owner.state.value.transfer)
            assertNull(owner.installationFile(updateRelease()))
        } finally {
            owner.close()
            runCurrent()
        }
    }

    @Test
    fun higherMinimumRetiresProgressAndReadyStateRequiresActualCompletion() = runTest {
        val service = ControlledUpdates()
        val store = MemoryUpdateStore()
        val owner = AppUpdates(service, store, "0.12.0", 35, StandardTestDispatcher(testScheduler))
        try {
            owner.check()
            advanceUntilIdle()
            owner.download(updateRelease())
            runCurrent()
            service.progress!!(500)
            assertEquals(
                500L,
                (owner.state.value.transfer as UpdateTransfer.Downloading).downloadedBytes,
            )
            val staleProgress = service.progress!!
            val newer = updateRelease("0.14.0")
            service.response = AndroidUpdates(null, newer)
            owner.requireUpdate(RequiredUpdate(newer.version))
            advanceUntilIdle()
            staleProgress(1000)
            assertEquals(UpdateTransfer.Idle, owner.state.value.transfer)
            service.transfer = CompletableDeferred()
            owner.download(newer)
            runCurrent()
            service.transfer.complete(File("verified.apk"))
            advanceUntilIdle()
            assertTrue(owner.state.value.transfer is UpdateTransfer.Ready)
            assertEquals(File("verified.apk"), owner.installationFile(newer))
            owner.installFailed(newer)
            service.failCheck = true
            owner.check()
            advanceUntilIdle()
            assertEquals(UpdateCheck.Failed, owner.state.value.check)
            assertTrue(owner.state.value.transfer is UpdateTransfer.Ready)
            assertEquals(UpdateProblem.Install, owner.state.value.problem)
            service.downloaded = null
            assertNull(owner.installationFile(newer))
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
                    if (complete) UpdateTransfer.Ready(updateRelease())
                    else UpdateTransfer.Interrupted,
                    owner.state.value.transfer,
                )
                service.response = AndroidUpdates(null, updateRelease("0.14.0"))
                owner.check()
                advanceUntilIdle()
                assertEquals(
                    if (complete) "0.13.0" else "0.14.0",
                    owner.state.value.displayedRelease!!.version,
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
            assertNull(updated.state.value.selectedRelease)
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
            owner.download(updateRelease())
            runCurrent()
            owner.requireUpdate(RequiredUpdate("0.14.0"))
            advanceUntilIdle()
            assertTrue(owner.state.value.required)
            assertFalse(owner.state.value.canDownload)
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
            assertEquals(UpdateCheck.Checked, owner.state.value.check)
            assertEquals(UpdateProblem.Storage, owner.state.value.problem)
        } finally {
            owner.close()
            runCurrent()
        }
    }
}
