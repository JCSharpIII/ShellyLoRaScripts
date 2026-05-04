/***** Gate – LoRa Master Ranch-Proof (INVERTED REED)
 * Optimized for Rockdale brush:
 * - INVERT_REED = true (Status fixed for your wiring)
 * - 10s Stability Check (ignores wind/jitter)
 * - Bit-Flip Protection (scrambled 'P' still opens gate)
 *****/

let MY_NAME = "gate";
let PEER_NAME = "pole";
let RELAY_ID = 0; 
let INPUT_ID = 0; 
let STABILITY_DELAY_MS = 10000; 

// FIXED: Status is now inverted to match your physical reed switch
let INVERT_REED = true; 

print("Gate script ready (Master Ranch-Proof Mode)");

/* ----------------- LoRa TX -------------------- */
function sendStatus(state) {
  let tinyState = (state === "closed") ? "C" : "O";
  try {
    let payload = btoa(JSON.stringify({ "s": tinyState }));
    print("TX Status:", tinyState);
    Shelly.call("Lora.SendBytes", { id: 100, data: payload });
  } catch(e) { print("TX Error"); }
}

let lastReportedState = null;
let stabilityTimer = null;

function checkStability() {
  Shelly.call("Input.GetStatus", { id: INPUT_ID }, function(res) {
    let rawState = (res && res.state); // true if magnet present
    
    // Apply the inversion logic
    let logicalOpen = INVERT_REED ? rawState : !rawState;
    let currentState = logicalOpen ? "open" : "closed";
    
    if (currentState !== lastReportedState) {
      lastReportedState = currentState;
      sendStatus(currentState);
    } else {
      print("State stable (" + currentState + "); no update needed.");
    }
    stabilityTimer = null;
  });
}

/* 1. MOVEMENT HANDLER */
Shelly.addEventHandler(function(e) {
  if (e.component === "input:" + INPUT_ID) {
    print("Reed movement detected... starting 10s stability check.");
    if (stabilityTimer) Timer.clear(stabilityTimer);
    stabilityTimer = Timer.set(STABILITY_DELAY_MS, false, checkStability);
  }
});

/* 2. HEARTBEAT */
Timer.set(600000, true, function() {
  if (!stabilityTimer) { 
    checkStability();
  }
});

/* ----------------- Relay Logic ---------------- */
function pulseGate() {
  print("COMMAND MATCH: Pulsing Gate Relay!");
  Shelly.call("Switch.Set", { id: RELAY_ID, on: true });
  Timer.set(500, false, function() {
    Shelly.call("Switch.Set", { id: RELAY_ID, on: false });
    Timer.set(15000, false, checkStability);
  });
}

/* ----------------- RX Handler ----------------- */
Shelly.addEventHandler(function(e) {
  let c = ("" + (e.component || "")).toLowerCase();
  if (c.indexOf("lora") === -1) return;
  let ev = ("" + (e.event || (e.info && e.info.event) || "")).toLowerCase();
  if (ev.indexOf("rx") === -1 && ev.indexOf("lora_received") === -1) return;

  let raw = (e.info && e.info.data) || e.data || "";
  try {
    let plainText = atob(raw);
    print("Received Raw:", plainText);
    if (plainText.indexOf('"c":') !== -1) {
      pulseGate();
    } else if (plainText.indexOf('"y":') !== -1) {
      print("COMMAND MATCH: Status Request");
      checkStability();
    }
  } catch(err) { print("Radio static too high to decode."); }
});

