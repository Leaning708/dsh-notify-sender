/**
 * dsh-notify-sender 的浏览器端：在 Settings 左栏和侧栏 Plugins
 * （bundle 配置区、行配置页）里渲染配置卡片。
 *
 * 配置的读写走宿主提供的 ctx.configForms（按 profile entry id 取表单），
 * 不直接请求 /api；样式只用 --dsw-alias-* 主题 token，控件自己实现。
 *
 * 0.3.1：
 * - 卡片分成「连接 / 通知 / 高级」三个页签（纯本地 state，不影响保存路径）；
 * - 连接页签维护 servers 列表（单选启用、名称、ws(s) 地址、令牌、删除、新增）；
 * - 底层仍只有一份配置：保存时写全部字段（servers 整体写回，令牌未改动的行沿用原值）。
 * 旧配置的 wsUrl/token 不再单独显示，只提供「从旧配置导入」。
 *
 * 0.3.2：
 * - 页签改成「底部 2px 主色高亮 + 加粗」的选中态；页签本身没有边框，
 *   鼠标点击不出现焦点框，键盘聚焦只用 :focus-visible 时的一个柔和焦点环；
 * - 服务列表压成「表头 + 每行一条」的紧凑网格，去掉每行重复的说明文字；
 * - 本机（设备名 / 设备 ID）移到连接页签最上面，总开关放在页签条上方常驻；
 * - 删除 includeSubagents：子代理会话固定不通知。
 *
 * 0.3.3：
 * - 简介收敛成一两句，删除 statusHint 这类常驻说明；
 * - 字段解释改成标题后的一个小「!」图标（InfoDot），悬停或键盘聚焦才显示悬浮提示；
 * - 不再注册 settings.plugins.tab（配置只保留 Settings 左栏与侧栏 Plugins 的两个入口）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-notify-sender',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ENTRY_ID = 'dsh-notify-sender';
    const NS = 'dsh-notify-sender';
    const DEFAULT_WS_URL = 'ws://127.0.0.1:3210/ws';
    /** 服务列表的列宽：启用、名称、地址、令牌、操作。全部 minmax(0, …)，窄宽度下不溢出。 */
    const SERVER_COLUMNS = '58px minmax(0, 1fr) minmax(0, 1.8fr) minmax(0, 1.1fr) auto';

    const zh = {
      title: 'Coopanion Bridge',
      summary: '任务结束时通过 WebSocket 通知 Coopanion，并把回复转回 DSH。',
      intro: '每轮结束（完成或失败）时通知 Coopanion；回复窗口里的消息会转回原会话。先装好并启用「Notify Receiver」World，再填服务地址和令牌。',
      tabConnection: '连接',
      tabNotify: '通知',
      tabAdvanced: '高级',
      enabled: '启用通知',
      enabledHint: '关闭时插件只注册监听，不连接任何服务。连接状态、最近 ack 与待发条数写在 DSH 日志里（搜索 dsh-notify-sender）。',
      serversSection: 'Coopanion 服务',
      serversHint: '可以保存多条服务，只连接启用中的一条；令牌不写日志、不回显。',
      serversEmpty: '还没有服务，点下面的「新增服务」添加一条。',
      serverActive: '启用',
      serverLabel: '名称',
      serverLabelPlaceholder: '例如：家里台式机',
      serverWsUrl: 'WebSocket 地址',
      serverToken: '令牌',
      serverActions: '操作',
      tokenSetPlaceholder: '已设置，留空不修改',
      tokenPlaceholder: '未设置',
      addServer: '新增服务',
      deleteServer: '删除',
      legacyHint: '检测到旧配置（wsUrl / token），可以一键导入成一条服务。',
      importLegacy: '从旧配置导入',
      legacyServerLabel: '默认',
      deviceSection: '本机',
      device: '设备名',
      deviceHint: '显示给桌宠的设备名；留空使用系统主机名。所有服务共用。',
      deviceId: '设备 ID',
      deviceIdHint: '稳定标识一台机器；留空自动用主机名的 12 位哈希，同机重装不变。所有服务共用。',
      deviceIdPlaceholder: '留空自动生成',
      acceptReplies: '接受 Coopanion 转回的回复',
      acceptRepliesHint: '打开后，Coopanion 回复窗口里的消息会作为一条用户消息注入原会话；关闭时直接回 reply-result 失败。',
      notifySection: '通知时机',
      notifyOnCompleted: '完成时通知',
      notifyOnFailed: '失败时通知',
      notifyMode: '通知时机',
      notifyModeHint: '自动：有活跃目标时等目标结束，没有目标时按轮通知；每轮：每次都通知；目标：只在目标完成/blocked 时通知。',
      notifyModeAuto: '自动（推荐）',
      notifyModeTurn: '每轮完成',
      notifyModeGoal: '目标完成（含 blocked）',
      advancedSection: '高级',
      minTurnMs: '最短耗时（毫秒）',
      minTurnMsHint: '短于这个耗时的回合不通知；0 表示不限制。',
      minTurnMsGoalHidden: '最短耗时只作用于每轮通知，目标模式不使用。',
      maxSummaryChars: '摘要字数上限',
      maxSummaryCharsHint: '发给 Coopanion 的最后回复最多保留多少字。',
      connectTimeoutMs: '握手超时（毫秒）',
      connectTimeoutMsHint: '连上后多久没收到 hello-ok 就断开重连，默认 8000。',
      reconnectMinMs: '最短重连间隔（毫秒）',
      reconnectMinMsHint: '断线后第一次重连的等待时间，默认 1000；之后按 2 倍递增。',
      reconnectMaxMs: '最长重连间隔（毫秒）',
      reconnectMaxMsHint: '退避上限，默认 30000。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，下一轮任务完成时生效。',
      saveAllTabsHint: '保存会写入三个页签的全部字段。',
      noChanges: '没有需要保存的改动。',
      saveFailed: '没有保存成功，请检查数值后重试。',
      serverUrlInvalid: '启用的服务必须填 ws(s):// 地址。',
      serverTokenRequired: '新增的服务必须填令牌。',
      invalidNumber: '请填一个非负数字，或留空使用默认值。',
      readOnly: '本部署的设置为只读。',
      loading: '正在读取配置…',
      unavailable: '该插件当前没有可编辑的配置（可能未加载或配置不可写）。',
    };

    const en = {
      title: 'Coopanion Bridge',
      summary: 'Notifies Coopanion over WebSocket when a DSH turn ends, and relays replies back to DSH.',
      intro: 'Every finished turn (completed or failed) notifies Coopanion; messages from its reply window are injected back into the original session. Install and enable the “Notify Receiver” World first, then fill in the service URL and token.',
      tabConnection: 'Connection',
      tabNotify: 'Notifications',
      tabAdvanced: 'Advanced',
      enabled: 'Enable notifications',
      enabledHint: 'While off, the plugin only registers its listener and does not connect to any service. Connection state, the latest ack and the pending count are written to the DSH log (search for dsh-notify-sender).',
      serversSection: 'Coopanion services',
      serversHint: 'Keep multiple services if you like; only the enabled one is connected. The token is never logged or echoed.',
      serversEmpty: 'No service yet. Use “Add service” below.',
      serverActive: 'Enabled',
      serverLabel: 'Name',
      serverLabelPlaceholder: 'e.g. Home desktop',
      serverWsUrl: 'WebSocket URL',
      serverToken: 'Token',
      serverActions: 'Actions',
      tokenSetPlaceholder: 'Already set, leave blank to keep',
      tokenPlaceholder: 'Not set',
      addServer: 'Add service',
      deleteServer: 'Delete',
      legacyHint: 'A legacy configuration (wsUrl / token) was found; import it as one service.',
      importLegacy: 'Import legacy config',
      legacyServerLabel: 'Default',
      deviceSection: 'This device',
      device: 'Device name',
      deviceHint: 'Shown to the pet; leave blank to use the system hostname. Shared by all services.',
      deviceId: 'Device ID',
      deviceIdHint: 'Stable id for this machine; leave blank to use a 12-char hash of the hostname (stable across reinstalls). Shared by all services.',
      deviceIdPlaceholder: 'generated automatically',
      acceptReplies: 'Accept replies from Coopanion',
      acceptRepliesHint: 'When on, a message from Coopanion’s reply window is injected into the original session as a user message; when off, reply-result reports failure.',
      notifySection: 'When to notify',
      notifyOnCompleted: 'Notify on completed',
      notifyOnFailed: 'Notify on failure',
      notifyMode: 'When to notify',
      notifyModeHint: 'Auto: wait for an active goal, otherwise notify every turn. Every turn: always notify. Goal: only when the goal completes or blocks.',
      notifyModeAuto: 'Auto (recommended)',
      notifyModeTurn: 'Every turn',
      notifyModeGoal: 'Goal completion (incl. blocked)',
      advancedSection: 'Advanced',
      minTurnMs: 'Minimum duration (ms)',
      minTurnMsHint: 'Turns shorter than this are not reported; 0 means no limit.',
      minTurnMsGoalHidden: 'Minimum duration only applies to per-turn notifications; goal mode does not use it.',
      maxSummaryChars: 'Summary length limit',
      maxSummaryCharsHint: 'How many characters of the final reply are sent at most.',
      connectTimeoutMs: 'Handshake timeout (ms)',
      connectTimeoutMsHint: 'How long to wait for hello-ok after connecting; 8000 by default.',
      reconnectMinMs: 'Minimum reconnect delay (ms)',
      reconnectMinMsHint: 'First delay after a disconnect, 1000 by default; doubles on each retry.',
      reconnectMaxMs: 'Maximum reconnect delay (ms)',
      reconnectMaxMsHint: 'Backoff ceiling, 30000 by default.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved; it applies from the next completed turn.',
      saveAllTabsHint: 'Save writes every field on all three tabs.',
      noChanges: 'No changes to save.',
      saveFailed: 'The save was not accepted; check the values and retry.',
      serverUrlInvalid: 'An enabled service needs a ws(s):// URL.',
      serverTokenRequired: 'A newly added service needs a token.',
      invalidNumber: 'Enter a non-negative number, or leave blank to use the default.',
      readOnly: 'This deployment stores settings read-only.',
      loading: 'Reading configuration…',
      unavailable: 'This plugin has no editable configuration right now (it may be unloaded or not writable).',
    };

    const styles = {
      root: {
        display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '680px',
        color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: 1.5,
        padding: '16px 18px', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '12px', background: 'var(--dsw-alias-bg-layer-1)',
      },
      heading: { margin: 0, fontSize: '15px', fontWeight: 700, color: 'var(--dsw-alias-label-primary)' },
      subheading: {
        margin: '10px 0 0', paddingTop: '10px', fontSize: '13px', fontWeight: 700,
        color: 'var(--dsw-alias-label-primary)', borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      groupHeading: { margin: 0, fontSize: '13px', fontWeight: 700, color: 'var(--dsw-alias-label-primary)' },
      section: { display: 'flex', flexDirection: 'column', gap: '12px' },
      intro: { margin: 0, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
      row: { display: 'flex', flexDirection: 'column', gap: '6px' },
      label: { fontWeight: 600, fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      // 只剩服务列表顶部那一句、goal 模式提示等少量常驻说明用这个样式。
      hint: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.55 },
      // 字段解释图标：可聚焦的圆形小「!」，不做全局 <style> 注入。
      infoDot: {
        position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        verticalAlign: 'middle', marginLeft: '5px', width: '15px', height: '15px', boxSizing: 'border-box',
        borderRadius: '50%', border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-secondary)',
        fontSize: '10px', fontWeight: 700, lineHeight: 1, cursor: 'help',
        outline: 'none', userSelect: 'none', flex: '0 0 auto',
      },
      infoDotOpen: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      infoDotGlyph: { display: 'block', transform: 'translateY(-0.5px)', pointerEvents: 'none' },
      // 绝对定位在图标上方；靠近视口右侧时改用右对齐（见 tooltipSideFor）。
      tooltip: {
        position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 9999,
        width: 'max-content', maxWidth: '260px', boxSizing: 'border-box', padding: '6px 9px',
        borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: '0 6px 18px rgba(0, 0, 0, 0.22)',
        fontSize: '12px', fontWeight: 400, lineHeight: 1.55, textAlign: 'left',
        whiteSpace: 'normal', pointerEvents: 'none',
      },
      tooltipRight: { left: 'auto', right: 0 },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)', font: 'inherit',
      },
      checkRow: { display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer' },
      checkbox: { width: '16px', height: '16px', marginTop: '2px', accentColor: 'var(--dsw-alias-brand-primary)', flex: '0 0 auto' },
      radio: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-brand-primary)', flex: '0 0 auto' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '12px' },
      tabs: {
        display: 'flex', gap: '20px', alignItems: 'stretch',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      // 页签本身不带任何边框；选中态只靠主色下划线与加粗，未选中没有 outline。
      tab: {
        border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit', fontWeight: 400, padding: '6px 0', cursor: 'pointer', outline: 'none',
        boxShadow: 'none', whiteSpace: 'nowrap',
      },
      tabActive: {
        color: 'var(--dsw-alias-label-primary)', fontWeight: 700,
        boxShadow: 'inset 0 -2px 0 0 var(--dsw-alias-brand-primary)',
      },
      // 键盘（:focus-visible）才有焦点环；鼠标点击走不到这里。
      tabFocus: {
        outline: '2px solid var(--dsw-alias-brand-primary)',
        outlineOffset: '2px',
        borderRadius: '6px',
      },
      serverTable: { display: 'flex', flexDirection: 'column' },
      serverHead: {
        display: 'grid', gridTemplateColumns: SERVER_COLUMNS, gap: '8px', alignItems: 'center',
        padding: '0 0 6px', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      serverHeadAction: { textAlign: 'right' },
      serverRow: {
        display: 'grid', gridTemplateColumns: SERVER_COLUMNS, gap: '8px', alignItems: 'center',
        padding: '7px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      serverCell: { minWidth: 0, display: 'flex', alignItems: 'center' },
      serverInput: {
        width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '5px 8px', borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: '12.5px',
      },
      serverActions: { justifyContent: 'flex-end' },
      deleteButton: {
        border: '1px solid var(--dsw-alias-state-danger-primary)', borderRadius: '6px',
        padding: '3px 9px', background: 'transparent', color: 'var(--dsw-alias-state-danger-primary)',
        font: 'inherit', fontSize: '12px', lineHeight: 1.4, cursor: 'pointer', whiteSpace: 'nowrap',
      },
      actions: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '2px' },
      primary: {
        border: 'none', borderRadius: '8px', padding: '7px 16px', background: 'var(--dsw-alias-brand-primary)',
        color: '#fff', font: 'inherit', cursor: 'pointer',
      },
      secondary: {
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px', padding: '7px 12px',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)', font: 'inherit', cursor: 'pointer',
      },
      error: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      ok: { margin: 0, color: 'var(--dsw-alias-state-success-primary)', fontSize: '12px' },
      muted: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
    };

    function asText(value, fallback) {
      return typeof value === 'string' ? value : fallback;
    }

    function asBool(value, fallback) {
      return typeof value === 'boolean' ? value : fallback;
    }

    function asNumberText(value) {
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    }

    function isWsUrl(value) {
      try {
        const url = new URL(String(value ?? ''));
        return url.protocol === 'ws:' || url.protocol === 'wss:';
      } catch {
        return false;
      }
    }

    /** 与 Host 侧 deriveServerId 同一规则：没有 id 的旧条目不丢，且 id 稳定。 */
    function derivedServerId(index, label) {
      const slug = String(label ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24);
      return slug ? `server-${index + 1}-${slug}` : `server-${index + 1}`;
    }

    function newServerId() {
      try {
        const cryptoApi = globalThis.crypto;
        if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
      } catch {
        // 降级到时间戳随机串
      }
      return `server-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    function serverRowsOf(source) {
      const list = Array.isArray(source?.servers) ? source.servers : [];
      const rows = [];
      list.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
        const label = asText(entry.label, '').trim();
        const storedToken = asText(entry.token, '').trim();
        rows.push({
          id: asText(entry.id, '').trim() || derivedServerId(index, label),
          label,
          wsUrl: asText(entry.wsUrl, '').trim(),
          enabled: entry.enabled === true,
          // 已保存的令牌只在内存里用来“未改动就沿用”，不渲染、不回显。
          storedToken,
          hasStoredToken: storedToken !== '',
          token: '',
          tokenTouched: false,
          isNew: false,
          legacyImported: false,
        });
      });
      // Host 在多条 enabled 时取第一条可用地址的服务；界面按同一规则只显示一个启用单选，
      // 避免打开设置页看到多个勾选、保存时又被 http(s) 地址卡住。
      const enabledRows = rows.filter((row) => row.enabled);
      const chosen = enabledRows.find((row) => isWsUrl(row.wsUrl)) ?? enabledRows[0];
      for (const row of rows) row.enabled = row === chosen;
      return rows;
    }

    function toDraft(value) {
      const source = value && typeof value === 'object' ? value : {};
      return {
        enabled: asBool(source.enabled, false),
        device: asText(source.device, ''),
        deviceId: asText(source.deviceId, ''),
        acceptReplies: asBool(source.acceptReplies, true),
        notifyOnCompleted: asBool(source.notifyOnCompleted, true),
        notifyOnFailed: asBool(source.notifyOnFailed, true),
        notifyMode: (() => {
          const mode = asText(source.notifyMode, 'auto');
          return mode === 'turn' || mode === 'goal' ? mode : 'auto';
        })(),
        minTurnMs: asNumberText(source.minTurnMs),
        maxSummaryChars: asNumberText(source.maxSummaryChars),
        connectTimeoutMs: asNumberText(source.connectTimeoutMs),
        reconnectMinMs: asNumberText(source.reconnectMinMs),
        reconnectMaxMs: asNumberText(source.reconnectMaxMs),
        servers: serverRowsOf(source),
        // 0.3.0 的顶层字段只用于迁移提示和「从旧配置导入」。
        legacy: {
          wsUrl: asText(source.wsUrl, '').trim(),
          token: asText(source.token, '').trim(),
        },
      };
    }

    /**
     * tooltip 默认在图标上方左对齐；图标靠近视口右侧时改成右对齐，
     * 避免 680px 宽的卡片在窄窗口里被裁掉。拿不到 DOM 布局（测试替身）时保持左对齐。
     */
    function tooltipSideFor(event) {
      try {
        const node = event && event.currentTarget;
        const rect = node && typeof node.getBoundingClientRect === 'function'
          ? node.getBoundingClientRect()
          : null;
        const viewportWidth = typeof window !== 'undefined' && typeof window.innerWidth === 'number'
          ? window.innerWidth
          : 0;
        if (rect && viewportWidth > 0) return rect.left > viewportWidth - 300 ? 'right' : 'left';
      } catch {
        // 忽略：拿不到布局就按默认左对齐
      }
      return 'left';
    }

    /**
     * 字段解释图标：一个可聚焦的圆形小「!」。
     * 悬停（mouseenter/mouseleave）与键盘聚焦（focus/blur）只改本组件 state；
     * tooltip 是绝对定位的 span，样式全部走 --dsw-alias-*，不注入全局样式表。
     */
    function InfoDot(props) {
      const [open, setOpen] = React.useState(false);
      const [side, setSide] = React.useState('left');
      const text = typeof props.text === 'string' ? props.text : '';
      if (!text) return null;

      const show = (event) => {
        setSide(tooltipSideFor(event));
        setOpen(true);
      };
      const hide = () => setOpen(false);

      return h('span', {
        'data-role': 'info-dot',
        role: 'button',
        tabIndex: 0,
        'aria-label': text,
        'aria-expanded': open,
        style: { ...styles.infoDot, ...(open ? styles.infoDotOpen : null) },
        onMouseEnter: show,
        onMouseLeave: hide,
        onFocus: show,
        onBlur: hide,
        // 图标常出现在 <label> 里：点它不要顺带切换复选框或聚焦输入框。
        onClick: (event) => {
          if (!event) return;
          event.preventDefault();
          event.stopPropagation();
        },
      },
        h('span', { key: 'glyph', 'aria-hidden': 'true', style: styles.infoDotGlyph }, '!'),
        open
          ? h('span', {
            key: 'tooltip',
            'data-role': 'info-tooltip',
            style: { ...styles.tooltip, ...(side === 'right' ? styles.tooltipRight : null) },
          }, text)
          : null,
      );
    }

    /** 字段：标题 + 解释图标（解释不再常驻在表单里）。 */
    function field(label, hint, control, key, extra) {
      return h('div', { key, style: styles.row, ...(extra ?? {}) },
        h('label', { key: 'label', style: styles.label },
          label,
          hint ? h(InfoDot, { key: 'info', text: hint }) : null,
        ),
        control,
      );
    }

    function checkboxField(id, label, hint, checked, disabled, onChange, key) {
      return h('label', { key, htmlFor: id, style: styles.checkRow },
        h('input', {
          id, type: 'checkbox', checked, disabled, style: styles.checkbox,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
          h('span', { key: 'label', style: styles.label },
            label,
            hint ? h(InfoDot, { key: 'info', text: hint }) : null,
          ),
        ),
      );
    }

    function ConfigCard(props) {
      if (props.view === 'summary') return h('span', null, props.t('summary'));
      return h(ConfigForm, props);
    }

    function ConfigForm(props) {
      const form = props.form;
      const t = props.t;
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot());
      const [draft, setDraft] = React.useState(() => toDraft(snapshot.value));
      // 页签是纯本地 state：保存仍然写全部字段，切页签不会丢草稿。
      const [tab, setTab] = React.useState('connection');
      // 只有键盘聚焦（:focus-visible）的页签才显示焦点环；鼠标点击不留黑框。
      const [focusTab, setFocusTab] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);

      React.useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form]);
      React.useEffect(() => { setDraft(toDraft(snapshot.value)); }, [snapshot.value]);

      const update = (key) => (value) => setDraft((previous) => ({ ...previous, [key]: value }));

      const updateServer = (id, patch) => setDraft((previous) => ({
        ...previous,
        servers: previous.servers.map((row) => (row.id === id ? { ...row, ...patch } : row)),
      }));

      /** 启用是单选：点一个 radio 就清掉其它行。 */
      const selectServer = (id) => setDraft((previous) => ({
        ...previous,
        servers: previous.servers.map((row) => ({ ...row, enabled: row.id === id })),
      }));

      const addServer = () => setDraft((previous) => ({
        ...previous,
        servers: [...previous.servers, {
          id: newServerId(),
          label: '',
          wsUrl: '',
          token: '',
          tokenTouched: false,
          storedToken: '',
          hasStoredToken: false,
          isNew: true,
          legacyImported: false,
          enabled: false,
        }],
      }));

      const removeServer = (id) => setDraft((previous) => ({
        ...previous,
        servers: previous.servers.filter((row) => row.id !== id),
      }));

      const importLegacy = () => setDraft((previous) => ({
        ...previous,
        servers: [...previous.servers, {
          id: newServerId(),
          label: t('legacyServerLabel'),
          wsUrl: previous.legacy.wsUrl,
          token: '',
          tokenTouched: false,
          storedToken: '',
          hasStoredToken: previous.legacy.token !== '',
          isNew: true,
          legacyImported: true,
          enabled: false,
        }],
      }));

      const disabled = busy || !snapshot.writable;

      /** 草稿行 → 要写回 config 的 servers 数组；未改动的令牌沿用 snapshot 里的值。 */
      const finalServers = () => draft.servers.map((row) => ({
        id: row.id,
        label: row.label.trim(),
        wsUrl: row.wsUrl.trim(),
        token: row.tokenTouched
          ? row.token.trim()
          : (row.legacyImported ? draft.legacy.token : row.storedToken),
        enabled: row.enabled,
      }));

      const save = async () => {
        setMessage(null);
        const current = snapshot.value && typeof snapshot.value === 'object' ? snapshot.value : {};
        const operations = [];
        const assign = (key, next) => {
          if (next !== current[key]) operations.push({ op: 'set', path: [key], value: next });
        };

        const nextServers = finalServers();
        if (nextServers.filter((row) => row.enabled).length > 1) {
          // radio 已经保证只有一个，这里兜住手改配置的极端情况。
          setMessage({ kind: 'error', text: t('serverUrlInvalid') });
          return;
        }
        for (const row of nextServers) {
          if (row.enabled && !isWsUrl(row.wsUrl)) {
            setMessage({ kind: 'error', text: t('serverUrlInvalid') });
            return;
          }
        }
        for (const row of draft.servers) {
          if (!row.isNew || row.legacyImported) continue;
          const token = row.tokenTouched ? row.token.trim() : row.storedToken;
          if (!token) {
            setMessage({ kind: 'error', text: t('serverTokenRequired') });
            return;
          }
        }

        assign('enabled', draft.enabled);
        assign('device', draft.device.trim());
        assign('deviceId', draft.deviceId.trim());
        assign('acceptReplies', draft.acceptReplies);
        assign('notifyOnCompleted', draft.notifyOnCompleted);
        assign('notifyOnFailed', draft.notifyOnFailed);
        assign('notifyMode', draft.notifyMode);

        for (const key of ['minTurnMs', 'maxSummaryChars', 'connectTimeoutMs', 'reconnectMinMs', 'reconnectMaxMs']) {
          const raw = String(draft[key] ?? '').trim();
          if (!raw) {
            if (current[key] !== undefined) operations.push({ op: 'unset', path: [key] });
            continue;
          }
          const parsed = Number(raw);
          if (!Number.isFinite(parsed) || parsed < 0) {
            setMessage({ kind: 'error', text: t('invalidNumber') });
            return;
          }
          assign(key, parsed);
        }

        const currentServers = Array.isArray(current.servers) ? current.servers : [];
        if (JSON.stringify(currentServers) !== JSON.stringify(nextServers)) {
          operations.push({ op: 'set', path: ['servers'], value: nextServers });
        }

        if (operations.length === 0) {
          setMessage({ kind: 'muted', text: t('noChanges') });
          return;
        }

        setBusy(true);
        try {
          const accepted = await form.mutate(operations);
          if (accepted) {
            setMessage({ kind: 'ok', text: t('saved') });
          } else {
            setMessage({ kind: 'error', text: t('saveFailed') });
          }
        } catch (error) {
          setMessage({ kind: 'error', text: String(error && error.message ? error.message : error) });
        } finally {
          setBusy(false);
        }
      };

      if (snapshot.status !== 'ready' || !snapshot.value) {
        return h('p', { style: styles.muted },
          snapshot.status === 'unavailable' ? t('unavailable') : t('loading'));
      }

      const tabButton = (id, label) => {
        const active = tab === id;
        const ring = focusTab === id;
        return h('button', {
          key: id,
          type: 'button',
          role: 'tab',
          id: `dsh-cwb-tab-${id}`,
          'aria-selected': active,
          'aria-controls': `dsh-cwb-panel-${id}`,
          'data-tab': id,
          'data-active': active ? 'true' : 'false',
          style: {
            ...styles.tab,
            ...(active ? styles.tabActive : null),
            ...(ring ? styles.tabFocus : null),
          },
          onFocus: (event) => {
            // 只有键盘聚焦（:focus-visible）才显示柔和焦点环；鼠标点击不留黑框。
            let visible = true;
            try {
              const target = event && event.target;
              if (target && typeof target.matches === 'function') visible = target.matches(':focus-visible');
            } catch {
              visible = true;
            }
            setFocusTab(visible ? id : '');
          },
          onBlur: () => setFocusTab((current) => (current === id ? '' : current)),
          onClick: () => setTab(id),
        }, label);
      };

      const renderServerRow = (row, index) => h('div', {
        key: row.id,
        'data-field': 'server-row',
        'data-id': row.id,
        style: index === draft.servers.length - 1
          ? { ...styles.serverRow, borderBottom: 'none' }
          : styles.serverRow,
      },
        h('div', { key: 'enabled', style: styles.serverCell },
          h('input', {
            type: 'radio',
            name: 'dsh-notify-sender-server-enabled',
            checked: row.enabled,
            disabled,
            'aria-label': t('serverActive'),
            'data-field': 'server-enabled',
            'data-id': row.id,
            style: styles.radio,
            onChange: () => selectServer(row.id),
          }),
        ),
        h('div', { key: 'label', style: styles.serverCell },
          h('input', {
            type: 'text',
            value: row.label,
            disabled,
            style: styles.serverInput,
            placeholder: t('serverLabelPlaceholder'),
            'aria-label': t('serverLabel'),
            'data-field': 'server-label',
            'data-id': row.id,
            onChange: (event) => updateServer(row.id, { label: event.target.value }),
          }),
        ),
        h('div', { key: 'wsUrl', style: styles.serverCell },
          h('input', {
            type: 'url',
            value: row.wsUrl,
            disabled,
            style: styles.serverInput,
            placeholder: DEFAULT_WS_URL,
            'aria-label': t('serverWsUrl'),
            'data-field': 'server-wsUrl',
            'data-id': row.id,
            onChange: (event) => updateServer(row.id, { wsUrl: event.target.value }),
          }),
        ),
        h('div', { key: 'token', style: styles.serverCell },
          h('input', {
            type: 'password',
            value: row.token,
            disabled,
            style: styles.serverInput,
            autoComplete: 'new-password',
            placeholder: row.hasStoredToken ? t('tokenSetPlaceholder') : t('tokenPlaceholder'),
            'aria-label': t('serverToken'),
            'data-field': 'server-token',
            'data-id': row.id,
            onChange: (event) => updateServer(row.id, { token: event.target.value, tokenTouched: true }),
          }),
        ),
        h('div', { key: 'actions', style: { ...styles.serverCell, ...styles.serverActions } },
          h('button', {
            type: 'button',
            disabled,
            style: styles.deleteButton,
            'data-action': 'delete-server',
            'data-id': row.id,
            onClick: () => removeServer(row.id),
          }, t('deleteServer')),
        ),
      );

      const connectionTab = h('div', { key: 'connection', style: styles.section },
        h('h3', { key: 'device-heading', style: styles.groupHeading }, t('deviceSection')),
        h('div', { key: 'device-grid', style: styles.grid },
          field(t('device'), t('deviceHint'), h('input', {
            type: 'text', value: draft.device, disabled, style: styles.input,
            placeholder: 'dev-box',
            'data-field': 'device',
            onChange: (event) => update('device')(event.target.value),
          }), 'device'),
          field(t('deviceId'), t('deviceIdHint'), h('input', {
            type: 'text', value: draft.deviceId, disabled, style: styles.input,
            placeholder: t('deviceIdPlaceholder'),
            'data-field': 'deviceId',
            onChange: (event) => update('deviceId')(event.target.value),
          }), 'deviceId'),
        ),
        checkboxField('dsh-notify-sender-accept-replies', t('acceptReplies'), t('acceptRepliesHint'), draft.acceptReplies, disabled, update('acceptReplies'), 'acceptReplies'),
        h('h3', { key: 'servers-heading', style: styles.subheading }, t('serversSection')),
        h('p', { key: 'servers-hint', 'data-role': 'servers-hint', style: styles.hint }, t('serversHint')),
        draft.servers.length === 0
          ? h('p', { key: 'servers-empty', style: styles.muted }, t('serversEmpty'))
          : h('div', { key: 'server-table', 'data-role': 'server-table', style: styles.serverTable },
            h('div', { key: 'server-head', 'data-role': 'server-head', style: styles.serverHead },
              h('span', null, t('serverActive')),
              h('span', null, t('serverLabel')),
              h('span', null, t('serverWsUrl')),
              h('span', null, t('serverToken')),
              h('span', { style: styles.serverHeadAction }, t('serverActions')),
            ),
            draft.servers.map(renderServerRow),
          ),
        draft.servers.length === 0 && draft.legacy.wsUrl
          ? h('p', { key: 'legacy-hint', 'data-role': 'legacy-hint', style: styles.hint }, t('legacyHint'))
          : null,
        h('div', { key: 'server-actions', 'data-role': 'server-actions', style: styles.actions },
          draft.servers.length === 0 && draft.legacy.wsUrl
            ? h('button', {
              type: 'button',
              disabled,
              style: styles.secondary,
              'data-action': 'import-legacy',
              onClick: importLegacy,
            }, t('importLegacy'))
            : null,
          h('button', {
            type: 'button',
            disabled,
            style: styles.secondary,
            'data-action': 'add-server',
            onClick: addServer,
          }, t('addServer')),
        ),
      );

      const notifyTab = h('div', { key: 'notify', style: styles.section },
        field(t('notifyMode'), t('notifyModeHint'), h('select', {
          value: draft.notifyMode, disabled, style: styles.input,
          'data-field': 'notifyMode',
          onChange: (event) => update('notifyMode')(event.target.value),
        },
          h('option', { value: 'auto' }, t('notifyModeAuto')),
          h('option', { value: 'turn' }, t('notifyModeTurn')),
          h('option', { value: 'goal' }, t('notifyModeGoal')),
        ), 'notifyMode'),
        checkboxField('dsh-notify-sender-completed', t('notifyOnCompleted'), null, draft.notifyOnCompleted, disabled, update('notifyOnCompleted'), 'completed'),
        checkboxField('dsh-notify-sender-failed', t('notifyOnFailed'), null, draft.notifyOnFailed, disabled, update('notifyOnFailed'), 'failed'),
        h('div', { key: 'numbers', style: styles.grid },
          draft.notifyMode === 'goal'
            ? null
            : field(t('minTurnMs'), t('minTurnMsHint'), h('input', {
              type: 'number', min: 0, step: 1000, value: draft.minTurnMs, disabled, style: styles.input,
              'data-field': 'minTurnMs',
              onChange: (event) => update('minTurnMs')(event.target.value),
            }), 'minTurnMs'),
          field(t('maxSummaryChars'), t('maxSummaryCharsHint'), h('input', {
            type: 'number', min: 80, step: 10, value: draft.maxSummaryChars, disabled, style: styles.input,
            'data-field': 'maxSummaryChars',
            onChange: (event) => update('maxSummaryChars')(event.target.value),
          }), 'maxSummaryChars'),
        ),
        draft.notifyMode === 'goal'
          ? h('p', { key: 'minTurn-note', 'data-role': 'minTurn-note', style: styles.hint }, t('minTurnMsGoalHidden'))
          : null,
      );

      const advancedTab = h('div', { key: 'advanced', style: styles.section },
        h('div', { key: 'advanced-grid', style: styles.grid },
          field(t('connectTimeoutMs'), t('connectTimeoutMsHint'), h('input', {
            type: 'number', min: 100, step: 100, value: draft.connectTimeoutMs, disabled, style: styles.input,
            'data-field': 'connectTimeoutMs',
            onChange: (event) => update('connectTimeoutMs')(event.target.value),
          }), 'connectTimeoutMs'),
          field(t('reconnectMinMs'), t('reconnectMinMsHint'), h('input', {
            type: 'number', min: 100, step: 100, value: draft.reconnectMinMs, disabled, style: styles.input,
            'data-field': 'reconnectMinMs',
            onChange: (event) => update('reconnectMinMs')(event.target.value),
          }), 'reconnectMinMs'),
          field(t('reconnectMaxMs'), t('reconnectMaxMsHint'), h('input', {
            type: 'number', min: 1000, step: 1000, value: draft.reconnectMaxMs, disabled, style: styles.input,
            'data-field': 'reconnectMaxMs',
            onChange: (event) => update('reconnectMaxMs')(event.target.value),
          }), 'reconnectMaxMs'),
        ),
      );

      return h('div', { style: styles.root },
        h('h2', { style: styles.heading }, t('title')),
        h('p', { style: styles.intro }, t('intro')),
        !snapshot.writable ? h('p', { style: styles.muted }, t('readOnly')) : null,
        // 总开关常驻在页签条上方：它影响连接与所有页签，不属于某一个页签。
        h('div', { key: 'master-switch', 'data-role': 'master-switch' },
          checkboxField('dsh-notify-sender-enabled', t('enabled'), t('enabledHint'), draft.enabled, disabled, update('enabled'), 'enabled'),
        ),
        h('div', { role: 'tablist', 'data-role': 'config-tabs', style: styles.tabs },
          tabButton('connection', t('tabConnection')),
          tabButton('notify', t('tabNotify')),
          tabButton('advanced', t('tabAdvanced')),
        ),
        h('div', {
          key: 'panel',
          role: 'tabpanel',
          id: `dsh-cwb-panel-${tab}`,
          'aria-labelledby': `dsh-cwb-tab-${tab}`,
          'data-role': 'tab-panel',
        },
          tab === 'notify' ? notifyTab : tab === 'advanced' ? advancedTab : connectionTab,
        ),
        h('div', { style: styles.actions },
          h('button', {
            type: 'button',
            disabled,
            style: styles.primary,
            'data-action': 'save',
            onClick: save,
          }, busy ? t('saving') : t('save')),
          h('span', { style: styles.muted }, t('saveAllTabsHint')),
        ),
        message
          ? h('p', { style: message.kind === 'error' ? styles.error : message.kind === 'ok' ? styles.ok : styles.muted }, message.text)
          : null,
      );
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-notify-sender: dictionaries');
      const form = ctx.configForms.get(ENTRY_ID);
      const render = (ownerProps) => h(ConfigCard, Object.assign({}, ownerProps, { form, t }));

      // Settings 左栏：一个独立入口，最容易找到。
      // 0.3.3 起不再注册 settings.plugins.tab：配置只出现在左栏，
      // 避免「内置插件」页签里再出现一份同样的表单。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-notify-sender',
        order: 70,
        label: 'Coopanion Bridge',
        locale: NS,
        inject: () => ({ t }),
      }, render));

      // 侧栏 Plugins 页：这个 bundle 自己的配置区。
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-notify-sender',
        locale: NS,
        inject: () => ({ t }),
      }, render));

      // 侧栏 Plugins 页：这一行的 configure 页，key 是 `<包名>#<行 id>`。
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dsh-notify-sender#dsh-notify-sender',
        locale: NS,
        inject: () => ({ t }),
      }, render));
    }

    return { inject: ['slots', 'locale', 'configForms'], apply };
  },
});
