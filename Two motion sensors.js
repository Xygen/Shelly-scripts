/ This script is for using 2 (two) Shelly BLU motion sensors triggering a Shelly 1PM mini Gen3 relais.
/ The difference to the original script from the Shelly Library called "BLE in Scripting - Shelly BLU
/ Motion script actions" is that the relais turnes off only when both motion sensors report "no motion".
/ In the original script one motion sensor reporting "no motion" turned the relais off. 
/ The part after "STOP CHANGE HERE" is identical to the original script
/ (https://github.com/ALLTERCO/shelly-script-examples/blob/main/ble-shelly-motion.js)! 

/******************* START CHANGE HERE *******************/
let CONFIG = {
  // Enable/disable debug mode
  debug: false,

  // Active scan mode for Bluetooth
  active: false,

  // Allowed MAC addresses of motion sensors
  allowedMacAddresses: [
    "aa:bc:12:34:56:78", // Motion sensor 1 - replace with your Shelly BLU Motion MAC address
    "11:22:33:45:5a:bc", // Motion sensor 2 - replace with your Shelly BLU Motion MAC address
  ],

  // Status variables for motion sensors
  motionSensor1Active: false,
  motionSensor2Active: false,

  /**
   * Handler for motion events
   * @param {Boolean} motion - Indicates if motion is detected (true/false)
   * @param {Object} eventData - Data from the motion event
   */
  motionHandler: function (motion, eventData) {
    // Determine which sensor triggered the event
    if (eventData.address === CONFIG.allowedMacAddresses[0]) {
      CONFIG.motionSensor1Active = motion;
    } else if (eventData.address === CONFIG.allowedMacAddresses[1]) {
      CONFIG.motionSensor2Active = motion;
    }

    // Control the relay based on the status of both sensors
    if (CONFIG.motionSensor1Active || CONFIG.motionSensor2Active) {
      // At least one sensor detects motion: turn on the relay
      Shelly.call("Switch.Set", { id: 0, on: true });
    } else {
      // Both sensors detect no motion: turn off the relay
      Shelly.call("Switch.Set", { id: 0, on: false });
    }

    // Debug output
    if (CONFIG.debug) {
      console.log("Motion Sensor 1 Active:", CONFIG.motionSensor1Active);
      console.log("Motion Sensor 2 Active:", CONFIG.motionSensor2Active);
    }
  },

  /**
   * Handler for illuminance values
   * @param {Number} illuminance - Current illuminance value
   * @param {Object} eventData - Data from the illuminance event
   */
  illuminanceHandler: function (illuminance, eventData) {
    // Build MQTT topic based on the sensor's MAC address
    let topic = eventData.address + "/illuminance";
    // Publish illuminance value via MQTT
    MQTT.publish(topic, String(illuminance));
  },

  /**
   * Handler for status updates
   * @param {Object} eventData - Data from the status update
   */
  onStatusUpdate: function (eventData) {
    // No action defined at the moment
  },
};
/******************* STOP CHANGE HERE *******************/

let ALLTERCO_MFD_ID_STR = "0ba9";
let BTHOME_SVC_ID_STR = "fcd2";

let uint8 = 0;
let int8 = 1;
let uint16 = 2;
let int16 = 3;
let uint24 = 4;
let int24 = 5;

//Logs the provided message with an optional prefix to the console.
function logger(message, prefix) {
  //exit if the debug isn't enabled
  if (!CONFIG.debug) {
    return;
  }

  let finalText = "";

  //if the message is list loop over it
  if (Array.isArray(message)) {
    for (let i = 0; i < message.length; i++) {
      finalText = finalText + " " + JSON.stringify(message[i]);
    }
  } else {
    finalText = JSON.stringify(message);
  }

  //the prefix must be string
  if (typeof prefix !== "string") {
    prefix = "";
  } else {
    prefix = prefix + ":";
  }

  //log the result
  console.log(prefix, finalText);
}

// The BTH object defines the structure of the BTHome data
let BTH = {};
BTH[0x00] = { n: "pid", t: uint8 };
BTH[0x01] = { n: "battery", t: uint8, u: "%" };
BTH[0x02] = { n: "temperature", t: int16, f: 0.01, u: "tC" };
BTH[0x03] = { n: "humidity", t: uint16, f: 0.01, u: "%" };
BTH[0x05] = { n: "illuminance", t: uint24, f: 0.01 };
BTH[0x21] = { n: "motion", t: uint8 };
BTH[0x2d] = { n: "window", t: uint8 };
BTH[0x3a] = { n: "button", t: uint8 };
BTH[0x3f] = { n: "rotation", t: int16, f: 0.1 };

function getByteSize(type) {
  if (type === uint8 || type === int8) return 1;
  if (type === uint16 || type === int16) return 2;
  if (type === uint24 || type === int24) return 3;
  //impossible as advertisements are much smaller;
  return 255;
}

// functions for decoding and unpacking the service data from Shelly BLU devices
let BTHomeDecoder = {
  utoi: function (num, bitsz) {
    let mask = 1 << (bitsz - 1);
    return num & mask ? num - (1 << bitsz) : num;
  },
  getUInt8: function (buffer) {
    return buffer.at(0);
  },
  getInt8: function (buffer) {
    return this.utoi(this.getUInt8(buffer), 8);
  },
  getUInt16LE: function (buffer) {
    return 0xffff & ((buffer.at(1) << 8) | buffer.at(0));
  },
  getInt16LE: function (buffer) {
    return this.utoi(this.getUInt16LE(buffer), 16);
  },
  getUInt24LE: function (buffer) {
    return (
      0x00ffffff & ((buffer.at(2) << 16) | (buffer.at(1) << 8) | buffer.at(0))
    );
  },
  getInt24LE: function (buffer) {
    return this.utoi(this.getUInt24LE(buffer), 24);
  },
  getBufValue: function (type, buffer) {
    if (buffer.length < getByteSize(type)) return null;
    let res = null;
    if (type === uint8) res = this.getUInt8(buffer);
    if (type === int8) res = this.getInt8(buffer);
    if (type === uint16) res = this.getUInt16LE(buffer);
    if (type === int16) res = this.getInt16LE(buffer);
    if (type === uint24) res = this.getUInt24LE(buffer);
    if (type === int24) res = this.getInt24LE(buffer);
    return res;
  },

  // Unpacks the service data buffer from a Shelly BLU device
  unpack: function (buffer) {
    //beacons might not provide BTH service data
    if (typeof buffer !== "string" || buffer.length === 0) return null;
    let result = {};
    let _dib = buffer.at(0);
    result["encryption"] = _dib & 0x1 ? true : false;
    result["BTHome_version"] = _dib >> 5;
    if (result["BTHome_version"] !== 2) return null;
    //can not handle encrypted data
    if (result["encryption"]) return result;
    buffer = buffer.slice(1);

    let _bth;
    let _value;
    while (buffer.length > 0) {
      _bth = BTH[buffer.at(0)];
      if (typeof _bth === "undefined") {
        logger("unknown type", "BTH");
        break;
      }
      buffer = buffer.slice(1);
      _value = this.getBufValue(_bth.t, buffer);
      if (_value === null) break;
      if (typeof _bth.f !== "undefined") _value = _value * _bth.f;
      result[_bth.n] = _value;
      buffer = buffer.slice(getByteSize(_bth.t));
    }
    return result;
  },
};

function onReceivedPacket (data) {
  if(CONFIG._processedMacAddresses !== null) { 
    if(CONFIG._processedMacAddresses.indexOf(data.address) < 0) {
      logger(["Received event from", data.address, "outside of the allowed addresses"], "Info");
      return;
    }
  }

  if (
    typeof CONFIG.motionHandler === "function" &&
    typeof data.motion !== "undefined"
  ) {
    CONFIG.motionHandler(data.motion === 1, data);
    logger("Motion handler called", "Info");
  }

  if (
    typeof CONFIG.illuminanceHandler === "function" &&
    typeof data.illuminance !== "undefined"
  ) {
    CONFIG.illuminanceHandler(data.illuminance, data);
    logger("Illuminance handler called", "Info");
  }

  if (typeof CONFIG.onStatusUpdate === "function") {
    CONFIG.onStatusUpdate(data);
    logger("New status update", "Info");
  }
}

//saving the id of the last packet, this is used to filter the duplicated packets
let lastPacketId = 0x100;

// Callback for the BLE scanner object
function BLEScanCallback(event, result) {
  //exit if not a result of a scan
  if (event !== BLE.Scanner.SCAN_RESULT) {
    return;
  }

  //exit if service_data member is missing
  if (
    typeof result.service_data === "undefined" ||
    typeof result.service_data[BTHOME_SVC_ID_STR] === "undefined"
  ) {
    return;
  }

  let unpackedData = BTHomeDecoder.unpack(
    result.service_data[BTHOME_SVC_ID_STR]
  );

  //exit if unpacked data is null or the device is encrypted
  if (
    unpackedData === null ||
    typeof unpackedData === "undefined" ||
    unpackedData["encryption"]
  ) {
    logger("Encrypted devices are not supported", "Error");
    return;
  }

  //exit if the event is duplicated
  if (lastPacketId === unpackedData.pid) {
    return;
  }

  lastPacketId = unpackedData.pid;

  unpackedData.rssi = result.rssi;
  unpackedData.address = result.addr;

  onReceivedPacket(unpackedData);
}

// Initializes the script and performs the necessary checks and configurations
function init() {
  //exit if can't find the config
  if (typeof CONFIG === "undefined") {
    console.log("Error: Undefined config");
    return;
  }

  //get the config of ble component
  let BLEConfig = Shelly.getComponentConfig("ble");

  //exit if the BLE isn't enabled
  if (!BLEConfig.enable) {
    console.log(
      "Error: The Bluetooth is not enabled, please enable it from settings"
    );
    return;
  }

  //check if the scanner is already running
  if (BLE.Scanner.isRunning()) {
    console.log("Info: The BLE gateway is running, the BLE scan configuration is managed by the device");
  }
  else {
    //start the scanner
    let bleScanner = BLE.Scanner.Start({
        duration_ms: BLE.Scanner.INFINITE_SCAN,
        active: CONFIG.active
    });

    if(!bleScanner) {
      console.log("Error: Can not start new scanner");
    }
  }

  if (
    typeof CONFIG.allowedMacAddresses !== "undefined"
  ) {
    if(CONFIG.allowedMacAddresses !== null) {
      // Process configured mac addresses all to lower case and remove duplicates. 
      CONFIG._processedMacAddresses = 
        CONFIG
          .allowedMacAddresses
          .map(function (mac) { return mac.toLowerCase(); })
          .filter(function (value, index, array) { return array.indexOf(value) === index; })
    }
    else {
      CONFIG._processedMacAddresses = null;
    }
  }

  //subscribe a callback to BLE scanner
  BLE.Scanner.Subscribe(BLEScanCallback);
}

init();
