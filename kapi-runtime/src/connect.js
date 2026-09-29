// Capafy connection helpers: URL candidate extraction + validation against the account's instances. Pure logic, testable.
(function (global) {
  'use strict';
  const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

  /** Extract candidate instance/conversation ids from a pasted Capafy URL. Never trusts them without validation. */
  function extractCandidates(rawUrl) {
    const out = new Set();
    const add = (v) => { if (v && ID_RE.test(v) && /\d/.test(v)) out.add(v); };
    let url = String(rawUrl || '').trim();
    if (url.length > 2048) return [];
    const tryUrl = (u) => {
      let parsed; try { parsed = new URL(u); } catch (_) { return; }
      const params = new URLSearchParams(parsed.search);
      for (const k of ['instanceId', 'instance_id', 'instance', 'conversationId', 'conversation_id', 'id', 'cid']) add(params.get(k));
      const hash = parsed.hash.replace(/^#\/?/, '');
      if (hash) {
        const [hp, hq] = hash.split('?');
        if (hq) { const hpar = new URLSearchParams(hq); for (const k of ['instanceId', 'instance_id', 'instance', 'conversationId', 'conversation_id', 'id']) add(hpar.get(k)); }
        for (const seg of hp.split('/')) add(seg);
      }
      for (const seg of parsed.pathname.split('/')) add(seg);
    };
    tryUrl(url);
    try { const dec = decodeURIComponent(url); if (dec !== url) tryUrl(dec); } catch (_) {}
    return [...out];
  }

  /** Match candidates against the instance list; returns {instanceId} for a unique match, else {instances} for the user to pick. */
  function matchInstance(candidates, instances) {
    const ids = (instances || []).map(i => i.instanceId).filter(Boolean);
    const hits = candidates.filter(c => ids.includes(c));
    if (hits.length === 1) return { instanceId: hits[0] };
    return { instances: instances || [] };
  }

  /** Build the message content the skill expects. */
  function buildContent(message, ctx) {
    const lines = ['[petchat]', `用户消息：${message}`];
    if (ctx.localTime) lines.push(`本地时间：${ctx.localTime}`);
    if (ctx.lastAction) lines.push(`桌宠上一动作：${ctx.lastAction}`);
    if (ctx.actions && ctx.actions.length) lines.push(`可用动作：${ctx.actions.join(',')}`);
    if (ctx.expressions && ctx.expressions.length) lines.push(`可用表情：${ctx.expressions.join(',')}`);
    return lines.join('\n');
  }

  /** Strip [action:x] / [expr:x]; only known ids are returned. */
  function parseTags(text, knownActions, knownExprs) {
    let action = null, expr = null;
    const cleaned = String(text || '').replace(/\[(action|expr):([a-z0-9_\-]+)\]/gi, (m, k, v) => {
      v = v.toLowerCase();
      if (k.toLowerCase() === 'action' && knownActions.includes(v)) action = v;
      if (k.toLowerCase() === 'expr' && knownExprs.includes(v)) expr = v;
      return '';
    }).replace(/\s+$/g, '').trim();
    return { text: cleaned, action, expr };
  }

  /** Map an API error to a user-facing key. */
  function errorKey(status, body) {
    const b = typeof body === 'string' ? body : JSON.stringify(body || '');
    if (status === 401) return 'authExpired';
    if (status === 404) return 'notFound';
    if (status === 409) return 'busy';
    if (status === 429) return 'tooFast';
    if (status === 402 || /quota|subscription|credit|balance|insufficient|expired|额度|套餐|订阅/i.test(b)) return 'quota';
    return 'offline';
  }

  global.Connect = { extractCandidates, matchInstance, buildContent, parseTags, errorKey };
})(typeof window !== 'undefined' ? window : globalThis);
