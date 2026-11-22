package ai.okou.android.updates

import ai.okou.android.api.ApiClient
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.AndroidUpdates
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.content.pm.SigningInfo
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 35])
class AndroidUpdateClientTest {
    @get:Rule val files = TemporaryFolder()

    @Test
    fun releaseNotesRetainSupplementaryCharactersAtTheCanonicalLimit() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val notes = "\uD83D\uDE80".repeat(8_000)
            val release = updateRelease().copy(notes = notes)
            server.enqueue(
                MockResponse().setBody(Json.encodeToString(AndroidUpdates(null, release)))
            )
            server.enqueue(
                MockResponse()
                    .setBody(
                        Json.encodeToString(AndroidUpdates(null, release.copy(notes = notes + "!")))
                    )
            )
            AndroidUpdateClient(
                    ApplicationProvider.getApplicationContext(),
                    server.url("/"),
                    "0.12.0",
                    files.newFolder(),
                )
                .use { updater ->
                    assertEquals(notes, updater.check().release.notes)
                    try {
                        updater.check()
                        fail("Expected the canonical release-note limit")
                    } catch (error: UpdateException) {
                        assertEquals(UpdateProblem.Check, error.problem)
                    }
                }
        }
    }

    @Test
    @OptIn(ExperimentalCoroutinesApi::class)
    fun temporaryDiscoveryRejectionRetriesThroughThePublicClient() = runTest {
        MockWebServer().use { server ->
            server.start()
            val directory = files.newFolder()
            val info = AndroidUpdates(null, updateRelease())
            server.enqueue(MockResponse().setResponseCode(503))
            server.enqueue(MockResponse().setBody(Json.encodeToString(info)))
            val client =
                AndroidUpdateClient(
                    ApplicationProvider.getApplicationContext(),
                    server.url("/"),
                    "0.12.0",
                    directory,
                )
            AppUpdates(
                    client,
                    FileUpdateStore(directory),
                    "0.12.0",
                    35,
                    StandardTestDispatcher(testScheduler),
                )
                .use { owner ->
                    owner.check()
                    val rejected =
                        owner.state.first {
                            it.check == UpdateCheck.Waiting || it.check == UpdateCheck.Failed
                        }
                    assertEquals(UpdateCheck.Waiting, rejected.check)
                    advanceTimeBy(59_999)
                    assertEquals(1, server.requestCount)

                    advanceTimeBy(1)
                    val confirmed = owner.state.first { it.check == UpdateCheck.Checked }
                    assertEquals(info.release, confirmed.candidate)
                    assertEquals(2, server.requestCount)
                }
        }
    }

    @Test
    fun rejectedApkRequestBecomesRecoverableDownloadFailure() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val directory = files.newFolder()
            val release =
                updateRelease()
                    .copy(
                        url =
                            server
                                .url("/android-updates/releases/0.13.0/${"a".repeat(64)}.apk")
                                .toString()
                    )
            server.enqueue(
                MockResponse().setBody(Json.encodeToString(AndroidUpdates(null, release)))
            )
            server.enqueue(MockResponse().setResponseCode(404))
            val client =
                AndroidUpdateClient(
                    ApplicationProvider.getApplicationContext(),
                    server.url("/"),
                    "0.12.0",
                    directory,
                    artifactOrigin = server.url("/"),
                )
            AppUpdates(client, FileUpdateStore(directory), "0.12.0", 35, Dispatchers.Default).use {
                owner ->
                owner.check()
                withTimeout(10_000) { owner.state.first { it.check == UpdateCheck.Checked } }
                owner.download(release)
                val failed =
                    withTimeout(10_000) {
                        owner.state.first { it.transfer == UpdateTransfer.Failed }
                    }
                assertEquals(UpdateProblem.Download, failed.problem)
                assertEquals("0.13.0", failed.displayedRelease!!.version)
                assertTrue(
                    directory.listFiles()!!.none {
                        it.name.endsWith(".apk") || it.name.endsWith(".part")
                    }
                )
            }
        }
    }

    @Test
    fun publicGeneratedTransportWorksAfterBusinessClientIsExcludedWithoutCredentials() =
        runBlocking {
            MockWebServer().use { server ->
                server.start()
                val directory = files.newFolder()
                val release =
                    updateRelease()
                        .copy(
                            url =
                                server
                                    .url("/android-updates/releases/0.13.0/${"a".repeat(64)}.apk")
                                    .toString()
                        )
                server.enqueue(
                    MockResponse()
                        .setResponseCode(426)
                        .setBody(
                            """{"error":{"code":"ANDROID_UPDATE_REQUIRED","message":"Update"},"minimumSupportedVersion":"0.13.0"}"""
                        )
                )
                server.enqueue(
                    MockResponse().setBody(Json.encodeToString(AndroidUpdates("0.13.0", release)))
                )
                val requirements = mutableListOf<String?>()
                ApiClient(
                        server.url("/"),
                        WorkspaceTokenProvider { "workspace-secret" },
                        version = "0.12.0",
                        onUpdateRequired = { requirements += it.minimumSupportedVersion },
                    )
                    .use { business ->
                        try {
                            business.organization()
                            fail("Expected exclusion")
                        } catch (_: ApiFailure.UpdateRequired) {}
                        AndroidUpdateClient(
                                ApplicationProvider.getApplicationContext(),
                                server.url("/"),
                                "0.12.0",
                                directory,
                                artifactOrigin = server.url("/"),
                            )
                            .use { updater ->
                                assertEquals("0.13.0", updater.check().release.version)
                            }
                        assertEquals(listOf("0.13.0"), requirements)
                        assertEquals(
                            "Bearer workspace-secret",
                            server.takeRequest().getHeader("Authorization"),
                        )
                        val request = server.takeRequest()
                        assertEquals("/api/android/updates", request.path)
                        assertNull(request.getHeader("Authorization"))
                        assertNull(request.getHeader("Cookie"))
                        assertEquals("Android", request.getHeader("X-Client-Type"))
                        try {
                            business.preferences()
                            fail("Expected retained exclusion")
                        } catch (_: ApiFailure.UpdateRequired) {}
                        assertEquals(2, server.requestCount)
                    }
            }
        }

    @Test
    fun tamperedAndTruncatedTransfersNeverPublishAnInstallableFile() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val directory = files.newFolder()
            val release =
                updateRelease()
                    .copy(
                        url =
                            server
                                .url("/android-updates/releases/0.13.0/${"a".repeat(64)}.apk")
                                .toString(),
                        size = 4,
                    )
            AndroidUpdateClient(
                    ApplicationProvider.getApplicationContext(),
                    server.url("/"),
                    "0.12.0",
                    directory,
                    artifactOrigin = server.url("/"),
                )
                .use { updater ->
                    for (bytes in listOf("bad!", "bad", "oversized")) {
                        server.enqueue(MockResponse().setBody(bytes))
                        try {
                            updater.download(release) {}
                            fail("Expected integrity rejection")
                        } catch (error: UpdateException) {
                            assertEquals(UpdateProblem.Integrity, error.problem)
                        }
                        assertTrue(directory.listFiles()!!.isEmpty())
                        val request = server.takeRequest()
                        assertNull(request.getHeader("Authorization"))
                        assertNull(request.getHeader("X-Client-Type"))
                    }
                }
        }
    }

    @Test
    fun privateStateRoundTripsOutsideSavedInstanceState() = runBlocking {
        val directory = files.newFolder()
        val record =
            UpdateRecord(
                installedVersion = "0.12.0",
                info = AndroidUpdates(null, updateRelease()),
                blocked = true,
                minimum = "0.13.0",
                checkedAt = 12345,
                target = updateRelease(),
            )
        val store = FileUpdateStore(directory)
        val stateFile = File(directory, "state.json")
        store.save(record)
        assertEquals(record, store.load())
        stateFile.writeText(stateFile.readText().replaceFirst("{", "{\"deferred\":\"0.13.0\","))
        assertEquals(record, store.load())
        store.save(record)
        assertFalse(stateFile.readText().contains("\"deferred\""))
        stateFile.writeBytes(ByteArray(131_073))
        try {
            store.load()
            fail("Expected bounded read")
        } catch (_: java.io.IOException) {}
    }

    @Test
    @OptIn(ExperimentalCoroutinesApi::class)
    fun startupAfterUpgradeRemovesTheDownloadedApk() = runTest {
        val directory = files.newFolder()
        val release = updateRelease()
        val downloaded = File(directory, "${release.sha256}.apk").apply { writeText("APK") }
        val unrelated = File(directory, "unmanaged.apk").apply { writeText("keep") }
        val dispatcher = StandardTestDispatcher(testScheduler)
        val store = FileUpdateStore(directory, dispatcher)
        store.save(UpdateRecord("0.12.0", target = release))
        val client =
            AndroidUpdateClient(
                ApplicationProvider.getApplicationContext(),
                "https://api.okou.ai/".toHttpUrl(),
                release.version,
                directory,
                dispatcher,
            )

        AppUpdates(client, store, release.version, 35, dispatcher).use { owner ->
            advanceUntilIdle()
            assertEquals(UpdateTransfer.Idle, owner.state.value.transfer)
            assertFalse(downloaded.exists())
            assertEquals("keep", unrelated.readText())
        }
    }

    @Test
    @Suppress("DEPRECATION")
    fun cachedPackageRequiresTheInstalledSigningIdentityAndVersion() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val directory = files.newFolder()
        val bytes = "verified APK fixture".toByteArray()
        val digest =
            java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") {
                "%02x".format(it)
            }
        val release =
            updateRelease()
                .copy(
                    size = bytes.size.toLong(),
                    sha256 = digest,
                    url = "https://static.okou.io/android-updates/releases/0.13.0/$digest.apk",
                )
        val file = File(directory, "$digest.apk").apply { writeBytes(bytes) }
        val previous = File(directory, "${"f".repeat(64)}.apk").apply { writeText("old APK") }
        fun setSigners(info: PackageInfo, signature: String) {
            val signers = arrayOf(Signature(signature))
            if (Build.VERSION.SDK_INT >= 28) {
                info.signingInfo = SigningInfo().apply { shadowOf(this).setSignatures(signers) }
            } else {
                info.signatures = signers
            }
        }
        val manager = shadowOf(context.packageManager)
        val flags =
            if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES
            else PackageManager.GET_SIGNATURES
        val installed = context.packageManager.getPackageInfo(context.packageName, flags)
        installed.versionCode = 401
        setSigners(installed, "1234")
        manager.installPackage(installed)
        val archive =
            PackageInfo().apply {
                packageName = context.packageName
                versionName = "0.13.0"
                versionCode = 402
                setSigners(this, "1234")
            }
        manager.setPackageArchiveInfo(file.path, archive)
        AndroidUpdateClient(context, "https://api.okou.ai/".toHttpUrl(), "0.12.0", directory).use {
            updater ->
            updater.initialize(release)
            assertFalse(previous.exists())
            assertEquals(file, updater.recover(release))
            archive.versionCode = installed.versionCode
            manager.setPackageArchiveInfo(file.path, archive)
            try {
                updater.recover(release)
                fail("Expected non-increasing APK code rejection")
            } catch (error: UpdateException) {
                assertEquals(UpdateProblem.Identity, error.problem)
            }
            assertFalse(file.exists())
            file.writeBytes(bytes)
            archive.versionCode = 402
            setSigners(archive, "5678")
            manager.setPackageArchiveInfo(file.path, archive)
            try {
                updater.recover(release)
                fail("Expected signer rejection")
            } catch (error: UpdateException) {
                assertEquals(UpdateProblem.Identity, error.problem)
            }
            assertFalse(file.exists())
        }
    }
}
