package ai.okou.android

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

internal class DefaultModelApiFixture(
    api: ChatListApiFixture,
    private val piUltra: Boolean = false,
) {
    val writes = CopyOnWriteArrayList<JsonObject>()
    @Volatile var codexExecution = false
    @Volatile var gptSortOrder = 1
    @Volatile var gptFastAvailable = true
    @Volatile var gptFastMultiplier = 2.5
    @Volatile var planRestricted = false
    @Volatile var onlyAuto = false
    @Volatile var beforeCatalogReturn: (() -> Unit)? = null
    @Volatile
    var preference =
        Json.parseToJsonElement(
                """{"selectedModel":"gpt-test","serviceTier":null,"modelSettings":{"claude-test":{"effort":"high"}},"selectedImageModel":null,"updatedAt":null}""",
            )
            .jsonObject

    init {
        val previous = api.commandResponse
        api.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/model-catalog" -> {
                    beforeCatalogReturn?.invoke()
                    jsonResponse(catalog)
                }
                "/api/run-models" -> jsonResponse(models)
                "/api/feature-switches" ->
                    jsonResponse(
                        """{"switches":{},"effectiveSwitches":{"_codexExecution":$codexExecution}}""",
                    )
                "/api/user-model-preference" -> {
                    if (request.method == "PUT") {
                        val update =
                            Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                        writes += update
                        val selectedModel =
                            update.getValue("selectedModel").takeUnless { it == JsonNull }
                                ?: JsonPrimitive("auto")
                        val patch = update["modelSettingsPatch"]?.jsonObject
                        val settings = preference.getValue("modelSettings").jsonObject
                        preference =
                            JsonObject(
                                preference +
                                    mapOf(
                                        "selectedModel" to selectedModel,
                                        "serviceTier" to update.getValue("serviceTier"),
                                        "modelSettings" to
                                            if (patch == null) settings
                                            else
                                                JsonObject(
                                                    settings +
                                                        ((patch.getValue("model") as JsonPrimitive)
                                                            .content to
                                                            JsonObject(
                                                                mapOf(
                                                                    "effort" to
                                                                        patch.getValue("effort"),
                                                                ),
                                                            )),
                                                ),
                                    ),
                            )
                    }
                    jsonResponse(preference.toString())
                }
                else -> previous(request)
            }
        }
    }

    fun selectAutoElsewhere() {
        preference =
            JsonObject(
                preference +
                    mapOf("selectedModel" to JsonPrimitive("auto"), "serviceTier" to JsonNull),
            )
    }

    private val gptEfforts =
        if (piUltra) """["medium","high","ultra"]""" else """["medium","high"]"""

    private val catalog
        get() =
            """{"models":[{"model":"gpt-test","displayName":"GPT 5.6 Sol","sortOrder":$gptSortOrder,"replacedBy":null,"resolvedModel":"gpt-test","builtInOnRestrictedPlans":false,"piRouteClass":null,"runOptions":{"fast":{"chatGptUsageMultiplier":$gptFastMultiplier}}},{"model":"claude-test","displayName":"Claude Sonnet 5","sortOrder":2,"replacedBy":null,"resolvedModel":"claude-test","builtInOnRestrictedPlans":false,"piRouteClass":null}],"routes":[{"model":"gpt-test","providerType":"codex-oauth-token","concreteProviderType":"codex-oauth-token","subscriptionType":"codex-oauth-token","upstreamModel":"gpt-test","enabled":true,"priority":1,"serviceTiers":["priority"],"defaultServiceTier":null,"efforts":$gptEfforts,"defaultEffort":"medium","piRuntimeCapable":$piUltra},{"model":"claude-test","providerType":"claude-code-oauth-token","concreteProviderType":"claude-code-oauth-token","subscriptionType":"claude-code-oauth-token","upstreamModel":"claude-test","enabled":true,"priority":1,"serviceTiers":[],"defaultServiceTier":null,"efforts":["medium","high"],"defaultEffort":"medium"}],"systemDefaultModel":"gpt-test"}"""

    private val models
        get(): String {
            if (onlyAuto) return """{"models":[]}"""
            val availability = if (planRestricted) "plan_restricted" else "available"
            val gptServiceTier = if (gptFastAvailable) "\"priority\"" else "null"
            return """{"models":[{"model":"gpt-test","modelLabel":"GPT 5.6 Sol","modelProviderId":null,"subscriptionOptions":{"efforts":$gptEfforts,"serviceTier":$gptServiceTier},"memberEffective":{"providerType":"codex-oauth-token","runtimeProviderType":"codex-oauth-token","credentialScope":"member","availability":"$availability","accountSelection":"capture_required"}},{"model":"claude-test","modelLabel":"Claude Sonnet 5","modelProviderId":null,"subscriptionOptions":{"efforts":["medium","high"],"serviceTier":null},"memberEffective":{"providerType":"claude-code-oauth-token","runtimeProviderType":"claude-code-oauth-token","credentialScope":"member","availability":"$availability","accountSelection":"capture_required"}}]}"""
        }
}
