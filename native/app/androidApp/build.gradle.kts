plugins {
    id("com.android.application")
    kotlin("android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The channel-logo index the web app ships (public/channel-logos.json), packaged as an asset.
val copyLogoIndex by tasks.registering(Copy::class) {
    from(rootProject.file("../../public/channel-logos.json"))
    into(layout.buildDirectory.dir("generated/ziptvAssets"))
}


// TMDB read token from the repo's .env (same as v9's vite build), packaged as a resource.
val writeTmdbToken by tasks.registering {
    val out = layout.buildDirectory.file("generated/ziptvAssets/tmdb.token")
    outputs.file(out)
    doLast {
        val env = rootProject.file("../../.env")
        val token = if (env.exists()) env.readLines().firstOrNull { it.trim().startsWith("TMDB_TOKEN") }
            ?.substringAfter('=')?.trim()?.removeSurrounding("\"") ?: "" else ""
        out.get().asFile.apply { parentFile.mkdirs(); writeText(token) }
    }
}

android {
    namespace = "com.ziptv.app"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.ziptv.app"
        minSdk = 24
        targetSdk = 36
        versionName = providers.gradleProperty("ziptv.version").get()
        versionCode = providers.gradleProperty("ziptv.versionCode").get().toInt()
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64", "x86") }
    }

    sourceSets["main"].apply {
        java.srcDir("../shared/kotlin")
        assets.srcDir(layout.buildDirectory.dir("generated/ziptvAssets"))
    }

    buildTypes {
        release {
            isMinifyEnabled = false // ponytail: no R8 yet; JNA/uniffi need keep rules before enabling
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true }
    packaging { jniLibs { useLegacyPackaging = true } }
}

kotlin { jvmToolchain(17) }

tasks.named("preBuild") { dependsOn(copyLogoIndex, writeTmdbToken) }

dependencies {
    val bom = platform("androidx.compose:compose-bom:2025.06.00") // newer BOMs need AGP 9.1+
    implementation(bom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended:1.7.8")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("io.coil-kt.coil3:coil-compose:3.2.0")
    implementation("io.coil-kt.coil3:coil-network-okhttp:3.2.0")
    implementation("net.java.dev.jna:jna:5.19.1@aar")
    implementation("org.videolan.android:libvlc-all:3.6.5")
}
