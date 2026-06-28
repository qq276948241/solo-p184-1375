const express = require('express');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const CANCEL_REFUND_RULES = [
  { hoursBefore: 24, refundRate: 1.0, label: '开课前24小时以上，全额退款' },
  { hoursBefore: 12, refundRate: 0.5, label: '开课前12-24小时，退款50%' },
  { hoursBefore: 0,  refundRate: 0.0, label: '开课前12小时内，不退款' }
];

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

function ensureInstance(scheduleId, date) {
  const instance = db.prepare(`
    SELECT * FROM class_instances WHERE coach_schedule_id = ? AND date = ?
  `).get(scheduleId, date);
  if (instance) return instance;

  const schedule = db.prepare('SELECT * FROM coach_schedules WHERE id = ?').get(scheduleId);
  if (!schedule) return null;

  const tpl = db.prepare('SELECT * FROM class_templates WHERE id = ?').get(schedule.class_template_id);

  try {
    const result = db.prepare(`
      INSERT INTO class_instances (coach_schedule_id, coach_id, class_template_id, date, start_time, end_time, capacity)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(scheduleId, schedule.coach_id, schedule.class_template_id, date, schedule.start_time, schedule.end_time, schedule.capacity);
    return { id: result.lastInsertRowid, coach_id: schedule.coach_id, class_template_id: schedule.class_template_id, date, start_time: schedule.start_time, end_time: schedule.end_time, capacity: schedule.capacity, booked_count: 0, status: 'open' };
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
    return { id: result.lastInsertRowid, coach_id: coachId, class_template_id: classTemplateId, date, start_time: startTime, end_time: endTime, capacity: 1, booked_count: 0, status: 'open' };
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return db.prepare('SELECT * FROM class_instances WHERE coach_id = ? AND date = ? AND start_time = ?').get(coachId, date, startTime);
    }
    throw err;
  }
}

router.post('/create', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const { type, schedule_id, coach_id, class_template_id, date, start_time, duration } = req.body;

  if (!type || !date) {
    return res.status(400).json({ error: '缺少必要参数: type, date' });
  }
  if (!['group', 'private'].includes(type)) {
    return res.status(400).json({ error: 'type 只能是 group 或 private' });
  }

  const today = new Date().toISOString().slice(0, 10);
  if (date < today) {
    return res.status(400).json({ error: '不能预约过去的日期' });
  }

  const activeGroupCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM bookings b
    JOIN class_instances ci ON ci.id = b.class_instance_id
    WHERE b.user_id = ? AND b.type = 'group' AND b.status = 'active' AND ci.date >= ?
  `).get(userId, today).cnt;

  if (type === 'group') {
    return createGroupBooking(req, res, userId, activeGroupCount, today);
  } else {
    return createPrivateBooking(req, res, userId, activeGroupCount, today);
  }
});

function createGroupBooking(req, res, userId, activeGroupCount, today) {
  const { schedule_id, date } = req.body;

  if (!schedule_id) {
    return res.status(400).json({ error: '团课预约需要 schedule_id' });
  }

  if (activeGroupCount >= 2) {
    return res.status(409).json({ error: '同时最多挂2节团课，请先取消已有团课预约' });
  }

  const schedule = db.prepare('SELECT * FROM coach_schedules WHERE id = ?').get(schedule_id);
  if (!schedule) {
    return res.status(404).json({ error: '排课不存在' });
  }

  const tpl = db.prepare('SELECT * FROM class_templates WHERE id = ?').get(schedule.class_template_id);
  if (!tpl || tpl.type !== 'group') {
    return res.status(400).json({ error: '该排课不是团课' });
  }

  const instance = ensureInstance(schedule_id, date);
  if (!instance) {
    return res.status(500).json({ error: '创建课次失败' });
  }

  if (instance.status === 'cancelled') {
    return res.status(400).json({ error: '该课次已取消' });
  }
  if (instance.booked_count >= instance.capacity) {
    return res.status(409).json({ error: '该团课已满' });
  }

  const existingBooking = db.prepare(`
    SELECT id FROM bookings WHERE user_id = ? AND class_instance_id = ? AND status = 'active'
  `).get(userId, instance.id);
  if (existingBooking) {
    return res.status(409).json({ error: '您已预约该课次' });
  }

  const userConflict = db.prepare(`
    SELECT b.id FROM bookings b
    JOIN class_instances ci ON ci.id = b.class_instance_id
    WHERE b.user_id = ? AND b.status = 'active' AND ci.date = ?
      AND ci.start_time < ? AND ci.end_time > ?
  `).get(userId, date, instance.end_time, instance.start_time);
  if (userConflict) {
    return res.status(409).json({ error: '该时段与您已有预约冲突' });
  }

  const price = tpl.price;

  const card = db.prepare(`
    SELECT * FROM membership_cards
    WHERE user_id = ? AND status = 'active' AND balance >= ? AND end_date >= ?
    ORDER BY end_date ASC LIMIT 1
  `).get(userId, price, today);

  if (!card) {
    return res.status(402).json({ error: '会员卡余额不足或已过期，请先充值' });
  }

  const transaction = db.transaction(() => {
    db.prepare('UPDATE membership_cards SET balance = balance - ? WHERE id = ?').run(price, card.id);
    db.prepare('UPDATE class_instances SET booked_count = booked_count + 1 WHERE id = ?').run(instance.id);
    const fullCheck = db.prepare('SELECT booked_count, capacity FROM class_instances WHERE id = ?').get(instance.id);
    if (fullCheck.booked_count >= fullCheck.capacity) {
      db.prepare("UPDATE class_instances SET status = 'full' WHERE id = ?").run(instance.id);
    }
    const result = db.prepare(`
      INSERT INTO bookings (user_id, class_instance_id, type, price_paid, duration)
      VALUES (?, ?, 'group', ?, ?)
    `).run(userId, instance.id, price, tpl.duration);
    return result.lastInsertRowid;
  });

  const bookingId = transaction();
  res.status(201).json({
    message: '团课预约成功',
    booking: { id: bookingId, type: 'group', class_instance_id: instance.id, price_paid: price, duration: tpl.duration }
  });
}

function createPrivateBooking(req, res, userId, activeGroupCount, today) {
  const { coach_id, class_template_id, date, start_time, duration } = req.body;

  if (!coach_id || !class_template_id || !start_time || !duration) {
    return res.status(400).json({ error: '私教课预约需要 coach_id, class_template_id, date, start_time, duration' });
  }

  const coach = db.prepare('SELECT * FROM coaches WHERE id = ?').get(coach_id);
  if (!coach) {
    return res.status(404).json({ error: '教练不存在' });
  }

  const tpl = db.prepare('SELECT * FROM class_templates WHERE id = ?').get(class_template_id);
  if (!tpl || tpl.type !== 'private') {
    return res.status(400).json({ error: '该课程不是私教课' });
  }

  const dur = parseInt(duration, 10);
  if (![30, 60, 90, 120].includes(dur)) {
    return res.status(400).json({ error: '私教课时长可选: 30, 60, 90, 120 分钟' });
  }

  const [sh, sm] = start_time.split(':').map(Number);
  const startMinutes = sh * 60 + sm;
  const endMinutes = startMinutes + dur;
  const endHours = Math.floor(endMinutes / 60);
  const endMins = endMinutes % 60;
  const end_time = `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}`;

  const coachConflict = db.prepare(`
    SELECT ci.id FROM class_instances ci
    JOIN bookings b ON b.class_instance_id = ci.id AND b.status = 'active'
    WHERE ci.coach_id = ? AND ci.date = ? AND ci.status != 'cancelled'
      AND ci.start_time < ? AND ci.end_time > ?
  `).get(coach_id, date, end_time, start_time);
  if (coachConflict) {
    return res.status(409).json({ error: '该教练此时段已被占用' });
  }

  const userConflict = db.prepare(`
    SELECT b.id FROM bookings b
    JOIN class_instances ci ON ci.id = b.class_instance_id
    WHERE b.user_id = ? AND b.status = 'active' AND ci.date = ?
      AND ci.start_time < ? AND ci.end_time > ?
  `).get(userId, date, end_time, start_time);
  if (userConflict) {
    return res.status(409).json({ error: '该时段与您已有预约冲突' });
  }

  const pricing = db.prepare('SELECT price_per_hour FROM coach_pricing WHERE coach_level = ?').get(coach.level);
  if (!pricing) {
    return res.status(500).json({ error: '教练等级定价未配置' });
  }
  const price = Math.round(pricing.price_per_hour * (dur / 60));

  const card = db.prepare(`
    SELECT * FROM membership_cards
    WHERE user_id = ? AND status = 'active' AND balance >= ? AND end_date >= ?
    ORDER BY end_date ASC LIMIT 1
  `).get(userId, price, today);

  if (!card) {
    return res.status(402).json({ error: `会员卡余额不足，私教课费用 ${price} 分，请先充值` });
  }

  const instance = ensurePrivateInstance(coach_id, class_template_id, date, start_time, end_time);

  const transaction = db.transaction(() => {
    db.prepare('UPDATE membership_cards SET balance = balance - ? WHERE id = ?').run(price, card.id);
    db.prepare('UPDATE class_instances SET booked_count = booked_count + 1, status = ? WHERE id = ?').run('full', instance.id);
    const result = db.prepare(`
      INSERT INTO bookings (user_id, class_instance_id, type, price_paid, duration)
      VALUES (?, ?, 'private', ?, ?)
    `).run(userId, instance.id, price, dur);
    return result.lastInsertRowid;
  });

  const bookingId = transaction();
  res.status(201).json({
    message: '私教课预约成功',
    booking: { id: bookingId, type: 'private', class_instance_id: instance.id, price_paid: price, duration: dur }
  });
}

router.post('/:id/cancel', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const bookingId = req.params.id;

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ? AND status = ?').get(bookingId, userId, 'active');
  if (!booking) {
    return res.status(404).json({ error: '预约不存在或已取消' });
  }

  const instance = db.prepare('SELECT * FROM class_instances WHERE id = ?').get(booking.class_instance_id);
  if (!instance) {
    return res.status(500).json({ error: '课次数据异常' });
  }

  const classStartTime = `${instance.date}T${instance.start_time}:00`;
  const { rate, label } = getRefundRate(classStartTime);

  const refundAmount = Math.round(booking.price_paid * rate);

  const transaction = db.transaction(() => {
    db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?").run(bookingId);
    db.prepare('UPDATE class_instances SET booked_count = booked_count - 1 WHERE id = ?').run(instance.id);
    if (instance.status === 'full') {
      db.prepare("UPDATE class_instances SET status = 'open' WHERE id = ?").run(instance.id);
    }
    if (refundAmount > 0) {
      const card = db.prepare(`
        SELECT * FROM membership_cards WHERE user_id = ? AND status = 'active' ORDER BY end_date ASC LIMIT 1
      `).get(userId);
      if (card) {
        db.prepare('UPDATE membership_cards SET balance = balance + ? WHERE id = ?').run(refundAmount, card.id);
      }
    }
  });

  transaction();

  res.json({
    message: '预约已取消',
    refund: {
      price_paid: booking.price_paid,
      refund_rate: rate,
      refund_amount: refundAmount,
      rule: label
    }
  });
});

router.get('/my', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const bookings = db.prepare(`
    SELECT b.*, ci.date, ci.start_time, ci.end_time,
           ct.name AS class_name, ct.type AS class_type,
           c.name AS coach_name, c.level AS coach_level
    FROM bookings b
    JOIN class_instances ci ON ci.id = b.class_instance_id
    JOIN class_templates ct ON ct.id = ci.class_template_id
    JOIN coaches c ON c.id = ci.coach_id
    WHERE b.user_id = ?
    ORDER BY ci.date DESC, ci.start_time
  `).all(userId);
  res.json({ bookings });
});

router.get('/refund-rules', authMiddleware, (req, res) => {
  res.json({ rules: CANCEL_REFUND_RULES });
});

module.exports = router;
