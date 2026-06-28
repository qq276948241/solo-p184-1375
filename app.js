const express = require('express');
const db = require('./db');

const authRoutes = require('./routes/auth');
const courseRoutes = require('./routes/courses');
const bookingRoutes = require('./routes/bookings');
const membershipRoutes = require('./routes/membership');

const app = express();
const PORT = process.env.PORT || 3084;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    name: '社区健身工作室预约系统',
    version: '1.0.0',
    endpoints: {
      auth: {
        'POST /api/auth/register': '注册',
        'POST /api/auth/login': '登录',
        'GET  /api/auth/profile': '获取个人信息'
      },
      courses: {
        'GET  /api/courses/coaches': '教练列表',
        'GET  /api/courses/coaches/:id': '教练详情+排课',
        'GET  /api/courses/classes': '课程模板列表',
        'GET  /api/courses/pricing': '教练等级定价',
        'GET  /api/courses/schedule': '周排课表 (?weekday=0-6)',
        'POST /api/courses/schedule': '新增排课',
        'GET  /api/courses/instances': '课次实例 (?date=&coach_id=)'
      },
      bookings: {
        'POST /api/bookings/create': '创建预约',
        'POST /api/bookings/:id/cancel': '取消预约',
        'GET  /api/bookings/my': '我的预约',
        'GET  /api/bookings/refund-rules': '退费规则'
      },
      membership: {
        'POST /api/membership/purchase': '购买会员卡',
        'GET  /api/membership/my': '我的会员卡',
        'POST /api/membership/:id/topup': '充值',
        'GET  /api/membership/balance': '余额查询',
        'GET  /api/membership/config': '卡类型配置'
      }
    }
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/membership', membershipRoutes);

app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  if (err.message && err.message.includes('UNIQUE constraint')) {
    return res.status(409).json({ error: '数据冲突：' + err.message });
  }
  if (err.message && err.message.includes('CHECK constraint')) {
    return res.status(400).json({ error: '数据校验失败：' + err.message });
  }
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`健身工作室预约系统已启动: http://localhost:${PORT}`);
  console.log(`API 文档: http://localhost:${PORT}/`);
});

process.on('SIGINT', () => {
  console.log('\n服务关闭');
  db.close();
  process.exit(0);
});
