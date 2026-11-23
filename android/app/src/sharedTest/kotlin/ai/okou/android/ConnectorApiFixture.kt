package ai.okou.android

import ai.okou.android.api.ApiClient
import ai.okou.android.api.ApiFailure
import ai.okou.android.connectors.ConnectorService
import java.io.Closeable
import java.net.ConnectException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest

internal const val CONNECTOR_CALENDAR = "google-calendar"
internal const val CONNECTOR_CALENDAR_PRIMARY = "10000000-0000-4000-8000-000000000001"
internal const val CONNECTOR_CALENDAR_SECONDARY = "10000000-0000-4000-8000-000000000002"
internal const val CONNECTOR_SLACK_ACCOUNT = "10000000-0000-4000-8000-000000000003"
internal const val CONNECTOR_GMAIL_ACCOUNT = "10000000-0000-4000-8000-000000000004"
internal const val CONNECTOR_OAUTH_ATTEMPT = "20000000-0000-4000-8000-000000000001"
internal const val CONNECTOR_AUTHORIZATION_URL = "https://provider.example/authorize?fixture=one"
internal const val CONNECTOR_DEVICE_EXAMPLE = "device-example"
internal const val CONNECTOR_MANUAL_EXAMPLE = "manual-example"
internal const val CONNECTOR_EXAMPLE_DEVICE_CODE = "ABCD-1234"

internal class ConnectorApiFixture(includeGrantExamples: Boolean = false) : Closeable {
    private val https = FixtureHttpsServer()
    private val api: ApiClient
    val service: ConnectorService
    @Volatile var discoveryRequested = CountDownLatch(1)
    @Volatile var discoveryGate: CountDownLatch? = null
    @Volatile var omittedFromDefaultBrowse: Set<String> = emptySet()
    @Volatile var unavailableCatalogSlugs: Set<String> = emptySet()
    @Volatile var failDiscovery = false
    @Volatile var denyDefaultDiscovery = false
    @Volatile var failAccountReads = false
    @Volatile var loseRenameReply = false
    @Volatile var deferRenameCommit = false
    @Volatile var renameReplyGate: CountDownLatch? = null
    val defaultReplyStarted = CountDownLatch(1)
    @Volatile var defaultReplyGate: CountDownLatch? = null
    @Volatile var failOauthCompletion = false
    @Volatile var oauthCompletion: String? = null
    @Volatile var rejectConnection = false
    @Volatile var loseManualReply = false
    val renameRequests = AtomicInteger()
    val manualRequests = AtomicInteger()
    private var pendingRename: Pair<String, String?>? = null
    private val entries = buildList {
        add(
            CatalogEntry(
                CONNECTOR_CALENDAR,
                "Google Calendar",
                "查看日程、查找空闲时间和创建会议。",
                "meetings-scheduling",
                0,
            )
        )
        if (includeGrantExamples) {
            add(
                CatalogEntry(
                    CONNECTOR_DEVICE_EXAMPLE,
                    "Device authorization sample",
                    "Connect using a code supplied by the service.",
                    "engineering-team-execution",
                    null,
                    grantKind = "device-auth",
                )
            )
            add(
                CatalogEntry(
                    CONNECTOR_MANUAL_EXAMPLE,
                    "Manual setup sample",
                    "Set up a sample workspace account.",
                    "engineering-team-execution",
                    null,
                    grantKind = "manual",
                )
            )
        }
        add(CatalogEntry("gmail", "Gmail", "查找邮件、整理往来记录和起草回复。", "email", 1))
        add(CatalogEntry("slack", "Slack", "查找团队消息、读取频道并起草更新。", "communication-collaboration", 2))
        add(
            CatalogEntry(
                "google-drive",
                "Google Drive",
                "找到文件并阅读已有资料。",
                "docs-files-knowledge",
                null,
            )
        )
        listOf("meetings-scheduling", "email", "communication-collaboration").forEachIndexed {
            categoryIndex,
            category ->
            repeat(3) { rank ->
                add(
                    CatalogEntry(
                        "$category-$rank",
                        "Service $categoryIndex–$rank",
                        "A related service.",
                        category,
                        10 + categoryIndex * 3 + rank,
                    )
                )
            }
        }
    }
    private val accounts =
        linkedMapOf(
            CONNECTOR_CALENDAR_PRIMARY to
                FixtureAccount(CONNECTOR_CALENDAR, "工作日历", "calendar@example.com", enabled = true),
            CONNECTOR_CALENDAR_SECONDARY to
                FixtureAccount(
                    CONNECTOR_CALENDAR,
                    "协作日历",
                    "team@example.com",
                    scopeMismatch = true,
                ),
            CONNECTOR_SLACK_ACCOUNT to
                FixtureAccount("slack", "示例团队", "Example workspace", expired = true),
        )

    init {
        https.server.dispatcher =
            object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val url = checkNotNull(request.requestUrl)
                    if (request.getHeader("Authorization") != "Bearer connector-test")
                        return rejected(401)
                    if (url.encodedPath == "/api/connector-catalog/discovery") {
                        discoveryRequested.countDown()
                        discoveryGate?.await()
                        if (failDiscovery) return rejected(503)
                        val keyword = url.queryParameter("keyword")
                        val category = url.queryParameter("category")
                        if (denyDefaultDiscovery && keyword == null && category == null)
                            return rejected(403)
                        val unavailable = unavailableCatalogSlugs
                        val available = entries.filterNot { it.slug in unavailable }
                        val matched =
                            available.filter {
                                (category == null || it.category == category) &&
                                    (keyword == null ||
                                        it.name.contains(keyword, true) ||
                                        it.slug.contains(keyword, true)) &&
                                    (keyword != null ||
                                        category != null ||
                                        it.slug !in omittedFromDefaultBrowse)
                            }
                        return json(
                            buildJsonObject {
                                put("connectors", JsonArray(matched.map(CatalogEntry::body)))
                                put("totalConnectorCount", available.size)
                                put(
                                    "categoryConnectorCounts",
                                    buildJsonObject {
                                        for ((key, entry) in available.groupBy { it.category }) put(
                                            key,
                                            entry.size,
                                        )
                                    },
                                )
                            }
                        )
                    }
                    val response = synchronized(accounts) { respond(request) }
                    if (
                        request.method == "PATCH" &&
                            url.pathSegments.getOrNull(1) == "connector-accounts"
                    )
                        renameReplyGate?.await()
                    if (
                        request.method == "PUT" &&
                            url.pathSegments.getOrNull(1) == "connector-account-access" &&
                            url.pathSegments.last() == "default-enabled"
                    ) {
                        defaultReplyStarted.countDown()
                        defaultReplyGate?.await()
                    }
                    return response
                }
            }
        api =
            ApiClient(
                https.server.url("/"),
                {
                    if (rejectConnection)
                        throw ApiFailure.Network(ConnectException("Fixture connection refused"))
                    "connector-test"
                },
            )
        service = ConnectorService(api)
    }

    fun authorizeGmail() {
        synchronized(accounts) {
            accounts[CONNECTOR_GMAIL_ACCOUNT] = FixtureAccount("gmail", null, "gmail@example.com")
            oauthCompletion = CONNECTOR_GMAIL_ACCOUNT
        }
    }

    fun removeAccount(id: String) {
        synchronized(accounts) { accounts.remove(id) }
    }

    fun commitDeferredRename() {
        synchronized(accounts) {
            val (id, name) = checkNotNull(pendingRename)
            accounts.getValue(id).name = name
            pendingRename = null
        }
    }

    private fun respond(request: RecordedRequest): MockResponse {
        val url = checkNotNull(request.requestUrl)
        val path = url.encodedPath
        val parts = url.pathSegments
        val querySlug = url.queryParameter("connectorSlug")
        return when {
            path == "/api/chat-connector-overview" ->
                json(
                    JsonArray(
                        accounts.entries
                            .groupBy { it.value.slug }
                            .map { (slug, rows) ->
                                buildJsonObject {
                                    put("target", target(slug))
                                    put("label", entries.first { it.slug == slug }.name)
                                    put("icon", Json.parseToJsonElement(icon))
                                    put("hasPermissions", true)
                                    put("currentConnectionId", Json.parseToJsonElement("null"))
                                    put(
                                        "accounts",
                                        JsonArray(
                                            rows.map { (id, account) ->
                                                buildJsonObject {
                                                    put("connectionId", id)
                                                    put("displayName", account.name)
                                                    put("defaultEnabled", account.enabled)
                                                    put(
                                                        "isDefault",
                                                        id == CONNECTOR_CALENDAR_PRIMARY,
                                                    )
                                                    put("authMethod", account.authMethod)
                                                    put(
                                                        "externalId",
                                                        Json.parseToJsonElement("null"),
                                                    )
                                                    put(
                                                        "externalUsername",
                                                        Json.parseToJsonElement("null"),
                                                    )
                                                    put("externalEmail", account.email)
                                                    put(
                                                        "overrideEnabled",
                                                        Json.parseToJsonElement("null"),
                                                    )
                                                    put("enabled", account.enabled)
                                                }
                                            }
                                        ),
                                    )
                                }
                            }
                    )
                )
            parts.getOrNull(1) == "connector-catalog" -> {
                val slug = parts.getOrNull(2)
                if (slug in unavailableCatalogSlugs) return rejected(404)
                val entry = entries.find { it.slug == slug } ?: return rejected(404)
                if (parts.getOrNull(3) == "permissions") {
                    val (read, write) =
                        if (slug == "gmail") "读取邮件" to "起草与发送邮件" else "读取日历与日程" to "创建和更新日程"
                    jsonResponse(
                        """{"permissions":{"connectorSlug":"$slug","label":"${entry.name}","icon":$icon,"permissionCount":2,"permissions":[{"name":"$read"},{"name":"$write"}],"categories":null,"defaultPolicy":{"permissionDefault":"ask","unknownPolicy":"deny"}}}"""
                    )
                } else json(buildJsonObject { put("connector", entry.body()) })
            }
            path == "/api/connector-accounts/inspect" -> {
                val selected = body(request).getValue("selections").jsonArray
                json(
                    buildJsonObject {
                        put(
                            "results",
                            JsonArray(
                                selected.mapNotNull {
                                    val selection = it.jsonObject
                                    val id =
                                        selection.getValue("connectionId").jsonPrimitive.content
                                    val account = accounts[id] ?: return@mapNotNull null
                                    if (selection["target"] != target(account.slug))
                                        return@mapNotNull null
                                    val common =
                                        account.row(id).filterKeys { key ->
                                            key in
                                                setOf(
                                                    "target",
                                                    "authMethod",
                                                    "displayName",
                                                    "externalId",
                                                    "externalUsername",
                                                    "externalEmail",
                                                    "connectionStatus",
                                                    "reconnectReason",
                                                    "missingRequiredFields",
                                                    "configuredFieldKeys",
                                                )
                                        }
                                    JsonObject(
                                        common +
                                            buildJsonObject {
                                                put("kind", "available")
                                                put("connectionId", id)
                                            }
                                    )
                                }
                            ),
                        )
                    }
                )
            }
            path == "/api/connector-accounts/connections" -> {
                if (failAccountReads) return rejected(503)
                if (
                    querySlug == null ||
                        url.queryParameter("kind") != "builtin" ||
                        url.queryParameter("includeScopeMismatch") != "true" ||
                        url.queryParameter("limit") != "100"
                )
                    return rejected(400)
                json(
                    buildJsonObject {
                        put(
                            "connections",
                            JsonArray(
                                accounts
                                    .filterValues { it.slug == querySlug }
                                    .map { (id, account) -> account.row(id) }
                            ),
                        )
                        put("nextCursor", Json.parseToJsonElement("null"))
                        put("defaultConnection", Json.parseToJsonElement("null"))
                    }
                )
            }
            path == "/api/connector-account-access/defaults" ->
                json(
                    JsonArray(
                        accounts
                            .filterValues { it.slug == querySlug }
                            .map { (id, account) -> account.defaults(id) }
                    )
                )
            parts.getOrNull(1) == "connector-account-access" &&
                parts.getOrNull(3) == "default-enabled" -> {
                val id = parts[2]
                val account = accounts[id] ?: return rejected(404)
                val requestBody = body(request)
                if (requestBody["target"] != target(account.slug) || request.method != "PUT")
                    return rejected(400)
                account.enabled = requestBody.getValue("enabled").jsonPrimitive.boolean
                json(account.defaults(id))
            }
            parts.getOrNull(1) == "connector-accounts" &&
                parts.getOrNull(2) == "oauth-completions" -> {
                if (failOauthCompletion) return rejected(503)
                val id = oauthCompletion ?: return rejected(404)
                if (parts.last() != CONNECTOR_OAUTH_ATTEMPT || accounts[id]?.slug != querySlug)
                    return rejected(404)
                jsonResponse("""{"connectionId":"$id"}""")
            }
            path == "/api/connectors/gmail/oauth/start" && request.method == "POST" -> {
                val requestBody = body(request)
                if (
                    requestBody["authMethod"]?.jsonPrimitive?.contentOrNull != "oauth" ||
                        requestBody["account"]
                            ?.jsonObject
                            ?.get("intent")
                            ?.jsonPrimitive
                            ?.contentOrNull != "add"
                )
                    return rejected(400)
                jsonResponse(
                    """{"authorizationUrl":"$CONNECTOR_AUTHORIZATION_URL","oauthAttemptId":"$CONNECTOR_OAUTH_ATTEMPT"}"""
                )
            }
            path == "/api/connectors/$CONNECTOR_DEVICE_EXAMPLE/oauth/device/sessions" &&
                request.method == "POST" -> {
                if (body(request)["authMethod"]?.jsonPrimitive?.content != "device-auth")
                    return rejected(400)
                jsonResponse(
                    """{"sessionId":"$CONNECTOR_OAUTH_ATTEMPT","sessionToken":"fixture-only","connectorSlug":"$CONNECTOR_DEVICE_EXAMPLE","status":"pending","userCode":"$CONNECTOR_EXAMPLE_DEVICE_CODE","verificationUri":"$CONNECTOR_AUTHORIZATION_URL","expiresIn":900,"interval":5}"""
                )
            }
            path == "/api/connectors/$CONNECTOR_MANUAL_EXAMPLE/manual-grant" &&
                request.method == "POST" -> {
                val requestBody = body(request)
                if (
                    requestBody["authMethod"]?.jsonPrimitive?.content != "manual" ||
                        requestBody["values"]
                            ?.jsonObject
                            ?.get("workspace")
                            ?.jsonPrimitive
                            ?.contentOrNull
                            .isNullOrBlank()
                )
                    return rejected(400)
                manualRequests.incrementAndGet()
                val id = "10000000-0000-4000-8000-000000000005"
                accounts[id] =
                    FixtureAccount(
                        CONNECTOR_MANUAL_EXAMPLE,
                        "Example workspace",
                        "example@sample.test",
                        authMethod = "manual",
                    )
                if (loseManualReply) rejected(503) else jsonResponse("""{"connectionId":"$id"}""")
            }
            parts.getOrNull(1) == "connector-accounts" && parts.size >= 3 -> {
                val id = parts[2]
                val account = accounts[id] ?: return rejected(404)
                when (request.method) {
                    "GET" -> {
                        if (querySlug != account.slug) return rejected(404)
                        if (parts.last() == "deletion-impact") {
                            jsonResponse(
                                """{"connectionId":"$id","explicitSelectionCount":2,"hasSibling":true}"""
                            )
                        } else json(account.row(id))
                    }
                    "PATCH" -> {
                        val requestBody = body(request)
                        if (requestBody["target"] != target(account.slug)) return rejected(400)
                        renameRequests.incrementAndGet()
                        val name = requestBody["displayName"]?.jsonPrimitive?.contentOrNull
                        if (deferRenameCommit) {
                            pendingRename = id to name
                            return rejected(503)
                        }
                        account.name = name
                        if (loseRenameReply) rejected(503) else json(account.row(id))
                    }
                    "DELETE" -> {
                        if (body(request)["target"] != target(account.slug)) return rejected(400)
                        accounts.remove(id)
                        jsonResponse(
                            """{"deletedConnectionId":"$id","resolvedSelectionCount":2,"promotedDefaultConnectionId":null}"""
                        )
                    }
                    else -> rejected(405)
                }
            }
            else -> rejected(404)
        }
    }

    override fun close() {
        discoveryGate?.countDown()
        renameReplyGate?.countDown()
        defaultReplyGate?.countDown()
        https.use { api.close() }
    }

    private data class CatalogEntry(
        val slug: String,
        val name: String,
        val description: String,
        val category: String,
        val rank: Int?,
        val grantKind: String = "auth-code",
    ) {
        fun body(): JsonObject {
            val method = if (grantKind == "auth-code") "oauth" else grantKind
            val methodLabel = if (grantKind == "auth-code") "OAuth" else method
            val singleAuth = if (grantKind == "auth-code") "\"oauth\"" else "null"
            val fields =
                if (grantKind == "manual") {
                    listOf(
                            "Workspace",
                            "Region",
                            "Endpoint",
                            "Account ID",
                            "Access key",
                            "Label",
                            "Notes",
                        )
                        .mapIndexed { index, name ->
                            val id = name.lowercase().replace(' ', '-')
                            val type = if (name == "Access key") "password" else "text"
                            """{"id":"$id","label":"$name","required":${index == 0},"placeholder":null,"inputType":"$type"}"""
                        }
                        .joinToString(",", "[", "]")
                } else "[]"
            return Json.parseToJsonElement(
                    """{"slug":"$slug","label":"$name","description":"$description","icon":$icon,"category":"$category",${if (rank != null) """ "popularityRank":$rank,""" else ""}"generation":[],"tags":[],"authMethods":[{"id":"$method","label":"$methodLabel","description":null,"supportsRefresh":true,"grantKind":"$grantKind","manualFields":$fields,"startOptions":[]}],"singleAuthCodeAuthMethodId":$singleAuth,"permissionSummary":{"hasPermissions":true,"permissionCount":2,"hasCategories":false,"hasDefaultPolicyOverrides":false},"connectNotice":null}"""
                )
                .jsonObject
        }
    }

    private data class FixtureAccount(
        val slug: String,
        var name: String?,
        val email: String,
        var enabled: Boolean = false,
        val scopeMismatch: Boolean = false,
        val expired: Boolean = false,
        val authMethod: String = "oauth",
    ) {
        fun row(id: String) = buildJsonObject {
            put("id", id)
            put("target", target(slug))
            put("authMethod", authMethod)
            put("displayName", name)
            put("isDefault", id == CONNECTOR_CALENDAR_PRIMARY)
            put("externalId", Json.parseToJsonElement("null"))
            put("externalUsername", Json.parseToJsonElement("null"))
            put("externalEmail", email)
            put("scopeMismatch", scopeMismatch)
            put("oauthScopes", Json.parseToJsonElement("null"))
            put("reconnectReason", if (expired) "authorization_expired_or_revoked" else null)
            put("connectionStatus", if (expired) "reconnect-required" else "connected")
            put("tokenExpiresAt", Json.parseToJsonElement("null"))
            put("createdAt", "2026-11-01T00:00:00.000Z")
            put("updatedAt", "2026-11-01T00:00:00.000Z")
            put("missingRequiredFields", JsonArray(emptyList()))
            put("configuredFieldKeys", JsonArray(emptyList()))
        }

        fun defaults(id: String) = buildJsonObject {
            put("connectionId", id)
            put("displayName", name)
            put("defaultEnabled", enabled)
            put("isDefault", id == CONNECTOR_CALENDAR_PRIMARY)
        }
    }

    companion object {
        private const val icon =
            """{"url":"https://static.example/icon.svg","invertInDarkMode":false}"""

        private fun body(request: RecordedRequest) =
            Json.parseToJsonElement(request.body.readUtf8()).jsonObject

        private fun rejected(code: Int) =
            MockResponse()
                .setResponseCode(code)
                .setHeader("Content-Type", "application/json")
                .setBody(
                    """{"error":{"code":"TEST_REJECTED","message":"Fixture request rejected"}}"""
                )

        private fun json(value: kotlinx.serialization.json.JsonElement) =
            jsonResponse(value.toString())

        private fun target(slug: String) = buildJsonObject {
            put("kind", "builtin")
            put("connectorSlug", slug)
        }
    }
}
