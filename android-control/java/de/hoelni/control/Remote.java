package de.hoelni.control;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Requests for the active PC through the backend (/api/remote/rpc) – used by the widgets. */
final class Remote {
  private Remote() {}

  static final class Failure extends Exception {
    final int status;

    Failure(int status, String message) {
      super(message);
      this.status = status;
    }
  }

  /** Answer of the active PC (JSON text). */
  static String pc(Context c, String method, String path, JSONObject body) throws Exception {
    JSONObject req = new JSONObject();
    req.put("method", method);
    req.put("path", path);
    if (body != null) req.put("body", body);
    return post(c, "/api/remote/rpc", req.toString());
  }

  static String get(Context c, String path) throws Exception {
    return send(c, "GET", path, null);
  }

  private static String post(Context c, String path, String json) throws Exception {
    return send(c, "POST", path, json);
  }

  private static String send(Context c, String method, String path, String json) throws Exception {
    String base = Store.backend(c);
    String token = Store.token(c);
    if (base == null || token == null) throw new Failure(401, "Nicht angemeldet – App öffnen");
    HttpURLConnection con = (HttpURLConnection) new URL(base + path).openConnection();
    try {
      con.setConnectTimeout(8000);
      con.setReadTimeout(8000);
      con.setRequestMethod(method);
      con.setRequestProperty("Authorization", "Bearer " + token);
      con.setRequestProperty("Content-Type", "application/json");
      if (json != null) {
        con.setDoOutput(true);
        OutputStream out = con.getOutputStream();
        out.write(json.getBytes("UTF-8"));
        out.close();
      }
      int status = con.getResponseCode();
      InputStream in = status >= 400 ? con.getErrorStream() : con.getInputStream();
      String text = read(in);
      if (status >= 400) {
        String msg = "Fehler " + status;
        try {
          msg = new JSONObject(text).optString("error", msg);
        } catch (Exception ignored) {
          // not JSON
        }
        throw new Failure(status, msg);
      }
      return text;
    } finally {
      con.disconnect();
    }
  }

  private static String read(InputStream in) throws Exception {
    if (in == null) return "";
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    byte[] buf = new byte[8192];
    int n;
    while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
    in.close();
    return b.toString("UTF-8");
  }
}
