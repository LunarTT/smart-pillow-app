const mqtt = require('mqtt');

// เชื่อมต่อเข้ากับ HiveMQ Broker
const BROKER_URL = 'mqtt://broker.hivemq.com:1883';
const client = mqtt.connect(BROKER_URL);

// =========================================================
// ⚙️ ตั้งค่า รหัสหมอน ให้ตรงกับใน Database/Dashboard ของคุณ
// =========================================================
const DEVICE_ID = 'pillow-003'; 
// =========================================================

const SENSOR_TOPIC = `smartpillow/${DEVICE_ID}/sensor`;
const SNORE_TOPIC = `smartpillow/${DEVICE_ID}/snore`;
const COMMAND_TOPIC = `smartpillow/${DEVICE_ID}/airbag/command`;
const SETTINGS_TOPIC = `smartpillow/${DEVICE_ID}/settings`;

// 1. Event เมื่อเชื่อมต่อ MQTT Broker สำเร็จ
client.on('connect', () => {
  console.log('====================================================');
  console.log(`🤖 ESP32 Hardware Simulator Connected! (ID: ${DEVICE_ID})`);
  console.log('====================================================');

  // Subscribe รอรับคำสั่งคุมถุงลม และคำสั่งเปลี่ยนโหมด Auto
  client.subscribe([COMMAND_TOPIC, SETTINGS_TOPIC], (err) => {
    if (!err) {
      console.log(`📡 Subscribed to Airbag Commands: ${COMMAND_TOPIC}`);
      console.log(`⚙️ Subscribed to Settings Commands: ${SETTINGS_TOPIC}`);
    }
  });
});

// 2. จำลองการส่งค่าอุณหภูมิและความชื้นทุกๆ 5 วินาที
setInterval(() => {
  if (!client.connected) return;

  const temp = (24 + Math.random() * 3).toFixed(1); // สุ่มอุณหภูมิ 24.0 - 27.0 °C
  const hum = (50 + Math.random() * 15).toFixed(1);  // สุ่มความชื้น 50.0 - 65.0 %

  const payload = JSON.stringify({
    device_id: DEVICE_ID,
    temperature: parseFloat(temp),
    humidity: parseFloat(hum)
  });

  client.publish(SENSOR_TOPIC, payload);
  console.log(`📊 [Sensor Telemetry Sent] Temp: ${temp}°C | Humidity: ${hum}%`);
}, 5000);

// 3. จำลองการตรวจจับเสียงกรนทุกๆ 15 วินาที (แบบไม่ใส่ user_id ให้ Server หาเอง)
setInterval(() => {
  if (!client.connected) return;

  const snoreProb = Math.floor(Math.random() * 40) + 60; // สุ่มความน่าจะเป็นกรน 60% - 99%
  const isInflated = snoreProb > 75;

  const payload = JSON.stringify({
    device_id: DEVICE_ID,
    snore_prob: snoreProb,
    is_inflated: isInflated
  });

  client.publish(SNORE_TOPIC, payload);
  console.log(`🚨 [Snore Event Detected] Device: ${DEVICE_ID} | Prob: ${snoreProb}% | Inflated: ${isInflated}`);
}, 15000);

// 4. แสดงการทำงานเมื่อรับคำสั่งสั่งงานจาก Web Dashboard
client.on('message', (topic, message) => {
  try {
    const data = JSON.parse(message.toString());

    // คำสั่งควบคุมถุงลม Manual
    if (topic === COMMAND_TOPIC) {
      console.log(`🎈 [ESP32 Airbag Action] Zone: ${data.zone || 'All'} -> State: ${data.action || data.status}`);
    }

    // คำสั่งเปิด/ปิด Auto Mode
    if (topic === SETTINGS_TOPIC) {
      console.log(`⚙️ [ESP32 Setting Updated] Auto Mode set to: ${data.auto_mode}`);
    }
  } catch (e) {
    console.log(`📩 Command received on ${topic}: ${message.toString()}`);
  }
});

// 5. จัดการ Error
client.on('error', (err) => {
  console.error('❌ MQTT Error:', err);
});