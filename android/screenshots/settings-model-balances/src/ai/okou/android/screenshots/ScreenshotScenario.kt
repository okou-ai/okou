package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.SettingsApiFixture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.OrganizationRole
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.NativeAccount
import ai.okou.android.awaitChatList
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.view.KeyEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import kotlin.math.roundToInt
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)
    private val auth = app.authentication as TestAuthentication

    @Test
    fun capturesSettingsAndVerifiesScopedBalancesAndQuotaWindows() {
        val priorSession = auth.state.value
        val priorAccount = auth.account.value
        val priorPreferences = app.snapshotApiPreferences()
        val priorChat = app.chatService
        val priorRecovery = app.recoveryService
        val priorRole = app.workspaceRole
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val priorLocale = localeManager.applicationLocales
        val priorFont = device.executeShellCommand("settings get system font_scale").trim()
        val priorSize = overrideValue("wm size")
        val priorDensity = overrideValue("wm density")
        ChatListApiFixture().use { api ->
            val fixture = SettingsApiFixture(api)
            var scenario: ActivityScenario<MainActivity>? = null
            try {
                app.chatService = api.service
                app.recoveryService = api.service
                app.workspaceRole = OrganizationRole.ADMIN
                val user = "settings-balances-capture"
                auth.state.value = testAuthenticationState(user = user)
                auth.account.value = NativeAccount(user, "account@example.com")
                app.restoreApiPreferences(
                    mapOf(
                        Triple(BuildConfig.API_ORIGIN, user, "org-a") to
                            testPreferences()
                                .copy(
                                    locale = UserPreferencesLocale.ZH_HANS,
                                    theme = UserPreferencesTheme.LIGHT,
                                    timezone = "Asia/Shanghai",
                                    cloudBrowserEnabledByDefault = true,
                                )
                    )
                )
                window("1080x2340", "420", 1f)
                scenario = ActivityScenario.launch(MainActivity::class.java)
                awaitWindow(scenario, 400..420, 1f)
                device.awaitChatList(app)
                val settings =
                    device.findObject(
                        By.pkg(app.packageName).desc(app.getString(R.string.settings))
                    )
                if (settings != null) settings.click()
                else {
                    checkNotNull(
                            device.findObject(
                                By.pkg(app.packageName)
                                    .desc(app.getString(R.string.chat_more_actions))
                            )
                        )
                        .click()
                    text(R.string.settings).click()
                }
                val modelEntry = clickable(text(R.string.settings_model_accounts))
                val gutter = (24 * app.resources.displayMetrics.density).roundToInt()
                val workspace = clickable(text("Workspace A")).visibleBounds
                check(workspace.left == gutter && workspace.right == device.displayWidth - gutter)
                check(workspace.top < modelEntry.visibleBounds.top)
                check(fixture.usagePackReads.get() == 0 && fixture.accountReads.get() == 0)
                capture("01-settings.png")

                modelEntry.click()
                text(app.getString(R.string.settings_provider_credit_balance, "ChatGPT", "120"))
                text("84%")
                text("0%")
                check(
                    device
                        .findObjects(
                            By.pkg(app.packageName)
                                .text(app.getString(R.string.settings_hour_quota, 5))
                        )
                        .size == 2
                )
                check(fixture.usagePackReads.get() == 0)
                capture("02-model-accounts.png")
                clickable(text("work@example.com")).click()
                val selected = app.getString(R.string.settings_account_current)
                check(
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice): Boolean {
                                val account =
                                    device.findObject(
                                        By.pkg(app.packageName).text("work@example.com")
                                    ) ?: return false
                                val row = clickable(account)
                                return row.text?.contains(selected) == true ||
                                    row.findObject(By.text(selected)) != null
                            }
                        },
                        WAIT,
                    ) == true
                )
                check(fixture.activations.toList() == listOf(SettingsApiFixture.alternateAccount))

                backToOverview()
                clickable(text(R.string.settings_credit_balance)).click()
                text(R.string.settings_credit_member)
                text(R.string.settings_credit_workspace)
                text("860")
                text("2,400")
                capture("03-credit-balance.png")

                backToOverview()
                clickable(text(R.string.settings_account_security)).click()
                text("account@example.com")
                text(R.string.settings_account_web)
                capture("04-account-security.png")
                clickable(text(R.string.auth_sign_out)).click()
                text(R.string.settings_sign_out_title)
                capture("07-sign-out.png")
                device.pressKeyCode(KeyEvent.KEYCODE_BACK)
                text(R.string.settings_account_security)

                backToOverview()
                clickable(text(R.string.settings_model_accounts)).click()
                text("84%")
                window("1400x1000", "160", 1f)
                awaitWindow(scenario, 1000..1500, 1f)
                text("84%")
                capture("05-wide-model-accounts.png")
                window("1080x2340", "420", 2f)
                awaitWindow(scenario, 400..420, 2f)
                text("72%")
                capture("06-large-type-model-accounts.png")
            } catch (failure: Throwable) {
                runCatching {
                        ScreenshotCapture.capture("settings-balances-failure.png")
                        TestStorage().openOutputFile("settings-balances-hierarchy.xml").use {
                            device.dumpWindowHierarchy(it)
                        }
                    }
                    .exceptionOrNull()
                    ?.let(failure::addSuppressed)
                throw failure
            } finally {
                scenario?.close()
                app.chatService = priorChat
                app.recoveryService = priorRecovery
                app.workspaceRole = priorRole
                app.restoreApiPreferences(priorPreferences)
                auth.account.value = priorAccount
                auth.state.value = priorSession
                localeManager.applicationLocales = priorLocale
                device.executeShellCommand("wm size ${priorSize ?: "reset"}")
                device.executeShellCommand("wm density ${priorDensity ?: "reset"}")
                if (priorFont.toFloatOrNull() == null)
                    device.executeShellCommand("settings delete system font_scale")
                else device.executeShellCommand("settings put system font_scale $priorFont")
            }
        }
    }

    private fun clickable(node: UiObject2) =
        generateSequence(node) { it.parent }.first { it.isClickable }

    private fun backToOverview() {
        device.pressKeyCode(KeyEvent.KEYCODE_BACK)
        text("Workspace A")
    }

    private fun text(resource: Int) = text(app.getString(resource))

    private fun text(label: String): UiObject2 {
        val target = By.pkg(app.packageName).text(label)
        device.waitForIdle()
        if (!device.hasObject(target)) {
            val condition =
                object : Condition<UiObject2, Boolean> {
                    override fun apply(container: UiObject2) = device.hasObject(target)
                }
            val scroll = device.findObject(By.pkg(app.packageName).scrollable(true))
            if (scroll?.scrollUntil(Direction.UP, condition) != true) {
                scroll?.scrollUntil(Direction.DOWN, condition)
            }
        }
        return checkNotNull(device.wait(Until.findObject(target), WAIT)) {
            "Expected visible text $label"
        }
    }

    private fun capture(name: String) {
        device.waitForIdle()
        ScreenshotCapture.capture(name)
    }

    private fun overrideValue(command: String) =
        device
            .executeShellCommand(command)
            .lineSequence()
            .firstOrNull { it.startsWith("Override ") }
            ?.substringAfter(": ")

    private fun window(size: String, dpi: String, font: Float) {
        device.executeShellCommand("wm size $size")
        device.executeShellCommand("wm density $dpi")
        device.executeShellCommand("settings put system font_scale $font")
    }

    private fun awaitWindow(
        scenario: ActivityScenario<MainActivity>,
        width: IntRange,
        font: Float,
    ) {
        check(
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice): Boolean {
                        var ready = false
                        scenario.onActivity {
                            val config = it.resources.configuration
                            ready =
                                config.screenWidthDp in width &&
                                    config.fontScale == font &&
                                    config.locales[0].toLanguageTag().startsWith("zh")
                        }
                        return ready
                    }
                },
                WAIT,
            ) == true
        )
    }

    private companion object {
        const val WAIT = 12_000L
    }
}
