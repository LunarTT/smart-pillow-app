#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <LunarTxT-project-1_inferencing.h>
#include "driver/i2s.h"
#include <HTTPClient.h>

// ===================================================================
// 1. ตั้งค่า Wi-Fi & MQTT
// ===================================================================
const char* ssid = "Tawan";          // ชื่อ Wi-Fi
const char* password = "87654321";  // รหัสผ่าน Wi-Fi
const char* mqtt_server = "broker.hivemq.com";
const int mqtt_port = 1883;

// URL Server ฝั่ง Express (ใส่ IP หรือ Hostname ของ Render เช่น "smart-pillow-api.onrender.com")
const char* server_host = "smart-pillow-dashboard.onrender.com"; 
const int server_port = 443; // หากเป็น HTTPS ให้ใช้ 443

bool autoMode = true; // เปิดโหมดทำงานอัตโนมัติเป็นค่าเริ่มต้น

WiFiClient espClient;
PubSubClient client(espClient);

// ฟังก์ชันสร้าง Device ID อัตโนมัติจาก MAC Address
String getDeviceID() {
    String mac = WiFi.macAddress();
    mac.replace(":", "");
    return "pillow-" + mac;
}

// ===================================================================
// 2. กำหนด พิน (Pins Setup)
// ===================================================================
#define I2S_WS   25  // Word Select
#define I2S_SD   32  // Serial Data
#define I2S_SCK  14  // Serial Clock
#define I2S_PORT I2S_NUM_0

#define PUMP_PIN     26  // IN1 ควบคุมปั๊มลม
#define VALVE_PIN    27  // IN2 ควบคุมโซลินอยด์วาล์ว

#define RELAY_ON     LOW
#define RELAY_OFF    HIGH

// ===================================================================
// 3. เงื่อนไขการตรวจจับเสียงกรน (Detection Logic Parameters)
// ===================================================================
#define SNORE_THRESHOLD      0.80f    // ความน่าจะเป็น >= 80%
const int REQUIRED_SNORES =   3;       // ต้องตรวจเจอ 3 ครั้ง
const unsigned long WINDOW_TIME_MS = 10000; // ภายใน 10 วินาที

unsigned long snore_window_start = 0; 
int snore_count = 0;                  

// ===================================================================
// 4. โครงสร้างข้อมูล Buffer สำหรับ Audio Sampling (Edge Impulse)
// ===================================================================
typedef struct {
    int16_t *buffers[2];
    uint8_t buf_idx;
    uint32_t buf_count;
    uint32_t buf_req_captured;
    bool is_ready;
} inference_t;

static inference_t inference;
static bool debug_nn = false;

// โครงสร้าง WAV Header 44 Bytes Standard
struct WAVHeader {
    char riff[4] = {'R', 'I', 'F', 'F'};
    uint32_t chunkSize;
    char wave[4] = {'W', 'A', 'V', 'E'};
    char fmt[4] = {'f', 'm', 't', ' '};
    uint32_t subchunk1Size = 16;
    uint16_t audioFormat = 1; // PCM
    uint16_t numChannels = 1; // Mono
    uint32_t sampleRate = 16000;
    uint32_t byteRate = 32000;
    uint16_t blockAlign = 2;
    uint16_t bitsPerSample = 16;
    char data[4] = {'d', 'a', 't', 'a'};
    uint32_t subchunk2Size;
};

// -------------------------------------------------------------------
// ฟังก์ชันตั้งค่า I2S Peripheral
// -------------------------------------------------------------------
void i2s_init() {
    i2s_config_t i2s_config = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
        .sample_rate = EI_CLASSIFIER_FREQUENCY, // 16000 Hz
        .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
        .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
        .communication_format = i2s_comm_format_t(I2S_COMM_FORMAT_STAND_I2S),
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = 8,
        .dma_buf_len = 64,
        .use_apll = false
    };

    i2s_pin_config_t pin_config = {
        .bck_io_num = I2S_SCK,
        .ws_io_num = I2S_WS,
        .data_out_num = I2S_PIN_NO_CHANGE,
        .data_in_num = I2S_SD
    };

    i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
    i2s_set_pin(I2S_PORT, &pin_config);
}

static int microphone_audio_signal_get_data(size_t offset, size_t length, float *out_ptr) {
    numpy::int16_to_float(&inference.buffers[inference.buf_idx ^ 1][offset], out_ptr, length);
    return 0;
}

void capture_samples(void *arg) {
    size_t bytes_read = 0;
    int32_t raw_samples[256];

    while (1) {
        i2s_read(I2S_PORT, (void *)raw_samples, sizeof(raw_samples), &bytes_read, portMAX_DELAY);
        int samples_read = bytes_read / sizeof(int32_t);

        for (int i = 0; i < samples_read; i++) {
            int16_t sample = raw_samples[i] >> 14; 

            inference.buffers[inference.buf_idx][inference.buf_count++] = sample;

            if (inference.buf_count >= inference.buf_req_captured) {
                inference.buf_idx ^= 1; 
                inference.buf_count = 0;
                inference.is_ready = true;
            }
        }
    }
}

// ===================================================================
// 5. ระบบ Network / HTTP Upload / MQTT
// ===================================================================
void delayWithMqtt(unsigned long ms) {
    unsigned long start = millis();
    while (millis() - start < ms) {
        client.loop();
        delay(10);
    }
}

void setupWifi() {
    delay(10);
    Serial.println();
    Serial.print("📡 กำลังเชื่อมต่อ Wi-Fi: ");
    Serial.println(ssid);

    WiFi.begin(ssid, password);
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\n✅ เชื่อมต่อ Wi-Fi สำเร็จ!");
    Serial.print("🆔 Device ID: ");
    Serial.println(getDeviceID());
}

// ฟังก์ชันส่งไฟล์เสียง WAV ผ่าน HTTP Multipart POST
void uploadAudioToServer(int16_t* audio_buffer, size_t sample_count, int snore_prob, bool is_inflated) {
    if (WiFi.status() != WL_CONNECTED) return;

    WiFiClientSecure netClient;
    netClient.setInsecure(); // ข้ามการยืนยัน Certificate เพื่อความสะดวกรวดเร็ว

    String boundary = "----ESP32Boundary7MA4YWxkTrZu0gW";
    String myDeviceId = getDeviceID();

    uint32_t pcmDataSize = sample_count * sizeof(int16_t);
    
    WAVHeader wavHeader;
    wavHeader.subchunk2Size = pcmDataSize;
    wavHeader.chunkSize = 36 + pcmDataSize;

    String head = "--" + boundary + "\r\n";
    head += "Content-Disposition: form-data; name=\"device_id\"\r\n\r\n" + myDeviceId + "\r\n";
    head += "--" + boundary + "\r\n";
    head += "Content-Disposition: form-data; name=\"snore_prob\"\r\n\r\n" + String(snore_prob) + "\r\n";
    head += "--" + boundary + "\r\n";
    head += "Content-Disposition: form-data; name=\"is_inflated\"\r\n\r\n" + String(is_inflated ? "true" : "false") + "\r\n";
    head += "--" + boundary + "\r\n";
    head += "Content-Disposition: form-data; name=\"audio\"; filename=\"snore.wav\"\r\n";
    head += "Content-Type: audio/wav\r\n\r\n";

    String tail = "\r\n--" + boundary + "--\r\n";
    uint32_t totalLength = head.length() + sizeof(WAVHeader) + pcmDataSize + tail.length();

    Serial.println("🌐 กำลังอัปโหลดไฟล์เสียงกรนไปยัง Server...");

    if (netClient.connect(server_host, server_port)) {
        netClient.println("POST /api/upload-audio HTTP/1.1");
        netClient.println("Host: " + String(server_host));
        netClient.println("Content-Type: multipart/form-data; boundary=" + boundary);
        netClient.println("Content-Length: " + String(totalLength));
        netClient.println("Connection: close");
        netClient.println();

        netClient.print(head);                                            
        netClient.write((uint8_t*)&wavHeader, sizeof(WAVHeader));          
        netClient.write((uint8_t*)audio_buffer, pcmDataSize);             
        netClient.print(tail);                                            

        Serial.println("✅ ส่งไฟล์เสียงสำเร็จ!");
        netClient.stop();
    } else {
        Serial.println("❌ ไม่สามารถเชื่อมต่อ HTTP Server ได้");
    }
}

void sendSnoreToMQTT(int snoreProb, bool isInflated) {
    if (!client.connected()) return;

    StaticJsonDocument<200> doc;
    doc["device_id"] = getDeviceID();
    doc["snore_prob"] = snoreProb;
    doc["is_inflated"] = isInflated;

    char jsonBuffer[200];
    serializeJson(doc, jsonBuffer);

    String topic = String("smartpillow/") + getDeviceID() + "/snore";
    client.publish(topic.c_str(), jsonBuffer);
    Serial.printf("🚀 [MQTT Sent] %s -> %s\n", topic.c_str(), jsonBuffer);
}

void callback(char* topic, byte* payload, unsigned int length) {
    String message = "";
    for (unsigned int i = 0; i < length; i++) {
        message += (char)payload[i];
    }
    Serial.printf("\n📩 MQTT Received [%s]: %s\n", topic, message.c_str());

    StaticJsonDocument<250> doc;
    DeserializationError error = deserializeJson(doc, message);
    if (error) return;

    String strTopic = String(topic);

    if (strTopic.endsWith("/airbag/command")) {
        // เช็คว่ามีคีย์ "action" ใน JSON หรือไม่ เพื่อป้องกัน Crash (Null Pointer Exception)
        if (doc.containsKey("action") && !doc["action"].isNull()) {
            const char* action = doc["action"]; 
            
            if (strcmp(action, "INFLATE") == 0 || strcmp(action, "ON") == 0) {
                digitalWrite(VALVE_PIN, RELAY_ON);
                digitalWrite(PUMP_PIN, RELAY_ON);
                Serial.println("--> [Manual] สั่งเปิดปั๊มลมและปิดวาล์วเพื่อพองลม");
            } else if (strcmp(action, "DEFLATE") == 0) {
                digitalWrite(PUMP_PIN, RELAY_OFF);
                digitalWrite(VALVE_PIN, RELAY_OFF); // เปิดวาล์วระบายลม
                Serial.println("--> [Manual] สั่งเปิดวาล์วเพื่อยุบลม");
            } else if (strcmp(action, "STOP") == 0) {
                digitalWrite(PUMP_PIN, RELAY_OFF);
                digitalWrite(VALVE_PIN, RELAY_ON); // ปิดทั้งปั๊มและวาล์วเพื่อคงระดับลมไว้
                Serial.println("--> [Manual] สั่งหยุดทำงาน");
            }
        }
    } 
    else if (strTopic.endsWith("/settings")) {
        // รองรับการรับค่า Auto Mode จากหน้า Web Dashboard
        if (doc.containsKey("auto_mode")) {
            autoMode = doc["auto_mode"].as<bool>();
            Serial.printf("--> [Settings] อัปเดต Auto Mode เป็น: %s\n", autoMode ? "ON" : "OFF");
        }
    }
}

void reconnectMqtt() {
    while (!client.connected()) {
        Serial.print("🔄 กำลังเชื่อมต่อ MQTT Broker...");
        String clientId = "ESP32_Pillow_";
        clientId += String(random(0xffff), HEX);

        if (client.connect(clientId.c_str())) {
            Serial.println(" สำเร็จ!");

            String cmdTopic = String("smartpillow/") + getDeviceID() + "/airbag/command";
            String settingsTopic = String("smartpillow/") + getDeviceID() + "/settings";

            client.subscribe(cmdTopic.c_str());
            client.subscribe(settingsTopic.c_str());
        } else {
            Serial.print(" ล้มเหลว (rc=");
            Serial.print(client.state());
            Serial.println(") ลองใหม่ใน 5 วินาที");
            delay(5000);
        }
    }
}

// ===================================================================
// 6. Setup
// ===================================================================
void setup() {
    Serial.begin(115200);
    while (!Serial);

    ei_printf("=== ESP32 Real-time Snore Detection & Smart Pillow ===\n");

    pinMode(PUMP_PIN, OUTPUT);
    pinMode(VALVE_PIN, OUTPUT);
    digitalWrite(PUMP_PIN, RELAY_OFF);
    digitalWrite(VALVE_PIN, RELAY_OFF);

    setupWifi();
    client.setServer(mqtt_server, mqtt_port);
    client.setCallback(callback);

    inference.buffers[0] = (int16_t *)malloc(EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE * sizeof(int16_t));
    inference.buffers[1] = (int16_t *)malloc(EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE * sizeof(int16_t));
    
    if (inference.buffers[0] == NULL || inference.buffers[1] == NULL) {
        ei_printf("ERROR: Failed to allocate memory for audio buffers!\n");
        return;
    }

    inference.buf_idx = 0;
    inference.buf_count = 0;
    inference.buf_req_captured = EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE;
    inference.is_ready = false;

    i2s_init();
    xTaskCreate(capture_samples, "CaptureTask", 1024 * 4, NULL, 10, NULL);

    ei_printf("System Ready. Listening for snoring sounds...\n");
}

// ===================================================================
// 7. Main Loop Process
// ===================================================================
void loop() {
    if (!client.connected()) {
        reconnectMqtt();
    }
    client.loop();

    if (!inference.is_ready) {
        delay(10);
        return;
    }

    inference.is_ready = false;

    signal_t signal;
    signal.total_length = EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE;
    signal.get_data = &microphone_audio_signal_get_data;

    ei_impulse_result_t result = { 0 };

    EI_IMPULSE_ERROR r = run_classifier(&signal, &result, debug_nn);
    if (r != EI_IMPULSE_OK) {
        ei_printf("ERR: Failed to run classifier (%d)\n", r);
        return;
    }

    float snore_score = 0.0;
    for (size_t ix = 0; ix < EI_CLASSIFIER_LABEL_COUNT; ix++) {
        if (strcmp(result.classification[ix].label, "snore") == 0) {
            snore_score = result.classification[ix].value;
        }
    }

    ei_printf("Snore Probability: %.2f%%\n", snore_score * 100.0);

    // Logic 1: ตรวจสอบหมดเวลา 10 วินาที
    if (snore_count > 0 && (millis() - snore_window_start > WINDOW_TIME_MS)) {
        ei_printf(">>> [Timer] 10s Window Expired! Counter reset to 0 <<<\n");
        snore_count = 0;
        snore_window_start = 0;
    }

    // Logic 2: ตรวจพบเสียงกรนเกิน 80%
    if (snore_score >= SNORE_THRESHOLD) {
        if (snore_count == 0) {
            snore_window_start = millis();
            snore_count = 1;
            ei_printf(">>> [Snore #1] Started 10s Window. Count: 1/%d <<<\n", REQUIRED_SNORES);
        } else {
            snore_count++;
            unsigned long time_left = (WINDOW_TIME_MS - (millis() - snore_window_start)) / 1000;
            ei_printf(">>> [Snore Detected] Count: %d/%d (Time left: %lu s) <<<\n", 
                      snore_count, REQUIRED_SNORES, time_left);
        }
    }

    // Logic 3: ครบเงื่อนไข 3 ครั้งภายใน 10 วินาที
    if (snore_count >= REQUIRED_SNORES) {
        int snoreProbPercent = (int)(snore_score * 100.0);

        ei_printf("\n==================================================\n");
        ei_printf(">>> CONFIRMED SNORE (%d Snores in 10s)! <<<\n", REQUIRED_SNORES);

        // 1. ส่งไฟล์เสียง WAV ขึ้น HTTP Server
        uploadAudioToServer(
            inference.buffers[inference.buf_idx ^ 1], 
            EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE, 
            snoreProbPercent, 
            autoMode
        );

        // 2. ส่งสถานะผ่าน MQTT
        sendSnoreToMQTT(snoreProbPercent, autoMode);

        // 3. ทำการอัดลมหากอยู่ใน Auto Mode
        if (autoMode) {
            ei_printf(">>> Action: Inflating Pillow Cushion... <<<\n");
            digitalWrite(VALVE_PIN, RELAY_ON);
            digitalWrite(PUMP_PIN, RELAY_ON);

            delayWithMqtt(5000); // เติมลม 5 วินาที

            digitalWrite(PUMP_PIN, RELAY_OFF);
            ei_printf(">>> Inflate Complete. System reset for next cycle. <<<\n");
        } else {
            ei_printf(">>> Auto Mode is OFF. Only logging snore event. <<<\n");
        }

        snore_count = 0;
        snore_window_start = 0;
    }
}