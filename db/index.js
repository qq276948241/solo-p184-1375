const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'fitness.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id),
    coach_id INTEGER NOT NULL REFERENCES coaches(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_reviews_coach ON reviews(coach_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id);
`);

const bookingCols = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);
if (!bookingCols.includes('reviewed')) {
  db.exec("ALTER TABLE bookings ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0");
}

module.exports = db;
