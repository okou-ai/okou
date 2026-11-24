package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.awaitChatList
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.content.res.Configuration
import android.os.LocaleList
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun artifactSearchPagingKeepsTheProgressAtTheTypeFilters() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChats = app.chatService
        val originalSearch = app.searchService
        val originalComposer = app.composerService
        val originalWorkflows = app.workflows
        val originalPreferences = app.snapshotApiPreferences()
        val initialPreferences = app.initialPreferences
        val localized = app.createConfigurationContext(Configuration(app.resources.configuration).apply {
            setLocales(LocaleList.forLanguageTags("zh-Hans"))
        })
        val originalCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val originalSize =
            device.executeShellCommand("wm size").substringAfter("Override size: ", "").trim()
        val originalDensity =
            device.executeShellCommand("wm density").substringAfter("Override density: ", "").trim()
        val workflows = WorkflowApiFixture(chinese = true)
        val fixture = workflows.chats
        val artifacts = ArtifactApiFixture(fixture, chinese = true).apply {
            pageSize = 2
            install()
        }
        val gate = AtomicReference<PageGate?>()
        artifacts.beforeCatalog = { request ->
            val url = checkNotNull(request.requestUrl)
            if (url.queryParameter("keyword") == "发布" && url.queryParameter("cursor") == "2") {
                gate.get()?.let { page ->
                    page.started.countDown()
                    check(page.release.await(20, TimeUnit.SECONDS)) { "Capture did not release next page" }
                }
            }
        }
        auth.state.value = testAuthenticationState(user = "search-paging-${UUID.randomUUID()}")
        app.initialPreferences = testPreferences().copy(locale = UserPreferencesLocale.ZH_HANS)
        app.chatService = fixture.service
        app.searchService = fixture.service
        app.composerService = fixture.service
        app.workflows = fixture.service

        fun get(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) {
                "Missing artifact search verification control: $selector"
            }
        fun label(id: Int) = localized.getString(id)
        fun text(value: String) = get(By.pkg(app.packageName).text(value))
        fun button(id: Int) = get(By.pkg(app.packageName).desc(label(id)))
        fun field() =
            checkNotNull(device.wait(Until.findObjects(
                By.pkg(app.packageName).clazz("android.widget.EditText"),
            ), 12_000)).minBy { it.visibleBounds.left }

        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 412x892")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                for (layout in listOf("phone", "wide")) {
                    if (layout == "wide") device.executeShellCommand("wm size 1000x800")
                    device.awaitChatList(localized)
                    val currentPage = PageGate()
                    gate.set(currentPage)
                    button(R.string.chat_search_workspace).click()
                    get(By.pkg(app.packageName).clazz("android.widget.EditText").focused(true))
                    field().text = "发布"
                    val artifactType = text(label(R.string.chat_search_artifacts))
                    assertTrue(artifactType.parent.isClickable)
                    artifactType.parent.click()
                    val selectedType = get(
                        By.pkg(app.packageName).selected(true)
                            .hasChild(By.text(label(R.string.chat_search_artifacts))),
                    )
                    scenario.onActivity { activity ->
                        WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                            .hide(WindowInsetsCompat.Type.ime())
                    }
                    assertEquals("发布", field().text)
                    val search = field().visibleBounds
                    assertEquals(48, search.height())
                    assertEquals(8, selectedType.visibleBounds.top - search.bottom)
                    assertEquals(48, selectedType.visibleBounds.height())
                    if (layout == "wide") assertTrue(search.right < 480)
                    val initialRow = text(artifacts.checklist.title).visibleBounds
                    assertTrue(currentPage.started.await(10, TimeUnit.SECONDS))
                    button(R.string.chat_search_loading)
                    assertEquals(initialRow, text(artifacts.checklist.title).visibleBounds)
                    assertFalse(device.hasObject(By.pkg(app.packageName).text(artifacts.site.title)))
                    ScreenshotCapture.capture("search-artifact-paging-$layout.png")
                    currentPage.release.countDown()
                    text(artifacts.site.title)
                    assertTrue(device.wait(Until.gone(
                        By.pkg(app.packageName).desc(label(R.string.chat_search_loading)),
                    ), 12_000))
                    assertEquals(initialRow, text(artifacts.checklist.title).visibleBounds)
                    assertEquals("发布", field().text)
                    ScreenshotCapture.capture("search-artifact-settled-$layout.png")
                    button(R.string.back).click()
                    device.awaitChatList(localized)
                }
            }
        } catch (error: Throwable) {
            runCatching {
                TestStorage().openOutputFile("artifact-search-window.xml")
                    .use(device::dumpWindowHierarchy)
            }.exceptionOrNull()?.let(error::addSuppressed)
            throw error
        } finally {
            gate.get()?.release?.countDown()
            app.searchService = originalSearch
            app.chatService = originalChats
            app.composerService = originalComposer
            app.workflows = originalWorkflows
            auth.state.value = originalAuth
            app.restoreApiPreferences(originalPreferences)
            app.initialPreferences = initialPreferences
            workflows.close()
            originalCache.restore()
            device.executeShellCommand("wm size ${originalSize.ifEmpty { "reset" }}")
            device.executeShellCommand("wm density ${originalDensity.ifEmpty { "reset" }}")
        }
    }

    private class PageGate {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
    }
}
