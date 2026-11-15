package ai.okou.android.updates

import ai.okou.android.api.ApiClient
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.AndroidUpdates
import androidx.test.core.app.ApplicationProvider
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
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
                owner.download()
                val failed =
                    withTimeout(10_000) {
                        owner.state.first { it.transfer == UpdateTransfer.Failed }
                    }
                assertEquals(UpdateProblem.Download, failed.problem)
                assertEquals("0.13.0", failed.release!!.version)
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
                "0.12.0",
                AndroidUpdates(null, updateRelease()),
                true,
                "0.13.0",
                "0.13.0",
                12345,
                updateRelease(),
            )
        FileUpdateStore(directory).save(record)
        assertEquals(record, FileUpdateStore(directory).load())
        File(directory, "state.json").writeBytes(ByteArray(131_073))
        try {
            FileUpdateStore(directory).load()
            fail("Expected bounded read")
        } catch (_: java.io.IOException) {}
    }

    @Test
    @Config(sdk = [24])
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
        val manager = org.robolectric.Shadows.shadowOf(context.packageManager)
        val installed =
            context.packageManager.getPackageInfo(
                context.packageName,
                android.content.pm.PackageManager.GET_SIGNATURES,
            )
        installed.versionCode = 12000
        installed.signatures = arrayOf(android.content.pm.Signature("1234"))
        manager.installPackage(installed)
        val archive =
            android.content.pm.PackageInfo().apply {
                packageName = context.packageName
                versionName = "0.13.0"
                versionCode = 13000
                signatures = installed.signatures
            }
        manager.setPackageArchiveInfo(file.path, archive)
        AndroidUpdateClient(context, "https://api.okou.ai/".toHttpUrl(), "0.12.0", directory).use {
            updater ->
            assertEquals(file, updater.recover(release))
            archive.signatures = arrayOf(android.content.pm.Signature("5678"))
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
