#include <Arduino.h>
#include <LunarTxT-project-1_inferencing.h>
#include "driver/i2s.h"

// กำหนด Pin I2S สำหรับ INMP441
#define I2S_WS   25  // สัญญาณ Word Select
#define I2S_SD   32  // สัญญาณ Serial Data (แก้ไขจาก 33 เป็น 32)
#define I2S_SCK  14  // สัญญาณ Serial Clock (แก้ไขจาก 32 เป็น 14)
#define I2S_PORT I2S_NUM_0

// โครงสร้าง Buffer สำหรับเก็บข้อมูลเสียง
typedef struct {
    int16_t *buffers[2];
    uint8_t buf_idx;
    uint32_t buf_count;
    uint32_t buf_req_captured;
    bool is_ready;
} inference_t;

static inference_t inference;
static bool debug_nn = false;

// -------------------------------------------------------------------
// 1. ตั้งค่าการเชื่อมต่อ I2S
// -------------------------------------------------------------------
void i2s_init() {
    i2s_config_t i2s_config = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
        .sample_rate = EI_CLASSIFIER_FREQUENCY, // 16000 Hz ตามที่เทรนใน Edge Impulse
        .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT, // INMP441 ส่งข้อมูล 24-bit ใน frame 32-bit
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

// -------------------------------------------------------------------
// 2. Callback สำหรับส่งข้อมูล Audio เข้าโมเดล
// -------------------------------------------------------------------
static int microphone_audio_signal_get_data(size_t offset, size_t length, float *out_ptr) {
    numpy::int16_to_float(&inference.buffers[inference.buf_idx ^ 1][offset], out_ptr, length);
    return 0;
}

// -------------------------------------------------------------------
// 3. Task อ่านค่าไมโครโฟนต่อเนื่อง (FreeRTOS Background Task)
// -------------------------------------------------------------------
void capture_samples(void *arg) {
    size_t bytes_read = 0;
    int32_t raw_samples[256];

    while (1) {
        // อ่านค่า RAW I2S แบบ 32-bit
        i2s_read(I2S_PORT, (void *)raw_samples, sizeof(raw_samples), &bytes_read, portMAX_DELAY);
        int samples_read = bytes_read / sizeof(int32_t);

        for (int i = 0; i < samples_read; i++) {
            // แปลงสัญญาณ 24-bit ภายใน 32-bit Frame ให้อยู่ในรูปแบบ PCM 16-bit
            int16_t sample = raw_samples[i] >> 14; 

            inference.buffers[inference.buf_idx][inference.buf_count++] = sample;

            if (inference.buf_count >= inference.buf_req_captured) {
                inference.buf_idx ^= 1; // สลับ Buffer
                inference.buf_count = 0;
                inference.is_ready = true;
            }
        }
    }
}

// -------------------------------------------------------------------
// 4. Setup & Loop
// -------------------------------------------------------------------
void setup() {
    Serial.begin(115200);
    while (!Serial);

    ei_printf("Initializing Real-time Snore Detection...\n");

    // จอง memory สำหรับ Audio Buffers
    inference.buffers[0] = (int16_t *)malloc(EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE * sizeof(int16_t));
    inference.buffers[1] = (int16_t *)malloc(EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE * sizeof(int16_t));
    
    if (inference.buffers[0] == NULL || inference.buffers[1] == NULL) {
        ei_printf("Failed to allocate audio buffer memory!\n");
        return;
    }

    inference.buf_idx = 0;
    inference.buf_count = 0;
    inference.buf_req_captured = EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE;
    inference.is_ready = false;

    // เริ่มต้น I2S
    i2s_init();

    // สร้าง Background Task สำหรับอ่านเสียงเฉพาะ
    xTaskCreate(capture_samples, "CaptureTask", 1024 * 4, NULL, 10, NULL);

    ei_printf("Listening for snoring...\n");
}

void loop() {
    // รอจนกว่า Buffer จะเก็บข้อมูลเสียงครบตามขนาดที่โมเดลต้องการ
    if (!inference.is_ready) {
        delay(10);
        return;
    }

    inference.is_ready = false;

    signal_t signal;
    signal.total_length = EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE;
    signal.get_data = &microphone_audio_signal_get_data;

    ei_impulse_result_t result = { 0 };

    // เรียกประมวลผลการจำแนกประเภทเสียง
    EI_IMPULSE_ERROR r = run_classifier(&signal, &result, debug_nn);
    if (r != EI_IMPULSE_OK) {
        ei_printf("ERR: Failed to run classifier (%d)\n", r);
        return;
    }

    // วิเคราะห์ผลลัพธ์
    float snore_score = 0.0;
    
    for (size_t ix = 0; ix < EI_CLASSIFIER_LABEL_COUNT; ix++) {
        if (strcmp(result.classification[ix].label, "snoring") == 0) {
            snore_score = result.classification[ix].value;
        }
    }

    // แสดงผลบน Serial Monitor
    ei_printf("Snore Probability: %.2f%%\n", snore_score * 100.0);

    // เงื่อนไขแจ้งเตือนเมื่อตรวจพบเสียงกรน
    if (snore_score >= 0.80) { // Threshold 80%
        ei_printf(">>> ALERT: Snoring Detected! <<<\n");
        // สามารถใส่โค้ดสั่งงานเพิ่มเติม เช่น สั่งเปิดมอเตอร์สั่น หรือส่ง Line Notification
    }
}