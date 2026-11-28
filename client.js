/**
 * BetterOffice 的浏览器半体：插件详情页里的自绘卡片。
 *
 * 刻意不用打包器——宿主用 CommonJS 工厂直接加载本文件，React 由宿主的 require 提供。
 * 卡片只负责「读状态 + 点按钮」，全部判断和中文文案都在宿主侧（src/routes.ts / src/control.ts），
 * 这样两边不会各写一套规则。
 *
 * 外观借用 DSH 自己的组件库与色板：按钮用 @deepseek-ai/dsh-client-ui-primitives 的 Button，
 * 其余块用 --dsw-alias-* 这些全局 token 画，跟设置页保持同一套视觉语言。
 */

const STATUS_URL = '/api/betteroffice/status'
const ACTION_URL = '/api/betteroffice/action'
const POLL_MS = 1500
const STYLE_ID = 'dsh-betteroffice-style'

const CARD_CSS = `
.bo_card { display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 13px; }
.bo_title { font-size: 14px; font-weight: 600; }
.bo_rows { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; align-items: baseline; }
.bo_label { color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.bo_value { color: var(--dsw-alias-label-primary); word-break: break-all; }
.bo_value[data-ok="false"] { color: var(--dsw-alias-state-error-primary); }
.bo_note { color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.bo_actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.bo_select { appearance: none; padding: 5px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 13px; font-family: var(--ds-font-family-code); }
.bo_select:disabled { opacity: 0.5; }
.bo_result { color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.bo_result[data-kind="ok"] { color: var(--dsw-alias-state-success-primary); }
.bo_result[data-kind="error"] { color: var(--dsw-alias-state-error-primary); }
.bo_btn { padding: 5px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 13px; cursor: pointer; }
.bo_btn[data-variant="primary"] { border-color: transparent; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-bg-base); }
.bo_btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.bo_btn:disabled { opacity: 0.5; cursor: default; }
`

window.__ModuleLoader__.load({
  id: 'dsh-betteroffice',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const exports = {}

    /**
     * 官方组件库由 package.json 的 dsh.client.inject 声明后才交给 require()。
     * 老宿主可能没这个包，取不到就退回自带样式，别让 apply 抛错把整个客户端带下去。
     */
    function loadPrimitives() {
      try {
        const module = require('@deepseek-ai/dsh-client-ui-primitives')
        return module !== null && typeof module === 'object' ? module : {}
      } catch {
        return {}
      }
    }

    const primitives = loadPrimitives()
    const OfficialButton = typeof primitives.Button === 'function' ? primitives.Button : null

    /** 样式表只挂一次；宿主可能重复执行本文件，用 DOM 上的 id 去重，不靠模块级变量。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CARD_CSS
      document.head.appendChild(style)
    }

    /** fetch 抛的英文错误换成一句能照着做的话。 */
    function readable(error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === '' || /fetch|network|load failed/i.test(message)) {
        return '连不上宿主的配置接口。稍后再点一次；一直这样请重启 DSH。'
      }
      return message
    }

    function Label({ children }) {
      return h('span', { className: 'bo_label' }, children)
    }

    function Value({ ok, children }) {
      return h('span', { className: 'bo_value', 'data-ok': ok === false ? 'false' : undefined }, children)
    }

    /** 有官方 Button 就用官方 Button（视觉与设置页一致），没有就退回同色板手绘按钮。 */
    function ActButton({ variant, disabled, onClick, children }) {
      if (OfficialButton !== null) {
        return h(OfficialButton, { variant, disabled, onClick }, children)
      }
      return h('button', { type: 'button', className: 'bo_btn', 'data-variant': variant, disabled, onClick }, children)
    }

    function Card() {
      const [snap, setSnap] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [result, setResult] = React.useState(null)
      const [target, setTarget] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(STATUS_URL, { headers: { accept: 'application/json' } })
          if (!response.ok) {
            throw new Error(`读不到运行时状态（HTTP ${response.status}），稍后再试；一直这样请重启 DSH。`)
          }
          // 401 的 HTML 页、别的路由的 JSON 都别拿去渲染：形状不对就给一句话，别白屏。
          const body = await response.json().catch(() => null)
          if (
            body === null ||
            typeof body !== 'object' ||
            body.ok === false ||
            body.node === null ||
            typeof body.node !== 'object' ||
            body.runtime === null ||
            typeof body.runtime !== 'object' ||
            !Array.isArray(body.runtime.installed) ||
            !Array.isArray(body.messages) ||
            !Array.isArray(body.inFlight)
          ) {
            throw new Error(body && body.error ? body.error : '宿主返回的状态不是配置卡片认识的格式，请把 DSH 升到 0.2.0-rc.1 以上。')
          }
          setSnap(body)
        } catch (error) {
          setResult({ kind: 'error', text: readable(error) })
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const inFlight = snap === null ? [] : snap.inFlight
      const installing = inFlight.length > 0
      // 安装期间轮询：装完 inFlight 清空，这个 effect 自然停下。
      React.useEffect(() => {
        if (!installing) return undefined
        const timer = setTimeout(() => {
          void load()
        }, POLL_MS)
        return () => clearTimeout(timer)
      }, [installing, snap, load])

      async function run(action) {
        setBusy(action)
        setResult(null)
        try {
          const response = await fetch(ACTION_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // 回退发的是下拉框实际选中的那个版本：target 初始是空串，直接发它是必然 400。
            body: JSON.stringify(action === 'rollback' ? { action, version: picked } : { action }),
          })
          const body = await response.json().catch(() => ({}))
          if (body.ok === true) {
            setResult({ kind: 'ok', text: body.text || '完成。' })
          } else {
            setResult({ kind: 'error', text: body.error || `操作失败（HTTP ${response.status}），稍后再试。` })
          }
        } catch (error) {
          setResult({ kind: 'error', text: readable(error) })
        }
        setBusy('')
        await load()
      }

      const versions = snap === null ? [] : snap.runtime.installed
      const picked = versions.includes(target) ? target : versions[0] || ''
      const disabled = busy !== '' || installing

      function button(action, label, variant) {
        return h(ActButton, { key: action, variant, disabled, onClick: () => void run(action) }, busy === action ? `${label}…` : label)
      }

      const rows = []
      if (snap !== null) {
        rows.push(
          h(Label, { key: 'node-label' }, `Node ${snap.node.version}`),
          h(Value, { key: 'node-value', ok: snap.node.ok }, snap.node.ok ? `满足（需要 ≥${snap.node.required}）` : `不满足：需要 ≥${snap.node.required}`),
          h(Label, { key: 'current-label' }, '当前运行时'),
          h(Value, { key: 'current-value' }, snap.runtime.configured === '' ? '未选择' : snap.runtime.configured),
          h(Label, { key: 'installed-label' }, '已装版本'),
          h(Value, { key: 'installed-value' }, versions.length === 0 ? '（还没装任何版本）' : versions.join(' / ')),
        )
        if (installing) {
          rows.push(h(Label, { key: 'inflight-label' }, '安装中'), h(Value, { key: 'inflight-value' }, `${inFlight.join(' / ')}…`))
        }
        if (snap.latest !== null) {
          rows.push(h(Label, { key: 'latest-label' }, 'registry 最新'), h(Value, { key: 'latest-value' }, snap.latest))
        }
      }

      return h(
        'div',
        { className: 'bo_card' },
        h('div', { className: 'bo_title' }, 'BetterOffice 运行时'),
        snap === null
          ? h('div', { className: 'bo_note' }, '正在读取状态…')
          : h('div', { className: 'bo_rows' }, ...rows),
        ...(snap === null ? [] : snap.messages.map((text, index) => h('div', { key: `message-${index}`, className: 'bo_note' }, text))),
        h(
          'div',
          { className: 'bo_actions' },
          button('install', '安装最新', 'primary'),
          button('check', '检查更新', 'outline'),
          button('update', '更新', 'outline'),
          h(
            'select',
            {
              key: 'rollback-version',
              className: 'bo_select',
              value: picked,
              disabled: disabled || versions.length === 0,
              onChange: (event) => setTarget(event.target.value),
            },
            versions.map((version) => h('option', { key: version, value: version }, version)),
          ),
          button('rollback', '回退', 'outline'),
        ),
        result === null ? null : h('div', { className: 'bo_result', 'data-kind': result.kind }, result.text),
      )
    }

    // 必须声明 slots：cordis 4 对没 inject 的服务属性访问会直接抛错，apply 抛错就是整个客户端起不来。
    exports.inject = ['slots']

    exports.apply = (ctx) => {
      ensureStyle()
      // key 必须是本 bundle 的包名：plugins.bundle.config 是共享命名空间，
      // 同一个 key 注册两次会抛错，而客户端 apply 抛错 = 整个插件起不来。
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-betteroffice' }, Card),
      )
    }

    return exports
  },
})
