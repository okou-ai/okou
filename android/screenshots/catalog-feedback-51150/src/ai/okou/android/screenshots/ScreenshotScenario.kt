package ai.okou.android.screenshots

import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.NativeAccount
import ai.okou.android.awaitChatList
import ai.okou.android.openChatListSettings
import ai.okou.android.settings.BuiltInToolsService
import ai.okou.android.settings.DataToolFamily
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.os.LocaleList
import androidx.lifecycle.Lifecycle
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
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val app =
        InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
            as TestOkouApplication

    @Test
    fun catalogFailureStaysInItsSectionAndRecoversOnResume() {
        val auth = app.authentication as TestAuthentication
        val previousSession = auth.state.value
        val previousAccount = auth.account.value
        val previousChat = app.chatService
        val previousRecovery = app.recoveryService
        val previousTools = app.screenshotBuiltInTools
        val previousPreferences = app.initialPreferences
        val locale = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val previousLocales = locale.applicationLocales
        val tools = CatalogFixture()
        ChatListApiFixture().use { api ->
            val user = "catalog-feedback-${UUID.randomUUID()}"
            try {
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
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    device.awaitChatList(app)
                    device.openChatListSettings(app)
                    openTools()
                    val failure = label(R.string.chat_list_first_load_failed)
                    val webSearch = label(R.string.settings_tool_web_search)
                    val searchBounds = await(webSearch).visibleBounds
                    await(failure)
                    device.waitForIdle()
                    ScreenshotCapture.capture("01-catalog-first-read-failure.png")

                    scenario.moveToState(Lifecycle.State.STARTED)
                    tools.unavailable = false
                    scenario.moveToState(Lifecycle.State.RESUMED)
                    val company = await(By.pkg(app.packageName).text("公司与联系人搜索"))
                    val keyword = await(By.pkg(app.packageName).text("关键词与排名"))
                    check(company.visibleBounds.top < keyword.visibleBounds.top)
                    check(await(webSearch).visibleBounds == searchBounds)
                    check(!device.hasObject(failure))
                    device.waitForIdle()
                    ScreenshotCapture.capture("02-catalog-recovered.png")
                }
            } finally {
                locale.applicationLocales = previousLocales
                auth.state.value = previousSession
                auth.account.value = previousAccount
                app.chatService = previousChat
                app.recoveryService = previousRecovery
                app.screenshotBuiltInTools = previousTools
                app.initialPreferences = previousPreferences
            }
        }
    }

    private fun label(id: Int) = By.pkg(app.packageName).text(app.getString(id))

    private fun await(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Expected $selector" }

    private fun openTools() {
        val target = label(R.string.settings_built_in_tools)
        if (!device.hasObject(target)) {
            val visible =
                object : Condition<UiObject2, Boolean> {
                    override fun apply(container: UiObject2) = device.hasObject(target)
                }
            val scroll = await(By.pkg(app.packageName).scrollable(true))
            if (scroll.scrollUntil(Direction.UP, visible) != true) {
                scroll.scrollUntil(Direction.DOWN, visible)
            }
        }
        generateSequence(await(target)) { it.parent }.first { it.isClickable }.click()
    }

    private class CatalogFixture : BuiltInToolsService {
        @Volatile var unavailable = true

        override suspend fun catalog(): List<DataToolFamily> {
            if (unavailable) throw ApiFailure.Http(400, null, null, null)
            return listOf(
                DataToolFamily(
                    "company-contacts",
                    mapOf("en-US" to "公司与联系人搜索", "zh-Hans" to "公司与联系人搜索"),
                ),
                DataToolFamily(
                    "keywords-rankings",
                    mapOf("en-US" to "关键词与排名", "zh-Hans" to "关键词与排名"),
                ),
                DataToolFamily(
                    "places-weather",
                    mapOf("en-US" to "地点与天气", "zh-Hans" to "地点与天气"),
                ),
            )
        }

        override suspend fun disabledTools() = setOf("keywords-rankings")
        override suspend fun setEnabled(id: String, enabled: Boolean) = enabled
        override suspend fun imageModel() = "gpt-image-2.5-flare"
        override suspend fun selectImageModel(id: String) = id
    }
}
