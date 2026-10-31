package br.com.gestaohummm.rastro;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.webkit.CookieManager;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Serviço em primeiro plano que registra o percurso com a tela apagada.
 * - Só roda depois que a pessoa toca em "Iniciar" e mostra uma notificação fixa enquanto rastreia.
 * - Guarda cada ponto numa fila local e envia em lotes a cada 10 segundos (sem internet, envia depois).
 * - Ao encerrar, para o GPS e continua só enviando o que faltou; depois se desliga.
 */
public class TrackingService extends Service implements LocationListener {
    public static final String ACTION_START = "br.com.gestaohummm.rastro.START";
    public static final String ACTION_STOP = "br.com.gestaohummm.rastro.STOP";
    public static final String EXTRA_SESSION = "session";
    private static final String CHANNEL = "rastreamento";
    private static final int NOTIF_ID = 42;
    private static final long MIN_INTERVAL_MS = 3000;
    private static final float MIN_DISTANCE_M = 4f;

    private LocationManager locationManager;
    private ScheduledExecutorService uploader;
    private PowerManager.WakeLock wakeLock;
    private boolean listening = false;

    public static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences("rastro", Context.MODE_PRIVATE);
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        SharedPreferences p = prefs(this);
        if (ACTION_STOP.equals(action)) {
            stopListening();
            p.edit().remove("activeSession").apply();
            goForeground("Enviando os últimos pontos do percurso...");
            ensureUploader();
            return START_NOT_STICKY;
        }
        String session = intent != null && intent.hasExtra(EXTRA_SESSION) ? intent.getStringExtra(EXTRA_SESSION) : p.getString("activeSession", null);
        if (session == null) {
            // Reiniciado pelo sistema sem rastreamento ativo: só termina os envios pendentes
            if (PointStore.get(this).countAll() > 0) { goForeground("Enviando pontos pendentes..."); ensureUploader(); }
            else stopSelf();
            return START_NOT_STICKY;
        }
        p.edit().putString("activeSession", session).putString("lastError", "").apply();
        goForeground("Registrando o seu percurso");
        startListening();
        ensureUploader();
        return START_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Rastreamento do percurso", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Aparece enquanto o RASTRO registra o percurso.");
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(ch);
        }
    }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        int pending = PointStore.get(this).countAll();
        String detail = pending > 0 ? pending + " ponto(s) aguardando envio" : "Pontos enviados";
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle("RASTRO · " + text)
                .setContentText(detail + ". Toque para abrir.")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pi)
                .build();
    }

    private void goForeground(String text) {
        Notification n = buildNotification(text);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    private void updateNotification() {
        String text = listening ? "Registrando o seu percurso" : "Enviando os últimos pontos do percurso...";
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTIF_ID, buildNotification(text));
    }

    private void startListening() {
        if (listening) return;
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            prefs(this).edit().putString("lastError", "Sem permissão de localização. Abra o app e permita a localização.").apply();
            return;
        }
        try {
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, MIN_INTERVAL_MS, MIN_DISTANCE_M, this, Looper.getMainLooper());
            listening = true;
        } catch (Exception e) {
            prefs(this).edit().putString("lastError", "Não foi possível ligar o GPS: " + e.getMessage()).apply();
        }
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "rastro:rastreamento");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(12 * 60 * 60 * 1000L); // no máximo 12 h
        }
    }

    private void stopListening() {
        if (listening) {
            try { locationManager.removeUpdates(this); } catch (Exception ignored) { }
            listening = false;
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    @Override
    public void onLocationChanged(Location loc) {
        String session = prefs(this).getString("activeSession", null);
        if (session == null) return;
        PointStore.get(this).add(
                UUID.randomUUID().toString(), session, loc.getLatitude(), loc.getLongitude(),
                loc.hasAccuracy() ? loc.getAccuracy() : null,
                loc.hasAltitude() ? loc.getAltitude() : null,
                loc.hasSpeed() ? loc.getSpeed() : null,
                loc.hasBearing() ? loc.getBearing() : null,
                Instant.ofEpochMilli(loc.getTime()).toString());
        prefs(this).edit().putLong("lastFixAt", System.currentTimeMillis()).putFloat("lastAccuracy", loc.hasAccuracy() ? loc.getAccuracy() : -1f).apply();
    }

    @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
    @Override public void onProviderEnabled(String provider) { prefs(this).edit().putString("lastError", "").apply(); }
    @Override public void onProviderDisabled(String provider) {
        prefs(this).edit().putString("lastError", "O GPS do celular foi desligado. Ligue a localização para continuar registrando.").apply();
    }

    private synchronized void ensureUploader() {
        if (uploader != null) return;
        uploader = Executors.newSingleThreadScheduledExecutor();
        uploader.scheduleWithFixedDelay(this::uploadAll, 2, 10, TimeUnit.SECONDS);
    }

    /** Envia os pontos pendentes de todas as sessões; quando não há mais nada e não está rastreando, desliga o serviço */
    private void uploadAll() {
        PointStore store = PointStore.get(this);
        try {
            for (String session : store.sessions()) {
                for (int i = 0; i < 20; i++) {
                    PointStore.Batch b = store.pending(session, 200);
                    if (b.ids.isEmpty()) break;
                    int remaining = Math.max(0, store.count(session) - b.ids.size());
                    JSONObject body = new JSONObject();
                    body.put("points", b.points);
                    body.put("pendingPoints", remaining);
                    int code = post("/api/tracking/sessions/" + session + "/points", body.toString());
                    if (code >= 200 && code < 300) {
                        store.remove(b.ids);
                        prefs(this).edit().putLong("lastSyncAt", System.currentTimeMillis()).putString("lastError", "").apply();
                    } else if (code == 404) {
                        // Sessão inexistente ou de outra pessoa: os pontos não têm para onde ir
                        store.removeSession(session);
                        break;
                    } else if (code == 401) {
                        prefs(this).edit().putString("lastError", "Sua sessão no RASTRO terminou. Abra o app e entre de novo: os pontos continuam guardados.").apply();
                        return;
                    } else if (code == 403) {
                        prefs(this).edit().putString("lastError", "O envio foi recusado (aparelho bloqueado ou campanha sem permissão). Fale com a gestão.").apply();
                        return;
                    } else {
                        return; // sem internet ou servidor fora do ar: tenta de novo no próximo ciclo
                    }
                }
            }
        } catch (Exception ignored) {
            // sem internet: fica para o próximo ciclo
        } finally {
            try { updateNotification(); } catch (Exception ignored) { }
            if (!listening && store.countAll() == 0) {
                stopForeground(true);
                stopSelf();
            }
        }
    }

    private int post(String path, String json) throws Exception {
        String base = BuildConfig.BASE_URL;
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(15000);
        c.setReadTimeout(20000);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("User-Agent", "RastroAndroid/" + BuildConfig.VERSION_NAME);
        String cookies = CookieManager.getInstance().getCookie(base);
        if (cookies != null) c.setRequestProperty("Cookie", cookies);
        try (OutputStream os = c.getOutputStream()) {
            os.write(json.getBytes(StandardCharsets.UTF_8));
        }
        int code = c.getResponseCode();
        try (InputStream is = code < 400 ? c.getInputStream() : c.getErrorStream()) {
            if (is != null) while (is.read() != -1) { /* descarta a resposta */ }
        } catch (Exception ignored) { }
        c.disconnect();
        return code;
    }

    @Override
    public void onDestroy() {
        stopListening();
        if (uploader != null) uploader.shutdownNow();
        uploader = null;
        super.onDestroy();
    }
}
