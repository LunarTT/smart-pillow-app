const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(cors());

// ตรวจสอบและสร้างโฟลเดอร์ uploads
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const JWT_SECRET = process.env.JWT_SECRET || 'pillow_super_secret_key_2026';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ปรับปรุงการสร้าง DB Table (ตัด sensor_data ออก)
const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        device_id VARCHAR(50) DEFAULT 'pillow-001',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS snore_events (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        device_id VARCHAR(50) DEFAULT 'pillow-001',
        snore_prob INT NOT NULL CHECK (snore_prob BETWEEN 0 AND 100),
        is_inflated BOOLEAN DEFAULT FALSE,
        audio_url TEXT DEFAULT '/uploads/demo.mp3',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Database tables initialized successfully');
  } catch (err) {
    console.error('❌ Error initializing database tables:', err.message);
  }
};
initDb();

// --- MQTT & Socket.io Integration ---
const mqttBrokerUrl = 'mqtt://broker.hivemq.com:1883';
const mqttClient = mqtt.connect(mqttBrokerUrl);

mqttClient.on('connect', () => {
  console.log('✅ Connected to HiveMQ MQTT Broker');
  mqttClient.subscribe('smartpillow/+/snore');
  mqttClient.subscribe('smartpillow/+/telemetry');
});

io.on('connection', (socket) => {
  console.log('⚡ Web Client Connected to Socket.io:', socket.id);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    const deviceId = data.device_id || 'pillow-001';

    // ส่งข้อมูลแบบ Real-time ไปหน้าเว็บผ่าน Socket.io
    io.emit('realtime_sensor_update', data);

    // ค้นหา User ID จาก device_id แล้วบันทึกเฉพาะ snore_events ลง Neon DB
    const userRes = await pool.query('SELECT id FROM users WHERE device_id = $1 LIMIT 1', [deviceId]);
    const userId = userRes.rows.length > 0 ? userRes.rows[0].id : (data.user_id || 1);

    if (data.snore_prob !== undefined) {
      await pool.query(
        'INSERT INTO snore_events (user_id, device_id, snore_prob, is_inflated, audio_url) VALUES ($1, $2, $3, $4, $5)',
        [userId, deviceId, data.snore_prob, data.is_inflated || false, data.audio_url || '/uploads/demo.mp3']
      );
    }
  } catch (err) {
    console.error('❌ Failed to process MQTT message:', err.message);
  }
});

// Middleware & Auth APIs
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Access Denied' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, message: 'Invalid Token' });
    req.user = user;
    next();
  });
};

app.post('/api/auth/register', async (req, res) => {
  const { username, email, password, device_id } = req.body;
  if (!username || !email || !password) return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const assignedDevice = device_id || 'pillow-001';
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash, device_id) VALUES ($1, $2, $3, $4) RETURNING id, username, email, device_id',
      [username, email, hashedPassword, assignedDevice]
    );
    res.json({ success: true, message: 'สมัครสมาชิกสำเร็จ!', user: result.rows[0] });
  } catch (err) {
    res.status(400).json({ success: false, message: err.code === '23505' ? 'อีเมลหรือชื่อผู้ใช้นี้มีในระบบแล้ว' : 'เกิดข้อผิดพลาด' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ success: false, message: 'ไม่พบบัญชีผู้ใช้นี้' });

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(400).json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });

    const token = jwt.sign(
      { id: user.id, username: user.username, device_id: user.device_id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ success: true, token, user: { id: user.id, username: user.username, email: user.email, device_id: user.device_id } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/user/pair-device', authenticateToken, async (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ success: false, message: 'กรุณาระบุรหัสหมอน' });
  try {
    await pool.query('UPDATE users SET device_id = $1 WHERE id = $2', [device_id, req.user.id]);
    res.json({ success: true, message: `จับคู่หมอนรหัส ${device_id} สำเร็จ!` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// API Dashboard Summary (ตัดเซนเซอร์สภาพแวดล้อมออก เหลือเฉพาะข้อมูลสถิติการกรน)
app.get('/api/dashboard/summary', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const snoreResult = await pool.query(
      'SELECT snore_prob, created_at FROM snore_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5',
      [userId]
    );

    let sleepScore = null;
    let chartLabels = [];
    let chartData = [];

    if (snoreResult.rows.length > 0) {
      sleepScore = Math.max(50, 100 - (snoreResult.rows.length * 4));
      const snoreRows = [...snoreResult.rows].reverse();
      chartLabels = snoreRows.map((row, idx) => `#${idx + 1} (${new Date(row.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })})`);
      chartData = snoreRows.map(row => parseFloat(row.snore_prob));
    }

    res.json({ success: true, sleepScore, chartLabels, chartData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/snore-events', authenticateToken, async (req, res) => {
  try {
    const { date } = req.query;
    let query = 'SELECT * FROM snore_events WHERE user_id = $1';
    let params = [req.user.id];
    if (date) { 
      query += " AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Bangkok') = $2"; 
      params.push(date); 
    }
    query += ' ORDER BY created_at DESC LIMIT 50';

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/snore-events', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM snore_events WHERE user_id = $1', [req.user.id]);
    res.json({ success: true, message: 'ล้างข้อมูลประวัติการนอนเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/settings', authenticateToken, async (req, res) => {
  const { auto_mode, device_id } = req.body;
  const targetDeviceId = device_id || req.user.device_id || 'pillow-001';
  mqttClient.publish(`smartpillow/${targetDeviceId}/settings`, JSON.stringify({ auto_mode }), () => {
    res.json({ success: true, message: 'อัปเดต Auto Mode แล้ว' });
  });
});

app.post('/api/control', authenticateToken, async (req, res) => {
  const { zone, action, device_id } = req.body;
  const targetDeviceId = device_id || req.user.device_id || 'pillow-001';
  mqttClient.publish(`smartpillow/${targetDeviceId}/airbag/command`, JSON.stringify({ zone, action }), () => {
    res.json({ success: true, message: 'สั่งงานถุงลมสำเร็จ' });
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Web & Socket Server is running on port ${PORT}`);
});