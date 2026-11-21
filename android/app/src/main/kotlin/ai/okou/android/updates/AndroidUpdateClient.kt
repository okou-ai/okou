package ai.okou.android.updates

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.SignedTransferClient
import ai.okou.android.api.bounded
import ai.okou.android.api.closeTransport
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.api.generated.ApiHeaders
import ai.okou.android.api.generated.CanonicalApi
import ai.okou.android.api.httpClient
import ai.okou.android.api.httpRejection
import ai.okou.android.api.retryAfter
import ai.okou.android.api.validateTransportUrl
import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.pm.PackageInfoCompat
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID
import kotlin.time.Duration.Companion.minutes
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

/** The updater cannot resolve bearer tokens or reuse a rejected business transport. */
class AndroidUpdateClient(
    private val context: Context,
    origin: HttpUrl,
    private val version: String,
    private val directory: File,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val artifactOrigin: HttpUrl = "https://static.okou.io/".toHttpUrl(),
) : UpdateService {
    private val json = Json { ignoreUnknownKeys = true }
    private val sessionId = UUID.randomUUID().toString()
    private val transfers = SignedTransferClient(dispatcher, 10.minutes)
    private val http =
        httpClient()
            .addInterceptor { chain ->
                val response =
                    chain.proceed(
                        chain
                            .request()
                            .newBuilder()
                            .header(ApiHeaders.TYPE_HEADER, ApiHeaders.CLIENT_TYPE)
                            .header(ApiHeaders.VERSION_HEADER, version)
                            .header(ApiHeaders.SESSION_HEADER, sessionId)
                            .header(ApiHeaders.REQUEST_HEADER, UUID.randomUUID().toString())
                            .build()
                    )
                response.newBuilder().body(response.body.bounded(65_536)).build()
            }
            .build()
    private val api: CanonicalApi

    init {
        validateTransportUrl(origin)
        validateTransportUrl(artifactOrigin)
        require(origin.encodedPath == "/" && origin.query == null && origin.fragment == null)
        require(
            artifactOrigin.encodedPath == "/" &&
                artifactOrigin.query == null &&
                artifactOrigin.fragment == null
        )
        api =
            Retrofit.Builder()
                .baseUrl(origin)
                .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
                .client(http)
                .build()
                .create(CanonicalApi::class.java)
    }

    override suspend fun check(): AndroidUpdates =
        withContext(dispatcher) {
            val info =
                try {
                    api.androidUpdates().body()
                } catch (error: IOException) {
                    currentCoroutineContext().ensureActive()
                    val rejection = error.httpRejection() ?: throw error
                    throw ApiFailure.Http(
                        rejection.status,
                        null,
                        null,
                        retryAfter(rejection.retryAfter),
                    )
                } ?: throw IOException("Empty Android update response")
            validateRelease(info.release)
            if (
                info.minimumSupportedVersion != null &&
                    !isAndroidVersion(info.minimumSupportedVersion)
            ) {
                throw UpdateException(UpdateProblem.Check)
            }
            info
        }

    private fun validateRelease(release: AndroidUpdatesRelease) {
        val expected =
            artifactOrigin
                .newBuilder()
                .addPathSegments(
                    "android-updates/releases/${release.version}/${release.sha256}.apk"
                )
                .build()
                .toString()
        if (
            !isAndroidVersion(release.version) ||
                !Regex("[a-f0-9]{64}").matches(release.sha256) ||
                release.url != expected ||
                release.size !in 1..Int.MAX_VALUE.toLong() ||
                release.minimumSdk !in 24..10_000 ||
                release.notes.codePointCount(0, release.notes.length) > 8_000
        )
            throw UpdateException(UpdateProblem.Check)
    }

    override suspend fun initialize() =
        withContext(dispatcher) {
            ensureDirectory()
            val files = directory.listFiles() ?: throw IOException("Cannot list update files")
            for (file in files) {
                if (Regex("[a-f0-9-]{36}\\.part").matches(file.name) && !file.delete())
                    throw IOException("Cannot remove an interrupted update")
            }
        }

    override suspend fun recover(release: AndroidUpdatesRelease): File? =
        withContext(dispatcher) {
            ensureDirectory()
            validateRelease(release)
            val file = File(directory, "${release.sha256}.apk")
            if (!file.isFile) return@withContext null
            try {
                verify(file, release)
                file
            } catch (error: UpdateException) {
                file.delete()
                throw error
            }
        }

    override suspend fun download(release: AndroidUpdatesRelease, progress: (Long) -> Unit): File =
        withContext(dispatcher) {
            validateRelease(release)
            ensureDirectory()
            val active = currentCoroutineContext()
            val temporary = File(directory, "${UUID.randomUUID()}.part")
            val destination = File(directory, "${release.sha256}.apk")
            try {
                transfers.download(release.url.toHttpUrl()) { input ->
                    temporary.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var total = 0L
                        var percent = -1L
                        while (true) {
                            active.ensureActive()
                            val count = input.read(buffer)
                            if (count < 0) break
                            total += count
                            if (total > release.size) throw UpdateException(UpdateProblem.Integrity)
                            output.write(buffer, 0, count)
                            val next = total * 100 / release.size
                            if (next != percent) {
                                percent = next
                                progress(total)
                            }
                        }
                        output.fd.sync()
                    }
                }
                active.ensureActive()
                verify(temporary, release)
                active.ensureActive()
                if (!temporary.renameTo(destination))
                    throw IOException("Cannot commit downloaded update")
                directory
                    .listFiles()
                    ?.filter { it != destination && Regex("[a-f0-9]{64}\\.apk").matches(it.name) }
                    ?.forEach { it.delete() }
                destination
            } finally {
                temporary.delete()
            }
        }

    private fun ensureDirectory() {
        if (!directory.isDirectory && !directory.mkdirs())
            throw IOException("Cannot create update directory")
    }

    private fun verify(file: File, release: AndroidUpdatesRelease) {
        if (file.length() != release.size) throw UpdateException(UpdateProblem.Integrity)
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        if (digest.digest().joinToString("") { "%02x".format(it) } != release.sha256)
            throw UpdateException(UpdateProblem.Integrity)
        val flags =
            if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES
            else legacySignatureFlag()
        val installed = context.packageManager.getPackageInfo(context.packageName, flags)
        val archive =
            context.packageManager.getPackageArchiveInfo(file.path, flags)
                ?: throw UpdateException(UpdateProblem.Identity)
        if (
            archive.packageName != context.packageName ||
                archive.versionName != release.version ||
                PackageInfoCompat.getLongVersionCode(archive) <=
                    PackageInfoCompat.getLongVersionCode(installed) ||
                release.minimumSdk > Build.VERSION.SDK_INT ||
                certificates(installed).isEmpty() ||
                certificates(installed) != certificates(archive)
        ) {
            throw UpdateException(UpdateProblem.Identity)
        }
    }

    @Suppress("DEPRECATION") private fun legacySignatureFlag() = PackageManager.GET_SIGNATURES

    @Suppress("DEPRECATION")
    private fun certificates(info: PackageInfo): Set<String> {
        val signatures =
            if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners
            else info.signatures
        return signatures
            ?.map { signature ->
                MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString(
                    ""
                ) {
                    "%02x".format(it)
                }
            }
            ?.toSet()
            .orEmpty()
    }

    override fun close() {
        transfers.close()
        http.closeTransport()
    }
}
