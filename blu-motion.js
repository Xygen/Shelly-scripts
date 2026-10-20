/*
 * Shelly 1PM Mini Gen3 - 3 BLU-Bewegungsmelder (BTHome v2)
 * Geeignet als Ersatz des bereitgestellten Skripts.
 * Verwendet die dokumentierten Shelly-Script-APIs.
 *
 * Verhalten:
 * - Mindestens ein Sensor meldet Bewegung -> Relais EIN.
 * - Alle drei Sensoren melden keine Bewegung -> Relais AUS.
 * - Fehlende Bewegung-AUS-Meldung: aktiver Sensorstatus verfällt
 *   nach maxActiveAgeMs ohne neue Bewegungsstatusmeldung.
 * - Keine zusaetzliche normale Nachlaufzeit.
 * - Helligkeit bleibt unter <mac>/illuminance per MQTT verfuegbar.
 */

var CONFIG = {
  debug: false,
  activeScan: false,

  // Muss laenger sein als die maximale eingestellte BLU Motion Blind Time
  // (laut Shelly-Dokumentation: maximal 600 Sekunden).
  maxActiveAgeMs: 15 * 60 * 1000,
  checkIntervalMs: 10 * 1000,
  duplicateWindowMs: 2500,

  // Example addresses only! Replace each MAC with the address of your own sensor.
  sensors: [
    { name: "Oben",       mac: "aa:bb:cc:00:00:01" },
    { name: "Unten neu",  mac: "aa:bb:cc:00:00:02" },
    { name: "Unten alt",  mac: "aa:bb:cc:00:00:03" }
  ]
};

// Einfache BTHome-v2-Typentabelle. Alle Werte sind little-endian.
var BTH = {
  0x00: { name: "pid",         len: 1 },
  0x01: { name: "battery",     len: 1 },
  0x02: { name: "temperature", len: 2, signed: true, factor: 0.01 },
  0x03: { name: "humidity",    len: 2, factor: 0.01 },
  0x05: { name: "illuminance", len: 3, factor: 0.01 },
  0x21: { name: "motion",      len: 1 },
  0x2d: { name: "window",      len: 1 },
  0x3a: { name: "button",      len: 2 },
  0x3f: { name: "rotation",    len: 2, signed: true, factor: 0.1 }
};

var states = {};
var hasMotionReport = false;
var relayCallInProgress = false;

function debug(message) {
  if (CONFIG.debug) console.log("DEBUG: " + message);
}

function initializeSensors() {
  for (var i = 0; i < CONFIG.sensors.length; i++) {
    var item = CONFIG.sensors[i];
    var mac = item.mac.toLowerCase();
    if (typeof states[mac] !== "undefined") {
      console.log("WARN: Doppelte Sensoradresse: " + mac);
      continue;
    }
    states[mac] = {
      name: item.name,
      motion: null,            // null = noch nicht bekannt / veraltet
      lastMotionAt: null,
      lastSeenAt: null,
      lastPid: null,
      lastPidAt: null
    };
  }
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
      debug("Unbekanntes BTHome-Feld 0x" + type.toString(16));
      break; // Bereits gelesene Felder bleiben nutzbar.
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
  // Nach Skript-Neustart keinen unbekannten Status zwangsweise schalten.
  if (!hasMotionReport || relayCallInProgress) return;

  var desired = desiredRelayState();
  var status = Shelly.getComponentStatus("switch", 0);
  if (status === null || typeof status.output !== "boolean") {
    console.log("WARN: Relaisstatus nicht lesbar");
    return;
  }
  if (status.output === desired) return;

  relayCallInProgress = true;
  Shelly.call("Switch.Set", { id: 0, on: desired }, function (result, errorCode, errorMessage) {
    relayCallInProgress = false;
    if (errorCode !== 0) {
      console.log("ERROR: Switch.Set: " + errorCode + " / " + errorMessage);
      // Ein neuer Versuch erfolgt durch den periodischen Check.
      return;
    }
    console.log("Relais " + (desired ? "EIN" : "AUS"));
    // Wenn sich der Sollzustand inzwischen geaendert hat, nachsteuern.
    if (desiredRelayState() !== desired) updateRelay();
  });
}

function publishIlluminance(mac, value) {
  // Das vorhandene Topic-Format bleibt erhalten.
  if (!MQTT.isConnected()) {
    debug("MQTT nicht verbunden; Helligkeit verworfen: " + mac);
    return;
  }
  if (!MQTT.publish(mac + "/illuminance", String(value))) {
    console.log("WARN: MQTT.publish fehlgeschlagen: " + mac);
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

  // Duplikate PRO Sensor. Das Zeitfenster verhindert dauerhafte Sperren
  // nach Neustart des Sensors oder Umlauf des 8-Bit-Paketzählers.
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
    if (state.motion !== motion) {
      console.log("Bewegung " + state.name + ": " + (motion ? "JA" : "NEIN"));
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
    // BLU Motion sendet unter normalen Bedingungen nach Ablauf der Blind
    // Time 'no motion'. Diese Absicherung greift nur bei fehlender Meldung.
    if (state.motion === true && state.lastMotionAt !== null &&
        now - state.lastMotionAt > CONFIG.maxActiveAgeMs) {
      state.motion = null;
      console.log("WARN: Bewegungsstatus veraltet: " + state.name +
                  "; wird fuer die Schaltentscheidung ignoriert");
    }
  }
  updateRelay(); // Korrigiert auch extern veraenderte Relaiszustände.
}

function init() {
  initializeSensors();

  var bleConfig = Shelly.getComponentConfig("ble");
  // Firmware < 2.0.0 hat 'enable'; ab 2.0.0 entfallen.
  if (bleConfig !== null && bleConfig.enable === false) {
    console.log("ERROR: Bluetooth in den Geraeteeinstellungen deaktiviert");
    return;
  }

  // Alte und neue Schreibweise der Shelly BLE-Scanner-API unterstuetzen.
  if (typeof BLE.Scanner.subscribe === "function") {
    BLE.Scanner.subscribe(onScanEvent);
  } else if (typeof BLE.Scanner.Subscribe === "function") {
    BLE.Scanner.Subscribe(onScanEvent);
  } else {
    console.log("ERROR: BLE.Scanner.subscribe nicht verfuegbar");
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
      console.log("ERROR: BLE.Scanner.start nicht verfuegbar");
      return;
    }
    if (!started) {
      console.log("ERROR: BLE-Scan konnte nicht gestartet werden");
      return;
    }
  }

  Timer.set(CONFIG.checkIntervalMs, true, periodicCheck);
  console.log("3-Sensor-Bewegungssteuerung gestartet");
}

init();