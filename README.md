# Shelly scripts

JavaScript examples for Shelly devices using Shelly Script.

**Contribution and language policy:** All future documentation, code comments, and human-readable script output must be in **English**. See [Repository contribution and language rules](AGENTS.md). Historical text remains untouched until revised.

## Configurable BLU Motion relay control — `blu-motion.js`

[View the script](blu-motion.js)

Controls relay `Switch 0` on a compatible Shelly from **one or more Shelly BLU Motion** sensors (unencrypted BTHome v2 advertisements). The configuration is an array; there is no hard-coded requirement to use exactly three sensors. The currently confirmed deployment uses a Shelly **1PM Mini Gen3**.

**Logic**
- Relay **ON** when at least one configured sensor reports motion, including with only one configured sensor.
- Relay **OFF** when no sensor has a valid active motion state.
- Sensor states are tracked separately, including each sensor's Bluetooth packet ID, so matching packet IDs from different devices are not treated as duplicates.
- A motion-ON state expires after **15 minutes** without another motion-status advertisement (`maxActiveAgeMs`). Expired states are treated as unknown, not active. This prevents an indefinitely active relay after a missed motion-OFF advertisement, but may turn the light off if BLE messages are lost.
- No additional normal switch-off delay is added beyond the motion sensors' configured blind time.
- Publishes received illuminance values on the existing MQTT topics `<lowercase-mac>/illuminance` if MQTT is connected.
- Checks the relay every **10 seconds** and corrects a state changed externally when at least one motion report has been received after starting.

### Setup

1. Back up the current script in the Shelly web interface before replacing it.
2. Open `blu-motion.js`, replace the sample MAC addresses in `CONFIG.sensors`, and **remove unused sensor entries**. For a one-sensor installation, configure exactly one entry.
3. Paste the code into a Shelly Script on the target device, save, and start it. Enable automatic start if desired.
4. Test every configured sensor, including motion-ON, motion-OFF, and fallback timeout behavior. On multisensor installations, confirm that one active sensor keeps the relay on.
5. For illuminance MQTT output, configure and connect the Shelly's MQTT client.

> **Privacy:** This public repository deliberately contains example MAC addresses, not the real addresses of installed motion sensors. Copying the file without replacing the relevant addresses will **not** control your sensors.

### Sensor count and reuse on other Shelly devices

The **same source file** must support **1, 2, 3 or more configured BLE motion sensors**. Only `CONFIG.sensors` needs to change between installations; do not create or maintain separate scripts based solely on sensor count.

Single sensor (for a room with one BLU Motion):

```javascript
sensors: [
  { name: "Utility room", mac: "aa:bb:cc:00:00:01" }
]
```

Three sensors (for larger spaces or different detection angles):

```javascript
sensors: [
  { name: "Upper", mac: "aa:bb:cc:00:00:01" },
  { name: "Lower A", mac: "aa:bb:cc:00:00:02" },
  { name: "Lower B", mac: "aa:bb:cc:00:00:03" }
]
```

- With **one** sensor, its motion-ON message turns the relay on; its motion-OFF message turns the relay off.
- With **multiple** sensors, the relay remains on while **any** configured sensor reports active motion.
- Messages from unconfigured Bluetooth devices are ignored.
- MAC addresses are normalized to lowercase; duplicate or malformed addresses are skipped with an English warning.
- If **no valid sensor** remains, the script reports an error and does not initialize scanning or switch the relay.
- Use one instance of this script per target relay; do **not** run two independently controlling scripts on the same relay.
- There is no artificial code-level sensor-count limit. Practical limits depend on the device's available memory, firmware and Bluetooth environment.
- The configured display `name` is used in logs; it does not need to match an entity name in Home Assistant.

### Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `debug` | `false` | Enable verbose console diagnostics |
| `diagnoseMotionTiming` | `false` | Optional gap/RSSI/battery logs per accepted motion report |
| `activeScan` | `false` | Passive Bluetooth scanning |
| `maxActiveAgeMs` | `900000` | Expiry for a previously active motion state |
| `checkIntervalMs` | `10000` | Periodic relay reconciliation and expiry check |
| `duplicateWindowMs` | `2500` | Ignore the same packet ID from the same sensor within this window |

### Compatibility and limitations

- Confirmed use case: **Shelly 1PM Mini Gen3** with three sensors. Reuse on other Shelly models requires Shelly Script support, BLE scanning, and a compatible `Switch 0` relay interface; hardware compatibility must be verified for each device. Other hardware is not yet validated.
- The device's firmware is reported as **Shelly OS 2.1.0** via Home Assistant. Compatibility with other releases must be tested.
- BTHome encrypted advertisements are not supported.
- Sensor silence alone does **not** indicate an outage while a sensor is reporting no motion; the timeout only expires a previously active motion state.
- After a script restart the sensor states are initially unknown; the script does not force a relay state until a motion report arrives.

## Original two-sensor implementation

[Two motion sensors.js](Two%20motion%20sensors.js) is retained **unchanged** as the historical two-sensor example. The main branch version before introducing the three-sensor script is preserved at [`archive/two-sensor-baseline-2026-10-20`](../../tree/archive/two-sensor-baseline-2026-10-20), starting from commit [`472e692`](../../commit/472e692f0b3ec29f6275a4fab69b0f931d466b7a).

### Notes on the transition

The newer script supports any number of configured motion sensors (including just one), independent per-sensor duplicate filtering, uniform MAC normalization, a configurable active-state expiry, conditional relay changes with RPC error reporting, and a BTHome v2 button event field width of one byte (`uint8`). It also retains the per-sensor MQTT illuminance topic pattern.

**Rollback:** Stop the new script and restore/start the previous on-device script backup. The archived GitHub two-sensor example contains sample MAC addresses and is not necessarily an exact copy of an individual device's prior running configuration.

### Motion timing investigation

Temporarily set `diagnoseMotionTiming: true` in `CONFIG` and inspect the Shelly script log. A `TIMING` line shows the sensor name, its motion state, the milliseconds since its preceding accepted motion-status report (`gapMs`, or `first`), BLE RSSI and the battery level if included in that particular packet. This does **not** change relay behavior.

**Known limitation:** the 15-minute fallback timeout is unchanged. When a sensor extends its internal blind time without broadcasting fresh motion packets, the saved ON state can expire even though someone is present. Before adjusting that timeout or using Beacon mode, collect representative motion timing logs for all three sensors. Do not assume silence proves a sensor failed.

### Offline regression tests

Run `node tests/blu-motion.test.js` to execute the simulated BTHome packet/relay tests. They mock Shelly APIs and cover single-, two-, three- and four-sensor configurations, invalid configurations and the device-specific binary-string behavior. They cannot substitute for a hardware/firmware test.

Protocol reference: [BTHome v2](https://bthome.io/format/).
