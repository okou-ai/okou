package ai.okou.android

import ai.okou.android.auth.SessionModel
import ai.okou.android.auth.SessionRoot
import ai.okou.android.auth.WorkspaceSessionFactory
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory

class MainActivity : ComponentActivity() {
    private val session: SessionModel by viewModels {
        viewModelFactory {
            initializer {
                val app = application as OkouApplication
                SessionModel(
                    app.authentication,
                    WorkspaceSessionFactory(app::createWorkspaceSession),
                    BuildConfig.API_ORIGIN,
                )
            }
        }
    }
    private val appearance: AppearanceModel by viewModels {
        viewModelFactory {
            initializer { AppearanceModel((application as OkouApplication).appearancePreferences) }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val settings = appearance
        val authentication = session
        setContent {
            val state by settings.uiState.collectAsStateWithLifecycle()
            val sessionState by authentication.uiState.collectAsStateWithLifecycle()
            // Capture the rendered owner, rather than reading a newer State value on an old click.
            val presentedGeneration = sessionState.generation
            val dark = state.mode.resolveDark(isSystemInDarkTheme())
            LaunchedEffect(dark) {
                val style =
                    if (dark) SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
                    else
                        SystemBarStyle.light(
                            android.graphics.Color.TRANSPARENT,
                            android.graphics.Color.BLACK,
                        )
                enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
            }
            OkouTheme(dark) {
                SessionRoot(
                    sessionState,
                    state,
                    settings::selectMode,
                    settings::retry,
                    { authentication.retry(presentedGeneration) },
                    { id -> authentication.chooseWorkspace(id, presentedGeneration) },
                    { authentication.signOut(presentedGeneration) },
                    openWorkspaceSetup = {
                        try {
                            startActivity(
                                Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.WEB_ORIGIN))
                            )
                        } catch (_: ActivityNotFoundException) {
                            Toast.makeText(
                                    this,
                                    R.string.auth_browser_unavailable,
                                    Toast.LENGTH_LONG,
                                )
                                .show()
                        }
                    },
                )
            }
        }
    }
}
