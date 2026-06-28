const db = require('../db');
const {
  CANCEL_REFUND_RULES,
  todayStr,
  getRefundRate,
  getActiveCard,
  ensureInstance,
  ensurePrivateInstance,
  computeEndTime
} = require('../utils/common');

const reviewService = require('./reviewService');
const ServiceError = require('./reviewService').ServiceError;

const PRIVATE_DURATIONS = [30, 60, 90, 120];
const MAX_GROUP_BOOKINGS = 2;

function countActiveGroupBookings(userId) {
  const today = todayStr();
  return db.prepare(`
    SELECT COUNT(*) AS cnt FROM bookings b
    JOIN class_instances ci ON ci.id = b.class_instance_id
    WHERE b.user_id = ? AND b.type = 'group' AND b.status = 'active' AND ci.date >= ?
  `).get(userId, today).cnt;
}

function checkUserTimeConflict(userId, date, start, end) {
  return db.prepare(`
    SELECT b.id FROM bookings b
    JOIN class_instances ci ON ci.id = b.class_instance_id
    WHERE b.user_id = ? AND b.status = 'active' AND ci.date = ?
      AND ci.start_time < ? AND ci.end_time > ?
  `).get(userId, date, end, start);
}

function checkCoachTimeConflict(coachId, date, start, end) {
  return db.prepare(`
    SELECT ci.id FROM class_instances ci
    JOIN bookings b ON b.class_instance_id = ci.id AND b.status = 'active'
    WHERE ci.coach_id = ? AND ci.date = ? AND ci.status != 'cancelled'
      AND ci.start_time < ? AND ci.end_time > ?
  `).get(coachId, date, end, start);
}

function validateCreateInput(payload) {
  const { type, date } = payload;
  if (!type || !date) throw new ServiceError('缺少必要参数: type, date');
  if (!['group', 'private'].includes(type)) throw new ServiceError('type 只能是 group 或 private');
  const today = todayStr();
  if (date < today) throw new ServiceError('不能预约过去的日期');
}

function createGroupBooking(userId, payload) {
  const { schedule_id, date } = payload;
  if (!schedule_id) throw new ServiceError('团课预约需要 schedule_id');

  if (countActiveGroupBookings(userId) >= MAX_GROUP_BOOKINGS) {
    throw new ServiceError('同时最多挂2节团课，请先取消已有团课预约', 409);
  }

  const schedule = db.prepare('SELECT * FROM coach_schedules WHERE id = ?').get(schedule_id);
  if (!schedule) throw new ServiceError('排课不存在', 404);

  const tpl = db.prepare('SELECT * FROM class_templates WHERE id = ?').get(schedule.class_template_id);
  if (!tpl || tpl.type !== 'group') throw new ServiceError('该排课不是团课');

  const instance = ensureInstance(schedule_id, date);
  if (!instance) throw new ServiceError('创建课次失败', 500);
  if (instance.status === 'cancelled') throw new ServiceError('该课次已取消');
  if (instance.booked_count >= instance.capacity) throw new ServiceError('该团课已满', 409);

  const existing = db.prepare(`
    SELECT id FROM bookings WHERE user_id = ? AND class_instance_id = ? AND status = 'active'
  `).get(userId, instance.id);
  if (existing) throw new ServiceError('您已预约该课次', 409);

  if (checkUserTimeConflict(userId, date, instance.start_time, instance.end_time)) {
    throw new ServiceError('该时段与您已有预约冲突', 409);
  }

  const price = tpl.price;
  const card = getActiveCard(userId, price);
  if (!card) throw new ServiceError('会员卡余额不足或已过期，请先充值', 402);

  const bookingId = db.transaction(() => {
    db.prepare('UPDATE membership_cards SET balance = balance - ? WHERE id = ?').run(price, card.id);
    db.prepare('UPDATE class_instances SET booked_count = booked_count + 1 WHERE id = ?').run(instance.id);
    const fullCheck = db.prepare('SELECT booked_count, capacity FROM class_instances WHERE id = ?').get(instance.id);
    if (fullCheck.booked_count >= fullCheck.capacity) {
      db.prepare("UPDATE class_instances SET status = 'full' WHERE id = ?").run(instance.id);
    }
    const r = db.prepare(`
      INSERT INTO bookings (user_id, class_instance_id, type, price_paid, duration)
      VALUES (?, ?, 'group', ?, ?)
    `).run(userId, instance.id, price, tpl.duration);
    return r.lastInsertRowid;
  })();

  return {
    message: '团课预约成功',
    booking: { id: bookingId, type: 'group', class_instance_id: instance.id, price_paid: price, duration: tpl.duration }
  };
}

function createPrivateBooking(userId, payload) {
  const { coach_id, class_template_id, date, start_time, duration } = payload;
  if (!coach_id || !class_template_id || !start_time || !duration) {
    throw new ServiceError('私教课预约需要 coach_id, class_template_id, date, start_time, duration');
  }

  const coach = db.prepare('SELECT * FROM coaches WHERE id = ?').get(coach_id);
  if (!coach) throw new ServiceError('教练不存在', 404);

  const tpl = db.prepare('SELECT * FROM class_templates WHERE id = ?').get(class_template_id);
  if (!tpl || tpl.type !== 'private') throw new ServiceError('该课程不是私教课');

  const dur = parseInt(duration, 10);
  if (!PRIVATE_DURATIONS.includes(dur)) {
    throw new ServiceError('私教课时长可选: 30, 60, 90, 120 分钟');
  }

  const end_time = computeEndTime(start_time, dur);

  if (checkCoachTimeConflict(coach_id, date, start_time, end_time)) {
    throw new ServiceError('该教练此时段已被占用', 409);
  }
  if (checkUserTimeConflict(userId, date, start_time, end_time)) {
    throw new ServiceError('该时段与您已有预约冲突', 409);
  }

  const pricing = db.prepare('SELECT price_per_hour FROM coach_pricing WHERE coach_level = ?').get(coach.level);
  if (!pricing) throw new ServiceError('教练等级定价未配置', 500);
  const price = Math.round(pricing.price_per_hour * (dur / 60));

  const card = getActiveCard(userId, price);
  if (!card) throw new ServiceError(`会员卡余额不足，私教课费用 ${price} 分，请先充值`, 402);

  const instance = ensurePrivateInstance(coach_id, class_template_id, date, start_time, end_time);

  const bookingId = db.transaction(() => {
    db.prepare('UPDATE membership_cards SET balance = balance - ? WHERE id = ?').run(price, card.id);
    db.prepare("UPDATE class_instances SET booked_count = booked_count + 1, status = 'full' WHERE id = ?").run(instance.id);
    const r = db.prepare(`
      INSERT INTO bookings (user_id, class_instance_id, type, price_paid, duration)
      VALUES (?, ?, 'private', ?, ?)
    `).run(userId, instance.id, price, dur);
    return r.lastInsertRowid;
  })();

  return {
    message: '私教课预约成功',
    booking: { id: bookingId, type: 'private', class_instance_id: instance.id, price_paid: price, duration: dur }
  };
}

function createBooking(userId, payload) {
  validateCreateInput(payload);
  return payload.type === 'group'
    ? createGroupBooking(userId, payload)
    : createPrivateBooking(userId, payload);
}

function cancelBooking(userId, bookingId) {
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ? AND user_id = ? AND status = 'active'").get(bookingId, userId);
  if (!booking) throw new ServiceError('预约不存在或已取消', 404);

  const instance = db.prepare('SELECT * FROM class_instances WHERE id = ?').get(booking.class_instance_id);
  if (!instance) throw new ServiceError('课次数据异常', 500);

  const { rate, label } = getRefundRate(`${instance.date}T${instance.start_time}:00`);
  const refundAmount = Math.round(booking.price_paid * rate);

  if (booking.type === 'private') {
    const pricing = db.prepare(`
      SELECT cp.price_per_hour
      FROM coaches c
      JOIN coach_pricing cp ON cp.coach_level = c.level
      WHERE c.id = ?
    `).get(instance.coach_id);
    if (pricing) {
      const expectedPrice = Math.round(pricing.price_per_hour * (booking.duration / 60));
      if (expectedPrice !== booking.price_paid) {
        console.warn(`[cancelBooking] 私教预约 ${bookingId} price_paid=${booking.price_paid} 与时长计算值 ${expectedPrice} 不一致，以实际支付为准退费`);
      }
    }
  }

  const reviewDeleted = reviewService.softDeleteReviewByBookingId(bookingId);

  db.transaction(() => {
    db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now'), reviewed = 0 WHERE id = ?").run(bookingId);
    db.prepare('UPDATE class_instances SET booked_count = booked_count - 1 WHERE id = ?').run(instance.id);
    if (instance.status === 'full') {
      db.prepare("UPDATE class_instances SET status = 'open' WHERE id = ?").run(instance.id);
    }
    if (refundAmount > 0) {
      const card = db.prepare("SELECT * FROM membership_cards WHERE user_id = ? AND status = 'active' ORDER BY end_date ASC LIMIT 1").get(userId);
      if (card) {
        db.prepare('UPDATE membership_cards SET balance = balance + ? WHERE id = ?').run(refundAmount, card.id);
      }
    }
  })();

  return {
    message: '预约已取消',
    refund: {
      price_paid: booking.price_paid,
      refund_rate: rate,
      refund_amount: refundAmount,
      rule: label
    },
    review_soft_deleted: reviewDeleted === 1
  };
}

function listUserBookings(userId) {
  return db.prepare(`
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
}

module.exports = {
  CANCEL_REFUND_RULES,
  MAX_GROUP_BOOKINGS,
  PRIVATE_DURATIONS,
  countActiveGroupBookings,
  checkUserTimeConflict,
  checkCoachTimeConflict,
  createBooking,
  createGroupBooking,
  createPrivateBooking,
  cancelBooking,
  listUserBookings
};
