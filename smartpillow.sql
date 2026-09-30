-- ============================================================
-- Smart Anti-Snoring Pillow Database Initialization Script
-- ============================================================

-- ลบตารางเดิมถ้ามีอยู่ (เพื่อเริ่มต้นใหม่ได้อย่างสะอาด)
DROP TABLE IF EXISTS sensor_data CASCADE;
DROP TABLE IF EXISTS snore_events CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- ------------------------------------------------------------
-- 1. ตารางผู้ใช้งาน (Users)
-- ------------------------------------------------------------
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 2. ตารางประวัติเหตุการณ์กรน (Snore Events)
-- ------------------------------------------------------------
CREATE TABLE snore_events (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    device_id VARCHAR(50) DEFAULT 'pillow-001',
    snore_prob INT NOT NULL CHECK (snore_prob BETWEEN 0 AND 100),
    is_inflated BOOLEAN DEFAULT FALSE,
    audio_url VARCHAR(255) DEFAULT '/uploads/demo.mp3',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 3. ตารางข้อมูลเซนเซอร์สภาพแวดล้อม (Sensor Data)
-- ------------------------------------------------------------
CREATE TABLE sensor_data (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50) DEFAULT 'pillow-001',
    temperature NUMERIC(4, 1) NOT NULL,
    humidity NUMERIC(4, 1) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 4. สร้าง Index เพื่อเพิ่มความเร็วในการดึงข้อมูลตามเวลา
-- ------------------------------------------------------------
CREATE INDEX idx_snore_events_created_at ON snore_events(created_at DESC);
CREATE INDEX idx_sensor_data_created_at ON sensor_data(created_at DESC);
CREATE INDEX idx_users_email ON users(email);

-- ------------------------------------------------------------
-- 5. ข้อมูลตัวอย่างเริ่มต้น (Initial Seed Data)
-- ------------------------------------------------------------

-- สร้างผู้ใช้ทดสอบ (Password คือ 'password123' ที่ผ่านการ Hash แล้ว)
INSERT INTO users (username, email, password_hash)
VALUES ('user01', 'user01@example.com', '$2a$10$eE0m9Z4sN/5w2bH2hS34o.q38Q8x2b1N4sY3xP2rQ1s2t3u4v5w6x');

-- เพิ่มข้อมูลเซนเซอร์เริ่มต้น
INSERT INTO sensor_data (device_id, temperature, humidity)
VALUES 
    ('pillow-001', 25.4, 55.0),
    ('pillow-001', 25.2, 54.8);

-- เพิ่มตัวอย่างประวัติการกรน
INSERT INTO snore_events (user_id, device_id, snore_prob, is_inflated)
VALUES 
    (1, 'pillow-001', 78, TRUE),
    (1, 'pillow-001', 62, FALSE),
    (1, 'pillow-001', 85, TRUE);