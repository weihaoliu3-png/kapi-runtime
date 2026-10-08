# Kapi运行器

桌宠的桌面程序（Mac / Windows）。加载 `capafy-deskpet` skill 产出的宠物包（`.petpack`），负责透明窗口、穿透、拖拽、8 朝向跟随、眨眼、关键帧动画、气泡、对话、提醒、托盘。规格以 skill 里的 `references/runtime-contract.md` 和 `pet-package-contract.md` 为准。

技术：Tauri 2 + 原生 JS（`src/engine.js` 纯逻辑、`src/main.js` 平台胶水）+ 极少 Rust（`src-tauri/src/lib.rs`：列宠物、读写文本、解压/打包 .petpack、托盘）。

## 怎么编译（第一次约 10 分钟）

需要：Node 20+、Rust stable（rustup）、Tauri 2 的系统依赖（Mac：Xcode 命令行工具；Windows：VS Build Tools + WebView2，通常已装）。

```bash
npm install
npm run icon          # 从 src-tauri/icons/app-icon.png 生成全部图标
node test/engine.test.mjs   # 引擎逻辑单测（无 GUI）
npm run dev           # 开发运行
npm run build         # 产出 src-tauri/target/release/bundle/…
```

或者直接推一个 tag（`v0.2.0`）到 GitHub，`.github/workflows/build.yml` 会在 Mac / Windows 机器上各编一份，产物 `Kapi-mac.zip`、`Kapi-win.zip` 在 Actions 的 Artifacts 里下载，**原样放进 skill 的 `assets/runtime/`**，并把版本号写进 `assets/runtime/VERSION`。

不签名（已定案）：Mac 首次打开要在"系统设置 → 隐私与安全性"里点"仍要打开"；Windows 会弹 SmartScreen。skill 的交付话术里已写清楚。

## v0.3 新增

- 养成系统 `src/care.js`：饱食/水分/精力/心情、喂食/喝水/抚摸/睡觉、每日经验、等级、服装券、成长阶段体型；状态存宠物目录 `state.json`。面板：右键「照顾」或悬停左上角 🐾。
- 表情帧：`layers.expressions` 六种（happy / sleepy / angry / sad / surprised / shy）：点击 happy、连点 angry、抚摸 shy→happy、甩动 surprised→落地 angry、久未互动后点击 surprised、心情低 sad、困/睡 sleepy、聊天回复可带 `[expr:x]`。
- 抚摸手势：在头部区域水平来回 ≥3 次。
- 朝向切换迟滞（死区 ±25%、扇区边界 8°）+ holdMs 400 + crossfade 180，消除交界处抖动。
- 首次启动操作提示气泡。
- 原图不再上屏：宠物包 `layers.base` 必须是生成帧。

## v0.7 声音（`src/voice.js`）

一只宠物只有一种声音，由 `pet.json.voice.kind` 决定，不混用：
- `tts`：播放 `voice/` 里 skill 预录（已变调）的 mp3；没有录音的台词（聊天回复）只显示气泡，不出声。
- `babble`：所有台词由运行器用 WebAudio 合成动森式咿呀声——按字数出音节（中文一字一音节、英文约三字母一音节）、问号尾音上扬、感叹号更短更响、同一句话永远同一段声音；`preset` 定基频（soft 330 / bright 440 / low 240 Hz）。零文件、零网络。
- `none`：不出声。
系统 TTS（speechSynthesis）已移除：每台电脑声音不同，而且会和录音混成两种声音。老包没有 `kind`：有 `voice/index.json` 按 tts，否则按 babble。

## v0.6.1 修复

- 「坐到窗口上」在 Windows 上没反应：原因有二——右键菜单弹出时 Kapi 自己是前台窗口被过滤掉；最大化窗口顶边 y≈0，目标位置 = 顶边 − 身高 为负，宠物被移到屏幕外。现在记住最近的其他窗口、贴顶时坐进窗口内侧、目标钳制在屏幕内，并在坐着时强制置顶。

## v0.4 新增（桌面互动，`src/behaviors.js`）

| 行为 | 触发 | 实现 |
|---|---|---|
| 扔出去 | 拖拽时松手速度 > 350px/s | 抛物线 + 重力 + 地面/侧边反弹，飞行中惊讶表情 + 按速度倾斜，落地播 drop + 生气 + 台词 |
| 扒住屏幕边 | 拖到 35% 以上出屏后松手 | 惊讶 + "扒住了"，4 秒后自己爬回来 |
| 躲起来 / 探头 | 右键「躲起来」 | 滑到最近的屏幕边只露 28%，点一下回来 |
| 过来 | 右键「过来」 | 走到光标处，走路时上下颠、朝向翻转（有 walk 帧就用帧） |
| 随机溜达 | 待机 3–7 分钟随机 | 左右走 80–240px |
| 坐到窗口上 | 右键「坐到窗口上」（开关） | 每秒记住**最近一个非 Kapi 的前台窗口**（右键时 Kapi 自己就是前台，所以不能用当下的），脚踩在窗口顶边靠右；最大化 / 贴顶的窗口改坐进右上角内侧，永不出屏；坐着期间强制置顶，取消后恢复用户设置；3 秒没找到窗口提示「点一下你想让我坐的窗口」（v0.6.1） |
| 打字反应 | 全局键盘活动（`device_query` 轮询，无钩子） | 每秒 ≥3 键时小幅点头；连续 400 键提醒休息 |
| 长时间没操作趴下 | 全局键鼠都没动 N 分钟（`afterIdleMin`，默认 15，可改 30） | 已有 |
| 电量低 | 每分钟查电池（`battery` crate） | ≤20% 且未充电：惊讶 + 置顶气泡，15 分钟一次 |
| 两只打招呼 | 右键「叫另一只出来」→ 第二个窗口；两只横向重叠 | 各自广播位置，重叠时开心 + "嗨，{name}" + 挥手，5 分钟一次 |

Mac 上 `device_query` 读键盘可能需要"输入监控"权限；没授权时打字反应静默失效，其他不受影响。

## v0.4 养成补充：服装券与衣柜

- 升级发券（Lv.3/5/7 服装券，Lv.9 节日券），带随机编号存 `state.json.ticketLog`；面板显示称号（每级一个）与券数。
- 衣服只能凭券换：用户导出宠物包给助手 → 助手验券、生图、核销 → 新包导入时**只合并券账本**，实时数值保留本地。
- 衣柜：`pet.json.outfits.items`，右键「衣柜」切换，选择存 `state.json.outfit`。

## 运行时行为一览

- 启动扫描：可执行文件旁的 `pets/`（首次交付包布局）、`.app` 旁的 `pets/`、应用数据目录 `pets/`；同 id 取高版本。
- 导入：把 `.petpack` 拖到宠物身上 / 托盘"导入" / 右键"导入宠物包"。导出：右键或托盘"导出当前宠物包"（用户拿它回 Capafy 继续教）。
- 穿透：每 33ms 轮询全局光标，落在宠物不透明像素或气泡上才接收鼠标，其余穿透（`setIgnoreCursorEvents`）。
- 拖拽：按住 4px 以上算拖，窗口跟着光标走，速度喂给 `sway`；松手播 `drop`，并弹回屏幕内。
- 朝向：光标相对"头部点"（宠物顶部下方 25%）的角度 → 最近的 45° 帧；死区回 base；`holdMs` 防抖；`crossfadeMs` 淡化。
- 动作：`sequence` × `fps` 走关键帧，`tweenMs` 交叉淡化；`holdLast` + `wake`；优先级 drag > 用户 > 聊天 > 睡觉 > 随机 > idle。
- 眨眼：3–7s 随机换 `blink.png` 100ms。
- 对话：双击宠物出输入框；发进已连接的 Capafy 对话实例（见下节）；回复里的 `[action:id]` / `[expr:id]` 会被播放。系统语音朗读（可静音）。
- 提醒：`persona.reminders`，15s 检查一次，气泡需点击关闭。
- 设置：托盘"设置…"（连接 Capafy 对话 / 大小）；缩放也在右键菜单。

## 已知取舍（v0.2）

- Mac 全屏 App 之上显示：目前用 `visibleOnAllWorkspaces`，在别的 App 全屏时不会浮在其上；要的话下一版接 `tauri-nspanel`（BongoCat 的做法）。
- Windows 置顶偶尔被其他置顶窗口盖住：下一版加 `SetWindowPos(HWND_TOPMOST)` 定时重申。
- 系统级"无操作"用的是光标是否移动，不是真正的系统空闲时间。
- 没有像素级"摸头手势"、自主走动、多宠互动（见 skill 的 growth-menu.md ◇ 项）。

## 聊天：复用当前 Capafy 对话实例（v0.5，按《桌宠对话连接方案》）

- 设置页：用户粘贴本对话完整网址 + Capafy Token → `GET /agent/account` 验 Token → `GET /agent/instance?status=active` → 网址候选 ID 与 `instances[].instanceId` 精确比对；不匹配则列出实例让用户选。连接测试不发消息。
- Token 只存系统凭据库（`keyring`：macOS Keychain / Windows Credential Manager），不进 settings.json、宠物包、日志。「断开连接」同时删凭据和 instanceId。
- 发送：`POST https://api.capafy.ai/agent/relay/instances/{id}/messages`，content = `[petchat]\n用户消息：…\n本地时间…\n桌宠上一动作…\n可用动作…\n可用表情…`；SSE 按 seq 合并，`done` 结束，`timeout` 提示；同一实例同时只一个请求，其余排队。
- 错误：401 重填 Token / 404 没找到对话 / 409 "我还在想上一句" / 429 退避 / 额度类业务错误提示续费 / 其他 "还没连上"。
- 只允许固定域名 `api.capafy.ai`，不从粘贴的网址继承主机。
