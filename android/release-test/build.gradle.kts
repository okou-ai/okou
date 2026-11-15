plugins { alias(libs.plugins.android.test) }

android {
    namespace = "ai.okou.android.releasetest"
    compileSdk = 36
    targetProjectPath = ":app"
    experimentalProperties["android.experimental.self-instrumenting"] = true
    defaultConfig {
        minSdk = 24
        targetSdk = 35
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        testInstrumentationRunnerArguments["useTestStorageService"] = "true"
    }
    buildTypes { create("release") { isDebuggable = true } }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions {
        animationsDisabled = true
        managedDevices {
            localDevices.create("pixel2Api35") {
                device = "Pixel 2"
                apiLevel = 35
                systemImageSource = "aosp"
                require64Bit = true
            }
        }
    }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

androidComponents { beforeVariants(selector().withBuildType("debug")) { it.enable = false } }

dependencies {
    implementation(libs.test.ext.junit)
    implementation(libs.test.runner)
    implementation(libs.test.uiautomator)
    implementation(libs.test.storage)
    androidTestUtil(libs.test.services)
}
