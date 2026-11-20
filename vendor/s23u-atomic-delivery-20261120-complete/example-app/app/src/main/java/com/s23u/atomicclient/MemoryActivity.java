package com.s23u.atomicclient;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.text.InputFilter;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.DateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MemoryActivity extends Activity {
    private static final int BACKGROUND = Color.rgb(248, 250, 252);
    private static final int TEXT = Color.rgb(15, 23, 42);
    private static final int SECONDARY = Color.rgb(71, 85, 105);
    private static final int ACCENT = Color.rgb(29, 78, 216);

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Map<String, String> speakerNames = new HashMap<>();
    private final DateFormat dates = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT);
    private AtomicServiceBridge bridge;
    private TextView status;
    private TextView empty;
    private Button historyTab;
    private Button graphTab;
    private Button refresh;
    private Button filter;
    private Button more;
    private EditText searchBox;
    private LinearLayout searchRow;
    private LinearLayout results;
    private ScrollView scroll;
    private boolean showingGraph;
    private boolean connected;
    private int generation;
    private long beforeMs;
    private String beforeId = "";
    private String speaker = "";
    private String query = "";

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(createPage());
        bridge = new AtomicServiceBridge(this, new AtomicServiceBridge.Listener() {
            @Override public void onConnected(String serviceInfo) {
                runOnUiThread(() -> {
                    connected = true;
                    refresh.setEnabled(true);
                    load(false);
                });
            }

            @Override public void onDisconnected(String reason) {
                runOnUiThread(() -> {
                    connected = false;
                    generation++;
                    more.setEnabled(false);
                    status.setText("原子能力服务连接失败");
                    showEmpty(reason);
                });
            }
        });
        bridge.bind();
    }

    private View createPage() {
        LinearLayout root = column();
        root.setBackgroundColor(BACKGROUND);
        root.setFocusableInTouchMode(true);
        root.setPadding(dp(16), dp(8), dp(16), 0);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                root.setPadding(dp(16) + bars.left, dp(8) + bars.top,
                        dp(16) + bars.right, bars.bottom);
            } else {
                root.setPadding(dp(16), dp(8) + insets.getSystemWindowInsetTop(),
                        dp(16), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        Button back = button("返回", this::finish);
        toolbar.addView(back);
        TextView title = text("记忆库", 22, TEXT);
        title.setGravity(Gravity.CENTER);
        title.setTypeface(null, Typeface.BOLD);
        toolbar.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        refresh = button("刷新", () -> load(false));
        refresh.setEnabled(false);
        toolbar.addView(refresh);
        root.addView(toolbar);

        LinearLayout tabs = new LinearLayout(this);
        historyTab = button("历史对话", () -> selectTab(false));
        graphTab = button("社交图谱", () -> selectTab(true));
        tabs.addView(historyTab, new LinearLayout.LayoutParams(0, -2, 1));
        tabs.addView(graphTab, new LinearLayout.LayoutParams(0, -2, 1));
        root.addView(tabs);

        status = text("正在连接原子能力服务…", 13, SECONDARY);
        status.setPadding(dp(4), dp(7), dp(4), dp(7));
        root.addView(status);

        searchRow = new LinearLayout(this);
        searchRow.setGravity(Gravity.CENTER_VERTICAL);
        searchBox = new EditText(this);
        searchBox.setSingleLine(true);
        searchBox.setHint("搜索对话或回复");
        searchBox.setTextSize(16);
        searchBox.setFilters(new InputFilter[]{new InputFilter.LengthFilter(256)});
        searchBox.setImeOptions(EditorInfo.IME_ACTION_SEARCH);
        searchBox.setOnEditorActionListener((view, action, event) -> {
            if (action != EditorInfo.IME_ACTION_SEARCH) return false;
            submitQuery();
            return true;
        });
        searchRow.addView(searchBox, new LinearLayout.LayoutParams(0, dp(50), 1));
        searchRow.addView(button("搜索", this::submitQuery));
        searchRow.addView(button("清空", () -> {
            searchBox.setText("");
            submitQuery();
        }));
        root.addView(searchRow);

        filter = button("", () -> {
            speaker = "";
            updateControls();
            load(false);
        });
        root.addView(filter, new LinearLayout.LayoutParams(-1, -2));

        scroll = new ScrollView(this);
        scroll.setClipToPadding(false);
        scroll.setPadding(0, dp(4), 0, dp(14));
        LinearLayout body = column();
        empty = text("", 15, SECONDARY);
        empty.setPadding(dp(4), dp(12), dp(4), dp(12));
        body.addView(empty);
        results = column();
        body.addView(results);
        more = button("加载更早的对话", () -> load(true));
        more.setVisibility(View.GONE);
        body.addView(more, new LinearLayout.LayoutParams(-1, -2));
        scroll.addView(body);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        updateControls();
        showEmpty("");
        return root;
    }

    private void selectTab(boolean graph) {
        if (showingGraph == graph) return;
        showingGraph = graph;
        updateControls();
        load(false);
    }

    private void submitQuery() {
        query = searchBox.getText().toString().trim();
        InputMethodManager keyboard = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        keyboard.hideSoftInputFromWindow(searchBox.getWindowToken(), 0);
        searchBox.clearFocus();
        load(false);
    }

    private void updateControls() {
        historyTab.setSelected(!showingGraph);
        graphTab.setSelected(showingGraph);
        historyTab.setTextColor(showingGraph ? SECONDARY : ACCENT);
        graphTab.setTextColor(showingGraph ? ACCENT : SECONDARY);
        searchRow.setVisibility(showingGraph ? View.GONE : View.VISIBLE);
        filter.setVisibility(!showingGraph && !speaker.isEmpty() ? View.VISIBLE : View.GONE);
        filter.setText("联系人 · " + speakerName(speaker) + "   ×");
    }

    private void load(boolean append) {
        if (!connected) return;
        int request = ++generation;
        boolean graphTabOpen = showingGraph;
        String phrase = query;
        String person = speaker;
        long time = append ? beforeMs : 0;
        String id = append ? beforeId : "";
        more.setEnabled(false);
        if (!append) {
            results.removeAllViews();
            showEmpty("正在加载…");
            more.setVisibility(View.GONE);
            scroll.scrollTo(0, 0);
        }
        worker.execute(() -> {
            try {
                JSONObject data = graphTabOpen ? checked(bridge.memoryGraph())
                        : phrase.isEmpty() ? checked(bridge.memoryPage(time, id, person))
                        : checked(bridge.searchMemory(phrase, person));
                JSONObject graph = graphTabOpen ? data.getJSONObject("graph")
                        : append ? null : checked(bridge.memoryGraph()).getJSONObject("graph");
                JSONObject stats = checked(bridge.memoryStats());
                runOnUiThread(() -> {
                    if (request != generation || isDestroyed()) return;
                    if (graph != null) updateSpeakerNames(graph);
                    updateStatus(data, stats, graphTabOpen, phrase);
                    if (graphTabOpen) renderGraph(graph);
                    else renderHistory(data, append, phrase);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    if (request != generation || isDestroyed()) return;
                    status.setText("读取失败，可点击刷新重试");
                    showEmpty(error.getMessage() == null ? "无法读取本地记忆" : error.getMessage());
                    more.setEnabled(append);
                });
            }
        });
    }

    private static JSONObject checked(String raw) throws Exception {
        JSONObject response = new JSONObject(raw);
        if (!response.optBoolean("ok")) {
            throw new IllegalStateException(response.optString("error", "无法读取本地记忆"));
        }
        return response;
    }

    private void updateStatus(JSONObject data, JSONObject stats, boolean graph, String phrase) {
        String source = data.optString("backend");
        String label = switch (source) {
            case "postgresql" -> "本机 PostgreSQL";
            case "sqlite" -> stats.optBoolean("postgres_online")
                    ? "本机 SQLite · 正在同步" : "本机 SQLite · 离线模式";
            default -> "模拟数据";
        };
        if (!graph) {
            if (phrase.isEmpty()) {
                label += " · " + stats.optLong("entries") + " 条记录";
            } else {
                label += data.optBoolean("semantic") ? " · 关键词与语义搜索" : " · 关键词搜索";
            }
        }
        if (stats.optBoolean("capacity_warning")) label += " · 存储超过 1 GB";
        status.setText(label);
    }

    private void renderHistory(JSONObject data, boolean append, String phrase) {
        JSONArray rows = data.optJSONArray("items");
        if (!append) results.removeAllViews();
        if (rows == null || rows.length() == 0) {
            showEmpty(append ? "已到最早的记录" : phrase.isEmpty()
                    ? "暂无历史对话" : "未找到匹配的对话");
        } else {
            showEmpty("");
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.optJSONObject(i);
                if (row != null) addHistoryCard(row);
            }
        }
        beforeMs = data.optLong("before_ms");
        beforeId = data.optString("before_id");
        more.setVisibility(beforeMs > 0 ? View.VISIBLE : View.GONE);
        more.setEnabled(beforeMs > 0);
    }

    private void addHistoryCard(JSONObject row) {
        String speakerId = row.optString("speaker_id");
        String reply = row.optString("reply");
        LinearLayout card = card();
        card.addView(text((reply.isEmpty() ? "语音转写" : "助手回复")
                + " · " + speakerName(speakerId), 13, ACCENT));
        TextView timestamp = text(dates.format(new Date(row.optLong("occurred_at_ms"))), 12, SECONDARY);
        timestamp.setPadding(0, dp(3), 0, dp(8));
        card.addView(timestamp);
        TextView transcript = text(row.optString("text"), 16, TEXT);
        transcript.setTextIsSelectable(true);
        card.addView(transcript);
        if (!reply.isEmpty()) {
            TextView response = text(reply, 15, TEXT);
            response.setPadding(0, dp(9), 0, 0);
            response.setTextIsSelectable(true);
            card.addView(response);
        }
        addCard(card);
    }

    private void renderGraph(JSONObject graph) {
        results.removeAllViews();
        showEmpty("");
        SocialGraphView view = new SocialGraphView(this);
        view.setBackground(cardBackground());
        view.setContentDescription("以当前使用者为中心的社交关系图");
        view.setGraph(graph);
        results.addView(view, new LinearLayout.LayoutParams(-1, dp(300)));
        JSONArray nodes = graph.optJSONArray("nodes");
        if (nodes == null || nodes.length() == 0) return;

        TextView heading = text("联系人 · " + nodes.length(), 15, SECONDARY);
        heading.setPadding(dp(4), dp(16), 0, dp(6));
        results.addView(heading);
        for (int i = 0; i < nodes.length(); i++) {
            JSONObject node = nodes.optJSONObject(i);
            if (node == null) continue;
            String id = node.optString("id");
            LinearLayout card = card();
            card.addView(text(node.optString("name", id), 17, TEXT));
            card.addView(text(node.optString("relation", "联系人") + " · "
                    + node.optInt("interactions") + " 次互动", 14, SECONDARY));
            Button history = button("查看此联系人的对话", () -> {
                speaker = id;
                query = "";
                searchBox.setText("");
                selectTab(false);
            });
            card.addView(history);
            addCard(card);
        }
    }

    private void updateSpeakerNames(JSONObject graph) {
        speakerNames.clear();
        JSONObject center = graph.optJSONObject("center");
        if (center != null) {
            speakerNames.put(center.optString("id", "self"), center.optString("name", "当前使用者"));
        }
        JSONArray nodes = graph.optJSONArray("nodes");
        if (nodes != null) {
            for (int i = 0; i < nodes.length(); i++) {
                JSONObject node = nodes.optJSONObject(i);
                if (node != null) speakerNames.put(node.optString("id"), node.optString("name"));
            }
        }
        updateControls();
    }

    private String speakerName(String id) {
        if (id.isEmpty() || "unknown".equals(id)) return "未知说话人";
        return speakerNames.getOrDefault(id, "self".equals(id) ? "当前使用者" : id);
    }

    private void showEmpty(String message) {
        empty.setText(message);
        empty.setVisibility(message.isEmpty() ? View.GONE : View.VISIBLE);
    }

    private LinearLayout column() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        return view;
    }

    private LinearLayout card() {
        LinearLayout card = column();
        card.setPadding(dp(14), dp(12), dp(14), dp(12));
        card.setBackground(cardBackground());
        return card;
    }

    private GradientDrawable cardBackground() {
        GradientDrawable background = new GradientDrawable();
        background.setCornerRadius(dp(12));
        background.setColor(Color.WHITE);
        background.setStroke(dp(1), Color.rgb(226, 232, 240));
        return background;
    }

    private void addCard(LinearLayout card) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(8);
        results.addView(card, params);
    }

    private Button button(String title, Runnable action) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(title);
        button.setOnClickListener(view -> action.run());
        return button;
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override protected void onDestroy() {
        generation++;
        worker.shutdownNow();
        if (bridge != null) bridge.close();
        super.onDestroy();
    }
}
