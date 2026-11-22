package ai.okou.android.artifacts

import ai.okou.android.BuildConfig
import ai.okou.android.api.ApiClient
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.SignedTransferClient
import ai.okou.android.api.generated.ArtifactCatalogArtifactsItemVariant1
import ai.okou.android.api.generated.ArtifactCatalogArtifactsItemVariant2
import ai.okou.android.api.generated.ArtifactCatalogArtifactsItemVariant2Kind
import ai.okou.android.api.generated.ArtifactCatalogQuery
import ai.okou.android.api.generated.ArtifactCatalogQueryKind
import ai.okou.android.api.generated.ArtifactDetail
import ai.okou.android.api.generated.ArtifactDetailVariant1
import ai.okou.android.api.generated.ArtifactDetailVariant2
import ai.okou.android.api.generated.ArtifactDetailVariant3
import ai.okou.android.api.generated.ArtifactDetailVariant4
import ai.okou.android.api.generated.ArtifactDetailVariant5
import ai.okou.android.api.generated.ArtifactDetailVariant6
import ai.okou.android.api.generated.ArtifactDetailVariant7
import ai.okou.android.api.generated.ArtifactDownloadVariant1
import ai.okou.android.api.generated.ArtifactReferenceTargetKind
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.OutputStream
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

internal enum class ArtifactKind {
    File,
    Website,
    Image,
    Presentation,
    Video,
    Avatar,
    SharedConversation,
}

internal enum class ArtifactFilter(val wire: ArtifactCatalogQueryKind?, val kind: ArtifactKind?) {
    All(null, null),
    Files(ArtifactCatalogQueryKind.FILE, ArtifactKind.File),
    Websites(ArtifactCatalogQueryKind.HOSTED_SITE, ArtifactKind.Website),
    Images(ArtifactCatalogQueryKind.IMAGE, ArtifactKind.Image),
    Presentations(ArtifactCatalogQueryKind.PRESENTATION, ArtifactKind.Presentation),
    Videos(ArtifactCatalogQueryKind.VIDEO, ArtifactKind.Video),
}

internal data class ArtifactQuery(
    val filter: ArtifactFilter = ArtifactFilter.All,
    val keyword: String = "",
    val chatThreadId: String? = null,
)

internal data class ArtifactItem(
    val id: String,
    val title: String,
    val kind: ArtifactKind,
    val createdAt: Long?,
    val thumbnail: String? = null,
)

internal data class ArtifactPage(val items: List<ArtifactItem>, val nextCursor: String?)

internal data class ArtifactSave(
    val reference: String,
    val filename: String,
    val contentType: String,
)

internal data class ArtifactInfo(
    val item: ArtifactItem,
    val sourceChatId: String?,
    val resource: ArtifactResource,
    val browserUrl: HttpUrl? = null,
    val resolvedAccess: ArtifactAccess? = null,
)

internal sealed interface ArtifactResource {
    data class File(val url: String, val name: String, val type: String, val cover: String?) :
        ArtifactResource

    data class Site(val url: HttpUrl) : ArtifactResource

    data class ResolvedHtml(val url: HttpUrl) : ArtifactResource

    data object Unsupported : ArtifactResource
}

internal sealed interface ArtifactContent {
    data class Text(val source: String, val markdown: Boolean) : ArtifactContent

    data class Image(val bitmap: Bitmap) : ArtifactContent

    data class Website(val url: HttpUrl) : ArtifactContent

    data class Media(val url: HttpUrl, val video: Boolean) : ArtifactContent

    data object Unsupported : ArtifactContent
}

internal data class ArtifactAccess(
    val url: HttpUrl?,
    val type: String,
    val name: String,
    val save: ArtifactSave? = null,
    val previewOnly: Boolean = false,
)

class ArtifactService
internal constructor(
    private val api: ApiClient,
    private val transfers: SignedTransferClient,
    apiOrigin: String,
) {
    private val referenceOrigins =
        setOfNotNull(apiOrigin.toHttpUrlOrNull(), BuildConfig.WEB_ORIGIN.toHttpUrlOrNull())

    internal suspend fun page(query: ArtifactQuery, cursor: String?): ArtifactPage {
        val page =
            api.artifactCatalog(
                ArtifactCatalogQuery(
                    limit = 40,
                    chatThreadId = query.chatThreadId,
                    kind = query.filter.wire,
                    keyword = query.keyword.ifBlank { null },
                    cursor = cursor,
                )
            )
        if (page.nextCursor != null && (page.nextCursor == cursor || page.artifacts.isEmpty())) {
            throw ApiFailure.IncompatibleResponse()
        }
        return withContext(Dispatchers.Default) {
            val clock = artifactTimestampParser()
            ArtifactPage(
                page.artifacts.map { item ->
                    when (item) {
                        is ArtifactCatalogArtifactsItemVariant1 ->
                            ArtifactItem(
                                item.id,
                                item.title,
                                ArtifactKind.SharedConversation,
                                parseArtifactTimestamp(clock, item.createdAt),
                                item.thumbnail?.url,
                            )
                        is ArtifactCatalogArtifactsItemVariant2 ->
                            ArtifactItem(
                                item.id,
                                item.title,
                                when (item.kind) {
                                    ArtifactCatalogArtifactsItemVariant2Kind.FILE ->
                                        ArtifactKind.File
                                    ArtifactCatalogArtifactsItemVariant2Kind.HOSTED_SITE ->
                                        ArtifactKind.Website
                                    ArtifactCatalogArtifactsItemVariant2Kind.IMAGE ->
                                        ArtifactKind.Image
                                    ArtifactCatalogArtifactsItemVariant2Kind.PRESENTATION ->
                                        ArtifactKind.Presentation
                                    ArtifactCatalogArtifactsItemVariant2Kind.VIDEO ->
                                        ArtifactKind.Video
                                    ArtifactCatalogArtifactsItemVariant2Kind.AVATAR ->
                                        ArtifactKind.Avatar
                                },
                                parseArtifactTimestamp(clock, item.createdAt),
                                item.thumbnail?.url,
                            )
                    }
                },
                page.nextCursor,
            )
        }
    }

    internal suspend fun info(id: String): ArtifactInfo {
        val link = messageArtifactLink(id)
        if (link != null) {
            val reference = artifactReference(link)
            if (reference != null) {
                val resolved = api.resolveArtifactReference(reference)
                if (resolved.target.kind == ArtifactReferenceTargetKind.HTML) {
                    val url =
                        artifactHttpsUrl(resolved.url) ?: throw ApiFailure.IncompatibleResponse()
                    return ArtifactInfo(
                        ArtifactItem(id, resolved.filename, ArtifactKind.Website, null),
                        null,
                        ArtifactResource.ResolvedHtml(url),
                    )
                }
                val kind =
                    when {
                        resolved.contentType.startsWith("image/") -> ArtifactKind.Image
                        resolved.contentType.startsWith("video/") -> ArtifactKind.Video
                        resolved.filename.endsWith(".pptx", ignoreCase = true) ->
                            ArtifactKind.Presentation
                        else -> ArtifactKind.File
                    }
                val file =
                    ArtifactResource.File(
                        link,
                        resolved.filename,
                        resolved.contentType,
                        resolved.previewImageUrl,
                    )
                val access = resolvedFileAccess(reference, file, resolved)
                return ArtifactInfo(
                    ArtifactItem(id, resolved.filename, kind, null),
                    null,
                    file,
                    resolvedAccess = access,
                )
            }
            val site = checkNotNull(artifactHttpsUrl(link))
            return ArtifactInfo(
                ArtifactItem(id, site.host, ArtifactKind.Website, null),
                null,
                ArtifactResource.Site(site),
            )
        }
        return api.artifactDetail(id).toInfo().also {
            if (it.item.id != id) throw ApiFailure.IncompatibleResponse()
        }
    }

    internal suspend fun fileAccess(file: ArtifactResource.File): ArtifactAccess {
        val reference = artifactReference(file.url)
        if (reference == null)
            return ArtifactAccess(artifactHttpsUrl(file.url), file.type, file.name)
        val resolved = api.resolveArtifactReference(reference)
        return resolvedFileAccess(reference, file, resolved)
    }

    private fun resolvedFileAccess(
        reference: String,
        file: ArtifactResource.File,
        resolved: ai.okou.android.api.generated.ArtifactReference,
    ): ArtifactAccess {
        if (resolved.target.kind != ArtifactReferenceTargetKind.FILE) {
            return ArtifactAccess(null, file.type, file.name)
        }
        return ArtifactAccess(
            artifactHttpsUrl(resolved.url),
            resolved.contentType,
            resolved.filename,
            save =
                if (resolved.downloadAllowed == false) null
                else ArtifactSave(reference, resolved.filename, resolved.contentType),
            previewOnly = resolved.downloadAllowed == false,
        )
    }

    internal suspend fun fileContent(
        file: ArtifactResource.File,
        access: ArtifactAccess,
    ): ArtifactContent {
        val url = access.url ?: return ArtifactContent.Unsupported
        val type = access.type.substringBefore(';').trim().lowercase(Locale.ROOT)
        val extension = access.name.substringAfterLast('.', "").lowercase(Locale.ROOT)
        return when {
            type.startsWith("image/") && type != "image/svg+xml" ->
                readBitmap(url, 1440, MAX_IMAGE_BYTES)?.let { ArtifactContent.Image(it) }
                    ?: ArtifactContent.Unsupported
            type.startsWith("video/") -> ArtifactContent.Media(url, video = true)
            type.startsWith("audio/") -> ArtifactContent.Media(url, video = false)
            type in documentTypes ||
                (type == "application/octet-stream" && extension in documentExtensions) -> {
                val text =
                    transfers
                        .download(url, MAX_TEXT_BYTES)
                        .toString(Charsets.UTF_8)
                        .removePrefix("\uFEFF")
                ArtifactContent.Text(
                    text,
                    type == "text/markdown" || extension in setOf("md", "markdown"),
                )
            }
            else ->
                thumbnail(file.cover, 1440)?.let { ArtifactContent.Image(it) }
                    ?: ArtifactContent.Unsupported
        }
    }

    internal suspend fun siteContent(site: ArtifactResource.Site): ArtifactContent.Website {
        val url = site.url
        val preview = api.artifactSitePreview(url.host.substringBefore('.'), url.host)
        val grant = artifactHttpsUrl(preview.url) ?: throw ApiFailure.IncompatibleResponse()
        return ArtifactContent.Website(grant)
    }

    internal suspend fun thumbnail(value: String?, edge: Int = 120): Bitmap? {
        if (value == null) return null
        val resolved =
            artifactReference(value)?.let { api.resolveArtifactReference(it).url } ?: value
        val url = artifactHttpsUrl(resolved) ?: return null
        return readBitmap(url, edge, MAX_IMAGE_BYTES)
    }

    internal suspend fun save(file: ArtifactSave, destination: () -> OutputStream) {
        val grant =
            api.artifactDownload(file.reference) as? ArtifactDownloadVariant1
                ?: throw ApiFailure.IncompatibleResponse()
        val url = artifactHttpsUrl(grant.url) ?: throw ApiFailure.IncompatibleResponse()
        transfers.download(url) { source -> destination().use { output -> source.copyTo(output) } }
    }

    private suspend fun readBitmap(url: HttpUrl, edge: Int, limit: Long): Bitmap? {
        val bytes = transfers.download(url, limit)
        return withContext(Dispatchers.Default) {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            val pixels = maxOf(bounds.outHeight, bounds.outWidth)
            if (pixels <= 0) return@withContext null
            var sample = 1
            while (pixels / sample > edge) sample *= 2
            val options = BitmapFactory.Options().apply { inSampleSize = sample }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        }
    }

    private fun artifactReference(value: String): String? {
        val path =
            if (value.startsWith("/artifacts/")) value.substringBefore('#')
            else {
                val address = artifactHttpsUrl(value) ?: return null
                if (referenceOrigins.none { it.host == address.host && it.port == address.port })
                    return null
                address.encodedPath
            }
        return artifactReferencePath.matchEntire(path)?.groupValues?.get(1)
    }
}

private val artifactReferencePath =
    Regex("/artifacts/((?:[a-f0-9]{32}|[a-z0-9]{10})(?:\\.[a-z0-9]{1,12})?)")

private val messageArtifactOrigins =
    listOf(BuildConfig.WEB_ORIGIN, BuildConfig.API_ORIGIN).mapNotNull { it.toHttpUrlOrNull() }
private val hostedArtifactHost =
    Regex("[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.(?:okou\\.app|sites\\.vm[07]\\.io)")

internal fun messageArtifactLink(value: String): String? {
    if (artifactReferencePath.matches(value)) return value
    val url = artifactHttpsUrl(value) ?: return null
    if (
        messageArtifactOrigins.any { it.host == url.host && it.port == url.port } &&
            artifactReferencePath.matches(url.encodedPath)
    )
        return url.encodedPath
    return url.takeIf {
            it.port == 443 && it.host != "files.sites.vm7.io" && hostedArtifactHost.matches(it.host)
        }
        ?.toString()
}

private const val MAX_IMAGE_BYTES = 16L * 1024 * 1024
private const val MAX_TEXT_BYTES = 256L * 1024
private val documentTypes =
    setOf(
        "text/plain",
        "text/markdown",
        "text/csv",
        "text/tab-separated-values",
        "application/json",
    )
private val documentExtensions = setOf("txt", "md", "markdown", "csv", "tsv", "json", "log")

internal fun artifactHttpsUrl(value: String): HttpUrl? =
    value.toHttpUrlOrNull()?.takeIf { it.isHttps && it.username.isEmpty() && it.password.isEmpty() }

private fun artifactTimestampParser() =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply {
        timeZone = TimeZone.getTimeZone("UTC")
        isLenient = false
    }

private fun parseArtifactTimestamp(parser: SimpleDateFormat, value: String): Long =
    parser.parse(value)?.time ?: throw ApiFailure.IncompatibleResponse()

private fun ArtifactDetail.toInfo(): ArtifactInfo {
    fun entry(
        id: String,
        title: String,
        kind: ArtifactKind,
        created: String,
        source: String?,
        resource: ArtifactResource,
        browser: HttpUrl? = null,
    ) =
        ArtifactInfo(
            ArtifactItem(
                id,
                title,
                kind,
                parseArtifactTimestamp(artifactTimestampParser(), created),
            ),
            source,
            resource,
            browser,
        )

    fun site(
        id: String,
        title: String,
        kind: ArtifactKind,
        created: String,
        source: String?,
        url: String,
    ): ArtifactInfo {
        val browser = artifactHttpsUrl(url)
        return entry(
            id,
            title,
            kind,
            created,
            source,
            browser?.let { ArtifactResource.Site(it) } ?: ArtifactResource.Unsupported,
            browser,
        )
    }

    return when (this) {
        is ArtifactDetailVariant1 ->
            entry(
                id,
                title,
                if (file.filename.endsWith(".pptx", ignoreCase = true)) ArtifactKind.Presentation
                else ArtifactKind.File,
                createdAt,
                sourceChatThreadId,
                ArtifactResource.File(
                    file.url,
                    file.filename,
                    file.contentType,
                    file.previewImageUrl,
                ),
            )
        is ArtifactDetailVariant2 ->
            entry(
                id,
                title,
                ArtifactKind.Image,
                createdAt,
                sourceChatThreadId,
                ArtifactResource.File(
                    file.url,
                    file.filename,
                    file.contentType,
                    file.previewImageUrl,
                ),
            )
        is ArtifactDetailVariant3 ->
            entry(
                id,
                title,
                ArtifactKind.Video,
                createdAt,
                sourceChatThreadId,
                ArtifactResource.File(
                    file.url,
                    file.filename,
                    file.contentType,
                    file.previewImageUrl,
                ),
            )
        is ArtifactDetailVariant4 ->
            entry(
                id,
                title,
                ArtifactKind.Avatar,
                createdAt,
                sourceChatThreadId,
                ArtifactResource.File(
                    file.url,
                    file.filename,
                    file.contentType,
                    file.previewImageUrl,
                ),
            )
        is ArtifactDetailVariant5 ->
            site(id, title, ArtifactKind.Website, createdAt, sourceChatThreadId, site.url)
        is ArtifactDetailVariant6 ->
            site(id, title, ArtifactKind.Presentation, createdAt, sourceChatThreadId, site.url)
        is ArtifactDetailVariant7 ->
            entry(
                id,
                title,
                ArtifactKind.SharedConversation,
                createdAt,
                sourceChatThreadId,
                ArtifactResource.Unsupported,
                BuildConfig.WEB_ORIGIN.toHttpUrlOrNull()
                    ?.newBuilder()
                    ?.addPathSegments("share/threads")
                    ?.addPathSegment(sharedThreadId)
                    ?.build(),
            )
    }
}
