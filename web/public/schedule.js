(function() {
  "use strict";

  const SCHEDULE = [
    {
      id: "morning_start",
      name: "早间起跑",
      tag: "唤醒与就绪",
      category: "prep",
      color: "#f59e0b",
      colorSoft: "rgba(245, 158, 11, 0.12)",
      start: "07:30",
      end: "08:20",
      durationMinutes: 50,
      summary: "洗漱更衣、营养早餐与自习室环境就绪，平稳进入学习状态",
      scienceNote: "晨光照射有效抑制褪黑素分泌，温水与咀嚼激活自主神经系统与脑供血",
      substeps: [
        { start: "07:30", end: "07:55", duration: 25, title: "醒晨洗漱与早餐", detail: "起居、洗漱、温水一杯，摄入富含优质蛋白与复合碳水的早餐为大脑皮层供能" },
        { start: "07:55", end: "08:05", duration: 10, title: "通勤自习室", detail: "步行至自习室，自然光照加速皮质醇上升，促进下肢血液回流与清醒" },
        { start: "08:05", end: "08:20", duration: 15, title: "桌面就绪与计划核对", detail: "接水、铺开教材与草稿纸、确认今日总控计划与核心任务，心流准备" }
      ]
    },
    {
      id: "morning_focus",
      name: "上午攻坚专注",
      tag: "皮质醇峰值攻坚",
      category: "focus",
      color: "#0071e3",
      colorSoft: "rgba(0, 113, 227, 0.12)",
      start: "08:20",
      end: "11:20",
      durationMinutes: 180,
      summary: "全天逻辑推理与计算峰值期，专用于高强度数学二闭卷作答与推导",
      scienceNote: "晨间 8–11 点前额叶皮层执行功能（Executive Function）处于生理峰值，最适合深度数学思维",
      substeps: [
        { start: "08:20", end: "09:50", duration: 90, title: "数学攻坚第一段 (90m)", detail: "张宇《基础30讲》重点例题深度推导或高难新题型闭卷独立作答" },
        { start: "09:50", end: "10:00", duration: 10, title: "间歇调息 (10m)", detail: "站立远眺、眼部放松、深呼吸与补水，严禁刷短视频避免注意力碎片残留" },
        { start: "10:00", end: "11:20", duration: 80, title: "课后题闭卷独立作答 (80m)", detail: "连续高质量严谨推导计算，记录卡点与疑难，准备后续小批批阅" }
      ]
    },
    {
      id: "lunch_rush",
      name: "午餐时段（错峰抢饭）",
      tag: "错峰避堵 · 细嚼慢咽",
      category: "meal",
      color: "#10b981",
      colorSoft: "rgba(16, 185, 129, 0.12)",
      start: "11:20",
      end: "12:15",
      durationMinutes: 55,
      summary: "提早 25 分钟错开下课大潮，享受从容午餐与消化平稳",
      scienceNote: "细嚼慢咽促进胆囊收缩素(CCK)分泌增强饱腹感，平抑餐后血糖暴冲，大幅减轻食后困倦(Food Coma)",
      substeps: [
        { start: "11:20", end: "11:25", duration: 5, title: "自习室收尾出发", detail: "收存草稿与当前笔记，收拾随身物品离室，抢先出发" },
        { start: "11:25", end: "11:30", duration: 5, title: "抵食堂与选菜", detail: "比 11:50 下课大潮提前 25 分钟，窗口零排队，自由挑选营养合口菜品" },
        { start: "11:30", end: "12:10", duration: 40, title: "细嚼慢咽享用午餐", detail: "充分咀嚼、从容用餐，保持静心进食节奏，杜绝囫囵吞枣伤胃" },
        { start: "12:10", end: "12:15", duration: 5, title: "整理餐盘离场", detail: "收拾餐盘离场，此时正逢 11:50 下课大部队刚涌入食堂，完美反向错峰" }
      ]
    },
    {
      id: "noon_nap",
      name: "午休与醒脑",
      tag: "黄金小睡 · 神经充电",
      category: "rest",
      color: "#af52de",
      colorSoft: "rgba(175, 82, 222, 0.12)",
      start: "12:15",
      end: "13:40",
      durationMinutes: 85,
      summary: "散步促消化 + 30 分钟纯浅睡 + 醒盹通勤，彻底重置认知敏锐度",
      scienceNote: "限制纯睡 20–30 分钟（NREM2），严防进入慢波深睡眠（SWS）产生昏睡 30 分钟的严重睡眠惯性",
      substeps: [
        { start: "12:15", end: "12:25", duration: 10, title: "食堂散步回宿舍", detail: "饭后慢步 10 分钟促进胃排空与动力学消化，严禁饱腹立刻平卧导致胃食管反流" },
        { start: "12:25", end: "12:35", duration: 10, title: "睡前准备与避光", detail: "漱口洗手、调暗遮光帘、戴好眼罩耳塞，营建静谧暗光微睡眠环境" },
        { start: "12:35", end: "13:15", duration: 40, title: "床上静卧午睡 (40m)", detail: "约 10 分钟入睡潜伏 + 30 分钟黄金浅睡，迅速清空神经元腺苷蓄积" },
        { start: "13:15", end: "13:30", duration: 15, title: "闹钟唤醒与洗漱醒脑", detail: "闹钟轻柔响起，冷水洗脸、饮温水一杯，彻底驱散暂态浅层睡眠惯性" },
        { start: "13:30", end: "13:40", duration: 10, title: "散步走回自习室", detail: "户外自然日光照射迅速抑制褪黑素，步行骨骼肌运动激活下午中枢神经系统" }
      ]
    },
    {
      id: "afternoon_focus",
      name: "下午攻坚专注",
      tag: "408 核心架构攻坚",
      category: "focus",
      color: "#5856d6",
      colorSoft: "rgba(88, 86, 214, 0.12)",
      start: "13:40",
      end: "17:15",
      durationMinutes: 215,
      summary: "午后精力完全恢复，专注于 408 专业课大块算法、指令通路与真题体系",
      scienceNote: "人体深部体温午后二次升高，长程工作记忆与复杂抽象架构理解力回升至高点",
      substeps: [
        { start: "13:40", end: "15:20", duration: 100, title: "408 攻坚第一段 (100m)", detail: "数据结构算法推演或计算机组成原理数据通路大题攻坚，弄透底层机制" },
        { start: "15:20", end: "15:35", duration: 15, title: "下午茶歇与拉伸 (15m)", detail: "离座走动、颈椎腰部放松拉伸、补充水分与适量微量元素坚果" },
        { start: "15:35", end: "17:15", duration: 100, title: "408 攻坚第二段 (100m)", detail: "课后收尾卷或专项练习规范作答，整理错因卡点与解题逻辑链条" }
      ]
    },
    {
      id: "dinner_rush",
      name: "晚餐时段（错峰就餐）",
      tag: "错峰就餐 · 餐后降糖",
      category: "meal",
      color: "#10b981",
      colorSoft: "rgba(16, 185, 129, 0.12)",
      start: "17:15",
      end: "18:25",
      durationMinutes: 70,
      summary: "提前 20 分钟避开晚课下课客流，舒缓就餐后散步回到晚自习",
      scienceNote: "饭后 10–15 分钟轻步走可促进骨骼肌摄取葡萄糖，显著削平餐后血糖波峰，消除晚自习昏睡感",
      substeps: [
        { start: "17:15", end: "17:25", duration: 10, title: "自习室收拾出发去食堂", detail: "收整下午材料，步行至食堂，此时窗口空旷从容" },
        { start: "17:25", end: "17:30", duration: 5, title: "打饭落座（避开17:50高峰）", detail: "轻松选餐、无需排队，17:30 前准时坐定开饭" },
        { start: "17:30", end: "18:15", duration: 45, title: "细嚼慢咽晚餐 (45m)", detail: "慢嚼细咽享用晚餐，摄入适量蔬菜与复合碳水，身心放松" },
        { start: "18:15", end: "18:25", duration: 10, title: "散步通勤回自习室", detail: "轻快散步回自习室，下肢循环恢复，脑供血充足准备晚间复习" }
      ]
    },
    {
      id: "evening_focus",
      name: "晚间巩固与闭环",
      tag: "记忆提取 · 查漏订正",
      category: "focus",
      color: "#06b6d4",
      colorSoft: "rgba(6, 182, 212, 0.12)",
      start: "18:25",
      end: "21:45",
      durationMinutes: 200,
      summary: "日间内容全面复盘、数学闪卡间隔提取、批阅答疑与 study-ledger 闭环",
      scienceNote: "睡前 2–4 小时进行主动提取练习（Active Recall）与错误再巩固，夜间睡眠将优先强化这批神经突触连接",
      substeps: [
        { start: "18:25", end: "20:00", duration: 95, title: "晚间第一段：知识提取与闪卡", detail: "数学公式识记闪卡、408 核心概念闭卷提取与今日重点笔记回顾" },
        { start: "20:00", end: "20:10", duration: 10, title: "调息起立活动 (10m)", detail: "洗手间洗手、接水、深呼吸，适度拉伸肩膀" },
        { start: "20:10", end: "21:45", duration: 95, title: "批阅订正与证据收口", detail: "对齐答卷批阅反馈、就地弄懂错题、同步 study-ledger 学习证据，学到 21:45 准时停钟" }
      ]
    },
    {
      id: "bath_routine",
      name: "晚间收尾与洗澡（浴室关门硬约束）",
      tag: "浴室 22:30 关门 · 充裕洗浴",
      category: "winddown",
      color: "#ec4899",
      colorSoft: "rgba(236, 72, 153, 0.12)",
      start: "21:45",
      end: "22:30",
      durationMinutes: 45,
      summary: "严格倒推：21:45 撤出自习室，22:00 进浴室，22:20 出浴室，留足 10 分钟关门缓冲",
      scienceNote: "睡前 1–2 小时温水浴（40–42.5℃）促进肢端微血管扩张散热，诱导核心体温平稳下降，大幅缩短入睡潜伏期",
      substeps: [
        { start: "21:45", end: "21:50", duration: 5, title: "自习室收尾离开", detail: "保存进度、背好书包，准时离开自习室，不恋战、不拖延" },
        { start: "21:50", end: "22:00", duration: 10, title: "走回宿舍与取物准备", detail: "回寝室换衣服、拿好洗漱包、浴巾与换洗衣物走向浴室" },
        { start: "22:00", end: "22:20", duration: 20, title: "舒适温水洗浴 (20m)", detail: "从容洗澡、冲走疲惫，温水浴激活副交感神经，启动体温散热开关" },
        { start: "22:20", end: "22:30", duration: 10, title: "出浴室回寝（提前10m关门缓冲）", detail: "22:20 穿戴整齐从容走出浴室回宿舍，距离 22:30 闭馆提前 10 分钟，绝不被催促" }
      ]
    },
    {
      id: "night_winddown",
      name: "夜间整理与复盘",
      tag: "身心松弛 · 离屏准备",
      category: "winddown",
      color: "#8b5cf6",
      colorSoft: "rgba(139, 92, 246, 0.12)",
      start: "22:30",
      end: "23:30",
      durationMinutes: 60,
      summary: "头发吹干护理、查看总控晚间复盘报告、调暗灯光离屏，静待体温达标入睡",
      scienceNote: "褪黑素在黑暗环境下大量分泌；体温自峰值下降约 0.5–1℃，身体迎来最自然的睡意窗口",
      substeps: [
        { start: "22:30", end: "22:50", duration: 20, title: "吹干头发与洗漱护肤", detail: "吹干头发避免着凉、护肤洗袜、整理明日衣物与随身包" },
        { start: "22:50", end: "23:20", duration: 30, title: "总控复盘阅览与日程核验", detail: "阅读总控 22:30 晚间复盘、确认次日最小自然范围与材料就绪，心中有数不焦虑" },
        { start: "23:20", end: "23:30", duration: 10, title: "调暗灯光与上床酝酿", detail: "彻底放下手机与电脑屏幕，上床闭目深呼吸，让肌肉与思维完全平息" }
      ]
    },
    {
      id: "deep_sleep",
      name: "夜间深度睡眠",
      tag: "8 小时黄金修复",
      category: "sleep",
      color: "#3b82f6",
      colorSoft: "rgba(59, 130, 246, 0.12)",
      start: "23:30",
      end: "07:30",
      durationMinutes: 480,
      summary: "整整 8 小时优质夜间睡眠，完整经历 5 个 90 分钟超日节律周期",
      scienceNote: "NREM 慢波睡眠负责脑组织代谢废物清除与体能恢复，REM 睡眠负责高阶神经突触修剪与长程记忆巩固",
      substeps: [
        { start: "23:30", end: "02:30", duration: 180, title: "慢波深度睡眠第一阶段", detail: "前两个睡眠周期主要为 SWS 慢波深睡，脑脊液脉动清洗大脑代谢副产物" },
        { start: "02:30", end: "05:30", duration: 180, title: "快速眼动与记忆重放", detail: "REM 睡眠比例增高，海马体与大脑皮层交互，将白天学习事实编码固化" },
        { start: "05:30", end: "07:30", duration: 120, title: "晨光渐醒与皮质醇回升", detail: "体温与皮质醇自然缓慢回升，为 07:30 精神饱满地醒来做好生理准备" }
      ]
    }
  ];

  function toMinutes(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  }

  function formatDuration(mins) {
    if (mins < 60) return mins + " 分钟";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? h + " 小时" : h + " 小时 " + m + " 分钟";
  }

  function getBeijingDate() {
    const now = new Date();
    // 强制按 UTC+8 计算当前年月日时分秒
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
    return new Date(utcMs + 8 * 3600000);
  }

  // 状态变量
  let simulationMinute = null; // null 表示实时跟随，数值 0..1439 表示时光机模拟
  let lastScrolledId = null;

  // 核心时间解算器
  function resolveStatus(minuteOfDay) {
    // minuteOfDay 归一化到 0..1439
    const m = ((Math.floor(minuteOfDay) % 1440) + 1440) % 1440;

    let currentIndex = -1;
    for (let i = 0; i < SCHEDULE.length; i++) {
      const item = SCHEDULE[i];
      const startM = toMinutes(item.start);
      const endM = toMinutes(item.end);

      if (startM < endM) {
        if (m >= startM && m < endM) {
          currentIndex = i;
          break;
        }
      } else {
        // 跨午夜
        if (m >= startM || m < endM) {
          currentIndex = i;
          break;
        }
      }
    }

    if (currentIndex === -1) currentIndex = 0;
    const current = SCHEDULE[currentIndex];
    const startM = toMinutes(current.start);
    const endM = toMinutes(current.end);
    
    // 计算已过时间与剩余时间
    let elapsed = 0;
    if (startM < endM) {
      elapsed = m - startM;
    } else {
      elapsed = m >= startM ? m - startM : (1440 - startM + m);
    }
    elapsed = Math.max(0, Math.min(elapsed, current.durationMinutes));
    const remaining = Math.max(0, current.durationMinutes - elapsed);
    const progress = Math.min(100, Math.max(0, (elapsed / current.durationMinutes) * 100));

    // 计算当前处于哪个子步骤
    let activeSubstep = null;
    for (let j = 0; j < current.substeps.length; j++) {
      const step = current.substeps[j];
      const sM = toMinutes(step.start);
      const eM = toMinutes(step.end);
      let inStep = false;
      if (sM < eM) {
        inStep = (m >= sM && m < eM);
      } else {
        inStep = (m >= sM || m < eM);
      }
      if (inStep) {
        activeSubstep = step;
        break;
      }
    }
    if (!activeSubstep && current.substeps.length > 0) {
      activeSubstep = current.substeps[0];
    }

    // 下一个大时段
    const nextIndex = (currentIndex + 1) % SCHEDULE.length;
    const nextItem = SCHEDULE[nextIndex];

    return {
      minute: m,
      current,
      currentIndex,
      elapsed,
      remaining,
      progress,
      activeSubstep,
      nextItem
    };
  }

  // 渲染函数
  function render(status, bDate) {
    const root = document.documentElement;

    // 1. 顶栏时钟
    const h = String(bDate.getHours()).padStart(2, "0");
    const min = String(bDate.getMinutes()).padStart(2, "0");
    const s = String(bDate.getSeconds()).padStart(2, "0");
    document.getElementById("nav-clock").textContent = h + ":" + min + ":" + s;

    const days = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    const y = bDate.getFullYear();
    const mo = bDate.getMonth() + 1;
    const d = bDate.getDate();
    document.getElementById("nav-date").textContent = y + "年" + mo + "月" + d + "日 " + days[bDate.getDay()];

    // 2. Hero 状态卡片
    const current = status.current;
    root.style.setProperty("--hero-accent", current.color);
    root.style.setProperty("--hero-soft", current.colorSoft);

    document.getElementById("hero-status-tag").innerHTML = "● 当前进行 · " + current.tag;
    document.getElementById("hero-time-range").textContent = current.start + " – " + current.end + " (" + formatDuration(current.durationMinutes) + ")";
    document.getElementById("hero-title").textContent = current.name;
    document.getElementById("hero-subtitle").textContent = current.summary;

    document.getElementById("hero-elapsed-label").textContent = "已进行 " + status.elapsed + " 分钟 (" + Math.round(status.progress) + "%)";
    document.getElementById("hero-remaining-label").textContent = "剩余 " + status.remaining + " 分钟";
    document.getElementById("hero-progress-fill").style.width = status.progress + "%";

    if (status.activeSubstep) {
      document.getElementById("hero-substep-badge").textContent = "📍 当前微动作";
      document.getElementById("hero-substep-time").textContent = status.activeSubstep.start + " – " + status.activeSubstep.end + " · " + status.activeSubstep.duration + "m";
      document.getElementById("hero-substep-text").textContent = status.activeSubstep.title;
      document.getElementById("hero-substep-detail").textContent = status.activeSubstep.detail;
    }

    document.getElementById("hero-science-note").textContent = current.scienceNote;
    document.getElementById("hero-next-preview").textContent = status.nextItem.start + " " + status.nextItem.name + " (" + status.remaining + " 分钟后启动)";

    // 3. 全天卡片高亮与状态
    const cards = document.querySelectorAll(".time-card");
    cards.forEach(function(card, idx) {
      const item = SCHEDULE[idx];
      card.style.setProperty("--card-color", item.color);
      
      const badge = card.querySelector(".card-status-badge");
      card.classList.remove("active", "past", "pending");

      if (idx === status.currentIndex) {
        card.classList.add("active");
        badge.className = "card-status-badge current";
        badge.innerHTML = "● 进行中 (" + status.remaining + "m 留余)";
      } else if (idx < status.currentIndex) {
        card.classList.add("past");
        badge.className = "card-status-badge done";
        badge.innerHTML = "✓ 已完成";
      } else {
        card.classList.add("pending");
        badge.className = "card-status-badge pending";
        badge.innerHTML = "○ 待执行";
      }

      // 细分动作的高亮
      const subItems = card.querySelectorAll(".substep-item");
      subItems.forEach(function(sEl, sIdx) {
        const sub = item.substeps[sIdx];
        if (idx === status.currentIndex && sub === status.activeSubstep) {
          sEl.classList.add("active");
        } else {
          sEl.classList.remove("active");
        }
      });
    });

    // 自动聚焦居中当前活动卡片
    if (simulationMinute === null && lastScrolledId !== current.id) {
      lastScrolledId = current.id;
      const activeEl = document.getElementById("card-" + current.id);
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  }

  // 周期轮询循环
  function tick() {
    const bDate = getBeijingDate();
    let currentMinute;

    if (simulationMinute !== null) {
      currentMinute = simulationMinute;
      // 模拟状态下把时分覆盖到 bDate 供时钟显示
      bDate.setHours(Math.floor(currentMinute / 60));
      bDate.setMinutes(currentMinute % 60);
      bDate.setSeconds(0);
    } else {
      currentMinute = bDate.getHours() * 60 + bDate.getMinutes();
    }

    const status = resolveStatus(currentMinute);
    render(status, bDate);
  }

  // 构建全天卡片 DOM
  function buildTimelineDOM() {
    const container = document.getElementById("timeline-flow-list");
    container.innerHTML = "";

    SCHEDULE.forEach(function(item, idx) {
      const card = document.createElement("div");
      card.className = "time-card";
      card.id = "card-" + item.id;
      card.style.setProperty("--card-color", item.color);

      var subHtml = "";
      item.substeps.forEach(function(s) {
        subHtml += '<div class="substep-item">'
          + '<span class="substep-time tabular">' + s.start + '–' + s.end + '</span>'
          + '<span class="substep-dur tabular">' + s.duration + 'm</span>'
          + '<div class="substep-body"><strong>' + s.title + '</strong><span>' + s.detail + '</span></div>'
          + '</div>';
      });

      card.innerHTML = '<div class="card-top">'
        + '<div class="card-time-group">'
        + '<span class="card-time-range tabular">' + item.start + ' – ' + item.end + '</span>'
        + '<span class="card-duration-badge tabular">' + formatDuration(item.durationMinutes) + '</span>'
        + '</div>'
        + '<span class="card-status-badge pending">○ 待执行</span>'
        + '</div>'
        + '<div class="card-name-row">'
        + '<div class="card-name"><span class="card-name-dot"></span>' + item.name + '</div>'
        + '</div>'
        + '<p class="card-summary">' + item.summary + '</p>'
        + '<div class="substep-list">' + subHtml + '</div>'
        + '<div class="card-science-pill"><span class="icon">🔬</span><span>' + item.scienceNote + '</span></div>';

      container.appendChild(card);
    });
  }

  // 初始化主题管理
  function initTheme() {
    const themeBtn = document.getElementById("btn-theme");
    const saved = localStorage.getItem("11408_schedule_theme");
    if (saved) {
      document.documentElement.setAttribute("data-theme", saved);
    } else {
      const bDate = getBeijingDate();
      const h = bDate.getHours();
      // 18:30 到次日 07:30 默认深色护眼
      const isNight = h >= 19 || h < 7;
      document.documentElement.setAttribute("data-theme", isNight ? "dark" : "light");
    }

    themeBtn.addEventListener("click", function() {
      const cur = document.documentElement.getAttribute("data-theme") || "light";
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("11408_schedule_theme", next);
      themeBtn.textContent = next === "dark" ? "☀️ 日间" : "🌙 夜间";
    });

    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    themeBtn.textContent = isDark ? "☀️ 日间" : "🌙 夜间";
  }

  // 时光机滑动控制器
  function initScrubber() {
    const slider = document.getElementById("time-scrubber");
    const resetBtn = document.getElementById("scrubber-reset");
    const label = document.getElementById("scrubber-val");

    slider.addEventListener("input", function(e) {
      simulationMinute = parseInt(e.target.value, 10);
      const h = String(Math.floor(simulationMinute / 60)).padStart(2, "0");
      const m = String(simulationMinute % 60).padStart(2, "0");
      label.textContent = h + ":" + m + " (时光机)";
      resetBtn.style.display = "inline-block";
      tick();
    });

    resetBtn.addEventListener("click", function() {
      simulationMinute = null;
      resetBtn.style.display = "none";
      label.textContent = "实时模式 (UTC+8)";
      const bDate = getBeijingDate();
      slider.value = bDate.getHours() * 60 + bDate.getMinutes();
      lastScrolledId = null;
      tick();
    });

    // 初始值同步
    const bDate = getBeijingDate();
    slider.value = bDate.getHours() * 60 + bDate.getMinutes();
  }

  function init() {
    buildTimelineDOM();
    initTheme();
    initScrubber();
    tick();
    setInterval(tick, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
