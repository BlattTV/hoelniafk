package de.hoelni.control;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Home-screen widget: sessions online, the active PC and the first sessions with their state. */
public class StatusWidget extends AppWidgetProvider {
  static final String ACTION_REFRESH = "de.hoelni.control.REFRESH_STATUS";
  private static final int[] ROWS = {R.id.s1, R.id.s2, R.id.s3, R.id.s4};

  @Override
  public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
    refreshAsync(ctx, goAsync());
  }

  @Override
  public void onReceive(Context ctx, Intent intent) {
    if (ACTION_REFRESH.equals(intent.getAction())) {
      refreshAsync(ctx, goAsync());
      return;
    }
    super.onReceive(ctx, intent);
  }

  /** Called by the app and the quick-action widget after a change. */
  static void requestRefresh(Context ctx) {
    Intent i = new Intent(ctx, StatusWidget.class);
    i.setAction(ACTION_REFRESH);
    ctx.sendBroadcast(i);
  }

  private static void refreshAsync(final Context ctx, final PendingResult pending) {
    final Context app = ctx.getApplicationContext();
    new Thread(new Runnable() {
      @Override
      public void run() {
        try {
          render(app);
        } finally {
          if (pending != null) pending.finish();
        }
      }
    }).start();
  }

  static void render(Context ctx) {
    AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
    int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, StatusWidget.class));
    if (ids.length == 0) return;
    RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_status);
    v.setOnClickPendingIntent(R.id.root, MainActivity.openIntent(ctx, "home"));
    Intent r = new Intent(ctx, StatusWidget.class);
    r.setAction(ACTION_REFRESH);
    v.setOnClickPendingIntent(R.id.refresh, PendingIntent.getBroadcast(ctx, 1, r, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
    for (int row : ROWS) v.setTextViewText(row, "");
    String time = new SimpleDateFormat("HH:mm", Locale.GERMANY).format(new Date());
    try {
      JSONObject s = new JSONObject(Remote.pc(ctx, "GET", "/api/summary", null));
      JSONObject sessions = s.getJSONObject("sessions");
      v.setTextViewText(R.id.big, sessions.optInt("online") + "/" + sessions.optInt("wanted"));
      int problems = sessions.optInt("problems");
      v.setTextViewText(R.id.label, problems > 0 ? "online · " + problems + " mit Problemen" : "Sessions online");
      v.setTextViewText(R.id.pc, s.optString("pc", "Hoelni") + " · " + s.optInt("stars") + " ★");
      JSONArray list = sessions.optJSONArray("list");
      for (int i = 0; list != null && i < Math.min(ROWS.length, list.length()); i++) {
        JSONObject x = list.getJSONObject(i);
        v.setTextViewText(ROWS[i], row(x.optString("name"), x.optString("server"), x.optString("state")));
      }
      v.setTextViewText(R.id.updated, "aktualisiert " + time);
    } catch (Remote.Failure f) {
      v.setTextViewText(R.id.big, "–");
      v.setTextViewText(R.id.label, f.status == 503 ? "kein PC aktiv" : f.getMessage());
      v.setTextViewText(R.id.updated, time + (f.status == 401 ? " · in der App anmelden" : ""));
    } catch (Exception e) {
      v.setTextViewText(R.id.big, "–");
      v.setTextViewText(R.id.label, "keine Verbindung");
      v.setTextViewText(R.id.updated, time);
    }
    mgr.updateAppWidget(ids, v);
  }

  private static CharSequence row(String name, String server, String state) {
    int color;
    String text;
    if ("ONLINE".equals(state)) {
      color = Color.parseColor("#22C55E");
      text = "online";
    } else if ("BLOCKED".equals(state)) {
      color = Color.parseColor("#EF4444");
      text = "blockiert";
    } else if ("RECONNECTING".equals(state)) {
      color = Color.parseColor("#F59E0B");
      text = "verbindet neu";
    } else if ("STOPPED".equals(state)) {
      color = Color.parseColor("#64748B");
      text = "offline";
    } else {
      color = Color.parseColor("#3B82F6");
      text = "verbindet";
    }
    SpannableStringBuilder b = new SpannableStringBuilder();
    b.append("● ");
    b.setSpan(new ForegroundColorSpan(color), 0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    b.append(name).append("  ");
    int start = b.length();
    b.append(server).append(" · ").append(text);
    b.setSpan(new ForegroundColorSpan(Color.parseColor("#8EA0BD")), start, b.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    return b;
  }
}
