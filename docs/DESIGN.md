# 11408 沉浸时钟 · 设计系统总纲

> 本文档是前端视觉与交互的**单一事实来源**。所有样式必须引用 `web/src/styles.css` 的语义 token，禁止组件各自写近似值。
> 定位：单用户公网沉浸式学习计时器。只记录时间执行数据，不推断学习完成、正确率、覆盖或掌握（由 study-ledger 独占）。

## 1. 代码边界

```
shared/   领域规则：状态机、净时长、北京时间日切、日报汇总、静默时段、休息预算（零云依赖）
server/   Hono API：路由/鉴权/CSRF/限流/幂等 + SQLite 与 D1 双 adapter（Storage 接口）
web/      React/Vite SPA：三态时钟 + 日时间轴 + 近 7 天回顾 + 设置（浅/深主题）
migrations/  纯 SQL migration（SQLite/D1 交集语法）
e2e/      Playwright：流程、响应式、视觉样式、数据状态回归（仅 desktop-light project）
docs/     API、设计、审计、交接
```

## 2. 视觉 token（styles.css `:root` / `[data-theme='dark']`）

| 类别 | token | 说明 |
|---|---|---|
| 背景/表面 | `--bg` `--bg-elevated` `--surface-1` `--surface-2` | 分层：页面底 → 卡片 → 次级 |
| 文字 | `--text-1` `--text-2` `--text-3` | 主/次/弱；`--text-3` 仅非关键信息（对比 ≥3:1） |
| 语义色 | `--accent`(systemBlue) `--danger`(systemRed) `--success`(systemGreen) `--amber` | HIG 语义色，浅/深各一套 |
| 边框/阴影 | `--border` `--shadow` `--shadow-sm` `--shadow-up` `--shadow-hover` `--shadow-knob` | 分层阴影，向上用 `--shadow-up`，悬停抬升用 `--shadow-hover`，分段控件滑块用 `--shadow-knob` |
| 材质 | `--material`(顶栏/浮层 0.72) `--popover-surface`(弹层 0.96) `--overlay-scrim`(遮罩 0.44) | backdrop-filter 只用于顶栏与浮层 |
| 圆角 | `--radius-sm`6 `--radius`10 `--radius-lg`12 `--radius-xl`14；胶囊 999px | 控件 ≤ 卡片 ≤ 浮层 |
| 间距 | `--space-1..7` = 4/8/12/16/24/32/48 | 4pt 底、8pt 节奏 |
| 字级 | `--fs-xs..3xl` = 11/12/13/14/15/17/22/28 | 大数字不用此表，用 dvh clamp |
| 动效 | `--ease-standard`(0.2,0,0,1) `--dur-press`0.1 `--dur-hover`0.15 `--dur-enter`0.25 `--dur-state`0.28 | 全部过渡取此组 |

科目色：`[data-color=amber|teal|blue|indigo|violet|cyan|coral]` → `--sc`/`--sc-bg`，浅/深两套，色相分散避免蓝紫扎堆。

## 3. 按钮层级（styles.css「按钮系统」段）

| 层级 | class | 尺寸 | 用途 |
|---|---|---|---|
| 主操作 | `.start-btn` | 48×auto / radius-lg | 开始 |
| 主操作（内联） | `.primary-btn` | 44 / radius-lg | 弹窗确认、召回「回到学习」 |
| 圆形控制 | `.control-btn`（.resume/.stop/.pause） | 56 / 圆 | 暂停/继续/结束 |
| 次要 | `.ghost-btn` | 36 / radius | 弹窗取消、撤回 |
| 危险 | `.danger-btn` | 36 / radius | 撤回、退出登录 |
| 图标 | `.icon-btn` | 32 / radius-sm | 顶栏设置、时间轴导航 |
| 文字 | `.text-btn` | 32 / radius-sm | 「现在」「回今天」 |
| 分段控件 | `.seg-control`（默认）/ `.timeline-scale`（紧凑） | 项高 32/24 | 设置内单选、时间轴尺度 |

规范：禁用统一 opacity 0.4；focus-visible 统一 2px accent 环；press 统一 scale；图标按钮必须有 `aria-label` 与 `title`；文字圆角胶囊不替代熟悉图标。

## 4. 弹层与遮罩

- 设置对话框、时间轴片段详情：`--popover-surface`（0.96）+ backdrop blur；遮罩 `--overlay-scrim`（0.44）。
- 层级：遮罩 z40 → 对话框 z50 → toast z60 → 离开召回遮罩 z90。
- 弹层互不套卡；各自内部滚动，不解锁文档级滚动。

## 5. 三态主题：专注 / 休息 / 逾期

参考 Super Productivity focus-mode、Pomotroid 阶段切换、FocusTide 全视口状态层，与游戏 feel 的「氛围反馈 + 状态过渡」理论。实现集中在 `.clockface[data-away-level]` → `.app` 的 `--alert-wash` 机制：

| 状态 | 触发 | 视觉 |
|---|---|---|
| 专注（running） | 运行中 | 中性底色 + `--success` 呼吸状态点；`data-away-level='0'`，不触发任何告警 |
| 休息 L1（due-soon） | 暂停/结束后，休息达建议时长的 75% | 仅局部：`.away-line` 琥珀描边 + 胶囊轻呼吸 |
| 休息 L2（due） | 达建议休息时长 100% | 温和琥珀洗色扩展到主区+时间轴+顶栏 |
| 逾期 L3（overdue） | 达 150% 或 +2min 宽限 | 红色洗色覆盖全 app，全屏召回卡片 |
| 静默（quiet） | 午饭/午睡/晚饭/夜间窗口 | 继续计时但 `reminderLevel` 归 0，不升级提醒 |

约束：告警只作为背景氛围与边界强调，文字/科目色/片段色/时间 Flag 保持可读；呼吸动画只挂在一个全视口层，避免频率相位分裂；`prefers-reduced-motion` 或应用内关动画时保留静态告警色、停止呼吸。

## 6. 布局骨架与响应式

- `html/body/#root/.app` 统一 `100dvh`，页面级 `overflow: hidden`（参考 Pomotroid）。
- `.app` 三行骨架：固定顶栏 44px / `minmax(0,1fr)` 主时钟 / 可控高度时间轴。
- 高度决定竖向密度，宽度只负责横向容器与换行；token `--main-pad-block`/`--clock-gap`/`--timeline-track-height` 由视口高度派生。
- 验收断点（仅 Pad/Desktop 横屏）：1024×640、1024×768、1180×820、1280×720、1440×900，首屏不产生文档滚动、不遮挡。
- 全屏与窗口模式**共用同一套布局**（用户决策），进入全屏只是视口变大，尺寸由既有 dvh/clamp 自适应，无第二套全屏 UI。

## 7. 动效与无障碍

- 只用 CSS transition + 已有 `motion/react`，不新增 GSAP。
- 状态切换进入/退出各自定义；页面级状态变化只过渡背景/边框/透明度/transform，不用 `transition: all`。
- 全局 `@media (prefers-reduced-motion: reduce)` 与 `html.animations-off` 双兜底，动画时长归零但布局功能不变。
- 计时数字 `font-variant-numeric: tabular-nums` + `font-synthesis: none`，秒变化零布局跳动。

## 8. 参考项目（记录「参考行为 → 本项目取舍」）

| 项目 | 借鉴 | 舍弃 |
|---|---|---|
| Super Productivity（21k★ MIT） | 专注模式固定骨架、状态切换不位移 | 任务系统、Electron 栈 |
| Pomotroid | 页面禁滚动、时钟/标签/控件统一尺度 | 番茄节奏强制 |
| FocusTide | 状态视觉作为全视口独立层 | 任务/设置层耦合 |
| Tomato | 窗口尺寸类别切换布局形态 | Android Compose 栈 |
| Apple HIG / M3 / Refactoring UI | 语义色、圆角档位、8pt 节奏、类型层级 | 直接照搬平台视觉 |

低 Star「Apple 仿作」与未维护模板只作灵感，不作规范来源。
