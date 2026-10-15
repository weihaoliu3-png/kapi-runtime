# Kapi运行器

**接手开发请先读 [`PRODUCT.md`](PRODUCT.md)**（产品定位、整体架构、当前进度、遗留问题、上线清单）。

桌宠的桌面程序（Mac / Windows）。加载 `capafy-deskpet` skill 产出的宠物包（`.petpack`），负责透明窗口、穿透、拖拽、目光跟随、眨眼、动画、气泡、提醒、托盘。规格以 skill 里的 `references/runtime-contract.md` 和 `pet-package-contract.md` 为准。

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

或者直接推一个 tag（`v0.2.0`）到 GitHub，`.github/workflows/build.yml` 会在 Mac / Windows 机器上各编一份，产物 `Kapi-mac.zip`、`Kapi-win.zip` 自动附在同名的 GitHub Release 上（Actions 的 Artifacts 里也有）；手动下载后**原样放进 skill 的 `assets/runtime/`**（不要解开重压），并把版本号写进 `assets/runtime/VERSION`。

不签名（已定案）：Mac 首次打开要在"系统设置 → 隐私与安全性"里点"仍要打开"；Windows 会弹 SmartScreen。skill 的交付话术里已写清楚。

## v0.9.6 修复：抚摸改回"鼠标划过"（真实用户摸不到，P0）、抓光点命中有表情、小本子日记说清是谁写的

基础版上线前的几件事。

- **空状态文案把人引到了一个不存在的文件**（Mac 实机）：完整交付包里宠物是 `pets/<id>/` **文件夹**，根本没有 `.petpack` 文件，而对话框第一句就让用户"选那个 .petpack 文件"，于是用户在文件夹里翻了半天也没找到。现在按两种情况分开写：拿到完整交付包 → 把 Kapi 和 pets 放在一起、双击 Kapi；只拿到单独的 `.petpack` → 托盘导入或双击它。
- **Mac 这一版不交付**（产品决定）：Mac 运行器没通过实机验收（未签名 → App Translocation → 启动了但看不到 pets）。skill 侧 `package_pet.py` / `hatch.py finalize` 对 mac 直接报错（内部测试 `KAPI_ALLOW_MAC=1`），对用户只说"Mac 版还在测试"。运行器代码本身仍然两个平台都编译，恢复时只需放回 `Kapi-mac.zip` + 改回 skill 话术。

- **抚摸回到"鼠标划过"，彻底去掉"按住摸"（P0，真实用户反馈"抚摸根本摸不到"）**：现象是在桌宠身上按住左键想摸，它直接被拎起来。根因在 0.9.4 的仲裁：抚摸被改成"按住 + 来回划"，和拖拽抢同一个输入流；而 `poll()` 每 33 ms 还要等 3 个 IPC 往返（`scaleFactor` / `cursorPosition` / `outerPosition`），实际采样率远低于 30 Hz，按下后**第一个**采样点往往已经离原点 > 10 px，`main.js` 的 `horizontal ? > 48 : > 10` 当场判成拖拽、`strokeTracker.end()` 清掉本轮——抚摸永远走不到第 3 次折返。这个仲裁在沙盒里无法真机验证（见 `PRODUCT.md` C3），所以不修它，而是**回到 0.9.3 之前的方案：抚摸不用任何按键**。
  - 采样点来自 `poll()` 的命中测试分支（它已经算好了 `overPet` 和窗口内坐标 `lx`）：没有按下鼠标、没按 Ctrl、没睡着时，光标第一次落到不透明像素上就 `StrokeTracker.press(lx, t)` 开一轮，之后每个采样点喂 `move(lx, t, overPet, false)`。`over` 传真实值（不是常量 `true`）：离开不透明像素后的 1.2 秒（`graceSec`）内仍算同一轮，所以一次折返擦过透明边角不会清零。
  - 一轮结束的 6 个原因，各记一行 `stroke-end <reason>`：`away`（离开桌宠超过 1.2 秒）、`press`（按下鼠标）、`ctrl`（按下 Ctrl，鞭子要用光标）、`sleep`（睡着了）、`game`（抓光点开局——追光点时光标正好在它身上来回扫，和抚摸的手势一模一样，不隔开会"玩一局顺手领一堆爱心和养成"，还会和 1.2 的命中表情抢脸）、`hidden`（窗口隐藏，没有采样点了）、以及拖拽（`press` 已经覆盖）。
  - **按键现在只有一个意思：拎起来**。拖拽分支里"按住抚摸"的全部代码删掉（`strokeTracker.move` 调用、`stroking` / `becomesDrag` 特判、48 px / 70 px / 140 px 三个阈值），阈值回到 0.9.3 那个简单可靠的版本：按下后 `Math.hypot(ddx, ddy) > 10` 即进入拖拽。短按抬起（< 400 ms 且没进入拖拽）仍是点击，逻辑没动。`mousedown` 调 `endStroke('press')`。
  - 三档不变：3 / 10 / 15 次有效折返 → 害羞 / shy→happy / 爱心 + `pet` 养成事件，`minTravel` 20 画布像素（手抖、高 DPI 抖动不计），每档一轮只触发一次，爱心后本轮锁定，`strokeTier()` 一行没改；两分钟 `pet` 养成冷却照旧（冷却中第 15 次只给视觉爱心）。
  - **诊断日志**（`kapi-debug.log`）：`stroke-start`、`stroke-tier <light|medium|heart> count=<n>`、`stroke-end <reason> count=<n>`、`drag-start`、`click`。用户一分钟就能自测："划几下有没有 `stroke-start` / `stroke-tier`""按住拖是不是只有 `drag-start`"。两处节流（和 0.9.4 的 `idle-skipped` 一个道理，`appendLog` 每行都要重写整个 120 行文件）：`stroke-start` 最多每 2 秒一条；一次折返都没数到的"路过"不记 `stroke-end`。
- **抓光点命中要有表情反馈**：以前 `catchHit` 只加分 + 播 pounce / jump + 音效，脸上什么都没有，用户反馈"点中了也不知道点中没"。现在命中后 100 ms 先 `surprised`（450 ms）再 `happy`（900 ms）；连续命中**用新反馈替换旧的**，不排队、不闪烁（只有一个 `catchFaceTimer`，每次命中先 `clearTimeout`）；未命中（点在光点旁边）不触发任何反馈，只记一行 `catch-miss`。一局结束先 `catchFaceCancel()` 丢掉还没跑完的命中反馈，再按结果追加一次最终反馈：达到目标分 `happy`，否则 `sleepy` / `shy` 各半；结算台词和音效不变。每个表情都自带时长，到点自动过期，所以反馈结束就回到游戏前的脸。日志：`catch-hit score=<n>`、`catch-miss`、`catch-end score=<n> <win|ok> …`。点中光点仍然不触发普通点击反应（`mousedown` 里 `catchHit` 先拦截，没动）。
- **小本子"日记"说清是谁写、什么时候更新**：用户以为日记是自己写的 / AI 生成的 / 云同步的。事实是运行器每天**第一次启动**时，把前一天本机统计的互动（点击、打字、照顾、抚摸、玩、花、心愿）写成一行摘要，最多留 30 天，纯本地。现在日记页标题下常驻一行说明"它每天自动写一行昨天的互动摘要，保留 30 天（存在你自己电脑上）"（不只在空状态时出现）；空状态从"还没有"改成"今天是第一天，明天第一次打开它就会写下今天的事"；每条记录前面的日期保持不变。文案在 `i18n.js`（`growth.panel.journalNote` / `journalEmpty`，zh + en），没有写死在 HTML 里。
- 测试：`test/stroke-tiers.test.mjs` 重写成悬停采样驱动（2 次无反应 / 3 只 light / 9 不到 medium / 10 一次 medium / 14 无爱心 / 15 一次爱心 / 30 不重复 / < 20 px 抖动不计 / Ctrl 期间不计且清零 / 离开 > 1.2 秒后重新从零计数；另外断言**按下鼠标后不再有任何 tier 触发**，以及 48 / 140 px 那套仲裁已从 `main.js` 消失、五条日志都在、节流在）、`test/catch-light.test.mjs` 增加命中反馈一节（100 ms → surprised 450 → happy 900、单 timer handle、未命中无反馈、结算 win/ok 与最终表情、保留结算台词）、`test/panel.test.mjs` 增加日记断言（空日记出现首日文案且不再出现"还没有"、有记录时说明行也在、文案来自 i18n 而非 HTML）。Rust 没改，不需要 `cargo check`。

## v0.9.5 修复：没有宠物时窗口吞掉所有点击（Mac 实机，P0）、空状态说人话、换 logo

- **没有宠物 = 整个桌面点不动（跨平台 P0，Mac 实机撞上）**：启动时先把桌宠窗口设成可点击（`main.js` 正常起点），而把"没有引擎就恢复点击穿透"那行写在了有宠物的 `else` 分支里；两个兜底（33 ms 的 `poll()` 和 1.5 秒看门狗）又都以 `if (!engine) return;` 开头。于是 `list_pets` 返回空时，一个透明、始终置顶、完全不穿透的 360×480 窗口永远浮在桌面上，盖住下面的窗口 —— 用户以为系统卡死，只能强制退出。现在：① 空宠物分支第一件事就是 `setIgnoreCursorEvents(true)`；② 新增一个**独立于宠物**的 1.5 秒守卫，只要没有引擎就把窗口按回穿透（不管是怎么走到这一步的）；③ 托盘「恢复交互」之后同样由这个守卫兜住。
- **空状态说人话**：以前只在一个看不见的透明窗口上弹 toast。现在额外弹一个真正的系统对话框，写清楚"Kapi 只是壳子，宠物住在 .petpack 里"、怎么导入、桌宠窗口不会挡住你点东西、怎么退出。
- **macOS App Translocation 会被点名**：未签名的 app 从下载文件夹直接双击时，Gatekeeper 会把它挂到一个随机只读路径运行，`.app` 旁边的 `pets/` 就看不见了（"启动了但没有宠物"的第二种成因）。新增命令 `launch_info`（`exeDir` / `folder` / `translocated` / `roots`），启动日志里一并记录，被挪走时对话框直接告诉用户"把整个文件夹拖到应用程序或桌面再打开"。
- **小本子的可执行预设不再手抄**：`engine.js` 新增 `PET_PERFORMABLE`（`PROCEDURAL` 去掉 breathe / sway / slump / dragWiggle / stagger / typing 这些"状态"），`main.js` 的 `requestPlay` 和 `panel.html` 的卡片判断共用这一份。
- 「切换宠物」只在这个运行器真的装了多只时才出现（一个文件夹一只之后它对绝大多数用户是个死项）。
- 没有宠物时的托盘项不再静默失败：「它的小本子」「导出当前宠物包」「教我新东西」会提示先导入宠物包（以前导出会直接抛异常，什么都不发生）。
- 应用图标换成新的像素猫 logo（源图 `src-tauri/icons/app-icon.png`，CI 每次构建都会重新生成全部尺寸）。
- **接手开发看 [`PRODUCT.md`](PRODUCT.md)**：产品定位、整体架构、当前进度、遗留问题（含未签名 / 公证）、上线清单。

## v0.9.4 修复 + 新增：待机真的活、走路 = 窗口真的动、小本子能指挥、抓光点 10 秒、打字不吵、目光可关、抚摸分三级

团团（Windows，kapi-aacd73 v5–v7）复盘：装好后"10 分钟没动静"、"自动走路只是原地踏步"。两件事的根都在运行器，宠物包改 `idleRandom` 救不了。

- **显示器解析兜底（"10 分钟没动静"的根因）**（`main.js` `resolveMonitor`）：Windows 上透明无边框窗口会让 `currentMonitor()` 返回 null；以前 `monRect` 一直没值，`behaviors.step()` 永远返回 null——待机小动作、溜达、规则里的 `walk` 全部静默不做，桌宠像贴纸。现在按顺序试 `currentMonitor → monitorFromPoint(窗口中心) → primaryMonitor → availableMonitors()[0] → window.screen`，有 `workArea`（去掉任务栏）就用它，所以溜达永远不会走到任务栏底下。每 2 秒刷新；来源变化时写一行 `monitor <来源>[/workArea] x y w h`，全部失败写一次 `monitor missing`。
- **待机调度内置，不依赖 `triggers.idleRandom`**（`behaviors.js`）：空池只表示"没有额外自定义项"，活着的待机（每 15–45 秒）和溜达（有 walk 帧每 1–2.5 分钟，否则 3–7 分钟）照常；被挡住就 15–30 秒后再试，不丢时段。
- **走路 = 窗口真的位移，只能由移动状态机启动**（`engine.js` / `behaviors.js` / `main.js`）：
  - `cycle` 动作（`actions.walk`）**只在 `engine.setWalking(true)` 时播**。`idleRandom`、`lifeAct`、规则 `{play: "walk"}`、右键「动作」、小本子直接要求 `play('walk')` 一律拒绝（`cycle-refused walk …` / `idle-random skipped walk …` 各记一次日志），不会再出现"腿在动、窗口没动"。要让它走只有 `beh.wander()` / `walkTo()` / 规则 `{walk: …}` / 右键「动作」里的 walk 项（0.9.4 起等于溜达一次）。
  - 溜达目标从当前显示器工作区（扣掉窗口宽高 + 8 px 边距）的左 / 中 / 右三个区域里选，不选当前所在和上一次去过的区域，离当前位置至少一个窗口宽；y 钳在工作区内。
  - 每个 33 ms 步进都 `setPosition`；`setPosition` 抛错 → 立刻 `stopWalk('failed')` 并回 idle，绝不原地无限走。点击、拖拽、打开小本子、抓光点、睡着也立刻结束溜达（`walk-end interrupted`）。
  - **`actions.walk.facing`**（`left` / `right`，默认 `right`）：帧朝哪边，运行器往另一边走时镜像（`engine.walkFlip`）。skill 的 `sheet_to_frames --cycle` / `video_to_action --mode cycle` 从 0.9.4 起写 `facing: "right"`，walk 必须是侧身朝右的素材——正面走路帧技术上能循环，但横着滑过桌面像贴纸，不再算合格的 walk。
  - **验收口径变了**：以前只看 `engine.state.action === 'walk'`；现在必须看**窗口屏幕坐标连续变化**，一次溜达累计位移 ≥ 一个窗口宽（`test/idle-walk.test.mjs` 就是这么断言的）。
- **诊断日志**（`kapi-debug.log`，`appendLog`）：`idle-scheduled <动作> <下一次秒数>`、`idle-skipped <bubble|panel|hover|sleep|drag|busy|lookScript|norect>`（同一原因 20 秒一条，`norect` 60 秒一条）、`walk-start x,y -> x,y`、`walk-end <arrived|interrupted|failed>`、`walk setPosition failed: …`、`monitor …`、`look-follow on|off`、`catch-start … / catch-end …`、`panel play <id> -> ok|<原因>`。拿到日志就能分清"定时器没启动 / 一直被挡 / 移动调用失败"三种情况。
- **抓光点 10 秒 + 按物种扑**（`growth.js` `catchLightConfig` / `CatchRound`）：`pet.json.catchLight.durationSec`（默认 10，范围 5–60，老包缺字段也按 10 跑）一个数驱动倒计时、结算、心愿和再开一局；目标分随时长等比例（20 秒 15 分 → 10 秒 8 分）。扑的动作按 `catchLight.action`（包显式指定，必须存在）→ 物种默认表（cat / kitten：pounce；dog 三种：pounce / chase / jump；bird：peck / hop / jump；rabbit：hop / jump；rodent：dash / pounce / jump；human / cartoon：reach / tap / jump）→ 通用 `jump`。物种取 `pet.json.species` → `voice.species` → `voice.preset` female/male 或 `kind: tts` 视为 human → unknown。达到目标分且缺对应动作时的"想学"提示也分物种：猫科"扑"、鸟"啄"、真人 / 卡通"拍光点"，其他物种只结算不弹学习请求（只说一次）。
- **打字叫声统一冷却 60 秒**（`voice.js` `TypingGate` + `main.js` `reaction()` / `say()` 的 `source: 'typing'`）：打字点头的轻"嗯"、快打惊吓、累计打字提醒、花园花苞 / 开花 / 摘花台词、规则 `typing* ` 事件里的 `say` / `react`——所有打字来源的**真实出声**走同一个闸门，每 `pet.json.voice.cooldowns.typingSec`（默认 60）秒最多一声；气泡、点头、长花照常，只跳过声音。点击 / 抚摸 / 喂食等不受影响。冷却只在进程内；静音时不记"已播放"。
- **目光跟随开关**（右键「目光跟随 ✓ / ✗」，只在包里确有 look 素材时显示；`settings.lookFollow`，按 Kapi 文件夹存）：关 = 一直用 `layers/base.png`，不再轮询鼠标角度、不做环顾小动作，眨眼 / 表情 / 动作照常；开 = 立刻恢复包里的 `lookFollow` 配置，不重载、不删素材。小本子"目光跟随"卡片是同一个开关。
- **抚摸三级反馈**（`behaviors.js` `StrokeTracker`，`main.js` `strokeTier`）：一次"按住不放在它身上来回摸"算一轮，计数单位是**有效折返**（转向前后两段都 ≥ 20 px，手抖、高 DPI 抖动不算）。3 次 = 轻反馈（害羞一下 + 头边小闪光，不出爱心、不计养成、不出声）；10 次 = 中反馈（shy → happy 一次）；15 次 = 爱心 + 原有 `pet` 养成事件 / 台词 / 叫声，然后本轮锁定，继续摩擦不刷爱心。松手、离开不透明像素 > 1 秒、按 Ctrl、转成拖拽都结束本轮清零。两分钟养成冷却照旧：冷却中 15 次只给视觉爱心，不重复计心情 / 经验 / 心愿。**抚摸和拖拽的区分**：按下后先看手是在来回划还是明确拎走——正在抚摸时要竖向 > 70 px 或单段 > 140 px 才变成拖拽；横向第一段给 48 px 回头的余地。
- **小本子：刷新不重排 + 卡片可点 + `panel-cmd` / `panel-ack` 协议**（`panel.html` / `main.js`）：2 秒刷新只在内容变化时碰 DOM（焦点不丢、省 CPU）；顶部头像 / 名字 / 等级 / 最近学会。"会了什么"的卡片分五种：**play**（frames 动作和可表演的程序化预设：点一下播一次；吃喝睡走原有照顾流程——道具、冷却、经验、心愿）、**walk**（`cycle` 动作：点一下 = 真溜达一次，没有合格侧身循环时禁用并写原因）、**expr**（表情 2.5 秒）、**voice**（叫一声，仍受静音 + 冷却）、**look**（目光跟随开关）；服装是入口（回助手换），还不会的只是信息。协议：小本子 `emit('panel-cmd', {cmd: play|expr|voice|lookFollow|game|care, action|name|on})`，主窗口校验后执行并**每条必回** `panel-ack {cmd, action, ok, reason}`（reason：`busy` / `sleeping` / `noWalk` / `cooldown` / `unknown` / `rejected`），同一时刻只接受一个普通动作请求，表演中再点忽略（防连点叠加），4 秒没回应卡片显示"再试一次"。
- 宠物包：新字段 `catchLight`、`voice.cooldowns.typingSec`、`actions.<id>.facing`，模板 `minVersion` 0.9.4（skill 校验器 `check_runtime_options` + `facing` 取值检查；规则 `{play: walk}` 直接报错让用 `{walk: …}`）。老包不改也能跑：抓光点 10 秒、打字 60 秒冷却、facing 视为 right。
- 测试：`test/idle-walk.test.mjs`（空池 / 显式池、假时钟 10 分钟内必有待机 + 至少一次真溜达，断言窗口坐标连续变化与 ≥ 一个窗口宽；`walk` 进 idleRandom / 当技巧点都被拒且只记一次日志；`facing: left` 时往右走才镜像；点击 / 面板 / 移动失败 / 睡着都结束溜达；目标覆盖左 / 中 / 右且不连续同区；无显示器矩形不崩、`norect` 每分钟一条、显示器出现后恢复；`idle-skipped` 原因正确）、`test/stroke-tiers.test.mjs`（2 次无、3 / 10 / 15 各一次、30 次不重复、松手重计、< 20 px 不计、Ctrl 清零、拖拽清零、离开 > 1 秒结束）、`test/catch-light.test.mjs`（默认 10 秒 / 目标 8、范围钳制、9.9 秒不结算 10.0 秒只结算一次、物种动作与提示矩阵）、`test/panel.test.mjs`（五种卡片、双击只发一次、ack 状态）、`test/voice.test.mjs`（打字闸门：180 秒连续打字最多 3 声、静音不计、点击不受影响）、`test/engine.test.mjs`（目光开关：关即回 base、忽略鼠标与环顾、眨眼表情动作照常、开即恢复不重载）。

## v0.9.3 新增：规则引擎（宠物包自己描述行为）、发布自动化

- **小本子白屏 + 桌宠永久失去鼠标（Windows，0.9.2 仍复现，P0）**：根因是"运行中创建 WebView2 窗口"这件事本身——0.9.1 在同步命令里建（WebView2 在 IPC 处理线程上建窗死锁），0.9.2 改成 `run_on_main_thread` 后仍是在事件循环的回调里建，用户机器上照样白屏、`aux-window` 事件发不出来，而 1.5 秒恢复点击的定时器排在 `invoke` 之后，IPC 一卡它也没跑。现在：**运行中不再创建任何窗口**。小本子在 `tauri.conf.json` 里和桌宠窗口一起声明（隐藏启动，走同一条已验证能用的启动路径）；`open_panel_window` 变成 `async` 命令（工作线程，永远不占主线程 IPC），只做"告诉页面是哪只（`notebook-open` 事件）→ show → focus"；关闭只是隐藏，整个运行期复用。页面侧：1.5 秒恢复交互和 8 秒超时都在 `invoke` **之前**就排好（独立于命令是否返回），`try / catch / finally` 包住；超时或页面报错 → 收起小本子、恢复桌宠、toast 说明。日志（`kapi-debug.log`）：`notebook-click`（页面 + 原生各一条）、`window-shown`（原生，不经过页面 IPC）、`dom-ready`、`window-loaded` / `load-error`、`timeout`、`interaction-restored <原因>`。万一窗口缺失，才从工作线程按文档推荐的方式建（`window-created`）。
- **规则引擎 `src/rules.js`**：`pet.json.rules` 是一组"什么时候 → 做什么"的声明（`when` / `match` / `if` / `chance` / `cooldownSec` / `do`），运行器照着执行。用户的创意——"打开 Excel 就打哈欠""18:00 举个牌子""拖张图片给它就跳舞""连点 10 下就生气"——现在是**宠物包里的数据**，skill 改一下 pet.json 就生效，不需要改运行器、不需要重新编译。事件 27 种（click / clickMany / stroke / dragStart / dragEnd / landed / typing / typingFast / typingLong / idle / time / app / fileDrop / desktopClick / lowBattery / hungry / thirsty / tired / lonely / levelUp / wishDone / sulk / greet / wake / sleep / hourly / start），步骤 14 种（play / say / expr / effect / sound / react / look / walk / hide / come / mood / flag / wait / toast），顺序执行、`wait` 可以隔开。未知事件 / 步骤被忽略（老运行器只是少做），skill 的 `validate_pet_package.py check_rules` 在交付前拦住拼错的。规则状态（上次触发、flags）存在 `state.json.rules`。默认冷却 60 秒（`time` / `app` 3600，`hourly` 3000，`idle` 600，`start` 每次启动一次）。`app` 事件由已有的前台窗口轮询触发（只在切换到匹配的应用时触发一次）。
- **三层边界**（给 skill 的判断口径）：① 能用现有动作 / 台词 / 事件组合出来的 → 写 `rules`，不编译；② 需要新动作 → `teach_action.py` 生成帧，还是不编译；③ 需要新事件 / 新步骤（比如"听到麦克风声音"）→ 才是运行器改动，走 GitHub。
- **发布自动化**：`build.yml` 在 tag 构建时自动创建 GitHub Release 并附上 `Kapi-mac.zip` / `Kapi-win.zip`；从 Release 页面手动下载、原样放进 skill 的 `assets/runtime/`（`package_pet.py` 打包时校验 Mac 可执行位、Windows 根目录 `Kapi.exe`）。
- 清理：去掉早已无用的「设置」窗口文案（`i18n.settings`）。
- 测试：`test/rules.test.mjs`（匹配 / 冷却 / 条件 / 步骤顺序 / 校验）。

## v0.9.2 修复 + 新增：小本子白屏、真走路、打理、去掉坐窗口、来源诊断

- **小本子白屏 + 桌宠失去鼠标（Windows，P0）**：`open_panel_window` 以前在 Tauri 命令线程里创建窗口——WebView2 窗口在没有消息循环的工作线程上建出来，就会永远停在加载页、收到关闭也不关，主窗口的光标调用排在它后面一起卡住；旧版"叫另一只出来后点不动"是同一机制。现在所有辅助窗口只在**主线程**创建（`run_on_main_thread`），结果以 `aux-window` 事件回报（失败 toast + 写日志）；`openNotebook` 之后 1.5 秒无条件把桌宠窗口恢复为可点击。
- **真走路**（`engine.setWalking` / `actions.walk.cycle`）：宠物包里有 `walk`（`cycle: true, loops: -1`，由 skill 的 `video_to_action.py --mode cycle` 产出）时，它溜达 / 过来 / 跟鼠标 / 躲起来的路上播放真实步行循环（向左走镜像），到达即回待机；没有就还是旧的颠簸。有真走路的宠物每 1–2.5 分钟溜达一次、走得更远（150–500 px）。
- **打理**（`actions.groom`）：舔毛 / 挠耳 / 理头发是待机调度里权重最高的一项（18），偶尔配一声"舒服"的反应。
- **「坐到窗口上」默认移除**：只有 `pet.json.features.perchOnWindow = true` 的包才显示那一项；代码保留。
- **来源诊断**：托盘「诊断」第一段就是"名字 id v版本/b构建 ← 目录"；启动把候选宠物（id@版本:目录）全部写进 `kapi-debug.log`；交付包里的宠物版本低于电脑上已装的 → 启动 toast 说明显示的是哪个（打包侧也已改为自动读本机已装版本，不会再出这种包）。
- CI：Windows 产物统一命名 `Kapi.exe`（二进制本名是 kapi.exe）并校验。
- 测试：`engine.test.mjs`（走路循环只在有 cycle 帧时播，到达即停）。

## v0.9.1 修复：Mac 启动被"辅助功能"弹窗卡死、Mac 包丢可执行位

- **启动不再申请辅助功能权限**（`lib.rs`）：`device_query::DeviceState::new()` 在 macOS 上会弹系统权限窗，没权限还会 panic——以前一启动就跑全局输入监听，所以每次打开都被卡在弹窗。现在：启动时用**不弹窗**的 `AXIsProcessTrusted` 检查，有权限才起监听线程（只起一次，`AtomicBool` 防重复）；没权限就正常进桌面，打字点头 / 长花 / Ctrl 鞭子暂停，其余一切照常；后台每 5 秒查一次，用户在系统设置里打开开关后**不用重启**自动接上。托盘多一项「启用打字互动（需要辅助功能权限）」（仅 Mac）：点了才弹一次系统提示 + 打开「隐私与安全性 → 辅助功能」页；拒绝了也只是没有打字互动。首次启动 6 秒后一条不阻塞的 toast 说明这件事（只说一次）。Windows 不受影响（那里不需要权限）。新增命令 `request_input_permission` / `input_watcher_state`，事件 `input-watcher`。
- **Mac 包的可执行位**：skill 的 `package_pet.py` 以前把 `Kapi-mac.zip` 解开再用 Python 重新压缩，Windows 上这一步会丢掉 `Contents/MacOS/kapi` 的 0755，解压后双击没反应。现在运行器 zip 的条目**逐条原样复制**进交付包（Unix 属性保留；遇到本身就是 Windows 上重压过的 zip 会修成 0755），其余文件显式写成 Unix 条目，打完强制检查 `MacOS/*` 为 0755，否则 exit 7。Actions 的 mac 打包步骤加了 `chmod 755` + ad-hoc `codesign` + `zipinfo` 校验。
- 版本来源只有一个：`package.json` / `tauri.conf.json` / `Cargo.toml` 同一个号，tag 同名；本地旧源码不是来源。签名 / 公证（Developer ID）仍未做——未签名的限制（首次 Gatekeeper、换路径或更新后可能要重新授权辅助功能）照旧，交付说明里不承诺"只授权一次"。

## v0.9.0 新增：小本子、今日心愿、捡东西、日记、闹脾气、抓光点、章节

带回家当天就有事可做，而且每一样都留了一个只有回助手那里才能完成的钩子。全部是运行器内置（`src/growth.js` 纯逻辑 + `src/panel.html` 小本子窗口），宠物包不用改，数据存在 `state.json.growth`。

- **小本子**（右键 / 托盘「它的小本子」，`open_panel_window` 开一个普通小窗口 `panel.html`，每 2 秒从 `state.json` / `pet.json` 刷新）：五页——**会了什么**（学会的动作 / 先凑合的吃喝睡 / 还不会的候选动作 / 表情 / 转头方式 / 声音 / 衣服 + 统计）、**今日心愿**、**收藏**、**日记**、**章节**。每一项"还不会"的后面都写着"回助手那里教，说'教它…'"。
- **今日心愿**：每天 3 条小愿望（被摸 10 下 / 被点 12 下 / 看你打 800 字 / 吃 2 次 / 喝 2 次 / 睡一觉 / 开一朵花 / 玩一局抓光点 / 收到一个东西 / 你翻一翻小本子），完成一条 +3 心意 + 一句台词，三条全完成 +5 + 爱心雨。**每周一条平台心愿**"想学一个新动作"——只有宠物包升级后 frames 动作变多才算完成（`onPackageChanged`），完成 +6。
- **它带回来的小东西**：你离开 ≥ 25 分钟再回来（全局键鼠恢复），55% 概率它叼回一个小物（18 种，三档稀有度，表情符号从它手边飘起 6 秒 + 一句"你不在的时候我捡到一个…"），一天最多 2 个。收藏里每集满一页（6 种不同）→ **服装券 +1**，它说"想换个新造型，带我回助手那里"。
- **日记**：每天第一次启动时把昨天写成一行（打了多少字、摸了几下、照顾几次、捡了几个、抓光点纪录、被打几下 + 一句心情），保留 30 天。
- **闹脾气**：你在电脑前（有键鼠活动）整整一小时没碰它一下（离开的时间不算，所以吃个饭回来不会闹）→ 它哼一声，之后点它只会生气脸 + "不理你。"（摸还有效）；摸够 10 下和好：爱心 + "……好吧，原谅你了。"，心情回到 60。
- **抓光点**（右键「玩一会儿」/ 小本子按钮）：20 秒，一个光点在它窗口里乱跑，点中 +1，它每次扑一下（有 `pounce` 动作就用，否则跳）并一直盯着光点看。记最高分；**≥ 15 分且还没学 pounce** → 它说"想学一个扑的动作，带我回助手那里教"（只说一次）。光点画在人物画布上，所以命中测试把它当实体，点击不会穿透到桌面。
- **章节**：Lv1–10 有名字（刚回家 → 混熟了 → 老朋友 → 心有灵犀 → 家人 → 少年期 → 默契 → 形影不离 → 老搭档 → 成年期），第 2 / 4 / 6 / 8 章各有一个**只能回助手完成的章节任务**：教一个新动作 / 换一套衣服 / 吃喝睡都教会 / 再教两个动作，小本子里显示完成没有。
- 数据：`growth.stats` 累计（被摸 / 被点 / 打字 / 吃 / 喝 / 被打 / 礼物），`best.catch`，`log` 最近 60 条事件。
- 测试：`growth.test.mjs`（心愿生成 / 完成 / 周心愿只认新动作 / 捡东西上限与服装券 / 日记 / 闹脾气与和好 / 章节任务）、`panel.test.mjs`（小本子五页在桩 DOM 里渲染）。`settings.html` 已删。

## v0.8.16 新增：真猫叫、一只一个文件夹、活着的待机、看得见你在干嘛

- **真实叫声**（`src/sounds/`，`tools/build_sounds.py` 生成，`src/sounds/CREDITS.md` 逐条署名）：动物桌宠的叫声不再合成，而是 46 条真实录音（全部 CC0 / 公有领域 / CC BY）：猫 15 条喵（打招呼、点击、台词按字数 1–3 声）、讨食长喵、呼噜（抚摸）、哈气（生气）、4 条嗷呜（被鞭）；狗按体型分三套汪（小 8 / 中 2 / 大 4）、嚎（寂寞）；鸟 4 段啾啾；仓鼠吱、豚鼠 wheek（饿）；兔子跺脚（生气 / 落地）。小奶猫 = 猫的录音升 18%。没有录音的叫法（吃饭咀嚼、舔水、狗哼唧、睡觉叹气）仍用 0.8.14 的合成，文件加载失败也自动退回合成。`voice.js` `playAnimal` / `loadBank`。skill 侧的试听 `animal_sound.py` 用同一套文件，所以"它开口了"听到的就是桌面上的声音。
- **一只宠物 = 一个 Kapi 文件夹**（`lib.rs` `take_folder_lock`）：去掉了"叫另一只出来 / 收回其他宠物"和整个多窗口代码（点不动的根源）。单实例改成按**文件夹**锁（`<文件夹>/.kapi.lock`）：同一文件夹双击两次只会把已经在跑的那只显示出来（通过 `.kapi.show` 文件通知）；另一个文件夹里的 Kapi 是另一只，各跑各的。设置按文件夹分开存（`settings-<hash>.json`，首次从旧 `settings.json` 继承）。两只打招呼改走临时目录 `kapi-peers/` 的位置文件（`peer_pets`，每秒一次，4 秒没更新视为退出）。`tauri-plugin-single-instance` 依赖移除，换 `fs4`。
- **活着的待机**（`behaviors.js` `lifeAct`，`engine.js` 新增 stretch / tilt / shiver / yawn / settle 程序动作 + `lookAlong`）：每 15–45 秒随机一件小事——慢慢环顾（用朝向帧左→正→右→正串起来）、瞟一眼鼠标在哪（再远也看）、伸懒腰（开心表情）、歪头、挪两步、打哈欠（困表情 + 偶尔一声）、抖一抖、蹦一下、坐稳、偶尔自己做一个学过的动作。心情（照顾面板的 mood）越高越频繁（0.8×–1.6×）；不连续重复同一件；气泡 / 面板开着、鼠标在身上、睡着、拖着时不做。鼠标靠近时环顾立刻让位给真实目光。
- **桌面感知**（`lib.rs` 全局鼠标按键事件 `mouse-press` + `behaviors.js` `onDesktopClick`）：你在桌面别处点击——离它近的一定看过去，远的有 45% 概率瞟一眼（6 秒一次）；右键一定看；1.2 秒内连点三下（双击打开东西、狂点）会被吓一跳（抖 + 惊讶 + 一声，12 秒一次）。文件拖经它上方：惊讶 + 一声"诶?"；拖到它身上：开心跳一下 + "给我的？……这个不能吃。"（`.petpack` 照旧导入）。
- 宠物包不用改；`minVersion` 不变。测试：`engine.test.mjs`（内置动作、lookAlong 让位规则）、`behaviors.test.mjs`（40 分钟内约 60–100 件事、不重复、忙时静止；桌面点击）、`voice.test.mjs`（录音库完整、许可证逐条有）。

## v0.8.15 新增：打字也有声，每个互动都有声；目光跟随不再叠影

- **打字时的声音**（`behaviors.js` `onTyping` → `host.react('typing')`）：桌宠每 1.5 秒随打字点一下头时，同时发一声很轻的"嗯"（真人按 female / male 音高）或一声短"mrp"（猫）/ 轻哼（狗）/ 啾（鸟）/ 吱（仓鼠），音量只有普通反应的 2/3；睡着不出声。连续快打的惊吓 shake 配一声"诶?!"（猫 chirp、狗 yip、鸟尖啾、仓鼠急吱）。
- **新增无词反应种类**（`voice.js` `planReaction` / 各物种 plan 都实现）：`typing`、`whine`（饿了 / 渴了 / 寂寞的提醒：真人"嗯~~"、猫长声讨食喵、狗讨食哼唧、鸟哀啾）、`surprise`（扒住屏幕边、快打）、`greet`（遇到另一只桌宠：真人"嗨~"、猫喵+呼噜、狗两声汪+哼、鸟三啾）、`wake`（醒来伸懒腰）。电量低也是一声 whine。
- **场景音效**（`voice.js` `sfx()`，与声音种类无关，`voice.kind = none` 也有，只受静音开关控制）：被扔出去落地 **thud**（弹一下也有小声的）、扒住屏幕边 / 第一次站上窗口 **knock**、花苞冒出来 **pop**、开花 **bloom**（三音上行）+ 一声开心、摘花 **pluck**、爱心 / 花瓣 / 音符飘落开始时 **chime**、升级 **fanfare**、奶茶出手 **whoosh**、奶茶砸中 **splat**（内置真视频在第 22 帧砸中，`BUILTIN_FX.hitFrame`；宠物包自带的 `effects.*.videoFrames` 可写 `hitFrame`，不写取中间帧；程序画的那版用 `effects.js` 的 `onHit` 回调）。
- **真人桌宠没录音的台词不再静音**：`voice.kind = tts` 的桌宠说一句没有录音的台词（运行器内置文案、照顾 / 行为提示等），以前只有气泡；现在先出一声它自己音色的无词反应（按这次互动的种类），不再出现"有字没声"。
- **目光跟随更跟手**（`engine.js`）：八方向切换的交叉淡化以前有一个 220 ms 的下限，宠物包里写多小都被抬到 220，所以总能看到两个头叠在一起、跟随发虚。现在按包里写的值用，默认（字段缺失时）`crossfadeMs` 55 / `holdMs` 80（原 260 / 150）；换装走八方向时同样 55 / 80。已有宠物包里写明的数值照用，不覆盖。skill 模板、`_common.py` 默认、预览 gif 的模拟时序同步改成 55 / 80（预览现在按包里的真实数值淡化）。
- 宠物包不用改；`minVersion` 不变。测试：`test/engine.test.mjs`（55 ms 不被抬到 220、holdMs 80 一格一格走）、`test/voice.test.mjs`（15 种反应 × 8 个物种 + 9 个 sfx 都能生成）、`test/behaviors.test.mjs`、`test/care.test.mjs`。

## v0.8.14 新增：猫会喵、狗会汪

- **物种叫声**（`src/voice.js` `planAnimal`）：宠物包 `voice.kind = babble` 且带 `voice.species`（cat / kitten / dog / dog-small / dog-large / bird / rodent / rabbit）时，运行器不再咿呀，而是合成该物种的叫声：猫——喵（点击 / 台词）、呼噜（抚摸，调幅低音）、哈气（生气）、嗷呜（被鞭）、"mrrr"（睡）；狗——汪（噪声爆 + 方波，按体型高低）、哼唧（抚摸 / 被拖）、低吼（生气）、尖叫（被鞭）、叹气（睡）；鸟——啾啾、颤音、嘎；仓鼠 / 兔子——吱吱、磨牙。台词在气泡里是文字，声音是按字数长短的 1–4 声叫。渲染器同时加了噪声音符、滑音 / 颤音、调幅，老的咿呀声和真人反应不受影响。没有 species 的动物包还是咿呀声。

## v0.8.13 新增：拎着晃会荡、晃狠了会晕

- **拎起来像被拎着**（`engine.js` 钟摆）：拖拽时以**抓取点**为轴像钟摆一样垂挂，随手的加速度甩动（±16°，窗口两侧留白从 60 加到 90 px 给它荡）；抓头顶和抓身子手感不同。原来的 `dragWiggle` 只剩轻微挣扎，之前它那段"按速度倾斜"的代码读的是不存在的字段，从来没生效过。
- **晃狠了会晕**：2.5 秒内三次 ≥600 px/s 的急转向 = 晕：头顶三颗转圈的小星星、surprised 表情，每次急转一声"哇—"的无词反应。
- **松手后踉跄**：晕着松手不是立刻站稳，而是 1.6 秒左右摆渐停（运行器内置 `stagger`，不进宠物包）+ angry 表情 + 一半概率说 `lines.dizzy`（模板默认"头、头好晕……"）。没晕的松手照旧。

## v0.8.12 新增：每次触碰都有声音，台词偶尔说；鞭子像鞭子了

- **咿呀声反应**（`src/voice.js` `planReaction` + `main.js` `react()`）：以前真人桌宠（`voice.kind = tts`）只在有录音的台词上出声，摸 / 拖 / 喂这些运行器内置文案的互动都是哑的，咿呀声只给动物用——所以"做了咿呀声却听不到"。现在**每一次**点击、抚摸、拖起、落地、鞭打、喂食、喝水、睡觉都先有一声它自己音色的无词反应（"嗯？""唔~""哎哟""咔嚓咔嚓""咕咚"、打哈欠、咯咯笑、哼），真人按 `voice.preset` 的 female / male 音高，动物按原来的 soft / bright / low；**台词只在一部分时候说**（点击 35%、抚摸 25%、拖起 30%、落地 45%、鞭打 30%、喂食喝水 40%、睡觉 60%、连点生气 100%），说台词时照旧气泡 + 录音。反应不受 700 ms 台词节流影响（自己 160 ms），台词录音播放中不打断。宠物包不用改。
- **鼠标跟随 / 点击失灵的加固 + 诊断**（`main.js` `poll()`）：v4/v5 的"叫另一只出来后，第一只头不跟鼠标、点不动，但打字还会晃"= 30 Hz 的 poll 循环没跑完（头跟随、命中测试、穿透都在这一个循环里，打字在别的定时器里）。现在循环分成四段各自 try/catch 并计数（cursor / look / hit / passthrough），头跟随放在最前面、不再排在可能失败的 IPC 调用后面；看门狗 3 秒没跑完就把窗口强制设为可点击；托盘多一项「诊断」——弹出各段失败次数 + 最后错误，并把一条诊断写到设置目录的 `kapi-debug.log`（连续 30 次同一段失败时也自动弹一次并写日志）。沙盒里复现不了根因，这版的目的是让它不再静默死掉，并把现场留下来。
- **叫出来的那只放在旁边，不压在身上**：以前新窗口随机落在屏幕 30%–50% 宽的位置，可能正好盖住第一只——一个还没加载完（或加载失败）的透明窗口默认是接收鼠标的，整块矩形把底下那只挡住，表现就是"第一只点不动、头不跟，但打字还晃"。现在新窗口放在叫它的那只右边 24 px（右边放不下就放左边），没有宠物可加载的窗口一律设为鼠标穿透。诊断日志里多了光标屏幕 / 窗口坐标、采样 alpha、当前穿透状态。
- **同一时间只跑一个 Kapi**（`tauri-plugin-single-instance`）：再双击一次 exe、或上一次没退干净又开了一个，以前会叠出第二只桌宠和第二个托盘图标——两个窗口叠在同一位置，点击只到最上面那个，底下那只照常动但点不着、头也"不跟"（其实跟的是上面那只被遮住的）。任务管理器里看到两个 Kapi 进程就是这个情况。现在第二次启动只会把第一只显示出来。（Tauri 在 Windows 上每个窗口还会有 WebView2 子进程，那些在同一个 Kapi 组里，是正常的。）
- **🐾 按钮够得着了**：以前鼠标一离开人物像素它就消失，从身上移到左上角的路上会经过透明区，按钮在半路就没了。现在离开后保留 0.8 秒、鼠标在按钮上时一直保留。
- **取消双击开面板**：连点几下会误触照顾面板；现在面板只从左上角 🐾 和右键「照顾」打开。
- **去掉「设置」**：右键和托盘里的「设置…」删了——那个窗口只有一个"显示大小"，右键「大小」子菜单已经有了。`settings.html` 留着，以后有真正的设置项再接。
- **鞭子**：鼠标按住 Ctrl 时画一条真正的皮鞭——跟着光标有惯性的渐细鞭身（最近 350 ms 的轨迹拉成约 90 px 的鞭梢）、光标处一截短鞭柄、手不动时鞭子下垂轻晃、击中时一个白色"啪"的闪光，落点留淡红鞭痕 0.2 s；光标改成十字线，不再叠一个鞭子图标。

## v0.8.11 新增：它会说自己还有什么没学会

- 孵化可以在"开口说话"之后就把它带回家（用户的选择），吃 / 喝 / 睡之后再一项项回平台教。运行器从宠物包推断哪些照顾动作还是程序化顶替（`actions.eat/drink/sleep` 不是真帧，或 `pet.json.pendingSkills` 列出的其他项），然后：每个版本第一次启动时说一次"我还没学会吃饭、喝水、睡觉，右键「教我新东西」带我回去继续"；用户在照顾面板触发顶替版动作后说一句"这个是我先凑合的"（每项 10 分钟一次）；原本偶尔出现的"还能教我"闲聊优先说这句。宠物包可用 `persona.lines.pendingHint / pendingEat / pendingDrink / pendingSleep` 覆盖文案。全部学会后自动不再提。

## v0.8.10 修复（小耳机 v5：头跟着鼠标时"跳回另一张图"）

- **看鼠标时不眨眼、不切表情**（`src/engine.js`）：闭眼图和表情图属于待机正面那一套；头跟随时屏幕上是朝向帧，100 ms 切到正面再切回来就是用户看到的"跳回默认待机"。现在 `look.current !== 'base'` 时朝向帧优先，眨眼只在停在正面时发生（看鼠标期间到点的眨眼直接跳过、重新排期），表情等鼠标回到死区再显示——用户的摸 / 点都发生在死区内，所以手动触发的表情照常立刻出现。
- 根因另一半在素材：那个包的待机正面 / 闭眼 / 表情 / 动作出自一次生成，8 朝向出自另一次（偏冷、头宽 13%）。skill 侧从这一版起：待机正面 = 注视视频自己的首帧，表情图以它为参考重出，`family_check.py` 把"不是同一次生成"的素材拦在第 2 步。旧包不重做、只换这个运行器也会明显好转。
- 版本号 0.8.10；宠物包契约不变（`runtime.minVersion` 不用升）。

## v0.8.9 修复（小耳机 v3 复盘）

- **聊天框 / 气泡不再压住头顶的花**（`src/care-layout.js` `stack` + `main.js` `layoutTop`）：打开聊天或冒气泡时，从舞台画布的 alpha 实测"画面最高到哪"（人物 + 头顶花 + 任何道具），气泡、输入框按"内容顶 → 气泡 → 输入框"叠成一列，彼此留 12 px；窗口上方不够就像照顾面板一样向上扩窗（脚底屏幕位置不动）；已经顶到显示器上沿时输入框改放到脚下。
- **花瓣 / 爱心不再叠加**（`src/effects.js` `Queue`，策略 `queue-one`）：同一时刻画布上只有一组特效；播放中再触发只保留最新的一次等着，播完再放；更多触发只计数不排队；切宠物 / 隐藏时清空。奶茶同策略。
- **目光跟随不跨方向**（`src/engine.js`）：鼠标一下越过几个扇区时，按最短路径一格一格走（每格一个 `holdMs`），每次切换都是相邻帧淡化；默认 `holdMs` 150（原 400）、`crossfadeMs` 260（原 180）。方向图和待机底图不一致（另一次生成）才是跳帧的主因，这由 skill 侧"待机正面 = 视频首帧 + family_check"解决（见 0.8.10）。
- **桌宠自己告诉用户"还能教我"**：首次提示多一行；右键「带它去学新东西」改成「教我新东西 / 实现你的想法」；动作子菜单为空时显示「去教我一个你自己想的动作」；导入同一只的新版本后说"我学会新东西啦，下次还可以继续教我"（宠物包 `lines.learnedNew` 可覆盖）；空闲很久偶尔（≥25 分钟一次、35% 概率）说一句"你想象中的动作我也能学"（`lines.teachHint` 可覆盖）。
- **特效按 id 通用**：`pet.json.effects.<任意id>`（videoFrames）都能被里程碑引用并播放，`bubbleTea` 只是第一个；里程碑可带 `action` 指定播放时的动作。新动作 / 新触发 / 新特效 / 新台词都只改宠物包，不用重新编译运行器（见 skill `runtime-contract.md`「不用编译就能扩展的空间」）。
- **首次交付包激活**：exe 旁的 `bundle.json`（skill 打包时写）第一次启动时把包里的宠物设为当前宠物，只处理一次（`settings.seenBundles`），之后尊重用户自己的切换；同 id 仍取最高版本。
- **多宠物窗口点不动**（小耳机 v4 复盘）：每个窗口每 1.5 秒重新声明自己的穿透状态（不只在变化时），新窗口启动先置为可点击；托盘加「恢复交互」（所有宠物窗口取消穿透）和「收回其他宠物」。根因在沙盒里无法复现，这是按窗口隔离 + 自愈 + 手动恢复三层兜底。
- **聊天功能移除**（见文末）。
- **奶茶是内置基础效果**：运行器自带一套真视频奶茶帧（`src/fx/bubbleTea/`，41 帧 18 fps 无损 WebP，2026-10-10 绿幕重拍版，原视频 SHA-256 4ABB968D…53EB36；画面里只有杯子和珍珠，不含任何角色），所有桌宠连点 10 下都扔这一杯；宠物包带自己的 `effects.bubbleTea` 时覆盖它。真帧加载失败才退回程序画的杯子。不再报"奶茶视频帧缺失"。
- 单测：`test/fx-queue.test.mjs`、`care-layout.test.mjs`（叠放）、`engine.test.mjs`（相邻过渡）。历次交接便条移到 `docs/history/`。

## v0.8 互动里程碑 / 局部特效 / 打字种花

- **里程碑**（`src/milestones.js`）：一张表驱动"连点 10 次 → 奶茶特效""累计摸 5 次 → 爱心""收集 5 朵花 → 花瓣雨"。阈值、时间窗、冷却从 `pet.json.milestones` 读（skill 可配），运行器只有默认值；计数和冷却存 `state.json.milestones`，重启保留；点击 / 抚摸 / 摘花分别计数、分别冷却。原有的 4 连点生气不变。
- **局部特效层**（`src/effects.js` + `src/index.html`）：在桌宠原有窗口的独立画布里播放，不创建覆盖显示器的置顶窗口。奶茶特效读取宠物包 `effects.bubbleTea` 指向的实际视频拆帧（48 张透明 WebP、12 fps），依原始顺序与位置播放 4 秒；缺帧时报错，不回退成程序模拟。爱心 / 花瓣 / 音符仍按原有方式程序绘制。特效画布不参与鼠标命中，播放完自动清空。`tools/video_to_effect.py` 可从交付的原始 MP4 重建奶茶帧。
- **打字种花**（`src/garden.js`）：只数按键次数不读内容；有效打字 30 秒花苞 → 2 分钟开花 → 5 分钟变大 → 10 分钟摘下放脚边；停止打字只暂停不倒退；花是独立挂载层跟随头部，不改人物图；花园存 `state.json.garden`，最多显示 5 朵，多的记数；每 5 朵触发花瓣雨。花的图用 `props/flower_1..3.png`，没有就程序化画。
- 新单测 `test/milestones.test.mjs`（里程碑 / 花园 / 抛物线）。

## v0.7.1 修复

- 打字点头没反应（Windows 实机反馈）：`behaviors.onTyping` 播放的是 `typing` 动作，而宠物包里只有 `nod`，`engine.play` 对不存在的动作直接返回 false。现在没有 `typing` 就点头（`nod`），阈值降到每秒 2 键（80ms 轮询会漏键），1.5 秒最多一次。键盘监听只数按键次数，不读内容。

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

## v0.3 新增

- 养成系统 `src/care.js`：饱食/水分/精力/心情、喂食/喝水/抚摸/睡觉、每日经验、等级、服装券、成长阶段体型；状态存宠物目录 `state.json`。面板：右键「照顾」或悬停左上角 🐾。
- 表情帧：`layers.expressions` 六种（happy / sleepy / angry / sad / surprised / shy）：点击 happy、连点 angry、抚摸 shy→happy、甩动 surprised→落地 angry、久未互动后点击 surprised、心情低 sad、困/睡 sleepy、聊天回复可带 `[expr:x]`。
- 抚摸手势：在头部区域水平来回 ≥3 次。
- 朝向切换迟滞（死区 ±25%、扇区边界 8°）+ holdMs 400 + crossfade 180，消除交界处抖动。
- 首次启动操作提示气泡。
- 原图不再上屏：宠物包 `layers.base` 必须是生成帧。

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

## 聊天功能已移除（0.8.9）

桌宠不再连接对话实例：用户在桌面上随口说一句"你好"就消耗一次请求，这个逻辑不成立。`connect.js`、设置里的连接页、Rust 的 relay / keychain 命令和 `reqwest / keyring / tauri-plugin-http` 依赖全部删除；双击桌宠改为打开照顾面板。桌宠说的话只来自宠物包里的台词（`persona.lines`）。以后要做聊天，先定计费方式再加回来。
