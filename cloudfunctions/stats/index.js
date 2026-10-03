// 云函数：统计功能
// 功能：周统计、课程排行、月度统计、连续打卡、热力图数据

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

function formatLocalDate(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function shiftDate(date, days) {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
}

async function getAll(collection, condition) {
  const rows = [];
  while (true) {
    const { data } = await db.collection(collection).where(condition).orderBy('_id', 'asc')
      .skip(rows.length).limit(100).get();
    rows.push(...data);
    if (data.length < 100) return rows;
  }
}

function realDatedCheckins(checkins) {
  const today = formatLocalDate();
  return checkins.filter(({ date }) => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000') || date > today) return false;
    const parsed = new Date(`${date}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  });
}

// 旧版可能留下同课同日多个随机 ID；只在计算时去重，原始历史不变。
function uniqueCheckins(checkins) {
  const records = new Map();
  checkins.forEach(checkin => records.set(JSON.stringify([checkin.courseId, checkin.date]), checkin));
  return [...records.values()];
}

async function getDatedCheckins(condition) {
  return uniqueCheckins(realDatedCheckins(await getAll('checkins', condition)));
}

// 验证用户权限
async function verifyAuth(event) {
  const wxContext = cloud.getWXContext();
  const OPENID = wxContext.OPENID;

  if (!OPENID || (event.expectedOpenid !== undefined && event.expectedOpenid !== OPENID)) {
    throw new Error('Unauthorized');
  }

  return OPENID;
}

// 获取总览统计
async function getOverview(openid) {
  const courses = await getAll('courses', { _openid: openid });
  const checkins = uniqueCheckins(await getAll('checkins', { _openid: openid }));
  const datedCheckins = realDatedCheckins(checkins);
  const totalCourses = courses.filter(course => course.isDeleted !== true).length;
  // 初始已上课时没有日期，只加入累计总数，不分摊到某天、某周或某月。
  const totalCheckins = checkins.length + courses.reduce((total, course) => total + (course.initialLessons || 0), 0);

  // 本周打卡数
  const weekStart = getWeekStart();
  const today = formatLocalDate();
  const weekCheckins = datedCheckins.filter(checkin => checkin.date >= weekStart).length;

  // 本月打卡数
  const monthStart = getMonthStart();
  const monthCheckins = datedCheckins.filter(checkin => checkin.date >= monthStart).length;

  // 今日是否打卡
  const todayCount = datedCheckins.filter(checkin => checkin.date === today).length;
  const streaks = calculateStreaks([...new Set(datedCheckins.map(checkin => checkin.date))].sort());

  return {
    totalCourses,
    totalCheckins,
    streakDays: streaks.current,
    weekCheckins,
    monthCheckins,
    todayCheckins: todayCount,
    hasCheckedInToday: todayCount > 0
  };
}

// 获取周打卡统计（用于图表）
async function getWeeklyStats(openid, event) {
  const { offset = 0 } = event; // offset: 0=本周, 1=上周, -1=下周

  const weekDates = getWeekDates(offset);
  const startDate = weekDates[0];
  const endDate = weekDates[6];

  // 获取本周所有打卡记录
  const checkins = await getDatedCheckins({ _openid: openid, date: _.gte(startDate).and(_.lte(endDate)) });

  // 按日期统计
  const dailyStats = weekDates.map(date => {
    const dayCheckins = checkins.filter(c => c.date === date);
    return {
      date,
      dayOfWeek: getDayOfWeek(date),
      dayName: getDayName(date),
      count: dayCheckins.length,
      courses: [...new Set(dayCheckins.map(c => c.courseId))]
    };
  });

  return {
    weekRange: { start: startDate, end: endDate },
    dailyStats,
    total: checkins.length
  };
}

// 获取课程排行
async function getCourseRanking(openid) {
  // 获取所有课程
  const courses = await getAll('courses', { _openid: openid });

  // 获取每个课程的打卡数
  const ranking = await Promise.all(
    courses.map(async (course) => {
      const checkins = uniqueCheckins(await getAll('checkins', { courseId: course._id, _openid: openid }));
      const recordCount = checkins.length;

      // 最近打卡时间
      const { data: recentCheckins } = await db.collection('checkins')
        .where({
          courseId: course._id,
          _openid: openid
        })
        .orderBy('date', 'desc')
        .limit(1)
        .get();

      const lastCheckinAt = recentCheckins.length > 0 ? recentCheckins[0].date : null;
      const total = recordCount + (course.initialLessons || 0);

      // 完成进度
      const progress = course.totalLessons > 0
        ? Math.min(100, Math.round((total / course.totalLessons) * 100))
        : 0;

      return {
        ...course,
        checkinCount: total,
        lastCheckinAt,
        progress,
        remaining: Math.max(0, course.totalLessons - total)
      };
    })
  );

  // 按打卡数排序
  ranking.sort((a, b) => b.checkinCount - a.checkinCount);

  return {
    ranking,
    total: ranking.length
  };
}

// 获取月度统计
async function getMonthlyStats(openid, event) {
  const today = formatLocalDate();
  const { year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7)) } = event;
  if (!Number.isInteger(year) || year < 1000 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('Invalid month');
  }

  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const monthEnd = getMonthEnd(year, month);

  // 当月打卡记录
  const checkins = await getDatedCheckins({ _openid: openid, date: _.gte(monthStart).and(_.lte(monthEnd)) });

  // 按课程统计
  const courseStats = {};
  checkins.forEach(checkin => {
    if (!courseStats[checkin.courseId]) {
      courseStats[checkin.courseId] = 0;
    }
    courseStats[checkin.courseId]++;
  });

  // 获取课程详情
  const courseIds = Object.keys(courseStats);
  const courses = await Promise.all(
    courseIds.map(async (id) => {
      const { data: courses } = await db.collection('courses')
        .where({
          _id: id,
          _openid: openid
        })
        .limit(1)
        .get();
      const courseData = courses[0] || {};
      return {
        ...courseData,
        monthCheckins: courseStats[id]
      };
    })
  );

  // 打卡天数（去重日期）
  const uniqueDates = [...new Set(checkins.map(c => c.date))];

  // 生成日历数据
  const calendar = generateCalendar(year, month, checkins);

  return {
    year,
    month,
    monthRange: { start: monthStart, end: monthEnd },
    totalCheckins: checkins.length,
    uniqueDays: uniqueDates.length,
    averagePerDay: uniqueDates.length > 0
      ? (checkins.length / uniqueDates.length).toFixed(1)
      : 0,
    courseBreakdown: courses,
    calendar
  };
}

// 生成热力图数据
async function getHeatmapData(openid, event) {
  const { days = 365 } = event; // 默认最近一年
  const rangeDays = Math.min(Math.max(Number(days) || 365, 1), 366);

  const endDate = formatLocalDate();
  const startDateStr = shiftDate(endDate, -rangeDays + 1);

  const checkins = await getDatedCheckins({ _openid: openid, date: _.gte(startDateStr).and(_.lte(endDate)) });

  // 按日期聚合
  const dateMap = {};
  checkins.forEach(checkin => {
    if (!dateMap[checkin.date]) {
      dateMap[checkin.date] = 0;
    }
    dateMap[checkin.date]++;
  });

  // 转换为热力图格式
  const heatmapData = Object.entries(dateMap).map(([date, count]) => ({
    date,
    count,
    level: getHeatmapLevel(count)
  }));

  // 计算连续打卡记录
  const streaks = calculateStreaks(Object.keys(dateMap).sort());

  return {
    startDate: startDateStr,
    endDate,
    heatmapData,
    totalDays: Object.keys(dateMap).length,
    currentStreak: streaks.current,
    longestStreak: streaks.longest,
    totalCheckins: checkins.length
  };
}

// 获取趋势数据
async function getTrends(openid, event) {
  const { weeks = 12 } = event; // 默认最近12周
  if (!Number.isSafeInteger(weeks) || weeks < 1 || weeks > 52) {
    throw new Error('Invalid weeks: expected an integer from 1 to 52');
  }

  const trends = [];

  for (let i = weeks - 1; i >= 0; i--) {
    const weekStartStr = shiftDate(getWeekStart(), -i * 7);
    const weekEndStr = shiftDate(weekStartStr, 6);

    const checkins = await getDatedCheckins({
      _openid: openid,
      date: _.gte(weekStartStr).and(_.lte(weekEndStr))
    });

    trends.push({
      weekStart: weekStartStr,
      weekEnd: weekEndStr,
      count: checkins.length
    });
  }

  return {
    weeks,
    trends,
    average: trends.length > 0
      ? (trends.reduce((sum, t) => sum + t.count, 0) / trends.length).toFixed(1)
      : 0
  };
}

// ========== 工具函数 ==========

function getWeekStart() {
  const today = formatLocalDate();
  return shiftDate(today, -getDayOfWeek(today));
}

function getMonthStart() {
  return `${formatLocalDate().slice(0, 7)}-01`;
}

function getMonthEnd(year, month) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

function getWeekDates(offset = 0) {
  return Array.from({ length: 7 }, (_, day) => shiftDate(getWeekStart(), -offset * 7 + day));
}

function getDayOfWeek(dateStr) {
  const date = new Date(dateStr);
  return date.getUTCDay();
}

function getDayName(dateStr) {
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const date = new Date(dateStr);
  return days[date.getUTCDay()];
}

function generateCalendar(year, month, checkins) {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const calendar = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayCheckins = checkins.filter(c => c.date === dateStr);

    calendar.push({
      date: dateStr,
      day,
      count: dayCheckins.length,
      hasCheckin: dayCheckins.length > 0
    });
  }

  return calendar;
}

function getHeatmapLevel(count) {
  if (count === 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 5) return 3;
  return 4;
}

function calculateStreaks(dates) {
  if (dates.length === 0) {
    return { current: 0, longest: 0 };
  }

  const todayStr = formatLocalDate();
  const yesterdayStr = shiftDate(todayStr, -1);

  // 计算当前连续天数
  let currentStreak = 0;
  if (dates.includes(todayStr)) {
    currentStreak = 1;
  } else if (dates.includes(yesterdayStr)) {
    currentStreak = 1;
  } else {
    currentStreak = 0;
  }

  if (currentStreak > 0) {
    let checkDate = dates.includes(todayStr) ? todayStr : yesterdayStr;
    while (true) {
      checkDate = shiftDate(checkDate, -1);
      if (dates.includes(checkDate)) {
        currentStreak++;
      } else {
        break;
      }
    }
  }

  // 计算最长连续天数
  let longestStreak = 1;
  let current = 1;

  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i - 1]);
    const curr = new Date(dates[i]);
    const diffDays = (curr - prev) / (1000 * 60 * 60 * 24);

    if (diffDays === 1) {
      current++;
      longestStreak = Math.max(longestStreak, current);
    } else {
      current = 1;
    }
  }

  return { current: currentStreak, longest: longestStreak };
}

// 主入口
exports.main = async (event = {}, context) => {
  try {
    const openid = await verifyAuth(event);
    const { action } = event;
    const payload = event.data || event;

    let result;
    switch (action) {
      case 'overview':
        result = await getOverview(openid);
        break;
      case 'weekly':
        result = await getWeeklyStats(openid, payload);
        break;
      case 'ranking':
        result = await getCourseRanking(openid);
        break;
      case 'monthly':
        result = await getMonthlyStats(openid, payload);
        break;
      case 'heatmap':
        result = await getHeatmapData(openid, payload);
        break;
      case 'trends':
        result = await getTrends(openid, payload);
        break;
      default:
        // 默认返回总览
        result = await getOverview(openid);
    }

    return {
      success: true,
      code: 200,
      data: result,
      message: 'Success'
    };

  } catch (error) {
    console.error('Stats function error:', error);

    const errorCode = error.message === 'Unauthorized' ? 401 : error.message.includes('Invalid') ? 400 : 500;

    return {
      success: false,
      code: errorCode,
      data: null,
      message: error.message
    };
  }
};
