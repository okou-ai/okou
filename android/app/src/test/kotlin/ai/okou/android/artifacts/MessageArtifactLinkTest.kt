package ai.okou.android.artifacts

import ai.okou.android.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MessageArtifactLinkTest {
    @Test
    fun onlyCanonicalReferencesAndHostedSiteIdentitiesBecomeCards() {
        val path = "/artifacts/artifacts2.md"
        assertEquals(path, messageArtifactLink("$path#page=1"))
        assertEquals(path, messageArtifactLink(BuildConfig.WEB_ORIGIN + path))
        assertEquals(
            "https://launch.okou.app/",
            messageArtifactLink("https://launch.okou.app/path?key=example#section"),
        )
        assertNull(messageArtifactLink("https://example.com$path"))
        assertNull(messageArtifactLink(BuildConfig.WEB_ORIGIN + "$path?key=example"))
        assertNull(messageArtifactLink("https://launch.okou.app.example.com/"))
        assertNull(messageArtifactLink("https://files.sites.vm7.io/"))
    }
}
