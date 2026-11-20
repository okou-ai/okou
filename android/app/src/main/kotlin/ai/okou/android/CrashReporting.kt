package ai.okou.android

import android.app.Application
import io.sentry.android.core.SentryAndroid

internal object CrashReporting {
    fun start(application: Application) {
        if (BuildConfig.SENTRY_DSN.isEmpty()) return

        SentryAndroid.init(application) { options ->
            options.dsn = BuildConfig.SENTRY_DSN
            options.release = "okou-android@${BuildConfig.VERSION_NAME}"
            options.dist = BuildConfig.VERSION_CODE.toString()
            options.environment = "production"
            options.dataCollection.setUserInfo(false)
            options.isEnableAutoSessionTracking = false
            options.isEnableActivityLifecycleBreadcrumbs = false
            options.isEnableAppLifecycleBreadcrumbs = false
            options.isEnableAppComponentBreadcrumbs = false
            options.isEnableSystemEventBreadcrumbs = false
            options.isEnableNetworkEventBreadcrumbs = false
            options.isEnableAutoActivityLifecycleTracing = false
            options.isTombstoneEnabled = false
            options.isAttachScreenshot = false
            options.isAttachViewHierarchy = false
            options.isAttachAnrThreadDump = false
            options.isCollectAdditionalContext = false
            options.tracesSampleRate = 0.0
            options.beforeBreadcrumb = { _, _ -> null }
            options.beforeSend = { event, _ ->
                // Exception values and thread names can contain response snippets or signed URLs.
                event.user = null
                event.request = null
                event.message = null
                event.exceptions?.forEach { it.value = null }
                event.threads?.forEach { it.name = null }
                event
            }
        }
    }
}
