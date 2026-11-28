/**
 * BetterOffice 的浏览器半体：插件详情页里的自绘卡片。
 *
 * 刻意不用打包器——宿主用 CommonJS 工厂直接加载本文件，React 由宿主的 require 提供。
 * 卡片只负责「读状态 + 点按钮」，全部判断和中文文案都在宿主侧（src/routes.ts / src/control.ts），
 * 这样两边不会各写一套规则。
 */

const STATUS_URL = '/api/betteroffice/status'
const ACTION_URL = '/api/betteroffice/action'
const POLL_MS = 1500

window.__ModuleLoader__.load({
  id: 'dsh-betteroffice',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const exports = {}

    /** fetch 抛的英文错误换成一句能照着做的话。 */
    function readable(error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === '' || /fetch|network|load failed/i.test(message)) {
        return '连不上宿主的配置接口。稍后再点一次；一直这样请重启 DSH。'
      }
      return message
    }

    function line(text, tone, key) {
      return h('div', { key, style: { marginTop: 2, color: tone === 'error' ? '#c0392b' : undefined } }, text)
    }

    function Card() {
      const [snap, setSnap] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [result, setResult] = React.useState(null)
      const [target, setTarget] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(STATUS_URL, { headers: { accept: 'application/json' } })
          const body = await response.json()
          if (body.ok === false) throw new Error(body.error || '读不到运行时状态。')
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
            body: JSON.stringify(action === 'rollback' ? { action, version: target } : { action }),
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

      const rows = []
      if (snap !== null) {
        rows.push(`Node ${snap.node.version}（需要 ≥${snap.node.required}）：${snap.node.ok ? '满足' : '不满足'}`)
        rows.push(`当前运行时：${snap.runtime.configured === '' ? '未选择' : snap.runtime.configured}`)
        rows.push(`已装版本：${versions.length === 0 ? '（还没装任何版本）' : versions.join(' / ')}`)
        if (installing) rows.push(`安装中：${inFlight.join(' / ')}…`)
        if (snap.latest !== null) rows.push(`registry 最新：${snap.latest}`)
      }

      function button(action, label) {
        return h(
          'button',
          { key: action, type: 'button', disabled, onClick: () => void run(action) },
          busy === action ? `${label}…` : label,
        )
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', padding: '8px 0' } },
        h('div', { style: { fontWeight: 600, marginBottom: 4 } }, 'BetterOffice 运行时'),
        snap === null ? line('正在读取状态…') : null,
        ...rows.map((text) => line(text)),
        ...(snap === null ? [] : snap.messages.map((text) => line(text))),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center' } },
          button('install', '安装最新'),
          button('check', '检查更新'),
          button('update', '更新'),
          h(
            'select',
            {
              key: 'rollback-version',
              value: picked,
              disabled: disabled || versions.length === 0,
              onChange: (event) => setTarget(event.target.value),
            },
            versions.map((version) => h('option', { key: version, value: version }, version)),
          ),
          button('rollback', '回退'),
        ),
        result === null ? null : line(result.text, result.kind),
      )
    }

    exports.inject = []

    exports.apply = (ctx) => {
      // key 必须是本 bundle 的包名：plugins.bundle.config 是共享命名空间，
      // 同一个 key 注册两次会抛错，而客户端 apply 抛错 = 整个插件起不来。
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-betteroffice' }, Card),
      )
    }

    return exports
  },
})
