const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const reviewService = require('../services/reviewService');

const router = express.Router();

function handleService(res, fn) {
  try {
    return fn();
  } catch (err) {
    if (err && err.status) {
      res.status(err.status).json({ error: err.message });
      return null;
    }
    throw err;
  }
}

router.get('/coach/:coachId', authMiddleware, (req, res) => {
  const result = handleService(res, () => reviewService.getCoachReviews(parseInt(req.params.coachId, 10), req.query));
  if (!result) return;
  res.json(result);
});

router.get('/booking/:bookingId', authMiddleware, (req, res) => {
  const result = handleService(res, () => reviewService.getBookingReview(req.user.id, parseInt(req.params.bookingId, 10)));
  if (!result) return;
  res.json({ review: result });
});

router.get('/my', authMiddleware, (req, res) => {
  const result = handleService(res, () => reviewService.getMyReviews(req.user.id, req.query));
  if (!result) return;
  res.json(result);
});

module.exports = router;
