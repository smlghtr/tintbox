package com.tintbox.pad

import org.json.JSONObject

/**
 * 12-byte little-endian binary packet layout matching Tintbox (`src/io/pad-client.ts`) verbatim:
 *   byte  0     : msgType  (1=DOWN, 2=MOVE, 3=UP, 4=HOVER, 5=CANCEL, 6=CMD, 7=PING, 8=PONG, 9=FRAME_SYNC)
 *   byte  1     : flags    (bit0=stylus, bit1=eraser/barrel, bit2=secondary, bit3=coalesced)
 *   bytes 2..3  : xNorm    (uint16 LE, 0..65535 -> 0..1; or cmdId when msgType=CMD)
 *   bytes 4..5  : yNorm    (uint16 LE, 0..65535 -> 0..1; or cmdArg when msgType=CMD)
 *   bytes 6..7  : pressure (uint16 LE, 0..65535 -> 0..1)
 *   bytes 8..11 : seq      (uint32 LE)
 */
object PadProtocol {
    const val PACKET_BYTES = 12
    const val BT_HEADER_0: Byte = 0xAA.toByte()
    const val BT_HEADER_1: Byte = 0x55.toByte()

    const val TYPE_DOWN = 1
    const val TYPE_MOVE = 2
    const val TYPE_UP = 3
    const val TYPE_HOVER = 4
    const val TYPE_CANCEL = 5
    const val TYPE_CMD = 6
    const val TYPE_PING = 7
    const val TYPE_PONG = 8
    const val TYPE_FRAME_SYNC = 9

    const val FLAG_STYLUS = 1 shl 0
    const val FLAG_ERASER = 1 shl 1
    const val FLAG_SECONDARY = 1 shl 2
    const val FLAG_COALESCED = 1 shl 3

    const val CMD_UNDO = 1
    const val CMD_REDO = 2
    const val CMD_TOOL_PEN = 3
    const val CMD_TOOL_ERASER = 4
    const val CMD_TOOL_PICKER = 5
    const val CMD_SWAP_COLORS = 6
    const val CMD_BRUSH_DEC = 7
    const val CMD_BRUSH_INC = 8
    const val CMD_TOOL_FILL = 9
    const val CMD_TOOL_LINE = 10
    const val CMD_TOGGLE_GRID = 11
    const val CMD_TOGGLE_SYM_X = 12
    const val CMD_TOGGLE_ONION = 13
    const val CMD_PREV_FRAME = 14
    const val CMD_NEXT_FRAME = 15
    const val CMD_SELECT_PALETTE = 16

    fun encodePointer(
        type: Int,
        flags: Int,
        xNorm: Float,
        yNorm: Float,
        pressure: Float,
        seq: Int,
    ): ByteArray {
        val out = ByteArray(PACKET_BYTES)
        val x = (xNorm.coerceIn(0f, 1f) * 65535f + 0.5f).toInt()
        val y = (yNorm.coerceIn(0f, 1f) * 65535f + 0.5f).toInt()
        val p = (pressure.coerceIn(0f, 1f) * 65535f + 0.5f).toInt()
        out[0] = (type and 0xFF).toByte()
        out[1] = (flags and 0xFF).toByte()
        out[2] = (x and 0xFF).toByte()
        out[3] = ((x ushr 8) and 0xFF).toByte()
        out[4] = (y and 0xFF).toByte()
        out[5] = ((y ushr 8) and 0xFF).toByte()
        out[6] = (p and 0xFF).toByte()
        out[7] = ((p ushr 8) and 0xFF).toByte()
        out[8] = (seq and 0xFF).toByte()
        out[9] = ((seq ushr 8) and 0xFF).toByte()
        out[10] = ((seq ushr 16) and 0xFF).toByte()
        out[11] = ((seq ushr 24) and 0xFF).toByte()
        return out
    }

    fun encodeCmd(cmdId: Int, seq: Int, arg: Int = 0): ByteArray {
        val out = ByteArray(PACKET_BYTES)
        out[0] = TYPE_CMD.toByte()
        out[1] = 0
        out[2] = (cmdId and 0xFF).toByte()
        out[3] = ((cmdId ushr 8) and 0xFF).toByte()
        out[4] = (arg and 0xFF).toByte()
        out[5] = ((arg ushr 8) and 0xFF).toByte()
        out[8] = (seq and 0xFF).toByte()
        out[9] = ((seq ushr 8) and 0xFF).toByte()
        out[10] = ((seq ushr 16) and 0xFF).toByte()
        out[11] = ((seq ushr 24) and 0xFF).toByte()
        return out
    }

    fun encodePingPong(type: Int, seq: Int): ByteArray {
        val out = ByteArray(PACKET_BYTES)
        out[0] = (type and 0xFF).toByte()
        out[8] = (seq and 0xFF).toByte()
        out[9] = ((seq ushr 8) and 0xFF).toByte()
        out[10] = ((seq ushr 16) and 0xFF).toByte()
        out[11] = ((seq ushr 24) and 0xFF).toByte()
        return out
    }

    fun readType(pkt: ByteArray): Int = if (pkt.isNotEmpty()) pkt[0].toInt() and 0xFF else 0

    fun readSeq(pkt: ByteArray): Int {
        if (pkt.size < PACKET_BYTES) return 0
        return (pkt[8].toInt() and 0xFF) or
            ((pkt[9].toInt() and 0xFF) shl 8) or
            ((pkt[10].toInt() and 0xFF) shl 16) or
            ((pkt[11].toInt() and 0xFF) shl 24)
    }

    fun parseDocSync(jsonText: String): PadDocInfo? {
        return try {
            val obj = JSONObject(jsonText)
            if (obj.optString("type") != "doc") return null
            val w = obj.optInt("w", 64).coerceAtLeast(1)
            val h = obj.optInt("h", 64).coerceAtLeast(1)
            val tool = obj.optString("tool", "pencil")
            val hex = obj.optString("primaryHex", "#c6f432")
            val brush = obj.optInt("brushSize", 1).coerceAtLeast(1)
            val frame = obj.optInt("frame", 0).coerceAtLeast(0)
            val frameCount = obj.optInt("frameCount", 1).coerceAtLeast(1)
            val palArr = obj.optJSONArray("palette")
            val palette = ArrayList<String>(palArr?.length() ?: 0)
            if (palArr != null) {
                for (i in 0 until palArr.length()) {
                    val c = palArr.optString(i)
                    if (c.isNotEmpty()) palette.add(c)
                }
            }
            PadDocInfo(w, h, tool, hex, brush, frame, frameCount, palette)
        } catch (_: Exception) {
            null
        }
    }

    /** Decode raw or RLE FrameSync packet into packed ARGB_8888 IntArray for Bitmap.setPixels. */
    fun decodeFrameSync(buf: ByteArray): DecodedFrame? {
        if (buf.size < 6 || (buf[0].toInt() and 0xFF) != TYPE_FRAME_SYNC) return null
        val enc = buf[1].toInt() and 0xFF
        val w = (buf[2].toInt() and 0xFF) or ((buf[3].toInt() and 0xFF) shl 8)
        val h = (buf[4].toInt() and 0xFF) or ((buf[5].toInt() and 0xFF) shl 8)
        if (w <= 0 || h <= 0 || w > 1024 || h > 1024) return null
        val total = w * h
        val pixels = IntArray(total)

        if (enc == 0) {
            if (buf.size < 6 + total * 4) return null
            var rp = 6
            for (i in 0 until total) {
                val r = buf[rp++].toInt() and 0xFF
                val g = buf[rp++].toInt() and 0xFF
                val b = buf[rp++].toInt() and 0xFF
                val a = buf[rp++].toInt() and 0xFF
                pixels[i] = (a shl 24) or (r shl 16) or (g shl 8) or b
            }
            return DecodedFrame(w, h, pixels)
        }
        if (enc == 1) {
            var rp = 6
            var px = 0
            while (rp + 4 < buf.size && px < total) {
                val count = buf[rp++].toInt() and 0xFF
                val r = buf[rp++].toInt() and 0xFF
                val g = buf[rp++].toInt() and 0xFF
                val b = buf[rp++].toInt() and 0xFF
                val a = buf[rp++].toInt() and 0xFF
                val argb = (a shl 24) or (r shl 16) or (g shl 8) or b
                val end = minOf(total, px + count)
                while (px < end) {
                    pixels[px++] = argb
                }
            }
            return DecodedFrame(w, h, pixels)
        }
        return null
    }
}

data class PadDocInfo(
    val width: Int,
    val height: Int,
    val tool: String,
    val primaryHex: String,
    val brushSize: Int = 1,
    val frame: Int = 0,
    val frameCount: Int = 1,
    val palette: List<String> = emptyList(),
)

class DecodedFrame(
    val width: Int,
    val height: Int,
    val pixels: IntArray,
)
