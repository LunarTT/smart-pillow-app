const express = require('express');
const mqtt = require('mqtt');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// ให้ Express ชี้ไปที่โฟลเดอร์ public เพื่อแสดงหน้าเว็บ index.html
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// คีย์ลับสำหรับสร้าง JWT Token
const JWT_SECRET = 'my_super_secret_key_123';

// --- 1. เชื่อมต่อฐานข้อมูล PostgreSQL ---
const pool = new Pool({
  user: 'postgres',          // Username ของ PostgreSQL
  host: 'localhost',         // IP ของ Database Server
  database: 'smart_pillow',   // ชื่อฐานข้อมูล
  password: 'as12301230',    // รหัสผ่านของคุณ
  port: 5432,
});

// --- 2. เชื่อมต่อ MQTT Broker ---
const mqttBrokerUrl = 'mqtt://broker.hivemq.com:1883';
const mqttClient = mqtt.connect(mqttBrokerUrl);

mqttClient.on('connect', () => {
  console.log('✅ Connected to HiveMQ MQTT Broker');
  mqttClient.subscribe('smartpillow/+/telemetry');
  mqttClient.subscribe('smartpillow/+/sensors');
});

// เมื่อมีข้อมูลส่งมาจาก ESP32 ผ่าน MQTT -> บันทึกลง PostgreSQL
mqttClient.on('message', async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    console.log('[MQTT Telemetry Received]:', data);

    // บันทึกข้อมูลเหตุการณ์กรน
    if (data.snore_prob && data.snore_prob >= 50) {
      const queryText = `
        INSERT INTO snore_events (device_id, snore_prob, is_inflated, audio_url)
        VALUES ($1, $2, $3, $4)
      `;
      await pool.query(queryText, [
        data.device_id, 
        data.snore_prob, 
        data.is_inflated, 
        data.audio_url || '/uploads/demo.mp3'
      ]);
      console.log('💾 Saved snore event to Database');
    }

    // บันทึกค่าเซนเซอร์อุณหภูมิและความชื้น
    if (data.temperature !== undefined && data.humidity !== undefined) {
      const sensorQuery = `
        INSERT INTO sensor_data (device_id, temperature, humidity)
        VALUES ($1, $2, $3)
      `;
      await pool.query(sensorQuery, [data.device_id, data.temperature, data.humidity]);
      console.log('🌡️ Saved sensor data to Database');
    }
  } catch (err) {
    console.error('Failed to process MQTT message:', err.message);
  }
});

// Middleware: ตรวจสอบ Token ความปลอดภัย
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ success: false, message: 'Access Denied: No Token Provided' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, message: 'Invalid or Expired Token' });
    req.user = user;
    next();
  });
};

// --- Authentication APIs ---
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username, email, hashedPassword]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(400).json({ success: false, error: 'Username or Email already exists' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'User not found' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(400).json({ success: false, message: 'Invalid Password' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      token: token,
      user: { id: user.id, username: user.username, email: user.email }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// [POST] สมัครสมาชิกใหม่
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
  }

  try {
    // 1. เข้ารหัสรหัสผ่านก่อนเก็บลงฐานข้อมูล
    const hashedPassword = await bcrypt.hash(password, 10);

    // 2. บันทึกลงตาราง users
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username, email, hashedPassword]
    );

    res.json({ 
      success: true, 
      message: 'สมัครสมาชิกสำเร็จ! กรุณาเข้าสู่ระบบ',
      user: result.rows[0] 
    });
  } catch (err) {
    // หาก Email หรือ Username ซ้ำในระบบ
    res.status(400).json({ success: false, message: 'อีเมลหรือชื่อผู้ใช้นี้มีในระบบแล้ว' });
  }
});

// --- Dashboard & Data APIs ---

// [GET] ดึงสรุปผลสำหรับ Carousel หน้าแรก (คะแนนการนอน, สภาพแวดล้อม, กราฟการกรน)
app.get('/api/dashboard/summary', authenticateToken, async (req, res) => {
  try {
    // 1. ดึงอุณหภูมิและความชื้นล่าสุด
    const envResult = await pool.query('SELECT temperature, humidity FROM sensor_data ORDER BY created_at DESC LIMIT 1');
    
    // 2. ดึงประวัติการกรน 5 ครั้งล่าสุดเพื่อแสดงในกราฟ
    const snoreResult = await pool.query('SELECT snore_prob, created_at FROM snore_events ORDER BY created_at ASC LIMIT 5');

    // 3. คำนวณคะแนนการนอน (คะแนนเต็ม 100 หักตามจำนวนการกรน)
    const snoreCount = snoreResult.rowCount;
    let sleepScore = Math.max(50, 100 - (snoreCount * 4));

    const chartLabels = snoreResult.rows.map((row, idx) => {
      const time = new Date(row.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
      return `#${idx + 1} (${time})`;
    });

    const chartData = snoreResult.rows.map(row => row.snore_prob);

    res.json({
      success: true,
      sleepScore: sleepScore,
      temp: envResult.rows[0]?.temperature || 25.4,
      humid: envResult.rows[0]?.humidity || 55,
      chartLabels: chartLabels.length > 0 ? chartLabels : ['#1 (01:15)', '#2 (02:30)', '#3 (03:45)', '#4 (05:10)', '#5 (06:00)'],
      chartData: chartData.length > 0 ? chartData : [58, 72, 65, 80, 60]
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// [GET] ดึงประวัติการกรนทั้งหมด
app.get('/api/snore-events', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM snore_events ORDER BY created_at DESC LIMIT 50');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// [DELETE] ล้างประวัติการนอนทั้งหมด
app.delete('/api/snore-events', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM snore_events');
    res.json({ success: true, message: 'ล้างข้อมูลประวัติการนอนทั้งหมดเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// [POST] ส่งคำสั่ง Auto Mode ไป MQTT
app.post('/api/settings', authenticateToken, (req, res) => {
  const { device_id, auto_mode } = req.body;
  if (!device_id) return res.status(400).json({ success: false, message: 'device_id is required' });

  const topic = `smartpillow/${device_id}/settings`;
  const payload = JSON.stringify({ auto_mode });

  mqttClient.publish(topic, payload, () => {
    res.json({ success: true, message: `Updated auto_mode to ${auto_mode}` });
  });
});

// [POST] คำสั่งสั่งงานถุงลม Manual
app.post('/api/control', authenticateToken, (req, res) => {
  const { device_id, zone, action } = req.body;
  const topic = `smartpillow/${device_id}/airbag/command`;
  const payload = JSON.stringify({ zone, action });

  mqttClient.publish(topic, payload, () => {
    res.json({ success: true, message: `Sent manual command ${action} to zone ${zone}` });
  });
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`🚀 Web Server is running on http://localhost:${PORT}`);
});
