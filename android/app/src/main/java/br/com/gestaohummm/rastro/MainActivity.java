package br.com.gestaohummm.rastro;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * App RASTRO: abre o Modo campo do site dentro do app e oferece ao site uma ponte ("RastroApp")
 * para ligar o rastreamento em segundo plano (TrackingService), que continua com a tela apagada.
 */
public class MainActivity extends Activity {
    private static final int REQ_PERMS = 7;
    private WebView web;
    private String baseHost;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        baseHost = Uri.parse(BuildConfig.BASE_URL).getHost();
        getWindow().setStatusBarColor(Color.parseColor("#1D1D1B"));

        CookieManager.getInstance().setAcceptCookie(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#1D1D1B"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " RastroAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        web.addJavascriptInterface(new Bridge(), "RastroApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (baseHost.equals(u.getHost()) && "https".equals(u.getScheme())) return false;
                // Endereços de fora do RASTRO (ex.: WhatsApp) abrem fora do app
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                // Localização no site (ex.: registrar a localização da loja) só para o próprio RASTRO
                if (!baseHost.equals(Uri.parse(origin).getHost())) { callback.invoke(origin, false, false); return; }
                if (hasLocationPermission()) { callback.invoke(origin, true, false); return; }
                pendingGeoCallback = callback;
                pendingGeoOrigin = origin;
                requestNeededPermissions();
            }
        });
        setContentView(web);

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(BuildConfig.BASE_URL + "/campo");
        requestNeededPermissions();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true); // não fecha o app: o rastreamento continua
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestNeededPermissions() {
        List<String> need = new ArrayList<>();
        if (!hasLocationPermission()) {
            need.add(Manifest.permission.ACCESS_FINE_LOCATION);
            need.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), REQ_PERMS);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (pendingGeoCallback != null) {
            pendingGeoCallback.invoke(pendingGeoOrigin, hasLocationPermission(), false);
            pendingGeoCallback = null;
        }
    }

    /** Ponte usada pelo Modo campo do site quando aberto dentro do app */
    private class Bridge {
        @JavascriptInterface
        public String info() {
            SharedPreferences p = TrackingService.prefs(MainActivity.this);
            String id = p.getString("installId", null);
            if (id == null) {
                id = UUID.randomUUID().toString() + UUID.randomUUID().toString();
                p.edit().putString("installId", id).apply();
            }
            try {
                return new JSONObject()
                        .put("app", true)
                        .put("version", BuildConfig.VERSION_NAME)
                        .put("installId", id)
                        .put("device", Build.MANUFACTURER + " " + Build.MODEL)
                        .toString();
            } catch (Exception e) { return "{}"; }
        }

        @JavascriptInterface
        public boolean start(String sessionId) {
            if (sessionId == null || sessionId.isEmpty()) return false;
            if (!hasLocationPermission()) {
                runOnUiThread(MainActivity.this::requestNeededPermissions);
                return false;
            }
            Intent i = new Intent(MainActivity.this, TrackingService.class)
                    .setAction(TrackingService.ACTION_START)
                    .putExtra(TrackingService.EXTRA_SESSION, sessionId);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i); else startService(i);
            return true;
        }

        /** Para o GPS e devolve quantos pontos ainda faltam enviar (o envio continua sozinho) */
        @JavascriptInterface
        public int stop() {
            SharedPreferences p = TrackingService.prefs(MainActivity.this);
            String session = p.getString("activeSession", null);
            int pending = session != null ? PointStore.get(MainActivity.this).count(session) : 0;
            startService(new Intent(MainActivity.this, TrackingService.class).setAction(TrackingService.ACTION_STOP));
            return pending;
        }

        @JavascriptInterface
        public String status() {
            SharedPreferences p = TrackingService.prefs(MainActivity.this);
            String session = p.getString("activeSession", null);
            LocationManager lm = (LocationManager) getSystemService(LOCATION_SERVICE);
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            try {
                return new JSONObject()
                        .put("tracking", session != null)
                        .put("sessionId", session == null ? JSONObject.NULL : session)
                        .put("pending", PointStore.get(MainActivity.this).countAll())
                        .put("lastFixAt", p.getLong("lastFixAt", 0))
                        .put("accuracy", p.getFloat("lastAccuracy", -1f))
                        .put("lastSyncAt", p.getLong("lastSyncAt", 0))
                        .put("lastError", p.getString("lastError", ""))
                        .put("permission", hasLocationPermission())
                        .put("gpsEnabled", lm != null && lm.isProviderEnabled(LocationManager.GPS_PROVIDER))
                        .put("batteryOptimized", pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName()))
                        .toString();
            } catch (Exception e) { return "{}"; }
        }

        @JavascriptInterface
        public void openAppSettings() {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
        }

        @JavascriptInterface
        public void openLocationSettings() {
            startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
        }

        /** Pede para o Android não "economizar bateria" no RASTRO (senão alguns celulares param o GPS) */
        @SuppressLint("BatteryLife")
        @JavascriptInterface
        public void requestBatteryExemption() {
            try {
                startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
            } catch (Exception e) {
                startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            }
        }
    }
}
