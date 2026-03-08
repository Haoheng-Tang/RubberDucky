const http = require("http");
const url = require("url");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const { exec } = require("child_process");

const PORT = 1337;
const BAUD = 9600;

let serial = null;
let parser = null;
let busy = false;
let shouldCam = false;
let shouldDiff = false;
let currKey = "";
let retCam = null;
let retDiff = null

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

function say(text,cb){
  exec(`node ../sound/cli.js --voice-id n2WRE2qz7YrHMS5eSNjC --model-id eleven_flash_v2_5 --text "${text}" --output tmp.mp3`, (err) => {
    exec("npx cli-sound tmp.mp3",(e)=>{
      cb();
    });
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (busy) {
    res.writeHead(429, {"Content-Type":"application/json"});
    res.end({ status: "BUSY" });
    return;
  }
  if (parsed.pathname == "/motor") {
    const a = parsed.query.a;
    const r = parsed.query.r;
    if (a === undefined || r === undefined) {
      res.writeHead(400, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ status: "ERR", message:"Missing parameters" }));
      return;
    }
    exec("npx cli-sound quack.mp3");
    const cmd = `${a},${r}\n`;

    sendCommand(cmd).then(()=>{
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ status: "OK" }));
    },(err)=>{
      res.writeHead(500, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ status: "ERR", message:err }));
    })
  }else if (parsed.pathname == "/cam-cmd"){
    if (shouldCam == 0){
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ status: "OK", command:"idle" }));
    }else if (shouldCam == 1){
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ status: "OK", command:"start", key:currKey}));
      shouldCam = 2;
    }else if (shouldCam == 2){
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ status: "OK", command:"continue", key:currKey}));
    }else if (shouldCam == 3){
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ status: "OK", command:"stop", key:currKey}));
      shouldCam = 0;
    }
  }else if (parsed.pathname == "/cam-ret"){
    retCam = {
      da:parsed.query.da,
      dr:parsed.query.dr,
      typed:parsed.query.typed
    }
    res.writeHead(200, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ status: "OK" }));
  }else if (parsed.pathname == "/dirty"){
    if (shouldDiff){
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ status: "OK", command:"diff" }));
    }else{
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ status: "OK", command:"idle" }));
    }
  }else if (parsed.pathname == "/diff"){
    retDiff = {
      diff:parsed.query.diff
    }
    res.writeHead(200, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ status: "OK" }));
  }else if (parsed.pathname == "/llm-cmd"){
    if (retDiff){
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ status: "OK", command:"analyze", cam:retCam, diff:retDiff }));
    }else{
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ status: "OK", command:"idle" }));
    }
  }else if (parsed.pathname == "/llm-ret"){
    let keys = parsed.query.keys;
    let ks = keys.split(',');
    let p = parsed.query.path;
    let ps = p.split(',').map(x=>Number(x));
    shouldCam = 1;
    retCam = null;
    retDiff = null;
    function nextCmd(){
      if (ps.length){
        let a = ps.shift();
        let r = ps.shift();
        const cmd = `${a},${r}\n`;
        currKey = ks.shift();
        exec("npx cli-sound quack.mp3");
        sendCommand(cmd).then(()=>{
          nextCmd();
        },(err)=>{
          res.writeHead(500, {"Content-Type":"application/json"});
          res.end(JSON.stringify({ status: "ERR", message:err }));
        })
      }else{
        res.writeHead(200, {"Content-Type":"application/json"});
        res.end(JSON.stringify({ status: "OK"}));
        shouldCam = 3;
        shouldDiff = 1;
      }
    }
    nextCmd();

  }else if (parsed.pathname == '/say'){
    busy = true;
    say(parsed.query.text,function(){
      busy = false;
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ status: "OK"}));
    });
  }else{
    res.writeHead(404, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ status: "ERR", message:"Not found"}));
    return;
  }
});
(async () => {
  await openSerial();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Server running: http://localhost:${PORT}`);
  });
})();
