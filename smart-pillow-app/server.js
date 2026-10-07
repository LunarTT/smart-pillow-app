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
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(cors());

// --- 1. ตั้งค่าโฟลเดอร์สำหรับ Static Files & Uploads ---
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 2. ตั้งค่า Multer สำหรับรับไฟล์เสียง WAV ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `snore-${uniqueSuffix}.wav`);
  }
});
const upload = multer({ storage: storage });

// --- 3. ตั้งค่าการเชื่อมต่อ Neon Database ---
const JWT_SECRET = process.env.JWT_SECRET || 'pillow_super_secret_key_2026';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// สร้าง Table เริ่มต้น
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

// --- 4. ระบบ MQTT & Socket.io ---
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

// [ปรับปรุงจุดนี้] ทำหน้าที่ส่งข้อมูล Realtime ไปยัง Dashboard ผ่าน Socket.io เท่านั้น (ไม่บันทึกซ้ำลง DB)
mqttClient.on('message', async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    const deviceId = data.device_id || 'pillow-001';

    // บรอดแคสต์ข้อมูลสดไปยังผู้ใช้งานผ่าน Socket.io
    io.emit('realtime_sensor_update', {
      device_id: deviceId,
      ...data
    });
  } catch (err) {
    console.error('❌ Failed to process MQTT message:', err.message);
  }
});

// --- 5. Middleware & Authentication APIs ---
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

// --- 6. REST APIs สำหรับ Web App & Dashboard ---
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

app.post('/api/airbag/command', authenticateToken, async (req, res) => {
  const { zone, action, device_id } = req.body;
  const targetDeviceId = device_id || req.user.device_id || 'pillow-001';
  mqttClient.publish(`smartpillow/${targetDeviceId}/airbag/command`, JSON.stringify({ zone, action }), () => {
    res.json({ success: true, message: 'สั่งงานถุงลมสำเร็จ' });
  });
});

// --- 7. Endpoint รับอัปโหลดไฟล์เสียง WAV จาก ESP32 (บันทึกลง DB ที่เดียวเท่านั้น) ---
app.post('/api/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    const { device_id, snore_prob, is_inflated } = req.body;
    const audioFile = req.file;

    if (!audioFile) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const audioUrl = `/uploads/${audioFile.filename}`;

    // ค้นหา user_id จาก device_id ในตาราง users
    const userResult = await pool.query(
      'SELECT id FROM users WHERE device_id = $1 LIMIT 1',
      [device_id]
    );

    let userId = userResult.rows.length > 0 ? userResult.rows[0].id : null;

    // บันทึกข้อมูลการกรน + URL ไฟล์เสียงลงตาราง snore_events
    const insertQuery = `
      INSERT INTO snore_events (user_id, device_id, snore_prob, is_inflated, audio_url, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *
    `;
    const values = [userId, device_id, parseInt(snore_prob, 10), is_inflated === 'true', audioUrl];
    const newLog = await pool.query(insertQuery, values);

    console.log(`✅ [Audio Uploaded] Device: ${device_id}, Path: ${audioUrl}`);
    
    // แจ้งเตือนหน้าเว็บผ่าน Socket.io เมื่อมีไฟล์เสียงใหม่เข้ามา
    io.emit('realtime_snore_event', newLog.rows[0]);

    res.status(200).json({ success: true, log: newLog.rows[0] });

  } catch (error) {
    console.error('❌ Upload error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- 8. เริ่มการทำงานของ Server ---
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Web & Socket Server is running on port ${PORT}`);
});