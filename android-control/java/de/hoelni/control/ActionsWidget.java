package de.hoelni.control;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

/** Home-screen widget: all sessions online / offline / reconnect with one tap, open the app. */
public class ActionsWidget extends AppWidgetProvider {
  static final String ACTION_BULK = "de.hoelni.control.BULK";

  @Override
  public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
    show(ctx, null);
  }

  @Override
  public void onReceive(Context ctx, Intent intent) {
    if (ACTION_BULK.equals(intent.getAction())) {
      final String action = intent.getStringExtra("action");
      final Context app = ctx.getApplicationContext();
      final PendingResult pending = goAsync();
      show(app, "wird ausgeführt…");
      new Thread(new Runnable() {
        @Override
        public void run() {
          try {
            show(app, perform(app, action));
            StatusWidget.requestRefresh(app);
          } finally {
            pending.finish();
          }
        }
      }).start();
      return;
    }
    super.onReceive(ctx, intent);
  }

  private static String perform(Context ctx, String action) {
    try {
      // the action applies to every identity (like "Alle online" in the app)
      JSONArray rows = new JSONObject(Remote.pc(ctx, "GET", "/api/dashboard", null)).getJSONArray("rows");
      JSONArray ids = new JSONArray();
      for (int i = 0; i < rows.length(); i++) ids.put(rows.getJSONObject(i).getInt("id"));
      JSONObject body = new JSONObject();
      body.put("action", action);
      body.put("identityIds", ids);
      Remote.pc(ctx, "POST", "/api/bulk", body);
      if ("startSessions".equals(action)) return "Alle Sessions starten ✓";
      if ("stopSessions".equals(action)) return "Alle Sessions gestoppt ✓";
      return "Neu verbinden ✓";
    } catch (Remote.Failure f) {
      return f.status == 503 ? "Kein PC aktiv" : f.getMessage();
    } catch (Exception e) {
      return "Keine Verbindung";
    }
  }

  private static PendingIntent bulk(Context ctx, int code, String action) {
    Intent i = new Intent(ctx, ActionsWidget.class);
    i.setAction(ACTION_BULK);
    i.putExtra("action", action);
    return PendingIntent.getBroadcast(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  static void show(Context ctx, String message) {
    AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
    int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, ActionsWidget.class));
    if (ids.length == 0) return;
    RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_actions);
    v.setOnClickPendingIntent(R.id.a_on, bulk(ctx, 10, "startSessions"));
    v.setOnClickPendingIntent(R.id.a_off, bulk(ctx, 11, "stopSessions"));
    v.setOnClickPendingIntent(R.id.a_re, bulk(ctx, 12, "reconnect"));
    v.setOnClickPendingIntent(R.id.a_open, MainActivity.openIntent(ctx, "sessions"));
    v.setTextViewText(R.id.msg, message != null ? message : Store.token(ctx) == null ? "In der App anmelden" : "Hoelni Schnellaktionen");
    mgr.updateAppWidget(ids, v);
  }
}
