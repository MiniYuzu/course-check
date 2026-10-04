# 首页今日课程优先 Implementation Plan

> 执行方式：当前开发目录内直接完成，按测试驱动流程实施；用户已确认规则。不新建工作目录，不提交或推送代码。

**Goal:** 今天有正式排课的课程按开始时间优先展示，其余课程保持原有相对顺序，打卡不引起卡片跳位。

**Architecture:** 仅在首页展示层排序，不改云端或本机保存的课程顺序。复用现有排课时间线规则，查询中国日期当天的正式安排，忽略打卡结果；同一时间保持原顺序。首页模板和首屏空间不变，不增加拖拽或分组卡片。

**Tech Stack:** 微信小程序 JavaScript、WXML；Node.js 内置测试框架。

## Task 1：先验证排序规则

**Files:** Create `tests/home-course-order.test.js`.

- [x] 用现有客户端测试环境加载真实首页和本地数据模块：正式排课混在普通课程中，断言早课、同时间课程、晚课依次靠前，其余课程顺序不变。
- [x] 验证已出席、缺席、停课不会改变排序；历史已停止、未来才开始、仅文字备忘不会误置顶；跨天重新判断，空列表不报错。
- [x] 执行 `node --test tests/home-course-order.test.js`，先确认旧首页没有排序而失败：6 项中 5 项按预期失败，1 项原有行为通过。

页面测试核心断言：

```js
page.render();
assert.deepEqual(Array.from(page.data.courses, item => item._id),
  ['morning', 'same-time', 'afternoon', 'other-a', 'other-b']);
assert.equal(JSON.stringify(storage.read()), before);
```

## Task 2：最小展示层实现

**Files:** Modify `miniprogram/utils/attendance-view.js`, `miniprogram/pages/index/index.js`.

- [x] 在展示工具中增加下面的纯排序函数，导出它并导入已有 `courseTimeline`：

```js
function sortHomeCourses(courses, date = today()) {
  return courses.map((course, index) => ({
    course, index, slot: courseTimeline(course, [], { from: date, to: date })[0]
  })).sort((a, b) => {
    if (a.slot && b.slot) return a.slot.start.localeCompare(b.slot.start) || a.index - b.index;
    if (a.slot) return -1;
    if (b.slot) return 1;
    return a.index - b.index;
  }).map(item => item.course);
}
```

- [x] 首页 `render` 只读取一次 `today()`，过滤归档课程后调用 `sortHomeCourses`，并将同一个日期传给 `scheduleLabel`；其余数据和行为不变。
- [x] 执行 `node --test tests/home-course-order.test.js tests/home-reminders.test.js`，11 项通过。

## Task 3：回归与实际页面核对

**Files:** Modify `README.md` 首页功能说明。

- [x] 说明“今日排课按开始时间优先，其余保持原有顺序，打卡不跳位”。
- [x] 执行 `npm run verify` 和 `git diff --check`：217 项测试、79 项源码/配置/模板检查通过，无空白差异错误。npm 仍提示已有的用户配置 `home` 警告，本次未改动用户 npm 配置。
- [x] 微信开发者工具通过“工具 → 编译”重新编译，首页原课程、余额与下次上课提示正常显示；未新增或修改真实课程/云端记录。
- [x] 多课程优先、同时间稳定、确认结果后不跳位、版本生效及中国日期跨天由 6 项新增测试验证。模拟器当前只有一门在用课程，因此人工检查只覆盖编译与首页显示，不声称已完成人工多课程排序验收。
