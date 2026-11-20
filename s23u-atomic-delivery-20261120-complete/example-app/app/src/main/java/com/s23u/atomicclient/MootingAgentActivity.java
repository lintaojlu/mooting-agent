package com.s23u.atomicclient;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipInputStream;

public final class MootingAgentActivity extends Activity {
    private static final String COOKIE = "mooting_android";
    private static final int REQUEST_MICROPHONE = 141;
    private static final ScheduledExecutorService RUNTIME = Executors.newSingleThreadScheduledExecutor();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static volatile Session session;
    private static volatile String failure;
    private WebView web;
    private TextView status;
    private Button microphone;
    private Button memory;
    private LinearLayout container;
    private final Runnable update = this::updatePage;

    private record Session(String base, String cookie) {}

    private static native int runNode(String[] arguments);

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!started && Build.VERSION.SDK_INT >= 28) WebView.setDataDirectorySuffix("mooting");
        container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setFitsSystemWindows(true);
        container.setBackgroundColor(Color.rgb(248, 250, 252));
        LinearLayout header = new LinearLayout(this);
        Button back = new Button(this);
        back.setText("返回");
        back.setOnClickListener(view -> finish());
        header.addView(back);
        TextView title = new TextView(this);
        title.setText("MootingAgent");
        title.setTextSize(19);
        header.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        microphone = new Button(this);
        microphone.setText("授予麦克风权限");
        microphone.setOnClickListener(view -> requestPermissions(
                new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_MICROPHONE));
        header.addView(microphone);
        memory = new Button(this);
        memory.setText("记忆设置");
        memory.setVisibility(View.GONE);
        memory.setOnClickListener(view -> configureMemory());
        header.addView(memory);
        container.addView(header);
        status = new TextView(this);
        status.setText("正在启动端侧 Agent…");
        status.setPadding(24, 16, 24, 16);
        container.addView(status);
        setContentView(container);
        initialize();
    }

    private static boolean started;
    private static volatile boolean hasMemoryRuntime;
    private void initialize() {
        if (started) return;
        started = true;
        var context = getApplicationContext();
        RUNTIME.execute(() -> {
            try {
                File home = new File(context.getFilesDir(), "mooting");
                Files.createDirectories(home.toPath());
                File code = installCode(context, home);
                AtomicAgentHost host = new AtomicAgentHost(context);
                String secret = randomHex();
                File ready = new File(home, "ready.json");
                Files.deleteIfExists(ready.toPath());
                File configuration = new File(home, "session.json");
                JSONObject config = new JSONObject().put("socket", host.address()).put("secret", secret)
                        .put("home", home.getAbsolutePath()).put("ready", ready.getAbsolutePath());
                File python = new File(context.getApplicationInfo().nativeLibraryDir, "libmooting-python.so");
                File pythonHome = new File(code, "python");
                hasMemoryRuntime = python.isFile() && pythonHome.isDirectory();
                if (hasMemoryRuntime) {
                    config.put("python", python.getPath()).put("pythonHome", pythonHome.getPath());
                    config.put("socketDirectory", context.getCacheDir().getPath());
                }
                Files.write(configuration.toPath(), config.toString().getBytes(StandardCharsets.UTF_8));
                System.loadLibrary("mooting_node");
                Thread node = new Thread(() -> {
                    try {
                        int exit = runNode(new String[]{"node", new File(code, "src/android/main.mjs").getPath(),
                                configuration.getPath()});
                        failure = "端侧 Agent 已停止（" + exit + "）";
                    } catch (RuntimeException | LinkageError error) {
                        failure = "无法启动 Node：" + error.getMessage();
                    } finally {
                        session = null;
                        host.close();
                    }
                }, "MootingAgent-Node");
                node.start();
                RUNTIME.scheduleWithFixedDelay(() -> {
                    if (session != null || failure != null || !ready.isFile()) return;
                    try {
                        JSONObject state = new JSONObject(new String(Files.readAllBytes(ready.toPath()), StandardCharsets.UTF_8));
                        if (state.has("error")) failure = state.getString("error");
                        else {
                            int port = state.getInt("port");
                            if (port <= 0 || port > 65535) throw new IOException("端口无效");
                            session = new Session("http://127.0.0.1:" + port + "/" + secret + "/",
                                    COOKIE + "=" + secret + "; Path=/" + secret + "/; HttpOnly; SameSite=Strict");
                        }
                    } catch (Exception error) {
                        failure = "读取 Agent 状态失败：" + error.getMessage();
                    }
                }, 0, 250, TimeUnit.MILLISECONDS);
            } catch (Exception | LinkageError error) {
                failure = "无法启动 MootingAgent：" + error.getMessage();
            }
        });
    }

    private static File installCode(android.content.Context context, File home) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (var source = context.getAssets().open("mooting-agent.zip")) {
            byte[] buffer = new byte[65536];
            for (int count; (count = source.read(buffer)) != -1;) digest.update(buffer, 0, count);
        }
        StringBuilder revision = new StringBuilder();
        for (byte value : digest.digest()) revision.append(String.format(Locale.ROOT, "%02x", value & 255));
        File code = new File(home, "code-" + revision);
        File marker = new File(code, ".installed");
        if (marker.isFile()) return code;
        Files.createDirectories(code.toPath());
        try (ZipInputStream zip = new ZipInputStream(context.getAssets().open("mooting-agent.zip"))) {
            for (var entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) {
                var target = code.toPath().resolve(entry.getName()).normalize();
                if (!target.startsWith(code.toPath())) throw new IOException("资源路径无效");
                if (entry.isDirectory()) Files.createDirectories(target);
                else {
                    Files.createDirectories(target.getParent());
                    Files.copy(zip, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
            }
        }
        Files.createFile(marker.toPath());
        return code;
    }

    static String randomHex() {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        StringBuilder text = new StringBuilder();
        for (byte value : bytes) text.append(String.format(Locale.ROOT, "%02x", value & 255));
        return text.toString();
    }

    private void configureMemory() {
        EditText field = new EditText(this);
        field.setSingleLine(true);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        field.setHint("PostgreSQL 连接字符串");
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("Hindsight PostgreSQL")
                .setMessage("请输入 Termux 专用数据库的连接字符串。主机使用 127.0.0.1。")
                .setView(field).setNegativeButton("取消", null).setPositiveButton("保存", null).create();
        dialog.setOnShowListener(event -> {
            Button save = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
            save.setOnClickListener(view -> {
                String url = field.getText().toString().trim();
                try {
                    var uri = new java.net.URI(url);
                    String user = uri.getUserInfo();
                    if (!"postgresql".equals(uri.getScheme()) || !"127.0.0.1".equals(uri.getHost())
                            || user == null || user.indexOf(':') <= 0 || user.endsWith(":")
                            || uri.getPath() == null || uri.getPath().length() < 2
                            || uri.getRawQuery() != null || uri.getRawFragment() != null
                            || uri.getPort() == 0 || uri.getPort() > 65535) throw new IOException();
                } catch (Exception error) {
                    field.setError("需要本机数据库名、用户名和密码");
                    return;
                }
                save.setEnabled(false);
                File home = new File(getFilesDir(), "mooting");
                RUNTIME.execute(() -> {
                    try {
                        var temporary = new File(home, "postgres.json.tmp").toPath();
                        Files.write(temporary, new JSONObject().put("databaseUrl", url)
                                .toString().getBytes(StandardCharsets.UTF_8));
                        Files.move(temporary, new File(home, "postgres.json").toPath(),
                                java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                                java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                        MAIN.post(dialog::dismiss);
                    } catch (Exception error) {
                        MAIN.post(() -> {
                            field.setError("无法保存数据库设置");
                            save.setEnabled(true);
                        });
                    }
                });
            });
        });
        dialog.show();
        if (dialog.getWindow() != null) dialog.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
    }

    @Override protected void onStart() {
        super.onStart();
        updatePage();
    }

    private void updatePage() {
        Session current = session;
        memory.setVisibility(hasMemoryRuntime ? View.VISIBLE : View.GONE);
        microphone.setVisibility(checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED ? View.GONE : View.VISIBLE);
        if (failure != null) {
            status.setVisibility(View.VISIBLE);
            status.setText(failure);
            if (web != null) web.setVisibility(View.GONE);
            return;
        }
        if (current != null && web == null) openPage(current);
        AtomicAgentHost.setPageVisible(true);
        MAIN.postDelayed(update, 500);
    }

    private void openPage(Session current) {
        status.setVisibility(View.GONE);
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setSupportZoom(true);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                return !uri.toString().startsWith(current.base());
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                status.setVisibility(View.VISIBLE);
                status.setText("无法加载 Agent 页面：" + error.getDescription());
            }
        });
        container.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        CookieManager.getInstance().setCookie(current.base(), current.cookie(), accepted -> {
            if (web == null) return;
            if (accepted) web.loadUrl(current.base());
            else {
                status.setVisibility(View.VISIBLE);
                status.setText("无法建立 Agent 页面会话");
            }
        });
    }

    @Override protected void onStop() {
        MAIN.removeCallbacks(update);
        AtomicAgentHost.setPageVisible(false);
        super.onStop();
    }

    @Override protected void onDestroy() {
        if (web != null) {
            container.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
