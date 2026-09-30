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

// ให้ Express ชี้ไปที่โฟลเดอร์ public สำหรับแสดง Web Dashboard
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// คีย์ลับ JWT Token (ใช้อ่านจาก Environment Variable บน Render หรือใช้ค่าเริ่มต้น)
const JWT_SECRET = process.env.JWT_SECRET || 'pillow_super_secret_key_2026';

// ตรวจสอบและเชื่อมต่อ PostgreSQL (Neon Database)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// --- 1. เชื่อมต่อ MQTT Broker ---
const mqttBrokerUrl = 'mqtt://broker.hivemq.com:1883';
const mqttClient = mqtt.connect(mqttBrokerUrl);

mqttClient.on('connect', () => {
  console.log('✅ Connected to HiveMQ MQTT Broker');
  // ดักฟัง Topic ให้ครอบคลุมทั้ง Simulator และ ESP32 จริง
  mqttClient.subscribe('smartpillow/+/sensor');
  mqttClient.subscribe('smartpillow/+/snore');
  mqttClient.subscribe('smartpillow/+/telemetry');
  mqttClient.subscribe('smartpillow/+/sensors');
});

// เมื่อมีข้อมูลจาก ESP32 / Simulator ผ่าน MQTT -> ค้นหา User ID แล้วบันทึกลงฐานข้อมูล
mqttClient.on('message', async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    const deviceId = data.device_id || 'pillow-001';

    // 1. ค้นหา User ID ที่ผูกอยู่กับ device_id นี้ในตาราง users
    const userRes = await pool.query('SELECT id FROM users WHERE device_id = $1 LIMIT 1', [deviceId]);
    // หากยังไม่ได้ผูกอุปกรณ์ ให้บันทึกเข้า User ID 1 เป็นค่าเริ่มต้น
    const userId = userRes.rows.length > 0 ? userRes.rows[0].id : (data.user_id || 1);

    // 2. บันทึกข้อมูลสภาพแวดล้อม (อุณหภูมิและความชื้น)
    if (data.temperature !== undefined && data.humidity !== undefined) {
      await pool.query(
        'INSERT INTO sensor_data (user_id, device_id, temperature, humidity) VALUES ($1, $2, $3, $4)',
        [userId, deviceId, data.temperature, data.humidity]
      );
      console.log(`🌡️ Saved sensor data for User ID ${userId} (${deviceId})`);
    }

    // 3. บันทึกข้อมูลเหตุการณ์กรน
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

// Middleware: ตรวจสอบ Token ความปลอดภัย (JWT Authentication)
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

// [POST] สมัครสมาชิกใหม่
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password, device_id } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const assignedDevice = device_id || 'pillow-001'; // Default อุปกรณ์เริ่มต้น

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
      message: err.code === '23505' ? 'อีเมล ชื่อผู้ใช้ หรือรหัสหมอนนี้มีในระบบแล้ว' : 'ไม่สามารถบันทึกข้อมูลลงฐานข้อมูลได้'
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

    // ฝัง user_id, username และ device_id ลงใน JWT Token
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

// [POST] ผูกรหัสหมอนอัจฉริยะ (Pair Device) เข้ากับบัญชีที่ล็อกอินอยู่
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

// [GET] สรุปข้อมูลสำหรับ Dashboard (ดึงเฉพาะข้อมูลของผู้ใช้ที่ล็อกอินอยู่)
app.get('/api/dashboard/summary', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. ดึงข้อมูลอุณหภูมิและความชื้นล่าสุดของผู้ใช้คนนี้
    const envResult = await pool.query(
      'SELECT temperature, humidity FROM sensor_data WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [userId]
    );

    // 2. ดึงประวัติการกรน 5 ครั้งล่าสุด
    const snoreResult = await pool.query(
      'SELECT snore_prob, created_at FROM snore_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5',
      [userId]
    );

    // 3. คำนวณคะแนนการนอน
    const snoreCount = snoreResult.rowCount;
    const sleepScore = Math.max(50, 100 - (snoreCount * 4));

    // เรียงย้อนกลับเพื่อให้เรียงลำดับเวลาจาก อดีต -> ปัจจุบัน ในกราฟ
    const snoreRows = snoreResult.rows.reverse();

    const chartLabels = snoreRows.map((row, idx) => {
      const time = new Date(row.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
      return `#${idx + 1} (${time})`;
    });

    const chartData = snoreRows.map(row => row.snore_prob);

    res.json({
      success: true,
      sleepScore: sleepScore,
      temp: envResult.rows[0]?.temperature || 25.0,
      humid: envResult.rows[0]?.humidity || 55.0,
      chartLabels: chartLabels.length > 0 ? chartLabels : ['#1 (01:15)', '#2 (02:30)', '#3 (03:45)'],
      chartData: chartData.length > 0 ? chartData : [60, 75, 80]
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// [GET] ดึงประวัติการกรนเฉพาะของผู้ใช้ที่ล็อกอินอยู่
app.get('/api/snore-events', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM snore_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// [DELETE] ล้างประวัติการนอนเฉพาะของผู้ใช้ที่ล็อกอินอยู่
app.delete('/api/snore-events', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM snore_events WHERE user_id = $1', [req.user.id]);
    res.json({ success: true, message: 'ล้างข้อมูลประวัติการนอนของคุณเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// [POST] ส่งคำสั่ง Auto Mode ไปยัง MQTT ของหมอนที่ผูกไว้
app.post('/api/settings', authenticateToken, async (req, res) => {
  const { auto_mode } = req.body;
  const deviceId = req.user.device_id || 'pillow-001';

  const topic = `smartpillow/${deviceId}/settings`;
  const payload = JSON.stringify({ auto_mode });

  mqttClient.publish(topic, payload, () => {
    res.json({ success: true, message: `อัปเดตสถานะ Auto Mode ของหมอน ${deviceId} เป็น ${auto_mode}` });
  });
});

// [POST] ส่งคำสั่งสั่งงานถุงลม Manual
app.post('/api/control', authenticateToken, async (req, res) => {
  const { zone, action } = req.body;
  const deviceId = req.user.device_id || 'pillow-001';

  const topic = `smartpillow/${deviceId}/airbag/command`;
  const payload = JSON.stringify({ zone, action });

  mqttClient.publish(topic, payload, () => {
    res.json({ success: true, message: `ส่งคำสั่ง ${action} ไปยังโซน ${zone} ของหมอน ${deviceId} เรียบร้อย` });
  });
});

// กำหนด พอร์ต ให้ยืดหยุ่นสำหรับรองรับ Render.com (`process.env.PORT`)
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Web Server is running on port ${PORT}`);
});
