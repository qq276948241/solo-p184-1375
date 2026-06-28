# 社区健身工作室预约系统 — 架构文档

> 目标：读完这份文档，新来的同学能直接上手改代码，知道为什么这么写，踩过哪些坑。

---

## 一、需求是怎么来的

一开始用户的需求很简单：一个社区健身工作室要**约课系统**。业务拆开就是四块：

1. **人**：学员注册登录，记一下真实姓名手机号
2. **课**：两种课 —— 团课（按周固定时段，比如每周一三五早 9 点瑜伽）和私教课（单独约教练，选教练+选时长）
3. **约**：学员点一下就约上，不能约重复时段，团课最多同时挂 2 节，私教还要额外看教练有没有被占；取消时按距离开课时间算退多少钱
4. **钱**：会员卡（月/季/年卡），里面是「余额」（单位是分），扣完了就约不了课

再加一个后来补的**教练评价**：上完课打星（1-5）+ 评论（≤200字），评价列表分页倒序展示，教练列表顺便带个平均评分。

**总结一下，这个系统的业务复杂度不算高，但业务规则特别多，所以我们特别强调代码分层 —— 规则和路由分开写。**

---

## 二、为什么选这些技术？

### Node.js + Express
最主流的纯后端组合，写 API 足够快，社区资料多，团队里谁都能看懂。

### 数据存储：SQLite + better-sqlite3

用户说了「SQLite 或 JSON 都行」，我们选了 **SQLite**，原因：

- JSON 文件不能做事务、不能做并发锁，几个人同时约课就要出事
- SQLite 零配置，单个 `fitness.db` 文件，备份就是复制一份，重启不丢数据
- 部署简单，不用单独跑 MySQL/PostgreSQL 服务，一台小服务器或甚至本地跑都 OK

**数据库驱动为什么选 `better-sqlite3` 而不是 `sqlite3`？**

`sqlite3` 是异步回调风格（或 Promise），数据库操作要嵌套 `await` / `.then()`。但 SQLite 本身是单线程文件数据库，就算你写成异步，底层还是排队等锁 —— **异步写法白白增加代码复杂度，没有任何性能收益**。

`better-sqlite3` 是同步调用，写出来就像：

```javascript
const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
```

没有回调，没有 await，事务也是直接包一个 `db.transaction(() => { ... })`，一眼就能看懂。

---

## 三、项目怎么分层的（文件结构）

```
project184/
├── app.js                 ← 入口：注册路由 + 全局错误处理
├── db/
│   ├── index.js           ← 数据库连接 + 初始化表/加列（幂等启动）
│   ├── init.js            ← 首次建库脚本，塞入 3 个教练、3 节团课模板、等级定价
│   └── migrate-status.js  ← 一次性迁移脚本：扩展 bookings.status 的 CHECK 约束
├── utils/
│   └── common.js          ← 跨模块通用工具：分页解析、退费规则、ensureInstance、endTime 计算等
├── services/
│   ├── bookingService.js  ← 预约业务：创建/取消、冲突校验、余额扣退
│   └── reviewService.js   ← 评价业务：提交、软删、查询（分页、平均分、分布）
├── middleware/
│   └── auth.js            ← JWT 认证中间件（生成 token + 校验请求头 Bearer token）
└── routes/
    ├── auth.js            ← 注册/登录/个人信息（接参→调服务→返回结果）
    ├── courses.js         ← 教练/课程/排课/课次查询
    ├── bookings.js        ← 预约创建/取消/我的预约/提交评价
    ├── membership.js      ← 会员卡购买/充值/余额查询
    └── reviews.js         ← 教练评价/预约评价/我的评价查询
```

### 分层原则（新人改代码看这个就知道该往哪写）

1. **routes 层只做三件事**：拿参数 → 调 service → `res.json(...)` 返回结构化数据。**不要在路由里写 if/else 判断业务规则！**
2. **services 层写纯业务规则**：冲突校验、价格计算、事务操作。通过 `ServiceError(msg, statusCode)` 抛错误，路由层 catch 了转 HTTP 码。
3. **utils 层放两边都用的东西**：比如 `getRefundRate()` 算退费比例，`ensureInstance()` 按排课建具体课次。
4. **db/index.js 只管建表和加列**，用 `PRAGMA table_info` 判断列是否存在，**幂等的** —— 服务重启 100 次也不会出错。

> 💡 为什么不让 service 之间互相调很多？我们控制了耦合深度：`bookingService` 只引用 `reviewService` 的两个东西（`ServiceError` 类 + `softDeleteReviewByBookingId`），其他互相独立。以后要加功能（比如教练回复评价、私教课专属评价），都只改 reviewService 就行，bookingService 不用动。

---

## 四、逐个模块讲清楚

### 4.1 注册登录 — [routes/auth.js](file:///d:/code/ai-prompt/solo-chrome-dev-F12/repos/repo184/project184/routes/auth.js) + [middleware/auth.js](file:///d:/code/ai-prompt/solo-chrome-dev-F12/repos/repo184/project184/middleware/auth.js)

- 密码用 `bcryptjs` 做哈希，数据库里不存明文
- 登录成功后用 `jsonwebtoken` 生成 `Bearer token`，前端每次请求塞 `Authorization: Bearer <token>` 请求头
- `authMiddleware` 中间件：校验 token 没过期，把用户 id/username/role 塞进 `req.user`，后面的路由直接用

**踩过的坑**：密码校验不要用「用户名不存在」和「密码错误」分开返回不同的提示（比如「用户名不存在」会被攻击者枚举用户），我们统一返回「用户名或密码错误」。

### 4.2 课程教练查询 — [routes/courses.js](file:///d:/code/ai-prompt/solo-chrome-dev-F12/repos/repo184/project184/routes/courses.js)

这里有两个概念要区分，新人最容易搞混：

| 概念 | 对应表 | 说明 |
|---|---|---|
| **课程模板 class_templates** | `class_templates` | 课的「种类」：晨瑜伽、燃脂搏击、私教体能… |
| **教练排课 coach_schedules** | `coach_schedules** | 「教练 X 每周 W 天 HH:MM 上课 Y」，是规则模板，不是具体某一天 |
| **课次实例 class_instances** | `class_instances** | 具体到某一天某时某刻的那节课，有人预约时才从排课生成 |

**为什么要分开？** 因为教练排课是「每周一 9 点」，我们不能把未来一年的周一全部塞进数据库。实际是：学员要预约某一天的课，系统先看 `class_instances` 里有没有这节课（之前有人约过就建好了），没有就从 `coach_schedules` 模板复制一份出来生成 —— 这个逻辑封装在 `ensureInstance()` / `ensurePrivateInstance()` 工具函数里，见 [utils/common.js](file:///d:/code/ai-prompt/solo-chrome-dev-F12/repos/repo184/project184/utils/common.js#L78-L139)。

教练列表接口除了返回教练基本信息，还 `LEFT JOIN reviews` 算出 `avg_rating` 和 `review_count`（注意过滤掉软删的评价）。

### 4.3 预约模块 — [services/bookingService.js](file:///d:/code/ai-prompt/solo-chrome-dev-F12/repos/repo184/project184/services/bookingService.js)

这块是业务规则最密集的地方，我们按「创建预约」和「取消预约」讲。

#### 创建预约的校验链

```
参数校验 (type/date 必须, date 不能是过去)
  │
  ├─ 团课分支
  │    · 统计用户当前 active 的团课预约数 >= 2 → 409 拒绝
  │    · 查排课存在 → 是团课类型
  │    · ensureInstance() 确保有具体课次
  │    · 满班？未约过该课次？
  │    · 用户自己的时段冲突？
  │    · 有足够余额的会员卡？
  │    → 事务：扣余额 + booked_count++ + 插入 bookings
  │
  └─ 私教课分支
       · 教练存在 + 课程是私教类型 + 时长 ∈ {30,60,90,120} 分钟
       · 计算 end_time (start_time + duration)
       · 教练时段占用（查 class_instances JOIN bookings WHERE status=active）冲突？
       · 用户时段冲突？
       · 按教练等级算价格：junior 200/h, senior 350/h, expert 500/h → 乘 (duration/60)
       · 余额够？
       · 事务：扣余额 + booked_count+status=full + 插入 bookings
```

**⚠️ 冲突校验算法的坑**：判断两个时间段 A 和 B 是否重叠，正确的 SQL 条件是：

```sql
A.start < B.end AND A.end > B.start   -- 只要这个成立就是重叠
```

不要写成 `A.start BETWEEN B.start AND B.end`，这会漏掉 A 覆盖 B 的情况。我们的 `checkUserTimeConflict()` / `checkCoachTimeConflict()` 都用了这个标准写法。

#### 取消预约的退费规则

距离开课时间 | 退费比例
---|---
≥ 24 小时 | 100%
12 ~ 24 小时 | 50%
< 12 小时 | 0%

逻辑在 `utils/common.js` 的 `getRefundRate()`。

**⚠️ 大踩坑：取消有评价的预约**

最开始直接 `UPDATE bookings SET status='cancelled'`，结果服务崩了 —— 因为 `reviews` 表有外键 `REFERENCES bookings(id)`。虽然 SQLite 的外键默认是「禁止删除/修改被引用的主键」，但实际上 UPDATE bookings 没问题，真正的风险是后续如果有人想 DELETE booking 就会炸。更重要的是，评价是运营资产，直接丢了可惜。

修复方案：**评价软删除**。`reviews` 表加 `deleted_at` 列，取消预约时先 `UPDATE reviews SET deleted_at = datetime('now') WHERE booking_id = ?`（只做一次），然后再改 booking 状态。查询时所有评价接口都加 `WHERE deleted_at IS NULL`，这样平均分、评价数、评价列表都不再算那条。

**顺带修复**：booking 取消后 `reviewed` 字段重置为 0，下次重新约这节课还能再评（用的是 UPDATE 软删那条记录，清掉 `deleted_at`，不会 UNIQUE 冲突）。

### 4.4 会员卡 — [routes/membership.js](file:///d:/code/ai-prompt/solo-chrome-dev-F12/repos/repo184/project184/routes/membership.js)

| 卡类型 | 默认余额（分）| 有效期 |
|---|---|---|
| monthly 月卡 | 50,000（500元） | 1 个月 |
| quarterly 季卡 | 150,000（1500元） | 3 个月 |
| annual 年卡 | 500,000（5000元） | 12 个月 |

预约扣款时，`getActiveCard()` 会挑**最早过期且余额够的卡**（按 `end_date ASC` 排序），避免浪费长期卡的时间。每次操作前 `expireCards()` 把过期卡标成 `expired`，保证过期的卡肯定约不了课。

**⚠️ 为什么不直接用卡次而是余额？** 因为团课（50 元/节）和私教课（200-500/小时，按教练等级）单价差很远，用余额最灵活，以后加新课直接填价格字段就行，不需要改卡类型。

---

## 五、数据库设计要点 & 踩坑

### WAL 模式（SQLite 并发生命线）
[db/index.js](file:///d:/code/ai-prompt/solo-chrome-dev-F12/repos/repo184/project184/db/index.js#L7) 里我们开了 `db.pragma('journal_mode = WAL')`。

**不开 WAL 会怎样？** 默认 SQLite 用 DELETE 日志，写入时会锁整个数据库文件，读请求也要等写入结束。并发稍微高一点（比如两个人同时点预约）就会报 `SQLITE_BUSY`。

**WAL 模式的好处**：读和写可以并行，写操作只是往 WAL 文件追加，不阻塞读。这也是 SQLite 能扛并发的关键。

### CHECK 约束 —— 把校验下沉到数据库
我们大量用了 CHECK：
```sql
status TEXT CHECK(status IN ('active','cancelled','completed'))
rating INTEGER CHECK(rating >= 1 AND rating <= 5)
weekday INTEGER CHECK(weekday >= 0 AND weekday <= 6)
```

**为什么不全部在代码里校验就够了？** 因为代码可能有 bug、可能被新同学绕过、甚至有人直接用数据库客户端改数据。CHECK 约束是最后一道防线，不符合规则的数据进不去。

**⚠️ SQLite CHECK 约束的坑**：创建表后就**不能修改**了！之前要加 `completed` 状态到 `bookings.status`，查了半天 ALTER TABLE 语法，发现 SQLite 不支持 `ALTER TABLE ... MODIFY CHECK`。最后方案是：

1. `PRAGMA foreign_keys = OFF`（暂时关闭外键检查，否则删不掉被引用的 bookings 表）
2. 创建一张新表 `bookings_new`（带新的 CHECK）
3. `INSERT INTO bookings_new SELECT * FROM bookings` 复制数据
4. `DROP TABLE bookings`
5. `ALTER TABLE bookings_new RENAME TO bookings`
6. 重建索引
7. `PRAGMA foreign_keys = ON` 重新打开

脚本在 [db/migrate-status.js](file:///d:/code/ai-prompt/solo-chrome-dev-F12/repos/repo184/project184/db/migrate-status.js)，以后还要加新状态就照着这个模板改。

### 外键约束一定要开
`db.pragma('foreign_keys = ON')`，不然后面乱删数据都不会报错，排查起来要命。

### 幂等的列迁移
`db/index.js` 启动时会用 `PRAGMA table_info(xxx)` 判断某列是否存在，不存在才 `ALTER TABLE ADD COLUMN`。这样服务重启 N 次都不会报错，也不需要单独跑迁移脚本，新人直接 `npm install && npm start` 就能跑起来。

---

## 六、全局错误处理机制

每个 service 抛 `ServiceError(msg, statusCode)`，路由层的小工具 `handleService()` catch 住后：

```javascript
function handleService(res, fn) {
  try { return fn(); }
  catch (err) {
    if (err && err.status) {
      res.status(err.status).json({ error: err.message });
      return null;
    }
    throw err; // 不是 ServiceError 就往上抛给全局错误中间件
  }
}
```

app.js 末尾有个全局错误中间件（[app.js](file:///d:/code/ai-prompt/solo-chrome-dev-F12/repos/repo184/project184/app.js#L73-L82)），处理数据库 UNIQUE/CHECK 冲突这些异常，转成 409/400 返回。

**⚠️ handleService 之前的坑**：最开始 catch 里写的是 `return res.status(...).json(...)`，然后外面又判断 `if (!result) return;` 然后 `res.json(...)`。结果是 catch 时已经发过响应，外面又发一次，触发 `Cannot set headers after they are sent` + 循环序列化报错（因为 Response 对象里有 socket 这种循环引用）。改成 catch 里 `res.status(...)...` + `return null`，外面拿到 null 直接 return，不再第二次发响应。

---

## 七、本地怎么跑起来

```bash
# 1. 初始化数据库（建表+塞种子教练和课程）
node db/init.js

# 2. 启动服务（默认端口 3084）
npm start
# 或
node app.js

# 3. 浏览 http://localhost:3084/ 看全部接口文档
```

**常用接口走一遍**（用 curl 或 Postman）：
```
POST /api/auth/register {username,password,real_name,phone}  → 拿 token
POST /api/membership/purchase {card_type:quarterly}            → 买季卡
GET  /api/courses/coaches                                       → 看教练+平均评分
POST /api/bookings/create {type:group,schedule_id,date}      → 约团课
POST /api/bookings/:id/review {rating,comment}                → 评价（课程结束后）
POST /api/bookings/:id/cancel                                   → 取消（按时间退余额，评价软删）
GET  /api/reviews/coach/:coachId                               → 教练评价（分页倒序+分布）
```

---

## 八、未来可以怎么演进

按**优先级从高到低**：

1. **教练端后台**：教练登录后看自己的排课、学员名单、预约统计；新增排课管理接口（现在是学员端也能 POST 排课，缺少权限校验，`authMiddleware` 里 `req.user.role` 字段可以用上）
2. **管理后台**：导出数据（Excel/CSV）、批量修改排课、手动调整余额、处理异常预约
3. **通知/提醒**：开课前 1 小时短信 / 微信模板消息推送，取消预约成功也推送
4. **签到系统**：教练扫学员码或学员扫码签到，`bookings.status` 再加 `checked_in` 状态，**自动标记 `completed`**（现在 completed 是启动时按日期迁移的，比较粗）
5. **数据报表**：收入趋势（按卡类型 / 教练 / 课程）、教练评分走势、出勤率
6. **升级数据库**：如果并发量上来（≥50 并发写入），SQLite 可能扛不住，可以考虑换到 MySQL / PostgreSQL —— 因为我们用了 service 层隔离，数据库访问都在 service 和 utils 里，改驱动的工作量可控
7. **多门店**：`coach_schedules`、`class_instances`、`membership_cards` 都加 `studio_id` 字段，一次部署管多家店
8. **Redis 缓存**：教练平均评分、热门课程列表、会员卡余额这些不经常变的数据可以放缓存，减少 SQL 查询

---

**一句话给新人**：改规则先找 service 层，加接口先写路由调 service，加字段去 `db/index.js` 里 `PRAGMA` 判空再 ALTER，最后别忘了写 `init.js` 的建表语句同步一下。有问题先看这份文档的「踩过的坑」部分，大概率遇到过 🙂
