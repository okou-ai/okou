package ai.okou.android.screenshots

import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.ProactiveSettingsApiFixture
import ai.okou.android.SettingsApiFixture
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
import kotlin.math.roundToInt
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
    fun proactiveChecksAndThenRollsBackWithOneSnackbar() {
        lateinit var fixture: ProactiveSettingsApiFixture
        val reads = AtomicInteger()
        val verificationStarted = CountDownLatch(1)
        val release = CountDownLatch(1)
        settings(prepare = { api ->
            fixture = ProactiveSettingsApiFixture(api)
            fixture.morningWriteStatus = 503
            fixture.beforeMorningRead = {
                if (fixture.writes.isNotEmpty() && reads.incrementAndGet() == 1) {
                    verificationStarted.countDown()
                    check(release.await(15, TimeUnit.SECONDS))
                }
            }
            app.proactivePreferencesService = api.service.proactivePreferences
        }) { context ->
            try {
                openSetting(context, R.string.settings_proactive_services)
                fun row(checked: Boolean) = By.pkg(app.packageName).checkable(true)
                    .checked(checked).hasDescendant(label(context, R.string.settings_morning_brief))
                val checking = label(context, R.string.settings_save_checking)
                val failure = label(context, R.string.settings_morning_brief_save_failed)
                await(row(false).enabled(true)).click()
                check(verificationStarted.await(12, TimeUnit.SECONDS))
                check(await(row(true)).findObject(checking) != null)
                check(device.findObjects(checking).size == 1 && !device.hasObject(failure))
                capture("05-proactive-checking.png")

                release.countDown()
                await(failure)
                await(row(false).enabled(true))
                check(device.findObjects(failure).size == 1 && !device.hasObject(checking))
                check(!fixture.morningEnabled && fixture.writes.size == 1 && reads.get() == 3)
                capture("06-proactive-rolled-back.png")
            } finally {
                release.countDown()
            }
        }
    }

    @Test
    fun defaultModelChecksAndRollsBackToTheConfirmedModel() {
        lateinit var fixture: DefaultModelApiFixture
        val testGptLabel = "GPT 6.2 Sol"
        val attempted = AtomicInteger()
        val verifications = AtomicInteger()
        val verificationStarted = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        settings(prepare = { api ->
            fixture = DefaultModelApiFixture(api, gptLabel = testGptLabel)
            app.chatService = object : WorkspaceSession by api.service {
                override suspend fun defaultModelPreference(): DefaultModelPreference {
                    if (attempted.get() > 0 && verifications.incrementAndGet() == 1) {
                        verificationStarted.complete(Unit)
                        release.await()
                    }
                    return api.service.defaultModelPreference()
                }

                override suspend fun updateDefaultModelPreference(
                    update: UpdateDefaultModelPreference,
                ): DefaultModelPreference {
                    attempted.incrementAndGet()
                    check(update.selectedModel == null)
                    throw ApiFailure.Http(503, null, null, null)
                }
            }
        }) { context ->
            try {
                openSetting(context, R.string.settings_default_model)
                fun auto(checked: Boolean) = By.pkg(app.packageName).checkable(true)
                    .checked(checked).enabled(true)
                    .hasDescendant(label(context, R.string.settings_auto_model))
                val checking = label(context, R.string.settings_save_checking)
                val failure = label(context, R.string.settings_model_save_rolled_back)
                await(auto(false)).click()
                runBlocking { withTimeout(12_000) { verificationStarted.await() } }
                await(auto(true))
                await(checking)
                check(!device.hasObject(failure))
                capture("07-default-model-checking.png")

                release.complete(Unit)
                await(failure)
                await(By.pkg(app.packageName).checkable(true).checked(true)
                    .hasDescendant(By.pkg(app.packageName).text(testGptLabel)))
                check(device.findObjects(failure).size == 1 && !device.hasObject(checking))
                check(attempted.get() == 1 && fixture.writes.isEmpty() && verifications.get() == 3)
                capture("08-default-model-rolled-back.png")
            } finally {
                release.complete(Unit)
            }
        }
    }

    @Test
    fun emailKeepsTheRowDuringReadbackAndAdoptsALateValueAfterRollback() {
        lateinit var fixture: SettingsApiFixture
        val retryStarted = CompletableDeferred<Unit>()
        val releaseRetry = CompletableDeferred<Unit>()
        val reads = AtomicInteger()
        try {
            settings(prepare = { api ->
                fixture = SettingsApiFixture(api)
                fixture.emailWriteStatus = 503
                app.chatService = object : WorkspaceSession by api.service {
                    override suspend fun emailSubscription(): ai.okou.android.api.generated.EmailSubscription {
                        if (reads.incrementAndGet() == 3) {
                            retryStarted.complete(Unit)
                            releaseRetry.await()
                        }
                        return api.service.emailSubscription()
                    }
                }
            }) { context ->
                openSetting(context, R.string.settings_email_updates)
                val off = await(emailSwitch(context, checked = false, enabled = true))
                val bounds = off.visibleBounds
                val density = context.resources.displayMetrics.density
                check(bounds.height() == (72 * density).roundToInt()) { "Default row bounds: $bounds" }
                println("Default switch row: $bounds at density $density")
                capture("01-confirmed-off.png")

                off.click()
                runBlocking { withTimeout(12_000) { retryStarted.await() } }
                check(await(emailSwitch(context, checked = true, enabled = false)).visibleBounds == bounds)
                check(device.hasObject(label(context, R.string.settings_email_saving)))
                check(!device.hasObject(label(context, R.string.settings_email_save_failed)))
                check(!fixture.emailSubscribed && fixture.emailWrites == listOf(true))
                capture("02-stale-readback.png")

                releaseRetry.complete(Unit)
                await(label(context, R.string.settings_email_save_failed))
                check(await(emailSwitch(context, checked = false, enabled = true)).visibleBounds == bounds)
                check(device.findObjects(label(context, R.string.settings_email_save_failed)).size == 1)
                check(!device.hasObject(label(context, R.string.settings_email_saving)))
                check(!fixture.emailSubscribed && fixture.emailWrites == listOf(true))
                capture("03-rolled-back.png")

                check(device.pressBack())
                check(device.wait(Until.gone(label(context, R.string.settings_email_scope)), 12_000))
                fixture.emailSubscribed = true
                openSetting(context, R.string.settings_email_updates)
                check(await(emailSwitch(context, checked = true, enabled = true)).visibleBounds == bounds)
                check(fixture.emailWrites == listOf(true))
                check(!device.hasObject(label(context, R.string.settings_email_save_failed)))
                capture("04-confirmed-on.png")
            }
        } finally {
            releaseRetry.complete(Unit)
        }
    }

    private fun emailSwitch(context: Context, checked: Boolean, enabled: Boolean) =
        By.pkg(app.packageName).checkable(true).checked(checked).enabled(enabled)
            .hasDescendant(label(context, R.string.settings_email_receive))

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
                val user = "settings-readback-${UUID.randomUUID()}"
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
                            takeScreenshot().writeToTestStorage("settings-readback-diagnostic.png")
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
