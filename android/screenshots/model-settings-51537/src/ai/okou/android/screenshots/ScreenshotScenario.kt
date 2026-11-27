package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.DefaultModelPreference
import ai.okou.android.api.generated.DefaultModelPreferenceServiceTier
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.NativeAccount
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.awaitChatList
import ai.okou.android.jsonResponse
import ai.okou.android.openChatListSettings
import ai.okou.android.settings.BuiltInToolsService
import ai.okou.android.settings.DataToolFamily
import ai.okou.android.settings.DefaultModelRecord
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.content.res.Configuration
import android.os.LocaleList
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val app =
        InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
            as TestOkouApplication
    private val modelId = "gpt-6.2-sol"
    private val modelLabel = "GPT 6.2 Sol"
    private val confirmedImageLabel = "GPT Image 2.5 Flare"
    private val attemptedImageLabel = "GPT Image 2.5 Sunburst"

    @Test
    fun defaultModelAndTheCompactPicker() = withModelFixture { _, models, identity, _ ->
        device.openChatListSettings(app)
        captureTextModels(models, identity)
    }

    @Test
    fun imageModelRollsBackAndReopensOnTheConfirmedValue() = withModelFixture { _, _, _, tools ->
        device.openChatListSettings(app)
        captureImageModels(tools)
    }

    @Test
    fun imageSaveFailureStaysInTheOpenPicker() = withModelFixture { _, _, _, tools ->
        device.openChatListSettings(app)
        openSetting(R.string.settings_built_in_tools)
        await(text(confirmedImageLabel))
        openSetting(R.string.settings_tool_image_model)
        choice(attemptedImageLabel, checked = false).click()
        waitFor("one held image preference save") { tools.attempts == 1 }
        check(device.wait(Until.gone(text(confirmedImageLabel)), 12_000) == true)

        openSetting(R.string.settings_tool_image_model)
        choice(attemptedImageLabel, checked = true)
        tools.reject.complete(Unit)
        val failure = label(R.string.settings_tool_image_save_failed)
        await(failure)
        choice(confirmedImageLabel, checked = true)
        waitFor("one image model failure in the open picker") {
            device.findObjects(failure).size == 1
        }
        capture("10-image-model-failure-open-picker.png")
    }

    @Test
    fun chatModelFailuresAppearInThePickerAndInTheConversation() =
        withModelFixture { api, _, _, _ -> captureChatModelFailure(api) }

    private fun withModelFixture(
        test: (ChatListApiFixture, DefaultModelApiFixture, WorkspaceIdentity, ImageFixture) -> Unit,
    ) {
        val auth = app.authentication as TestAuthentication
        val previousSession = auth.state.value
        val previousAccount = auth.account.value
        val previousChat = app.chatService
        val previousRecovery = app.recoveryService
        val previousTools = app.screenshotBuiltInTools
        val previousPreferences = app.initialPreferences
        val locale = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val previousLocales = locale.applicationLocales
        val user = "model-settings-${UUID.randomUUID()}"
        val identity = WorkspaceIdentity(BuildConfig.API_ORIGIN, user, "session-a", "org-a")
        val tools = ImageFixture()
        ChatListApiFixture().use { api ->
            val models = DefaultModelApiFixture(api, gptModel = modelId, gptLabel = modelLabel)
            models.preference =
                JsonObject(
                    models.preference + ("serviceTier" to JsonPrimitive("priority")),
                )
            try {
                app.defaultModelStore.save(
                    identity,
                    DefaultModelRecord(
                        confirmed =
                            DefaultModelPreference(
                                modelId,
                                DefaultModelPreferenceServiceTier.PRIORITY,
                                emptyMap(),
                            ),
                        lastRefreshMillis = System.currentTimeMillis(),
                        confirmedLabel = modelLabel,
                    ),
                )
                app.chatService = api.service
                app.recoveryService = api.service
                app.screenshotBuiltInTools = tools
                app.initialPreferences =
                    testPreferences().copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Shanghai",
                    )
                locale.applicationLocales = LocaleList.forLanguageTags("zh-Hans")
                auth.account.value = NativeAccount(user, "account@example.com")
                auth.state.value = testAuthenticationState(user = user)
                ActivityScenario.launch(MainActivity::class.java).use {
                    device.awaitChatList(app)
                    test(api, models, identity, tools)
                }
            } finally {
                tools.reject.complete(Unit)
                locale.applicationLocales = previousLocales
                auth.state.value = previousSession
                auth.account.value = previousAccount
                app.chatService = previousChat
                app.recoveryService = previousRecovery
                app.screenshotBuiltInTools = previousTools
                app.initialPreferences = previousPreferences
                app.defaultModelStore.save(identity, DefaultModelRecord())
            }
        }
    }

    private fun captureTextModels(models: DefaultModelApiFixture, identity: WorkspaceIdentity) {
        openSetting(R.string.settings_default_model)
        choice(modelLabel, checked = true)
        await(text(app.getString(R.string.settings_model_fast_usage, "2.5")))
        check(checkable(await(label(R.string.settings_model_fast))).isChecked)
        val effort = By.pkg(app.packageName).desc(app.getString(R.string.settings_model_effort))
        device.waitForIdle()
        val field = await(effort).visibleBounds
        val density = app.resources.displayMetrics.density
        check(abs(field.height() - (56 * density).roundToInt()) <= 2) { "Unexpected field $field" }
        val label = await(label(R.string.settings_model_effort)).visibleBounds
        check(abs(field.top - label.bottom - (4 * density).roundToInt()) <= 2) {
            "The field label did not have a 4 dp gap"
        }
        await(effort).click()
        await(label(R.string.settings_model_effort_high)).click()
        waitFor("a confirmed High effort with Fast still on") {
            val write = models.writes.lastOrNull() ?: return@waitFor false
            write["serviceTier"] == JsonPrimitive("priority") &&
                write["modelSettingsPatch"]?.jsonObject?.get("effort") == JsonPrimitive("high") &&
                runBlocking {
                    app.defaultModelStore.load(identity).confirmed.modelSettings[modelId]
                        ?.effort?.name == "HIGH"
                }
        }
        capture("01-default-model-fast.png")
        await(effort).click()
        choice(app.getString(R.string.settings_model_effort_high), checked = true)
        capture("02-reasoning-effort-menu.png")
        device.pressBack()

        val auto = app.getString(R.string.settings_auto_model)
        choice(auto, checked = false).click()
        choice(auto, checked = true)
        check(device.wait(Until.gone(effort), 12_000) == true)
        check(!device.hasObject(label(R.string.settings_model_fast)))
        capture("03-default-model-auto.png")
        choice(modelLabel, checked = false).click()
        choice(modelLabel, checked = true)
        device.pressBack()
        check(device.wait(Until.gone(text(auto)), 12_000) == true)

        try {
            device.setOrientationLeft()
            waitFor("a short landscape app window") {
                val config = app.resources.configuration
                config.orientation == Configuration.ORIENTATION_LANDSCAPE &&
                    config.screenHeightDp < 480
            }
            device.waitForIdle()
            openSetting(R.string.settings_default_model)
            val autoTop = choice(auto, checked = false).visibleBounds.top
            device.waitForIdle()
            val back = By.pkg(app.packageName).desc(app.getString(R.string.back)).enabled(true)
            fun backButtons() =
                device.findObjects(back).mapNotNull { node ->
                    generateSequence(node) { it.parent }.firstOrNull { it.isClickable }
                }
            val candidates = backButtons()
            val expectedSize = (48 * density).roundToInt()
            val expectedGap = (8 * density).roundToInt()
            val headerBack =
                candidates.firstOrNull {
                    val bounds = it.visibleBounds
                    abs(bounds.height() - expectedSize) <= 2 &&
                        abs(autoTop - bounds.bottom - expectedGap) <= 2
                }
            if (headerBack == null) capture("04-model-picker-short-window.png")
            checkNotNull(headerBack) {
                "Expected a 48 dp Back button in the 64 dp app bar before Auto at $autoTop. " +
                    "Clickable candidates: ${candidates.map { it.visibleBounds }}"
            }
            val before = headerBack.visibleBounds
            val body = await(By.pkg(app.packageName).scrollable(true).hasDescendant(text(auto)))
            body.scroll(Direction.DOWN, 0.8f)
            await(label(R.string.settings_model_fast))
            capture("04-model-picker-short-window.png")
            val after = backButtons().firstOrNull {
                val bounds = it.visibleBounds
                it.isEnabled && abs(bounds.left - before.left) <= 2 &&
                    abs(bounds.top - before.top) <= 2
            }
            checkNotNull(after) {
                "Model header before scrolling: $before. After: ${backButtons().map { it.visibleBounds }}"
            }.click()
        } finally {
            device.setOrientationNatural()
            device.unfreezeRotation()
            waitFor("restored portrait") {
                app.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT
            }
        }
    }

    private fun captureImageModels(tools: ImageFixture) {
        openSetting(R.string.settings_built_in_tools)
        val row = label(R.string.settings_tool_image_model)
        await(text(confirmedImageLabel))
        await(text("地点与天气"))
        device.waitForIdle()
        fun rowTop() =
            generateSequence(await(row)) { it.parent }.first { it.isClickable }
                .visibleBounds.top
        val before = rowTop()
        openSetting(R.string.settings_tool_image_model)
        choice(confirmedImageLabel, checked = true)
        choice(attemptedImageLabel, checked = false).click()
        waitFor("one held image preference save") { tools.attempts == 1 }
        await(text(attemptedImageLabel))
        await(By.pkg(app.packageName).desc(app.getString(R.string.settings_saving)))
        capture("05-image-model-saving.png")
        check(abs(rowTop() - before) <= 2) { "Image model row moved from $before to ${rowTop()}" }

        tools.reject.complete(Unit)
        await(label(R.string.settings_tool_image_save_failed))
        await(text(confirmedImageLabel))
        check(!device.hasObject(text(attemptedImageLabel)))
        capture("06-image-model-rolled-back.png")
        check(abs(rowTop() - before) <= 2) { "Image model row moved after rollback" }
        check(device.wait(Until.gone(label(R.string.settings_tool_image_save_failed)), 12_000) == true)

        openSetting(R.string.settings_tool_image_model)
        choice(confirmedImageLabel, checked = true)
        choice(attemptedImageLabel, checked = false)
        check(tools.attempts == 1)
        capture("07-image-model-confirmed-choice.png")
    }

    private fun captureChatModelFailure(api: ChatListApiFixture) {
        val releases = List(2) { CountDownLatch(1) }
        val attempts = AtomicInteger()
        val previous = api.commandResponse
        api.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == "/api/chat-threads/$CHAT_PERSONAL/model-selection") {
                val index = attempts.getAndIncrement()
                check(releases[index].await(12, TimeUnit.SECONDS))
                jsonResponse("""{"code":"BAD_REQUEST","message":"Unavailable"}""")
                    .setResponseCode(400)
            } else previous(request)
        }
        try {
            await(text("Personal chat")).click()
            val actions = By.pkg(app.packageName).desc(app.getString(R.string.chat_options_title))
            val auto = app.getString(R.string.settings_auto_model)
            val failure = label(R.string.chat_model_save_rejected)
            fun selectModel(index: Int) {
                await(actions).click()
                await(label(R.string.chat_options_model))
                openSetting(R.string.chat_options_model)
                choice(auto, checked = true)
                choice(modelLabel, checked = false).click()
                choice(modelLabel, checked = true)
                waitFor("chat model save ${index + 1}") { attempts.get() == index + 1 }
            }
            selectModel(0)
            releases[0].countDown()
            await(failure)
            choice(auto, checked = true)
            waitFor("one model picker message") { device.findObjects(failure).size == 1 }
            capture("08-chat-model-save-failure-picker.png")
            check(device.wait(Until.gone(failure), 12_000) == true)
            val options = label(R.string.chat_options_title)
            fun returnToConversation() {
                device.pressBack()
                await(options)
                device.pressBack()
                check(device.wait(Until.gone(options), 12_000) == true)
            }
            returnToConversation()
            selectModel(1)
            returnToConversation()
            releases[1].countDown()
            await(failure)
            check(!device.hasObject(text(auto)))
            waitFor("one conversation message") { device.findObjects(failure).size == 1 }
            capture("09-chat-model-save-failure-conversation.png")
        } finally {
            releases.forEach(CountDownLatch::countDown)
            api.commandResponse = previous
        }
    }

    private fun capture(file: String) {
        device.waitForIdle()
        ScreenshotCapture.capture(file)
    }

    private fun label(id: Int) = text(app.getString(id))

    private fun text(label: String) = By.pkg(app.packageName).text(label)

    private fun await(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Expected $selector" }

    private fun waitFor(description: String, ready: () -> Boolean) {
        val condition =
            object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice) = ready()
            }
        check(device.wait(condition, 12_000) == true) { "Expected $description" }
    }

    private fun openSetting(id: Int) {
        val selector = label(id)
        if (!device.hasObject(selector)) {
            val visible =
                object : Condition<UiObject2, Boolean> {
                    override fun apply(container: UiObject2) = device.hasObject(selector)
                }
            val list = await(By.pkg(app.packageName).scrollable(true))
            if (list.scrollUntil(Direction.UP, visible) != true) {
                list.scrollUntil(Direction.DOWN, visible)
            }
        }
        var target: UiObject2? = null
        waitFor("an enabled Settings row for $selector") {
            target =
                device.findObjects(selector).firstNotNullOfOrNull { node ->
                    generateSequence(node) { it.parent }.firstOrNull {
                        it.isEnabled && it.isClickable
                    }
                }
            target != null
        }
        checkNotNull(target).click()
    }

    private fun checkable(node: UiObject2): UiObject2 =
        generateSequence(node) { it.parent }.first { it.isCheckable }

    private fun choice(label: String, checked: Boolean): UiObject2 {
        var result: UiObject2? = null
        waitFor("a ${if (checked) "selected" else "selectable"} option for $label") {
            result =
                device.findObjects(text(label)).firstNotNullOfOrNull { candidate ->
                    try {
                        generateSequence(candidate) { it.parent }.firstOrNull {
                            it.isCheckable && it.isChecked == checked
                        }
                    } catch (_: StaleObjectException) {
                        // The option may be replaced while the model list recomposes.
                        null
                    }
                }
            result != null
        }
        return checkNotNull(result)
    }

    private class ImageFixture : BuiltInToolsService {
        val reject = CompletableDeferred<Unit>()
        @Volatile var attempts = 0
            private set

        override suspend fun catalog() =
            listOf(
                DataToolFamily("company-contacts", mapOf("zh-Hans" to "公司与联系人搜索")),
                DataToolFamily("keywords-rankings", mapOf("zh-Hans" to "关键词与排名")),
                DataToolFamily("places-weather", mapOf("zh-Hans" to "地点与天气")),
            )

        override suspend fun disabledTools() = emptySet<String>()

        override suspend fun setEnabled(id: String, enabled: Boolean) = enabled

        override suspend fun imageModel() = "gpt-image-2.5-flare"

        override suspend fun selectImageModel(id: String): String {
            check(id == "gpt-image-2.5-sunburst")
            attempts++
            reject.await()
            throw ApiFailure.Http(400, null, null, null)
        }
    }
}
