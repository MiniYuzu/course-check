const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A database boundary fake: production entrypoints, validation and calculations
// stay real. Queries deliberately default to 20 rows and cap pages at 100.
function createCloud(seed = {}, options = {}) {
  let state = structuredClone({ users: [], courses: [], checkins: [], ...seed });
  let sequence = 0;
  let transactionTail = Promise.resolve();
  const logs = [];
  const predicate = test => ({ test, and: other => predicate(value => test(value) && other.test(value)) });
  const command = {
    neq: value => predicate(actual => actual !== value),
    gte: value => predicate(actual => actual >= value),
    lte: value => predicate(actual => actual <= value),
    in: values => predicate(actual => values.includes(actual)),
    inc: value => ({ increment: value })
  };
  const matches = (row, condition) => Object.entries(condition).every(([key, value]) =>
    value && typeof value.test === 'function' ? value.test(row[key]) : row[key] === value);
  const update = (row, data) => {
    for (const [key, value] of Object.entries(data)) {
      row[key] = value && value.increment !== undefined ? (row[key] || 0) + value.increment : structuredClone(value);
    }
  };
  function collection(name, getState = () => state) {
    function query(condition = {}, sorting = [], offset = 0, size = 20) {
      const rows = () => getState()[name].filter(row => matches(row, condition));
      return {
        where: value => query(value, sorting, offset, size),
        orderBy: (field, direction) => query(condition, [...sorting, [field, direction]], offset, size),
        skip: value => query(condition, sorting, value, size),
        limit: value => query(condition, sorting, offset, Math.min(value, 100)),
        async get() {
          const result = rows().slice().sort((a, b) => {
            for (const [field, direction] of sorting) {
              const order = a[field] === b[field] ? 0 : a[field] < b[field] ? -1 : 1;
              if (order) return direction === 'desc' ? -order : order;
            }
            return 0;
          }).slice(offset, offset + size);
          const snapshot = structuredClone(result);
          if (options.afterQuery) await options.afterQuery({ collection: name, condition, offset, limit: size, rows: snapshot });
          return { data: snapshot };
        },
        async count() { return { total: rows().length }; },
        async update({ data }) { const found = rows(); found.forEach(row => update(row, data)); return { stats: { updated: found.length } }; },
        async remove() { const found = rows(); getState()[name] = getState()[name].filter(row => !found.includes(row)); return { stats: { removed: found.length } }; }
      };
    }
    return {
      ...query(),
      async add({ data }) {
        const id = data._id || `random-${++sequence}`;
        if (getState()[name].some(row => row._id === id)) throw new Error('duplicate key');
        getState()[name].push(structuredClone({ ...data, _id: id }));
        return { _id: id };
      },
      doc(id) {
        return {
          async get() { return { data: structuredClone(getState()[name].find(row => row._id === id) || null) }; },
          async set({ data }) {
            const rows = getState()[name];
            const index = rows.findIndex(row => row._id === id);
            const value = structuredClone({ ...data, _id: id });
            if (index < 0) rows.push(value); else rows[index] = value;
            return { _id: id, stats: { created: index < 0 ? 1 : 0, updated: index < 0 ? 0 : 1 } };
          },
          async update({ data }) {
            const row = getState()[name].find(row => row._id === id);
            if (row) update(row, data);
            return { stats: { updated: row ? 1 : 0 } };
          },
          async remove() { return query({ _id: id }).remove(); }
        };
      }
    };
  }
  const db = {
    command,
    collection,
    async runTransaction(callback, retryTimes = 3) {
      if (options.beforeTransaction) await options.beforeTransaction();
      const transaction = transactionTail.then(async () => {
        const draft = structuredClone(state);
        // CloudBase transactions support document operations, not where queries.
        let operations = 0;
        const result = await callback({ collection: name => ({ doc: id => {
          const ref = collection(name, () => draft).doc(id);
          return Object.fromEntries(Object.entries(ref).map(([method, invoke]) => [method, async (...args) => {
            if (++operations > 100) throw new Error('Transaction exceeds 100 operations');
            return invoke(...args);
          }]));
        } }) });
        if (options.beforeTransactionCommit) await options.beforeTransactionCommit({ retryTimes });
        state = draft;
        return result;
      });
      transactionTail = transaction.catch(() => {});
      return transaction;
    }
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [options.now || '2026-10-01T16:30:00.000Z'])); }
    static now() { return new Clock().getTime(); }
  }
  const cloud = {
    init() {},
    DYNAMIC_CURRENT_ENV: 'test',
    database: () => db,
    getWXContext: () => ({ OPENID: options.openid === undefined ? 'owner' : options.openid, APPID: 'app' })
  };
  const functions = {};
  const modules = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const sandbox = { module, exports: module.exports, Date: Clock, console: { error: (...args) => logs.push(args) }, require: id => id === 'wx-server-sdk' ? cloud : id.startsWith('.') ? load(require.resolve(path.resolve(path.dirname(filename), id))) : require(id) };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return module.exports;
  }
  for (const name of ['login', 'course', 'checkin', 'stats']) {
    const filename = path.resolve(__dirname, '../../cloudfunctions', name, 'index.js');
    functions[name] = load(filename).main;
  }
  return {
    call: async (name, event = {}) => structuredClone(await functions[name](event, {})),
    rows: name => structuredClone(state[name]),
    logs
  };
}

function pauseOnce() {
  let arrive;
  let resume;
  let paused = false;
  const reached = new Promise(resolve => { arrive = resolve; });
  const released = new Promise(resolve => { resume = resolve; });
  return {
    reached,
    resume,
    async hold() {
      if (paused) return;
      paused = true;
      arrive();
      await released;
    }
  };
}

module.exports = { createCloud, pauseOnce };
