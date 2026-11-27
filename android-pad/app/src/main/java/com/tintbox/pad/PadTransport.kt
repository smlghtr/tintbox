package com.tintbox.pad

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.os.Process
import android.util.Base64
import java.io.BufferedInputStream
import java.io.DataInputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

enum class TransportMode(val key: String, val badge: String) {
    USB("usb", "USB"),
    WIFI("wifi", "WI-FI"),
    BLUETOOTH("bt", "BT"),
    ;

    companion object {
        fun fromKey(k: String?): TransportMode = entries.firstOrNull { it.key == k } ?: USB
    }
}

enum class ConnectionState {
    OFFLINE,
    CONNECTING,
    ONLINE,
    ERROR,
}

interface PadTransportListener {
    fun onStateChanged(state: ConnectionState, detail: String)
    fun onRttUpdated(rttMs: Int)
    fun onDocSync(doc: PadDocInfo)
    fun onFrameSync(frame: DecodedFrame)
}

interface PadTransport {
    fun connect()
    fun send(packet: ByteArray)
    fun disconnect()
    fun isConnected(): Boolean
}

/**
 * Raw-socket RFC 6455 WebSocket client tuned for near-zero latency:
 * - TCP_NODELAY + IPTOS_LOWDELAY (no Nagle buffering)
 * - Dedicated urgent-priority writer thread with bounded queue
 * - Drops stale MOVE/HOVER packets on transient congestion instead of queuing lag
 * - Receives live RLE canvas frames + doc/palette sync from Tintbox
 */
class WsPadTransport(
    private val host: String,
    private val port: Int,
    private val listener: PadTransportListener,
) : PadTransport {

    private val running = AtomicBoolean(false)
    private val connected = AtomicBoolean(false)
    private val queue = ArrayBlockingQueue<ByteArray>(256)
    private val pingSeq = AtomicInteger(1)

    @Volatile private var socket: Socket? = null
    @Volatile private var lastPingSeq = 0
    @Volatile private var lastPingNs = 0L

    private var writerThread: Thread? = null
    private var readerThread: Thread? = null
    private var pingThread: Thread? = null

    override fun isConnected(): Boolean = connected.get()

    override fun connect() {
        if (!running.compareAndSet(false, true)) return
        listener.onStateChanged(ConnectionState.CONNECTING, "Connecting to $host:$port…")

        val t = Thread({
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_DISPLAY)
            try {
                val sock = Socket()
                sock.tcpNoDelay = true
                runCatching { sock.trafficClass = 0x10 }
                sock.connect(InetSocketAddress(host, port), 3500)
                socket = sock

                val out = sock.getOutputStream()
                val inp = DataInputStream(BufferedInputStream(sock.getInputStream(), 16384))

                performHandshake(out, inp)
                connected.set(true)
                listener.onStateChanged(ConnectionState.ONLINE, "$host:$port")

                startReader(inp)
                startPinger()
                runWriterLoop(out)
            } catch (e: Exception) {
                if (running.get()) {
                    listener.onStateChanged(
                        ConnectionState.ERROR,
                        e.message?.take(64) ?: "Connection failed",
                    )
                }
            } finally {
                cleanup(notifyOffline = running.getAndSet(false) && !connected.get())
            }
        }, "TintboxWsWriter")
        t.isDaemon = true
        writerThread = t
        t.start()
    }

    override fun send(packet: ByteArray) {
        if (!connected.get()) return
        if (!queue.offer(packet)) {
            val type = PadProtocol.readType(packet)
            if (type == PadProtocol.TYPE_MOVE || type == PadProtocol.TYPE_HOVER) {
                return
            }
            queue.poll()
            queue.offer(packet)
        }
    }

    override fun disconnect() {
        running.set(false)
        cleanup(notifyOffline = true)
    }

    private fun performHandshake(out: OutputStream, inp: DataInputStream) {
        val keyBytes = ByteArray(16)
        SecureRandom().nextBytes(keyBytes)
        val secKey = Base64.encodeToString(keyBytes, Base64.NO_WRAP)
        val req = buildString {
            append("GET /?role=pad HTTP/1.1\r\n")
            append("Host: ").append(host).append(':').append(port).append("\r\n")
            append("Upgrade: websocket\r\n")
            append("Connection: Upgrade\r\n")
            append("Sec-WebSocket-Key: ").append(secKey).append("\r\n")
            append("Sec-WebSocket-Version: 13\r\n\r\n")
        }
        out.write(req.toByteArray(Charsets.US_ASCII))
        out.flush()

        val headerBuf = StringBuilder(256)
        var crlfState = 0
        while (headerBuf.length < 4096) {
            val b = inp.read()
            if (b < 0) throw IllegalStateException("Bridge closed during handshake")
            val ch = b.toChar()
            headerBuf.append(ch)
            crlfState = when {
                crlfState == 0 && ch == '\r' -> 1
                crlfState == 1 && ch == '\n' -> 2
                crlfState == 2 && ch == '\r' -> 3
                crlfState == 3 && ch == '\n' -> 4
                ch == '\r' -> 1
                else -> 0
            }
            if (crlfState == 4) break
        }
        val statusLine = headerBuf.lineSequence().firstOrNull().orEmpty()
        if (!statusLine.contains("101")) {
            throw IllegalStateException("Unexpected bridge reply: $statusLine")
        }
    }

    private fun runWriterLoop(out: OutputStream) {
        var maskState = SecureRandom().nextInt().let { if (it == 0) 0x5A17C3D1 else it }
        val frame = ByteArray(6 + PadProtocol.PACKET_BYTES)
        while (running.get()) {
            val pkt = try {
                queue.take()
            } catch (_: InterruptedException) {
                break
            }
            if (!running.get()) break

            maskState = maskState xor (maskState shl 13)
            maskState = maskState xor (maskState ushr 17)
            maskState = maskState xor (maskState shl 5)
            val m0 = (maskState and 0xFF).toByte()
            val m1 = ((maskState ushr 8) and 0xFF).toByte()
            val m2 = ((maskState ushr 16) and 0xFF).toByte()
            val m3 = ((maskState ushr 24) and 0xFF).toByte()

            val len = pkt.size
            if (len == PadProtocol.PACKET_BYTES) {
                frame[0] = 0x82.toByte()
                frame[1] = (0x80 or len).toByte()
                frame[2] = m0
                frame[3] = m1
                frame[4] = m2
                frame[5] = m3
                for (i in 0 until len) {
                    val m = when (i and 3) {
                        0 -> m0
                        1 -> m1
                        2 -> m2
                        else -> m3
                    }
                    frame[6 + i] = (pkt[i].toInt() xor m.toInt()).toByte()
                }
                out.write(frame)
            } else {
                writeMaskedFrame(out, 0x82, pkt, maskState)
            }
            out.flush()
        }
    }

    private fun writeMaskedFrame(out: OutputStream, firstByte: Int, payload: ByteArray, mask: Int) {
        val len = payload.size
        val header = when {
            len < 126 -> byteArrayOf(firstByte.toByte(), (0x80 or len).toByte())
            else -> byteArrayOf(
                firstByte.toByte(),
                (0x80 or 126).toByte(),
                ((len ushr 8) and 0xFF).toByte(),
                (len and 0xFF).toByte(),
            )
        }
        val m = byteArrayOf(
            (mask and 0xFF).toByte(),
            ((mask ushr 8) and 0xFF).toByte(),
            ((mask ushr 16) and 0xFF).toByte(),
            ((mask ushr 24) and 0xFF).toByte(),
        )
        val masked = ByteArray(len)
        for (i in 0 until len) {
            masked[i] = (payload[i].toInt() xor m[i and 3].toInt()).toByte()
        }
        out.write(header)
        out.write(m)
        out.write(masked)
        out.flush()
    }

    private fun startReader(inp: DataInputStream) {
        val t = Thread({
            try {
                while (running.get()) {
                    val b0 = inp.read()
                    if (b0 < 0) break
                    val b1 = inp.read()
                    if (b1 < 0) break
                    val opcode = b0 and 0x0F
                    val masked = (b1 and 0x80) != 0
                    var len = (b1 and 0x7F).toLong()
                    if (len == 126L) {
                        len = inp.readUnsignedShort().toLong()
                    } else if (len == 127L) {
                        len = inp.readLong()
                    }
                    if (len < 0 || len > 1_048_576L) break
                    val maskKey = if (masked) ByteArray(4).also { inp.readFully(it) } else null
                    val payload = ByteArray(len.toInt())
                    inp.readFully(payload)
                    if (maskKey != null) {
                        for (i in payload.indices) {
                            payload[i] = (payload[i].toInt() xor maskKey[i and 3].toInt()).toByte()
                        }
                    }

                    when (opcode) {
                        0x1 -> {
                            val text = String(payload, Charsets.UTF_8)
                            PadProtocol.parseDocSync(text)?.let { listener.onDocSync(it) }
                        }
                        0x2 -> {
                            when (PadProtocol.readType(payload)) {
                                PadProtocol.TYPE_FRAME_SYNC -> {
                                    PadProtocol.decodeFrameSync(payload)?.let { listener.onFrameSync(it) }
                                }
                                PadProtocol.TYPE_PING -> {
                                    if (payload.size >= PadProtocol.PACKET_BYTES) {
                                        send(PadProtocol.encodePingPong(PadProtocol.TYPE_PONG, PadProtocol.readSeq(payload)))
                                    }
                                }
                                PadProtocol.TYPE_PONG -> {
                                    if (payload.size >= PadProtocol.PACKET_BYTES) {
                                        val seq = PadProtocol.readSeq(payload)
                                        if (seq == lastPingSeq && lastPingNs > 0L) {
                                            val ms = ((System.nanoTime() - lastPingNs) / 1_000_000L).toInt().coerceAtLeast(0)
                                            listener.onRttUpdated(ms)
                                        }
                                    }
                                }
                            }
                        }
                        0x8 -> break
                    }
                }
            } catch (_: Exception) {
                // Socket closed
            } finally {
                if (running.getAndSet(false)) {
                    cleanup(notifyOffline = true)
                }
            }
        }, "TintboxWsReader")
        t.isDaemon = true
        readerThread = t
        t.start()
    }

    private fun startPinger() {
        val t = Thread({
            while (running.get() && connected.get()) {
                try {
                    Thread.sleep(2000)
                } catch (_: InterruptedException) {
                    break
                }
                if (!running.get() || !connected.get()) break
                val seq = pingSeq.getAndIncrement()
                lastPingSeq = seq
                lastPingNs = System.nanoTime()
                send(PadProtocol.encodePingPong(PadProtocol.TYPE_PING, seq))
            }
        }, "TintboxWsPinger")
        t.isDaemon = true
        pingThread = t
        t.start()
    }

    private fun cleanup(notifyOffline: Boolean) {
        connected.set(false)
        queue.clear()
        runCatching { socket?.close() }
        socket = null
        writerThread?.interrupt()
        readerThread?.interrupt()
        pingThread?.interrupt()
        if (notifyOffline) {
            listener.onStateChanged(ConnectionState.OFFLINE, "Offline")
        }
    }
}

/**
 * Bluetooth Classic RFCOMM SPP transport (`00001101-0000-1000-8000-00805F9B34FB`).
 * - When `device == null`: runs as RFCOMM Server (`listenUsingRfcommWithServiceRecord`) so Chrome's
 *   Web Serial Bluetooth popup can connect directly to this phone with zero PC COM/rfcomm setup.
 * - When `device != null`: connects as RFCOMM Client to the selected paired PC.
 * - Supports bidirectional downlink frames `[0xAA, 0x55, kind(u8), len(u32 LE), ...payload]` for
 *   doc sync (kind=1) and live canvas frames (kind=2).
 */
class BluetoothPadTransport(
    private val adapter: BluetoothAdapter,
    private val device: BluetoothDevice?,
    private val listener: PadTransportListener,
) : PadTransport {

    private val running = AtomicBoolean(false)
    private val connected = AtomicBoolean(false)
    private val queue = ArrayBlockingQueue<ByteArray>(256)

    @Volatile private var serverSocket: BluetoothServerSocket? = null
    @Volatile private var btSocket: BluetoothSocket? = null
    private var writerThread: Thread? = null
    private var readerThread: Thread? = null

    override fun isConnected(): Boolean = connected.get()

    @SuppressLint("MissingPermission")
    override fun connect() {
        if (!running.compareAndSet(false, true)) return

        val t = Thread({
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_DISPLAY)
            try {
                val sock: BluetoothSocket
                val peerLabel: String
                val targetDevice = device
                if (targetDevice == null) {
                    listener.onStateChanged(
                        ConnectionState.CONNECTING,
                        "BT waiting for Chrome Web Serial…",
                    )
                    val srv = adapter.listenUsingRfcommWithServiceRecord("TintboxPad", SPP_UUID)
                    serverSocket = srv
                    sock = srv.accept()
                    runCatching { srv.close() }
                    serverSocket = null
                    peerLabel = runCatching { sock.remoteDevice?.name }.getOrNull() ?: "PC"
                } else {
                    val devName = runCatching { targetDevice.name }.getOrNull() ?: targetDevice.address
                    listener.onStateChanged(ConnectionState.CONNECTING, "Connecting BT $devName…")
                    sock = targetDevice.createRfcommSocketToServiceRecord(SPP_UUID)
                    sock.connect()
                    peerLabel = devName
                }

                btSocket = sock
                val out = sock.outputStream
                connected.set(true)
                listener.onStateChanged(ConnectionState.ONLINE, "BT · $peerLabel")

                startDownlinkReader(DataInputStream(BufferedInputStream(sock.inputStream, 8192)))

                val framed = ByteArray(2 + PadProtocol.PACKET_BYTES)
                framed[0] = PadProtocol.BT_HEADER_0
                framed[1] = PadProtocol.BT_HEADER_1
                while (running.get()) {
                    val pkt = try {
                        queue.take()
                    } catch (_: InterruptedException) {
                        break
                    }
                    if (!running.get()) break
                    System.arraycopy(pkt, 0, framed, 2, PadProtocol.PACKET_BYTES)
                    out.write(framed)
                    out.flush()
                }
            } catch (e: Exception) {
                if (running.get()) {
                    listener.onStateChanged(
                        ConnectionState.ERROR,
                        e.message?.take(64) ?: "Bluetooth SPP failed",
                    )
                }
            } finally {
                cleanup(notifyOffline = running.getAndSet(false) && !connected.get())
            }
        }, "TintboxBtWriter")
        t.isDaemon = true
        writerThread = t
        t.start()
    }

    private fun startDownlinkReader(inp: DataInputStream) {
        val t = Thread({
            try {
                while (running.get()) {
                    val b0 = inp.read()
                    if (b0 < 0) break
                    if (b0.toByte() != PadProtocol.BT_HEADER_0) continue
                    val b1 = inp.read()
                    if (b1 < 0) break
                    if (b1.toByte() != PadProtocol.BT_HEADER_1) continue
                    val kind = inp.read()
                    if (kind < 0) break
                    val l0 = inp.read()
                    val l1 = inp.read()
                    val l2 = inp.read()
                    val l3 = inp.read()
                    if (l0 < 0 || l1 < 0 || l2 < 0 || l3 < 0) break
                    val len = (l0 and 0xFF) or ((l1 and 0xFF) shl 8) or ((l2 and 0xFF) shl 16) or ((l3 and 0xFF) shl 24)
                    if (len <= 0 || len > 524_288) continue
                    val payload = ByteArray(len)
                    inp.readFully(payload)
                    if (kind == 1) {
                        PadProtocol.parseDocSync(String(payload, Charsets.UTF_8))?.let { listener.onDocSync(it) }
                    } else if (kind == 2) {
                        PadProtocol.decodeFrameSync(payload)?.let { listener.onFrameSync(it) }
                    }
                }
            } catch (_: Exception) {
                // Socket closed
            } finally {
                if (running.getAndSet(false)) {
                    cleanup(notifyOffline = true)
                }
            }
        }, "TintboxBtReader")
        t.isDaemon = true
        readerThread = t
        t.start()
    }

    override fun send(packet: ByteArray) {
        if (!connected.get()) return
        if (!queue.offer(packet)) {
            val type = PadProtocol.readType(packet)
            if (type == PadProtocol.TYPE_MOVE || type == PadProtocol.TYPE_HOVER) return
            queue.poll()
            queue.offer(packet)
        }
    }

    override fun disconnect() {
        running.set(false)
        cleanup(notifyOffline = true)
    }

    private fun cleanup(notifyOffline: Boolean) {
        connected.set(false)
        queue.clear()
        runCatching { serverSocket?.close() }
        serverSocket = null
        runCatching { btSocket?.close() }
        btSocket = null
        writerThread?.interrupt()
        readerThread?.interrupt()
        if (notifyOffline) {
            listener.onStateChanged(ConnectionState.OFFLINE, "Offline")
        }
    }

    companion object {
        val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    }
}
