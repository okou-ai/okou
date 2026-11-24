package ai.okou.android.settings

import ai.okou.android.api.ApiClient
import ai.okou.android.api.awaitBytes
import ai.okou.android.api.closeTransport
import ai.okou.android.api.generated.UpdateImageModelPreference
import ai.okou.android.api.generated.UpdateImageModelPreferenceSelectedImageModel
import ai.okou.android.api.generated.UpdatePaidTool
import ai.okou.android.api.generated.dataRouterProtocolVersion
import ai.okou.android.api.httpClient
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

@Serializable
data class DataToolFamily(
    val id: String,
    val title: Map<String, String>,
)

interface BuiltInToolsService {
    suspend fun catalog(): List<DataToolFamily>

    suspend fun disabledTools(): Set<String>

    suspend fun setEnabled(id: String, enabled: Boolean): Boolean

    suspend fun imageModel(): String?

    suspend fun selectImageModel(id: String): String?
}

internal class CanonicalBuiltInToolsService(private val api: ApiClient, origin: HttpUrl) :
    BuiltInToolsService, AutoCloseable {
    private val router =
        DataToolCatalog(
            if (origin.host == "api.okou.ai") "https://data.okou.ai/mcp"
            else "https://okou-data-router-staging.vm0.workers.dev/mcp",
        )

    override suspend fun catalog() = router.read()

    override suspend fun disabledTools() =
        api.read { paidToolPreferences(it) }.disabledTools.toSet()

    override suspend fun setEnabled(id: String, enabled: Boolean) =
        !api.write { updatePaidTool(it, id, UpdatePaidTool(!enabled)) }.disabled

    override suspend fun imageModel() =
        api.read { imageModelPreference(it) }
            .selectedImageModel
            ?.let {
                Json.encodeToJsonElement(it).jsonPrimitive.content
            }

    override suspend fun selectImageModel(id: String): String? {
        val model =
            Json.decodeFromJsonElement<UpdateImageModelPreferenceSelectedImageModel>(
                JsonPrimitive(id),
            )
        return api.write { updateImageModelPreference(it, UpdateImageModelPreference(model)) }
            .selectedImageModel
            ?.let { Json.encodeToJsonElement(it).jsonPrimitive.content }
    }

    override fun close() = router.close()
}

@Serializable private data class RouterEnvelope(val result: RouterPage)

@Serializable
private data class RouterPage(
    val tools: List<RouterTool>,
    @SerialName("_meta") val metadata: RouterFamilies,
    val nextCursor: String? = null,
)

@Serializable
private data class RouterTool(@SerialName("_meta") val metadata: RouterToolMetadata? = null)

@Serializable
private data class RouterToolMetadata(
    @SerialName("ai.okou/data") val data: RouterToolFamily? = null,
)

@Serializable private data class RouterToolFamily(val family: String)

@Serializable
private data class RouterFamilies(@SerialName("ai.okou/data") val data: RouterFamilyList)

@Serializable private data class RouterFamilyList(val families: List<DataToolFamily>)

/** Public metadata transport owns its client and never receives member credentials. */
internal class DataToolCatalog(private val url: String) : AutoCloseable {
    private var transport: OkHttpClient? = null
    private var closed = false
    private val json = Json { ignoreUnknownKeys = true }

    @Synchronized
    private fun client(): OkHttpClient {
        check(!closed) { "Catalog is closed" }
        return transport ?: httpClient().build().also { transport = it }
    }

    suspend fun read(): List<DataToolFamily> =
        withContext(Dispatchers.IO) {
            withTimeoutOrNull(30_000) {
                val families = linkedMapOf<String, DataToolFamily>()
                val listed = mutableSetOf<String>()
                val cursors = mutableSetOf<String>()
                var cursor: String? = null
                do {
                    val page = page(cursor, cursors.size + 1)
                    page.tools.mapNotNullTo(listed) { it.metadata?.data?.family }
                    page.metadata.data.families.forEach { families.putIfAbsent(it.id, it) }
                    cursor = page.nextCursor
                    if (cursor != null && !cursors.add(cursor))
                        throw IOException("Repeated catalog cursor")
                } while (cursor != null)
                families.values.filter {
                    it.id in listed && it.id != webSearchTool && it.id != imageGenerationTool
                }
            } ?: throw IOException("Catalog read timed out")
        }

    private suspend fun page(cursor: String?, id: Int): RouterPage {
        val message = buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", id)
            put("method", "tools/list")
            putJsonObject("params") {
                cursor?.let { put("cursor", it) }
                putJsonObject("_meta") {
                    put("io.modelcontextprotocol/protocolVersion", dataRouterProtocolVersion)
                    putJsonObject("io.modelcontextprotocol/clientCapabilities") {}
                }
            }
        }
        val request =
            Request.Builder()
                .url(url)
                .header("Accept", "application/json")
                .header("MCP-Protocol-Version", dataRouterProtocolVersion)
                .header("Mcp-Method", "tools/list")
                .post(message.toString().toRequestBody("application/json".toMediaType()))
                .build()
        return json
            .decodeFromString<RouterEnvelope>(
                client().newCall(request).awaitBytes(2L * 1024 * 1024).decodeToString(),
            )
            .result
    }

    @Synchronized
    override fun close() {
        closed = true
        transport?.closeTransport()
        transport = null
    }
}
