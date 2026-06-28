const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'fitness.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
