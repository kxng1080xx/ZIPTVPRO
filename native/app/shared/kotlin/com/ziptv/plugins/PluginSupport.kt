package com.ziptv.plugins

// ZIPTV glue for the JS plugin runtime ported from Nuvio (runtime/*, GPL-3.0): the few things Nuvio got from
// its own app (logger, HTTP client, dispatcher, QuickJS library location).

/** Stand-in for kermit's Logger: plugin console output goes to stdout only when ZIPTV_PLUGIN_LOG=1. */
internal class Logger private constructor(private val tag: String) {
    private fun out(level: String, msg: String, t: Throwable? = null) {
        if (!verbose) return
        println("$level/$tag: $msg" + (t?.let { " ($it)" } ?: ""))
    }
    fun d(msg: () -> String) = out("D", msg())
    fun i(msg: () -> String) = out("I", msg())
    fun w(msg: () -> String) = out("W", msg())
    fun e(msg: () -> String) = out("E", msg())
    fun e(t: Throwable, msg: () -> String) = out("E", msg(), t)

    companion object {
        private val verbose = System.getenv("ZIPTV_PLUGIN_LOG") == "1"
        fun withTag(tag: String) = Logger(tag)
    }
}

/**
 * PC: QuickJS's native library ships inside the quickjs-kt jar as a resource; copy it to [dir] once and point
 * the library at it (Android loads its .so from the APK by itself). Call before the first plugin runs.
 */
fun configureDesktopQuickJs(dir: java.io.File) {
    if (!System.getProperty("com.dokar.quickjs.library.path").isNullOrBlank()) return
    val os = System.getProperty("os.name").orEmpty().lowercase()
    val (folder, name) = when {
        os.contains("windows") -> "windows_x64" to "libquickjs.dll"
        os.contains("mac") -> (if (System.getProperty("os.arch") == "aarch64") "macos_aarch64" else "macos_x64") to "libquickjs.dylib"
        else -> (if (System.getProperty("os.arch") == "aarch64") "linux_aarch64" else "linux_x64") to "libquickjs.so"
    }
    val bytes = Logger::class.java.classLoader?.getResourceAsStream("jni/$folder/$name")?.use { it.readBytes() } ?: return
    val target = java.io.File(dir, "quickjs/$folder").apply { mkdirs() }
    val file = java.io.File(target, name)
    if (!file.exists() || file.length() != bytes.size.toLong()) runCatching { file.writeBytes(bytes) }
    System.setProperty("com.dokar.quickjs.library.path", target.absolutePath)
    System.setProperty("com.dokar.quickjs.library.name", name)
}
