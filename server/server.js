const http = require("http");
const url = require("url");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const PORT = 1337;
const BAUD = 9600;

let serial = null;
let parser = null;
let busy = false;
let dirtyCommand = "idle";
let lastDiff = null;

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function findPort() {
  const ports = await SerialPort.list();
  console.log(ports);
  for (const p of ports) {
    if (p.productId == '8036') {
      return p.path;
    }
  }
  return null;
}

async function openSerial() {
  const portPath = await findPort();

  if (!portPath) {
    console.error("No suitable serial port found");
    // process.exit(1);
  }else{
    console.log("Using serial port:", portPath);
    serial = new SerialPort({
      path: portPath,
      baudRate: BAUD,
    });
    parser = serial.pipe(new ReadlineParser({ delimiter: "\n" }));
    serial.on("open", () => {
      console.log("Serial port opened");
    });
  }
}

function sendCommand(cmd) {
  return new Promise((resolve, reject) => {
    if (!serial) return reject("Serial not ready");
    const timeout = setTimeout(() => {
      parser.removeListener("data", onData);
      reject("Timeout waiting for OK");
    }, 3000);
    function onData(data) {
      const line = data.trim();
      console.log("RX:", line);

      if (line === "OK") {
        clearTimeout(timeout);
        parser.removeListener("data", onData);
        resolve();
      }
    }
    parser.on("data", onData);
    console.log("TX:", cmd.trim());
    serial.write(cmd);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (busy) {
    sendJson(res, 429, { status: "BUSY", command: "busy" });
    return;
  }
  if (parsed.pathname == "/motor") {
    const a = parsed.query.a;
    const r = parsed.query.r;
    if (a === undefined || r === undefined) {
      sendJson(res, 400, { status: "ERR", message:"Missing parameters" });
      return;
    }
    const cmd = `${a},${r}\n`;
    busy = true;
    try {
      await sendCommand(cmd);
      sendJson(res, 200, { status: "OK" });
    } catch (err) {
      sendJson(res, 500, { status: "ERR", message:err });
    }
    busy = false;
  }else if (parsed.pathname == "/cam-cmd"){
    sendJson(res, 200, { status: "OK", command:"idle" });
  }else if (parsed.pathname == "/cam-ret"){
    sendJson(res, 200, { status: "OK" });
  }else if (parsed.pathname == "/dirty"){
    const requestedCommand = String(parsed.query.command || "").toLowerCase();
    if (requestedCommand === "idle" || requestedCommand === "diff") {
      dirtyCommand = requestedCommand;
    }
    sendJson(res, 200, { status: "OK", command: dirtyCommand });
  }else if (parsed.pathname == "/diff"){
    if (req.method === "POST") {
      try {
        const body = await readBody(req);
        if (body.trim().length > 0) {
          lastDiff = JSON.parse(body);
          console.log("Received /diff payload:", {
            filePath: lastDiff.filePath,
            hasChanges: lastDiff.hasChanges
          });
        }
        dirtyCommand = "idle";
        sendJson(res, 200, { status: "OK" });
      } catch (err) {
        sendJson(res, 400, { status: "ERR", message: String(err) });
      }
    } else if (req.method === "GET") {
      sendJson(res, 200, { status: "OK", lastDiff });
    } else {
      sendJson(res, 405, { status: "ERR", message: "Method not allowed" });
    }
  }else if (parsed.pathname == "/llm-cmd"){
    sendJson(res, 200, { status: "OK", command:"idle" });
  }else if (parsed.pathname == "/llm-ret"){
    sendJson(res, 200, { status: "OK"});
  }else{
    sendJson(res, 404, { status: "ERR", message:"Not found"});
    return;
  }
});

(async () => {
  await openSerial();

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Server running: http://localhost:${PORT}`);
  });
})();
