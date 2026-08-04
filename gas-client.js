/* GAS接続クライアント（共通） */
(function (global) {
  var CFG_KEY = 'gmoKokkaiDb.gasConfig';
  var CACHE_PREFIX = 'gmoKokkaiDb.cache.';
  // これより新しいキャッシュは更新チェックの通信すら行わず即表示する（DBの更新頻度が低いため）
  var CHECK_INTERVAL_MS = 60 * 60 * 1000;
  // listAll/listRelations/listContactsAll がそれぞれどのNotionデータソースに対応するか（checkUpdatedのキーと一致）
  var DS_FOR_ACTION = { listAll: 'legislatorsAll', listRelations: 'relations', listContactsAll: 'contacts' };
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
  function writeCache(action, data, remoteEditedAt) {
    try {
      localStorage.setItem(CACHE_PREFIX + action, JSON.stringify({
        data: data, remoteEditedAt: remoteEditedAt, checkedAt: Date.now()
      }));
    } catch (e) { /* 容量超過等はキャッシュ無しで継続 */ }
  }
  function touchCache(action) {
    var c = readCache(action);
    if (c) writeCache(action, c.data, c.remoteEditedAt);
  }
  function clearListCache() {
    Object.keys(DS_FOR_ACTION).forEach(function (action) {
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
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (!json.ok) throw new Error(json.error || '不明なエラー');
        if (WRITE_INVALIDATES[action]) {
          WRITE_INVALIDATES[action].forEach(function (a) { localStorage.removeItem(CACHE_PREFIX + a); });
        }
        return json.data;
      });
  }

  /**
   * listAll / listRelations / listContactsAll をキャッシュ優先で取得する。
   * - 直近1時間以内にチェック済みのキャッシュがあれば、通信なしでそのまま返す。
   * - それより古い場合のみ軽量な checkUpdated（各データソースの最新更新時刻だけを見る）を呼び、
   *   実際にNotion側で更新があったものだけ再取得する。
   * - force=true の場合はキャッシュ鮮度を無視し、必ずcheckUpdated経由で最新を確認する（更新ボタン用）。
   */
  function callListCached(actions, force) {
    var out = {};
    var needsCheck = [];
    actions.forEach(function (action) {
      var cached = force ? null : readCache(action);
      if (cached && (Date.now() - cached.checkedAt) < CHECK_INTERVAL_MS) {
        out[action] = cached.data;
      } else {
        needsCheck.push(action);
      }
    });
    if (!needsCheck.length) return Promise.resolve(out);

    return callGas('checkUpdated').then(function (timestamps) {
      var toFetch = [];
      needsCheck.forEach(function (action) {
        var cached = force ? null : readCache(action);
        var dsKey = DS_FOR_ACTION[action];
        if (cached && cached.remoteEditedAt === timestamps[dsKey]) {
          out[action] = cached.data;
          touchCache(action);
        } else {
          toFetch.push(action);
        }
      });
      if (!toFetch.length) return out;
      return Promise.all(toFetch.map(function (action) {
        return callGas(action).then(function (data) {
          writeCache(action, data, timestamps[DS_FOR_ACTION[action]]);
          out[action] = data;
        });
      })).then(function () { return out; });
    });
  }

  function getCacheMeta(action) {
    var c = readCache(action);
    return c ? { checkedAt: c.checkedAt, remoteEditedAt: c.remoteEditedAt } : null;
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
