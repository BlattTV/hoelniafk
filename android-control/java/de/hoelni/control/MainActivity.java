package de.hoelni.control;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.view.View;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Hoelni Control: the backend's control page (/app) in a WebView. The page signs in itself (the
 * backend issues a device token for this phone); the bridge below keeps that token for the widgets.
 */
public class MainActivity extends Activity {
  private static final String SETUP = "file:///android_asset/setup.html";
  private WebView web;
  /** The page shown is the configured backend (or the setup page) – only then the bridge works. */
  private volatile boolean trusted = false;

  static PendingIntent openIntent(Context ctx, String tab) {
    Intent i = new Intent(ctx, MainActivity.class);
    i.putExtra("tab", tab);
    i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    return PendingIntent.getActivity(ctx, tab.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().setStatusBarColor(Color.parseColor("#000000"));
    getWindow().setNavigationBarColor(Color.parseColor("#000000"));
    web = new WebView(this);
    web.setBackgroundColor(Color.parseColor("#000000"));
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setAllowFileAccess(true);
    web.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, String url) {
        if (isOurs(url)) return false;
        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        return true;
      }

      @Override
      public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
        trusted = isOurs(url);
      }
    });
    web.clearCache(true); // always the current control page from the backend
    web.addJavascriptInterface(new Bridge(), "HoelniControl");
    applyBars((getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES);
    setContentView(web);
    open(getIntent().getStringExtra("tab"));
    AlertJob.schedule(this);
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    String tab = intent.getStringExtra("tab");
    if (tab != null) open(tab);
  }

  private boolean isOurs(String url) {
    String b = Store.backend(this);
    return url != null && (url.startsWith(SETUP) || (b != null && (url.equals(b) || url.startsWith(b + "/"))));
  }

  private void open(String tab) {
    String b = Store.backend(this);
    if (b == null) web.loadUrl(SETUP);
    else web.loadUrl(b + "/app/" + (tab != null ? "?tab=" + Uri.encode(tab) : ""));
  }

  private static final String NOTIFY = "android.permission.POST_NOTIFICATIONS";

  private void applyBars(boolean dark) {
    int bg = dark ? Color.BLACK : Color.WHITE;
    getWindow().setStatusBarColor(bg);
    getWindow().setNavigationBarColor(bg);
    web.setBackgroundColor(bg);
    int flags = getWindow().getDecorView().getSystemUiVisibility();
    if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
    else flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
    if (Build.VERSION.SDK_INT >= 26) {
      if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
      else flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
    }
    getWindow().getDecorView().setSystemUiVisibility(flags);
  }

  @Override
  public void onConfigurationChanged(Configuration c) {
    super.onConfigurationChanged(c);
    // dark mode switched while the app is open: the page re-checks
    if (web != null) web.evaluateJavascript("window.dispatchEvent(new Event('hoelni-theme'))", null);
  }

  private boolean notificationsAllowed() {
    return Build.VERSION.SDK_INT < 33 || checkSelfPermission(NOTIFY) == PackageManager.PERMISSION_GRANTED;
  }

  private void askNotifications() {
    if (notificationsAllowed()) return;
    runOnUiThread(new Runnable() {
      @Override
      public void run() {
        requestPermissions(new String[] {NOTIFY}, 7);
      }
    });
  }

  @Override
  public void onBackPressed() {
    moveTaskToBack(true);
  }

  @Override
  public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
    if (code == 7 && results.length > 0 && results[0] != PackageManager.PERMISSION_GRANTED) {
      getSharedPreferences("alerts", MODE_PRIVATE).edit().putBoolean("denied", true).apply();
    }
  }

  /** window.HoelniControl in the page (only while the configured backend / the setup page is shown). */
  final class Bridge {
    @JavascriptInterface
    public void saveSession(String origin, String token, String user) {
      String b = Store.backend(MainActivity.this);
      if (!trusted || b == null || !b.equals(origin)) return;
      Store.setToken(MainActivity.this, token, user);
      refreshWidgets();
      // signed in: star alerts may now be shown as notifications (Android 13+ asks once)
      if (!getSharedPreferences("alerts", MODE_PRIVATE).getBoolean("asked", false)) {
        getSharedPreferences("alerts", MODE_PRIVATE).edit().putBoolean("asked", true).apply();
        askNotifications();
      }
    }

    @JavascriptInterface
    public void clearSession() {
      if (!trusted) return;
      Store.clear(MainActivity.this);
      refreshWidgets();
    }

    @JavascriptInterface
    public String deviceName() {
      String m = Build.MODEL == null ? "Android" : Build.MODEL;
      String brand = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
      if (!brand.isEmpty() && !m.toLowerCase().startsWith(brand.toLowerCase())) m = brand.substring(0, 1).toUpperCase() + brand.substring(1) + " " + m;
      return m;
    }

    @JavascriptInterface
    public void refreshWidgets() {
      StatusWidget.requestRefresh(MainActivity.this);
      ActionsWidget.show(MainActivity.this, null);
    }

    /** The page follows the phone's dark mode (WebView does not always report it to CSS). */
    @JavascriptInterface
    public boolean isDarkMode() {
      return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    /** Status and navigation bar in the colours of the page (light or dark). */
    @JavascriptInterface
    public void setTheme(final boolean dark) {
      runOnUiThread(new Runnable() {
        @Override
        public void run() {
          applyBars(dark);
        }
      });
    }

    @JavascriptInterface
    public boolean notificationsAllowed() {
      return MainActivity.this.notificationsAllowed();
    }

    @JavascriptInterface
    public void requestNotifications() {
      if (!trusted) return;
      if (Build.VERSION.SDK_INT >= 33 && !shouldShowRequestPermissionRationale(NOTIFY) && getSharedPreferences("alerts", MODE_PRIVATE).getBoolean("denied", false)) {
        // denied for good: only the system settings can turn it on
        Intent i = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS);
        i.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName());
        startActivity(i);
        return;
      }
      askNotifications();
    }

    @JavascriptInterface
    public void checkAlertsNow() {
      if (!trusted) return;
      AlertJob.checkSoon(MainActivity.this);
    }

    @JavascriptInterface
    public String backend() {
      String b = Store.backend(MainActivity.this);
      return b != null ? b : Store.DEFAULT_BACKEND;
    }

    @JavascriptInterface
    public void changeBackend() {
      if (!trusted) return;
      web.post(new Runnable() {
        @Override
        public void run() {
          web.loadUrl(SETUP);
        }
      });
    }

    /** From the setup page: the backend address (https://… – the app loads its control page). */
    @JavascriptInterface
    public String setBackend(String input) {
      if (!trusted) return "not allowed";
      String url = input == null ? "" : input.trim();
      if (url.isEmpty()) url = Store.DEFAULT_BACKEND;
      if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://" + url;
      while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
      Uri u = Uri.parse(url);
      if (u.getHost() == null || u.getHost().isEmpty() || (u.getPath() != null && !u.getPath().isEmpty())) return "Bitte nur die Adresse eingeben, z. B. afk.hoelni.de";
      final String target = u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
      Store.setBackend(MainActivity.this, target);
      refreshWidgets();
      web.post(new Runnable() {
        @Override
        public void run() {
          web.loadUrl(target + "/app/");
        }
      });
      return "";
    }
  }
}
