const express = require('express');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

router.get('/coaches', authMiddleware, (req, res) => {
  const coaches = db.prepare(`
    SELECT c.*, cp.price_per_hour,
           ROUND(AVG(r.rating), 1) AS avg_rating,
           COUNT(r.id) AS review_count
    FROM coaches c
    LEFT JOIN coach_pricing cp ON cp.coach_level = c.level
    LEFT JOIN reviews r ON r.coach_id = c.id AND r.deleted_at IS NULL
    GROUP BY c.id
    ORDER BY c.id
  `).all();
  const cleaned = coaches.map(c => ({
    ...c,
    avg_rating: c.avg_rating ? Number(c.avg_rating) : 0,
    review_count: c.review_count || 0
  }));
  res.json({ coaches: cleaned });
});

router.get('/coaches/:id', authMiddleware, (req, res) => {
  const coach = db.prepare(`
    SELECT c.*, cp.price_per_hour,
           ROUND(AVG(r.rating), 1) AS avg_rating,
           COUNT(r.id) AS review_count
    FROM coaches c
    LEFT JOIN coach_pricing cp ON cp.coach_level = c.level
    LEFT JOIN reviews r ON r.coach_id = c.id AND r.deleted_at IS NULL
    WHERE c.id = ?
    GROUP BY c.id
  `).get(req.params.id);
  if (!coach) {
    return res.status(404).json({ error: '教练不存在' });
  }
  const cleanedCoach = {
    ...coach,
    avg_rating: coach.avg_rating ? Number(coach.avg_rating) : 0,
    review_count: coach.review_count || 0
  };
  const schedules = db.prepare(`
    SELECT cs.*, ct.name AS class_name, ct.type AS class_type, ct.duration, ct.price
    FROM coach_schedules cs
    JOIN class_templates ct ON ct.id = cs.class_template_id
    WHERE cs.coach_id = ?
    ORDER BY cs.weekday, cs.start_time
  `).all(coach.id);
  res.json({ coach: cleanedCoach, schedules });
});

router.get('/classes', authMiddleware, (req, res) => {
  const templates = db.prepare('SELECT * FROM class_templates ORDER BY type, id').all();
  res.json({ classes: templates });
});

router.get('/pricing', authMiddleware, (req, res) => {
  const pricing = db.prepare('SELECT * FROM coach_pricing ORDER BY price_per_hour').all();
  res.json({ pricing });
});

router.get('/schedule', authMiddleware, (req, res) => {
  const { weekday } = req.query;
  let schedules;
  if (weekday !== undefined) {
    const wd = parseInt(weekday, 10);
    if (isNaN(wd) || wd < 0 || wd > 6) {
      return res.status(400).json({ error: 'weekday 取值 0-6 (0=周日)' });
    }
    schedules = db.prepare(`
      SELECT cs.*, c.name AS coach_name, c.level AS coach_level,
             ct.name AS class_name, ct.type AS class_type, ct.duration, ct.price,
             cp.price_per_hour
      FROM coach_schedules cs
      JOIN coaches c ON c.id = cs.coach_id
      JOIN class_templates ct ON ct.id = cs.class_template_id
      LEFT JOIN coach_pricing cp ON cp.coach_level = c.level
      WHERE cs.weekday = ?
      ORDER BY cs.start_time
    `).all(wd);
  } else {
    schedules = db.prepare(`
      SELECT cs.*, c.name AS coach_name, c.level AS coach_level,
             ct.name AS class_name, ct.type AS class_type, ct.duration, ct.price,
             cp.price_per_hour
      FROM coach_schedules cs
      JOIN coaches c ON c.id = cs.coach_id
      JOIN class_templates ct ON ct.id = cs.class_template_id
      LEFT JOIN coach_pricing cp ON cp.coach_level = c.level
      ORDER BY cs.weekday, cs.start_time
    `).all();
  }
  const enriched = schedules.map(s => ({
    ...s,
    weekday_name: WEEKDAY_NAMES[s.weekday]
  }));
  res.json({ schedules: enriched });
});

router.post('/schedule', authMiddleware, (req, res) => {
  const { coach_id, class_template_id, weekday, start_time, end_time, capacity } = req.body;
  if (!coach_id || !class_template_id || weekday === undefined || !start_time || !end_time) {
    return res.status(400).json({ error: '缺少必要参数: coach_id, class_template_id, weekday, start_time, end_time' });
  }

  const coach = db.prepare('SELECT * FROM coaches WHERE id = ?').get(coach_id);
  if (!coach) {
    return res.status(404).json({ error: '教练不存在' });
  }

  const tpl = db.prepare('SELECT * FROM class_templates WHERE id = ?').get(class_template_id);
  if (!tpl) {
    return res.status(404).json({ error: '课程模板不存在' });
  }

  const conflict = db.prepare(`
    SELECT id FROM coach_schedules
    WHERE coach_id = ? AND weekday = ? AND start_time < ? AND end_time > ?
  `).get(coach_id, weekday, end_time, start_time);
  if (conflict) {
    return res.status(409).json({ error: '该教练此时段已有排课' });
  }

  const result = db.prepare(`
    INSERT INTO coach_schedules (coach_id, class_template_id, weekday, start_time, end_time, capacity)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(coach_id, class_template_id, weekday, start_time, end_time, capacity || 10);

  res.status(201).json({
    message: '排课成功',
    schedule: {
      id: result.lastInsertRowid,
      coach_id,
      class_template_id,
      weekday,
      weekday_name: WEEKDAY_NAMES[weekday],
      start_time,
      end_time,
      capacity: capacity || 10
    }
  });
});

router.get('/instances', authMiddleware, (req, res) => {
  const { date, coach_id } = req.query;
  let instances;
  if (date && coach_id) {
    instances = db.prepare(`
      SELECT ci.*, c.name AS coach_name, c.level AS coach_level,
             ct.name AS class_name, ct.type AS class_type, ct.duration, ct.price
      FROM class_instances ci
      JOIN coaches c ON c.id = ci.coach_id
      JOIN class_templates ct ON ct.id = ci.class_template_id
      WHERE ci.date = ? AND ci.coach_id = ?
      ORDER BY ci.start_time
    `).all(date, coach_id);
  } else if (date) {
    instances = db.prepare(`
      SELECT ci.*, c.name AS coach_name, c.level AS coach_level,
             ct.name AS class_name, ct.type AS class_type, ct.duration, ct.price
      FROM class_instances ci
      JOIN coaches c ON c.id = ci.coach_id
      JOIN class_templates ct ON ct.id = ci.class_template_id
      WHERE ci.date = ?
      ORDER BY ci.start_time
    `).all(date);
  } else {
    instances = db.prepare(`
      SELECT ci.*, c.name AS coach_name, c.level AS coach_level,
             ct.name AS class_name, ct.type AS class_type, ct.duration, ct.price
      FROM class_instances ci
      JOIN coaches c ON c.id = ci.coach_id
      JOIN class_templates ct ON ct.id = ci.class_template_id
      ORDER BY ci.date DESC, ci.start_time
      LIMIT 100
    `).all();
  }
  res.json({ instances });
});

module.exports = router;
