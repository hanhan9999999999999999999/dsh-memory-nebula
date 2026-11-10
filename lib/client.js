/**
 * dsh-memory-nebula —— 浏览器半侧（手写 __ModuleLoader__ bundle，无需构建）。
 *
 * 做两件事：
 *   1. 左侧栏加一个图标（sidebar.panellist，id = memory-nebula）；
 *   2. 点进去是主面板（main → key = memory-nebula），里面是一个占满高度的 iframe，
 *      指向 /api/memory-nebula/app —— 星云本体自己带 CSS/JS，走同源，零构建。
 *
 * 为什么用 iframe：canvas 星图需要自己的全屏布局、自己的滚轮/拖拽事件、
 * 自己的 <style>，塞进 React 树里会被宿主的滚动容器和主题样式反复干扰。
 * 同源 iframe 既隔离又共享 cookie，还顺便让人能单独打开 /api/memory-nebula/app 调试。
 */

window.__ModuleLoader__.load({
  id: 'dsh-memory-nebula',
  factory: function (require) {
    var module = { exports: {} }
    var React = require('react')
    var h = React.createElement

    var PANEL_ID = 'memory-nebula'
    var APP_URL = '/api/memory-nebula/app'
    var LABEL = '记忆星图'

    // ---- 图标：一条星线（三个节点被两条弧连起来） -------------------------

    function NebulaIcon(props) {
      var size = (props && props.size) || 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('circle', { cx: 5.5, cy: 17.5, r: 2.2 }),
        h('circle', { cx: 18.5, cy: 14.5, r: 1.7 }),
        h('circle', { cx: 12, cy: 4.8, r: 2.4 }),
        h('path', { d: 'M7.4 16.2 10.4 6.9' }),
        h('path', { d: 'M13.6 6.3 17.2 12.9' }),
        h('path', { d: 'M7.7 17.6c3.2 1.4 6.6 0 9.2-2.1' }),
      )
    }

    // ---- 主面板：一个铺满的 iframe ---------------------------------------

    function NebulaPage() {
      return h('iframe', {
        src: APP_URL,
        title: LABEL,
        style: {
          display: 'block',
          width: '100%',
          height: '100%',
          border: '0',
          background: '#04060c',
          colorScheme: 'dark',
        },
        allow: 'clipboard-write',
      })
    }

    // ---- 注册 -------------------------------------------------------------

    function apply(ctx) {
      ctx.slots.inject('main', function () {
        return ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            order: 30,
          },
          NebulaPage,
        )
      })

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 24,
            label: function () {
              return LABEL
            },
          },
          NebulaIcon,
        )
      })
    }

    module.exports = {
      name: 'memory-nebula',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
