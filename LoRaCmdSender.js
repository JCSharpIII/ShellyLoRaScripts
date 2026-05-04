/***** Pole – LoRa command sender + status sink (permissive RX)
 * Device: Pole (this unit), Script ID: 2
 * Peer  : Gate (the opener end), runs the receiver script
 *****/

/* ---------------- CONFIG ---------------- */
let MY_NAME = "pole";
let PEER_NAME = "gate";

let ACK_TIMEOUT_MS = 10000;
let MAX_RETRIES = 1;

let RATE_LIMIT_TX_PER_MIN = 6;  // soft guard for airtime
/* ---------------------------------------- */

print("Pole script ready (permissive RX)");

/* ----------- Utilities / rate limit ----------- */
function nowMs() { return Math.floor(Date.now()); }

let txCount = 0;
Timer.set(60000, true, function(){ txCount = 0; });
function canTX() {
  if (txCount >= RATE_LIMIT_TX_PER_MIN) {
    print("TX blocked by rate limit");
    return false;
  }
  txCount++;
  return true;
}

/* ----------------- LoRa TX -------------------- */
function sendLoRa(obj) {
  if (!canTX()) return false;
  try {
    let payload = btoa(JSON.stringify(obj));
    print("TX LoRa:", JSON.stringify(obj));
    Shelly.call("Lora.SendBytes", { id: 100, data: payload }, function(_r, err, errmsg){
      if (err) print("Lora.SendBytes error:", err, errmsg); else print("Lora.SendBytes ok");
    });
    return true;
  } catch(e){
    print("Serialize error:", e);
    return false;
  }
}

/* ------------- Command + ACK tracking ----------- */
let pend = {};
let inflightToken = null;

function makeToken() {
  if (typeof makeToken._c === "undefined") makeToken._c = 1;
  return String(makeToken._c++);
}

function startAckWait(token) {
  let p = pend[token];
  if (!p) return;
  p.t_ack = Timer.set(ACK_TIMEOUT_MS, false, function(){
    let px = pend[token];
    if (!px) return;
    if (px.retries < MAX_RETRIES) {
      px.retries++;
      print("ACK timeout, retry", px.retries, "token", token);
      sendLoRa({ src: MY_NAME, dst: PEER_NAME, type: "cmd", cmd: px.cmd, token: token, ts: nowMs() });
      startAckWait(token);
    } else {
      print("Command failed:", px.cmd, "token", token);
      delete pend[token];
      if (inflightToken === token) inflightToken = null;
    }
  });
}

/* Public: send a gate command (OPEN/CLOSE/TOGGLE/PULSE) */
LoRaGateCmd = function(cmd) {
  cmd = ("" + (cmd || "")).toUpperCase();
  if (!(cmd === "OPEN" || cmd === "CLOSE" || cmd === "TOGGLE" || cmd === "PULSE")) {
    print("Bad cmd");
    return "ERR";
  }

  /* stale-guard self-heal: if guard set but no pending entry, clear it */
  if (inflightToken !== null) {
    let p = (typeof pend === "object") ? pend[inflightToken] : null;
    if (!p || !p.t_ack) {
      inflightToken = null;   // clear stale guard
    } else {
      print("BUSY guard hit; inflightToken=", inflightToken);
      return "BUSY";
    }
  }

  let token = makeToken();
  inflightToken = token;

  let sent = sendLoRa({ src: MY_NAME, dst: PEER_NAME, type: "cmd", cmd: cmd, token: token, ts: nowMs() });
  if (!sent) {
    inflightToken = null;
    return "RATE-LIMIT";
  }
  pend[token] = { cmd: cmd, retries: 0, t_ack: null };
  startAckWait(token);
  return "OK";
};

/* ------------- State cache + helpers ------------- */
let gate_state = "unknown";
GetGateState = function(){ return gate_state; };

/* Ask the Gate to report reed status now (LoRa GET) */
ForceGateStatus = function(){
  let ok = sendLoRa({ src: MY_NAME, dst: PEER_NAME, type: "get", what: "reed", ts: nowMs() });
  if (ok) print("Force status sent");
  return ok ? "OK" : "RATE-LIMIT";
};

/* ------- Lightweight RX normalizer + tap ------- */
function isLoRaEvent(e){
  if (!e) return false;
  let c = ("" + (e.component || "")).toLowerCase();
  return (c === "lora" || c.indexOf("lora:") === 0);
}
function isRxEvent(e){
  let ev = ("" + (e.event || (e.info && e.info.event) || e.name || "")).toLowerCase();
  return (ev === "lora_received" || ev === "rx" || ev === "receive" || ev === "rx_bytes" || ev === "receive_raw");
}
function rawB64(e){
  if (e && e.info && typeof e.info.data === "string") return e.info.data;
  if (e && typeof e.data === "string") return e.data;
  if (e && e.data && typeof e.data.data === "string") return e.data.data;
  return "";
}

/* small ring-buffer (last message only) for debugging */
let last_msg = null;
DumpLastMsg = function(){ try { return last_msg ? JSON.stringify(last_msg) : "none"; } catch(e){ return "err:"+e; } };
DebugState = function(){
  let keys = []; try { for (let k in pend) keys.push(k); } catch(_){}
  return { inflightToken: inflightToken, pend: keys, txCount: txCount };
};
ClearGuard = function(){
  try {
    if (typeof pend === "object") {
      for (let k in pend) { if (pend[k] && pend[k].t_ack) Timer.clear(pend[k].t_ack); }
      pend = {};
    }
    inflightToken = null;
    if (typeof makeToken !== "undefined") makeToken._c = 1;
  } catch(_){}
  return "cleared";
};

/* ----------------- RX handler ------------------- */
Shelly.addEventHandler(function(e){
  if (!isLoRaEvent(e) || !isRxEvent(e)) return;

  let msg = null;
  let raw = rawB64(e);
  
  try { 
    msg = JSON.parse(atob(raw)); 
  } catch(err){ 
    print("LoRa RX Error: Could not parse JSON (likely signal noise/trees)");
    return; 
  }

  /* store last message for quick inspection */
  last_msg = msg;

  /* 1. Handle Tiny Status Format (e.g. {"s":"C"}) */
  if (msg && typeof msg.s === "string") {
    let tinyState = msg.s.toUpperCase();
    gate_state = (tinyState === "C") ? "closed" : (tinyState === "O" ? "open" : "unknown");
    print("Gate status updated (Tiny):", gate_state, "RSSI:", e.info ? e.info.rssi : "n/a");
    return;
  }

  /* 2. Standard Status Format */
  if (msg && msg.type === "status" && msg.what === "reed") {
    let s = (msg.state === "open" || msg.state === "closed") ? msg.state : "unknown";
    gate_state = s;
    print("Gate status updated (Full):", gate_state, "RSSI:", e.info ? e.info.rssi : "n/a");
  }

  /* 3. ACK handling */
  if (msg && msg.type === "ack") {
    let tok = (msg.token != null) ? String(msg.token) : "";
    if (pend[tok]) {
      print("ACK for token", tok, "ok:", msg.ok);
      if (pend[tok].t_ack) Timer.clear(pend[tok].t_ack);
      delete pend[tok];
      if (inflightToken === tok) inflightToken = null;
    }
  }
});
