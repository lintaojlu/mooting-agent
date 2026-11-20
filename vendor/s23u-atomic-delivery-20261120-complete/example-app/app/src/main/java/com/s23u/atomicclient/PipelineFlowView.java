package com.s23u.atomicclient;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;

import java.util.LinkedHashMap;
import java.util.Map;

/** Non-blocking debug view fed only with small status/latency summaries. */
public final class PipelineFlowView extends View {
    private static final class State {
        String detail = "等待";
        double latencyMs;
        boolean ok;
    }

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Map<String, State> states = new LinkedHashMap<>();
    private final String[] names = {"麦克风", "VAD", "ASR", "VPR", "汇聚", "图谱", "LLM", "界面"};

    public PipelineFlowView(Context context) {
        super(context);
        reset();
    }

    public synchronized void reset() {
        states.clear();
        for (String name : names) states.put(name, new State());
        postInvalidate();
    }

    public synchronized void updateNode(String name, String detail,
                                        double latencyMs, boolean ok) {
        State state = states.get(name);
        if (state == null) return;
        state.detail = detail == null ? "" : detail;
        state.latencyMs = latencyMs;
        state.ok = ok;
        postInvalidate();
    }

    @Override protected synchronized void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float margin = dp(12);
        float gap = dp(8);
        float w = (getWidth() - margin * 2 - gap * 3) / 4f;
        float h = (getHeight() - margin * 2 - gap) / 2f;
        for (int i = 0; i < names.length; ++i) {
            int row = i / 4;
            int col = i % 4;
            float left = margin + col * (w + gap);
            float top = margin + row * (h + gap);
            if (i > 0) {
                int previousRow = (i - 1) / 4;
                if (previousRow == row) {
                    paint.setColor(Color.rgb(148, 163, 184));
                    paint.setStrokeWidth(dp(2));
                    canvas.drawLine(left - gap, top + h / 2, left,
                            top + h / 2, paint);
                }
            }
            State state = states.get(names[i]);
            RectF rect = new RectF(left, top, left + w, top + h);
            paint.setColor(state.ok ? Color.rgb(220, 252, 231)
                    : Color.rgb(241, 245, 249));
            canvas.drawRoundRect(rect, dp(9), dp(9), paint);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(dp(2));
            paint.setColor(state.ok ? Color.rgb(22, 163, 74)
                    : Color.rgb(148, 163, 184));
            canvas.drawRoundRect(rect, dp(9), dp(9), paint);
            paint.setStyle(Paint.Style.FILL);
            paint.setTextAlign(Paint.Align.CENTER);
            paint.setColor(Color.rgb(15, 23, 42));
            paint.setTextSize(13f * getResources().getDisplayMetrics().scaledDensity);
            paint.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
            canvas.drawText(names[i], left + w / 2, top + h * 0.38f, paint);
            paint.setTypeface(android.graphics.Typeface.DEFAULT);
            paint.setTextSize(10f * getResources().getDisplayMetrics().scaledDensity);
            paint.setColor(Color.rgb(71, 85, 105));
            String detail = state.detail;
            if (detail.length() > 12) detail = detail.substring(0, 12) + "…";
            canvas.drawText(detail, left + w / 2, top + h * 0.64f, paint);
            if (state.latencyMs > 0) {
                canvas.drawText(String.format(java.util.Locale.US, "%.1f ms", state.latencyMs),
                        left + w / 2, top + h * 0.84f, paint);
            }
        }
    }

    private float dp(float value) {
        return value * getResources().getDisplayMetrics().density;
    }
}
