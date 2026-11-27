package ai.okou.android.screenshots

import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.SettingsApiFixture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.EmailSubscriptionUpdate
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
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.roundToInt
import kotlinx.coroutines.CompletableDeferred
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun defaultSwitchConfirmsInPlace() {
        panel("zh-Hans", UserPreferencesLocale.ZH_HANS, fontScale = 1f) { context, fixture ->
            val off = await(toggle(context, checked = false, enabled = true))
            val bounds = off.visibleBounds
            val density = context.resources.displayMetrics.density
            check(bounds.height() == (72 * density).roundToInt()) { "Default row bounds: $bounds" }
            println("Default switch row: $bounds at density $density")
            capture("01-email-off.png")
            off.click()
            val on = await(toggle(context, checked = true, enabled = true))
            check(on.visibleBounds == bounds)
            check(fixture.emailWrites == listOf(true) && fixture.emailSubscribed)
            capture("02-email-on.png")
        }
    }

    @Test
    fun largeTextKeepsLoadingAndWriteStatesInPlace() {
        val read = CompletableDeferred<Unit>()
        val firstWrite = CompletableDeferred<Unit>()
        val secondWrite = CompletableDeferred<Unit>()
        panel(
            "de-DE",
            UserPreferencesLocale.DE_DE,
            fontScale = 2f,
            read = read,
            writes = listOf(firstWrite, secondWrite),
        ) { context, fixture ->
            fixture.emailWriteStatus = 400
            val scope = label(context, R.string.settings_email_scope)
            val skeleton = By.pkg(app.packageName).desc(context.getString(R.string.settings_email_refreshing))
            val failure = label(context, R.string.settings_email_save_failed)
            val saving = label(context, R.string.settings_email_saving)
            val idleSwitch = toggle(context, checked = false, enabled = true)
            val savingSwitch = toggle(context, checked = true, enabled = false)
            val loadingBounds = await(skeleton).visibleBounds
            val scopeBounds = await(scope).visibleBounds
            check(!device.hasObject(idleSwitch))
            capture("03-email-large-loading.png")

            read.complete(Unit)
            val ready = await(idleSwitch)
            val bounds = ready.visibleBounds
            check(loadingBounds == bounds) { "Loading $loadingBounds, confirmed $bounds" }
            check(await(scope).visibleBounds == scopeBounds)
            check(device.wait(Until.gone(skeleton), 12_000))
            println("Large text switch row: $bounds")
            capture("04-email-large-ready.png")

            ready.click()
            await(saving)
            check(await(savingSwitch).visibleBounds == bounds)
            check(await(scope).visibleBounds == scopeBounds)
            capture("05-email-large-saving.png")
            firstWrite.complete(Unit)

            await(failure)
            check(await(idleSwitch).visibleBounds == bounds)
            check(await(scope).visibleBounds == scopeBounds)
            check(!fixture.emailSubscribed && fixture.emailWrites == listOf(true))
            capture("06-email-large-rejected.png")

            await(idleSwitch).click()
            await(savingSwitch)
            check(device.pressBack())
            check(device.wait(Until.gone(scope), 12_000))
            secondWrite.complete(Unit)
            await(failure)
            check(!device.hasObject(scope) && fixture.emailWrites == listOf(true, true))
            capture("07-email-settings-snackbar.png")
        }
    }

    private fun panel(
        languageTag: String,
        locale: UserPreferencesLocale,
        fontScale: Float,
        read: CompletableDeferred<Unit>? = null,
        writes: List<CompletableDeferred<Unit>> = emptyList(),
        block: (Context, SettingsApiFixture) -> Unit,
    ) {
        val auth = app.authentication as TestAuthentication
        val initialSession = auth.state.value
        val initialAccount = auth.account.value
        val initialChat = app.chatService
        val initialRecovery = app.recoveryService
        val initialPreferences = app.initialPreferences
        val initialStored = app.snapshotApiPreferences()
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val initialLocales = localeManager.applicationLocales
        val initialScale = device.executeShellCommand("settings get system font_scale").trim()
        val initialSize = override("wm size", Regex("[0-9]+x[0-9]+"))
        val initialDensity = override("wm density", Regex("[0-9]+"))
        val locales = LocaleList.forLanguageTags(languageTag)
        val context =
            app.createConfigurationContext(Configuration(app.resources.configuration).apply { setLocales(locales) })
        ChatListApiFixture().use { api ->
            val fixture = SettingsApiFixture(api)
            DefaultModelApiFixture(api)
            val writeAttempts = AtomicInteger()
            try {
                app.chatService =
                    object : WorkspaceSession by api.service {
                        override suspend fun emailSubscription() =
                            if (read == null) api.service.emailSubscription()
                            else {
                                read.await()
                                api.service.emailSubscription().copy(email = "qa@x.test")
                            }

                        override suspend fun updateEmailSubscription(
                            subscribed: Boolean,
                        ): EmailSubscriptionUpdate {
                            writes.getOrNull(writeAttempts.getAndIncrement())?.await()
                            return api.service.updateEmailSubscription(subscribed)
                        }
                    }
                app.recoveryService = api.service
                app.initialPreferences =
                    testPreferences().copy(
                        locale = locale,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Shanghai",
                    )
                val user = "email-layout-${UUID.randomUUID()}"
                auth.account.value = NativeAccount(user, "account@example.com")
                auth.state.value = testAuthenticationState(user = user)
                if (fontScale == 2f) {
                    device.executeShellCommand("wm size 800x1950")
                    device.executeShellCommand("wm density 400")
                }
                device.executeShellCommand("settings put system font_scale $fontScale")
                localeManager.applicationLocales = locales
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    try {
                        device.awaitChatList(context)
                        val configurationApplied = object : Condition<UiDevice, Boolean> {
                            override fun apply(unused: UiDevice): Boolean {
                                var applied = false
                                scenario.onActivity { activity ->
                                    val config = activity.resources.configuration
                                    applied =
                                        config.fontScale == fontScale &&
                                            config.locales[0].language == locales[0].language &&
                                            (fontScale == 1f || config.screenWidthDp == 320)
                                }
                                return applied
                            }
                        }
                        check(device.wait(configurationApplied, 12_000))
                        device.openChatListSettings(context)
                        openEmail(context)
                        block(context, fixture)
                    } catch (failure: Throwable) {
                        try {
                            takeScreenshot().writeToTestStorage("email-layout-diagnostic.png")
                        } catch (diagnosis: Throwable) {
                            failure.addSuppressed(diagnosis)
                        }
                        throw failure
                    }
                }
            } finally {
                read?.complete(Unit)
                writes.forEach { it.complete(Unit) }
                app.initialPreferences = initialPreferences
                app.restoreApiPreferences(initialStored)
                app.chatService = initialChat
                app.recoveryService = initialRecovery
                auth.state.value = initialSession
                auth.account.value = initialAccount
                localeManager.applicationLocales = initialLocales
                device.executeShellCommand("wm size ${initialSize ?: "reset"}")
                device.executeShellCommand("wm density ${initialDensity ?: "reset"}")
                if (initialScale.toFloatOrNull() == null) {
                    device.executeShellCommand("settings delete system font_scale")
                } else {
                    device.executeShellCommand("settings put system font_scale $initialScale")
                }
            }
        }
    }

    private fun label(context: Context, resource: Int) = By.pkg(app.packageName).text(context.getString(resource))

    private fun toggle(context: Context, checked: Boolean, enabled: Boolean) =
        By.pkg(app.packageName).checkable(true).checked(checked).enabled(enabled)
            .hasDescendant(label(context, R.string.settings_email_receive))

    private fun openEmail(context: Context) {
        val setting = By.pkg(app.packageName).clickable(true).checkable(false).enabled(true)
            .hasDescendant(label(context, R.string.settings_email_updates))
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

    private fun override(command: String, format: Regex) =
        device.executeShellCommand(command).lineSequence()
            .firstOrNull { it.startsWith("Override") }?.substringAfter(": ")?.takeIf(format::matches)

    private fun await(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Expected $selector" }

    private fun capture(name: String) {
        device.waitForIdle()
        ScreenshotCapture.capture(name)
    }
}
