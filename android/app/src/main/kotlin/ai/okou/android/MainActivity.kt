package ai.okou.android

import android.os.Bundle
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
    private val home: HomeModel by viewModels()
    private val appearance: AppearanceModel by viewModels {
        viewModelFactory {
            initializer { AppearanceModel((application as OkouApplication).appearancePreferences) }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val settings = appearance
        val editor = home
        setContent {
            val state by settings.uiState.collectAsStateWithLifecycle()
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
            OkouTheme(dark) { OkouApp(editor, state, settings::selectMode, settings::retry) }
        }
    }
}
