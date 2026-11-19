package ai.okou.android

import android.app.LocaleManager
import android.app.UiModeManager
import android.content.res.Configuration
import android.view.KeyEvent
import androidx.core.view.WindowCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

/** Actual navigation/configuration coverage on the API 35 managed phone. */
@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 35)
class NativeShellTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val automation = instrumentation.uiAutomation
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext.applicationContext as OkouApplication
    private var scenario: ActivityScenario<MainActivity>? = null

    @Test
    fun manualAppearanceRestoresWithANewActivityOwnerAndNativeBars() =
        onIsolatedDevice("appearance") {
            launch()
            var systemDark = false
            requireNotNull(scenario).onActivity { systemDark = isNight(it) }
            val manual = if (systemDark) R.string.appearance_light else R.string.appearance_dark
            click(R.string.settings)
            openAppearance()
            awaitSelectable(R.string.appearance_system)
            selectAppearance(manual)
            awaitBars(light = systemDark)
            closeActivity()
            launch()
            awaitBars(light = systemDark)
            click(R.string.settings)
            openAppearance()
            awaitSelected(manual)
            selectAppearance(R.string.appearance_system)
            awaitBars(light = !systemDark)
        }

    @Test
    fun followSystemRespondsToPlatformNightChangesAndKeepsTheDestination() =
        onIsolatedDevice("system-appearance") {
            val mode = requireNotNull(app.getSystemService(UiModeManager::class.java))
            mode.nightMode = UiModeManager.MODE_NIGHT_NO
            launch()
            awaitActivity("Android initial light configuration applies") { !isNight(it) }
            awaitBars(light = true)
            click(R.string.settings)
            openAppearance()
            awaitSelected(R.string.appearance_system)
            dismissAppearance()
            mode.nightMode = UiModeManager.MODE_NIGHT_YES
            awaitActivity("Android night configuration applies") { isNight(it) }
            text(R.string.appearance_system)
            awaitBars(light = false)
            mode.nightMode = UiModeManager.MODE_NIGHT_NO
            awaitActivity("Android light configuration applies") { !isNight(it) }
            text(R.string.appearance_system)
            awaitBars(light = true)
            assertTrue("System Back key injected", device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            device.awaitChatList(app)
        }

    @Test
    fun paletteAndLanguageChangesRecreateTheListAndReloadMemberPreferences() =
        onIsolatedDevice("member-preferences") {
            fun findCurrent(target: BySelector): UiObject2? {
                // API 35 can retain offscreen Compose descendants after a scroll without events.
                check(automation.clearCache()) { "Native accessibility cache could not be cleared" }
                return device.findObject(target)
            }
            fun reveal(target: BySelector, value: String, firstChoice: Int? = null): UiObject2 {
                if (findCurrent(target) == null) {
                    val selector = By.pkg(app.packageName).scrollable(true)
                    if (firstChoice != null) selector.hasDescendant(appearanceOption(firstChoice))
                    fun container() = requireNotNull(device.wait(Until.findObject(selector), WAIT))
                    val visible =
                        object : Condition<UiObject2, Boolean> {
                            override fun apply(container: UiObject2) = findCurrent(target) != null
                        }
                    // The sheet starts at the first choice. The overview can retain a scroll.
                    if (firstChoice != null || !container().scrollUntil(Direction.UP, visible)) {
                        container().scrollUntil(Direction.DOWN, visible)
                    }
                }
                return requireNotNull(
                    device.wait(
                        object : Condition<UiDevice, UiObject2?> {
                            override fun apply(device: UiDevice) = findCurrent(target)
                        },
                        WAIT,
                    )
                ) {
                    "Native preference control not reachable: $value"
                }
            }
            fun button(id: Int) =
                reveal(
                    By.pkg(app.packageName)
                        .clickable(true)
                        .checkable(false)
                        .enabled(true)
                        .hasDescendant(label(id)),
                    app.getString(id),
                )
            fun option(id: Int, firstChoice: Int) =
                reveal(appearanceOption(id).enabled(true), app.getString(id), firstChoice)
            fun openPicker(row: Int, firstChoice: Int) {
                button(row).click()
                await("Preference picker is open") {
                    findCurrent(appearanceOption(firstChoice)) != null
                }
            }
            fun dismissPicker(firstChoice: Int, selected: Int) {
                assertTrue(
                    "Confirmed preference selection: ${app.getString(selected)}",
                    option(selected, firstChoice).isChecked,
                )
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
                await("Preference picker is dismissed") {
                    findCurrent(appearanceOption(selected)) == null
                }
            }
            launch()
            click(R.string.settings)
            button(R.string.updates_title).click()
            text(R.string.updates_check)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            await("Update details are dismissed") {
                findCurrent(label(R.string.updates_check)) == null
            }
            openPicker(R.string.preference_color_theme, R.string.palette_default)
            option(R.string.palette_blue_horizon, R.string.palette_default).click()
            openPicker(R.string.preference_color_theme, R.string.palette_default)
            dismissPicker(R.string.palette_default, R.string.palette_blue_horizon)
            openPicker(R.string.language_en_us, R.string.language_en_us)
            option(R.string.language_zh_hant, R.string.language_en_us).click()
            awaitActivity("Traditional Chinese is applied by Android") {
                it.resources.configuration.locales[0].toLanguageTag() == "zh-Hant"
            }
            openPicker(R.string.language_zh_hant, R.string.language_en_us)
            dismissPicker(R.string.language_en_us, R.string.language_zh_hant)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            device.awaitChatList(app)
            closeActivity()
            launch()
            click(R.string.settings)
            openPicker(R.string.palette_blue_horizon, R.string.palette_default)
            dismissPicker(R.string.palette_default, R.string.palette_blue_horizon)
            await("Restored palette label is Traditional Chinese") {
                findCurrent(By.pkg(app.packageName).text("藍色地平線")) != null
            }
            openPicker(R.string.language_zh_hant, R.string.language_en_us)
            dismissPicker(R.string.language_en_us, R.string.language_zh_hant)
        }

    private fun launch() {
        check(scenario == null)
        scenario = ActivityScenario.launch(MainActivity::class.java)
        device.awaitChatList(app)
    }

    private fun closeActivity() {
        scenario?.close()
        scenario = null
    }

    private fun text(id: Int): UiObject2 =
        requireNotNull(device.wait(Until.findObject(label(id)), WAIT)) {
            "Native control not found: ${app.getString(id)}"
        }

    private fun label(id: Int): BySelector = By.pkg(app.packageName).text(app.getString(id))

    private fun click(id: Int) =
        if (id == R.string.settings)
            checkNotNull(device.wait(Until.findObject(By.desc(app.getString(id))), WAIT)).click()
        else text(id).click()

    // Compose exposes the label as a child of the native checkable option.
    private fun appearanceOption(id: Int): BySelector =
        By.pkg(app.packageName).checkable(true).hasDescendant(label(id))

    private fun appearanceRow() =
        By.pkg(app.packageName)
            .clickable(true)
            .checkable(false)
            .enabled(true)
            .hasDescendant(label(R.string.appearance))

    private fun openAppearance() {
        requireNotNull(device.wait(Until.findObject(appearanceRow()), WAIT)).click()
    }

    private fun selectAppearance(id: Int) {
        requireNotNull(device.wait(Until.findObject(appearanceOption(id).enabled(true)), WAIT))
            .click()
        await("Appearance choice is applied") {
            !device.hasObject(appearanceOption(id)) &&
                device.hasObject(appearanceRow().hasDescendant(label(id)))
        }
    }

    private fun dismissAppearance() {
        assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
        await("Appearance sheet is dismissed") {
            !device.hasObject(appearanceOption(R.string.appearance_system))
        }
    }

    private fun awaitSelectable(id: Int) =
        await("Appearance controls finish loading") {
            device.hasObject(appearanceOption(id).enabled(true))
        }

    private fun awaitSelected(id: Int) =
        await("Confirmed appearance selection: ${app.getString(id)}") {
            device.hasObject(appearanceOption(id).checked(true).enabled(true))
        }

    private fun awaitBars(light: Boolean) =
        awaitActivity("Native system bars follow the resolved app appearance") { activity ->
            val controller =
                WindowCompat.getInsetsController(activity.window, activity.window.decorView)
            controller.isAppearanceLightStatusBars == light &&
                controller.isAppearanceLightNavigationBars == light
        }

    private fun awaitActivity(description: String, check: (MainActivity) -> Boolean) =
        await(description) {
            var matches = false
            instrumentation.runOnMainSync {
                val activity =
                    ActivityLifecycleMonitorRegistry.getInstance()
                        .getActivitiesInStage(Stage.RESUMED)
                        .filterIsInstance<MainActivity>()
                        .singleOrNull()
                matches = activity?.let(check) == true
            }
            matches
        }

    private fun await(description: String, check: () -> Boolean) {
        assertTrue(
            description,
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice) = check()
                },
                WAIT,
            ) == true,
        )
    }

    private fun isNight(activity: MainActivity): Boolean =
        activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
            Configuration.UI_MODE_NIGHT_YES

    /** Capture before cleanup; preserve every primary/diagnostic/restoration failure. */
    private fun onIsolatedDevice(name: String, test: () -> Unit) {
        val apiFixture = app as TestOkouApplication
        val apiPreferences = apiFixture.snapshotApiPreferences()
        val cacheSnapshot =
            ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val locales = requireNotNull(app.getSystemService(LocaleManager::class.java))
        val applicationLocales = locales.applicationLocales
        val mode = requireNotNull(app.getSystemService(UiModeManager::class.java))
        val nightMode = mode.nightMode
        val failures = mutableListOf<Throwable>()
        try {
            automation.adoptShellPermissionIdentity("android.permission.MODIFY_DAY_NIGHT_MODE")
            apiFixture.restoreApiPreferences(emptyMap())
            test()
        } catch (failure: Throwable) {
            failures += failure
            try {
                takeScreenshot().writeToTestStorage("$name-failure")
            } catch (diagnostic: Throwable) {
                failure.addSuppressed(diagnostic)
            }
            try {
                TestStorage().openOutputFile("$name-hierarchy.xml").use {
                    device.dumpWindowHierarchy(it)
                }
            } catch (diagnostic: Throwable) {
                failure.addSuppressed(diagnostic)
            }
        } finally {
            fun restore(action: () -> Unit) {
                try {
                    action()
                } catch (failure: Throwable) {
                    failures += failure
                }
            }
            restore { closeActivity() }
            restore { cacheSnapshot.restore() }
            restore { apiFixture.restoreApiPreferences(apiPreferences) }
            restore { locales.applicationLocales = applicationLocales }
            restore { mode.nightMode = nightMode }
            restore { automation.dropShellPermissionIdentity() }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    private companion object {
        const val WAIT = 10_000L
    }
}
