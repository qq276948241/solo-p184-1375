const express = require('express');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const CARD_CONFIG = {
  monthly:   { label: '月卡', months: 1, defaultBalance: 50000 },
  quarterly: { label: '季卡', months: 3, defaultBalance: 150000 },
  annual:    { label: '年卡', months: 12, defaultBalance: 500000 }
};

function expireCards() {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare("UPDATE membership_cards SET status = 'expired' WHERE end_date < ? AND status = 'active'").run(today);
}

router.post('/purchase', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const { card_type, balance } = req.body;

  if (!card_type || !CARD_CONFIG[card_type]) {
    return res.status(400).json({ error: '卡类型仅支持: monthly, quarterly, annual' });
  }

  const config = CARD_CONFIG[card_type];
  const topUp = balance !== undefined ? parseInt(balance, 10) : config.defaultBalance;
  if (isNaN(topUp) || topUp <= 0) {
    return res.status(400).json({ error: '充值金额必须为正整数(分)' });
  }

  expireCards();

  const today = new Date();
  const start_date = today.toISOString().slice(0, 10);
  const endDate = new Date(today);
  endDate.setMonth(endDate.getMonth() + config.months);
  const end_date = endDate.toISOString().slice(0, 10);

  const result = db.prepare(`
    INSERT INTO membership_cards (user_id, card_type, balance, start_date, end_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, card_type, topUp, start_date, end_date);

  res.status(201).json({
    message: `${config.label}购买成功`,
    card: {
      id: result.lastInsertRowid,
      card_type,
      card_label: config.label,
      balance: topUp,
      start_date,
      end_date,
      status: 'active'
    }
  });
});

router.get('/my', authMiddleware, (req, res) => {
  const userId = req.user.id;
  expireCards();
  const cards = db.prepare(`
    SELECT * FROM membership_cards WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId);
  const enriched = cards.map(c => ({
    ...c,
    card_label: CARD_CONFIG[c.card_type] ? CARD_CONFIG[c.card_type].label : c.card_type
  }));
  res.json({ cards: enriched });
});

router.post('/:id/topup', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const cardId = req.params.id;
  const { amount } = req.body;

  if (!amount || parseInt(amount, 10) <= 0) {
    return res.status(400).json({ error: '充值金额必须为正整数(分)' });
  }

  const card = db.prepare('SELECT * FROM membership_cards WHERE id = ? AND user_id = ?').get(cardId, userId);
  if (!card) {
    return res.status(404).json({ error: '会员卡不存在' });
  }

  if (card.status === 'expired') {
    return res.status(400).json({ error: '会员卡已过期，请新购会员卡' });
  }

  db.prepare('UPDATE membership_cards SET balance = balance + ? WHERE id = ?').run(parseInt(amount, 10), cardId);
  const updated = db.prepare('SELECT * FROM membership_cards WHERE id = ?').get(cardId);

  res.json({
    message: '充值成功',
    card: { ...updated, card_label: CARD_CONFIG[updated.card_type].label }
  });
});

router.get('/balance', authMiddleware, (req, res) => {
  const userId = req.user.id;
  expireCards();
  const cards = db.prepare(`
    SELECT * FROM membership_cards WHERE user_id = ? AND status = 'active' ORDER BY end_date ASC
  `).all(userId);

  const totalBalance = cards.reduce((sum, c) => sum + c.balance, 0);

  res.json({
    total_balance: totalBalance,
    active_cards: cards.map(c => ({
      ...c,
      card_label: CARD_CONFIG[c.card_type].label
    })),
    can_book: totalBalance > 0
  });
});

router.get('/config', authMiddleware, (req, res) => {
  res.json({ card_types: CARD_CONFIG });
});

module.exports = router;
