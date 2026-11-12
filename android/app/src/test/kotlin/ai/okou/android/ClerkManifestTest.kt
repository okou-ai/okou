package ai.okou.android

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 35])
class ClerkManifestTest {
    @Test
    fun requiredSdkComponentRemainsAddressableWhilePrivateAndDisabled() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val component =
            ComponentName(context, "com.clerk.api.sharedsession.SharedSessionSyncProvider")
        val info =
            context.packageManager.getProviderInfo(
                component,
                PackageManager.MATCH_DISABLED_COMPONENTS,
            )
        assertFalse(info.exported)
        assertFalse(info.enabled)
        // This is the framework operation Clerk.initialize performs even with sharing disabled.
        context.packageManager.setComponentEnabledSetting(
            component,
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP,
        )
    }
}
