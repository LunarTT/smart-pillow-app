const express = require('express');
const mqtt = require('mqtt');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());

// ตรวจสอบและสร้างโฟลเดอร์ uploads สำหรับเก็บไฟล์เสียงหากยังไม่มี
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ชี้จุดบริการไฟล์ Static ฝั่ง Web Dashboard
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// คีย์ลับ JWT Token
const JWT_SECRET = process.env.JWT_SECRET || 'pillow_super_secret_key_2026';

// เชื่อมต่อ PostgreSQL (Neon Database)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ฟังก์ชันสร้างตารางในฐานข้อมูลอัตโนมัติหากยังไม่มี
const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        device_id VARCHAR(50) DEFAULT 'pillow-001',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sensor_data (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        device_id VARCHAR(50),
        temperature NUMERIC(4, 1),
        humidity NUMERIC(4, 1),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS snore_events (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        device_id VARCHAR(50),
        snore_prob NUMERIC(5, 2),
        is_inflated BOOLEAN DEFAULT FALSE,
        audio_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Database tables initialized successfully');
  } catch (err) {
    console.error('❌ Error initializing database tables:', err.message);
  }
};
initDb();

// --- 1. เชื่อมต่อ MQTT Broker ---
const mqttBrokerUrl = 'mqtt://broker.hivemq.com:1883';
const mqttClient = mqtt.connect(mqttBrokerUrl);

mqttClient.on('connect', () => {
  console.log('✅ Connected to HiveMQ MQTT Broker');
  mqttClient.subscribe('smartpillow/+/sensor');
  mqttClient.subscribe('smartpillow/+/snore');
  mqttClient.subscribe('smartpillow/+/telemetry');
  mqttClient.subscribe('smartpillow/+/sensors');
});

// ประมวลผลข้อความ MQTT จาก ESP32 / Simulator
mqttClient.on('message', async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    const deviceId = data.device_id || 'pillow-001';

    // ค้นหา User ID ที่ผูกอยู่กับ device_id
    const userRes = await pool.query('SELECT id FROM users WHERE device_id = $1 LIMIT 1', [deviceId]);
    const userId = userRes.rows.length > 0 ? userRes.rows[0].id : (data.user_id || 1);

    // บันทึกข้อมูลสภาพแวดล้อม
    if (data.temperature !== undefined && data.humidity !== undefined) {
      await pool.query(
        'INSERT INTO sensor_data (user_id, device_id, temperature, humidity) VALUES ($1, $2, $3, $4)',
        [userId, deviceId, data.temperature, data.humidity]
      );
      console.log(`🌡️ Saved sensor data for User ID ${userId} (${deviceId})`);
    }

    // บันทึกข้อมูลเหตุการณ์กรน
    if (data.snore_prob !== undefined) {
      await pool.query(
        'INSERT INTO snore_events (user_id, device_id, snore_prob, is_inflated, audio_url) VALUES ($1, $2, $3, $4, $5)',
        [
          userId,
          deviceId,
          data.snore_prob,
          data.is_inflated || false,
          data.audio_url || '/uploads/demo.mp3'
        ]
      );
      console.log(`🚨 Saved snore event for User ID ${userId} (${deviceId})`);
    }
  } catch (err) {
    console.error('❌ Failed to process MQTT message:', err.message);
  }
});

// Middleware: ตรวจสอบ JWT Authentication Token
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

// [POST] สมัครสมาชิก
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password, device_id } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const assignedDevice = device_id || 'pillow-001';

    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash, device_id) VALUES ($1, $2, $3, $4) RETURNING id, username, email, device_id',
      [username, email, hashedPassword, assignedDevice]
    );

    res.json({
      success: true,
      message: 'สมัครสมาชิกสำเร็จ!',
      user: result.rows[0]
    });
  } catch (err) {
    console.error('Register Error:', err);
    res.status(400).json({
      success: false,
      message: err.code === '23505' ? 'อีเมล หรือ ชื่อผู้ใช้นี้มีในระบบแล้ว' : 'ไม่สามารถบันทึกข้อมูลลงฐานข้อมูลได้'
    });
  }
});

// [POST] เข้าสู่ระบบ
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'ไม่พบบัญชีผู้ใช้นี้ในระบบ' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(400).json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, device_id: user.device_id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token: token,
      user: { id: user.id, username: user.username, email: user.email, device_id: user.device_id }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// [POST] ผูกรหัสหมอนอัจฉริยะ (Pair Device)
app.post('/api/user/pair-device', authenticateToken, async (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ success: false, message: 'กรุณาระบุรหัสหมอน (device_id)' });

  try {
    await pool.query('UPDATE users SET device_id = $1 WHERE id = $2', [device_id, req.user.id]);
    res.json({ success: true, message: `จับคู่หมอนรหัส ${device_id} สำเร็จ!` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการจับคู่หมอน' });
  }
});

// --- Dashboard & Data APIs ---

// [GET] สรุปข้อมูลสำหรับ Dashboard
app.get('/api/dashboard/summary', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. ดึงสภาพแวดล้อมล่าสุด
    const envResult = await pool.query(
      'SELECT temperature, humidity FROM sensor_data WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [userId]
    );

    // 2. ดึงประวัติการกรน 5 ครั้งล่าสุด
    const snoreResult = await pool.query(
      'SELECT snore_prob, created_at FROM snore_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5',
      [userId]
    );

    const hasEnv = envResult.rows.length > 0;
    const temp = hasEnv ? parseFloat(envResult.rows[0].temperature) : null;
    const humid = hasEnv ? parseFloat(envResult.rows[0].humidity) : null;

    let sleepScore = null;
    let chartLabels = [];
    let chartData = [];

    if (snoreResult.rows.length > 0) {
      const snoreCount = snoreResult.rows.length;
      sleepScore = Math.max(50, 100 - (snoreCount * 4));

      const snoreRows = [...snoreResult.rows].reverse();
      chartLabels = snoreRows.map((row, idx) => {
        const time = new Date(row.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
        return `#${idx + 1} (${time})`;
      });
      chartData = snoreRows.map(row => parseFloat(row.snore_prob));
    }

    res.json({
      success: true,
      sleepScore,
      temp,
      humid,
      chartLabels,
      chartData
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// [GET] ดึงประวัติการกรน (รองรับการกรองตามวันที่ ?date=YYYY-MM-DD)
app.get('/api/snore-events', authenticateToken, async (req, res) => {
  try {
    const { date } = req.query;
    let query = 'SELECT * FROM snore_events WHERE user_id = $1';
    let params = [req.user.id];

    if (date) {
      query += ' AND DATE(created_at) = $2';
      params.push(date);
    }

    query += ' ORDER BY created_at DESC LIMIT 50';

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// [DELETE] ล้างประวัติการนอน
app.delete('/api/snore-events', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM snore_events WHERE user_id = $1', [req.user.id]);
    res.json({ success: true, message: 'ล้างข้อมูลประวัติการนอนของคุณเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// [POST] ส่งคำสั่ง Auto Mode ไปยัง MQTT
app.post('/api/settings', authenticateToken, async (req, res) => {
  const { auto_mode, device_id } = req.body;
  const targetDeviceId = device_id || req.user.device_id || 'pillow-001';

  const topic = `smartpillow/${targetDeviceId}/settings`;
  const payload = JSON.stringify({ auto_mode });

  mqttClient.publish(topic, payload, () => {
    res.json({ success: true, message: `อัปเดตสถานะ Auto Mode ของหมอน ${targetDeviceId} เป็น ${auto_mode}` });
  });
});

// [POST] ส่งคำสั่งควบคุมถุงลม Manual
app.post('/api/control', authenticateToken, async (req, res) => {
  const { zone, action, device_id } = req.body;
  const targetDeviceId = device_id || req.user.device_id || 'pillow-001';

  const topic = `smartpillow/${targetDeviceId}/airbag/command`;
  const payload = JSON.stringify({ zone, action });

  mqttClient.publish(topic, payload, () => {
    res.json({ success: true, message: `ส่งคำสั่ง ${action} ไปยังโซน ${zone} ของหมอน ${targetDeviceId} เรียบร้อย` });
  });
});

// กำหนด พอร์ต รองรับ Render.com (`process.env.PORT`)
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Web Server is running on port ${PORT}`);
});
