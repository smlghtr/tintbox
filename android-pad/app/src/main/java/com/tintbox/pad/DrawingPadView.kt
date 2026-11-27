package com.tintbox.pad

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.SystemClock
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Minimal near-zero-latency drawing pad surface with:
 * - Real-time nearest-neighbor live canvas mirror synced from Tintbox
 * - `requestUnbufferedDispatch(event)` + `event.historySize` high-frequency stylus/touch capture
 * - Pinch-to-zoom & 2-finger pan (accurately maps zoomed coordinates back to `[0..1]` doc space)
 * - 2-finger tap = Undo, 3-finger tap = Redo
 * - Stylus hover reticle, barrel/tail eraser auto-flag, and `PEN ONLY` palm rejection
 */
class DrawingPadView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    var onPacket: ((ByteArray) -> Unit)? = null
    var onTwoFingerTap: (() -> Unit)? = null
    var onThreeFingerTap: (() -> Unit)? = null
    var onZoomChanged: ((Float) -> Unit)? = null

    var stylusOnly: Boolean = false
        set(value) {
            field = value
            invalidate()
        }

    var isOnline: Boolean = false
        set(value) {
            field = value
            invalidate()
        }

    var showCanvasMirror: Boolean = true
        set(value) {
            field = value
            invalidate()
        }

    var showPixelGrid: Boolean = false
        set(value) {
            field = value
            invalidate()
        }

    private var docWidth = 64
    private var docHeight = 64
    private var seq = 1
    private var activePointerId = MotionEvent.INVALID_POINTER_ID

    // Live synced pixel-art bitmap
    private var canvasBitmap: Bitmap? = null

    // Base fitted rect & user zoom/pan transform
    private val baseRect = RectF()
    private val activeRect = RectF()
    private var padZoom = 1f
    private var padPanX = 0f
    private var padPanY = 0f

    // Multi-touch gesture tracking (pinch/pan + 2/3-finger tap)
    private var inMultiTouch = false
    private var maxTouchCount = 0
    private var multiDownTime = 0L
    private var multiStartDist = 0f
    private var multiStartMidX = 0f
    private var multiStartMidY = 0f
    private var multiStartZoom = 1f
    private var multiStartPanX = 0f
    private var multiStartPanY = 0f
    private var multiMoved = false

    private val density = resources.displayMetrics.density

    // Zero-allocation fixed ring buffer for subtle instant stroke feedback
    private val trailCap = 96
    private val trailX = FloatArray(trailCap)
    private val trailY = FloatArray(trailCap)
    private val trailBreak = BooleanArray(trailCap)
    private var trailHead = 0
    private var trailCount = 0

    private var hoverX = -1f
    private var hoverY = -1f
    private var hoverVisible = false

    private var hudText: String? = null
    private var hudUntilMs = 0L

    private val bgPaint = Paint().apply {
        color = Color.parseColor("#14130F")
        style = Paint.Style.FILL
    }
    private val padFillPaint = Paint().apply {
        color = Color.parseColor("#1B1A15")
        style = Paint.Style.FILL
    }
    private val checkerLightPaint = Paint().apply {
        color = Color.parseColor("#25231C")
        style = Paint.Style.FILL
    }
    private val checkerDarkPaint = Paint().apply {
        color = Color.parseColor("#1D1C16")
        style = Paint.Style.FILL
    }
    private val bitmapPaint = Paint().apply {
        isFilterBitmap = false
        isAntiAlias = false
        isDither = false
    }
    private val borderOfflinePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#343126")
        style = Paint.Style.STROKE
        strokeWidth = 1.5f * density
    }
    private val borderOnlinePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#C6F432")
        style = Paint.Style.STROKE
        strokeWidth = 1.5f * density
    }
    private val guidePaint = Paint().apply {
        color = Color.argb(30, 234, 229, 213)
        style = Paint.Style.STROKE
        strokeWidth = 1f * density
    }
    private val pixelGridPaint = Paint().apply {
        color = Color.argb(45, 234, 229, 213)
        style = Paint.Style.STROKE
        strokeWidth = 1f
    }
    private val tickPaint = Paint().apply {
        color = Color.argb(120, 198, 244, 50)
        style = Paint.Style.STROKE
        strokeWidth = 1.5f * density
    }
    private val trailPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(150, 198, 244, 50)
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeWidth = 2f * density
    }
    private val hoverPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#C6F432")
        style = Paint.Style.STROKE
        strokeWidth = 1.25f * density
    }
    private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(135, 154, 147, 128)
        textSize = 11f * density
        typeface = android.graphics.Typeface.MONOSPACE
    }
    private val hudBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(210, 20, 19, 15)
        style = Paint.Style.FILL
    }
    private val hudTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#C6F432")
        textSize = 13f * density
        typeface = android.graphics.Typeface.MONOSPACE
        textAlign = Paint.Align.CENTER
    }

    fun setDocAspect(w: Int, h: Int) {
        val changed = docWidth != max(1, w) || docHeight != max(1, h)
        docWidth = max(1, w)
        docHeight = max(1, h)
        if (changed) {
            updateActiveRect()
            invalidate()
        }
    }

    fun updateCanvasFrame(frame: DecodedFrame) {
        var bmp = canvasBitmap
        if (bmp == null || bmp.width != frame.width || bmp.height != frame.height) {
            bmp?.recycle()
            bmp = Bitmap.createBitmap(frame.width, frame.height, Bitmap.Config.ARGB_8888)
            canvasBitmap = bmp
        }
        bmp.setPixels(frame.pixels, 0, frame.width, 0, 0, frame.width, frame.height)
        invalidate()
    }

    fun resetZoom() {
        padZoom = 1f
        padPanX = 0f
        padPanY = 0f
        updateActiveRect()
        onZoomChanged?.invoke(padZoom)
        flashHud("FIT 100%")
    }

    fun flashHud(text: String) {
        hudText = text
        hudUntilMs = SystemClock.uptimeMillis() + 900L
        invalidate()
        postDelayed({ invalidate() }, 950L)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        updateActiveRect()
    }

    private fun updateActiveRect() {
        val pad = 14f * density
        val availW = max(1f, width - pad * 2f)
        val availH = max(1f, height - pad * 2f)
        val aspect = docWidth.toFloat() / docHeight.toFloat()

        val rectW: Float
        val rectH: Float
        if (availW / availH > aspect) {
            rectH = availH
            rectW = availH * aspect
        } else {
            rectW = availW
            rectH = availW / aspect
        }
        val left = (width - rectW) * 0.5f
        val top = (height - rectH) * 0.5f
        baseRect.set(left, top, left + rectW, top + rectH)

        val zw = rectW * padZoom
        val zh = rectH * padZoom
        val cx = width * 0.5f + padPanX
        val cy = height * 0.5f + padPanY
        activeRect.set(cx - zw * 0.5f, cy - zh * 0.5f, cx + zw * 0.5f, cy + zh * 0.5f)
    }

    private fun isAllowedPointer(event: MotionEvent, pointerIndex: Int): Boolean {
        if (!stylusOnly) return true
        val tool = event.getToolType(pointerIndex)
        return tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER
    }

    private fun buildFlags(event: MotionEvent, pointerIndex: Int, coalesced: Boolean): Int {
        var flags = 0
        val tool = event.getToolType(pointerIndex)
        if (tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER) {
            flags = flags or PadProtocol.FLAG_STYLUS
        }
        val barrelPressed =
            (event.buttonState and MotionEvent.BUTTON_STYLUS_PRIMARY) != 0 ||
                (event.buttonState and MotionEvent.BUTTON_SECONDARY) != 0
        if (tool == MotionEvent.TOOL_TYPE_ERASER || barrelPressed) {
            flags = flags or PadProtocol.FLAG_ERASER
        }
        if (coalesced) flags = flags or PadProtocol.FLAG_COALESCED
        return flags
    }

    private fun toNormX(x: Float): Float {
        if (activeRect.width() <= 0f) return 0f
        return ((x - activeRect.left) / activeRect.width()).coerceIn(0f, 1f)
    }

    private fun toNormY(y: Float): Float {
        if (activeRect.height() <= 0f) return 0f
        return ((y - activeRect.top) / activeRect.height()).coerceIn(0f, 1f)
    }

    private fun emitPoint(type: Int, flags: Int, x: Float, y: Float, pressure: Float) {
        onPacket?.invoke(
            PadProtocol.encodePointer(
                type = type,
                flags = flags,
                xNorm = toNormX(x),
                yNorm = toNormY(y),
                pressure = pressure,
                seq = seq++,
            ),
        )
    }

    private fun pushTrail(x: Float, y: Float, isBreak: Boolean) {
        trailX[trailHead] = x
        trailY[trailHead] = y
        trailBreak[trailHead] = isBreak
        trailHead = (trailHead + 1) % trailCap
        if (trailCount < trailCap) trailCount++
    }

    private fun cancelActiveStroke() {
        if (activePointerId != MotionEvent.INVALID_POINTER_ID) {
            emitPoint(PadProtocol.TYPE_CANCEL, 0, 0f, 0f, 0f)
            activePointerId = MotionEvent.INVALID_POINTER_ID
            trailCount = 0
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                inMultiTouch = false
                maxTouchCount = 1
                multiMoved = false
                if (!isAllowedPointer(event, 0)) {
                    // Still allow finger to start a 2-finger pinch/undo gesture even in PEN ONLY mode!
                    multiDownTime = SystemClock.uptimeMillis()
                    return true
                }
                requestUnbufferedDispatch(event)
                activePointerId = event.getPointerId(0)
                val x = event.x
                val y = event.y
                val flags = buildFlags(event, 0, coalesced = false)
                emitPoint(PadProtocol.TYPE_DOWN, flags, x, y, event.pressure)
                hoverVisible = false
                trailCount = 0
                pushTrail(x, y, isBreak = true)
                invalidate()
                return true
            }

            MotionEvent.ACTION_POINTER_DOWN -> {
                val count = event.pointerCount
                maxTouchCount = max(maxTouchCount, count)
                if (!inMultiTouch && count >= 2) {
                    // Cancel any accidental single-finger stroke that just started
                    cancelActiveStroke()
                    inMultiTouch = true
                    multiDownTime = SystemClock.uptimeMillis()
                    multiMoved = false
                    multiStartDist = hypot(
                        event.getX(1) - event.getX(0),
                        event.getY(1) - event.getY(0),
                    ).coerceAtLeast(1f)
                    multiStartMidX = (event.getX(0) + event.getX(1)) * 0.5f
                    multiStartMidY = (event.getY(0) + event.getY(1)) * 0.5f
                    multiStartZoom = padZoom
                    multiStartPanX = padPanX
                    multiStartPanY = padPanY
                    invalidate()
                }
                return true
            }

            MotionEvent.ACTION_MOVE -> {
                if (inMultiTouch) {
                    if (event.pointerCount >= 2) {
                        val dist = hypot(
                            event.getX(1) - event.getX(0),
                            event.getY(1) - event.getY(0),
                        ).coerceAtLeast(1f)
                        val midX = (event.getX(0) + event.getX(1)) * 0.5f
                        val midY = (event.getY(0) + event.getY(1)) * 0.5f
                        val moveDelta = hypot(midX - multiStartMidX, midY - multiStartMidY)
                        val distDelta = kotlin.math.abs(dist - multiStartDist)
                        if (moveDelta > 14f * density || distDelta > 14f * density) {
                            multiMoved = true
                        }
                        if (multiMoved) {
                            val newZoom = (multiStartZoom * (dist / multiStartDist)).coerceIn(1f, 12f)
                            val zoomRatio = newZoom / multiStartZoom
                            val cx = width * 0.5f
                            val cy = height * 0.5f
                            padZoom = newZoom
                            padPanX = (multiStartPanX + (multiStartMidX - cx) * (1f - zoomRatio)) + (midX - multiStartMidX)
                            padPanY = (multiStartPanY + (multiStartMidY - cy) * (1f - zoomRatio)) + (midY - multiStartMidY)
                            if (padZoom <= 1.02f) {
                                padZoom = 1f
                                padPanX = 0f
                                padPanY = 0f
                            }
                            updateActiveRect()
                            onZoomChanged?.invoke(padZoom)
                            invalidate()
                        }
                    }
                    return true
                }

                val idx = event.findPointerIndex(activePointerId)
                if (idx < 0 || !isAllowedPointer(event, idx)) return false
                val hist = event.historySize
                for (h in 0 until hist) {
                    val hx = event.getHistoricalX(idx, h)
                    val hy = event.getHistoricalY(idx, h)
                    val hp = event.getHistoricalPressure(idx, h)
                    emitPoint(PadProtocol.TYPE_MOVE, buildFlags(event, idx, coalesced = true), hx, hy, hp)
                    pushTrail(hx, hy, isBreak = false)
                }
                val x = event.getX(idx)
                val y = event.getY(idx)
                emitPoint(PadProtocol.TYPE_MOVE, buildFlags(event, idx, coalesced = false), x, y, event.getPressure(idx))
                pushTrail(x, y, isBreak = false)
                invalidate()
                return true
            }

            MotionEvent.ACTION_POINTER_UP -> {
                if (inMultiTouch) return true
                val idx = event.findPointerIndex(activePointerId)
                if (event.actionIndex != idx) return true
                if (idx >= 0) {
                    emitPoint(
                        PadProtocol.TYPE_UP,
                        buildFlags(event, idx, coalesced = false),
                        event.getX(idx),
                        event.getY(idx),
                        event.getPressure(idx),
                    )
                }
                activePointerId = MotionEvent.INVALID_POINTER_ID
                trailCount = 0
                invalidate()
                return true
            }

            MotionEvent.ACTION_UP -> {
                if (inMultiTouch) {
                    val elapsed = SystemClock.uptimeMillis() - multiDownTime
                    if (!multiMoved && elapsed < 280L) {
                        if (maxTouchCount == 2) {
                            flashHud("UNDO")
                            onTwoFingerTap?.invoke()
                        } else if (maxTouchCount >= 3) {
                            flashHud("REDO")
                            onThreeFingerTap?.invoke()
                        }
                    }
                    inMultiTouch = false
                    maxTouchCount = 0
                    return true
                }
                val idx = event.findPointerIndex(activePointerId)
                if (idx >= 0) {
                    emitPoint(
                        PadProtocol.TYPE_UP,
                        buildFlags(event, idx, coalesced = false),
                        event.getX(idx),
                        event.getY(idx),
                        event.getPressure(idx),
                    )
                }
                activePointerId = MotionEvent.INVALID_POINTER_ID
                trailCount = 0
                invalidate()
                return true
            }

            MotionEvent.ACTION_CANCEL -> {
                inMultiTouch = false
                cancelActiveStroke()
                invalidate()
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    override fun onHoverEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_HOVER_ENTER -> {
                requestUnbufferedDispatch(event)
                hoverVisible = true
                hoverX = event.x
                hoverY = event.y
                emitPoint(PadProtocol.TYPE_HOVER, buildFlags(event, 0, coalesced = false), hoverX, hoverY, 0f)
                invalidate()
                return true
            }
            MotionEvent.ACTION_HOVER_MOVE -> {
                hoverVisible = true
                hoverX = event.x
                hoverY = event.y
                emitPoint(PadProtocol.TYPE_HOVER, buildFlags(event, 0, coalesced = false), hoverX, hoverY, 0f)
                invalidate()
                return true
            }
            MotionEvent.ACTION_HOVER_EXIT -> {
                hoverVisible = false
                invalidate()
                return true
            }
        }
        return super.onHoverEvent(event)
    }

    override fun onDraw(canvas: Canvas) {
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bgPaint)

        val bmp = canvasBitmap
        if (showCanvasMirror && bmp != null && !bmp.isRecycled) {
            // Subtle pixel-art transparency checkerboard clipped to activeRect
            canvas.save()
            canvas.clipRect(activeRect)
            canvas.drawRect(activeRect, checkerDarkPaint)
            val cell = 12f * density
            val startX = activeRect.left
            val startY = activeRect.top
            var row = 0
            var y = startY
            while (y < activeRect.bottom) {
                var col = row and 1
                var x = startX + col * cell
                while (x < activeRect.right) {
                    canvas.drawRect(x, y, min(x + cell, activeRect.right), min(y + cell, activeRect.bottom), checkerLightPaint)
                    x += cell * 2f
                    col += 2
                }
                y += cell
                row++
            }
            // Crisp nearest-neighbor live Tintbox canvas
            canvas.drawBitmap(bmp, null, activeRect, bitmapPaint)

            // Optional pixel grid when cells are wide enough
            if (showPixelGrid) {
                val cellW = activeRect.width() / docWidth
                val cellH = activeRect.height() / docHeight
                if (cellW >= 5f * density && cellH >= 5f * density) {
                    for (gx in 1 until docWidth) {
                        val px = activeRect.left + gx * cellW
                        if (px >= 0f && px <= width) {
                            canvas.drawLine(px, activeRect.top, px, activeRect.bottom, pixelGridPaint)
                        }
                    }
                    for (gy in 1 until docHeight) {
                        val py = activeRect.top + gy * cellH
                        if (py >= 0f && py <= height) {
                            canvas.drawLine(activeRect.left, py, activeRect.right, py, pixelGridPaint)
                        }
                    }
                }
            }
            canvas.restore()
        } else {
            canvas.drawRect(activeRect, padFillPaint)
            val cx = activeRect.centerX()
            val cy = activeRect.centerY()
            canvas.drawLine(activeRect.left, cy, activeRect.right, cy, guidePaint)
            canvas.drawLine(cx, activeRect.top, cx, activeRect.bottom, guidePaint)
        }

        // Active frame border + crisp corner registration ticks
        canvas.drawRect(activeRect, if (isOnline) borderOnlinePaint else borderOfflinePaint)
        val tick = min(14f * density, activeRect.width() * 0.1f)
        val l = activeRect.left
        val t = activeRect.top
        val r = activeRect.right
        val b = activeRect.bottom
        canvas.drawLine(l, t, l + tick, t, tickPaint)
        canvas.drawLine(l, t, l, t + tick, tickPaint)
        canvas.drawLine(r, t, r - tick, t, tickPaint)
        canvas.drawLine(r, t, r, t + tick, tickPaint)
        canvas.drawLine(l, b, l + tick, b, tickPaint)
        canvas.drawLine(l, b, l, b - tick, tickPaint)
        canvas.drawLine(r, b, r - tick, b, tickPaint)
        canvas.drawLine(r, b, r, b - tick, tickPaint)

        // Subtle corner metadata
        val zoomPct = (padZoom * 100f).toInt()
        val meta = "${docWidth}x${docHeight} · ${zoomPct}%" + if (stylusOnly) " · PEN ONLY" else ""
        canvas.drawText(meta, max(10f * density, l + 8f * density), max(20f * density, t + 16f * density), labelPaint)

        // Faint live stroke ghost (extra light when canvas mirror is visible)
        if (trailCount > 1 && (!showCanvasMirror || bmp == null)) {
            val start = (trailHead - trailCount + trailCap) % trailCap
            var prevX = trailX[start]
            var prevY = trailY[start]
            for (i in 1 until trailCount) {
                val idx = (start + i) % trailCap
                val x = trailX[idx]
                val y = trailY[idx]
                if (!trailBreak[idx]) {
                    trailPaint.alpha = (35 + (i * 145) / trailCount).coerceIn(35, 180)
                    canvas.drawLine(prevX, prevY, x, y, trailPaint)
                }
                prevX = x
                prevY = y
            }
        }

        // Stylus hover reticle
        if (hoverVisible) {
            val rad = 7f * density
            canvas.drawCircle(hoverX, hoverY, rad, hoverPaint)
            canvas.drawLine(hoverX - rad - 3f, hoverY, hoverX + rad + 3f, hoverY, hoverPaint)
            canvas.drawLine(hoverX, hoverY - rad - 3f, hoverX, hoverY + rad + 3f, hoverPaint)
        }

        // Transient gesture HUD pill (UNDO / REDO / FIT)
        val msg = hudText
        if (msg != null && SystemClock.uptimeMillis() < hudUntilMs) {
            val padH = 14f * density
            val padV = 7f * density
            val tw = hudTextPaint.measureText(msg)
            val cx = width * 0.5f
            val cy = 32f * density
            canvas.drawRoundRect(
                cx - tw * 0.5f - padH,
                cy - 12f * density - padV,
                cx + tw * 0.5f + padH,
                cy + 4f * density + padV,
                6f * density,
                6f * density,
                hudBgPaint,
            )
            canvas.drawText(msg, cx, cy, hudTextPaint)
        }
    }
}
