package com.iptv.player.zero;

import android.os.Handler;
import android.os.Looper;

import androidx.mediarouter.media.MediaRouteSelector;
import androidx.mediarouter.media.MediaRouter;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.cast.CastMediaControlIntent;
import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaLoadRequestData;
import com.google.android.gms.cast.MediaMetadata;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.SessionManager;
import com.google.android.gms.cast.framework.SessionManagerListener;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import android.net.wifi.WifiManager;
import android.content.Context;

/**
 * Google Cast (Chromecast / Android TV) sender for the phone app. Discovers Cast
 * routes via MediaRouter and loads media (HLS for live, MP4 for VOD) over a Cast
 * session. The receiver fetches the public provider URL directly, so no local
 * proxy is needed. No-ops where Google Play services / Cast is unavailable
 * (e.g. Amazon Fire TV).
 */
@CapacitorPlugin(name = "Cast")
public class CastPlugin extends Plugin {

    private CastContext castContext;
    private MediaRouter mediaRouter;
    private MediaRouteSelector routeSelector;
    private MediaRouter.Callback routeCallback;
    private final Map<String, MediaRouter.RouteInfo> routes = new LinkedHashMap<>();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, DlnaDevice> dlnaDevices = new LinkedHashMap<>();
    private String activeDlnaDeviceId = null;
    private LocalProxyServer proxyServer;
    
    private static final String mSearch = "M-SEARCH * HTTP/1.1\r\n" +
            "HOST: 239.255.255.250:1900\r\n" +
            "MAN: \"ssdp:discover\"\r\n" +
            "MX: 3\r\n" +
            "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n" +
            "USER-AGENT: Android/10.0 UPnP/1.1 ZIPTVPro/3.15.0\r\n\r\n";

    static class DlnaDevice {
        String id;
        String name;
        String location;
        String controlUrl;
    }

    @Override
    public void load() {
        try {
            proxyServer = new LocalProxyServer();
            proxyServer.start();
        } catch (Exception e) {
            e.printStackTrace();
        }
        main.post(() -> {
            try {
                castContext = CastContext.getSharedInstance(getContext().getApplicationContext());
                mediaRouter = MediaRouter.getInstance(getContext().getApplicationContext());
                routeSelector = new MediaRouteSelector.Builder()
                        .addControlCategory(CastMediaControlIntent.categoryForCast(
                                CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID))
                        .build();
                routeCallback = new MediaRouter.Callback() {
                    @Override public void onRouteAdded(MediaRouter r, MediaRouter.RouteInfo info) { addRoute(info); }
                    @Override public void onRouteChanged(MediaRouter r, MediaRouter.RouteInfo info) { addRoute(info); }
                    @Override public void onRouteRemoved(MediaRouter r, MediaRouter.RouteInfo info) { removeRoute(info); }
                };
                startScan();
            } catch (Throwable t) {
                // Cast not available on this device — methods will simply find no routes.
                startScan();
            }
        });
    }

    private boolean isCastRoute(MediaRouter.RouteInfo info) {
        return info != null && !info.isDefault() && routeSelector != null && info.matchesSelector(routeSelector);
    }

    private void addRoute(MediaRouter.RouteInfo info) {
        if (isCastRoute(info)) { routes.put(info.getId(), info); emitDevices(); }
    }

    private void removeRoute(MediaRouter.RouteInfo info) {
        if (info != null && routes.remove(info.getId()) != null) emitDevices();
    }

    private void startScan() {
        if (mediaRouter != null && routeCallback != null) {
            mediaRouter.addCallback(routeSelector, routeCallback, MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN);
            for (MediaRouter.RouteInfo info : mediaRouter.getRoutes()) addRoute(info);
        }
        discoverDlna();
    }

    private void emitDevices() {
        notifyListeners("devices", devicesPayload());
    }

    private JSObject devicesPayload() {
        JSArray arr = new JSArray();
        for (MediaRouter.RouteInfo info : routes.values()) {
            JSObject d = new JSObject();
            d.put("id", info.getId());
            d.put("name", info.getName());
            d.put("type", "chromecast");
            arr.put(d);
        }
        synchronized (dlnaDevices) {
            for (DlnaDevice dev : dlnaDevices.values()) {
                JSObject d = new JSObject();
                d.put("id", dev.id);
                d.put("name", dev.name);
                d.put("type", "dlna");
                arr.put(d);
            }
        }
        JSObject o = new JSObject();
        o.put("devices", arr);
        return o;
    }

    @Override
    protected void handleOnDestroy() {
        if (proxyServer != null) {
            proxyServer.stop();
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void list(PluginCall call) {
        main.post(() -> {
            startScan();
            call.resolve(devicesPayload());
        });
    }

    @PluginMethod
    public void play(final PluginCall call) {
        final String deviceId = call.getString("deviceId");
        final String url = call.getString("url");
        final String contentType = call.getString("contentType", "video/mp4");
        final String title = call.getString("title", "ZIPTV Pro");
        final boolean isLive = Boolean.TRUE.equals(call.getBoolean("isLive", false));
        if (url == null) { call.reject("Missing url"); return; }

        synchronized (dlnaDevices) {
            if (dlnaDevices.containsKey(deviceId)) {
                String phoneIp = getLocalIpAddress();
                if (phoneIp == null) {
                    call.reject("Could not determine local network IP to cast via DLNA");
                    return;
                }
                
                int port = (proxyServer != null) ? proxyServer.getPort() : 0;
                if (port == 0) {
                    call.reject("Local proxy server not running");
                    return;
                }
                
                String encodedUrl = "";
                try {
                    encodedUrl = java.net.URLEncoder.encode(url, "UTF-8");
                } catch (Exception e) {
                    encodedUrl = url;
                }
                
                String proxyUrl = "http://" + phoneIp + ":" + port + "/proxy?url=" + encodedUrl + "&live=" + (isLive ? "1" : "0");
                activeDlnaDeviceId = deviceId;
                
                new Thread(() -> playDlna(deviceId, proxyUrl, contentType, title, call)).start();
                return;
            }
        }

        activeDlnaDeviceId = null;
        main.post(() -> {
            try {
                if (castContext == null) { call.reject("Cast unavailable on this device"); return; }
                final SessionManager sm = castContext.getSessionManager();
                CastSession current = sm.getCurrentCastSession();

                if (current != null && current.isConnected()) {
                    loadMedia(current, url, contentType, title, isLive);
                    call.resolve();
                    return;
                }

                sm.addSessionManagerListener(new SessionManagerListener<CastSession>() {
                    @Override public void onSessionStarted(CastSession session, String sessionId) {
                        sm.removeSessionManagerListener(this, CastSession.class);
                        loadMedia(session, url, contentType, title, isLive);
                        call.resolve();
                    }
                    @Override public void onSessionStartFailed(CastSession session, int error) {
                        sm.removeSessionManagerListener(this, CastSession.class);
                        call.reject("Cast session failed (" + error + ")");
                    }
                    @Override public void onSessionEnded(CastSession s, int e) {}
                    @Override public void onSessionEnding(CastSession s) {}
                    @Override public void onSessionResumeFailed(CastSession s, int e) {}
                    @Override public void onSessionResumed(CastSession s, boolean w) {}
                    @Override public void onSessionResuming(CastSession s, String id) {}
                    @Override public void onSessionStarting(CastSession s) {}
                    @Override public void onSessionSuspended(CastSession s, int r) {}
                }, CastSession.class);

                MediaRouter.RouteInfo route = routes.get(deviceId);
                if (route != null) {
                    mediaRouter.selectRoute(route);
                } else {
                    call.reject("Cast device not found (try rescanning)");
                }
            } catch (Exception e) {
                call.reject("Cast failed: " + e.getMessage());
            }
        });
    }

    private void loadMedia(CastSession session, String url, String contentType, String title, boolean isLive) {
        MediaMetadata meta = new MediaMetadata(MediaMetadata.MEDIA_TYPE_GENERIC);
        meta.putString(MediaMetadata.KEY_TITLE, title);
        MediaInfo info = new MediaInfo.Builder(url)
                .setStreamType(isLive ? MediaInfo.STREAM_TYPE_LIVE : MediaInfo.STREAM_TYPE_BUFFERED)
                .setContentType(contentType)
                .setMetadata(meta)
                .build();
        RemoteMediaClient rmc = session.getRemoteMediaClient();
        if (rmc != null) {
            rmc.load(new MediaLoadRequestData.Builder().setMediaInfo(info).setAutoplay(true).build());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (activeDlnaDeviceId != null) {
            final String deviceId = activeDlnaDeviceId;
            activeDlnaDeviceId = null;
            new Thread(() -> {
                try {
                    DlnaDevice dev;
                    synchronized (dlnaDevices) {
                        dev = dlnaDevices.get(deviceId);
                    }
                    if (dev != null) {
                        String stopSoap = buildStopSoap();
                        sendSoapRequest(dev.controlUrl, "urn:schemas-upnp-org:service:AVTransport:1#Stop", stopSoap);
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                }
                call.resolve();
            }).start();
            return;
        }

        main.post(() -> {
            try {
                if (castContext != null) castContext.getSessionManager().endCurrentSession(true);
            } catch (Exception e) {}
            call.resolve();
        });
    }

    // --- DLNA / SSDP Discovery & Controls -----------------------------------

    private void discoverDlna() {
        new Thread(() -> {
            WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            WifiManager.MulticastLock lock = null;
            if (wifi != null) {
                try {
                    lock = wifi.createMulticastLock("ZIPTVProDlnaMulticastLock");
                    lock.setReferenceCounted(true);
                    lock.acquire();
                } catch (Exception e) {
                    e.printStackTrace();
                }
            }

            synchronized (dlnaDevices) {
                dlnaDevices.clear();
            }

            DatagramSocket socket = null;
            try {
                socket = new DatagramSocket();
                socket.setSoTimeout(3000);
                
                InetAddress group = InetAddress.getByName("239.255.255.250");
                byte[] txData = mSearch.getBytes("UTF-8");
                DatagramPacket packet = new DatagramPacket(txData, txData.length, group, 1900);
                
                socket.send(packet);
                try { Thread.sleep(100); } catch (Exception e) {}
                socket.send(packet);
                
                byte[] rxBuf = new byte[8192];
                long startTime = System.currentTimeMillis();
                while (System.currentTimeMillis() - startTime < 4000) {
                    DatagramPacket rxPacket = new DatagramPacket(rxBuf, rxBuf.length);
                    try {
                        socket.receive(rxPacket);
                        String resp = new String(rxPacket.getData(), 0, rxPacket.getLength(), "UTF-8");
                        parseSsdpResponse(resp);
                    } catch (java.io.InterruptedIOException e) {
                        break;
                    } catch (Exception e) {
                        break;
                    }
                }
            } catch (Exception e) {
                e.printStackTrace();
            } finally {
                if (socket != null) socket.close();
                if (lock != null && lock.isHeld()) {
                    try { lock.release(); } catch (Exception e) {}
                }
            }
        }).start();
    }

    private void parseSsdpResponse(String response) {
        String location = null;
        String usn = null;
        String[] lines = response.split("\r?\n");
        for (String line : lines) {
            String lower = line.toLowerCase();
            if (lower.startsWith("location:")) {
                location = line.substring(9).trim();
            } else if (lower.startsWith("usn:")) {
                usn = line.substring(4).trim();
            }
        }
        
        if (location != null && !location.isEmpty()) {
            final String loc = location;
            final String deviceId = (usn != null && !usn.isEmpty()) ? parseUsnUuid(usn) : loc;
            
            boolean alreadyExists;
            synchronized (dlnaDevices) {
                alreadyExists = dlnaDevices.containsKey(deviceId);
            }
            if (!alreadyExists) {
                new Thread(() -> fetchDlnaDescription(deviceId, loc)).start();
            }
        }
    }

    private String parseUsnUuid(String usn) {
        int start = usn.indexOf("uuid:");
        if (start != -1) {
            start += 5;
            int end = usn.indexOf("::", start);
            if (end != -1) {
                return usn.substring(start, end);
            }
            return usn.substring(start);
        }
        return usn;
    }

    private void fetchDlnaDescription(String deviceId, String location) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(location);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(3000);
            conn.setRequestMethod("GET");
            
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
            }
            String xml = out.toString("UTF-8");
            
            String friendlyName = extractTag(xml, "friendlyName");
            String controlUrl = extractControlUrl(xml);
            
            if (friendlyName != null && controlUrl != null) {
                String absControlUrl = resolveUrl(location, controlUrl, xml);
                
                DlnaDevice dev = new DlnaDevice();
                dev.id = deviceId;
                dev.name = friendlyName;
                dev.location = location;
                dev.controlUrl = absControlUrl;
                
                synchronized (dlnaDevices) {
                    dlnaDevices.put(deviceId, dev);
                }
                emitDevices();
            }
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private String extractTag(String xml, String tag) {
        java.util.regex.Pattern p = java.util.regex.Pattern.compile("<(?:\\w+:)?" + tag + ">(.*?)</(?:\\w+:)?" + tag + ">", java.util.regex.Pattern.DOTALL);
        java.util.regex.Matcher m = p.matcher(xml);
        if (m.find()) {
            return m.group(1).trim();
        }
        return null;
    }

    private String extractControlUrl(String xml) {
        int idx = xml.indexOf("urn:schemas-upnp-org:service:AVTransport:1");
        if (idx == -1) idx = xml.indexOf("urn:schemas-upnp-org:service:AVTransport:2");
        if (idx == -1) return null;
        
        int serviceStart = xml.lastIndexOf("<service>", idx);
        int serviceEnd = xml.indexOf("</service>", idx);
        if (serviceStart == -1 || serviceEnd == -1) return null;
        
        String serviceBlock = xml.substring(serviceStart, serviceEnd);
        return extractTag(serviceBlock, "controlURL");
    }

    private String resolveUrl(String baseUrl, String relativeUrl, String xml) {
        if (relativeUrl == null) return null;
        if (relativeUrl.startsWith("http://") || relativeUrl.startsWith("https://")) {
            return relativeUrl;
        }
        
        String urlBase = extractTag(xml, "URLBase");
        String base = (urlBase != null && !urlBase.isEmpty()) ? urlBase : baseUrl;
        
        try {
            URL baseURI = new URL(base);
            return new URL(baseURI, relativeUrl).toString();
        } catch (Exception e) {
            if (base.endsWith("/") && relativeUrl.startsWith("/")) {
                return base + relativeUrl.substring(1);
            } else if (!base.endsWith("/") && !relativeUrl.startsWith("/")) {
                return base + "/" + relativeUrl;
            } else {
                return base + relativeUrl;
            }
        }
    }

    private String getLocalIpAddress() {
        try {
            for (Enumeration<NetworkInterface> en = NetworkInterface.getNetworkInterfaces(); en.hasMoreElements();) {
                NetworkInterface intf = en.nextElement();
                for (Enumeration<InetAddress> enumIpAddr = intf.getInetAddresses(); enumIpAddr.hasMoreElements();) {
                    InetAddress inetAddress = enumIpAddr.nextElement();
                    if (!inetAddress.isLoopbackAddress() && inetAddress instanceof Inet4Address) {
                        return inetAddress.getHostAddress();
                    }
                }
            }
        } catch (Exception ex) {
            ex.printStackTrace();
        }
        return null;
    }

    private void playDlna(String deviceId, String url, String contentType, String title, PluginCall call) {
        DlnaDevice dev;
        synchronized (dlnaDevices) {
            dev = dlnaDevices.get(deviceId);
        }
        if (dev == null) {
            call.reject("DLNA device not found");
            return;
        }
        
        try {
            String setUriSoap = buildSetUriSoap(url, contentType, title);
            sendSoapRequest(dev.controlUrl, "urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI", setUriSoap);
            
            String playSoap = buildPlaySoap();
            sendSoapRequest(dev.controlUrl, "urn:schemas-upnp-org:service:AVTransport:1#Play", playSoap);
            
            call.resolve();
        } catch (Exception e) {
            call.reject("DLNA playback failed: " + e.getMessage());
        }
    }

    private String buildSetUriSoap(String url, String contentType, String title) {
        String escUrl = escapeXml(url);
        String escTitle = escapeXml(title);
        String escContentType = escapeXml(contentType);
        
        String FLAGS = "ED100000000000000000000000000000";
        boolean isMpegts = escContentType.contains("mpeg") && !escContentType.contains("mpegurl");
        String dlnaFeatures = isMpegts 
            ? "DLNA.ORG_PN=MPEG_TS_NA_ISO;DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=" + FLAGS 
            : "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=" + FLAGS;

        String protocolInfo = "http-get:*:" + escContentType + ":" + dlnaFeatures;
        
        String didl = "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" " +
                "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" " +
                "xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">" +
                "<item id=\"0\" parentID=\"-1\" restricted=\"1\">" +
                "<dc:title>" + escTitle + "</dc:title>" +
                "<upnp:class>object.item.videoItem</upnp:class>" +
                "<res protocolInfo=\"" + protocolInfo + "\">" + escUrl + "</res>" +
                "</item>" +
                "</DIDL-Lite>";
        
        String escDidl = escapeXml(didl);
        
        return "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" +
                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\n" +
                "  <s:Body>\n" +
                "    <u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\n" +
                "      <InstanceID>0</InstanceID>\n" +
                "      <CurrentURI>" + escUrl + "</CurrentURI>\n" +
                "      <CurrentURIMetaData>" + escDidl + "</CurrentURIMetaData>\n" +
                "    </u:SetAVTransportURI>\n" +
                "  </s:Body>\n" +
                "</s:Envelope>";
    }

    private String buildPlaySoap() {
        return "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" +
                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\n" +
                "  <s:Body>\n" +
                "    <u:Play xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\n" +
                "      <InstanceID>0</InstanceID>\n" +
                "      <Speed>1</Speed>\n" +
                "    </u:Play>\n" +
                "  </s:Body>\n" +
                "</s:Envelope>";
    }

    private String buildStopSoap() {
        return "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" +
                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\n" +
                "  <s:Body>\n" +
                "    <u:Stop xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\n" +
                "      <InstanceID>0</InstanceID>\n" +
                "    </u:Stop>\n" +
                "  </s:Body>\n" +
                "</s:Envelope>";
    }

    private String escapeXml(String str) {
        if (str == null) return "";
        return str.replace("&", "&amp;")
                  .replace("<", "&lt;")
                  .replace(">", "&gt;")
                  .replace("\"", "&quot;")
                  .replace("'", "&apos;");
    }

    private void sendSoapRequest(String controlUrl, String soapAction, String xml) throws Exception {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(controlUrl);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "text/xml; charset=utf-8");
            conn.setRequestProperty("SOAPACTION", "\"" + soapAction + "\"");
            conn.setDoOutput(true);
            
            byte[] payload = xml.getBytes("UTF-8");
            conn.setRequestProperty("Content-Length", String.valueOf(payload.length));
            
            OutputStream out = conn.getOutputStream();
            out.write(payload);
            out.close();
            
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                InputStream err = conn.getErrorStream();
                String errorMsg = "";
                if (err != null) {
                    ByteArrayOutputStream errOut = new ByteArrayOutputStream();
                    byte[] buf = new byte[1024];
                    int n;
                    while ((n = err.read(buf)) != -1) {
                        errOut.write(buf, 0, n);
                    }
                    errorMsg = ": " + errOut.toString("UTF-8");
                }
                throw new Exception("HTTP " + code + errorMsg);
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    // --- Local HTTP Proxy Server for DLNA -----------------------------------

    static class LocalProxyServer {
        private ServerSocket serverSocket;
        private int port = 0;
        private boolean running = false;
        
        public void start() {
            new Thread(() -> {
                try {
                    serverSocket = new ServerSocket(0);
                    port = serverSocket.getLocalPort();
                    running = true;
                    while (running) {
                        Socket client = serverSocket.accept();
                        new Thread(() -> handleClient(client)).start();
                    }
                } catch (Exception e) {
                    // silent socket close on stop
                }
            }).start();
        }
        
        public int getPort() { return port; }
        
        public void stop() {
            running = false;
            try { if (serverSocket != null) serverSocket.close(); } catch (Exception e) {}
        }
        
        private void handleClient(Socket client) {
            try {
                BufferedReader in = new BufferedReader(new InputStreamReader(client.getInputStream(), "UTF-8"));
                String firstLine = in.readLine();
                if (firstLine == null) { client.close(); return; }
                
                String[] parts = firstLine.split(" ");
                if (parts.length < 2) { client.close(); return; }
                
                String method = parts[0];
                String path = parts[1];
                
                String headerLine;
                Map<String, String> requestHeaders = new HashMap<>();
                while ((headerLine = in.readLine()) != null && !headerLine.trim().isEmpty()) {
                    int colon = headerLine.indexOf(':');
                    if (colon != -1) {
                        requestHeaders.put(headerLine.substring(0, colon).trim().toLowerCase(), headerLine.substring(colon + 1).trim());
                    }
                }
                
                if (!path.startsWith("/proxy")) {
                    sendError(client, 404, "Not Found");
                    return;
                }
                
                int queryIdx = path.indexOf('?');
                String query = (queryIdx != -1) ? path.substring(queryIdx + 1) : null;
                String targetUrl = null;
                boolean isLive = false;
                if (query != null) {
                    for (String param : query.split("&")) {
                        String[] kv = param.split("=");
                        if (kv.length == 2) {
                            if (kv[0].equals("url")) {
                                targetUrl = URLDecoder.decode(kv[1], "UTF-8");
                            } else if (kv[0].equals("live")) {
                                isLive = kv[1].equals("1");
                            }
                        }
                    }
                }
                
                if (targetUrl == null) {
                    sendError(client, 400, "Bad Request");
                    return;
                }
                
                String FLAGS = "ED100000000000000000000000000000";
                String mime = isLive ? "video/mpeg" : "video/mp4";
                String dlnaFeatures = isLive 
                    ? "DLNA.ORG_PN=MPEG_TS_NA_ISO;DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=" + FLAGS 
                    : "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=" + FLAGS;
                
                if (method.equalsIgnoreCase("HEAD")) {
                    OutputStream out = client.getOutputStream();
                    PrintWriter writer = new PrintWriter(new OutputStreamWriter(out, "UTF-8"));
                    writer.print("HTTP/1.1 200 OK\r\n");
                    writer.print("Content-Type: " + mime + "\r\n");
                    writer.print("transferMode.dlna.org: Streaming\r\n");
                    writer.print("contentFeatures.dlna.org: " + dlnaFeatures + "\r\n");
                    writer.print("Connection: close\r\n\r\n");
                    writer.flush();
                    client.close();
                    return;
                }
                
                proxyGet(client, targetUrl, mime, dlnaFeatures, requestHeaders);
                
            } catch (Exception e) {
                e.printStackTrace();
                try { client.close(); } catch (Exception ex) {}
            }
        }
        
        private void proxyGet(Socket client, String targetUrl, String mime, String dlnaFeatures, Map<String, String> requestHeaders) {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(targetUrl);
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                
                if (requestHeaders.containsKey("range")) {
                    conn.setRequestProperty("Range", requestHeaders.get("range"));
                }
                
                int responseCode = conn.getResponseCode();
                
                OutputStream out = client.getOutputStream();
                PrintWriter writer = new PrintWriter(new OutputStreamWriter(out, "UTF-8"));
                
                if (responseCode == 206) {
                    writer.print("HTTP/1.1 206 Partial Content\r\n");
                } else {
                    writer.print("HTTP/1.1 200 OK\r\n");
                }
                
                writer.print("Content-Type: " + mime + "\r\n");
                String range = conn.getHeaderField("Content-Range");
                if (range != null) {
                    writer.print("Content-Range: " + range + "\r\n");
                }
                long len = conn.getContentLengthLong();
                if (len != -1) {
                    writer.print("Content-Length: " + len + "\r\n");
                }
                
                writer.print("transferMode.dlna.org: Streaming\r\n");
                writer.print("contentFeatures.dlna.org: " + dlnaFeatures + "\r\n");
                writer.print("Connection: close\r\n\r\n");
                writer.flush();
                
                InputStream in = conn.getInputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                }
                out.flush();
            } catch (Exception e) {
                // connection reset or client disconnected
            } finally {
                if (conn != null) conn.disconnect();
                try { client.close(); } catch (Exception e) {}
            }
        }
        
        private void sendError(Socket client, int code, String msg) {
            try {
                OutputStream out = client.getOutputStream();
                PrintWriter writer = new PrintWriter(new OutputStreamWriter(out, "UTF-8"));
                writer.print("HTTP/1.1 " + code + " " + msg + "\r\n");
                writer.print("Content-Type: text/plain\r\n");
                writer.print("Connection: close\r\n\r\n");
                writer.print(msg);
                writer.flush();
                client.close();
            } catch (Exception e) {}
        }
    }
}
