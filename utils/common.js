const db = require('../db');

const CANCEL_REFUND_RULES = [
  { hoursBefore: 24, refundRate: 1.0, label: '开课前24小时以上，全额退款' },
  { hoursBefore: 12, refundRate: 0.5, label: '开课前12-24小时，退款50%' },
  { hoursBefore: 0,  refundRate: 0.0, label: '开课前12小时内，不退款' }
];

const CARD_CONFIG = {
  monthly:   { label: '月卡', months: 1, defaultBalance: 50000 },
  quarterly: { label: '季卡', months: 3, defaultBalance: 150000 },
  annual:    { label: '年卡', months: 12, defaultBalance: 500000 }
};

const STARS = ['', '★', '★★', '★★★', '★★★★', '★★★★★'];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(query.page_size, 10) || 10));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function addStars(rows) {
  return rows.map(r => ({ ...r, stars: STARS[r.rating] || '' }));
}

function addCardLabel(rows) {
  return rows.map(c => ({ ...c, card_label: CARD_CONFIG[c.card_type] ? CARD_CONFIG[c.card_type].label : c.card_type }));
}

function getRefundRate(classStartTime) {
  const now = Date.now();
  const classTime = new Date(classStartTime).getTime();
  const hoursBefore = (classTime - now) / (1000 * 60 * 60);
  for (const rule of CANCEL_REFUND_RULES) {
    if (hoursBefore >= rule.hoursBefore) {
      return { rate: rule.refundRate, label: rule.label };
    }
  }
  return { rate: 0, label: '开课前12小时内，不退款' };
}

function expireCards(userId) {
  const today = todayStr();
  if (userId) {
    db.prepare("UPDATE membership_cards SET status = 'expired' WHERE end_date < ? AND status = 'active' AND user_id = ?").run(today, userId);
  } else {
    db.prepare("UPDATE membership_cards SET status = 'expired' WHERE end_date < ? AND status = 'active'").run(today);
  }
}

function getActiveCard(userId, price) {
  expireCards(userId);
  const today = todayStr();
  return db.prepare(`
    SELECT * FROM membership_cards
    WHERE user_id = ? AND status = 'active' AND balance >= ? AND end_date >= ?
    ORDER BY end_date ASC LIMIT 1
  `).get(userId, price, today);
}

function ensureInstance(scheduleId, date) {
  const instance = db.prepare(`
    SELECT * FROM class_instances WHERE coach_schedule_id = ? AND date = ?
  `).get(scheduleId, date);
  if (instance) return instance;

  const schedule = db.prepare('SELECT * FROM coach_schedules WHERE id = ?').get(scheduleId);
  if (!schedule) return null;

  try {
    const result = db.prepare(`
      INSERT INTO class_instances (coach_schedule_id, coach_id, class_template_id, date, start_time, end_time, capacity)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(scheduleId, schedule.coach_id, schedule.class_template_id, date, schedule.start_time, schedule.end_time, schedule.capacity);
    return {
      id: result.lastInsertRowid,
      coach_id: schedule.coach_id,
      class_template_id: schedule.class_template_id,
      date,
      start_time: schedule.start_time,
      end_time: schedule.end_time,
      capacity: schedule.capacity,
      booked_count: 0,
      status: 'open'
    };
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return db.prepare('SELECT * FROM class_instances WHERE coach_schedule_id = ? AND date = ?').get(scheduleId, date);
    }
    throw err;
  }
}

function ensurePrivateInstance(coachId, classTemplateId, date, startTime, endTime) {
  const instance = db.prepare(`
    SELECT * FROM class_instances WHERE coach_id = ? AND date = ? AND start_time = ?
  `).get(coachId, date, startTime);
  if (instance) return instance;

  try {
    const result = db.prepare(`
      INSERT INTO class_instances (coach_id, class_template_id, date, start_time, end_time, capacity)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(coachId, classTemplateId, date, startTime, endTime, 1);
    return {
      id: result.lastInsertRowid,
      coach_id: coachId,
      class_template_id: classTemplateId,
      date,
      start_time: startTime,
      end_time: endTime,
      capacity: 1,
      booked_count: 0,
      status: 'open'
    };
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return db.prepare('SELECT * FROM class_instances WHERE coach_id = ? AND date = ? AND start_time = ?').get(coachId, date, startTime);
    }
    throw err;
  }
}

function computeEndTime(startTime, durationMinutes) {
  const [sh, sm] = startTime.split(':').map(Number);
  const startMinutes = sh * 60 + sm;
  const endMinutes = startMinutes + durationMinutes;
  const eh = Math.floor(endMinutes / 60);
  const em = endMinutes % 60;
  return `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
}

module.exports = {
  CANCEL_REFUND_RULES,
  CARD_CONFIG,
  STARS,
  todayStr,
  parsePagination,
  addStars,
  addCardLabel,
  getRefundRate,
  expireCards,
  getActiveCard,
  ensureInstance,
  ensurePrivateInstance,
  computeEndTime
};
