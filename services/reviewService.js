const db = require('../db');
const { parsePagination, addStars } = require('../utils/common');

const ACTIVE_FILTER = "deleted_at IS NULL";

const ServiceError = class extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
};

function validateReviewInput(rating, comment) {
  if (rating === undefined || rating === null) {
    throw new ServiceError('缺少星级 rating 必填');
  }
  const ratingNum = parseInt(rating, 10);
  if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    throw new ServiceError('星级 rating 必须是 1-5 整数');
  }
  const commentText = comment === undefined || comment === null ? '' : String(comment);
  if (commentText.length > 200) {
    throw new ServiceError('评论不能超过 200 字');
  }
  return { ratingNum, commentText };
}

function submitReview(userId, bookingId, rating, comment) {
  const { ratingNum, commentText } = validateReviewInput(rating, comment);

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?').get(bookingId, userId);
  if (!booking) {
    throw new ServiceError('预约不存在', 404);
  }
  if (booking.status === 'cancelled') {
    throw new ServiceError('已取消的预约不能评价');
  }
  if (booking.reviewed === 1) {
    throw new ServiceError('该预约已评价，不可重复提交', 409);
  }

  const instance = db.prepare('SELECT * FROM class_instances WHERE id = ?').get(booking.class_instance_id);
  if (!instance) {
    throw new ServiceError('课次数据异常', 500);
  }
  const classStart = new Date(`${instance.date}T${instance.start_time}:00`).getTime();
  if (classStart > Date.now()) {
    throw new ServiceError('课程尚未开始，需等课程结束后再评价');
  }

  const existingSoftDeleted = db.prepare(
    `SELECT id FROM reviews WHERE booking_id = ? AND deleted_at IS NOT NULL`
  ).get(bookingId);

  const transaction = db.transaction(() => {
    if (existingSoftDeleted) {
      db.prepare(`
        UPDATE reviews SET rating = ?, comment = ?, deleted_at = NULL, created_at = datetime('now')
        WHERE id = ?
      `).run(ratingNum, commentText, existingSoftDeleted.id);
    } else {
      db.prepare(`
        INSERT INTO reviews (booking_id, coach_id, user_id, rating, comment)
        VALUES (?, ?, ?, ?, ?)
      `).run(bookingId, instance.coach_id, userId, ratingNum, commentText);
    }
    db.prepare('UPDATE bookings SET reviewed = 1 WHERE id = ?').run(bookingId);
  });

  try {
    transaction();
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      throw new ServiceError('该预约已评价，不可重复提交', 409);
    }
    throw err;
  }

  return {
    booking_id: bookingId,
    coach_id: instance.coach_id,
    rating: ratingNum,
    comment: commentText
  };
}

function softDeleteReviewByBookingId(bookingId) {
  const review = db.prepare(
    `SELECT id FROM reviews WHERE booking_id = ? AND deleted_at IS NULL`
  ).get(bookingId);
  if (!review) return 0;
  db.prepare(`UPDATE reviews SET deleted_at = datetime('now') WHERE id = ?`).run(review.id);
  return 1;
}

function getCoachReviews(coachId, query) {
  const coach = db.prepare('SELECT id, name, level FROM coaches WHERE id = ?').get(coachId);
  if (!coach) {
    throw new ServiceError('教练不存在', 404);
  }

  const { page, pageSize, offset } = parsePagination(query);
  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM reviews WHERE coach_id = ? AND ${ACTIVE_FILTER}`).get(coachId).cnt;

  const stats = db.prepare(`
    SELECT AVG(rating) AS avg_rating, COUNT(*) AS total_count,
           SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) AS s5,
           SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS s4,
           SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS s3,
           SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS s2,
           SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS s1
    FROM reviews r WHERE r.coach_id = ? AND ${ACTIVE_FILTER}
  `).get(coachId);

  const rows = db.prepare(`
    SELECT r.*, u.username, u.real_name,
           ci.date, ci.start_time, ct.name AS class_name
    FROM reviews r
    JOIN users u ON u.id = r.user_id
    JOIN bookings b ON b.id = r.booking_id
    JOIN class_instances ci ON ci.id = b.class_instance_id
    JOIN class_templates ct ON ct.id = ci.class_template_id
    WHERE r.coach_id = ? AND ${ACTIVE_FILTER}
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `).all(coachId, pageSize, offset);

  const roundedAvg = stats.avg_rating ? Math.round(stats.avg_rating * 10) / 10 : 0;
  return {
    coach,
    summary: {
      avg_rating: roundedAvg,
      total_count: stats.total_count || 0,
      distribution: { 5: stats.s5 || 0, 4: stats.s4 || 0, 3: stats.s3 || 0, 2: stats.s2 || 0, 1: stats.s1 || 0 }
    },
    pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
    reviews: addStars(rows)
  };
}

function getBookingReview(userId, bookingId) {
  const booking = db.prepare('SELECT id, user_id FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) {
    throw new ServiceError('预约不存在', 404);
  }
  if (booking.user_id !== userId) {
    throw new ServiceError('无权查看他人的预约评价', 403);
  }

  const review = db.prepare(`
    SELECT r.*, u.username, u.real_name,
           ci.date, ci.start_time, ct.name AS class_name,
           c.name AS coach_name, c.level AS coach_level
    FROM reviews r
    JOIN users u ON u.id = r.user_id
    JOIN bookings b ON b.id = r.booking_id
    JOIN class_instances ci ON ci.id = b.class_instance_id
    JOIN class_templates ct ON ct.id = ci.class_template_id
    JOIN coaches c ON c.id = r.coach_id
    WHERE r.booking_id = ? AND ${ACTIVE_FILTER}
  `).get(bookingId);

  if (!review) {
    throw new ServiceError('该预约暂无评价', 404);
  }
  return addStars([review])[0];
}

function getMyReviews(userId, query) {
  const { page, pageSize, offset } = parsePagination(query);
  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM reviews WHERE user_id = ? AND ${ACTIVE_FILTER}`).get(userId).cnt;

  const rows = db.prepare(`
    SELECT r.*,
           c.name AS coach_name, c.level AS coach_level,
           ci.date, ci.start_time, ct.name AS class_name
    FROM reviews r
    JOIN coaches c ON c.id = r.coach_id
    JOIN bookings b ON b.id = r.booking_id
    JOIN class_instances ci ON ci.id = b.class_instance_id
    JOIN class_templates ct ON ct.id = ci.class_template_id
    WHERE r.user_id = ? AND ${ACTIVE_FILTER}
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, pageSize, offset);

  return {
    pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
    reviews: addStars(rows)
  };
}

module.exports = {
  ServiceError,
  submitReview,
  softDeleteReviewByBookingId,
  getCoachReviews,
  getBookingReview,
  getMyReviews
};
