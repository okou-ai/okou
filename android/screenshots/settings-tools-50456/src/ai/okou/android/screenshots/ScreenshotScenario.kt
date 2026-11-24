package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.awaitChatList
import ai.okou.android.settings.BuiltInToolsService
import ai.okou.android.settings.DataToolFamily
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)
    private val auth = app.authentication as TestAuthentication

    @Test
    fun capturesBuiltInTools() {
        val priorSession = auth.state.value
        val priorChat = app.chatService
        val priorTools = app.builtInToolsService
        val priorPreferences = app.snapshotApiPreferences()
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val priorLocale = localeManager.applicationLocales
        val fixture = ToolFixture()
        ChatListApiFixture().use { api ->
            try {
                val user = "tools-screenshot-${UUID.randomUUID()}"
                auth.state.value = testAuthenticationState(user = user)
                app.chatService = api.service
                app.builtInToolsService = fixture
                app.restoreApiPreferences(
                    mapOf(
                        Triple(BuildConfig.API_ORIGIN, user, "org-a") to
                            testPreferences()
                                .copy(
                                    locale = UserPreferencesLocale.ZH_HANS,
                                    theme = UserPreferencesTheme.LIGHT,
                                    timezone = "Asia/Shanghai",
                                ),
                    ),
                )
                ActivityScenario.launch(MainActivity::class.java).use {
                    device.awaitChatList(app)
                    openSettings()
                    click(text("内置工具"))
                    text("网页提取")
                    text("关键词与排名")
                    val web = reveal(By.pkg(app.packageName).text("网页搜索").checkable(true))
                    check(web.isChecked)
                    ScreenshotCapture.capture("01-directory.png")

                    click(reveal(modelRow()))
                    val sunburst =
                        reveal(By.pkg(app.packageName).textContains("GPT Image 2.5 Sunburst"))
                    check(sunburst.isEnabled)
                    ScreenshotCapture.capture("02-image-model-picker.png")
                    check(device.pressBack())

                    val imageSwitch = By.pkg(app.packageName).text("图片生成").checkable(true)
                    reveal(imageSwitch).click()
                    await(
                        By.pkg(app.packageName)
                            .text("图片生成")
                            .checked(false)
                            .checkable(true)
                            .enabled(true),
                    )
                    check(!reveal(modelRow()).isEnabled)
                    reveal(By.pkg(app.packageName).textContains("GPT Image 2.5 Flare"))
                    ScreenshotCapture.capture("03-image-generation-disabled.png")

                    reveal(imageSwitch).click()
                    await(
                        By.pkg(app.packageName)
                            .text("图片生成")
                            .checked(true)
                            .checkable(true)
                            .enabled(true),
                    )
                    click(reveal(modelRow()))
                    click(reveal(By.pkg(app.packageName).textContains("GPT Image 2.5 Sunburst")))
                    text("未能保存模型，请重新选择以重试。")
                    reveal(By.pkg(app.packageName).textContains("GPT Image 2.5 Sunburst"))
                    ScreenshotCapture.capture("04-image-model-save-failed.png")
                }
            } finally {
                auth.state.value = priorSession
                app.chatService = priorChat
                app.builtInToolsService = priorTools
                app.restoreApiPreferences(priorPreferences)
                localeManager.applicationLocales = priorLocale
            }
        }
    }

    private fun openSettings() {
        val direct =
            device.findObject(By.pkg(app.packageName).desc(app.getString(R.string.settings)))
        if (direct != null) direct.click()
        else {
            await(By.pkg(app.packageName).desc(app.getString(R.string.chat_more_actions))).click()
            click(text(app.getString(R.string.settings)))
        }
    }

    private fun click(objectInRow: UiObject2) {
        generateSequence(objectInRow) { it.parent }.first { it.isClickable }.click()
    }

    private fun modelRow() = By.pkg(app.packageName).textStartsWith("图片生成模型")

    private fun text(label: String) = reveal(By.pkg(app.packageName).text(label))

    private fun reveal(target: BySelector): UiObject2 {
        device.waitForIdle()
        if (!device.hasObject(target)) {
            val scroll = device.findObject(By.pkg(app.packageName).scrollable(true))
            val condition =
                object : Condition<UiObject2, Boolean> {
                    override fun apply(container: UiObject2) = device.hasObject(target)
                }
            if (scroll?.scrollUntil(Direction.UP, condition) != true) {
                scroll?.scrollUntil(Direction.DOWN, condition)
            }
        }
        return await(target)
    }

    private fun await(target: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(target), 10_000)) { "Expected $target" }

    private class ToolFixture : BuiltInToolsService {
        private var disabled = emptySet<String>()

        override suspend fun catalog() =
            listOf(
                    "web-extraction" to "网页提取",
                    "company-contacts" to "公司与联系人搜索",
                    "website-traffic" to "网站流量",
                    "keywords-rankings" to "关键词与排名",
                    "ad-creatives" to "广告素材搜索",
                    "creators-partners" to "创作者与合作伙伴搜索",
                    "social" to "社交媒体分析",
                    "product-research" to "商品研究",
                    "finance" to "金融数据",
                    "places-weather" to "地点与天气",
                )
                .map { (id, label) ->
                    DataToolFamily(id, mapOf("zh-Hans" to label, "en-US" to label))
                }

        override suspend fun disabledTools() = disabled

        override suspend fun setEnabled(id: String, enabled: Boolean): Boolean {
            disabled = if (enabled) disabled - id else disabled + id
            return enabled
        }

        override suspend fun imageModel() = "gpt-image-2.5-flare"

        override suspend fun selectImageModel(id: String): String =
            throw ApiFailure.Http(400, null, null, null)
    }
}
