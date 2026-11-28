package ai.okou.android

import android.graphics.Bitmap
import android.graphics.Color
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull

internal class ArtifactApiFixture(
    private val api: ChatListApiFixture,
    private val chinese: Boolean = false,
    private val summaryDownloadAllowed: Boolean = false,
    private val imageBody: ByteArray? = null,
    includeVideo: Boolean = false,
    private val imageDownloadAllowed: Boolean? = null,
    imageThumbnailUrl: String? = null,
) {
    data class Item(val id: String, val kind: String, val title: String, val date: String)

    private fun title(english: String, han: String) = if (chinese) han else english

    val sourceTitle = title("Review release copy and assets", "检查发布文案与素材")
    private val calendar = Calendar.getInstance()
    val checklist =
        Item(
            "10000000-1000-4000-8000-000000000001",
            "file",
            title("Release checklist", "发布前检查清单"),
            date(0),
        )
    val summary =
        Item(
            "10000000-1000-4000-8000-000000000002",
            "file",
            title("Product launch summary", "产品发布摘要"),
            date(-1, 17, 40),
        )
    val site =
        Item(
            "10000000-1000-4000-8000-000000000003",
            "hosted-site",
            title("Product launch site", "产品发布介绍页"),
            date(-1, 14, 15),
        )
    val slides =
        Item(
            "10000000-1000-4000-8000-000000000004",
            "presentation",
            title("Launch presentation", "发布准备分享"),
            date(-4),
        )
    val image =
        Item(
            "10000000-1000-4000-8000-000000000005",
            "image",
            title("Launch avatar", "发布头像示例"),
            date(-5),
        )
    val video =
        Item(
            "10000000-1000-4000-8000-000000000006",
            "file",
            title("Release walkthrough", "发布演示视频"),
            date(-6),
        )
    val allItems =
        listOfNotNull(checklist, summary, site, slides, image, video.takeIf { includeVideo })
    val checklistBody =
        title(
            "1. Check the release notes\n2. Approve the website copy\n3. Confirm the launch owner",
            "1. 核对发布文案与说明\n2. 确认官网和邮件素材\n3. 汇总负责人和待确认事项",
        )
    val summaryBody =
        title(
            "1. Positioning: help teams move ongoing work forward\n2. Audience: founders and business teams\n3. Channels: website, email, and community",
            "1. 定位：帮助团队继续推进在手工作\n2. 受众：创始人和业务团队\n3. 渠道：官网长版、邮件短版和社区配图",
        )
    var beforeCatalog: (RecordedRequest) -> Unit = {}
    var beforeDownload: () -> Unit = {}
    @Volatile var beforeSitePreview: () -> Unit = {}
    @Volatile
    var imageThumbnailUrl: String? =
        imageThumbnailUrl ?: api.server.url("/artifact-bytes/image").toString()

    @Volatile
    var imageResponse: () -> MockResponse = {
        MockResponse().setBody(Buffer().write(imageBody ?: sampleImage()))
    }
    var pageSize = 40
    @Volatile var removedCatalogIds: Set<String> = emptySet()
    var downloadGranted = true
    val catalogQueries = CopyOnWriteArrayList<Pair<String?, String?>>()
    val catalogScopes = CopyOnWriteArrayList<Pair<String?, String?>>()
    val requestedDownloads = CopyOnWriteArrayList<String>()
    val requestedReferences = CopyOnWriteArrayList<String>()
    val requestedSiteGrants = CopyOnWriteArrayList<String>()
    private val currentDispatcher = api.commandResponse

    fun installInlineHistory() {
        val intro = title("The release summary is ready.", "发布摘要已准备好。")
        api.historyReply = "$intro\n\n[${summary.title}](/artifacts/artifacts2.md)"
    }

    fun install() {
        val chatEvents = api.events
        api.events = { request ->
            if (request.requestUrl?.queryParameter("sinceSeqId") == null) {
                jsonResponse(
                    """{"events":[${chatEventWire(title = sourceTitle)}],"hasMore":false}""",
                )
            } else chatEvents(request)
        }
        api.commandResponse = { request ->
            when (val path = checkNotNull(request.requestUrl).encodedPath) {
                "/api/artifacts/catalog" -> page(request)
                "/api/host/sites/fixture/preview" -> {
                    assertEquals("fixture.okou.app", request.requestUrl?.queryParameter("hostname"))
                    val grant =
                        api.server
                            .url("/artifact-bytes/site")
                            .newBuilder()
                            .addQueryParameter("grant", UUID.randomUUID().toString())
                            .build()
                    requestedSiteGrants.add(grant.toString())
                    beforeSitePreview()
                    jsonResponse("""{"url":"$grant","expiresAt":null}""")
                }
                "/artifact-bytes/site" ->
                    MockResponse()
                        .setHeader("Content-Type", "text/html; charset=utf-8")
                        .setBody("<!doctype html><title>${site.title}</title><p>${site.title}</p>")
                "/artifact-bytes/image" -> {
                    assertNull(request.getHeader("Authorization"))
                    MockResponse().setBody(Buffer().write(imageBody ?: sampleImage()))
                }
                "/artifact-bytes/image-preview" -> {
                    assertNull(request.getHeader("Authorization"))
                    imageResponse()
                }
                "/artifact-bytes/checklist",
                "/artifact-bytes/summary" -> {
                    assertNull(request.getHeader("Authorization"))
                    MockResponse()
                        .setBody(if (path.endsWith("/summary")) summaryBody else checklistBody)
                }
                else -> {
                    val detail = allItems.firstOrNull { path == "/api/artifacts/catalog/${it.id}" }
                    when {
                        detail != null -> detail(detail)
                        path == "/api/artifact-references/checklist1.md" ->
                            reference(checklist, "checklist", true)
                        path == "/api/artifact-references/artifacts2.md" -> {
                            requestedReferences.add(path)
                            reference(summary, "summary", summaryDownloadAllowed)
                        }
                        path == "/api/artifact-references/thumbnail1.png" &&
                            imageDownloadAllowed != null ->
                            reference(image, "image-preview", imageDownloadAllowed)
                        path == "/api/artifact-references/checklist1.md/download" -> {
                            requestedDownloads.add(path)
                            beforeDownload()
                            if (downloadGranted)
                                jsonResponse(
                                    """{"kind":"file","filename":"checklist.md","contentType":"text/markdown","url":"${api.server.url("/artifact-bytes/checklist")}"}""",
                                )
                            else
                                jsonResponse(
                                        """{"error":{"code":"PAYMENT_REQUIRED","message":"Unavailable"}}""",
                                    )
                                    .setResponseCode(402)
                        }
                        else -> currentDispatcher(request)
                    }
                }
            }
        }
    }

    fun sampleImage(color: Int = Color.rgb(220, 190, 164)): ByteArray {
        val bitmap = Bitmap.createBitmap(24, 24, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(color)
        try {
            val output = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
            return output.toByteArray()
        } finally {
            bitmap.recycle()
        }
    }

    private fun date(days: Int, hour: Int = 10, minute: Int = 20): String {
        val date =
            (calendar.clone() as Calendar)
                .apply {
                    add(Calendar.DATE, days)
                    set(Calendar.HOUR_OF_DAY, hour)
                    set(Calendar.MINUTE, minute)
                    set(Calendar.SECOND, 0)
                    set(Calendar.MILLISECOND, 0)
                }
                .time
        return SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }
            .format(date)
    }

    private fun page(request: RecordedRequest): MockResponse {
        assertEquals("Bearer fixture-token", request.getHeader("Authorization"))
        beforeCatalog(request)
        val url = checkNotNull(request.requestUrl)
        val keyword = url.queryParameter("keyword")
        val kind = url.queryParameter("kind")
        val threadId = url.queryParameter("chatThreadId")
        catalogScopes.add(threadId to url.queryParameter("cursor"))
        val offset = url.queryParameter("cursor")?.toInt() ?: 0
        catalogQueries.add(kind to keyword)
        val removed = removedCatalogIds
        val items = allItems.filter {
            it.id !in removed &&
                (threadId == null || threadId == CHAT_PERSONAL && it != image) &&
                (kind == null || it.kind == kind) &&
                (keyword == null || it.title.contains(keyword, ignoreCase = true))
        }
        val selected = items.drop(offset).take(pageSize)
        return jsonResponse(
            buildJsonObject {
                put("artifacts", JsonArray(selected.map(::wire)))
                put(
                    "nextCursor",
                    (offset + selected.size)
                        .takeIf { it < items.size }
                        ?.toString()
                        ?.let(::JsonPrimitive) ?: kotlinx.serialization.json.JsonNull,
                )
            }
                .toString(),
        )
    }

    private fun wire(item: Item) = buildJsonObject {
        put("id", item.id)
        put("title", item.title)
        put("kind", item.kind)
        put("createdAt", item.date)
        put("updatedAt", item.date)
        put(
            "thumbnail",
            if (item == image)
                imageThumbnailUrl?.let { url -> buildJsonObject { put("url", url) } }
                    ?: kotlinx.serialization.json.JsonNull
            else kotlinx.serialization.json.JsonNull,
        )
    }

    private fun detail(item: Item) =
        jsonResponse(
            buildJsonObject {
                wire(item).forEach { (name, value) -> put(name, value) }
                if (item == summary || item == site) put("sourceChatThreadId", CHAT_PERSONAL)
                when (item) {
                    site,
                    slides ->
                        put(
                            "site",
                            Json.parseToJsonElement(
                                """{"id":"${item.id}","slug":"fixture","publicSlug":"fixture","url":"https://fixture.okou.app/","deploymentVersion":1,"entrypoint":"index.html","spaFallback":false}""",
                            ),
                        )
                    else -> {
                        val path =
                            when (item) {
                                checklist -> "/artifacts/checklist1.md"
                                summary -> "/artifacts/artifacts2.md"
                                image ->
                                    if (imageDownloadAllowed != null) "/artifacts/thumbnail1.png"
                                    else api.server.url("/artifact-bytes/image").toString()
                                video -> api.server.url("/artifact-bytes/video").toString()
                                else -> api.server.url("/artifact-bytes/image").toString()
                            }
                        val (filename, type) =
                            when (item) {
                                image -> "avatar.png" to "image/png"
                                video -> "walkthrough.mp4" to "video/mp4"
                                else -> "launch.md" to "text/markdown"
                            }
                        put(
                            "file",
                            Json.parseToJsonElement(
                                """{"id":"${item.id}","filename":"$filename","contentType":"$type","size":40,"url":"$path","previewImageUrl":null}""",
                            ),
                        )
                        if (item == image) {
                            put("model", kotlinx.serialization.json.JsonNull)
                            put("provider", kotlinx.serialization.json.JsonNull)
                        }
                    }
                }
            }
                .toString(),
        )

    private fun reference(item: Item, path: String, downloadAllowed: Boolean): MockResponse {
        val filename = if (item == image) "avatar.png" else "$path.md"
        val type = if (item == image) "image/png" else "text/markdown"
        return jsonResponse(
            """{"artifactId":"${item.id}","url":"${api.server.url("/artifact-bytes/$path")}","expiresAt":"${date(1)}","downloadUrl":"${api.server.url("/artifact-bytes/$path")}","downloadAllowed":$downloadAllowed,"filename":"$filename","contentType":"$type","target":{"kind":"file","id":"${item.id}"}}""",
        )
    }
}
