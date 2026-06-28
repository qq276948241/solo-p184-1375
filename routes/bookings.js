const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const bookingService = require('../services/bookingService');
const reviewService = require('../services/reviewService');

const router = express.Router();

function handleService(res, fn) {
  try {
    return fn();
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }
}

router.post('/create', authMiddleware, (req, res) => {
  const result = handleService(res, () => bookingService.createBooking(req.user.id, req.body));
  if (!result) return;
  res.status(201).json(result);
});

router.post('/:id/cancel', authMiddleware, (req, res) => {
  const result = handleService(res, () => bookingService.cancelBooking(req.user.id, parseInt(req.params.id, 10)));
  if (!result) return;
  res.json(result);
});

router.get('/my', authMiddleware, (req, res) => {
  res.json({ bookings: bookingService.listUserBookings(req.user.id) });
});

router.get('/refund-rules', authMiddleware, (_req, res) => {
  res.json({ rules: bookingService.CANCEL_REFUND_RULES });
});

router.post('/:id/review', authMiddleware, (req, res) => {
  const result = handleService(res, () => reviewService.submitReview(
    req.user.id,
    parseInt(req.params.id, 10),
    req.body.rating,
    req.body.comment
  ));
  if (!result) return;
  res.status(201).json({ message: '评价提交成功', review: result });
});

module.exports = router;
