package ai.okou.android

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.time.Clock
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.hours
import kotlin.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.MockResponse

internal class SettingsApiFixture(api: ChatListApiFixture) {
    @Volatile var returnedAccountIds = listOf(primaryAccount, alternateAccount, claudeAccount)
    @Volatile var activeAccount = primaryAccount
    @Volatile var activationStatus = 200
    @Volatile var activateBeforeError = false
    @Volatile var billingStatus = 200
    @Volatile var usagePackStatus = 200
    val activations = CopyOnWriteArrayList<String>()
    val accountReads = AtomicInteger()
    val billingReads = AtomicInteger()
    val usagePackReads = AtomicInteger()
    private val now = Clock.System.now()

    init {
        val previous = api.commandResponse
        api.commandResponse = { request ->
            val path = request.requestUrl?.encodedPath.orEmpty()
            when {
                path == "/api/me/3rd-party-subscriptions" -> {
                    accountReads.incrementAndGet()
                    jsonResponse("""{"subscriptions":${accounts()}}""")
                }
                path.endsWith("/activate") && request.method == "POST" -> {
                    val id = request.requestUrl!!.pathSegments[3]
                    check(request.body.readUtf8() == "{}")
                    activations += id
                    if (activationStatus == 200 || activateBeforeError) activeAccount = id
                    if (activationStatus == 200) jsonResponse(account(id).toString())
                    else failed(activationStatus)
                }
                path == "/api/billing/usage-pack-credits" -> {
                    usagePackReads.incrementAndGet()
                    if (usagePackStatus != 200) failed(usagePackStatus)
                    else
                        jsonResponse(
                            """{"totalCredits":860,"purchasedCredits":800,"bonusCredits":60,"creditGrants":[]}"""
                        )
                }
                path == "/api/billing/status" -> {
                    billingReads.incrementAndGet()
                    if (billingStatus != 200) failed(billingStatus)
                    else {
                        val previous =
                            Json.parseToJsonElement(RecoveryApiFixture.billing).jsonObject
                        val breakdown =
                            Json.parseToJsonElement(
                                """[{"category":"plan","label":"Pro plan","credits":300,"tier":"pro"},{"category":"plan","label":"Team plan","credits":1700,"tier":"team"},{"category":"payAsYouGo","label":"Top-up","credits":400}]"""
                            )
                        jsonResponse(
                            JsonObject(
                                    previous +
                                        mapOf(
                                            "credits" to JsonPrimitive(2400),
                                            "creditBreakdown" to breakdown,
                                        )
                                )
                                .toString()
                        )
                    }
                }
                else -> previous(request)
            }
        }
    }

    private fun accounts() =
        returnedAccountIds.joinToString(",", "[", "]") { account(it).toString() }

    private fun account(id: String): JsonObject {
        val claude = id == claudeAccount
        val provider = if (claude) "claude-code-oauth-token" else "codex-oauth-token"
        val framework = if (claude) "claude-code" else "codex"
        val active = if (claude) true else id == activeAccount
        val email =
            when (id) {
                primaryAccount -> "personal@example.com"
                alternateAccount -> "work@example.com"
                else -> "claude@example.com"
            }
        val shortWindow = if (id == alternateAccount) "null" else window(72, 18_000, now + 3.hours)
        val week =
            window(if (claude) 0 else if (id == primaryAccount) 42 else 84, 604_800, now + 3.days)
        val credits =
            when (id) {
                alternateAccount -> ""","subscriptionCredits":{"balance":120,"unlimited":false}"""
                primaryAccount -> ""","subscriptionCredits":null"""
                else -> ""
            }
        return Json.parseToJsonElement(
                """{"id":"$id","type":"$provider","framework":"$framework","isActive":$active,"accountEmail":"$email","planType":"pro","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","needsReconnect":false,"lastRefreshErrorCode":null,"subscriptionUsage":{"fiveHour":$shortWindow,"weekly":$week}$credits}"""
            )
            .jsonObject
    }

    private fun window(remaining: Int, seconds: Int, reset: Instant) =
        """{"usedPercent":${100 - remaining},"remainingPercent":$remaining,"windowSeconds":$seconds,"resetAt":"$reset"}"""

    private fun failed(status: Int): MockResponse =
        jsonResponse("""{"error":{"code":"UNAVAILABLE","message":"Unavailable"}}""")
            .setResponseCode(status)

    companion object {
        const val primaryAccount = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        const val alternateAccount = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        const val claudeAccount = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    }
}
