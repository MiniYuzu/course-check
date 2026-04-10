# 云函数部署指南

## 目录结构

```
cloudfunctions/
├── login/          # 登录云函数
│   ├── index.js
│   ├── package.json
│   └── config.json
├── course/         # 课程管理云函数
│   ├── index.js
│   └── package.json
├── checkin/        # 打卡云函数
│   ├── index.js
│   └── package.json
├── stats/          # 统计云函数
│   ├── index.js
│   └── package.json
├── db-rules.md     # 数据库权限规则
└── DEPLOY.md       # 本文件
```

---

## 部署步骤

### 第一步：开通云开发

1. 打开微信开发者工具
2. 点击工具栏「云开发」按钮
3. 点击「开通」
4. 创建环境（或使用已有环境）
5. 记录环境 ID

### 第二步：配置项目

修改 `miniprogram/app.js` 中的云开发环境 ID：

```javascript
wx.cloud.init({
  env: '你的环境ID',  // 替换为你的云开发环境 ID
  traceUser: true
});
```

### 第三步：创建数据库集合

1. 进入「云开发控制台」→「数据库」
2. 创建以下集合：
   - `users` - 用户信息
   - `courses` - 课程
   - `checkins` - 打卡记录
3. 设置权限为「仅创建者可读写」（参考 db-rules.md）

### 第四步：部署云函数

在开发者工具中：

1. 展开 `cloudfunctions/login` 文件夹
2. 右键点击 `login` →「创建并部署：云端安装依赖」
3. 等待部署完成（控制台会有提示）
4. 对 `course`、`checkin`、`stats` 重复上述操作

### 第五步：测试

1. 重新编译项目
2. 点击登录按钮
3. 添加课程测试
4. 打卡测试

---

## 云函数接口说明

### login 云函数

**调用方式：**
```javascript
wx.cloud.callFunction({
  name: 'login',
  data: {
    nickName: '用户昵称',
    avatarUrl: '头像URL'
  }
})
```

**返回数据：**
```javascript
{
  success: true,
  code: 200,
  data: {
    openid: '用户openid',
    userId: '用户记录ID',
    isNewUser: false,
    userInfo: { ... }
  }
}
```

---

### course 云函数

**Actions:**
- `list` - 获取课程列表
- `get` - 获取单个课程
- `add` - 添加课程
- `update` - 更新课程
- `delete` - 删除课程

**调用示例：**
```javascript
// 获取列表
wx.cloud.callFunction({
  name: 'course',
  data: { action: 'list', includeStats: true }
})

// 添加课程
wx.cloud.callFunction({
  name: 'course',
  data: {
    action: 'add',
    name: '游泳课',
    type: 'swim',
    totalLessons: 20
  }
})
```

---

### checkin 云函数

**Actions:**
- `list` - 获取打卡记录
- `hasCheckedIn` - 检查是否已打卡
- `checkin` - 打卡
- `cancel` - 取消打卡
- `batch` - 批量打卡

**调用示例：**
```javascript
// 打卡
wx.cloud.callFunction({
  name: 'checkin',
  data: {
    action: 'checkin',
    courseId: '课程ID',
    notes: '今天学得很棒！'
  }
})
```

---

### stats 云函数

**Actions:**
- `overview` - 总览统计
- `weekly` - 周统计
- `ranking` - 课程排行
- `monthly` - 月度统计
- `heatmap` - 热力图数据
- `trends` - 趋势数据

**调用示例：**
```javascript
// 获取总览
wx.cloud.callFunction({
  name: 'stats',
  data: { action: 'overview' }
})

// 获取周统计
wx.cloud.callFunction({
  name: 'stats',
  data: { action: 'weekly', offset: 0 }
})
```

---

## 常见问题

### 1. 云函数部署失败

- 检查微信开发者工具是否已登录微信账号
- 检查网络连接
- 尝试重新部署

### 2. 调用云函数报 404

- 确认云函数已部署
- 检查云函数名称是否正确
- 重新编译项目

### 3. 权限错误

- 检查数据库权限设置
- 确认用户已登录（有有效的 openid）

### 4. 数据不同步

- 检查网络状态
- 查看同步状态组件
- 手动触发同步：重新进入小程序
