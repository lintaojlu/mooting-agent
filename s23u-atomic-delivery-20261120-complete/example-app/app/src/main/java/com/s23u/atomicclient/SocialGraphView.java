package com.s23u.atomicclient;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Lightweight code-native graph renderer for the App-private social store. */
public final class SocialGraphView extends View {
    private static final class Node {
        String id;
        String name;
        String relation;
        int interactions;
        float x;
        float y;
    }

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final List<Node> nodes = new ArrayList<>();
    private final ScaleGestureDetector scaleDetector;
    private String centerId = "self";
    private String centerName = "当前使用者";
    private String highlightedId = "";
    private float scale = 1f;
    private float panX;
    private float panY;
    private float lastX;
    private float lastY;
    private boolean dragging;

    public SocialGraphView(Context context) {
        super(context);
        paint.setTypeface(android.graphics.Typeface.create(
                android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD));
        scaleDetector = new ScaleGestureDetector(context,
                new ScaleGestureDetector.SimpleOnScaleGestureListener() {
                    @Override public boolean onScale(ScaleGestureDetector detector) {
                        scale = Math.max(0.65f, Math.min(2.2f,
                                scale * detector.getScaleFactor()));
                        invalidate();
                        return true;
                    }
                });
        setClickable(true);
    }

    public void setGraph(JSONObject snapshot) {
        nodes.clear();
        JSONObject center = snapshot.optJSONObject("center");
        if (center != null) {
            centerId = center.optString("id", "self");
            centerName = center.optString("name", "当前使用者");
        }
        JSONArray array = snapshot.optJSONArray("nodes");
        if (array != null) {
            for (int i = 0; i < array.length(); ++i) {
                JSONObject item = array.optJSONObject(i);
                if (item == null) continue;
                Node node = new Node();
                node.id = item.optString("id");
                node.name = item.optString("name", node.id);
                node.relation = item.optString("relation", "联系人");
                node.interactions = item.optInt("interactions");
                nodes.add(node);
            }
        }
        invalidate();
    }

    public void setHighlightedId(String id) {
        highlightedId = id == null ? "" : id;
        invalidate();
    }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float cx = getWidth() / 2f + panX;
        float cy = getHeight() / 2f + panY;
        canvas.save();
        canvas.scale(scale, scale, cx, cy);
        if (nodes.isEmpty()) {
            drawNode(canvas, cx, cy, centerName, true, centerId.equals(highlightedId));
            paint.setColor(Color.rgb(100, 116, 139));
            paint.setTextSize(13f * getResources().getDisplayMetrics().scaledDensity);
            paint.setTextAlign(Paint.Align.CENTER);
            canvas.drawText("暂无已确认联系人；先录入第二个人声纹",
                    cx, cy + dp(66), paint);
            canvas.restore();
            return;
        }
        float radius = Math.min(getWidth(), getHeight()) * 0.34f;
        for (int i = 0; i < nodes.size(); ++i) {
            double angle = -Math.PI / 2 + Math.PI * 2 * i / nodes.size();
            Node node = nodes.get(i);
            node.x = cx + (float) Math.cos(angle) * radius;
            node.y = cy + (float) Math.sin(angle) * radius;
            paint.setStrokeWidth(dp(node.id.equals(highlightedId) ? 4 : 2));
            paint.setColor(node.id.equals(highlightedId)
                    ? Color.rgb(245, 158, 11) : Color.rgb(148, 163, 184));
            canvas.drawLine(cx, cy, node.x, node.y, paint);
            paint.setTextAlign(Paint.Align.CENTER);
            paint.setTextSize(12f * getResources().getDisplayMetrics().scaledDensity);
            paint.setColor(Color.rgb(71, 85, 105));
            canvas.drawText(node.relation, (cx + node.x) / 2f,
                    (cy + node.y) / 2f - dp(4), paint);
            drawNode(canvas, node.x, node.y, node.name, false,
                    node.id.equals(highlightedId));
        }
        drawNode(canvas, cx, cy, centerName, true, centerId.equals(highlightedId));
        canvas.restore();
    }

    private void drawNode(Canvas canvas, float x, float y, String label,
                          boolean center, boolean highlighted) {
        float w = center ? dp(112) : dp(96);
        float h = center ? dp(58) : dp(50);
        RectF rect = new RectF(x - w / 2, y - h / 2, x + w / 2, y + h / 2);
        paint.setStyle(Paint.Style.FILL);
        paint.setColor(highlighted ? Color.rgb(254, 243, 199)
                : center ? Color.rgb(219, 234, 254) : Color.rgb(240, 253, 244));
        canvas.drawRoundRect(rect, dp(14), dp(14), paint);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(highlighted ? 3 : 2));
        paint.setColor(highlighted ? Color.rgb(245, 158, 11)
                : center ? Color.rgb(37, 99, 235) : Color.rgb(22, 163, 74));
        canvas.drawRoundRect(rect, dp(14), dp(14), paint);
        paint.setStyle(Paint.Style.FILL);
        paint.setTextAlign(Paint.Align.CENTER);
        paint.setTextSize(14f * getResources().getDisplayMetrics().scaledDensity);
        paint.setColor(Color.rgb(15, 23, 42));
        canvas.drawText(label, x, y + dp(5), paint);
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        scaleDetector.onTouchEvent(event);
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                lastX = event.getX();
                lastY = event.getY();
                dragging = false;
                return true;
            case MotionEvent.ACTION_MOVE:
                if (!scaleDetector.isInProgress()) {
                    float dx = event.getX() - lastX;
                    float dy = event.getY() - lastY;
                    if (Math.abs(dx) + Math.abs(dy) > dp(2)) dragging = true;
                    panX += dx;
                    panY += dy;
                    lastX = event.getX();
                    lastY = event.getY();
                    invalidate();
                }
                return true;
            case MotionEvent.ACTION_UP:
                if (!dragging) showNodeAt(event.getX(), event.getY());
                performClick();
                return true;
            default:
                return true;
        }
    }

    @Override public boolean performClick() {
        super.performClick();
        return true;
    }

    private void showNodeAt(float x, float y) {
        float cx = getWidth() / 2f + panX;
        float cy = getHeight() / 2f + panY;
        for (Node node : nodes) {
            float dx = (x - cx) / scale + cx - node.x;
            float dy = (y - cy) / scale + cy - node.y;
            if (dx * dx + dy * dy < dp(56) * dp(56)) {
                Toast.makeText(getContext(), node.name + " · " + node.relation
                        + " · 互动 " + node.interactions + " 次", Toast.LENGTH_SHORT).show();
                return;
            }
        }
    }

    private float dp(float value) {
        return value * getResources().getDisplayMetrics().density;
    }
}
