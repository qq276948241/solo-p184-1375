const db = require('./index');

const hasCompleted = db.prepare(`
  SELECT 1 FROM sqlite_master
  WHERE type='table' AND name='bookings'
    AND sql LIKE '%completed%'
`).get();

if (hasCompleted) {
  console.log('bookings 表 CHECK 已包含 completed，无需重建');
} else {
  console.log('重建 bookings 表，扩展 status CHECK 为 active/cancelled/completed...');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE bookings_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      class_instance_id INTEGER NOT NULL REFERENCES class_instances(id),
      type TEXT NOT NULL CHECK(type IN ('group','private')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled','completed')),
      price_paid INTEGER NOT NULL DEFAULT 0,
      duration INTEGER NOT NULL DEFAULT 60,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      cancelled_at TEXT,
      reviewed INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO bookings_new (id, user_id, class_instance_id, type, status, price_paid, duration, created_at, cancelled_at, reviewed)
    SELECT id, user_id, class_instance_id, type, status, price_paid, duration, created_at, cancelled_at, reviewed FROM bookings;

    DROP TABLE bookings;
    ALTER TABLE bookings_new RENAME TO bookings;

    CREATE INDEX IF NOT EXISTS idx_bookings_user_status ON bookings(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_bookings_instance ON bookings(class_instance_id, status);
  `);
  db.pragma('foreign_keys = ON');
  console.log('bookings 表重建完成');
}

const today = new Date().toISOString().slice(0, 10);
const r = db.prepare(`
  UPDATE bookings SET status = 'completed'
  WHERE status = 'active' AND class_instance_id IN (
    SELECT id FROM class_instances WHERE date < ?
  )
`).run(today);
console.log(`已迁移 ${r.changes} 条已上课预约为 status='completed'`);

db.close();
