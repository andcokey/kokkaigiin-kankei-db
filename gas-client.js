/* GAS接続クライアント（共通） */
(function (global) {
  var CFG_KEY = 'gmoKokkaiDb.gasConfig';
  var CACHE_PREFIX = 'gmoKokkaiDb.cache.';
  var CACHE_ACTIONS = ['listAll', 'listRelations', 'listContactsAll'];
  // これより新しいキャッシュは通信なしでそのまま使う（DBの更新頻度が低いため）。
  // これより古い場合は素直にGASへ取りに行く（更新確認の往復は挟まない。挟むと通信回数が増えて
  // GAS側の一時的な不調＝<!DOCTYPE...のHTMLが返るエラーに引っかかりやすくなるため）。
  var CACHE_TTL_MS = 60 * 60 * 1000;
  // 書き込み系アクション成功後、値が古くなるキャッシュを明示的に無効化する（次回は必ず最新を取得）
  var WRITE_INVALIDATES = {
    updateRelation: ['listRelations'],
    createRelation: ['listRelations', 'listAll'],
    addContact: ['listContactsAll'],
    updateContact: ['listContactsAll'],
    deleteContact: ['listContactsAll'],
    bulkImport: ['listAll', 'listRelations', 'listContactsAll']
  };

  function getConfig() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function setConfig(cfg) {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  }

  function ensureConfigured() {
    var cfg = getConfig();
    if (cfg.url && cfg.token) return cfg;
    var url = window.prompt('GASのウェブアプリURLを入力してください（一度入力すればこの端末に保存されます）', cfg.url || '');
    if (!url) return null;
    var token = window.prompt('合言葉（SHARED_TOKEN）を入力してください', cfg.token || '');
    if (!token) return null;
    cfg = { url: url.trim(), token: token.trim() };
    setConfig(cfg);
    return cfg;
  }

  function resetConfig() {
    localStorage.removeItem(CFG_KEY);
    clearListCache();
  }

  function readCache(action) {
    try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + action)); }
    catch (e) { return null; }
  }
  function writeCache(action, data) {
    try {
      localStorage.setItem(CACHE_PREFIX + action, JSON.stringify({ data: data, checkedAt: Date.now() }));
    } catch (e) { /* 容量超過等はキャッシュ無しで継続 */ }
  }
  function clearListCache() {
    CACHE_ACTIONS.forEach(function (action) {
      localStorage.removeItem(CACHE_PREFIX + action);
    });
  }

  function callGas(action, params) {
    var cfg = ensureConfigured();
    if (!cfg) return Promise.reject(new Error('GAS接続設定が未入力です'));
    var body = Object.assign({ action: action, token: cfg.token }, params || {});
    return fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' }, // CORSプリフライト回避
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.text(); })
      .then(function (text) {
        var json;
        try { json = JSON.parse(text); }
        catch (e) { throw new Error('サーバーから予期しない応答がありました（時間をおいて再度お試しください）'); }
        if (!json.ok) throw new Error(json.error || '不明なエラー');
        if (WRITE_INVALIDATES[action]) {
          WRITE_INVALIDATES[action].forEach(function (a) { localStorage.removeItem(CACHE_PREFIX + a); });
        }
        return json.data;
      });
  }

  /**
   * listAll / listRelations / listContactsAll をキャッシュ優先で取得する。
   * - 直近1時間以内に取得済みのキャッシュがあれば、通信なしでそのまま返す。
   * - それより古い場合、またはforce=trueの場合は素直に取得し直す。
   * - 取得に失敗した場合、古いキャッシュがあればそれを代わりに使う（無ければエラーを伝播）。
   */
  function callListCached(actions, force) {
    var out = {};
    var toFetch = [];
    actions.forEach(function (action) {
      var cached = force ? null : readCache(action);
      if (cached && (Date.now() - cached.checkedAt) < CACHE_TTL_MS) {
        out[action] = cached.data;
      } else {
        toFetch.push(action);
      }
    });
    if (!toFetch.length) return Promise.resolve(out);

    return Promise.all(toFetch.map(function (action) {
      return callGas(action).then(function (data) {
        writeCache(action, data);
        out[action] = data;
      }).catch(function (err) {
        var stale = readCache(action);
        if (stale) { out[action] = stale.data; return; }
        throw err;
      });
    })).then(function () { return out; });
  }

  function getCacheMeta(action) {
    var c = readCache(action);
    return c ? { checkedAt: c.checkedAt } : null;
  }

  global.GasClient = {
    call: callGas,
    ensureConfigured: ensureConfigured,
    resetConfig: resetConfig,
    getConfig: getConfig,
    callListCached: callListCached,
    clearListCache: clearListCache,
    getCacheMeta: getCacheMeta
  };
})(window);
