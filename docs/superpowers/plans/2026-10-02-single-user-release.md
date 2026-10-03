# 单人记课可靠性与产品闭环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. 不自动提交、推送或部署。只依据代码和本轮批准范围，不读取旧需求或架构文档。

**Goal:** 完成一个家长使用的课程记账闭环：建课 → 当日记课/补记 → 撤销 → 余额和月统计 → 归档恢复 → 导出。离线操作不会被刷新覆盖，错误不会伪装成功。

**Architecture:** 保留微信原生小程序与四个独立云函数。服务端校验身份和业务规则；客户端使用按环境、身份隔离的持久队列，将未同步操作叠加在云端快照上。历史记录按页取全，再由纯函数产生一致的业务统计。旧无身份缓存只保留与导出，不自动上传。

**Tech Stack:** 原生 JS/WXML/WXSS，微信云开发，Node.js 内置测试运行器；不新增应用框架或独立后台。

## 范围与验收

- 单用户，同一课程同一日期至多一节，不允许未来日期。
- `initialLessons` 是开始使用前已上课时，计入累计和余额，不伪造日期，不计入月统计。
- 课程包允许超出购买课时，剩余显示 0，并明确显示超出数量；未设置总课时不显示假进度。
- 归档隐藏首页课程，但保留历史统计与导出；可恢复，不提供永久删除入口。
- 云端未知/离线/有缓存/待同步/失败分别表达；首次未登录不允许创建无归属队列。
- 家庭共享、多孩子、订阅提醒、成就、独立管理后台暂缓；不保留“开发中”的假入口。
- 本地测试与静态检查可验收；微信编译、真机、云环境权限和费用必须另行验证，不以 HTML 示意代替。

## 文件责任

- `cloudfunctions/{login,course,checkin,stats}/`：身份、校验、幂等写入、完整分页及服务端统计。各函数独立可部署，不跨函数 require。
- `miniprogram/utils/{storage,sync-queue,db}.js`：身份隔离、本地快照、排队、顺序重试和对账。
- `miniprogram/utils/records.js`：日期、课时和月统计纯函数。
- `miniprogram/utils/export.js`：导出文件内容（课程、记录、待同步信息）。
- `miniprogram/config.js`：用户填写的云环境配置，非密钥。
- `miniprogram/pages/` 与已有组件：三页导航、课程编辑/详情、归档、补记、撤销、导出及真实状态。
- `tests/`：Node 行为测试及微信 API 边界替身；`scripts/check-project.js`：JS/JSON/引用及模板结构检查。
- 根目录 `package.json`、`project.config.json`、`.gitignore`：可复现开发入口与隐私隔离。
- `docs/SETUP.md`、`docs/ACCEPTANCE.md`：人工接入步骤和验收记录。旧文档、历史设计预览和现有未提交改动不随意删除。

## 接口约定

云函数返回 `{ success, code, data, message }`；身份只取 `getWXContext().OPENID`。

- course.list：`page,limit,includeArchived`，返回 `{courses,total}`，每项 `_id,isDeleted,initialLessons,totalLessons,completedCount,isCheckedIn`。统计包含 baseline。get 可读自己的归档课程。
- course.add：字段在 `data` 中；`operationId` 位于 `data`，重试必须得到同一课程，不更新已存在课程。
- course.update：`courseId,updates`。course.archive/restore：`courseId`。旧 delete 只作为 archive 别名，禁止永久删除。
- checkin.list：`courseId` 可选，`page,limit,startDate,endDate`，返回 `{checkins,total}`；按稳定次序分页。
- checkin.checkin：`data:{courseId,date,notes}`；同课同日原子防重，重复返回既有记录；cancel：`data:{courseId,date}`，不存在也成功。
- stats：保留已有 action，但不依赖用户表中易过期的累计值；所有聚合必须分页取全，归档历史保留。

## 执行任务（依赖顺序）

### 1. 云端可靠性

- [x] 先写 `tests/cloud.test.js` 与最小云 API 替身，运行 `node --test tests/cloud.test.js` 观察防重、补记校验、baseline、归档、分页失败。
- [x] 实现云端幂等新增、原子同日去重、幂等撤销、归档恢复、整数校验和完整计数；避免缓存用户统计双写。
- [x] 重跑同一测试，独立规格审查后做质量审查；修关键问题。

### 2. 本地数据链路

- [x] 先写 `tests/records.test.js`、`tests/data.test.js`，覆盖 60+ 记录、月末跨月、断网、刷新覆盖、同步中重启、失败后重试、身份隔离和新增课程依赖。
- [x] 实现 records/storage/queue/db/export，保留旧存储、单一队列写入边界、顺序依赖、真实同步结果；补全分页读取。
- [x] 运行 `node --test tests/records.test.js tests/data.test.js`，独立审查规格和质量。

### 3. 产品界面与工程交付

- [x] 先写 `tests/ui.test.js`，覆盖原生事件、不重复保存、补记撤销、月份选择、导出、归档及同步失败反馈。
- [x] 统一原生导航和三页底栏，缩小装饰区、使用浅色卡片、全类型可读、显示余额；隐藏未实现入口。
- [x] 完成课程编辑 baseline、详情日期选择与历史筛选、统计月选择、我的归档恢复/导出/重试/旧数据保护说明。
- [x] 添加项目配置、固定 SDK 版本与锁文件、脚本及手动接入文档；保持单仓库原生目录。
- [x] `npm test`、`npm run check`、`git diff --check`；执行端到端模拟“建课→断网记课→重启→恢复同步→补记→撤销→归档恢复→导出”。
- [x] 独立规格/质量审查（集中 1～2 轮），修复关键问题，记录尚未经过微信运行时验证的部分。

## 本地交付结果（2026-10-02）

- 单人版本范围已获用户确认；云端、本地数据链路、界面的规格与质量审查均通过。
- 自动化共 69 项通过：云函数 37、本地数据 12、统计规则 6、界面 12、完整模拟流程 2；静态检查覆盖 60 个源代码、配置与模板文件。
- 本地分支：`codex/single-user-reliability`。未自动提交、推送或部署。
- 微信编译、真机交互、真实数据库权限与云端事务仍待联调；逐项操作见 `docs/ACCEPTANCE.md`，不计入上述完成项。

## 交付边界

本轮不自动提交 Git，不推 GitHub，不动线上数据，不注册账号，不购买云资源。用户负责微信扫码、主体注册、AppID 和云环境授权；助手负责本地实现、可复现配置、测试与操作清单。
