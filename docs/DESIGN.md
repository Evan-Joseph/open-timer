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
| 语义色 | `--accent`(systemBlue) `--danger`(systemRed) `--success`(systemGreen) `--amber` `--on-accent`(accent 底上的白) | HIG 语义色，浅/深各一套 |
| 边框/阴影 | `--border` `--shadow` `--shadow-sm` `--shadow-up` `--shadow-hover` `--shadow-knob` | 分层阴影，向上用 `--shadow-up`，悬停抬升用 `--shadow-hover`，分段控件滑块用 `--shadow-knob` |
| 材质 | `--material`(顶栏/浮层 0.72) `--popover-surface`(弹层 0.96) `--overlay-scrim`(遮罩 0.44) | backdrop-filter 只用于顶栏与浮层 |
| 圆角 | `--radius-xs`3（微图形：时间轴片段/信标旗） `--radius-sm`6 `--radius`10 `--radius-lg`12 `--radius-xl`14；胶囊 999px | 控件 ≤ 卡片 ≤ 浮层 |
| 间距 | `--space-1..7` = 4/8/12/16/24/32/48 | 4pt 底、8pt 节奏；gap/padding/margin 一律取此组（分段控件内 2px 微间距除外） |
| 字级 | `--fs-xs..3xl` = 11/12/13/14/15/17/22/28；`--fs-mini`10 | 大数字不用此表，用 dvh clamp；10px 是注记字号下限，禁止更小 |
| 动效 | `--ease-standard`(0.2,0,0,1) `--ease-expo`(0.16,1,0.3,1)；`--dur-press`0.1 `--dur-hover`0.15 `--dur-enter`0.25 `--dur-state`0.28 `--dur-shake`0.4 `--dur-wash`0.5 `--dur-glide`0.9(linear) `--dur-pulse`1.2 `--dur-breathe`2.4 `--dur-breathe-slow`2.8 `--dur-breathe-pill`3.2 | 全部过渡取此组；振荡呼吸动画用 ease-in-out（频率下限 2.4s，WCAG 2.3.1）；`--dur-wash`+`--ease-expo` 专属全视口洗色；`--dur-glide` 专属信标匀速漂移 |

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
| 分段控件 | `.seg-control`（默认，项高 32）/ `.timeline-scale`（工具栏紧凑，项高 26 → 容器 32） | 与同行控件等高 | 设置内单选、时间轴尺度 |

规范：禁用统一 opacity 0.4；focus-visible 统一 2px accent 环；press 统一 scale；图标按钮必须有 `aria-label` 与 `title`；文字圆角胶囊不替代熟悉图标。

**按钮权重规则**（2026-08-21，调研 HIG/Super Productivity/FocusTide/Pomotroid 后沉淀）：
- 一个 action-row 至多一个填充（primary）按钮；primary 权重 = 使用频率高 × 破坏性低。
- 破坏性/少数恢复类动作永不为 primary（撤回、误触恢复常规场景一律 ghost）。
- 例外：结束反馈卡检测到 <10s 短会话时提示「是误触吗？」，此时「继续这段」临时提为 primary——这是它唯一配得上强调的场景（参照 Clockify 阈值思路）。
- 查看型弹层（时间轴详情）以浏览为主、动作皆低频编辑：全部 ghost，不设备注 Save 按钮——备注 Enter/失焦自动保存（参照 Super Productivity inline-markdown 模式）。
- 主控制（暂停/继续/结束）为 56px 圆形，播放/暂停是最高权重；结束为同尺寸 danger 色图标。

**工具栏契约**（2026-08-20，参考 HIG toolbars / Radix SegmentedControl 单一 size 下发）：同一工具栏行只允许一个高度档（时间轴工具栏 = 32px 行），行内控件 `align-items: center`、间距统一 `--space-2`（8px），中心 Y 共线（E2E 断言 ±1px）。

**动作行契约**：弹层/卡片内的动作行（`.action-row`：结束反馈、时间轴详情）按钮等高 44px，层级用填充/颜色区分而非尺寸差，间距 `--space-3`。

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
| 逾期 L3（overdue） | 达 150% 或 +2min 宽限 | 红色洗色覆盖全 app（统一氛围表达，无阻断弹窗） |
| 静默（quiet） | 午饭/午睡/晚饭/夜间窗口 | 继续计时但 `reminderLevel` 归 0，不升级提醒 |

三态参数（2026-08-20 调研校准，来源见交接手册参考资料）：
- 洗色过渡：全视口色彩变化用 `--dur-wash` 0.5s + `--ease-expo`（FocusTide 背景层参数），比组件级过渡慢，避免闪变。
- L2 呼吸 3.2s / L3 呼吸 2.6s，opacity 0.75↔1（原 1.8s / 0.58↔1 过快过深，是焦虑感主源；WCAG 2.3.1 闪烁约束 + Super Productivity 呼吸基准）。
- 深色主题 L3 洗色 mix 比例 12%（浅 15%）：深色下红感知更刺眼（FocusTide dark 降饱和思路）。
- 逾期不使用阻断式全屏召回弹窗（2026-08-21 移除）：红色洗色 + away-line 文案已足够表达，恢复/开始下一段入口在常规控件（继续计时 / 空闲页开始）。避免打断式弹窗干扰沉浸。
- 洗色只做 opacity 呼吸，不做 transform scale（大面缩放 = 整屏重绘 + 晃屏）。

约束：告警只作为背景氛围与边界强调，文字/科目色/片段色/时间 Flag 保持可读；呼吸动画只挂在一个全视口层，避免频率相位分裂；`prefers-reduced-motion` 或应用内关动画时保留静态告警色（wash 层 `animation: none`，全量终态）、停止呼吸。

**动效与交互升级（2026-08-24，2026-08-25 收敛）**：在"不阻断"前提下补事件感——① 提醒级别**上升瞬间**一次性触发 away-line 敲击（0.4s）+ 全视口内缘闪光（L2 琥珀 / L3 红，0.9s）；② 召回仍只由洗色、敲击、升级音和既有开始/继续入口承担（重复的「回到专注」绿色按钮已移除）；③ 状态转换一次性 fx：开始点火（内缘光环 0.5s）/ 暂停帷幕（0.5s）/ 继续回升（0.5s）/ 结束卡标准 expo 入场 + 光晕绽放；④ 微交互：选科弹跳、海螺 hover 轻摆。所有循环 ≥2.4s、一次性 ≤0.9s，reduced-motion/关动画全量降级。详见 `docs/动效与交互升级-设计-2026-08-24.md`。

## 6. 布局骨架与响应式

- `html/body/#root/.app` 统一 `100dvh`，页面级 `overflow: hidden`（参考 Pomotroid）。
- `.app` 三行骨架：固定顶栏 44px / `minmax(0,1fr)` 主时钟 / 可控高度时间轴。
- 高度决定竖向密度，宽度只负责横向容器与换行；token `--main-pad-block`/`--clock-gap`/`--timeline-track-height` 由视口高度派生。
- 验收断点（仅 Pad/Desktop 横屏）：1024×640、1024×768、1180×820、1280×720、1440×900，首屏不产生文档滚动、不遮挡。
- 全屏与窗口模式**共用同一套布局**（用户决策），进入全屏只是视口变大，尺寸由既有 dvh/clamp 自适应，无第二套全屏 UI。
- **近 7 天执行回顾是居中浮层**（drill-down 模态，2026-08-21 重构）：盖在主界面之上、时钟保持全尺寸不被挤压。参数参照 shadcn/Radix Dialog 与本项目设置弹窗——面板 `min(960px, 100vw-64px)`、`max-height: 100dvh-64px` 内滚兜底、遮罩 `--overlay-scrim`、材质 `--popover-surface`、250ms 入场；关闭三通道：Esc / 点遮罩 / 右上角 X。**不再**用 `.app:has()` 压缩主时钟把周图塞进同一屏（单屏竖向零和，会挤压主角并留白）。
- 时间轴工具栏按语义分为“视图 / 日期浏览 / 回顾与建议”三组，组内 `--space-2`、组间用细分隔；窄屏保留同一顺序但收至 `--space-1`，避免不可见的微量横向溢出。会话详情/预览在 ≤560px 时固定在 12px 安全边距内，禁止依据被撑宽的时间轴容器越出视口。
- 宽屏近 7 天报告：有科目数据时使用“汇总指标 + 科目分布”双栏，全天泳道独占下行；无科目数据时指标占满宽度；窄屏自然回落单栏。设置中简单二值/三值偏好使用标签-控件同行，连续/说明型项维持全宽纵向。

## 7. 动效与无障碍

- 只用 CSS transition + 已有 `motion/react`，不新增 GSAP。
- 状态切换进入/退出各自定义；页面级状态变化只过渡背景/边框/透明度/transform，不用 `transition: all`。
- 全局 `@media (prefers-reduced-motion: reduce)` 与 `html.animations-off` 双兜底：停掉动画与过渡、保留静态终态和布局功能，避免 0.01ms 动画闪回起始帧。
- 计时数字 `font-variant-numeric: tabular-nums` + `font-synthesis: none`，秒变化零布局跳动。

## 8. 多端同步与误触（2026-08-21）

**UI 偏好同步**（服务端 `user_pref` 单行 JSON，`GET/PUT /api/v1/prefs`，owner-only）：
- localStorage 即时层 + 服务端事实层；last-write-wins；登录态 15s 轮询拉取偏好、空闲 30s / 运行中 3s 轮询状态、本地变更 500ms 防抖推送；在途窗口 3s 内拉取不得回滚本地变更（防竞态）。轮询间隔依据：Workers 免费档 100,000 请求/天是紧约束（单设备约 3.5 万请求/天，三设备内安全）；304 只省 D1 读、不省请求数，故不用作优化手段。
- 同步键：theme / animations / finishSound / ambientKind / timelineScale / timelineMode / selectedSubject（空闲页选中科目）。
- local-only 明确排除：ambientVolume（设备响度差异，默认 0）、全屏态、reduced-motion 派生态、输入草稿、clock-last-subject、historyOpen / conchOpen（浮层开合会触发本地读/LLM 请求，2026-08-24 起不跨端同步）。
- 参照 Super Productivity sync/local-only-keys 与 Pomotroid 后端持久化范式。

**时钟同步正确姿势**（2026-08-22 联网核验背书：本实现 = Cristian 中点锚定算法，与微软 Live Share SDK 同构）：
- 服务端权威 `server_now_ms` + RTT 半程锚定 + `performance.now` 单调外推 + 1.2s 迟滞（≈chrony makestep 阈值）+ 滞后响应丢弃。
- 弱网防护：维护最近 8 次 RTT 窗口，样本 RTT > max(1000ms, 3×中位数) 时不用于重锚（防 ±RTT/2 锚点污染）。
- 不引入多采样/Marzullo/HLC/钟漂率补偿：单权威源 + 秒级显示精度下均为过度工程（误差预算被 RTT/2 ≪ 1s 显示量子占据）。

**轮询间隔与资源**（依据 Cloudflare 免费档：Workers 100,000 请求/天、D1 5,000,000 行读/天）：
- 状态：运行中 3s / 空闲 30s；偏好：15s；单设备 ≈2 万请求/天，三设备内安全。
- 例外：结束卡“等待补备注”是短暂跨端协作态，展示期间仅该客户端每 2s 刷新状态与会话；另一端保存 end_note / 撤回后立即收卡回主页，常态轮询预算不变。

**结束反馈指标（2026-08-26）**：
- 「已记录本次投入」不再只报今日累计；主指标为**本次总专注**（该会话全部计入段之和），副指标为**最长连续专注**（单个计入段的最大值）。这是记录长期专注训练的事实指标，不设“3 小时达标”等暗示性目标。
- 依据：Biwer 等《British Journal of Educational Psychology》(2023, PMID 36859717) 的在线自学干预发现，系统性休息相比自定休息可降低疲劳/分心、改善情绪和效率；长时训练应观察连续能力同时保留休息，而非把不间断越久视作越好。
- 两指标由服务端 `/sessions` / stop 响应统一提供，发起结束端与跨端水合端读取同一会话事实；不得用北京日裁剪的 `active_seconds` 代替。
- `sessionsOverlapping` 必须走 `session_ended(ended_at_ms)` 索引（「窗口起点后结束 ∪ 仍开放」改写）——全表扫描会在约 250 个历史会话时撞穿 D1 行读日额度导致应用整体不可用。

**误触过滤**：短于 `CLOCK_MIN_SEGMENT_SECONDS`（默认 10s）的已关闭片段不计入 sessions/daily-summary/state（开放段不受影响）。领域规则 `isCountedSegment` 在 shared，服务端配置注入。参照 Clockify「可配置阈值丢弃」；不做静默删除会话（事件链完整保留），不做自动合并（无业界先例）。

**空格键主控**：Space = 开始（空闲）/暂停（运行）/继续（暂停）/确认关闭（结束反馈卡）；输入框、弹层打开、修饰键组合时让位。参照 FocusTide/Pomotroid 共识。

## 9. 参考项目（记录「参考行为 → 本项目取舍」）

| 项目 | 借鉴 | 舍弃 |
|---|---|---|
| Super Productivity（21k★ MIT） | 专注模式固定骨架、状态切换不位移 | 任务系统、Electron 栈 |
| Pomotroid | 页面禁滚动、时钟/标签/控件统一尺度 | 番茄节奏强制 |
| FocusTide | 状态视觉作为全视口独立层 | 任务/设置层耦合 |
| Tomato | 窗口尺寸类别切换布局形态 | Android Compose 栈 |
| Apple HIG / M3 / Refactoring UI | 语义色、圆角档位、8pt 节奏、类型层级 | 直接照搬平台视觉 |

低 Star「Apple 仿作」与未维护模板只作灵感，不作规范来源。
