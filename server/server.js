const http = require("http");
const url = require("url");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const PORT = 1337;
const BAUD = 9600;

let serial = null;
let parser = null;
let busy = false;

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
    process.exit(1);
  }

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
    res.writeHead(429);
    res.end("Busy");
    return;
  }

  if (parsed.pathname == "/motor") {
    const a = parsed.query.a;
    const r = parsed.query.r;
    if (a === undefined || r === undefined) {
      res.writeHead(400);
      res.end("Missing parameters");
      return;
    }
    const cmd = `${a},${r}\n`;
    busy = true;
    try {
      await sendCommand(cmd);
      res.writeHead(200);
      res.end("OK\n");
    } catch (err) {
      res.writeHead(500);
      res.end("Error: " + err);
    }
    busy = false;
  }else{
    res.writeHead(404);
    res.end("Not found");
    return;
  }
});

(async () => {
  await openSerial();

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Server running: http://localhost:${PORT}`);
  });
})();