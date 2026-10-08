// Kapi UI strings. Locale = active pet's persona.language, else OS language. Unknown locales fall back to English.
(function (global) {
  'use strict';
  const STRINGS = {
    'zh': {
      hint: '拖我 · 点我 · 在我头上来回摸 · 双击跟我聊 · 右键有菜单',
      noPet: '还没有宠物：把 .petpack 拖到这里，或用托盘菜单导入',
      needNewer: '这个宠物包需要新版本的 Kapi，请重新下载',
      imported: (n, v) => `已导入「${n}」 v${v}`, importFail: '导入失败：', onlyOne: '只有这一只', switched: (n) => `切换到「${n}」`,
      exported: '已导出，把它发给助手就能继续教', exportFail: '导出失败：',
      chatPlaceholder: '跟它说点什么… (Enter 发送, Esc 关闭)', offline: '还没连上服务器', quota: '我今天说不动啦，续个费再聊？', reminder: '提醒时间到',
      menu: { care: (n) => `照顾「${n}」（喂食 / 喝水 / 睡觉）`, talk: (n) => `跟「${n}」说话`, actions: '动作', size: '大小', mute: '静音', onTop: '总在最前',
              import: '导入宠物包…', switch: '切换宠物', export: '导出当前宠物包…', settings: '设置…', hide: '隐藏', quit: '退出' },
      care: { feed: '喂食', water: '喝水', pet: '抚摸', sleep: '睡觉', wake: '叫醒', hunger: '饱食', thirst: '水分', energy: '精力', mood: '心情', xp: 'XP', streak: (d) => `连续 ${d} 天`,
              cooldown: (label, m) => `刚${label}过，${m} 分钟后再来。`, enough: '够了够了。', tickets: (o, h) => `🎫 服装券 ${o} · 节日券 ${h}（回助手那里兑换）`, close: '×',
              firstToday: (xp, d) => `今日首次照顾 +${xp} XP · 连续 ${d} 天`, levelUp: (lv) => `升到 Lv.${lv}！`, got: ' 获得：', cooling: '冷却中',
              fallback: { fed: '好吃。', watered: '咕咚。', pet: '嗯……舒服。', sleep: 'Zzz', wakeUp: '睡饱了。', wokenUp: '……谁叫我。', hungry: '……有点饿。', thirsty: '想喝水。', tired: '困了……', lonely: '你好久没理我了。' },
              titles: ['新手饲养员', '常客', '熟人', '好朋友', '铲屎官', '搭子', '家人', '老朋友', '知己', '灵魂伴侣'],
              rewards: { 2: '新台词包：撒娇', 3: '服装券 ×1', 4: '新台词包：碎碎念', 5: '服装券 ×1', 6: '成长阶段：少年期（体型 +10%）', 7: '服装券 ×1', 8: '新台词包：老朋友', 9: '节日皮肤券 ×1', 10: '成长阶段：成年期（体型 +20%）' } },
      beh: { follow: '走哪跟哪。',  hide: '我躲一会儿。', coming: '来了来了。', perch: '这里视野不错。', perchHint: '点一下你想让我坐的窗口。', typingLong: '打这么多字，歇会儿？', lowBattery: '电量只剩 {p}% 了！', greet: '嗨，{name}。', thrown: '……你扔我？', cling: '扒住了扒住了！', climbBack: '差点掉下去。' },
      wardrobe: { menu: '衣柜', default: '原装' },
      teach: { menu: '带它去学新东西…', done: (f) => `已放到桌面：${f}。把它拖进助手对话，说你想教什么。`, guide: '使用说明', guideMissing: '说明文件不在这个宠物包里' },
      inter: { clickTea: '再点我就请你喝奶茶——接住！', strokeLove: '被你摸得心花怒放～', garden: '花园又多了一朵！', flowerBud: '咦，头上长了个花苞？', flowerBloom: '开花了！继续打字它会长大。', flowerPick: '摘下来啦，放旁边收着。' },
      menu2: { follow: '跟着鼠标走', unfollow: '别跟了', come: '过来', hide: '躲起来', perch: '坐到窗口上', unperch: '别坐窗口了', summon: '叫另一只出来', release: '收回这只' },
      settings: { title: 'Kapi 设置', scale: '显示大小 (0.5 – 2)', save: '保存' },
      connect: { title: '连接 Capafy 对话（让它会聊天）', risk: '需要你的 Capafy Token。它是账号级令牌，泄露可能影响你在 Capafy 的其他操作；Kapi 只把它存进系统凭据库，不写入任何文件。',
        url: '正在使用 Kapi 的那个 Capafy 对话的完整网址（复制浏览器地址栏）', token: 'Capafy Token（在 Capafy 账户页复制）', pick: '没有自动匹配到，请选择 Kapi 所在的对话实例', test: '连接测试（不发消息、不计次）',
        useSelected: '使用选中的实例', disconnect: '断开连接并删除凭据', display: '显示', connectedTo: (id) => `已连接当前对话（${id}）`, checking: '正在验证…', needToken: '请先粘贴 Token。',
        badToken: 'Token 无效或已过期。', netErr: (s) => `连不上 Capafy（${s || '网络错误'}）。`, noInstances: '这个账号没有活跃的对话实例。', noMatch: '网址里的 ID 不属于这个账号的活跃实例，请在下面选择。', parseFail: '无法从网址解析出 ID，请在下面选择。' },
      chatErr: { authExpired: 'Capafy 登录已失效，去设置里重新填 Token。', notFound: '没有找到这个 Capafy 对话。', busy: '我还在想上一句话。', tooFast: '说得太快了，等一下再聊。', quota: '今天的对话额度用完了，回 Capafy 续费。', offline: '还没连上。', notConnected: '还没连上 Capafy：右键 → 设置，粘贴对话网址和 Token。', timeout: '暂时没连上，再说一次？' },
    },
    'en': {
      hint: 'Drag me · click me · stroke my head · double-click to chat · right-click for menu',
      noPet: 'No pet yet: drop a .petpack here or import from the tray menu',
      needNewer: 'This pet package needs a newer Kapi. Please download again.',
      imported: (n, v) => `Imported “${n}” v${v}`, importFail: 'Import failed: ', onlyOne: 'Only one pet here', switched: (n) => `Switched to “${n}”`,
      exported: 'Exported. Send it to your assistant to keep teaching.', exportFail: 'Export failed: ',
      chatPlaceholder: 'Say something… (Enter to send, Esc to close)', offline: 'Not connected yet', quota: "I'm out of words for today — top up to keep chatting?", reminder: 'Reminder',
      menu: { care: (n) => `Take care of ${n} (feed / water / sleep)`, talk: (n) => `Talk to ${n}`, actions: 'Actions', size: 'Size', mute: 'Mute', onTop: 'Always on top',
              import: 'Import pet package…', switch: 'Switch pet', export: 'Export current pet…', settings: 'Settings…', hide: 'Hide', quit: 'Quit' },
      care: { feed: 'Feed', water: 'Water', pet: 'Pet', sleep: 'Sleep', wake: 'Wake up', hunger: 'Food', thirst: 'Water', energy: 'Energy', mood: 'Mood', xp: 'XP', streak: (d) => `${d}-day streak`,
              cooldown: (label, m) => `Just did that. Try again in ${m} min.`, enough: 'Okay, okay, enough.', tickets: (o, h) => `🎫 Outfit tickets ${o} · Holiday ${h} (redeem with your assistant)`, close: '×',
              firstToday: (xp, d) => `First care today +${xp} XP · ${d}-day streak`, levelUp: (lv) => `Level ${lv}!`, got: ' Unlocked: ', cooling: 'cooling down',
              fallback: { fed: 'Yum.', watered: 'Gulp.', pet: 'Mm… nice.', sleep: 'Zzz', wakeUp: 'Slept well.', wokenUp: '…who woke me?', hungry: '…kinda hungry.', thirsty: 'Thirsty.', tired: 'Sleepy…', lonely: "You haven't talked to me in a while." },
              titles: ['Newcomer', 'Regular', 'Acquaintance', 'Good friend', 'Caretaker', 'Buddy', 'Family', 'Old friend', 'Confidant', 'Soulmate'],
              rewards: { 2: 'New lines: clingy', 3: 'Outfit ticket ×1', 4: 'New lines: rambling', 5: 'Outfit ticket ×1', 6: 'Growth: teen (size +10%)', 7: 'Outfit ticket ×1', 8: 'New lines: old friend', 9: 'Holiday skin ticket ×1', 10: 'Growth: adult (size +20%)' } },
      beh: { follow: 'Right behind you.', hide: "I'll hide for a bit.", coming: 'Coming.', perch: 'Nice view up here.', perchHint: 'Click the window you want me to sit on.', typingLong: "That's a lot of typing. Break?", lowBattery: 'Battery is at {p}%!', greet: 'Hey, {name}.', thrown: '…did you just throw me?', cling: 'Hanging on!', climbBack: 'Almost fell.' },
      wardrobe: { menu: 'Wardrobe', default: 'Original' },
      teach: { menu: 'Take it to learn something new…', done: (f) => `Saved to your Desktop: ${f}. Drop it into the assistant chat and say what to teach.`, guide: 'How to use', guideMissing: 'No guide file in this pet package' },
      inter: { clickTea: 'Keep poking and I throw bubble tea — catch!', strokeLove: 'All these pets are going to my head~', garden: 'One more for the garden!', flowerBud: 'Huh, a bud on my head?', flowerBloom: 'It bloomed! Keep typing and it grows.', flowerPick: 'Picked it — keeping it next to me.' },
      menu2: { follow: 'Follow the mouse', unfollow: 'Stop following', come: 'Come here', hide: 'Hide', perch: 'Sit on the window', unperch: 'Get off the window', summon: 'Call another pet', release: 'Send this one away' },
      settings: { title: 'Kapi settings', scale: 'Display size (0.5 – 2)', save: 'Save' },
      connect: { title: 'Connect to your Capafy chat (enables talking)', risk: 'This needs your Capafy token. It is an account-level token: if leaked it could affect your other Capafy actions. Kapi keeps it only in the system credential store, never in files.',
        url: 'Full URL of the Capafy chat where you use Kapi (copy the browser address bar)', token: 'Capafy token (copy from your Capafy account page)', pick: 'No automatic match — pick the chat instance where Kapi lives', test: 'Test connection (sends nothing, costs nothing)',
        useSelected: 'Use selected instance', disconnect: 'Disconnect and delete credentials', display: 'Display', connectedTo: (id) => `Connected to this chat (${id})`, checking: 'Checking…', needToken: 'Paste the token first.',
        badToken: 'Token is invalid or expired.', netErr: (s) => `Could not reach Capafy (${s || 'network error'}).`, noInstances: 'No active chat instances on this account.', noMatch: 'The ID in that URL is not an active instance of this account — pick one below.', parseFail: 'Could not read an ID from that URL — pick one below.' },
      chatErr: { authExpired: 'Capafy login expired — enter the token again in Settings.', notFound: 'That Capafy chat was not found.', busy: "Still thinking about the last one.", tooFast: 'Too fast — give me a second.', quota: "Today's chat quota is used up. Top up on Capafy.", offline: 'Not connected.', notConnected: 'Not connected to Capafy yet: right-click → Settings, paste the chat URL and token.', timeout: 'Lost the connection — say it again?' },
    },
  };
  function pick(lang) {
    const l = String(lang || (typeof navigator !== 'undefined' ? navigator.language : 'en') || 'en').toLowerCase();
    if (l.startsWith('zh')) return STRINGS.zh;
    return STRINGS.en;
  }
  global.I18N = { strings: STRINGS, pick };
})(typeof window !== 'undefined' ? window : globalThis);
