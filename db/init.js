const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'fitness.db');

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    real_name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'student',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS coaches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    level TEXT NOT NULL CHECK(level IN ('junior','senior','expert')),
    bio TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS coach_pricing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coach_level TEXT NOT NULL UNIQUE,
    price_per_hour INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS class_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('group','private')),
    description TEXT NOT NULL DEFAULT '',
    duration INTEGER NOT NULL DEFAULT 60,
    price INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS coach_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coach_id INTEGER NOT NULL REFERENCES coaches(id),
    class_template_id INTEGER NOT NULL REFERENCES class_templates(id),
    weekday INTEGER NOT NULL CHECK(weekday >= 0 AND weekday <= 6),
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    capacity INTEGER NOT NULL DEFAULT 10,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(coach_id, weekday, start_time)
  );

  CREATE TABLE IF NOT EXISTS class_instances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coach_schedule_id INTEGER REFERENCES coach_schedules(id),
    coach_id INTEGER NOT NULL REFERENCES coaches(id),
    class_template_id INTEGER NOT NULL REFERENCES class_templates(id),
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    capacity INTEGER NOT NULL DEFAULT 10,
    booked_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','full','cancelled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(coach_id, date, start_time)
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    class_instance_id INTEGER NOT NULL REFERENCES class_instances(id),
    type TEXT NOT NULL CHECK(type IN ('group','private')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
    price_paid INTEGER NOT NULL DEFAULT 0,
    duration INTEGER NOT NULL DEFAULT 60,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    cancelled_at TEXT
  );

  CREATE TABLE IF NOT EXISTS membership_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    card_type TEXT NOT NULL CHECK(card_type IN ('monthly','quarterly','annual')),
    balance INTEGER NOT NULL DEFAULT 0,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_user_status ON bookings(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_bookings_instance ON bookings(class_instance_id, status);
  CREATE INDEX IF NOT EXISTS idx_class_instances_date ON class_instances(date);
  CREATE INDEX IF NOT EXISTS idx_class_instances_coach_date ON class_instances(coach_id, date);
  CREATE INDEX IF NOT EXISTS idx_membership_user ON membership_cards(user_id, status);
`);

const stmt = db.prepare('SELECT COUNT(*) AS cnt FROM coach_pricing');
const row = stmt.get();
if (row.cnt === 0) {
  const insert = db.prepare('INSERT INTO coach_pricing (coach_level, price_per_hour) VALUES (?, ?)');
  insert.run('junior', 20000);
  insert.run('senior', 35000);
  insert.run('expert', 50000);

  const insertCoach = db.prepare('INSERT INTO coaches (name, level, bio) VALUES (?, ?, ?)');
  insertCoach.run('张教练', 'junior', '擅长基础体能训练');
  insertCoach.run('李教练', 'senior', '精通力量训练与康复');
  insertCoach.run('王教练', 'expert', '国家级健身教练，专攻竞技体能');

  const insertTpl = db.prepare('INSERT INTO class_templates (name, type, description, duration, price) VALUES (?, ?, ?, ?, ?)');
  insertTpl.run('晨间瑜伽', 'group', '放松身心的清晨瑜伽课', 60, 5000);
  insertTpl.run('燃脂搏击', 'group', '高强度搏击有氧课', 45, 5000);
  insertTpl.run('核心训练', 'group', '核心力量与稳定性训练', 50, 5000);
  insertTpl.run('私教体能', 'private', '一对一私人教练体能训练', 60, 0);
}

console.log('Database initialized at', DB_PATH);
db.close();
