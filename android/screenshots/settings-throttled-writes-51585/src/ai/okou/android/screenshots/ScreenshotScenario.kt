package ai.okou.android.screenshots

import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.ProactiveSettingsApiFixture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.DefaultModelPreference
import ai.okou.android.api.generated.UpdateDefaultModelPreference
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.NativeAccount
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.awaitChatList
import ai.okou.android.openChatListSettings
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.os.LocaleList
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun defaultModelKeepsItsChoiceThroughRateLimitAndThenRollsBack() {
        val modelLabel = "GPT 6.2 Sol"
        val writes = AtomicInteger()
        val readsAfterWrite = AtomicInteger()
        val retryStarted = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        settings(prepare = { api ->
            DefaultModelApiFixture(api, gptLabel = modelLabel)
            app.chatService = object : WorkspaceSession by api.service {
                override suspend fun defaultModelPreference(): DefaultModelPreference {
                    if (writes.get() > 0) readsAfterWrite.incrementAndGet()
                    return api.service.defaultModelPreference()
                }

                override suspend fun updateDefaultModelPreference(
                    update: UpdateDefaultModelPreference,
                ): DefaultModelPreference {
                    check(update.selectedModel == null)
                    if (writes.incrementAndGet() == 2) {
                        retryStarted.complete(Unit)
                        release.await()
                    }
                    throw ApiFailure.Http(429, null, null, 1)
                }
            }
        }) { context ->
            try {
                openSetting(context, R.string.settings_default_model)
                fun auto(checked: Boolean) = By.pkg(app.packageName).checkable(true)
                    .checked(checked).enabled(true)
                    .hasDescendant(label(context, R.string.settings_auto_model))
                val saving = label(context, R.string.settings_saving)
                val failure = label(context, R.string.settings_model_save_rolled_back)
                await(auto(false)).click()
                runBlocking { withTimeout(12_000) { retryStarted.await() } }
                await(auto(true))
                await(saving)
                check(!device.hasObject(failure))
                capture("01-default-model-retrying.png")

                release.complete(Unit)
                await(failure)
                await(By.pkg(app.packageName).checkable(true).checked(true)
                    .hasDescendant(By.pkg(app.packageName).text(modelLabel)))
                check(device.findObjects(failure).size == 1 && !device.hasObject(saving))
                check(writes.get() == 3 && readsAfterWrite.get() == 0)
                capture("02-default-model-rolled-back.png")
            } finally {
                release.complete(Unit)
            }
        }
    }

    @Test
    fun morningBriefKeepsItsChoiceThroughRateLimitAndThenRollsBack() {
        lateinit var fixture: ProactiveSettingsApiFixture
        val retryStarted = CountDownLatch(1)
        val release = CountDownLatch(1)
        settings(prepare = { api ->
            fixture = ProactiveSettingsApiFixture(api)
            fixture.morningWriteStatus = 429
            fixture.beforeMorningWrite = {
                if (fixture.writes.size == 2) {
                    retryStarted.countDown()
                    check(release.await(20, TimeUnit.SECONDS))
                }
            }
            app.proactivePreferencesService = api.service.proactivePreferences
        }) { context ->
            try {
                openSetting(context, R.string.settings_proactive_services)
                fun row(checked: Boolean) = By.pkg(app.packageName).checkable(true)
                    .checked(checked).hasDescendant(label(context, R.string.settings_morning_brief))
                val saving = label(context, R.string.settings_saving)
                val failure = label(context, R.string.settings_morning_brief_save_failed)
                await(row(false).enabled(true)).click()
                check(retryStarted.await(12, TimeUnit.SECONDS))
                check(await(row(true)).findObject(saving) != null)
                check(!device.hasObject(failure))
                capture("03-morning-brief-retrying.png")

                release.countDown()
                await(failure)
                await(row(false).enabled(true))
                check(device.findObjects(failure).size == 1 && !device.hasObject(saving))
                check(!fixture.morningEnabled && fixture.writes.size == 3)
                check(fixture.reads.count { it == "morning-brief" } == 1)
                capture("04-morning-brief-rolled-back.png")
            } finally {
                release.countDown()
            }
        }
    }

    private fun settings(
        prepare: (ChatListApiFixture) -> Unit,
        block: (Context) -> Unit,
    ) {
        val languageTag = "zh-Hans"
        val locale = UserPreferencesLocale.ZH_HANS
        val auth = app.authentication as TestAuthentication
        val initialSession = auth.state.value
        val initialAccount = auth.account.value
        val initialChat = app.chatService
        val initialProactive = app.proactivePreferencesService
        val initialRecovery = app.recoveryService
        val initialPreferences = app.initialPreferences
        val initialStored = app.snapshotApiPreferences()
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val initialLocales = localeManager.applicationLocales
        val locales = LocaleList.forLanguageTags(languageTag)
        val context =
            app.createConfigurationContext(Configuration(app.resources.configuration).apply { setLocales(locales) })
        ChatListApiFixture().use { api ->
            DefaultModelApiFixture(api)
            try {
                app.chatService = api.service
                app.recoveryService = api.service
                prepare(api)
                app.initialPreferences =
                    testPreferences().copy(
                        locale = locale,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Shanghai",
                    )
                val user = "settings-throttle-${UUID.randomUUID()}"
                auth.account.value = NativeAccount(user, "account@example.com")
                auth.state.value = testAuthenticationState(user = user)
                localeManager.applicationLocales = locales
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    try {
                        device.awaitChatList(context)
                        val configurationApplied = object : Condition<UiDevice, Boolean> {
                            override fun apply(unused: UiDevice): Boolean {
                                var applied = false
                                scenario.onActivity { activity ->
                                    val config = activity.resources.configuration
                                    applied = config.locales[0].language == locales[0].language
                                    if (applied) {
                                        println(
                                            "Capture device: API ${android.os.Build.VERSION.SDK_INT}, density ${config.densityDpi}, font scale ${config.fontScale}, locale ${config.locales[0].toLanguageTag()}, UI mode ${config.uiMode}",
                                        )
                                    }
                                }
                                return applied
                            }
                        }
                        check(device.wait(configurationApplied, 12_000))
                        device.openChatListSettings(context)
                        block(context)
                    } catch (failure: Throwable) {
                        try {
                            takeScreenshot().writeToTestStorage("settings-throttle-diagnostic.png")
                        } catch (diagnosis: Throwable) {
                            failure.addSuppressed(diagnosis)
                        }
                        throw failure
                    }
                }
            } finally {
                app.proactivePreferencesService = initialProactive
                app.initialPreferences = initialPreferences
                app.restoreApiPreferences(initialStored)
                app.chatService = initialChat
                app.recoveryService = initialRecovery
                auth.state.value = initialSession
                auth.account.value = initialAccount
                localeManager.applicationLocales = initialLocales
            }
        }
    }

    private fun label(context: Context, resource: Int) = By.pkg(app.packageName).text(context.getString(resource))

    private fun openSetting(context: Context, resource: Int) {
        val setting = By.pkg(app.packageName).clickable(true).checkable(false).enabled(true)
            .hasDescendant(label(context, resource))
        if (!device.hasObject(setting)) {
            val scroll = await(By.pkg(app.packageName).scrollable(true))
            val visible = object : Condition<UiObject2, Boolean> {
                override fun apply(unused: UiObject2) = device.hasObject(setting)
            }
            if (scroll.scrollUntil(Direction.DOWN, visible) != true) {
                scroll.scrollUntil(Direction.UP, visible)
            }
        }
        await(setting).click()
    }

    private fun await(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Expected $selector" }

    private fun capture(name: String) {
        device.waitForIdle()
        ScreenshotCapture.capture(name)
    }
}
