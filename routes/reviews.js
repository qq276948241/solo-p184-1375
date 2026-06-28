const express = require('express');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(query.page_size, 10) || 10));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function addStars(list) {
  const stars = ['', '★', '★★', '★★★', '★★★★', '★★★★★'];
  return list.map(r => ({ ...r, stars: stars[r.rating] || '' }));
}

router.get('/coach/:coachId', authMiddleware, (req, res) => {
  const coachId = parseInt(req.params.coachId, 10);
  const { page, pageSize, offset } = parsePagination(req.query);

  const coach = db.prepare('SELECT id, name, level FROM coaches WHERE id = ?').get(coachId);
  if (!coach) {
    return res.status(404).json({ error: '教练不存在' });
  }

  const total = db.prepare('SELECT COUNT(*) AS cnt FROM reviews WHERE coach_id = ?').get(coachId).cnt;
  const stats = db.prepare(`
    SELECT AVG(rating) AS avg_rating, COUNT(*) AS total_count,
           SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) AS s5,
           SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS s4,
           SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS s3,
           SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS s2,
           SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS s1
    FROM reviews WHERE coach_id = ?
  `).get(coachId);

  const rows = db.prepare(`
    SELECT r.*, u.username, u.real_name,
           ci.date, ci.start_time, ct.name AS class_name
    FROM reviews r
    JOIN users u ON u.id = r.user_id
    JOIN bookings b ON b.id = r.booking_id
    JOIN class_instances ci ON ci.id = b.class_instance_id
    JOIN class_templates ct ON ct.id = ci.class_template_id
    WHERE r.coach_id = ?
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `).all(coachId, pageSize, offset);

  const roundedAvg = stats.avg_rating ? Math.round(stats.avg_rating * 10) / 10 : 0;
  res.json({
    coach: { id: coach.id, name: coach.name, level: coach.level },
    summary: {
      avg_rating: roundedAvg,
      total_count: stats.total_count || 0,
      distribution: { 5: stats.s5 || 0, 4: stats.s4 || 0, 3: stats.s3 || 0, 2: stats.s2 || 0, 1: stats.s1 || 0 }
    },
    pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
    reviews: addStars(rows)
  });
});

router.get('/booking/:bookingId', authMiddleware, (req, res) => {
  const bookingId = parseInt(req.params.bookingId, 10);
  const userId = req.user.id;

  const booking = db.prepare('SELECT id, user_id FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) {
    return res.status(404).json({ error: '预约不存在' });
  }
  if (booking.user_id !== userId) {
    return res.status(403).json({ error: '无权查看他人的预约评价' });
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
    WHERE r.booking_id = ?
  `).get(bookingId);

  if (!review) {
    return res.status(404).json({ error: '该预约暂无评价' });
  }
  res.json({ review: addStars([review])[0] });
});

router.get('/my', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const { page, pageSize, offset } = parsePagination(req.query);

  const total = db.prepare('SELECT COUNT(*) AS cnt FROM reviews WHERE user_id = ?').get(userId).cnt;
  const rows = db.prepare(`
    SELECT r.*,
           c.name AS coach_name, c.level AS coach_level,
           ci.date, ci.start_time, ct.name AS class_name
    FROM reviews r
    JOIN coaches c ON c.id = r.coach_id
    JOIN bookings b ON b.id = r.booking_id
    JOIN class_instances ci ON ci.id = b.class_instance_id
    JOIN class_templates ct ON ct.id = ci.class_template_id
    WHERE r.user_id = ?
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, pageSize, offset);

  res.json({
    pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
    reviews: addStars(rows)
  });
});

module.exports = router;
