#include <driver/i2s.h>

// กำหนดขาพินไมโครโฟน INMP441 (I2S)
#define I2S_WS   25
#define I2S_SD   32
#define I2S_SCK  14
#define I2S_PORT I2S_NUM_0

// กำหนดขาพินบอร์ดรีเลย์
#define RELAY_PUMP  26  // IN1: ควบคุมปั๊มลม
#define RELAY_VALVE 27  // IN2: ควบคุมโซลินอยด์วาล์ว

// บอร์ดรีเลย์ส่วนใหญ่เป็น Active LOW (LOW = ติด/ทำงาน, HIGH = ดับ)
#define RELAY_ON  LOW
#define RELAY_OFF HIGH

void setupI2S() {
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = 16000,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = i2s_comm_format_t(I2S_COMM_FORMAT_STAND_I2S),
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 4,
    .dma_buf_len = 512,
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

void setup() {
  Serial.begin(115200);

  // ตั้งค่าขาควบคุมรีเลย์
  pinMode(RELAY_PUMP, OUTPUT);
  pinMode(RELAY_VALVE, OUTPUT);

  // สถานะเริ่มต้น: ปิดทั้งปั๊มและวาล์ว
  digitalWrite(RELAY_PUMP, RELAY_OFF);
  digitalWrite(RELAY_VALVE, RELAY_OFF);

  setupI2S();
  Serial.println(">>> System Ready: Testing INMP441 & Relay Logic <<<");
}

void loop() {
  int32_t raw_samples[128];
  size_t bytes_read = 0;

  // อ่านค่าสัญญาณดิจิทัลจากไมโครโฟน
  i2s_read(I2S_PORT, &raw_samples, sizeof(raw_samples), &bytes_read, portMAX_DELAY);

  int samples_read = bytes_read / sizeof(int32_t);
  if (samples_read > 0) {
    float sum = 0;
    for (int i = 0; i < samples_read; i++) {
      sum += abs(raw_samples[i] >> 14); // ปรับทอนค่าความดังให้อยู่ในระดับที่มองเห็นง่าย
    }
    float sound_level = sum / samples_read;

    // แสดงค่าความดังเสียงออกทาง Serial
    Serial.print("Sound_Level:");
    Serial.println(sound_level);

    // ทดสอบ: ถ้าลองปรบมือหรือส่งเสียงดังจนค่าความดังเกิน 3000
    if (sound_level > 10000) {
      Serial.println(">>> Sound Detected! Triggering Relays... <<<");
      
      // สั่งรีเลย์ทำงาน (ไฟ LED บนบอร์ดรีเลย์จะติด + มีเสียงคลิก)
      digitalWrite(RELAY_PUMP, RELAY_ON);
      digitalWrite(RELAY_VALVE, RELAY_ON);
      
      delay(2000); // จำลองการอัดลม 2 วินาที

      // สั่งปิดรีเลย์
      digitalWrite(RELAY_PUMP, RELAY_OFF);
      digitalWrite(RELAY_VALVE, RELAY_OFF);
      Serial.println(">>> Relays OFF <<<");
    }
  }
  delay(50);
}