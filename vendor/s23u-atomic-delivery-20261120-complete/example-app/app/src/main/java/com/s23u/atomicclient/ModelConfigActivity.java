package com.s23u.atomicclient;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 模型配置页：为 ASR / VAD / LLM / VPR 四类能力分别选择要用的模型。
 *
 * <p>模型文件在服务的私有目录里，客户端碰不到，所以本页只负责"选"，
 * 真正的装载/释放由服务端的 {@code selectModel} 完成。
 */
public final class ModelConfigActivity extends Activity {

    private static final String[] CAPABILITIES = {"asr", "vad", "llm", "vpr"};
    private static final String[] TITLES = {
            "ASR 语音识别模型",
            "VAD 语音活动检测模型",
            "LLM 大语言模型",
            "VPR 声纹识别模型"};
    private static final String[] HINTS = {
            "必须是 SM8550 的 QNN context 目录（含 model.bin + tokens.txt）",
            "决定断句行为；换模型后阈值可能需重新调",
            "GGUF 文件；换更大的模型要先确认 HTP 显存",
            "不同模型的声纹向量不可互用，切换后需重新登记声纹"};

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private AtomicServiceBridge bridge;
    private LinearLayout listContainer;
    private TextView statusView;
    private JSONObject catalog;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(createContentView());
        bridge = new AtomicServiceBridge(this, new AtomicServiceBridge.Listener() {
            @Override public void onConnected(String serviceInfo) {
                runOnUiThread(() -> {
                    statusView.setText("状态：已连接原子能力服务");
                    refresh();
                });
            }

            @Override public void onDisconnected(String reason) {
                runOnUiThread(() -> statusView.setText("状态：服务未连接 · " + reason));
            }
        });
        bridge.bind();
    }

    private View createContentView() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(248, 250, 252));
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(20), dp(20), dp(32));
        scroll.addView(root);

        Button back = new Button(this);
        back.setText("← 返回主界面");
        back.setTextSize(15);
        back.setAllCaps(false);
        back.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        back.setOnClickListener(v -> finish());
        LinearLayout.LayoutParams backParams = new LinearLayout.LayoutParams(-1, dp(46));
        backParams.bottomMargin = dp(4);
        root.addView(back, backParams);

        TextView title = new TextView(this);
        title.setText("模型配置");
        title.setTextSize(22);
        title.setTextColor(Color.rgb(15, 23, 42));
        title.setGravity(Gravity.CENTER_HORIZONTAL);
        title.setTypeface(null, Typeface.BOLD);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(-1, -2);
        titleParams.bottomMargin = dp(8);
        root.addView(title, titleParams);

        TextView subtitle = new TextView(this);
        subtitle.setText("为每类能力选择要使用的模型。模型文件部署在服务私有目录，"
                + "本页只列出实际已存在的文件。");
        subtitle.setTextSize(13);
        subtitle.setTextColor(Color.rgb(71, 85, 105));
        subtitle.setGravity(Gravity.CENTER_HORIZONTAL);
        LinearLayout.LayoutParams subParams = new LinearLayout.LayoutParams(-1, -2);
        subParams.bottomMargin = dp(16);
        root.addView(subtitle, subParams);

        statusView = new TextView(this);
        statusView.setText("状态：正在连接原子能力服务……");
        statusView.setTextSize(14);
        statusView.setTextColor(Color.rgb(15, 23, 42));
        statusView.setPadding(dp(12), dp(10), dp(12), dp(10));
        statusView.setBackgroundColor(Color.WHITE);
        LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(-1, -2);
        statusParams.bottomMargin = dp(12);
        root.addView(statusView, statusParams);

        Button refreshButton = new Button(this);
        refreshButton.setText("刷新模型列表");
        refreshButton.setTextSize(15);
        refreshButton.setAllCaps(false);
        refreshButton.setOnClickListener(v -> refresh());
        LinearLayout.LayoutParams refreshParams = new LinearLayout.LayoutParams(-1, dp(50));
        refreshParams.bottomMargin = dp(14);
        root.addView(refreshButton, refreshParams);

        listContainer = new LinearLayout(this);
        listContainer.setOrientation(LinearLayout.VERTICAL);
        root.addView(listContainer, new LinearLayout.LayoutParams(-1, -2));

        return scroll;
    }

    // ---------------------------------------------------------------- 数据

    private void refresh() {
        if (bridge == null || !bridge.isConnected()) return;
        worker.execute(() -> {
            try {
                String raw = bridge.listModels();
                JSONObject parsed = new JSONObject(raw);
                if (!parsed.optBoolean("ok", false)) {
                    throw new IllegalStateException(parsed.optString("error", raw));
                }
                runOnUiThread(() -> render(parsed));
            } catch (Throwable error) {
                runOnUiThread(() -> statusView.setText("状态：读取模型列表失败 · " + error));
            }
        });
    }

    private void render(JSONObject parsed) {
        catalog = parsed;
        listContainer.removeAllViews();
        JSONObject active = parsed.optJSONObject("active");
        JSONObject models = parsed.optJSONObject("models");
        statusView.setText("状态：已连接，模型列表已更新");

        for (int i = 0; i < CAPABILITIES.length; i++) {
            String capability = CAPABILITIES[i];
            JSONArray items = models == null ? null : models.optJSONArray(capability);
            int count = items == null ? 0 : items.length();
            String activeId = active == null ? "" : active.optString(capability, "");
            String activeName = prettyName(activeId);

            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setPadding(dp(14), dp(14), dp(14), dp(14));
            card.setBackgroundColor(Color.WHITE);
            LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(-1, -2);
            cardParams.bottomMargin = dp(14);

            TextView heading = new TextView(this);
            heading.setText(TITLES[i]);
            heading.setTextSize(16);
            heading.setTextColor(Color.rgb(15, 23, 42));
            heading.setTypeface(null, Typeface.BOLD);
            card.addView(heading);

            TextView current = new TextView(this);
            current.setText("当前生效：" + activeName);
            current.setTextSize(14);
            current.setTextColor(Color.rgb(22, 101, 52));
            current.setPadding(0, dp(6), 0, 0);
            card.addView(current);

            TextView hint = new TextView(this);
            hint.setText(HINTS[i]);
            hint.setTextSize(12);
            hint.setTextColor(Color.rgb(100, 116, 139));
            hint.setPadding(0, dp(4), 0, dp(8));
            card.addView(hint);

            Button choose = new Button(this);
            choose.setText(count == 0
                    ? "选择模型（该能力下没有可用模型，请先部署）"
                    : "选择模型（可用 " + count + " 个）");
            choose.setTextSize(15);
            choose.setAllCaps(false);
            choose.setEnabled(count > 0);
            final String titleText = TITLES[i];
            choose.setOnClickListener(v -> showPicker(capability, titleText, items, activeId));
            card.addView(choose, new LinearLayout.LayoutParams(-1, dp(50)));

            listContainer.addView(card, cardParams);
        }
    }

    private void showPicker(String capability, String title, JSONArray items, String activeId) {
        if (items == null || items.length() == 0) {
            Toast.makeText(this, "该能力下没有可用模型", Toast.LENGTH_SHORT).show();
            return;
        }
        final List<String> ids = new ArrayList<>();
        final List<String> labels = new ArrayList<>();
        int checked = -1;
        for (int i = 0; i < items.length(); ++i) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            String id = item.optString("id");
            ids.add(id);
            labels.add(item.optString("name", id) + "  ·  " + humanBytes(item.optLong("bytes")));
            if (id.equals(activeId)) checked = ids.size() - 1;
        }
        if (ids.isEmpty()) {
            Toast.makeText(this, "该能力下没有可用模型", Toast.LENGTH_SHORT).show();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle(title)
                .setSingleChoiceItems(labels.toArray(new String[0]), checked,
                        (dialog, which) -> {
                            dialog.dismiss();
                            applySelection(capability, ids.get(which));
                        })
                .setNegativeButton("取消", null)
                .show();
    }

    private void applySelection(String capability, String modelId) {
        statusView.setText("状态：正在切换到 " + modelId + " ……");
        worker.execute(() -> {
            try {
                String raw = bridge.selectModel(capability, modelId);
                JSONObject parsed = new JSONObject(raw);
                if (!parsed.optBoolean("ok", false)) {
                    throw new IllegalStateException(parsed.optString("error", raw));
                }
                runOnUiThread(() -> {
                    Toast.makeText(this, "已切换：" + prettyName(modelId), Toast.LENGTH_SHORT).show();
                    refresh();
                });
            } catch (Throwable error) {
                runOnUiThread(() -> statusView.setText("状态：切换失败 · " + error));
            }
        });
    }

    // ---------------------------------------------------------------- 工具

    private static String prettyName(String id) {
        if (id == null || id.isEmpty()) return "（未设置）";
        int slash = id.lastIndexOf('/');
        return slash >= 0 ? id.substring(slash + 1) : id;
    }

    private static String humanBytes(long bytes) {
        if (bytes <= 0) return "0 B";
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024L * 1024L) return String.format(Locale.US, "%.1f KB", bytes / 1024.0);
        if (bytes < 1024L * 1024L * 1024L) {
            return String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0));
        }
        return String.format(Locale.US, "%.2f GB", bytes / (1024.0 * 1024.0 * 1024.0));
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override protected void onDestroy() {
        if (bridge != null) bridge.close();
        worker.shutdownNow();
        super.onDestroy();
    }
}
