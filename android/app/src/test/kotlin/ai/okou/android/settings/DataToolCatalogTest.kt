package ai.okou.android.settings

import ai.okou.android.api.generated.dataRouterProtocolVersion
import ai.okou.android.jsonResponse
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DataToolCatalogTest {
    @Test
    fun readsAvailableFamiliesInRouterOrderThroughAnEmptyFinalCursor() = runTest {
        MockWebServer().use { server ->
            server.enqueue(discoveryPage(1, "page-2", "social", "web-search"))
            server.enqueue(discoveryPage(2, "", "finance", "image-generation"))
            server.enqueue(MockResponse().setResponseCode(400))

            DataToolCatalog(server.url("/mcp").toString()).use { catalog ->
                assertEquals(
                    listOf(
                        DataToolFamily("finance", mapOf("en-US" to "Financial data")),
                        DataToolFamily("social", mapOf("en-US" to "Social media")),
                    ),
                    catalog.read(),
                )
            }

            val first = checkNotNull(server.takeRequest(1, TimeUnit.SECONDS))
            val second = checkNotNull(server.takeRequest(1, TimeUnit.SECONDS))
            for (request in listOf(first, second)) {
                assertEquals("POST", request.method)
                assertEquals("/mcp", request.path)
                assertEquals("tools/list", request.getHeader("Mcp-Method"))
                assertEquals(dataRouterProtocolVersion, request.getHeader("MCP-Protocol-Version"))
                assertNull(request.getHeader("Authorization"))
            }
            val lastParams =
                Json.parseToJsonElement(second.body.readUtf8())
                    .jsonObject
                    .getValue("params")
                    .jsonObject
            assertEquals("page-2", lastParams.getValue("cursor").jsonPrimitive.content)
            assertEquals(2, server.requestCount)
        }
    }

    private fun discoveryPage(id: Int, cursor: String, vararg toolFamilies: String): MockResponse {
        val tools =
            toolFamilies.joinToString(",") { family ->
                """{"name":"$family-tool","inputSchema":{"type":"object"},"_meta":{"ai.okou/data":{"family":"$family"}}}"""
            }
        return jsonResponse(
            """
            {
              "jsonrpc": "2.0", "id": $id,
              "result": {
                "tools": [$tools], "nextCursor": "$cursor",
                "_meta": {"ai.okou/data": {"families": [
                  {"id":"finance","title":{"en-US":"Financial data"},"description":{}},
                  {"id":"web-search","title":{"en-US":"Search the web"},"description":{}},
                  {"id":"unused","title":{"en-US":"Unavailable"},"description":{}},
                  {"id":"social","title":{"en-US":"Social media"},"description":{}},
                  {"id":"image-generation","title":{"en-US":"Image generation"},"description":{}}
                ]}}
              }
            }
            """
                .trimIndent(),
        )
    }
}
