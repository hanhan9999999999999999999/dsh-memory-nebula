# 可访问性：键盘与读屏

> 面向 1.7.0 起的界面。星图是一张 canvas，画布里的像素对读屏没有任何语义，
> 所以这里做的不是「给 canvas 加个 aria-label」，而是**另开一条不依赖画面的通路**。

## 一、键盘怎么用

页面的第一个 `Tab` 停在左上角的「跳到记忆星图」——按 `Enter` 直接越过整条工具栏进入星图；
也可以点一下画面。焦点进入时会自动落在最近的一颗星上，然后：

| 按键 | 作用 |
| --- | --- |
| `Tab`（页面起始处） | 停在「跳到记忆星图」；`Enter` 直接把焦点送进星图层 |
| `↑` `↓` `←` `→` | 朝那个方向走到下一颗星（按屏幕上的空间关系挑，不是按数组顺序） |
| `Enter` / `空格` | 打开当前这颗星的详情 |
| `[` / `]` | 沿已有连接走到相邻的一颗（按连接强度从强到弱循环） |
| `+` / `=` | 放大 |
| `-` / `_` | 缩小 |
| `0` | 回到全图 |
| `Home` | 跳到连接最多的那颗（没有度数数据时退回第一颗） |
| `Esc` | 有详情先收详情；再按一次离开星图，焦点回到顶栏按钮 |

方向键的挑选规则写在 `lib/web/nav.js`：

- 只考虑落在该方向上的星（投影距离 `along < 2px` 的直接跳过，避免手抖选中正上方那颗）；
- 代价 `cost = 距离 × (1 + 1.5 × 垂直偏移 / 前进距离)`，所以**略偏的近星会赢过很远的正前方**，
  这符合人看画面时的直觉；
- 代价打平时按 `id` 的字符串序取小，保证同一张图每次按键结果一致；
- 与当前点重合的星不会被选中（否则会在原地来回跳）。

## 二、读屏会听到什么

| 区域 | 元素 | 内容 |
| --- | --- | --- |
| 星图摘要 | `#a11y-summary`（`.sr-only`） | 「记忆星图：N 条记忆，M 条连接。按 Tab 进入星图后，用方向键在星星之间移动，回车打开。」 |
| 纯文本索引 | `#a11y-index`（`.sr-only` 列表） | 按重要度排序的标题清单，最多 300 条；超出部分给一句「还有 N 条，用搜索或项目筛选收窄范围」 |
| 走位播报 | `#a11y-live`（`role="status" aria-live="polite" aria-atomic="true"`） | 「当前位置：标题 · 项目」「已打开：…」「已放大」「这个方向没有别的记忆」等 |
| 键位说明 | `#kb-help`（`.sr-only`，由 `aria-describedby` 关联） | 全部按键的一句话说明 |

画布本身保持 `aria-hidden="true"`。在 `aria-hidden` 的节点上设 `role="img"` / `aria-label`
是**死代码**——读屏不会念，还会让人误以为无障碍已经做了；1.7.0 把 `applyGraph` 里那一段删掉了。

## 三、实现结构

| 文件 | 职责 |
| --- | --- |
| `lib/web/nav.js` | 纯几何：`pick` / `nearest` / `hub` / `neighbors`。不碰 DOM，可在 Node 里直接测 |
| `lib/web/index.html` | `.skip-link` 跳过链接、`#skykeys` 键盘层、`#kb-help`、`#a11y-live`、`#a11y-summary`、`#a11y-index` |
| `lib/web/style.css` | `.sr-only`（`clip-path: inset(50%)`，不是 `display:none`）、`.skip-link` 的滑入与焦点样式、`#skykeys` 的焦点描边与 `pointer-events: none` |
| `lib/web/app.js` | `bindKeyboardNav()` 接管按键、`announce()` 播报、`renderA11yIndex()` 生成摘要与索引、点画布时把焦点递给键盘层 |
| `lib/web/render.js` | `api.centerOn(id)`（只平移）、`api.zoomBy(factor)`（限位 0.18–5.5，与滚轮一致） |
| `lib/web/space3d.js` | 同名的 `centerOn` / `zoomBy`（距离限位 180–9000） |

键盘层是 `pointer-events: none` 的：它只接焦点、不吃鼠标，所以点画布照旧能拖动、
悬停照旧有高亮；点下去时才由 `app.js` 把焦点递进来。

## 四、边界与已知限制

- **只走看得见的星**：`screenOf(id)` 拿不到坐标的（被转到屏幕外、被球体挡在背面）不参与走位。
  这是刻意的——把人送到一个看不见的点上比不动更糟。
- **索引上限 300 条**：两万条的图全列出来对读屏是灾难。要更全的清单用搜索或左栏筛选先收窄。
- **只做了结构语义 + 自动审计**：颜色对比、`prefers-reduced-motion` 的 5 处降级、`aria-live` 播报都在，
  axe-core 4.10.2 对离线快照、HTTP 服务、英文界面与官网首页跑过一遍，**0 违例**
  （只有 `color-contrast` 因画布渐变背景列进 incomplete，需要人眼复核）。
  但**没有**经过 NVDA / VoiceOver 真机走查，发布前建议按下面的清单过一遍。
- 官网的弱文字从 `#5f6878` 提到 `#8a94a6`（3.6:1 → 6.6:1），横向截图条加了 `tabindex="0"` 与区域名；
  星图页补了 `<main>` 地标和两个滑杆的 `aria-label`。这三处都是 axe 审计抓出来后才补的。
- 3D 视图的方向键走位用的是屏幕投影坐标，转视角之后「上」仍然是屏幕上方，符合直觉，但不等于世界坐标的 y。
  这一条已在 headless Edge 里按 `3` 切到 Galaxy 后用真实按键走过一遍（方向键、`]`、`+`、`Enter`、`Esc` 全通过）。

## 五、怎么验证

自动：

```bash
node --test test/nav.test.mjs     # 10 项几何
node --test test/a11y.test.mjs    # 11 项结构门
npm test                          # 全量 126 项
```

审计（开发机，仓库外放 `axe.min.js` 与 CDP 脚本）：

```bash
node dev/cdp-axe.mjs "D:/path/to/docs/demo.html"          # 离线快照
node dev/cdp-axe.mjs "http://127.0.0.1:62120/?lang=en"    # 英文界面
node dev/cdp-axe.mjs "D:/path/to/docs/index.html"         # 官网
# 期望：violations 为空，passes 38–42
```

手工（每条 30 秒）：

1. 打开星图，按 `Tab`：焦点应停在星图（能看到一圈描边），并听到「当前位置：…」。
2. 连按 `→`：焦点环随选中星移动，播报跟着变；到头时听到「这个方向没有别的记忆」。
3. 按 `Enter`：右侧详情打开；按 `Esc` 收起详情，再按一次焦点回到顶栏。
4. 按 `+` `-` `0`：画面缩放与回到全图正常，且缩放不会越过滚轮的上下限。
5. 开读屏（NVDA / VoiceOver）按 `Tab` 顺序走一遍：应能听到摘要、索引条数与每一条标题。
