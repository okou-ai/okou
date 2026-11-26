package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.DefaultModelPreference
import ai.okou.android.api.generated.DefaultModelPreferenceServiceTier
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.NativeAccount
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.awaitChatList
import ai.okou.android.openChatListSettings
import ai.okou.android.settings.DefaultModelRecord
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
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val app =
        InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
            as TestOkouApplication

    @Test
    fun cachedModelRowsStayInPlaceWhenRefreshFails() {
        val auth = app.authentication as TestAuthentication
        val previousSession = auth.state.value
        val previousAccount = auth.account.value
        val previousChat = app.chatService
        val previousRecovery = app.recoveryService
        val previousPreferences = app.initialPreferences
        val locale = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val previousLocales = locale.applicationLocales
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            fixture.preference =
                JsonObject(fixture.preference + ("serviceTier" to JsonPrimitive("priority")))
            val responds = api.commandResponse
            val fail = AtomicBoolean(false)
            api.commandResponse = { request ->
                if (fail.get() && request.requestUrl?.encodedPath == "/api/model-catalog") {
                    MockResponse().setResponseCode(400).setBody("{}")
                } else responds(request)
            }
            val user = "model-catalog-feedback-${UUID.randomUUID()}"
            val identity = WorkspaceIdentity(BuildConfig.API_ORIGIN, user, "session-a", "org-a")
            try {
                app.defaultModelStore.save(
                    identity,
                    DefaultModelRecord(
                        confirmed =
                            DefaultModelPreference(
                                "gpt-test",
                                DefaultModelPreferenceServiceTier.PRIORITY,
                                emptyMap(),
                            ),
                        lastRefreshMillis = System.currentTimeMillis(),
                        confirmedLabel = "GPT 5.6 Sol",
                    ),
                )
                app.chatService = api.service
                app.recoveryService = api.service
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
                    val entry = label(R.string.settings_default_model)
                    awaitClickable(entry).click()
                    val auto = label(R.string.settings_auto_model)
                    val model = By.pkg(app.packageName).text("GPT 5.6 Sol")
                    val claude = By.pkg(app.packageName).text("Claude Sonnet 5")
                    val unavailable = label(R.string.settings_model_catalog_refresh_failed)
                    await(claude)
                    device.waitForIdle()
                    val autoBounds = await(auto).visibleBounds
                    val modelBounds = modelBelow(model, autoBounds.bottom).visibleBounds
                    val claudeBounds = await(claude).visibleBounds
                    ScreenshotCapture.capture("01-model-catalog-loaded.png")

                    scenario.moveToState(Lifecycle.State.STARTED)
                    fail.set(true)
                    scenario.moveToState(Lifecycle.State.RESUMED)
                    await(unavailable)
                    device.waitForIdle()
                    check(await(auto).visibleBounds == autoBounds)
                    check(modelBelow(model, autoBounds.bottom).visibleBounds == modelBounds)
                    check(await(claude).visibleBounds == claudeBounds)
                    check(!device.hasObject(label(R.string.chat_list_first_load_failed)))
                    ScreenshotCapture.capture("02-model-catalog-refresh-failed.png")

                    device.pressBack()
                    awaitClickable(entry)
                    check(device.wait(Until.gone(unavailable), 8_000) == true)
                    scenario.moveToState(Lifecycle.State.STARTED)
                    scenario.moveToState(Lifecycle.State.RESUMED)
                    await(unavailable)
                    device.waitForIdle()
                    ScreenshotCapture.capture("03-settings-catalog-refresh-failed.png")

                    val accounts = label(R.string.settings_model_accounts)
                    awaitClickable(accounts).click()
                    check(device.wait(Until.gone(unavailable), 5_000) == true)
                }
            } finally {
                locale.applicationLocales = previousLocales
                auth.state.value = previousSession
                auth.account.value = previousAccount
                app.chatService = previousChat
                app.recoveryService = previousRecovery
                app.initialPreferences = previousPreferences
                app.defaultModelStore.save(identity, DefaultModelRecord())
            }
        }
    }

    private fun label(id: Int) = By.pkg(app.packageName).text(app.getString(id))

    private fun await(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Expected $selector" }

    private fun modelBelow(selector: BySelector, top: Int): UiObject2 =
        device.findObjects(selector).first { it.visibleBounds.top >= top }

    private fun awaitClickable(selector: BySelector): UiObject2 =
        checkNotNull(
            device.wait(
                object : Condition<UiDevice, UiObject2?> {
                    override fun apply(device: UiDevice): UiObject2? =
                        device.findObject(selector)?.let { node ->
                            generateSequence(node) { it.parent }.firstOrNull {
                                it.isClickable && it.isEnabled
                            }
                        }
                },
                12_000,
            ),
        ) { "Expected clickable $selector" }
}
