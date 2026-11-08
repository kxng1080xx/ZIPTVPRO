import org.jetbrains.compose.desktop.application.dsl.TargetFormat

plugins {
    kotlin("jvm")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.compose")
}

kotlin {
    jvmToolchain(17)
    sourceSets["main"].kotlin.srcDir("../shared/kotlin")
}

// Same logo index as Android, on the classpath.
val copyLogoIndex by tasks.registering(Copy::class) {
    from(rootProject.file("../../public/channel-logos.json"))
    into(layout.buildDirectory.dir("generated/ziptvResources"))
}

// TMDB read token from the repo's .env (same as v9's vite build), packaged as a resource.
val writeTmdbToken by tasks.registering {
    val out = layout.buildDirectory.file("generated/ziptvResources/tmdb.token")
    outputs.file(out)
    doLast {
        val env = rootProject.file("../../.env")
        val token = if (env.exists()) env.readLines().firstOrNull { it.trim().startsWith("TMDB_TOKEN") }
            ?.substringAfter('=')?.trim()?.removeSurrounding("\"") ?: "" else ""
        out.get().asFile.apply { parentFile.mkdirs(); writeText(token) }
    }
}

// Trimmed VLC for the installer: playback plugins only (no Qt GUI, visualizations, stream
// output, Lua, services discovery…) ~100 MB instead of ~140. From VLC_DIR or the installed VLC.
val prepareVlc by tasks.registering(Sync::class) {
    val vlcDir = System.getenv("VLC_DIR") ?: "C:/Program Files/VideoLAN/VLC"
    from(vlcDir) {
        include("libvlc.dll", "libvlccore.dll", "plugins/**")
        exclude("plugins/plugins.dat") // the app writes its own (VlcjPlayer): install-time file dates make any shipped one stale
        listOf("gui", "visualization", "lua", "control", "services_discovery", "meta_engine",
            "stream_out", "access_output", "mux", "video_splitter").forEach { exclude("plugins/$it/**") }
    }
    into(layout.buildDirectory.dir("vlcResources/windows/vlc"))
    doFirst { require(file("$vlcDir/libvlc.dll").exists()) { "VLC not found at $vlcDir (set VLC_DIR)" } }
}

sourceSets["main"].resources.srcDir(layout.buildDirectory.dir("generated/ziptvResources"))
tasks.named("processResources") { dependsOn(copyLogoIndex, writeTmdbToken) }

dependencies {
    implementation(compose.desktop.currentOs)
    implementation(compose.material3)
    implementation(compose.materialIconsExtended)
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-swing:1.11.0")
    implementation("io.coil-kt.coil3:coil-compose:3.6.3")
    implementation("io.coil-kt.coil3:coil-network-okhttp:3.6.3")
    implementation("net.java.dev.jna:jna:5.19.1")
    implementation("uk.co.caprica:vlcj:4.12.1")
}

compose.desktop {
    application {
        mainClass = "com.ziptv.desktop.MainKt"
        // Packaging needs jpackage, which Android Studio's JBR lacks (Gradle itself still runs on JBR).
        (System.getenv("JPACKAGE_JDK") ?: "C:/Program Files/Java/jdk-26.0.2.1").let { if (file(it).exists()) javaHome = it }
        nativeDistributions {
            targetFormats(TargetFormat.Msi, TargetFormat.Exe)
            // jdk.unsupported: vlcj allocates frame buffers via sun.misc.Unsafe. Without it the bundled
            // runtime (CI's JDK 17 jlink) drops every frame: audio plays, picture stays black (10.0.0-10.0.4).
            // From `gradlew :desktopApp:suggestRuntimeModules`; re-run it after adding libraries.
            modules("java.instrument", "jdk.unsupported")
            packageName = "ZIPTV Pro"
            packageVersion = providers.gradleProperty("ziptv.version").get()
            appResourcesRootDir.set(layout.buildDirectory.dir("vlcResources")) // windows/vlc -> <app>/resources/vlc
            windows {
                menuGroup = "ZIPTV Pro"; shortcut = true; iconFile.set(rootProject.file("../../build/icon.ico"))
                // NEVER change: MSI upgrades find the old install by this id (without it every
                // version installed side by side). Generated once for v10.
                upgradeUuid = "f6c61db4-b087-4cab-ae16-a0857c04c599"
                perUserInstall = true // like v9: %LOCALAPPDATA%, no admin prompt
            }
        }
    }
}

tasks.matching { it.name == "prepareAppResources" }.configureEach { dependsOn(prepareVlc) }
