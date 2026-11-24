package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.NativeAccount
import ai.okou.android.awaitChatList
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
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.coroutines.CompletableDeferred
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)
    private val auth = app.authentication as TestAuthentication

    @Test
    fun accountSignOutConfirmationWaitAndFailure() {
        val previousSession = auth.state.value
        val previousAccount = auth.account.value
        val previousAction = auth.signOutAction
        val previousChat = app.chatService
        val previousRecovery = app.recoveryService
        val previousPrefs = app.snapshotApiPreferences()
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val previousLocale = localeManager.applicationLocales
        val previousSize =
            Regex("Override size: (\\d+x\\d+)")
                .find(device.executeShellCommand("wm size"))
                ?.groupValues
                ?.get(1) ?: "reset"
        val reject = CompletableDeferred<Unit>()
        val user = "sign-out-screenshot-${UUID.randomUUID()}"
        val email = "account@example.com"
        ChatListApiFixture().use { api ->
            try {
                DefaultModelApiFixture(api).selectAutoElsewhere()
                auth.account.value = NativeAccount(user, email)
                auth.state.value = testAuthenticationState(user = user)
                auth.signOutAction = {
                    reject.await()
                    error("Fixture rejected sign-out")
                }
                app.chatService = api.service
                app.recoveryService = api.service
                val preferences =
                    testPreferences()
                        .copy(
                            locale = UserPreferencesLocale.ZH_HANS,
                            theme = UserPreferencesTheme.LIGHT,
                            timezone = "Asia/Shanghai",
                        )
                app.restoreApiPreferences(
                    mapOf(Triple(BuildConfig.API_ORIGIN, user, "org-a") to preferences),
                )
                device.executeShellCommand("wm size 1080x2340")
                ActivityScenario.launch(MainActivity::class.java).use {
                    device.awaitChatList(app)
                    openSettings()
                    click(reveal("账号与安全"))
                    text(email)
                    text("在 Web 管理账号")
                    val signOut = text("退出登录")
                    ScreenshotCapture.capture("01-account.png")
                    click(signOut)
                    text("退出登录？")
                    text("再次使用 Okou 时需要登录。草稿保留在原账号下。")
                    ScreenshotCapture.capture("02-sign-out-confirmation.png")

                    val cancelCenterY = text("取消").visibleCenter.y
                    val confirm =
                        device.findObjects(label("退出登录")).minBy { button ->
                            abs(button.visibleCenter.y - cancelCenterY)
                        }
                    click(confirm)
                    val waiting = text("正在退出登录")
                    check(!device.hasObject(label(email)))
                    awaitProgress(waiting)
                    ScreenshotCapture.capture("03-signing-out.png")

                    reject.complete(Unit)
                    text("暂时无法退出登录。")
                    text("账号与安全")
                    text(email)
                    check(!device.hasObject(label("退出登录？")))
                    ScreenshotCapture.capture("04-sign-out-failed.png")
                }
            } finally {
                reject.complete(Unit)
                auth.state.value = previousSession
                auth.account.value = previousAccount
                auth.signOutAction = previousAction
                app.chatService = previousChat
                app.recoveryService = previousRecovery
                app.restoreApiPreferences(previousPrefs)
                localeManager.applicationLocales = previousLocale
                device.executeShellCommand("wm size $previousSize")
            }
        }
    }

    private fun openSettings() {
        val settings = "设置"
        val direct = device.findObject(By.pkg(app.packageName).desc(settings))
        if (direct != null) return direct.click()
        await(By.pkg(app.packageName).desc(app.getString(R.string.chat_more_actions))).click()
        click(text(settings))
    }

    private fun reveal(value: String): UiObject2 {
        val target = label(value)
        val scrollable = By.pkg(app.packageName).scrollable(true)
        check(
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice) =
                        device.hasObject(target) || device.hasObject(scrollable)
                },
                10_000,
            ),
        )
        if (!device.hasObject(target)) {
            val visible =
                object : Condition<UiObject2, Boolean> {
                    override fun apply(container: UiObject2) = device.hasObject(target)
                }
            device.findObject(scrollable)?.scrollUntil(Direction.DOWN, visible)
        }
        return await(target)
    }

    private fun awaitProgress(title: UiObject2) {
        val bounds = title.visibleBounds
        val density = app.resources.displayMetrics.density
        val diameter = (20 * density).roundToInt()
        val left = bounds.right + (12 * density).roundToInt()
        val top = bounds.centerY() - diameter / 2
        // The title announces waiting. The decorative progress indicator has no accessibility node.
        val indicatorVisible =
            object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice): Boolean {
                    val bitmap = instrumentation.uiAutomation.takeScreenshot() ?: return false
                    try {
                        val background = bitmap.getPixel(left - 1, top)
                        return (top until top + diameter).any { y ->
                            (left until left + diameter).any { x ->
                                bitmap.getPixel(x, y) != background
                            }
                        }
                    } finally {
                        bitmap.recycle()
                    }
                }
            }
        check(device.wait(indicatorVisible, 5_000)) { "The delayed progress indicator is missing" }
    }

    private fun label(value: String) = By.pkg(app.packageName).text(value)

    private fun text(value: String) = await(label(value))

    private fun await(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 10_000)) { "Missing $selector" }

    private fun click(view: UiObject2) {
        generateSequence(view) { it.parent }.first { it.isClickable }.click()
    }
}
