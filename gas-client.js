/* GAS接続クライアント（共通） */
(function (global) {
  // キー名を変更し、旧SHARED_TOKENを保持した端末のキャッシュを無効化して合言葉の再入力を促す
  var CFG_KEY = 'gmoKokkaiDb.workerConfig';
  // 実際のGAS URL・SHARED_TOKENはCloudflare Worker側のSecretsに隠蔽されている。
  // フロントはこの固定URLだけを知ればよい（Workerが合言葉を検証してGASに中継する）。
  var WORKER_URL = 'https://api.policy-office.com';

  function getConfig() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function setConfig(cfg) {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  }

  function ensureConfigured() {
    var cfg = getConfig();
    if (cfg.token) return cfg;
    var token = window.prompt('合言葉を入力してください（一度入力すればこの端末に保存されます）', cfg.token || '');
    if (!token) return null;
    cfg = { token: token.trim() };
    setConfig(cfg);
    return cfg;
  }

  function resetConfig() {
    localStorage.removeItem(CFG_KEY);
  }

  function callGas(action, params) {
    var cfg = ensureConfigured();
    if (!cfg) return Promise.reject(new Error('合言葉が未入力です'));
    var body = Object.assign({ action: action, token: cfg.token }, params || {});
    return fetch(WORKER_URL, {
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
        return json.data;
      });
  }

  /**
   * listAll / listRelations / listContactsAll をまとめて取得する。
   * キャッシュはGAS側（CacheService、全ユーザー・全端末で共有・1時間）で行うため、
   * フロント側はここで何もキャッシュしない。force=trueの場合はGAS側のキャッシュも
   * 無視して必ずNotionから最新を取得する（「最新を取得」ボタン用）。
   */
  function fetchLists(actions, force) {
    var out = {};
    return Promise.all(actions.map(function (action) {
      return callGas(action, force ? { force: true } : undefined).then(function (data) {
        out[action] = data;
      });
    })).then(function () { return out; });
  }

  global.GasClient = {
    call: callGas,
    ensureConfigured: ensureConfigured,
    resetConfig: resetConfig,
    getConfig: getConfig,
    fetchLists: fetchLists
  };
})(window);
