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
import ai.okou.android.api.generated.ArtifactDownloadVariant1
import ai.okou.android.api.generated.ArtifactReferenceTargetKind
import ai.okou.android.api.generated.RelatedCommunicatingChatsItemsItemStatus
import ai.okou.android.api.generated.RelatedCreatedChatsItemsItemStatus
import ai.okou.android.chat.ChatAttachmentReference
import ai.okou.android.chat.isAttachmentImage
import ai.okou.android.chat.isAttachmentVideo
import ai.okou.android.chat.renderHistoryMarkdown
import ai.okou.android.workflows.workflowDisplayTitle
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.ui.text.AnnotatedString
import java.io.OutputStream
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

enum class ArtifactKind {
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

internal class ChatAttachmentAccessLost(val rejection: ApiFailure.Http) : Exception(rejection)

internal data class ArtifactInfo(
    val item: ArtifactItem,
    val sourceChatId: String?,
    val resource: ArtifactResource,
    val browserUrl: HttpUrl? = null,
    val resolvedAccess: ArtifactAccess? = null,
    val linkSource: ArtifactLinkSource? = null,
) {
    val thumbnailUrl: String?
        get() = item.thumbnail ?: (resource as? ArtifactResource.File)?.cover

    fun independentThumbnailUrl(originalUrl: String?): String? {
        val file = resource as? ArtifactResource.File ?: return null
        return listOfNotNull(item.thumbnail, file.cover).firstOrNull {
            it != file.url && it != originalUrl
        }
    }
}

internal sealed interface ArtifactResource {
    data class File(val url: String, val name: String, val type: String, val cover: String?) :
        ArtifactResource

    data class Site(val url: HttpUrl) : ArtifactResource

    data class ResolvedHtml(val url: HttpUrl) : ArtifactResource

    data object Unsupported : ArtifactResource
}

internal sealed interface ArtifactContent {
    data class Text(val rendered: AnnotatedString, val markdown: Boolean) : ArtifactContent

    data class Image(val bitmap: Bitmap) : ArtifactContent

    class EncodedImage(val bytes: ByteArray, val fallback: Bitmap? = null) : ArtifactContent

    data class Website(val url: HttpUrl, val remainingRetries: Int) : ArtifactContent

    data class Media(val url: HttpUrl, val video: Boolean) : ArtifactContent

    data object Unsupported : ArtifactContent
}

internal data class ArtifactAccess(
    val url: HttpUrl?,
    val type: String,
    val name: String,
    val save: ArtifactSave? = null,
    val previewOnly: Boolean = false,
    val linkSource: ArtifactLinkSource.File? = null,
)

class ArtifactService
internal constructor(
    private val api: ApiClient,
    private val transfers: SignedTransferClient,
    apiOrigin: String,
) {
    internal val links = ArtifactLinkAccess(api)

    private val referenceOrigins =
        setOfNotNull(apiOrigin.toHttpUrlOrNull(), BuildConfig.WEB_ORIGIN.toHttpUrlOrNull())

    internal suspend fun relatedChats(
        threadId: String,
        communicating: Boolean,
    ): List<RelatedChatResource> =
        if (communicating) {
            api.relatedCommunicatingChats(threadId).items.map {
                RelatedChatResource(
                    it.threadId,
                    it.title,
                    it.lastMessageAt,
                    it.status != RelatedCommunicatingChatsItemsItemStatus.UNAVAILABLE,
                )
            }
        } else {
            api.relatedCreatedChats(threadId).items.map {
                RelatedChatResource(
                    it.threadId,
                    it.title,
                    it.createdAt,
                    it.status != RelatedCreatedChatsItemsItemStatus.UNAVAILABLE,
                )
            }
        }

    internal suspend fun relatedWorkflows(ids: Set<String>): List<WorkflowResource> =
        api.workflows().mapNotNull {
            if (it.id in ids && it.official == null)
                WorkflowResource(it.id, workflowDisplayTitle(it.name, it.displayName))
            else null
        }

    internal suspend fun page(
        query: ArtifactQuery,
        cursor: String?,
        limit: Int = 40,
    ): ArtifactPage {
        val page =
            api.artifactCatalog(
                ArtifactCatalogQuery(
                    limit = limit.toLong(),
                    chatThreadId = query.chatThreadId,
                    kind = query.filter.wire,
                    keyword = query.keyword.ifBlank { null },
                    cursor = cursor,
                ),
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
        if (id.startsWith(ExternalImagePreviewPrefix)) return externalImageInfo(id)
        chatAttachment(id)?.let { file ->
            val grant = resolveChatUpload(file)
            val kind =
                when {
                    file.contentType.isAttachmentImage -> ArtifactKind.Image
                    file.contentType.isAttachmentVideo -> ArtifactKind.Video
                    else -> ArtifactKind.File
                }
            val access =
                ArtifactAccess(
                    artifactHttpsUrl(grant.url),
                    file.contentType,
                    file.filename,
                    save = ArtifactSave(id, file.filename, file.contentType),
                )
            return ArtifactInfo(
                ArtifactItem(id, file.filename, kind, null),
                null,
                ArtifactResource.File(id, file.filename, file.contentType, grant.previewImageUrl),
                resolvedAccess = access,
            )
        }
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
                        linkSource =
                            if (resolved.sharedThreadSnapshot == null)
                                ArtifactLinkSource.LegacyDeployment(resolved.target.id)
                            else null,
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
            return messageSiteInfo(id, checkNotNull(artifactHttpsUrl(link)))
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
            linkSource =
                if (resolved.sharedThreadSnapshot == null && resolved.artifactId != null)
                    ArtifactLinkSource.File(resolved.artifactId)
                else null,
        )
    }

    internal suspend fun fileContent(
        file: ArtifactResource.File,
        access: ArtifactAccess,
        keepImageSource: Boolean,
    ): ArtifactContent {
        val url = access.url ?: return ArtifactContent.Unsupported
        val type = access.type.substringBefore(';').trim().lowercase(Locale.ROOT)
        val extension = access.name.substringAfterLast('.', "").lowercase(Locale.ROOT)
        return when {
            type.startsWith("image/") && type != "image/svg+xml" ->
                if (keepImageSource)
                    ArtifactContent.EncodedImage(transfers.download(url, MAX_IMAGE_BYTES))
                else
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
                val markdown = type == "text/markdown" || extension in setOf("md", "markdown")
                val rendered =
                    if (markdown)
                        withContext(Dispatchers.Default) {
                            renderHistoryMarkdown(text, compactLists = true)
                        }
                    else AnnotatedString(text)
                ArtifactContent.Text(rendered, markdown)
            }
            else ->
                thumbnail(file.cover, 1440)?.let { ArtifactContent.Image(it) }
                    ?: ArtifactContent.Unsupported
        }
    }

    internal suspend fun sitePreviewUrl(site: ArtifactResource.Site): HttpUrl {
        val url = site.url
        val preview = api.artifactSitePreview(url.host.substringBefore('.'), url.host)
        return artifactHttpsUrl(preview.url) ?: throw ApiFailure.IncompatibleResponse()
    }

    internal suspend fun thumbnail(value: String?, edge: Int = 120): Bitmap? {
        if (value == null) return null
        val resolved =
            artifactReference(value)?.let { api.resolveArtifactReference(it).url } ?: value
        val url = artifactHttpsUrl(resolved) ?: return null
        return readBitmap(url, edge, MAX_IMAGE_BYTES)
    }

    internal suspend fun readInlineImage(
        source: String,
        width: Int,
        cached: CachedInlineThumbnail?,
        onAuthorized: (InlineImageGrant) -> Unit,
    ): Bitmap? {
        if (source.startsWith(ExternalImagePreviewPrefix)) {
            val info = externalImageInfo(source)
            val url = checkNotNull(info.resolvedAccess?.url)
            val bitmap =
                readBitmap(url, width, MAX_IMAGE_BYTES) ?: throw ApiFailure.IncompatibleResponse()
            onAuthorized(InlineImageGrant(source, info.item.title))
            return bitmap
        }
        val image = authorizeInlineImage(source)
        onAuthorized(image.grant)
        return cached?.takeIf { it.grant.fileId == image.grant.fileId }?.bitmap
            ?: image.loadThumbnail(width)
    }

    internal suspend fun revalidateInlineImage(source: String): InlineImageGrant =
        authorizeInlineImage(source).grant

    private class AuthorizedInlineImage(
        val grant: InlineImageGrant,
        val loadThumbnail: suspend (Int) -> Bitmap?,
    )

    private suspend fun authorizeInlineImage(source: String): AuthorizedInlineImage {
        chatAttachment(source)?.let { file ->
            if (!file.contentType.isAttachmentImage) throw ApiFailure.IncompatibleResponse()
            val grant = resolveChatUpload(file)
            val url = artifactHttpsUrl(grant.url) ?: throw ApiFailure.IncompatibleResponse()
            return AuthorizedInlineImage(InlineImageGrant(source, file.filename, file.id)) { width
                ->
                thumbnail(grant.previewImageUrl, width)
                    ?: readBitmap(
                        url.inlineThumbnail(width, file.contentType) ?: url,
                        width,
                        MAX_IMAGE_BYTES,
                    )
            }
        }
        val reference = artifactReference(source) ?: throw ApiFailure.IncompatibleResponse()
        val resolved = api.resolveArtifactReference(reference)
        val original = artifactHttpsUrl(resolved.url) ?: throw ApiFailure.IncompatibleResponse()
        if (
            resolved.target.kind != ArtifactReferenceTargetKind.FILE ||
                !resolved.contentType.startsWith("image/", ignoreCase = true)
        )
            throw ApiFailure.IncompatibleResponse()
        val cover =
            resolved.previewImageUrl?.takeUnless {
                it == resolved.url || artifactReference(it) == reference
            }
        return AuthorizedInlineImage(
            InlineImageGrant(source, resolved.filename, resolved.target.id),
        ) { width ->
            val resized = original.inlineThumbnail(width, resolved.contentType)
            if (resized != null) readBitmap(resized, width, MAX_IMAGE_BYTES)
            else thumbnail(cover, width)
        }
    }

    private fun externalImageInfo(id: String): ArtifactInfo {
        val url =
            artifactHttpsUrl(id.removePrefix(ExternalImagePreviewPrefix))
                ?: throw ApiFailure.IncompatibleResponse()
        val filename = url.pathSegments.last().ifBlank { url.host }
        val type = "image/*"
        return ArtifactInfo(
            ArtifactItem(id, filename, ArtifactKind.Image, null),
            null,
            ArtifactResource.File(url.toString(), filename, type, null),
            resolvedAccess = ArtifactAccess(url, type, filename, previewOnly = true),
        )
    }

    // These are the policy-checked delivery and signed R2 transform paths used by Web.
    private fun HttpUrl.inlineThumbnail(width: Int, contentType: String): HttpUrl? {
        if (
            port != 443 ||
                contentType.substringBefore(';').trim().lowercase(Locale.ROOT) !in
                    thumbnailImageTypes
        )
            return null
        val height = (width * 9 / 10).coerceAtLeast(1)
        if (host in artifactDeliveryHosts && artifactDeliveryPath.matches(encodedPath)) {
            return newBuilder()
                .setQueryParameter("thumbnail", "1")
                .setQueryParameter("width", width.toString())
                .setQueryParameter("height", height.toString())
                .setQueryParameter("fit", "scale-down")
                .setQueryParameter("quality", "85")
                .build()
        }
        val transform =
            "/cdn-cgi/image/width=$width,height=$height,fit=scale-down,format=auto,quality=85,metadata=none"
        if (
            host.endsWith(".r2.cloudflarestorage.com") && queryParameter("X-Amz-Signature") != null
        ) {
            val origin =
                if (referenceOrigins.any { it.host == "app.okou.ai" }) "https://a.okou.io"
                else "https://cdn.vm7.io"
            return artifactHttpsUrl("$origin$transform/$this")
        }
        if (host !in artifactResizeHosts || encodedPath.startsWith("/cdn-cgi/image/")) return null
        return newBuilder().encodedPath("$transform$encodedPath").build()
    }

    internal suspend fun save(file: ArtifactSave, destination: () -> OutputStream) {
        val attachment = chatAttachment(file.reference)
        val reference =
            if (attachment != null) resolveChatUpload(attachment).downloadUrl
            else {
                val grant =
                    api.artifactDownload(file.reference) as? ArtifactDownloadVariant1
                        ?: throw ApiFailure.IncompatibleResponse()
                grant.url
            }
        val url = artifactHttpsUrl(reference) ?: throw ApiFailure.IncompatibleResponse()
        transfers.download(url) { source -> destination().use { output -> source.copyTo(output) } }
    }

    private suspend fun resolveChatUpload(file: ChatAttachmentReference) =
        try {
            api.resolveChatUpload(file.id)
        } catch (error: ApiFailure.Http) {
            if (file.contentType.isAttachmentImage && (error.status == 403 || error.status == 404))
                throw ChatAttachmentAccessLost(error)
            throw error
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

private const val ChatAttachmentPreviewPrefix = "chat-attachment:"

internal fun isGeneratedArtifactPreview(id: String): Boolean =
    !id.startsWith(ExternalImagePreviewPrefix) && chatAttachment(id) == null

internal fun isChatAttachmentImage(id: String): Boolean =
    chatAttachment(id)?.contentType?.isAttachmentImage == true

internal fun ChatAttachmentReference.attachmentPreviewId(): String =
    ChatAttachmentPreviewPrefix +
        listOf(id, filename, contentType).joinToString("/") { Uri.encode(it) }

internal fun chatAttachment(value: String): ChatAttachmentReference? {
    if (!value.startsWith(ChatAttachmentPreviewPrefix)) return null
    val parts = value.removePrefix(ChatAttachmentPreviewPrefix).split('/')
    if (parts.size != 3) return null
    val (id, name, type) = parts.map(Uri::decode)
    return if (id.isNotBlank() && name.isNotBlank() && type.isNotBlank())
        ChatAttachmentReference(id, name, type)
    else null
}

private val artifactReferencePath =
    Regex("/artifacts/((?:[a-f0-9]{32}|[a-z0-9]{10})(?:\\.[a-z0-9]{1,12})?)")

private val messageArtifactOrigins =
    listOf(BuildConfig.WEB_ORIGIN, BuildConfig.API_ORIGIN).mapNotNull { it.toHttpUrlOrNull() }
private val hostedArtifactHost =
    Regex("[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.(?:okou\\.app|sites\\.vm[07]\\.io)")

internal fun messageArtifactLink(value: String): String? {
    val path = value.substringBefore('#')
    if (artifactReferencePath.matches(path)) return path
    val url = artifactHttpsUrl(value) ?: return null
    if (
        messageArtifactOrigins.any { it.host == url.host && it.port == url.port } &&
            url.query == null &&
            artifactReferencePath.matches(url.encodedPath)
    )
        return url.encodedPath
    return url.takeIf {
            it.port == 443 && it.host != "files.sites.vm7.io" && hostedArtifactHost.matches(it.host)
        }
        ?.newBuilder()
        ?.encodedPath("/")
        ?.query(null)
        ?.fragment(null)
        ?.build()
        ?.toString()
}

internal fun knownMessageSiteInfo(id: String): ArtifactInfo? =
    messageArtifactLink(id)?.let(::artifactHttpsUrl)?.let { messageSiteInfo(id, it) }

private fun messageSiteInfo(id: String, site: HttpUrl): ArtifactInfo =
    ArtifactInfo(
        ArtifactItem(id, site.host, ArtifactKind.Website, null),
        null,
        ArtifactResource.Site(site),
        linkSource = ArtifactLinkSource.Website(site),
    )

private const val MAX_IMAGE_BYTES = 16L * 1024 * 1024
private val artifactDeliveryHosts = setOf("a.okou.io", "files.sites.vm7.io")
private val artifactResizeHosts =
    artifactDeliveryHosts +
        setOf("cdn.vm0.io", "cdn.okou.io", "cdn.vm7.io", "static.vm0.io", "static.okou.io")
private val artifactDeliveryPath = Regex("/(?:[a-z0-9]{10}|[a-f0-9]{24})\\.[a-z0-9]{1,12}")
private val thumbnailImageTypes =
    setOf(
        "image/avif",
        "image/gif",
        "image/heic",
        "image/jpeg",
        "image/png",
        "image/svg+xml",
        "image/webp",
    )
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
        linkSource: ArtifactLinkSource? = null,
        thumbnail: String? = null,
    ) =
        ArtifactInfo(
            ArtifactItem(
                id,
                title,
                kind,
                parseArtifactTimestamp(artifactTimestampParser(), created),
                thumbnail,
            ),
            source,
            resource,
            browser,
            linkSource = linkSource,
        )

    fun site(
        id: String,
        title: String,
        kind: ArtifactKind,
        created: String,
        source: String?,
        url: String,
        siteId: String,
        version: Double?,
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
            browser?.let {
                ArtifactLinkSource.Website(it, siteId, version?.toInt(), artifactId = id)
            },
        )
    }

    return when (this) {
        is ArtifactDetailVariant1 ->
            entry(
                id,
                title,
                when {
                    file.filename.endsWith(".pptx", ignoreCase = true) -> ArtifactKind.Presentation
                    file.contentType.startsWith("video/", ignoreCase = true) -> ArtifactKind.Video
                    else -> ArtifactKind.File
                },
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
                thumbnail = thumbnail?.url,
            )
        is ArtifactDetailVariant3 ->
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
        is ArtifactDetailVariant4 ->
            site(
                id,
                title,
                ArtifactKind.Website,
                createdAt,
                sourceChatThreadId,
                site.url,
                site.id,
                site.deploymentVersion,
            )
        is ArtifactDetailVariant5 ->
            site(
                id,
                title,
                ArtifactKind.Presentation,
                createdAt,
                sourceChatThreadId,
                site.url,
                site.id,
                site.deploymentVersion,
            )
        is ArtifactDetailVariant6 ->
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
