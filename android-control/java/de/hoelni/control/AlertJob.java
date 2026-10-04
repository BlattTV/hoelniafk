package de.hoelni.control;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;

/**
 * Star alerts as phone notifications: about every 15 minutes (Android decides the exact time) the
 * app asks the active PC for its alerts of the last 24 hours and shows the new ones.
 */
public class AlertJob extends JobService {
  private static final int JOB_ID = 4711;
  private static final String CHANNEL = "stars";
  private static final String PREFS = "alerts";

  /** Called when the app starts; keeps running in the background (also after a reboot). */
  static void schedule(Context c) {
    JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
    if (js == null) return;
    for (JobInfo j : js.getAllPendingJobs()) if (j.getId() == JOB_ID) return;
    js.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(c, AlertJob.class))
        .setPeriodic(15 * 60 * 1000L)
        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
        .setPersisted(true)
        .build());
  }

  /** Right away (after "send test notification"). */
  static void checkSoon(final Context c) {
    final Context app = c.getApplicationContext();
    new Thread(new Runnable() {
      @Override
      public void run() {
        try {
          Thread.sleep(1500);
        } catch (InterruptedException ignored) {
          // check anyway
        }
        check(app);
      }
    }).start();
  }

  @Override
  public boolean onStartJob(final JobParameters params) {
    new Thread(new Runnable() {
      @Override
      public void run() {
        check(getApplicationContext());
        jobFinished(params, false);
      }
    }).start();
    return true;
  }

  @Override
  public boolean onStopJob(JobParameters params) {
    return false;
  }

  private static String iso(long t) {
    SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
    f.setTimeZone(TimeZone.getTimeZone("UTC"));
    return f.format(new Date(t));
  }

  static synchronized void check(Context ctx) {
    if (Store.token(ctx) == null) return;
    SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    // the first time: only alerts from now on (no flood of old ones)
    String since = p.getString("since", null);
    if (since == null) {
      since = iso(System.currentTimeMillis() - 60 * 1000L);
      p.edit().putString("since", since).commit();
    }
    Set<String> seen = new HashSet<String>(p.getStringSet("seen", new HashSet<String>()));
    try {
      JSONObject s = new JSONObject(Remote.pc(ctx, "GET", "/api/summary", null));
      JSONArray list = s.optJSONArray("starAlerts");
      if (list == null) return;
      Set<String> now = new HashSet<String>();
      for (int i = list.length() - 1; i >= 0; i--) {
        JSONObject a = list.getJSONObject(i);
        String id = a.optString("id");
        now.add(id);
        if (seen.contains(id) || a.optString("ts").compareTo(since) < 0) continue;
        notify(ctx, a);
      }
      // remember the ids that are still in the list (older ones drop out of it by themselves)
      p.edit().putStringSet("seen", now).commit();
    } catch (Exception ignored) {
      // no connection / no PC active – next time
    }
  }

  private static void notify(Context ctx, JSONObject a) {
    NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm == null) return;
    Notification.Builder b;
    if (Build.VERSION.SDK_INT >= 26) {
      if (nm.getNotificationChannel(CHANNEL) == null) {
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Stern-Warnungen", NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription("Wenn das Sterne-Verdienen eines Accounts ungewöhnlich ist");
        nm.createNotificationChannel(ch);
      }
      b = new Notification.Builder(ctx, CHANNEL);
    } else {
      b = new Notification.Builder(ctx);
    }
    String kind = a.optString("kind");
    String what = "stall".equals(kind) ? "Keine Sterne" : "spike".equals(kind) ? "Ungewöhnlich viele Sterne" : "drop".equals(kind) ? "Sterne verloren" : "Test";
    String server = a.optString("server");
    String title = "test".equals(kind) ? "Hoelni – Test" : a.optString("name") + (server.isEmpty() ? "" : " (" + server + ")") + " – " + what;
    String text = a.optString("textDe", a.optString("text"));
    b.setSmallIcon(R.drawable.ic_stat_star)
        .setColor(Color.parseColor("#F59E0B"))
        .setContentTitle(title)
        .setContentText(text)
        .setStyle(new Notification.BigTextStyle().bigText(text))
        .setAutoCancel(true)
        .setContentIntent(MainActivity.openIntent(ctx, "alerts"));
    nm.notify(a.optString("id").hashCode(), b.build());
  }
}
