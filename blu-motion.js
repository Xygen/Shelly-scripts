/*
 * Shelly BLU Motion relay control (BTHome v2).
 * Compatible with Shelly devices supporting Scripts, BLE scanning, and Switch 0.
 * Configure one or more motion sensors in CONFIG.sensors.
 *
 * Behavior:
 * - Any configured sensor reports motion -> relay ON.
 * - No configured sensor has active motion -> relay OFF.
 * - A motion-ON state expires after maxActiveAgeMs without a new motion report.
 * - No additional normal switch-off delay.
 * - Illuminance is published on <mac>/illuminance via MQTT, if connected.
 */

var CONFIG = {
  debug: false,
  diagnoseMotionTiming: false, // Optionally log motion-report timing
  activeScan: false,

  // Must exceed the BLU Motion blind time (up to 600 seconds).
  maxActiveAgeMs: 15 * 60 * 1000,
  checkIntervalMs: 10 * 1000,
  duplicateWindowMs: 2500,

  // Add only the sensors paired with this Shelly; one entry is sufficient.
  // Replace the sample MAC addresses before deployment.
  sensors: [
    { name: "Sensor 1", mac: "aa:bb:cc:00:00:01" },
    { name: "Sensor 2", mac: "aa:bb:cc:00:00:02" },
    { name: "Sensor 3", mac: "aa:bb:cc:00:00:03" }
  ]
};

// BTHome v2 data types; multibyte values are little-endian.
var BTH = {
  0x00: { name: "pid",         len: 1 },
  0x01: { name: "battery",     len: 1 },
  0x02: { name: "temperature", len: 2, signed: true, factor: 0.01 },
  0x03: { name: "humidity",    len: 2, factor: 0.01 },
  0x05: { name: "illuminance", len: 3, factor: 0.01 },
  0x21: { name: "motion",      len: 1 },
  0x2d: { name: "window",      len: 1 },
  0x3a: { name: "button",      len: 1 }, // BTHome v2: 1-byte event
  0x3f: { name: "rotation",    len: 2, signed: true, factor: 0.1 }
};

var states = {};
var hasMotionReport = false;
var relayCallInProgress = false;

function debug(message) {
  if (CONFIG.debug) console.log("DEBUG: " + message);
}

function isValidMac(mac) {
  if (typeof mac !== "string" || mac.length !== 17) return false;
  for (var p = 0; p < 17; p++) {
    var c = mac.slice(p, p + 1);
    if (p % 3 === 2) {
      if (c !== ":") return false;
    } else if ("0123456789abcdefABCDEF".indexOf(c) === -1) {
      return false;
    }
  }
  return true;
}

function initializeSensors() {
  if (!CONFIG.sensors || typeof CONFIG.sensors.length !== "number") {
    console.log("ERROR: CONFIG.sensors must be an array");
    return 0;
  }
  var count = 0;
  for (var i = 0; i < CONFIG.sensors.length; i++) {
    var item = CONFIG.sensors[i];
    if (!item || !isValidMac(item.mac)) {
      console.log("WARN: Invalid sensor MAC address at index " + i);
      continue;
    }
    var mac = item.mac.toLowerCase();
    if (typeof states[mac] !== "undefined") {
      console.log("WARN: Duplicate sensor MAC address: " + mac);
      continue;
    }
    states[mac] = {
      name: item.name,
      motion: null,            // null = unknown or expired
      lastMotionAt: null,
      lastSeenAt: null,
      lastPid: null,
      lastPidAt: null
    };
    count++;
  }
  return count;
}

function parseBTHome(raw) {
  if (typeof raw !== "string" || raw.length < 1) return null;
  var flags = raw.at(0);
  if ((flags >> 5) !== 2 || (flags & 1) !== 0) return null;

  var decoded = {};
  var pos = 1;
  while (pos < raw.length) {
    var type = raw.at(pos++);
    var def = BTH[type];
    if (typeof def === "undefined") {
      debug("Unknown BTHome field 0x" + type.toString(16));
      break; // Keep any fields already decoded.
    }
    if (pos + def.len > raw.length) return null;

    var value = 0;
    for (var b = 0; b < def.len; b++) {
      value = value | (raw.at(pos + b) << (8 * b));
    }
    pos += def.len;

    if (def.signed && (value & (1 << (def.len * 8 - 1)))) {
      value = value - (1 << (def.len * 8));
    }
    if (typeof def.factor !== "undefined") value *= def.factor;
    decoded[def.name] = value;
  }
  return decoded;
}

function desiredRelayState() {
  for (var mac in states) {
    if (states[mac].motion === true) return true;
  }
  return false;
}

function updateRelay() {
  // Do not force a relay state before the first motion report after startup.
  if (!hasMotionReport || relayCallInProgress) return;

  var desired = desiredRelayState();
  var status = Shelly.getComponentStatus("switch", 0);
  if (status === null || typeof status.output !== "boolean") {
    console.log("WARN: Relay status unavailable");
    return;
  }
  if (status.output === desired) return;

  relayCallInProgress = true;
  Shelly.call("Switch.Set", { id: 0, on: desired }, function (result, errorCode, errorMessage) {
    relayCallInProgress = false;
    if (errorCode !== 0) {
      console.log("ERROR: Switch.Set: " + errorCode + " / " + errorMessage);
      // The periodic check retries the desired state.
      return;
    }
    console.log("Relay " + (desired ? "ON" : "OFF"));
    // Reconcile if the desired state changed during the RPC call.
    if (desiredRelayState() !== desired) updateRelay();
  });
}

function publishIlluminance(mac, value) {
  // Preserve the existing MQTT topic format.
  if (!MQTT.isConnected()) {
    debug("MQTT disconnected; illuminance dropped: " + mac);
    return;
  }
  if (!MQTT.publish(mac + "/illuminance", String(value))) {
    console.log("WARN: MQTT.publish failed: " + mac);
  }
}

function onScanEvent(event, result) {
  if (event !== BLE.Scanner.SCAN_RESULT || !result || !result.addr) return;
  var mac = result.addr.toLowerCase();
  var state = states[mac];
  if (typeof state === "undefined") return;

  if (!result.service_data || typeof result.service_data["fcd2"] === "undefined") return;
  var data = parseBTHome(result.service_data["fcd2"]);
  if (data === null) return;

  var now = Shelly.getUptimeMs();
  state.lastSeenAt = now;

  // Per-sensor duplicate filtering with a short window prevents
  // permanent suppression after a sensor restart or PID wraparound.
  if (typeof data.pid === "number") {
    if (state.lastPid === data.pid && state.lastPidAt !== null &&
        now - state.lastPidAt >= 0 &&
        now - state.lastPidAt < CONFIG.duplicateWindowMs) {
      return;
    }
    state.lastPid = data.pid;
    state.lastPidAt = now;
  }

  if (typeof data.motion === "number") {
    var motion = data.motion === 1;
    if (CONFIG.diagnoseMotionTiming) {
      var gap = state.lastMotionAt === null ? "first" : String(now - state.lastMotionAt);
      console.log("TIMING " + state.name + " motion=" + (motion ? "1" : "0") +
                  " gapMs=" + gap + " rssi=" + result.rssi +
                  " battery=" + (typeof data.battery === "number" ? data.battery : "unknown"));
    }
    if (state.motion !== motion) {
      console.log("Motion " + state.name + ": " + (motion ? "YES" : "NO"));
    }
    state.motion = motion;
    state.lastMotionAt = now;
    hasMotionReport = true;
    updateRelay();
  }

  if (typeof data.illuminance === "number") {
    publishIlluminance(mac, data.illuminance);
  }
  debug("BLE " + state.name + " RSSI=" + result.rssi + " pid=" + data.pid);
}

function periodicCheck() {
  var now = Shelly.getUptimeMs();
  for (var mac in states) {
    var state = states[mac];
    // The motion-OFF advertisement can be missed; expire stale active states
    // as a fallback. Long uninterrupted motion may also trigger this expiry.
    if (state.motion === true && state.lastMotionAt !== null &&
        now - state.lastMotionAt > CONFIG.maxActiveAgeMs) {
      state.motion = null;
      console.log("WARN: Motion state expired: " + state.name +
                  "; treating as inactive");
    }
  }
  updateRelay(); // Also reconciles externally changed relay states.
}

function init() {
  var sensorCount = initializeSensors();
  if (sensorCount === 0) {
    console.log("ERROR: No valid motion sensors configured; script not started");
    return;
  }

  var bleConfig = Shelly.getComponentConfig("ble");
  // Firmware before 2.0.0 exposes 'enable'; newer releases omit it.
  if (bleConfig !== null && bleConfig.enable === false) {
    console.log("ERROR: Bluetooth is disabled in device settings");
    return;
  }

  // Support the legacy and newer Shelly BLE Scanner API spellings.
  if (typeof BLE.Scanner.subscribe === "function") {
    BLE.Scanner.subscribe(onScanEvent);
  } else if (typeof BLE.Scanner.Subscribe === "function") {
    BLE.Scanner.Subscribe(onScanEvent);
  } else {
    console.log("ERROR: BLE.Scanner.subscribe is unavailable");
    return;
  }

  if (!BLE.Scanner.isRunning()) {
    var opts = {
      duration_ms: BLE.Scanner.INFINITE_SCAN,
      active: CONFIG.activeScan
    };
    var started = null;
    if (typeof BLE.Scanner.start === "function") {
      started = BLE.Scanner.start(opts);
    } else if (typeof BLE.Scanner.Start === "function") {
      started = BLE.Scanner.Start(opts);
    } else {
      console.log("ERROR: BLE.Scanner.start is unavailable");
      return;
    }
    if (!started) {
      console.log("ERROR: BLE scan could not be started");
      return;
    }
  }

  Timer.set(CONFIG.checkIntervalMs, true, periodicCheck);
  console.log("Motion control started with " + sensorCount + " sensor(s)");
}

init();