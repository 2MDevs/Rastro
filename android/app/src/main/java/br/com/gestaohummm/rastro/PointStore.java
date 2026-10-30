package br.com.gestaohummm.rastro;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Fila local de pontos GPS: nada se perde sem internet; cada ponto tem um id único (o servidor ignora repetidos). */
public class PointStore extends SQLiteOpenHelper {
    private static PointStore instance;

    public static synchronized PointStore get(Context ctx) {
        if (instance == null) instance = new PointStore(ctx.getApplicationContext());
        return instance;
    }

    private PointStore(Context ctx) {
        super(ctx, "rastro_pontos.db", null, 1);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE points (id TEXT PRIMARY KEY, session TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, " +
                "acc REAL, alt REAL, speed REAL, heading REAL, captured TEXT NOT NULL, created INTEGER NOT NULL)");
        db.execSQL("CREATE INDEX points_session ON points(session, created)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { }

    public synchronized void add(String id, String session, double lat, double lng, Float acc, Double alt, Float speed, Float heading, String captured) {
        ContentValues v = new ContentValues();
        v.put("id", id);
        v.put("session", session);
        v.put("lat", lat);
        v.put("lng", lng);
        if (acc != null) v.put("acc", acc); else v.putNull("acc");
        if (alt != null) v.put("alt", alt); else v.putNull("alt");
        if (speed != null) v.put("speed", speed); else v.putNull("speed");
        if (heading != null) v.put("heading", heading); else v.putNull("heading");
        v.put("captured", captured);
        v.put("created", System.currentTimeMillis());
        getWritableDatabase().insertWithOnConflict("points", null, v, SQLiteDatabase.CONFLICT_IGNORE);
    }

    /** Lote de pontos de uma sessão em formato JSON da API, mais os ids para apagar depois do envio */
    public synchronized Batch pending(String session, int limit) {
        Batch b = new Batch();
        try (Cursor c = getReadableDatabase().query("points", null, "session = ?", new String[]{session}, null, null, "created", String.valueOf(limit))) {
            while (c.moveToNext()) {
                JSONObject p = new JSONObject();
                p.put("id", c.getString(c.getColumnIndexOrThrow("id")));
                p.put("lat", c.getDouble(c.getColumnIndexOrThrow("lat")));
                p.put("lng", c.getDouble(c.getColumnIndexOrThrow("lng")));
                putNullable(p, c, "acc", "accuracy");
                putNullable(p, c, "alt", "altitude");
                putNullable(p, c, "speed", "speed");
                putNullable(p, c, "heading", "heading");
                p.put("capturedAt", c.getString(c.getColumnIndexOrThrow("captured")));
                b.points.put(p);
                b.ids.add(p.getString("id"));
            }
        } catch (Exception ignored) { }
        return b;
    }

    private static void putNullable(JSONObject p, Cursor c, String col, String key) throws Exception {
        int i = c.getColumnIndexOrThrow(col);
        if (c.isNull(i)) p.put(key, JSONObject.NULL); else p.put(key, c.getDouble(i));
    }

    public synchronized void remove(List<String> ids) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (String id : ids) db.delete("points", "id = ?", new String[]{id});
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public synchronized void removeSession(String session) {
        getWritableDatabase().delete("points", "session = ?", new String[]{session});
    }

    public synchronized int count(String session) {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM points WHERE session = ?", new String[]{session})) {
            return c.moveToFirst() ? c.getInt(0) : 0;
        }
    }

    public synchronized int countAll() {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM points", null)) {
            return c.moveToFirst() ? c.getInt(0) : 0;
        }
    }

    public synchronized List<String> sessions() {
        List<String> out = new ArrayList<>();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT DISTINCT session FROM points", null)) {
            while (c.moveToNext()) out.add(c.getString(0));
        }
        return out;
    }

    public static class Batch {
        public final JSONArray points = new JSONArray();
        public final List<String> ids = new ArrayList<>();
    }
}
