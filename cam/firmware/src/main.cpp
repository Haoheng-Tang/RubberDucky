#include <Arduino.h>
#include "esp_camera.h"

// ── XIAO ESP32S3 Sense camera pin map ──────────────────────────────
#define PWDN_GPIO_NUM   -1
#define RESET_GPIO_NUM  -1
#define XCLK_GPIO_NUM   10
#define SIOD_GPIO_NUM   40
#define SIOC_GPIO_NUM   39
#define Y9_GPIO_NUM     48
#define Y8_GPIO_NUM     11
#define Y7_GPIO_NUM     12
#define Y6_GPIO_NUM     14
#define Y5_GPIO_NUM     16
#define Y4_GPIO_NUM     18
#define Y3_GPIO_NUM     17
#define Y2_GPIO_NUM     15
#define VSYNC_GPIO_NUM  38
#define HREF_GPIO_NUM   47
#define PCLK_GPIO_NUM   13

static const uint8_t FRAME_MAGIC[] = {0xBE, 0xEF};

bool streaming = false;

// ── Camera init ────────────────────────────────────────────────────
void initCamera() {
    camera_config_t cfg;
    cfg.ledc_channel = LEDC_CHANNEL_0;
    cfg.ledc_timer   = LEDC_TIMER_0;
    cfg.pin_d0       = Y2_GPIO_NUM;
    cfg.pin_d1       = Y3_GPIO_NUM;
    cfg.pin_d2       = Y4_GPIO_NUM;
    cfg.pin_d3       = Y5_GPIO_NUM;
    cfg.pin_d4       = Y6_GPIO_NUM;
    cfg.pin_d5       = Y7_GPIO_NUM;
    cfg.pin_d6       = Y8_GPIO_NUM;
    cfg.pin_d7       = Y9_GPIO_NUM;
    cfg.pin_xclk     = XCLK_GPIO_NUM;
    cfg.pin_pclk     = PCLK_GPIO_NUM;
    cfg.pin_vsync    = VSYNC_GPIO_NUM;
    cfg.pin_href     = HREF_GPIO_NUM;
    cfg.pin_sccb_sda = SIOD_GPIO_NUM;
    cfg.pin_sccb_scl = SIOC_GPIO_NUM;
    cfg.pin_pwdn     = PWDN_GPIO_NUM;
    cfg.pin_reset    = RESET_GPIO_NUM;
    cfg.xclk_freq_hz = 20000000;
    cfg.pixel_format = PIXFORMAT_JPEG;
    cfg.frame_size   = FRAMESIZE_VGA;
    cfg.jpeg_quality = 12;
    cfg.fb_count     = 2;
    cfg.fb_location  = CAMERA_FB_IN_PSRAM;
    cfg.grab_mode    = CAMERA_GRAB_LATEST;

    esp_err_t err = esp_camera_init(&cfg);
    if (err != ESP_OK) {
        Serial.printf("RSP:ERROR:Camera init failed 0x%x\n", err);
        return;
    }
    Serial.println("RSP:OK:Camera initialized");
}

// ── Send one JPEG frame over serial ────────────────────────────────
void sendFrame() {
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
        Serial.println("RSP:ERROR:Capture failed");
        return;
    }

    uint32_t len = fb->len;
    Serial.write(FRAME_MAGIC, 2);
    Serial.write((uint8_t *)&len, 4);
    Serial.write(fb->buf, fb->len);

    esp_camera_fb_return(fb);
}

// ── Process text commands from the host ────────────────────────────
void processCommand(String cmd) {
    cmd.trim();

    if (cmd == "CMD:STREAM") {
        streaming = true;
        Serial.println("RSP:OK:Streaming started");
    } else if (cmd == "CMD:STOP") {
        streaming = false;
        Serial.println("RSP:OK:Streaming stopped");
    } else if (cmd == "CMD:CAPTURE") {
        sendFrame();
    } else if (cmd.startsWith("CMD:RES:")) {
        String res = cmd.substring(8);
        framesize_t fs = FRAMESIZE_VGA;
        if      (res == "QQVGA") fs = FRAMESIZE_QQVGA;
        else if (res == "QVGA")  fs = FRAMESIZE_QVGA;
        else if (res == "CIF")   fs = FRAMESIZE_CIF;
        else if (res == "VGA")   fs = FRAMESIZE_VGA;
        else if (res == "SVGA")  fs = FRAMESIZE_SVGA;
        else if (res == "XGA")   fs = FRAMESIZE_XGA;
        else if (res == "SXGA")  fs = FRAMESIZE_SXGA;
        else if (res == "UXGA")  fs = FRAMESIZE_UXGA;
        sensor_t *s = esp_camera_sensor_get();
        s->set_framesize(s, fs);
        Serial.printf("RSP:OK:Resolution %s\n", res.c_str());
    } else if (cmd.startsWith("CMD:QUALITY:")) {
        int q = constrain(cmd.substring(12).toInt(), 4, 63);
        sensor_t *s = esp_camera_sensor_get();
        s->set_quality(s, q);
        Serial.printf("RSP:OK:Quality %d\n", q);
    } else if (cmd.startsWith("CMD:BRIGHT:")) {
        int v = cmd.substring(11).toInt();
        sensor_t *s = esp_camera_sensor_get();
        s->set_brightness(s, v);
        Serial.printf("RSP:OK:Brightness %d\n", v);
    } else if (cmd.startsWith("CMD:CONTRAST:")) {
        int v = cmd.substring(13).toInt();
        sensor_t *s = esp_camera_sensor_get();
        s->set_contrast(s, v);
        Serial.printf("RSP:OK:Contrast %d\n", v);
    } else if (cmd.startsWith("CMD:SATURATION:")) {
        int v = cmd.substring(15).toInt();
        sensor_t *s = esp_camera_sensor_get();
        s->set_saturation(s, v);
        Serial.printf("RSP:OK:Saturation %d\n", v);
    } else if (cmd.startsWith("CMD:HMIRROR:")) {
        int v = cmd.substring(12).toInt();
        sensor_t *s = esp_camera_sensor_get();
        s->set_hmirror(s, v);
        Serial.printf("RSP:OK:H-Mirror %d\n", v);
    } else if (cmd.startsWith("CMD:VFLIP:")) {
        int v = cmd.substring(10).toInt();
        sensor_t *s = esp_camera_sensor_get();
        s->set_vflip(s, v);
        Serial.printf("RSP:OK:V-Flip %d\n", v);
    } else if (cmd == "CMD:STATUS") {
        sensor_t *s = esp_camera_sensor_get();
        Serial.printf("INFO:streaming=%d,quality=%d,framesize=%d,"
                       "brightness=%d,contrast=%d,saturation=%d,"
                       "hmirror=%d,vflip=%d\n",
            streaming, s->status.quality, s->status.framesize,
            s->status.brightness, s->status.contrast, s->status.saturation,
            s->status.hmirror, s->status.vflip);
    } else if (cmd == "CMD:PING") {
        Serial.println("RSP:PONG");
    }
}

// ── Arduino entry points ───────────────────────────────────────────
void setup() {
    Serial.begin(2000000);
    delay(1000);
    Serial.println("INFO:XIAO_ESP32S3_CAMERA_READY");
    initCamera();
}

void loop() {
    if (Serial.available()) {
        String cmd = Serial.readStringUntil('\n');
        processCommand(cmd);
    }
    if (streaming) {
        sendFrame();
    }
    delay(5);
}
