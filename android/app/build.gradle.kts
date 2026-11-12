plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

val appVersion = rootProject.file("version.txt").readText().trim()

require(Regex("\\d+\\.\\d+\\.\\d+").matches(appVersion)) {
    "Android version.txt must contain a stable x.y.z version"
}

val versionParts = appVersion.split('.').map { it.toInt() }
val appVersionCode =
    versionParts[0].toLong() * 1_000_000 + versionParts[1] * 1_000L + versionParts[2]

require(
    versionParts[1] < 1_000 &&
        versionParts[2] < 1_000 &&
        appVersionCode in 1..Int.MAX_VALUE.toLong()
) {
    "Android version must fit a monotonic major*1000000 + minor*1000 + patch versionCode"
}

android {
    namespace = "ai.okou.android"
    compileSdk = 35
    defaultConfig {
        applicationId = "ai.okou.android"
        minSdk = 24
        targetSdk = 35
        versionCode = appVersionCode.toInt()
        versionName = appVersion
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        testInstrumentationRunnerArguments["useTestStorageService"] = "true"
    }
    buildTypes { debug { applicationIdSuffix = ".debug" } }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets["main"].res.srcDir(layout.buildDirectory.dir("generated/brand/res"))
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/brand/assets"))
    testOptions {
        unitTests.isIncludeAndroidResources = true
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

val generateBrandFonts by
    tasks.registering(Sync::class) {
        from("../../ios/Okou/Resources/Fonts/Geist.ttf") { rename { "geist.ttf" } }
        into(layout.buildDirectory.dir("generated/brand/res/font"))
    }

tasks.named("preBuild") { dependsOn(generateBrandFonts) }

val generateLicenseAssets by
    tasks.registering(Sync::class) {
        from("../../ios/Okou/Resources/Fonts") { include("*-LICENSE.txt") }
        from("../../ios/Okou/DesignSystem/Lucide-LICENSE.txt")
        into(layout.buildDirectory.dir("generated/brand/assets/licenses"))
    }

tasks.named("preBuild") { dependsOn(generateLicenseAssets) }

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.foundation)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.navigation.compose)
    implementation(libs.datastore.preferences)
    implementation(libs.coroutines.android)
    implementation(libs.retrofit)
    implementation(libs.retrofit.serialization)
    implementation(libs.okhttp)
    implementation(libs.serialization.json)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(libs.compose.ui.test)
    testImplementation(libs.lifecycle.runtime.testing)
    debugImplementation(libs.compose.ui.test.manifest)
    androidTestImplementation(libs.test.core.ktx)
    androidTestImplementation(libs.test.ext.junit)
    androidTestImplementation(libs.test.runner)
    androidTestImplementation(libs.test.uiautomator)
    androidTestImplementation(libs.test.storage)
    androidTestUtil(libs.test.services)
}
