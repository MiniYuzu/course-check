// 云函数：统计功能
// 功能：周统计、课程排行、月度统计、连续打卡、热力图数据

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

// 验证用户权限
async function verifyAuth(context) {
  const wxContext = cloud.getWXContext();
  const OPENID = wxContext.OPENID;

  if (!OPENID) {
    throw new Error('Unauthorized');
  }

  return OPENID;
}

// 获取总览统计
async function getOverview(openid) {
  // 课程总数
  const { total: totalCourses } = await db.collection('courses')
    .where({
      _openid: openid,
      isDeleted: _.neq(true)
    })
    .count();

  // 打卡总数
  const { total: totalCheckins } = await db.collection('checkins')
    .where({ _openid: openid })
    .count();

  // 获取用户信息（连续打卡天数）
  const { data: users } = await db.collection('users')
    .where({ _openid: openid })
    .limit(1)
    .get();

  const userInfo = users[0] || {};

  // 本周打卡数
  const weekStart = getWeekStart();
  const { total: weekCheckins } = await db.collection('checkins')
    .where({
      _openid: openid,
      date: _.gte(weekStart)
    })
    .count();

  // 本月打卡数
  const monthStart = getMonthStart();
  const { total: monthCheckins } = await db.collection('checkins')
    .where({
      _openid: openid,
      date: _.gte(monthStart)
    })
    .count();

  // 今日是否打卡
  const today = new Date().toISOString().split('T')[0];
  const { total: todayCount } = await db.collection('checkins')
    .where({
      _openid: openid,
      date: today
    })
    .count();

  return {
    totalCourses,
    totalCheckins,
    streakDays: userInfo.streakDays || 0,
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
  const { data: checkins } = await db.collection('checkins')
    .where({
      _openid: openid,
      date: _.gte(startDate).and(_.lte(endDate))
    })
    .get();

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
  const { data: courses } = await db.collection('courses')
    .where({
      _openid: openid,
      isDeleted: _.neq(true)
    })
    .get();

  // 获取每个课程的打卡数
  const ranking = await Promise.all(
    courses.map(async (course) => {
      const { total } = await db.collection('checkins')
        .where({
          courseId: course._id,
          _openid: openid
        })
        .count();

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
  const { year = new Date().getFullYear(), month = new Date().getMonth() + 1 } = event;

  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const monthEnd = getMonthEnd(year, month);

  // 当月打卡记录
  const { data: checkins } = await db.collection('checkins')
    .where({
      _openid: openid,
      date: _.gte(monthStart).and(_.lte(monthEnd))
    })
    .get();

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
      const { data: courseData } = await db.collection('courses')
        .doc(id)
        .get();
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

  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];

  const { data: checkins } = await db.collection('checkins')
    .where({
      _openid: openid,
      date: _.gte(startDate).and(_.lte(endDate))
    })
    .get();

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
    startDate,
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

  const trends = [];
  const now = new Date();

  for (let i = weeks - 1; i >= 0; i--) {
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay() - i * 7);
    const weekStartStr = weekStart.toISOString().split('T')[0];

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    const { total } = await db.collection('checkins')
      .where({
        _openid: openid,
        date: _.gte(weekStartStr).and(_.lte(weekEndStr))
      })
      .count();

    trends.push({
      weekStart: weekStartStr,
      weekEnd: weekEndStr,
      count: total
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
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day;
  const sunday = new Date(now.setDate(diff));
  return sunday.toISOString().split('T')[0];
}

function getMonthStart() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

function getMonthEnd(year, month) {
  const lastDay = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

function getWeekDates(offset = 0) {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + offset * 7;
  const sunday = new Date(now.setDate(diff));

  const dates = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(sunday);
    date.setDate(sunday.getDate() + i);
    dates.push(date.toISOString().split('T')[0]);
  }
  return dates;
}

function getDayOfWeek(dateStr) {
  const date = new Date(dateStr);
  return date.getDay();
}

function getDayName(dateStr) {
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const date = new Date(dateStr);
  return days[date.getDay()];
}

function generateCalendar(year, month, checkins) {
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const daysInMonth = lastDay.getDate();

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

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayStr = today.toISOString().split('T')[0];
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

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
    let checkDate = new Date(dates.includes(todayStr) ? today : yesterday);
    while (true) {
      checkDate.setDate(checkDate.getDate() - 1);
      const checkStr = checkDate.toISOString().split('T')[0];
      if (dates.includes(checkStr)) {
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
exports.main = async (event, context) => {
  try {
    const openid = await verifyAuth(context);
    const { action } = event;

    let result;
    switch (action) {
      case 'overview':
        result = await getOverview(openid);
        break;
      case 'weekly':
        result = await getWeeklyStats(openid, event);
        break;
      case 'ranking':
        result = await getCourseRanking(openid);
        break;
      case 'monthly':
        result = await getMonthlyStats(openid, event);
        break;
      case 'heatmap':
        result = await getHeatmapData(openid, event);
        break;
      case 'trends':
        result = await getTrends(openid, event);
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

    const errorCode = error.message === 'Unauthorized' ? 401 : 500;

    return {
      success: false,
      code: errorCode,
      data: null,
      message: error.message
    };
  }
};
