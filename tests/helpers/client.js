const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Only the unavailable WeChat runtime boundary is replaced; application modules are real.
function client({ store = new Map(), cloud, network = 'none', app = {} } = {}) {
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const calls = [];
  const wx = {
    getStorageSync: key => clone(store.get(key)),
    setStorageSync: (key, data) => store.set(key, clone(data)),
    getStorageInfoSync: () => ({ keys: [...store.keys()] }),
    getStorage: async ({ key }) => {
      if (!store.has(key)) throw new Error('data not found');
      return { data: clone(store.get(key)) };
    },
    setStorage: async ({ key, data }) => store.set(key, clone(data)),
    getNetworkType: async () => ({ networkType: network }),
    cloud: { callFunction: async request => {
      calls.push(clone(request));
      if (cloud) return cloud(request);
      throw new Error('network offline');
    } },
    showToast: options => calls.push({ toast: options.title, icon: options.icon }),
    showModal: options => options.success({ confirm: true }),
    navigateTo: options => calls.push({ navigate: options.url }),
    navigateBack: () => calls.push({ back: true }),
    stopPullDownRefresh() {}, setNavigationBarTitle() {}
  };
  const cache = new Map();
  let definition;
  function load(relative) {
    const filename = path.resolve(__dirname, '../..', relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const context = {
      module, exports: module.exports, wx, console, Date,
      setTimeout, clearTimeout, setInterval, clearInterval,
      getApp: () => app,
      Page: value => { definition = value; },
      Component: value => { definition = value; },
      App: value => { definition = value; },
      require: name => name.startsWith('.')
        ? load(path.relative(path.resolve(__dirname, '../..'), path.resolve(path.dirname(filename), name + (path.extname(name) ? '' : '.js'))))
        : require(name)
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return module.exports;
  }
  return { wx, calls, store, load, definition: () => definition, clone };
}

module.exports = { client };
