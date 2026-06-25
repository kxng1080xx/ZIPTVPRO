package com.iptv.player.zero;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Downloads an APK to the app cache and launches the system package installer.
 * Needed on devices (e.g. Fire TV) whose browser can't install APKs — the app
 * fetches the update itself and hands it to Android's installer via FileProvider.
 */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    @PluginMethod
    public void downloadAndInstall(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("Missing url");
            return;
        }

        // Android 8+ gates installs behind a per-app "install unknown apps"
        // permission. If it isn't granted, send the user to the settings screen
        // and tell the UI to ask them to retry.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            try {
                Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName()));
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(settings);
            } catch (Exception ignored) {
            }
            call.reject("NEEDS_PERMISSION");
            return;
        }

        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    File apk = new File(getContext().getCacheDir(), "update.apk");
                    if (apk.exists()) apk.delete();

                    conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setInstanceFollowRedirects(true);
                    conn.setConnectTimeout(20000);
                    conn.setReadTimeout(60000);
                    conn.connect();

                    int code = conn.getResponseCode();
                    if (code / 100 != 2) {
                        call.reject("Download failed: HTTP " + code);
                        return;
                    }

                    // Total size for the progress bar. -1 (unknown) → JS shows an
                    // indeterminate bar; APKs are well under 2GB so a long is plenty.
                    long total;
                    try {
                        total = conn.getContentLengthLong();
                    } catch (Throwable t) {
                        total = conn.getContentLength();
                    }

                    InputStream in = conn.getInputStream();
                    FileOutputStream out = new FileOutputStream(apk);
                    byte[] buf = new byte[8192];
                    int n;
                    long downloaded = 0;
                    int lastPct = -1;
                    long lastEmitBytes = 0;
                    while ((n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                        downloaded += n;

                        // Emit progress to JS. With a known total, emit on each whole
                        // percent change; otherwise emit roughly every 512KB so the UI
                        // can still show bytes downloaded.
                        boolean emit = false;
                        int pct = -1;
                        if (total > 0) {
                            pct = (int) (downloaded * 100 / total);
                            if (pct != lastPct) { lastPct = pct; emit = true; }
                        } else if (downloaded - lastEmitBytes >= 512 * 1024) {
                            lastEmitBytes = downloaded;
                            emit = true;
                        }
                        if (emit) {
                            JSObject ev = new JSObject();
                            ev.put("percent", pct);          // -1 when total unknown
                            ev.put("downloaded", downloaded);
                            ev.put("total", total);
                            notifyListeners("downloadProgress", ev);
                        }
                    }
                    out.flush();
                    out.close();
                    in.close();

                    // Final 100% tick so the bar always lands full before install.
                    JSObject doneEv = new JSObject();
                    doneEv.put("percent", 100);
                    doneEv.put("downloaded", downloaded);
                    doneEv.put("total", total > 0 ? total : downloaded);
                    notifyListeners("downloadProgress", doneEv);

                    final Uri uri = FileProvider.getUriForFile(getContext(),
                            getContext().getPackageName() + ".fileprovider", apk);

                    getActivity().runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                Intent intent = new Intent(Intent.ACTION_VIEW);
                                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                getContext().startActivity(intent);

                                JSObject ret = new JSObject();
                                ret.put("started", true);
                                call.resolve(ret);
                            } catch (Exception e) {
                                call.reject("Install failed: " + e.getMessage());
                            }
                        }
                    });
                } catch (Exception e) {
                    call.reject("Download failed: " + e.getMessage());
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
        }).start();
    }
}
