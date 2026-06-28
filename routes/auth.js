const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { generateToken, authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.post('/register', (req, res) => {
  const { username, password, real_name, phone } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: '用户名长度3-20字符' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少6位' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: '用户名已存在' });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    'INSERT INTO users (username, password_hash, real_name, phone) VALUES (?, ?, ?, ?)'
  ).run(username, password_hash, real_name || '', phone || '');

  const token = generateToken({ id: result.lastInsertRowid, username, role: 'student' });
  res.status(201).json({
    message: '注册成功',
    user: { id: result.lastInsertRowid, username, real_name: real_name || '', phone: phone || '' },
    token
  });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = generateToken({ id: user.id, username: user.username, role: user.role });
  res.json({
    message: '登录成功',
    user: { id: user.id, username: user.username, real_name: user.real_name, phone: user.phone, role: user.role },
    token
  });
});

router.get('/profile', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, real_name, phone, role, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  res.json({ user });
});

module.exports = router;
