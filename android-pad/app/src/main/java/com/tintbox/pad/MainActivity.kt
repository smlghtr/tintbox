package com.tintbox.pad

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.view.HapticFeedbackConstants
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import android.widget.ArrayAdapter
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioGroup
import android.widget.Spinner
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.tintbox.pad.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity(), PadTransportListener {

    private lateinit var binding: ActivityMainBinding
    private var transport: PadTransport? = null
    private var cmdSeq = 100000

    private var mode = TransportMode.USB
    private var wifiHost = "192.168.1.41"
    private var port = 8765
    private var btAddress = BT_WAIT_FOR_PC
    private var stylusOnly = false
    private var leftHanded = false
    private var showLiveMirror = true
    private var showPixelGrid = false

    private var lastPalette: List<String> = emptyList()
    private var activeHex: String = "#c6f432"

    private val requestBtPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) connectCurrentMode() else {
            onStateChanged(ConnectionState.ERROR, "Bluetooth permission denied")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemBars()
        loadPrefs()
        bindUi()
    }

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, true)
        val controller = WindowInsetsControllerCompat(window, binding.root)
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    private fun loadPrefs() {
        val p = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        mode = TransportMode.fromKey(p.getString(KEY_MODE, TransportMode.USB.key))
        wifiHost = p.getString(KEY_HOST, "192.168.1.41") ?: "192.168.1.41"
        port = p.getInt(KEY_PORT, 8765)
        btAddress = p.getString(KEY_BT_ADDR, BT_WAIT_FOR_PC) ?: BT_WAIT_FOR_PC
        stylusOnly = p.getBoolean(KEY_STYLUS_ONLY, false)
        leftHanded = p.getBoolean(KEY_LEFT_HANDED, false)
        showLiveMirror = p.getBoolean(KEY_LIVE_MIRROR, true)
        showPixelGrid = p.getBoolean(KEY_PIXEL_GRID, false)
    }

    private fun savePrefs() {
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putString(KEY_MODE, mode.key)
            .putString(KEY_HOST, wifiHost)
            .putInt(KEY_PORT, port)
            .putString(KEY_BT_ADDR, btAddress)
            .putBoolean(KEY_STYLUS_ONLY, stylusOnly)
            .putBoolean(KEY_LEFT_HANDED, leftHanded)
            .putBoolean(KEY_LIVE_MIRROR, showLiveMirror)
            .putBoolean(KEY_PIXEL_GRID, showPixelGrid)
            .apply()
    }

    private fun haptic(view: View) {
        view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    }

    private fun bindUi() {
        binding.modeBadge.text = mode.badge
        binding.drawingPad.stylusOnly = stylusOnly
        binding.drawingPad.showCanvasMirror = showLiveMirror
        binding.drawingPad.showPixelGrid = showPixelGrid
        applyHandedness()
        updateTogglePill(binding.keyStylusOnly, stylusOnly)
        updateTogglePill(binding.btnMirror, showLiveMirror)
        updateTogglePill(binding.btnGrid, showPixelGrid)

        binding.drawingPad.onPacket = { pkt ->
            transport?.send(pkt)
        }
        binding.drawingPad.onTwoFingerTap = {
            haptic(binding.drawingPad)
            transport?.send(PadProtocol.encodeCmd(PadProtocol.CMD_UNDO, cmdSeq++))
        }
        binding.drawingPad.onThreeFingerTap = {
            haptic(binding.drawingPad)
            transport?.send(PadProtocol.encodeCmd(PadProtocol.CMD_REDO, cmdSeq++))
        }

        binding.btnConnect.setOnClickListener {
            haptic(it)
            if (transport?.isConnected() == true) {
                transport?.disconnect()
                transport = null
            } else {
                connectCurrentMode()
            }
        }
        binding.btnSetup.setOnClickListener { showSetupDialog() }
        binding.modeBadge.setOnClickListener { showSetupDialog() }

        binding.btnMirror.setOnClickListener {
            haptic(it)
            showLiveMirror = !showLiveMirror
            binding.drawingPad.showCanvasMirror = showLiveMirror
            updateTogglePill(binding.btnMirror, showLiveMirror)
            savePrefs()
        }
        binding.btnGrid.setOnClickListener {
            haptic(it)
            showPixelGrid = !showPixelGrid
            binding.drawingPad.showPixelGrid = showPixelGrid
            updateTogglePill(binding.btnGrid, showPixelGrid)
            savePrefs()
        }
        binding.btnFit.setOnClickListener {
            haptic(it)
            binding.drawingPad.resetZoom()
        }
        bindExpressKey(binding.btnPrevFrame, PadProtocol.CMD_PREV_FRAME)
        bindExpressKey(binding.btnNextFrame, PadProtocol.CMD_NEXT_FRAME)

        // Express keys -> instant binary CMD packets to Tintbox
        bindExpressKey(binding.keyUndo, PadProtocol.CMD_UNDO)
        bindExpressKey(binding.keyRedo, PadProtocol.CMD_REDO)
        bindExpressKey(binding.keyPen, PadProtocol.CMD_TOOL_PEN)
        bindExpressKey(binding.keyErase, PadProtocol.CMD_TOOL_ERASER)
        bindExpressKey(binding.keyFill, PadProtocol.CMD_TOOL_FILL)
        bindExpressKey(binding.keyLine, PadProtocol.CMD_TOOL_LINE)
        bindExpressKey(binding.keyPick, PadProtocol.CMD_TOOL_PICKER)
        bindExpressKey(binding.keySwap, PadProtocol.CMD_SWAP_COLORS)
        bindExpressKey(binding.keyBrushDec, PadProtocol.CMD_BRUSH_DEC)
        bindExpressKey(binding.keyBrushInc, PadProtocol.CMD_BRUSH_INC)
        bindExpressKey(binding.keySym, PadProtocol.CMD_TOGGLE_SYM_X)

        binding.keyStylusOnly.setOnClickListener {
            haptic(it)
            stylusOnly = !stylusOnly
            binding.drawingPad.stylusOnly = stylusOnly
            updateTogglePill(binding.keyStylusOnly, stylusOnly)
            savePrefs()
        }
    }

    private fun applyHandedness() {
        val row = binding.workspaceRow
        row.removeAllViews()
        if (leftHanded) {
            row.addView(binding.padColumn)
            row.addView(binding.railDivider)
            row.addView(binding.expressRail)
        } else {
            row.addView(binding.expressRail)
            row.addView(binding.railDivider)
            row.addView(binding.padColumn)
        }
    }

    private fun bindExpressKey(view: View, cmdId: Int) {
        view.setOnClickListener {
            haptic(it)
            transport?.send(PadProtocol.encodeCmd(cmdId, cmdSeq++))
        }
    }

    private fun updateTogglePill(btn: TextView, active: Boolean) {
        btn.isSelected = active
        btn.setTextColor(
            ContextCompat.getColor(
                this,
                if (active) R.color.accent_dark else R.color.text_primary,
            ),
        )
    }

    private fun connectCurrentMode() {
        transport?.disconnect()
        transport = null
        binding.modeBadge.text = mode.badge

        when (mode) {
            TransportMode.USB -> {
                val t = WsPadTransport("127.0.0.1", port, this)
                transport = t
                t.connect()
            }
            TransportMode.WIFI -> {
                val host = wifiHost.trim()
                if (host.isEmpty()) {
                    showSetupDialog()
                    return
                }
                val t = WsPadTransport(host, port, this)
                transport = t
                t.connect()
            }
            TransportMode.BLUETOOTH -> {
                if (!hasBluetoothPermission()) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        requestBtPermission.launch(Manifest.permission.BLUETOOTH_CONNECT)
                    }
                    return
                }
                val adapter = getBluetoothAdapter()
                if (adapter == null || !adapter.isEnabled) {
                    onStateChanged(ConnectionState.ERROR, "Enable Bluetooth in Android Settings")
                    return
                }
                val dev = if (btAddress == BT_WAIT_FOR_PC) null else findPairedDevice(btAddress)
                val t = BluetoothPadTransport(adapter, dev, this)
                transport = t
                t.connect()
            }
        }
    }

    private fun hasBluetoothPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) ==
                PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
    }

    private fun getBluetoothAdapter(): BluetoothAdapter? {
        val mgr = getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        return mgr?.adapter
    }

    @SuppressLint("MissingPermission")
    private fun getPairedBluetoothDevices(): List<BluetoothDevice> {
        if (!hasBluetoothPermission()) return emptyList()
        return getBluetoothAdapter()?.bondedDevices?.toList().orEmpty()
    }

    @SuppressLint("MissingPermission")
    private fun findPairedDevice(addr: String): BluetoothDevice? {
        val list = getPairedBluetoothDevices()
        return list.firstOrNull { it.address == addr }
    }

    @SuppressLint("MissingPermission")
    private fun showSetupDialog() {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_connection, null)
        val rg = view.findViewById<RadioGroup>(R.id.rgTransport)
        val boxNet = view.findViewById<LinearLayout>(R.id.boxNetwork)
        val boxBt = view.findViewById<LinearLayout>(R.id.boxBluetooth)
        val etHost = view.findViewById<EditText>(R.id.etHost)
        val etPort = view.findViewById<EditText>(R.id.etPort)
        val tvNetHint = view.findViewById<TextView>(R.id.tvNetHint)
        val spBt = view.findViewById<Spinner>(R.id.spBtDevices)
        val tvBtHint = view.findViewById<TextView>(R.id.tvBtHint)
        val cbLeft = view.findViewById<CheckBox>(R.id.cbLeftHanded)

        etHost.setText(wifiHost)
        etPort.setText(port.toString())
        cbLeft.isChecked = leftHanded

        val paired = getPairedBluetoothDevices()
        val btOptions = ArrayList<Pair<String, String>>()
        btOptions.add(BT_WAIT_FOR_PC to "Wait for PC (Chrome Web Serial — Recommended)")
        for (d in paired) {
            btOptions.add(d.address to "${d.name ?: "Device"} (${d.address})")
        }
        spBt.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            btOptions.map { it.second },
        )
        val savedIdx = btOptions.indexOfFirst { it.first == btAddress }.coerceAtLeast(0)
        spBt.setSelection(savedIdx)

        fun applyVisibility(selected: TransportMode) {
            boxNet.visibility = if (selected == TransportMode.BLUETOOTH) View.GONE else View.VISIBLE
            boxBt.visibility = if (selected == TransportMode.BLUETOOTH) View.VISIBLE else View.GONE
            etHost.isEnabled = selected == TransportMode.WIFI
            etHost.alpha = if (selected == TransportMode.WIFI) 1f else 0.45f
            tvNetHint.text = if (selected == TransportMode.USB) {
                "USB (~1ms): run `adb reverse tcp:$port tcp:$port` on PC. Connects to 127.0.0.1:$port."
            } else {
                "Wi-Fi LAN: run `npm run pad-bridge` on PC and enter the LAN IP it prints."
            }
            if (selected == TransportMode.BLUETOOTH && !hasBluetoothPermission() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                tvBtHint.text = "Tap Save & Connect to grant Bluetooth permission."
            }
        }

        when (mode) {
            TransportMode.USB -> rg.check(R.id.rbUsb)
            TransportMode.WIFI -> rg.check(R.id.rbWifi)
            TransportMode.BLUETOOTH -> rg.check(R.id.rbBt)
        }
        applyVisibility(mode)

        rg.setOnCheckedChangeListener { _, checkedId ->
            val sel = when (checkedId) {
                R.id.rbWifi -> TransportMode.WIFI
                R.id.rbBt -> TransportMode.BLUETOOTH
                else -> TransportMode.USB
            }
            applyVisibility(sel)
        }

        AlertDialog.Builder(this)
            .setTitle("Tintbox Pad Setup")
            .setView(view)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Save & Connect") { _, _ ->
                mode = when (rg.checkedRadioButtonId) {
                    R.id.rbWifi -> TransportMode.WIFI
                    R.id.rbBt -> TransportMode.BLUETOOTH
                    else -> TransportMode.USB
                }
                wifiHost = etHost.text.toString().trim().ifEmpty { wifiHost }
                port = etPort.text.toString().toIntOrNull()?.coerceIn(1, 65535) ?: 8765
                val idx = spBt.selectedItemPosition
                btAddress = if (idx in btOptions.indices) btOptions[idx].first else BT_WAIT_FOR_PC
                if (leftHanded != cbLeft.isChecked) {
                    leftHanded = cbLeft.isChecked
                    applyHandedness()
                }
                savePrefs()
                connectCurrentMode()
            }
            .show()
    }

    private fun renderPaletteStrip(palette: List<String>, active: String) {
        if (palette == lastPalette && active.equals(activeHex, ignoreCase = true) && binding.paletteStrip.childCount > 0) {
            return
        }
        lastPalette = palette
        activeHex = active
        val strip = binding.paletteStrip
        strip.removeAllViews()
        val d = resources.displayMetrics.density
        val size = (24 * d).toInt()
        val gap = (5 * d).toInt()
        val borderActive = ContextCompat.getColor(this, R.color.accent)
        val borderIdle = ContextCompat.getColor(this, R.color.border_hairline)

        palette.forEachIndexed { idx, hex ->
            val swatch = View(this)
            val lp = LinearLayout.LayoutParams(size, size)
            if (idx > 0) lp.marginStart = gap
            swatch.layoutParams = lp
            val isSel = hex.equals(active, ignoreCase = true)
            val bg = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = 3f * d
                setColor(runCatching { Color.parseColor(hex) }.getOrDefault(Color.DKGRAY))
                setStroke(((if (isSel) 2f else 1f) * d).toInt(), if (isSel) borderActive else borderIdle)
            }
            swatch.background = bg
            swatch.setOnClickListener {
                haptic(it)
                transport?.send(PadProtocol.encodeCmd(PadProtocol.CMD_SELECT_PALETTE, cmdSeq++, arg = idx))
            }
            strip.addView(swatch)
        }
    }

    override fun onStateChanged(state: ConnectionState, detail: String) {
        runOnUiThread {
            val dotColor = ContextCompat.getColor(
                this,
                when (state) {
                    ConnectionState.ONLINE -> R.color.status_online
                    ConnectionState.CONNECTING -> R.color.status_connecting
                    ConnectionState.ERROR -> R.color.status_error
                    ConnectionState.OFFLINE -> R.color.status_offline
                },
            )
            (binding.statusDot.background as? GradientDrawable)?.setColor(dotColor)
            binding.statusText.text = detail
            binding.drawingPad.isOnline = state == ConnectionState.ONLINE
            binding.btnConnect.text = getString(
                if (state == ConnectionState.ONLINE || state == ConnectionState.CONNECTING) {
                    R.string.btn_disconnect
                } else {
                    R.string.btn_connect
                },
            )
            updateTogglePill(binding.btnConnect, state == ConnectionState.ONLINE)
        }
    }

    override fun onRttUpdated(rttMs: Int) {
        runOnUiThread {
            val target = if (mode == TransportMode.USB) "127.0.0.1:$port" else "$wifiHost:$port"
            binding.statusText.text = "$target · ${rttMs}ms"
        }
    }

    override fun onDocSync(doc: PadDocInfo) {
        runOnUiThread {
            binding.drawingPad.setDocAspect(doc.width, doc.height)
            binding.docInfoText.text = "${doc.width}x${doc.height} · ${doc.tool} ${doc.brushSize}px"
            runCatching { Color.parseColor(doc.primaryHex) }.onSuccess { color ->
                binding.colorSwatch.setBackgroundColor(color)
            }
            binding.frameBox.visibility = if (doc.frameCount > 1) View.VISIBLE else View.GONE
            binding.frameText.text = "${doc.frame + 1}/${doc.frameCount}"
            highlightToolKey(doc.tool)
            if (doc.palette.isNotEmpty()) {
                renderPaletteStrip(doc.palette, doc.primaryHex)
            }
        }
    }

    override fun onFrameSync(frame: DecodedFrame) {
        runOnUiThread {
            binding.drawingPad.updateCanvasFrame(frame)
        }
    }

    private fun highlightToolKey(tool: String) {
        val map = listOf(
            binding.keyPen to (tool == "pencil"),
            binding.keyErase to (tool == "eraser"),
            binding.keyFill to (tool == "fill"),
            binding.keyLine to (tool == "line"),
            binding.keyPick to (tool == "picker"),
        )
        for ((btn, active) in map) {
            updateTogglePill(btn, active)
        }
    }

    override fun onDestroy() {
        transport?.disconnect()
        transport = null
        super.onDestroy()
    }

    companion object {
        private const val PREFS_NAME = "tintbox_pad_prefs"
        private const val KEY_MODE = "mode"
        private const val KEY_HOST = "host"
        private const val KEY_PORT = "port"
        private const val KEY_BT_ADDR = "bt_addr"
        private const val KEY_STYLUS_ONLY = "stylus_only"
        private const val KEY_LEFT_HANDED = "left_handed"
        private const val KEY_LIVE_MIRROR = "live_mirror"
        private const val KEY_PIXEL_GRID = "pixel_grid"
        private const val BT_WAIT_FOR_PC = "__WAIT_FOR_PC__"
    }
}
