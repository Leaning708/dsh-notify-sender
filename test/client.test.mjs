import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSettings } from '../lib/notify.js';

/** 浏览器模块加载器的假实现：捕获 load() 的定义，供下面直接调用。 */
let definition;
globalThis.window = { __ModuleLoader__: { load(value) { definition = value; } } };
await import('../lib/client.js');

/**
 * 极简 hooks 实现：useState 按调用顺序存值，setter 同步改值；
 * 测试里改完 state 后重新调用一次表单函数即可拿到新输出（useEffect 不影响渲染）。
 */
function makeReactHarness() {
  const hooks = [];
  let cursor = 0;
  return {
    begin() { cursor = 0; },
    reset() { hooks.length = 0; cursor = 0; },
    react: {
      createElement(type, props, ...children) {
        return { type, props, children };
      },
      useState(initial) {
        const index = cursor;
        cursor += 1;
        if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
        const set = (next) => {
          hooks[index] = typeof next === 'function' ? next(hooks[index]) : next;
        };
        return [hooks[index], set];
      },
      useEffect() {},
    },
  };
}

const harness = makeReactHarness();

function requireStub(name) {
  if (name === 'react') return harness.react;
  throw new Error(`unexpected module: ${name}`);
}

function baseValue(overrides = {}) {
  return {
    enabled: false,
    servers: [],
    wsUrl: '',
    token: '',
    device: '',
    deviceId: '',
    acceptReplies: true,
    notifyOnCompleted: true,
    notifyOnFailed: true,
    notifyMode: 'auto',
    minTurnMs: 0,
    maxSummaryChars: 600,
    connectTimeoutMs: 8000,
    reconnectMinMs: 1000,
    reconnectMaxMs: 30_000,
    ...overrides,
  };
}

function readyForm(value = {}) {
  const writes = [];
  const snapshotValue = baseValue(value);
  return {
    writes,
    getSnapshot: () => ({
      status: 'ready',
      value: snapshotValue,
      base: {},
      user: {},
      revision: 0,
      writable: true,
    }),
    subscribe: () => () => {},
    mutate: async (ops) => { writes.push(ops); return true; },
    unset: async (field) => { writes.push([{ op: 'unset', path: [field] }]); return true; },
  };
}

function makeContext(form) {
  const registrations = [];
  const dictionaries = {};
  let dictionary = {};
  const t = (key) => (typeof dictionary[key] === 'string' ? dictionary[key] : `t:${key}`);
  const ctx = {
    effect: (callback) => callback(),
    locale: {
      register: (_ns, values) => {
        Object.assign(dictionaries, values);
        dictionary = values.zh;
        return () => {};
      },
      bind: () => t,
    },
    configForms: { get: (entryId) => { assert.equal(entryId, 'dsh-notify-sender'); return form; } },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, render) => { registrations.push({ options, render }); return () => {}; },
    },
  };
  return { ctx, registrations, t, dictionaries };
}

function setup(value = {}) {
  harness.reset();
  const form = readyForm(value);
  const { ctx, registrations, t, dictionaries } = makeContext(form);
  definition.factory(requireStub).apply(ctx);
  return { form, registrations, t, dictionaries };
}

/** 页面渲染统一从 Settings 左栏入口取卡片（0.3.3 起不再有 settings.plugins.tab）。 */
function pageRegistration(registrations) {
  const registration = registrations.find(({ options }) => options.name === 'settings.section');
  assert.ok(registration, '缺少 settings.section 注册');
  return registration;
}

/** 渲染当前页签内容（模拟一次 React 渲染）。 */
function renderPage(registrations) {
  const card = pageRegistration(registrations).render({ view: 'page' });
  const cardOutput = card.type(card.props);
  harness.begin();
  return cardOutput.type(cardOutput.props);
}

/** 递归展开函数组件（InfoDot），把返回的元素树摊平成可直接断言的 DOM 替身。 */
function expand(node) {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== 'object') return node;
  const children = expand(node.children ?? []);
  if (typeof node.type === 'function') {
    return expand(node.type({ ...(node.props ?? {}), children }));
  }
  return { ...node, children };
}

/**
 * 深度渲染：模拟 React 把 InfoDot 也渲染一遍。
 * 表单 hooks 顺序固定，InfoDot 按 DFS 顺序排在后面，所以悬停 state 能被下一次渲染读到。
 */
function renderPageDeep(registrations) {
  const card = pageRegistration(registrations).render({ view: 'page' });
  const cardOutput = card.type(card.props);
  harness.begin();
  return expand(cardOutput.type(cardOutput.props));
}

function collect(node, predicate, found = []) {
  if (node === null || node === undefined) return found;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, found);
    return found;
  }
  if (typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  collect(node.children, predicate, found);
  return found;
}

const elements = (root, type) => collect(root, (node) => node.type === type);
const byField = (root, field) => collect(root, (node) => node.props && node.props['data-field'] === field);
const byAction = (root, action) => collect(root, (node) => node.props && node.props['data-action'] === action);
const byTab = (root, tab) => collect(root, (node) => node.props && node.props['data-tab'] === tab);
const byRole = (root, role) => collect(root, (node) => node.props && node.props['data-role'] === role);
const byId = (root, id) => collect(root, (node) => node.props && node.props.id === id);
const infoDots = (root) => collect(root, (node) => node.props && node.props['data-role'] === 'info-dot');
const tooltips = (root) => collect(root, (node) => node.props && node.props['data-role'] === 'info-tooltip');
const tabLabels = (root) => byTab(root, 'connection').concat(byTab(root, 'notify'), byTab(root, 'advanced'))
  .map((node) => node.children[0]);
const messageText = (root) => collect(root, (node) => node.type === 'p' && typeof node.children?.[0] === 'string')
  .map((node) => node.children[0]);

/** 按渲染（DFS）顺序收集 data-field / data-role / id 标记，用于断言布局顺序。 */
function markOrder(root) {
  const marks = [];
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object') return;
    const props = node.props ?? {};
    if (typeof props['data-field'] === 'string') marks.push(props['data-field']);
    if (typeof props['data-role'] === 'string') marks.push(props['data-role']);
    if (typeof props.id === 'string') marks.push(`#${props.id}`);
    walk(node.children);
  };
  walk(root);
  return marks;
}

function clickTab(registrations, name) {
  const root = renderPage(registrations);
  const button = byTab(root, name)[0];
  assert.ok(button, `没有 ${name} 页签`);
  button.props.onClick();
  return renderPage(registrations);
}

function changeInput(root, field, value, index = 0) {
  const input = byField(root, field)[index];
  assert.ok(input, `没有 ${field} 输入框`);
  input.props.onChange({ target: { value } });
}

async function clickSave(root, registrations) {
  const button = byAction(root, 'save')[0];
  assert.ok(button, '没有保存按钮');
  await button.props.onClick();
  return renderPage(registrations);
}

test('模块声明与注册位', () => {
  assert.equal(definition.id, 'dsh-notify-sender');
  const plugin = definition.factory(requireStub);
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms']);

  const { registrations } = setup();
  // 0.3.3：只剩三处注册，不再注册「内置插件」页签。
  assert.equal(registrations.length, 3);
  assert.deepEqual(
    registrations.map(({ options }) => options.name).sort(),
    ['plugins.bundle.config', 'plugins.row.config', 'settings.section'],
  );
  assert.equal(registrations.some(({ options }) => options.name === 'settings.plugins.tab'), false, '不应再注册 settings.plugins.tab');
  const section = registrations.find(({ options }) => options.name === 'settings.section');
  const bundle = registrations.find(({ options }) => options.name === 'plugins.bundle.config');
  const row = registrations.find(({ options }) => options.name === 'plugins.row.config');
  assert.ok(section, '缺少 Settings 左栏入口注册');
  assert.ok(bundle, '缺少 bundle 配置区注册');
  assert.ok(row, '缺少行配置页注册');
  assert.equal(section.options.id, 'dsh-notify-sender');
  assert.equal(section.options.label, 'Coopanion Bridge');
  assert.equal(section.options.order, 70);
  assert.equal(bundle.options.key, 'dsh-notify-sender');
  assert.equal(row.options.key, 'dsh-notify-sender#dsh-notify-sender');
  for (const registration of registrations) assert.equal(typeof registration.render, 'function');
});

test('summary 视图只回一句话', () => {
  const { registrations, t } = setup();
  const card = pageRegistration(registrations).render({ view: 'summary' });
  const output = card.type(card.props);
  assert.equal(output.type, 'span');
  assert.equal(output.children[0], t('summary'));
});

test('0.3.3：简介收敛成一两句，statusHint 这类长说明已删除', () => {
  const { registrations, t } = setup();
  const root = renderPageDeep(registrations);

  // 卡片顶部只有一句 intro，没有 statusHint 段落
  const introParagraphs = elements(root, 'p').filter((node) => node.children?.[0] === t('intro'));
  assert.equal(introParagraphs.length, 1);
  assert.ok(t('intro').length <= 120, `intro 太长（${t('intro').length} 字）：${t('intro')}`);
  assert.ok(!t('intro').includes('把设备、会话、耗时和最后回复摘要'), '旧的 intro 长段落还在');
  // statusHint 已从文案表里删除：查不到键，也不会渲染那段说明
  assert.equal(t('statusHint'), 't:statusHint');
  const allText = collect(root, (node) => typeof node.children?.[0] === 'string')
    .map((node) => node.children[0])
    .join('\n');
  assert.ok(!allText.includes('连接状态、最近 ack'), '旧的 statusHint 仍在渲染');
  assert.ok(!allText.includes('Coopanion 的设备页也能看到在线状态'), '旧的 statusHint 仍在渲染');
});

test('中英文案同步：key 集合一致、都没有 statusHint、intro 都不再是大段落', () => {
  const { dictionaries } = setup();
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort());
  for (const lang of ['zh', 'en']) {
    assert.equal('statusHint' in dictionaries[lang], false, `${lang} 仍有 statusHint`);
    assert.equal('advancedHint' in dictionaries[lang], false, `${lang} 仍有 advancedHint`);
    assert.ok(dictionaries[lang].intro.length <= 260, `${lang} intro 太长`);
    assert.ok(!dictionaries[lang].intro.includes('final-reply summary'), `${lang} intro 仍是旧长段落`);
  }
});

test('字段解释收成 InfoDot：可聚焦、带 aria-label，悬停/聚焦才出现 tooltip', () => {
  const { registrations, t } = setup();
  let root = renderPageDeep(registrations);

  // 连接页签：总开关 / 设备名 / 设备 ID / 接受回传，四个解释图标
  const dots = infoDots(root);
  assert.equal(dots.length, 4);
  assert.equal(tooltips(root).length, 0, '默认不显示 tooltip');
  const deviceDot = dots.find((node) => node.props['aria-label'] === t('deviceHint'));
  assert.ok(deviceDot, '没有设备名的说明图标');
  assert.equal(typeof deviceDot.type, 'string');
  assert.equal(deviceDot.props.tabIndex, 0);
  assert.equal(deviceDot.props.role, 'button');
  // 圆形小图标画的是「!」
  const glyph = deviceDot.children.find((child) => child && child.props && child.props['aria-hidden'] === 'true');
  assert.equal(glyph.children[0], '!');
  // 解释文字不再常驻：未悬停时页面里没有设备名 hint
  const visibleText = collect(root, (node) => typeof node.children?.[0] === 'string')
    .map((node) => node.children[0])
    .join('\n');
  assert.ok(!visibleText.includes(t('deviceHint')), '字段 hint 不应该常驻在表单里');

  // 悬停：本地 state 打开 tooltip，文字与 aria-label 一致
  deviceDot.props.onMouseEnter({ currentTarget: null });
  root = renderPageDeep(registrations);
  let shown = tooltips(root);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].children[0], t('deviceHint'));
  // 样式参数：绝对定位、主题 token、最大宽度 260、zIndex 够高、默认左对齐
  const style = shown[0].props.style;
  assert.equal(style.position, 'absolute');
  assert.equal(style.maxWidth, '260px');
  assert.ok(style.zIndex >= 1000, 'tooltip 的 zIndex 应该足够高');
  assert.equal(style.left, 0);
  assert.match(String(style.background), /var\(--dsw-alias-/);
  assert.match(String(style.color), /var\(--dsw-alias-/);
  assert.match(String(style.borderColor ?? style.border), /var\(--dsw-alias-|dsw-alias/);

  // 移出后 tooltip 消失
  infoDots(root).find((node) => node.props['aria-label'] === t('deviceHint')).props.onMouseLeave();
  root = renderPageDeep(registrations);
  assert.equal(tooltips(root).length, 0);

  // 键盘聚焦也能显示，失焦消失
  infoDots(root).find((node) => node.props['aria-label'] === t('deviceHint')).props.onFocus({ currentTarget: null });
  root = renderPageDeep(registrations);
  assert.equal(tooltips(root).length, 1);
  infoDots(root).find((node) => node.props['aria-label'] === t('deviceHint')).props.onBlur();
  root = renderPageDeep(registrations);
  assert.equal(tooltips(root).length, 0);
});

test('InfoDot 靠近视口右侧时 tooltip 改成右对齐，不被裁掉', () => {
  const previousWidth = globalThis.window.innerWidth;
  globalThis.window.innerWidth = 1200;
  try {
    const { registrations, t } = setup();
    clickTab(registrations, 'advanced');
    let root = renderPageDeep(registrations);
    const dot = infoDots(root).find((node) => node.props['aria-label'] === t('reconnectMaxMsHint'));
    assert.ok(dot, '没有重连上限的说明图标');

    // 图标在视口右侧（left=1150）：tooltip 右对齐
    dot.props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => ({ left: 1150 }) } });
    root = renderPageDeep(registrations);
    let shown = tooltips(root);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].props.style.right, 0);
    assert.equal(shown[0].props.style.left, 'auto');

    // 图标在左侧（left=100）：保持左对齐
    infoDots(root).find((node) => node.props['aria-label'] === t('reconnectMaxMsHint'))
      .props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => ({ left: 100 }) } });
    root = renderPageDeep(registrations);
    shown = tooltips(root);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].props.style.left, 0);
    assert.equal(shown[0].props.style.right, undefined);
  } finally {
    globalThis.window.innerWidth = previousWidth;
  }
});

test('page 视图：三个页签、连接页签与新增服务按钮', () => {
  const { registrations, t } = setup();
  const root = renderPage(registrations);

  assert.deepEqual(tabLabels(root), ['连接', '通知', '高级']);
  assert.equal(byTab(root, 'connection')[0].props['aria-selected'], true);
  assert.equal(byAction(root, 'add-server').length, 1);
  assert.equal(byAction(root, 'save').length, 1);

  // 总开关常驻在页签条上方（不属于某一个页签）
  const marks = markOrder(root);
  assert.equal(byId(root, 'dsh-notify-sender-enabled').length, 1);
  assert.ok(marks.indexOf('#dsh-notify-sender-enabled') < marks.indexOf('config-tabs'));

  // 默认连接页签：没有服务、有设备字段、通知/高级字段还没渲染
  assert.equal(byField(root, 'server-row').length, 0);
  assert.equal(elements(root, 'select').length, 0);
  assert.equal(byField(root, 'minTurnMs').length, 0);
  assert.ok(elements(root, 'input').some((node) => node.props.placeholder === 'dev-box'));
  assert.equal(byId(root, 'dsh-notify-sender-accept-replies').length, 1);
  // 空列表：一句说明 + 新增按钮，不渲染表头
  assert.equal(byRole(root, 'servers-hint').length, 1);
  assert.equal(byRole(root, 'server-head').length, 0);
  // 字段解释不再常驻：连接页签里唯一的说明段落是服务列表顶部那一句
  const paragraphs = elements(root, 'p').map((node) => node.children?.[0]).filter((text) => typeof text === 'string');
  assert.ok(!paragraphs.includes(t('deviceHint')), '设备名 hint 不应该以段落形式常驻');
  assert.ok(!paragraphs.includes(t('acceptRepliesHint')), '接受回传 hint 不应该以段落形式常驻');
});

test('页签选中态：当前页签高亮、非选中无边框，aria-selected 只落在当前页签', () => {
  const { registrations } = setup();
  const root = renderPage(registrations);
  const tabs = ['connection', 'notify', 'advanced'].map((id) => byTab(root, id)[0]);

  assert.deepEqual(tabs.map((node) => node.props['aria-selected']), [true, false, false]);
  assert.deepEqual(tabs.map((node) => node.props['data-active']), ['true', 'false', 'false']);
  assert.equal(tabs[0].props.style.boxShadow, 'inset 0 -2px 0 0 var(--dsw-alias-brand-primary)');
  assert.equal(tabs[0].props.style.fontWeight, 700);
  for (const inactive of tabs.slice(1)) {
    assert.equal(inactive.props.style.border, 'none', '非选中页签不应有边框');
    assert.equal(inactive.props.style.outline, 'none');
    assert.equal(inactive.props.style.boxShadow, 'none');
    assert.equal(inactive.props.style.fontWeight, 400);
  }
  assert.equal(byRole(root, 'config-tabs').length, 1);
  assert.equal(byRole(root, 'tab-panel').length, 1);

  // 切到通知页签：选中态跟着走，仍只有一个 aria-selected=true
  tabs[1].props.onClick();
  const next = renderPage(registrations);
  assert.deepEqual(
    ['connection', 'notify', 'advanced'].map((id) => byTab(next, id)[0].props['aria-selected']),
    [false, true, false],
  );
  assert.equal(byTab(next, 'notify')[0].props.style.boxShadow.includes('inset 0 -2px 0 0'), true);
});

test('页签焦点环只在键盘（:focus-visible）时出现，鼠标点击不留黑框', () => {
  const { registrations } = setup();
  let root = renderPage(registrations);
  const button = byTab(root, 'notify')[0];

  // 键盘聚焦：浏览器把 target 匹配 :focus-visible
  button.props.onFocus({ target: { matches: (selector) => selector === ':focus-visible' } });
  root = renderPage(registrations);
  const focused = byTab(root, 'notify')[0];
  assert.equal(focused.props.style.outline, '2px solid var(--dsw-alias-brand-primary)');
  assert.equal(focused.props.style.outlineOffset, '2px');

  // 失焦后焦点环消失
  focused.props.onBlur();
  root = renderPage(registrations);
  assert.equal(byTab(root, 'notify')[0].props.style.outline, 'none');

  // 鼠标聚焦：不匹配 :focus-visible → 没有 outline
  byTab(root, 'advanced')[0].props.onFocus({ target: { matches: () => false } });
  root = renderPage(registrations);
  assert.equal(byTab(root, 'advanced')[0].props.style.outline, 'none');
});

test('连接页签：紧凑服务列表（表头 + 每行一行控件 + 删除）', () => {
  const { registrations } = setup({
    servers: [
      { id: 'home', label: '家里', wsUrl: 'ws://192.168.1.20:3210/ws', token: 'stored-secret', enabled: true },
      { id: 'office', label: '公司', wsUrl: 'wss://coop.example.com/ws', token: '', enabled: false },
    ],
  });
  const root = renderPageDeep(registrations);

  // 表头只在顶部出现一次，五列
  const heads = byRole(root, 'server-head');
  assert.equal(heads.length, 1);
  assert.deepEqual(
    heads[0].children.map((cell) => cell.children[0]),
    ['启用', '名称', 'WebSocket 地址', '令牌', '操作'],
  );

  const rows = byField(root, 'server-row');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.children.length, 5, '每行只有 5 个格子，没有重复的 hint');
    assert.ok(row.children.every((cell) => cell.type === 'div'));
  }
  // 列表只保留顶部一句说明，不再每行重复
  assert.equal(byRole(root, 'servers-hint').length, 1);
  assert.ok(byRole(root, 'server-table').length === 1);
  // 表格不逐行放解释图标（顶部一句说明就够）
  const table = byRole(root, 'server-table')[0];
  assert.equal(collect(table, (node) => node.props && node.props['data-role'] === 'info-dot').length, 0, '服务行不应该有 InfoDot');

  const radios = byField(root, 'server-enabled');
  assert.equal(radios.length, 2);
  assert.deepEqual(radios.map((node) => node.props.checked), [true, false]);
  assert.equal(new Set(radios.map((node) => node.props.name)).size, 1, '单选应用同一个 name');
  assert.ok(radios[0].props.name);

  const labels = byField(root, 'server-label');
  assert.deepEqual(labels.map((node) => node.props.value), ['家里', '公司']);
  const urls = byField(root, 'server-wsUrl');
  assert.deepEqual(urls.map((node) => node.props.value), ['ws://192.168.1.20:3210/ws', 'wss://coop.example.com/ws']);
  assert.ok(urls.every((node) => node.props.type === 'url'));
  assert.ok(urls.every((node) => node.props.style.minWidth === 0), '地址输入允许压缩，窄宽度不溢出');

  const tokens = byField(root, 'server-token');
  assert.equal(tokens.length, 2);
  assert.ok(tokens.every((node) => node.props.type === 'password'));
  // 已保存的令牌不回显；输入框提示「已设置，留空不修改」/「未设置」
  assert.deepEqual(tokens.map((node) => node.props.value), ['', '']);
  assert.equal(tokens[0].props.placeholder, '已设置，留空不修改');
  assert.equal(tokens[1].props.placeholder, '未设置');

  const deletes = byAction(root, 'delete-server');
  assert.equal(deletes.length, 2);
  assert.ok(deletes.every((node) => node.props.style.fontSize === '12px'));
  assert.equal(byAction(root, 'add-server').length, 1);
  assert.equal(byAction(root, 'import-legacy').length, 0);

  // 布局顺序：本机 → 接受回传 → 服务列表（表头、行）→ 新增/导入按钮
  const marks = markOrder(root);
  const at = (needle) => marks.indexOf(needle);
  assert.ok(at('device') < at('deviceId'));
  assert.ok(at('deviceId') < at('#dsh-notify-sender-accept-replies'));
  assert.ok(at('#dsh-notify-sender-accept-replies') < at('server-head'));
  assert.ok(at('server-head') < at('server-row'));
  assert.ok(at('server-row') < at('server-actions'));
});

test('服务启用是单选：切换后只保留一个 enabled', () => {
  const { registrations } = setup({
    servers: [
      { id: 'home', label: '家里', wsUrl: 'ws://127.0.0.1:1/ws', token: '', enabled: true },
      { id: 'office', label: '公司', wsUrl: 'ws://127.0.0.1:2/ws', token: '', enabled: false },
      { id: 'lab', label: '实验室', wsUrl: 'http://127.0.0.1:3/notify', token: '', enabled: false },
    ],
  });
  let root = renderPage(registrations);
  byField(root, 'server-enabled')[1].props.onChange();
  root = renderPage(registrations);
  assert.deepEqual(
    byField(root, 'server-enabled').map((node) => node.props.checked),
    [false, true, false],
  );
});

test('多条 enabled 时按 Host 规则只显示第一个可用地址为启用', () => {
  const { registrations } = setup({
    servers: [
      { id: 'bad', label: '坏地址', wsUrl: 'http://127.0.0.1:1/notify', token: '', enabled: true },
      { id: 'ok', label: '好地址', wsUrl: 'ws://127.0.0.1:2/ws', token: '', enabled: true },
    ],
  });
  const root = renderPage(registrations);
  assert.deepEqual(
    byField(root, 'server-enabled').map((node) => node.props.checked),
    [false, true],
  );
});

test('页签切换：通知/高级字段只在对应页签渲染', () => {
  const { registrations } = setup({ enabled: true, device: 'dev-box', connectTimeoutMs: 9000 });
  let root = clickTab(registrations, 'notify');
  assert.equal(byTab(root, 'notify')[0].props['aria-selected'], true);
  assert.equal(elements(root, 'select').length, 1);
  assert.equal(byField(root, 'minTurnMs').length, 1);
  assert.equal(byField(root, 'maxSummaryChars').length, 1);
  // 0.3.2：includeSubagents 已删除，通知页签不再有子代理开关
  assert.equal(byId(root, 'dsh-notify-sender-subagents').length, 0);
  assert.equal(byField(root, 'subagents').length, 0);
  // 总开关在页签条上方，切页签不消失
  assert.equal(byId(root, 'dsh-notify-sender-enabled').length, 1);

  root = clickTab(registrations, 'advanced');
  assert.equal(byField(root, 'connectTimeoutMs')[0].props.value, '9000');
  assert.equal(byField(root, 'reconnectMinMs').length, 1);
  assert.equal(byField(root, 'reconnectMaxMs').length, 1);
  assert.equal(elements(root, 'select').length, 0);

  root = clickTab(registrations, 'connection');
  assert.equal(byAction(root, 'add-server').length, 1);
});

test('notifyMode=goal 时隐藏 minTurnMs 并显示说明', () => {
  const { registrations } = setup({ notifyMode: 'auto', minTurnMs: 5000 });
  let root = clickTab(registrations, 'notify');
  assert.equal(byField(root, 'minTurnMs').length, 1);

  const select = elements(root, 'select')[0];
  select.props.onChange({ target: { value: 'goal' } });
  root = renderPage(registrations);

  assert.equal(byField(root, 'minTurnMs').length, 0, 'goal 模式不应渲染 minTurnMs');
  const note = collect(root, (node) => node.props && node.props['data-role'] === 'minTurn-note');
  assert.equal(note.length, 1);
  assert.equal(note[0].children[0], '最短耗时只作用于每轮通知，目标模式不使用。');
  // 其它通知字段还在
  assert.equal(byField(root, 'maxSummaryChars').length, 1);

  // 切回 auto 又出现
  elements(root, 'select')[0].props.onChange({ target: { value: 'auto' } });
  root = renderPage(registrations);
  assert.equal(byField(root, 'minTurnMs').length, 1);
});

test('旧配置提示与「从旧配置导入」：导入后令牌沿用旧值且不回显', async () => {
  const { form, registrations } = setup({ wsUrl: 'ws://192.168.1.20:3210/ws', token: 'old-token' });
  let root = renderPage(registrations);
  assert.equal(byAction(root, 'import-legacy').length, 1);

  byAction(root, 'import-legacy')[0].props.onClick();
  root = renderPage(registrations);

  assert.equal(byField(root, 'server-row').length, 1);
  assert.equal(byField(root, 'server-wsUrl')[0].props.value, 'ws://192.168.1.20:3210/ws');
  assert.equal(byField(root, 'server-token')[0].props.value, '');
  assert.equal(byField(root, 'server-token')[0].props.placeholder, '已设置，留空不修改');

  await clickSave(root, registrations);
  assert.equal(form.writes.length, 1);
  const serversOp = form.writes[0].find((op) => op.op === 'set' && op.path[0] === 'servers');
  assert.ok(serversOp, '没有写 servers');
  assert.equal(serversOp.value.length, 1);
  assert.equal(serversOp.value[0].wsUrl, 'ws://192.168.1.20:3210/ws');
  assert.equal(serversOp.value[0].token, 'old-token');
  assert.equal(serversOp.value[0].enabled, false);
  assert.ok(serversOp.value[0].id);
});

test('新增服务：填写名称/地址/令牌并启用后保存整个 servers 数组', async () => {
  const { form, registrations } = setup({ device: 'old-dev' });
  let root = renderPage(registrations);

  byAction(root, 'add-server')[0].props.onClick();
  root = renderPage(registrations);
  assert.equal(byField(root, 'server-row').length, 1);

  changeInput(root, 'server-label', '家里');
  changeInput(root, 'server-wsUrl', 'ws://127.0.0.1:3210/ws');
  changeInput(root, 'server-token', 'new-token');
  root = renderPage(registrations);
  byField(root, 'server-enabled')[0].props.onChange();
  changeInput(root, 'device', 'dev-box');
  root = renderPage(registrations);

  await clickSave(root, registrations);
  assert.equal(form.writes.length, 1);
  const ops = form.writes[0];
  const serversOp = ops.find((op) => op.op === 'set' && op.path[0] === 'servers');
  assert.ok(serversOp);
  assert.equal(serversOp.value.length, 1);
  assert.match(serversOp.value[0].id, /\S+/);
  assert.deepEqual(
    { label: serversOp.value[0].label, wsUrl: serversOp.value[0].wsUrl, token: serversOp.value[0].token, enabled: serversOp.value[0].enabled },
    { label: '家里', wsUrl: 'ws://127.0.0.1:3210/ws', token: 'new-token', enabled: true },
  );
  assert.ok(ops.some((op) => op.op === 'set' && op.path[0] === 'device' && op.value === 'dev-box'));
});

test('未改动的行沿用 snapshot 里的令牌，改动的字段按草稿写回', async () => {
  const { form, registrations } = setup({
    servers: [
      { id: 'home', label: '家里', wsUrl: 'ws://127.0.0.1:3210/ws', token: 'stored-secret', enabled: true },
    ],
  });
  let root = renderPage(registrations);
  changeInput(root, 'server-label', '家里-改');
  root = renderPage(registrations);

  await clickSave(root, registrations);
  assert.equal(form.writes.length, 1);
  const serversOp = form.writes[0].find((op) => op.op === 'set' && op.path[0] === 'servers');
  assert.ok(serversOp);
  assert.equal(serversOp.value[0].label, '家里-改');
  assert.equal(serversOp.value[0].token, 'stored-secret');
  assert.equal(serversOp.value[0].wsUrl, 'ws://127.0.0.1:3210/ws');

  // 保存出来的数组能被 Host 侧直接消费（页签 → servers → resolveSettings 往返）
  const resolved = resolveSettings({ enabled: true, servers: serversOp.value });
  assert.equal(resolved.activeServerId, 'home');
  assert.equal(resolved.activeServerLabel, '家里-改');
  assert.equal(resolved.wsUrl, 'ws://127.0.0.1:3210/ws');
  assert.equal(resolved.token, 'stored-secret');
});

test('保存校验：启用的服务必须是 ws(s)，新增服务必须填令牌', async () => {
  const { form, registrations } = setup();
  let root = renderPage(registrations);

  byAction(root, 'add-server')[0].props.onClick();
  root = renderPage(registrations);
  changeInput(root, 'server-label', '坏服务');
  changeInput(root, 'server-wsUrl', 'http://127.0.0.1:3210/notify');
  changeInput(root, 'server-token', 'tok');
  root = renderPage(registrations);
  byField(root, 'server-enabled')[0].props.onChange();
  root = renderPage(registrations);
  root = await clickSave(root, registrations);
  assert.equal(form.writes.length, 0, '非法地址不应该保存');
  assert.ok(messageText(root).includes('启用的服务必须填 ws(s):// 地址。'));

  changeInput(root, 'server-wsUrl', 'ws://127.0.0.1:3210/ws');
  changeInput(root, 'server-token', '');
  root = renderPage(registrations);
  root = await clickSave(root, registrations);
  assert.equal(form.writes.length, 0, '新服务缺令牌不应该保存');
  assert.ok(messageText(root).includes('新增的服务必须填令牌。'));

  changeInput(root, 'server-token', 'good-token');
  root = renderPage(registrations);
  root = await clickSave(root, registrations);
  assert.equal(form.writes.length, 1);
  assert.ok(messageText(root).includes('已保存，下一轮任务完成时生效。'));
});

test('保存仍写全部页签的字段', async () => {
  const { form, registrations } = setup({ enabled: true });
  let root = renderPage(registrations);
  changeInput(root, 'device', 'dev-box');
  root = clickTab(registrations, 'notify');
  elements(root, 'select')[0].props.onChange({ target: { value: 'turn' } });
  root = clickTab(registrations, 'advanced');
  changeInput(root, 'connectTimeoutMs', '9000');
  root = renderPage(registrations);

  await clickSave(root, registrations);
  const ops = form.writes[0];
  const setOf = (key) => ops.find((op) => op.op === 'set' && op.path[0] === key);
  assert.equal(setOf('device').value, 'dev-box');
  assert.equal(setOf('notifyMode').value, 'turn');
  assert.equal(setOf('connectTimeoutMs').value, 9000);
  // includeSubagents 已删除，保存不再写这个键
  assert.equal(ops.some((op) => op.path[0] === 'includeSubagents'), false);
  // servers 没改动就不写
  assert.equal(ops.some((op) => op.path[0] === 'servers'), false);
});
