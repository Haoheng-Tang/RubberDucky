# Rubberducky Camera

USB camera viewer for the **Seeed Studio XIAO ESP32S3 Sense** with OV2640/OV3660 camera module.

Streams JPEG frames over USB serial to a Node.js server and displays them in a browser-based UI with real-time controls for resolution, quality, brightness, contrast, saturation, and orientation.

## Architecture

```
XIAO ESP32S3 ──USB──> Node.js server ──WebSocket──> Browser UI
 (firmware)           (server.js)                   (public/)
```

## Setup

### 1. Flash the firmware

Open `firmware/` in PlatformIO (VS Code extension) and upload to the board:

```bash
cd firmware
pio run --target upload
```

> Make sure the XIAO ESP32S3 is in **boot mode** if the upload fails — hold the BOOT button while pressing RESET, then release.

### 2. Install & run the viewer

```bash
npm install
npm start
```

Open **http://localhost:3000** in your browser.

### 3. Connect

1. Select the serial port from the dropdown (usually `COMx` on Windows)
2. Click **Connect**
3. Click **Start Stream**

## Camera Controls

| Control    | Range           | Description                              |
|------------|-----------------|------------------------------------------|
| Resolution | QQVGA → UXGA    | Frame size (higher = slower FPS)         |
| Quality    | 4 – 63          | JPEG quality (lower number = better)     |
| Brightness | -2 – 2          | Image brightness                         |
| Contrast   | -2 – 2          | Image contrast                           |
| Saturation | -2 – 2          | Color saturation                         |
| H-Mirror   | on/off          | Horizontal mirror                        |
| V-Flip     | on/off          | Vertical flip                            |

## Serial Protocol

**ESP32 → PC (binary frames):**
- 2-byte magic `0xBE 0xEF`
- 4-byte little-endian JPEG size
- N bytes of JPEG data

**PC → ESP32 (text commands):**
- `CMD:STREAM` / `CMD:STOP` / `CMD:CAPTURE`
- `CMD:RES:VGA` / `CMD:QUALITY:12` / `CMD:BRIGHT:1` etc.
- `CMD:PING` / `CMD:STATUS`

## Requirements

- Node.js 18+
- PlatformIO CLI or VS Code extension
- Seeed Studio XIAO ESP32S3 Sense with camera module attached
