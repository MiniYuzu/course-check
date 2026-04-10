# 云数据库权限规则配置

在微信开发者工具中配置以下数据库权限：

---

## 1. courses 集合（课程）

```json
{
  "read": "doc._openid == auth.openid",
  "write": "doc._openid == auth.openid"
}
```

说明：用户只能读写自己创建的课程

---

## 2. checkins 集合（打卡记录）

```json
{
  "read": "doc._openid == auth.openid",
  "write": "doc._openid == auth.openid"
}
```

说明：用户只能读写自己的打卡记录

---

## 3. users 集合（用户信息）

```json
{
  "read": "doc._openid == auth.openid",
  "write": "doc._openid == auth.openid"
}
```

说明：用户只能读写自己的用户信息

---

## 配置步骤

1. 打开微信开发者工具
2. 点击「云开发」→「数据库」
3. 创建以下集合：
   - `courses`
   - `checkins`
   - `users`
4. 点击每个集合的「权限设置」
5. 选择「自定义权限」并粘贴上面的规则
6. 保存

---

## 索引配置（提升性能）

在 checkins 集合上创建以下索引：

1. 复合索引：`courseId` + `date` + `_openid`
2. 单字段索引：`date`（降序）
3. 单字段索引：`_openid`

在 courses 集合上创建：

1. 单字段索引：`_openid`
2. 单字段索引：`createdAt`（降序）
