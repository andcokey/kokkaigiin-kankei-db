/**
 * GMO×国会議員 関係DB — GAS プロキシ
 *
 * スクリプトプロパティに以下を設定すること:
 *   NOTION_TOKEN  … Notion Integration のアクセストークン
 *   SHARED_TOKEN  … フロント側と共有する合言葉（任意の文字列）
 *
 * デプロイ: 「ウェブアプリとして導入」→ アクセスできるユーザー「全員」
 * フロント側は POST 時に Content-Type: text/plain を指定し、CORS プリフライトを回避すること。
 */

var NOTION_VERSION = '2025-09-03';

var DATA_SOURCES = {
  legislatorsAll: '46e6a7a6-899f-4f44-8ec1-818d68ad2626', // 議員マスタ（全体）
  relations:      'd56c2517-9c62-4e5d-978c-1d53c7a9cc21', // 関係マスタ（重点対象）
  contacts:       'd184116b-6236-4f6f-9a47-6c8e992c4e04', // 接触履歴
  qualityNotes:   'e4135d0e-d92c-4716-8b45-8c307453c63f'  // データ品質メモ
};

function doGet(e) {
  return handle(e);
}

function doPost(e) {
  return handle(e);
}

function handle(e) {
  try {
    var params = parseParams(e);
    var sharedToken = getProp('SHARED_TOKEN');
    if (!sharedToken || params.token !== sharedToken) {
      return jsonOut({ ok: false, error: '認証エラー: token不一致' });
    }

    var action = params.action;
    var result;
    switch (action) {
      case 'listAll':
        result = listLegislatorsAll(params.force);
        break;
      case 'listRelations':
        result = listRelations(params.force);
        break;
      case 'getContacts':
        result = getContactsByRelationId(params.relationPageId);
        break;
      case 'listContactsAll':
        result = listContactsAll(params.force);
        break;
      case 'getStaffOptions':
        result = getStaffOptions();
        break;
      case 'getQualityNotes':
        result = getQualityNotesByRelationId(params.relationPageId);
        break;
      case 'addContact':
        result = addContact(params);
        break;
      case 'updateRelation':
        result = updateRelation(params);
        break;
      case 'updateContact':
        result = updateContact(params);
        break;
      case 'deleteContact':
        result = deleteContact(params);
        break;
      case 'createRelation':
        result = createRelation(params);
        break;
      case 'bulkImport':
        result = bulkImport(params);
        break;
      case 'bulkUpdateDomainExpiry':
        result = bulkUpdateDomainExpiry(params);
        break;
      case 'createNonDietMember':
        result = createNonDietMember(params);
        break;
      case 'getNews':
        result = getNews(params);
        break;
      default:
        return jsonOut({ ok: false, error: '不明なaction: ' + action });
    }
    return jsonOut({ ok: true, data: result });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function parseParams(e) {
  if (e.postData && e.postData.contents) {
    try {
      var body = JSON.parse(e.postData.contents);
      return body || {};
    } catch (err) {
      // フォールバック: クエリパラメータ扱い
    }
  }
  return e.parameter || {};
}

function getProp(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- Notion API helpers ---------------- */

function notionFetch(path, method, payload) {
  var token = getProp('NOTION_TOKEN');
  var options = {
    method: method || 'get',
    headers: {
      Authorization: 'Bearer ' + token,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true
  };
  if (payload) options.payload = JSON.stringify(payload);

  var maxRetries = 3;
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    var resp = UrlFetchApp.fetch('https://api.notion.com/v1/' + path, options);
    var code = resp.getResponseCode();
    if (code === 429 && attempt < maxRetries) {
      Utilities.sleep(800 * (attempt + 1)); // レート制限: 一括インポート等の連続呼び出しで発生しうる
      continue;
    }
    var body = JSON.parse(resp.getContentText());
    if (code >= 300) {
      throw new Error('Notion API error ' + code + ': ' + (body.message || resp.getContentText()));
    }
    return body;
  }
}

function notionQueryAll(dataSourceId, filter, sorts) {
  var results = [];
  var cursor = null;
  do {
    var payload = {};
    if (filter) payload.filter = filter;
    if (sorts) payload.sorts = sorts;
    if (cursor) payload.start_cursor = cursor;
    var page = notionFetch('data_sources/' + dataSourceId + '/query', 'post', payload);
    results = results.concat(page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return results;
}

/* ---------------- プロパティ抽出 ---------------- */

function extractProp(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case 'title':
      return (prop.title || []).map(function (t) { return t.plain_text; }).join('');
    case 'rich_text':
      return (prop.rich_text || []).map(function (t) { return t.plain_text; }).join('');
    case 'select':
      return prop.select ? prop.select.name : null;
    case 'multi_select':
      return (prop.multi_select || []).map(function (s) { return s.name; });
    case 'number':
      return prop.number;
    case 'date':
      return prop.date ? prop.date.start : null;
    case 'url':
      return prop.url || null;
    case 'checkbox':
      return !!prop.checkbox;
    case 'relation':
      return (prop.relation || []).map(function (r) { return r.id; });
    default:
      return null;
  }
}

function extractPage(page, fieldMap) {
  var out = { id: page.id };
  for (var key in fieldMap) {
    out[key] = extractProp(page.properties[fieldMap[key]]);
  }
  return out;
}

/* ---------------- 共有キャッシュ（CacheService、全ユーザー・全端末で共有） ---------------- */

// listAll/listRelations/listContactsAllは重い（Notionのフルページネーション）ため、
// 全ユーザーで共有するサーバー側キャッシュを1時間保持する。CacheServiceの1キー100KB制限に
// 収めるため、JSON文字列をチャンク分割して複数キーに保存する。
var SHARED_CACHE_TTL_SECONDS = 60 * 60;
var SHARED_CACHE_CHUNK_SIZE = 90000;

function cacheGetList(action) {
  var cache = CacheService.getScriptCache();
  var meta = cache.get(action + '_meta');
  if (!meta) return null;
  var count = JSON.parse(meta).chunks;
  var keys = [];
  for (var i = 0; i < count; i++) keys.push(action + '_' + i);
  var parts = cache.getAll(keys);
  var chunks = [];
  for (var i = 0; i < count; i++) {
    var part = parts[action + '_' + i];
    if (part == null) return null; // 一部でも欠けていればキャッシュ無効とみなす
    chunks.push(part);
  }
  try { return JSON.parse(chunks.join('')); } catch (e) { return null; }
}

function cacheSetList(action, data) {
  var cache = CacheService.getScriptCache();
  var json = JSON.stringify(data);
  var chunks = [];
  for (var i = 0; i < json.length; i += SHARED_CACHE_CHUNK_SIZE) {
    chunks.push(json.slice(i, i + SHARED_CACHE_CHUNK_SIZE));
  }
  var payload = { };
  chunks.forEach(function (c, i) { payload[action + '_' + i] = c; });
  payload[action + '_meta'] = JSON.stringify({ chunks: chunks.length });
  cache.putAll(payload, SHARED_CACHE_TTL_SECONDS);
}

function cacheInvalidateList(action) {
  var cache = CacheService.getScriptCache();
  var meta = cache.get(action + '_meta');
  if (!meta) return;
  var count = JSON.parse(meta).chunks;
  var keys = [action + '_meta'];
  for (var i = 0; i < count; i++) keys.push(action + '_' + i);
  cache.removeAll(keys);
}

/**
 * キャッシュ優先でリストを取得する。force=trueならキャッシュを無視して必ず再取得する。
 */
function getCachedList(action, fetchFn, force) {
  if (!force) {
    var cached = cacheGetList(action);
    if (cached) return cached;
  }
  var data = fetchFn();
  cacheSetList(action, data);
  return data;
}

/* ---------------- アクション実装 ---------------- */

var ALL_FIELDS = {
  name: '氏名', kana: '読み', house: '議院', party: '政党', district: '選挙区',
  domain: 'ドメイン', domainService: 'ドメイン管理サービス', domainCompany: 'ドメイン管理会社',
  domainExpiry: 'ドメイン有効期限', domainCardExpiry: 'ドメイン決済カード有効期限', photoUrl: '顔写真URL',
  serverService: 'サーバー管理サービス', serverCompany: 'サーバー管理会社',
  hostingExpiry: 'ホスティング有効期限', hostingCardExpiry: 'ホスティング決済カード有効期限',
  sslVendor: 'SSLベンダー', sslExpiry: 'SSL有効期限', sslCardExpiry: 'SSL決済カード有効期限',
  siteSeal: 'サイトシール', currentPost: '現職役職',
  isCurrent: '現職', isDietMember: '国会議員である', isCabinetMember: '閣僚',
  relationId: '関係マスタ（重点対象）'
};

function listLegislatorsAll(force) {
  return getCachedList('listAll', function () {
    var pages = notionQueryAll(DATA_SOURCES.legislatorsAll);
    return pages.map(function (p) {
      var row = extractPage(p, ALL_FIELDS);
      row.relationId = (row.relationId && row.relationId[0]) || null;
      return row;
    });
  }, force);
}

var RELATION_FIELDS = {
  legislatorId: 'legislator_id', name: '氏名', party: '政党', house: '議院', district: '選挙区',
  currentPost: '現職役職', factionNotes: '派閥_備考', electionResult: '選挙結果',
  giftInRepName: '代表名で贈るか', internalContact: '社内担当コンタクト',
  note1: '備考1', note2Url: '備考2_URL等',
  zip: '送付先郵便番号', address: '送付先住所', phone: '送付先電話番号',
  isAdvisor: '顧問区分', advisorSince: '顧問就任日', advisorOfficer: '顧問担当役員',
  allMasterId: '議員マスタ（全体）', contactIds: '接触履歴', qualityNoteIds: 'データ品質メモ'
};

function listRelations(force) {
  return getCachedList('listRelations', function () {
    var pages = notionQueryAll(DATA_SOURCES.relations);
    return pages.map(function (p) {
      var row = extractPage(p, RELATION_FIELDS);
      row.allMasterId = (row.allMasterId && row.allMasterId[0]) || null;
      return row;
    });
  }, force);
}

var CONTACT_FIELDS = {
  summary: '概要', type: '種別', date: '日付', content: '内容',
  amount: '金額_円', units: '口数', note: '備考', rawText: '元テキスト',
  relationIds: '対象議員', staff: '対応者', place: '場所', gift: 'お手土産'
};

function getContactsByRelationId(relationPageId) {
  if (!relationPageId) throw new Error('relationPageId が必要です');
  var filter = { property: '対象議員', relation: { contains: relationPageId } };
  var sorts = [{ property: '日付', direction: 'descending' }];
  var pages = notionQueryAll(DATA_SOURCES.contacts, filter, sorts);
  return pages.map(function (p) { return extractPage(p, CONTACT_FIELDS); });
}

function listContactsAll(force) {
  return getCachedList('listContactsAll', function () {
    var sorts = [{ property: '日付', direction: 'descending' }];
    var pages = notionQueryAll(DATA_SOURCES.contacts, null, sorts);
    return pages.map(function (p) {
      var row = extractPage(p, CONTACT_FIELDS);
      row.relationId = (row.relationIds && row.relationIds[0]) || null;
      return row;
    });
  }, force);
}

/**
 * 接触履歴「対応者」列の選択肢一覧を返す（フロントの入力候補・絞り込みチップ用）。
 * 新しい名前を追加したい場合は入力フォームで自由入力すれば、addContact/updateContact時に
 * Notion側へ新しい選択肢として自動追加される（このリストにも次回以降反映される）。
 */
function getStaffOptions() {
  var ds = notionFetch('data_sources/' + DATA_SOURCES.contacts, 'get');
  var prop = ds.properties && ds.properties['対応者'];
  if (!prop || !prop.multi_select) return [];
  return prop.multi_select.options.map(function (o) { return o.name; });
}

var QUALITY_NOTE_FIELDS = { summary: '概要', item: '項目', content: '内容' };

function getQualityNotesByRelationId(relationPageId) {
  if (!relationPageId) throw new Error('relationPageId が必要です');
  var filter = { property: '対象議員', relation: { contains: relationPageId } };
  var pages = notionQueryAll(DATA_SOURCES.qualityNotes, filter);
  return pages.map(function (p) { return extractPage(p, QUALITY_NOTE_FIELDS); });
}

/**
 * 履歴を追加（面談 / セミナー献金〈パーティー券購入〉）
 * params: relationPageId, type(種別), date(YYYY-MM-DD), content(内容), note(備考), amount(金額_円, optional),
 *         staff(対応者, string[], optional), place(場所, optional), gift(お手土産, optional)
 */
function addContact(params) {
  if (!params.relationPageId) throw new Error('relationPageId が必要です');
  if (!params.type) throw new Error('type(種別) が必要です');

  var properties = {
    '概要': { title: [{ text: { content: String(params.summary || params.content || params.type) } }] },
    '種別': { select: { name: params.type } },
    '内容': { rich_text: [{ text: { content: String(params.content || '') } }] },
    '備考': { rich_text: [{ text: { content: String(params.note || '') } }] },
    '場所': { rich_text: [{ text: { content: String(params.place || '') } }] },
    'お手土産': { rich_text: [{ text: { content: String(params.gift || '') } }] },
    '対応者': { multi_select: (params.staff || []).map(function (name) { return { name: String(name) }; }) },
    '対象議員': { relation: [{ id: params.relationPageId }] }
  };
  if (params.date) {
    properties['日付'] = { date: { start: params.date } };
  }
  if (params.amount) {
    properties['金額_円'] = { number: Number(params.amount) };
  }

  var body = {
    parent: { data_source_id: DATA_SOURCES.contacts },
    properties: properties
  };
  var page = notionFetch('pages', 'post', body);
  cacheInvalidateList('listContactsAll');
  return { id: page.id };
}

/* ---------------- 編集・削除（社内担当／接触履歴） ---------------- */

function buildPropertyPayload(type, value) {
  switch (type) {
    case 'title':
      return { title: [{ text: { content: String(value || '') } }] };
    case 'rich_text':
      return { rich_text: [{ text: { content: String(value || '') } }] };
    case 'select':
      return value ? { select: { name: String(value) } } : { select: null };
    case 'multi_select':
      return { multi_select: (value || []).map(function (name) { return { name: String(name) }; }) };
    case 'number':
      return { number: (value === '' || value == null) ? null : Number(value) };
    case 'date':
      return value ? { date: { start: value } } : { date: null };
    case 'checkbox':
      return { checkbox: !!value };
    default:
      throw new Error('未対応のプロパティ型: ' + type);
  }
}

function buildUpdateProperties(fieldMap, editableTypes, params, required) {
  var properties = {};
  for (var key in editableTypes) {
    if (params[key] !== undefined) {
      properties[fieldMap[key]] = buildPropertyPayload(editableTypes[key], params[key]);
    }
  }
  if (required !== false && !Object.keys(properties).length) throw new Error('更新する項目がありません');
  return properties;
}

/**
 * 関係マスタの各項目を編集
 * params: relationPageId, house/party/district/factionNotes/currentPost/electionResult/
 *         internalContact/giftInRepName/zip/address/phone/note1/note2Url/
 *         isAdvisor/advisorSince/advisorOfficer のうち更新したいもの
 */
var RELATION_EDITABLE_TYPES = {
  house: 'rich_text', party: 'rich_text', district: 'rich_text', factionNotes: 'rich_text',
  currentPost: 'rich_text', electionResult: 'rich_text',
  internalContact: 'rich_text', giftInRepName: 'rich_text',
  zip: 'rich_text', address: 'rich_text', phone: 'rich_text',
  note1: 'rich_text', note2Url: 'rich_text',
  isAdvisor: 'checkbox', advisorSince: 'date', advisorOfficer: 'rich_text'
};

function updateRelation(params) {
  if (!params.relationPageId) throw new Error('relationPageId が必要です');
  var properties = buildUpdateProperties(RELATION_FIELDS, RELATION_EDITABLE_TYPES, params);
  notionFetch('pages/' + params.relationPageId, 'patch', { properties: properties });
  cacheInvalidateList('listRelations');
  return { id: params.relationPageId };
}

/**
 * 議員マスタ（全体）の議員を関係マスタに新規登録する
 * params: allMasterId, name(氏名), party(政党), house(議院), district(選挙区), currentPost(現職役職, optional)
 * legislator_id は既存の最大値+1を自動採番する
 */
function nextLegislatorId(existingIds) {
  var max = 0;
  existingIds.forEach(function (id) {
    var m = /^L(\d+)$/.exec(id || '');
    if (m) {
      var n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  });
  var s = String(max + 1);
  while (s.length < 3) s = '0' + s;
  return 'L' + s;
}

function createRelation(params) {
  if (!params.allMasterId) throw new Error('allMasterId が必要です');

  var existing = listRelations();
  var legislatorId = nextLegislatorId(existing.map(function (r) { return r.legislatorId; }));

  var properties = {
    '氏名': { title: [{ text: { content: String(params.name || '') } }] },
    'legislator_id': { rich_text: [{ text: { content: legislatorId } }] },
    '議員マスタ（全体）': { relation: [{ id: params.allMasterId }] }
  };
  ['party', 'house', 'district', 'currentPost'].forEach(function (key) {
    properties[RELATION_FIELDS[key]] = { rich_text: [{ text: { content: String(params[key] || '') } }] };
  });

  var body = { parent: { data_source_id: DATA_SOURCES.relations }, properties: properties };
  var page = notionFetch('pages', 'post', body);
  cacheInvalidateList('listRelations');
  cacheInvalidateList('listAll'); // 議員マスタ（全体）側の逆リレーション（relationId）も変わるため
  return { id: page.id, legislatorId: legislatorId };
}

/**
 * 議員マスタ（全体）に、国会議員でない閣僚等を新規登録する（議院・選挙区は空欄のまま）。
 * params: name(氏名), currentPost(現職役職), party(政党, optional)
 */
function createNonDietMember(params) {
  if (!params.name) throw new Error('name(氏名) が必要です');

  var properties = {
    '氏名': { title: [{ text: { content: String(params.name) } }] },
    '現職役職': { rich_text: [{ text: { content: String(params.currentPost || '') } }] },
    '政党': { rich_text: [{ text: { content: String(params.party || '') } }] },
    '国会議員である': { checkbox: false },
    '現職': { checkbox: true },
    '閣僚': { checkbox: true }
  };

  var body = { parent: { data_source_id: DATA_SOURCES.legislatorsAll }, properties: properties };
  var page = notionFetch('pages', 'post', body);
  cacheInvalidateList('listAll');
  return { id: page.id };
}

/**
 * 接触履歴（面談・贈答・セミナー献金）を編集
 * params: contactPageId, type(種別), date(日付), content(内容), note(備考), amount(金額_円), summary(概要)
 */
var CONTACT_EDITABLE_TYPES = {
  type: 'select', date: 'date', content: 'rich_text', note: 'rich_text', amount: 'number', summary: 'title',
  staff: 'multi_select', place: 'rich_text', gift: 'rich_text'
};

function updateContact(params) {
  if (!params.contactPageId) throw new Error('contactPageId が必要です');
  var properties = buildUpdateProperties(CONTACT_FIELDS, CONTACT_EDITABLE_TYPES, params);
  notionFetch('pages/' + params.contactPageId, 'patch', { properties: properties });
  cacheInvalidateList('listContactsAll');
  return { id: params.contactPageId };
}

/**
 * 接触履歴を削除（Notion上はアーカイブ）
 * params: contactPageId
 */
function deleteContact(params) {
  if (!params.contactPageId) throw new Error('contactPageId が必要です');
  notionFetch('pages/' + params.contactPageId, 'patch', { archived: true });
  cacheInvalidateList('listContactsAll');
  return { id: params.contactPageId, archived: true };
}

/* ---------------- 一括インポート（CSV） ---------------- */

var BULK_RELATION_FIELD_KEYS = [
  'house', 'party', 'district', 'currentPost', 'electionResult', 'factionNotes',
  'internalContact', 'giftInRepName', 'zip', 'address', 'phone', 'note1', 'note2Url'
];

/**
 * CSVの1行から関係マスタを解決する（legislator_id優先、なければ氏名で既存関係／議員マスタ全体を検索）。
 * 該当する関係マスタが無く議員マスタ全体に一意に一致する場合は新規登録する。
 */
function resolveRelationForBulkRow(row, relations, allRows) {
  if (row.legislatorId) {
    var byId = relations.filter(function (r) { return r.legislatorId === row.legislatorId; })[0];
    if (!byId) throw new Error('legislator_id "' + row.legislatorId + '" が関係マスタに見つかりません');
    return { id: byId.id, name: byId.name, legislatorId: byId.legislatorId, created: false, relations: relations };
  }

  if (!row.name) throw new Error('氏名またはlegislator_idが必要です');

  var byName = relations.filter(function (r) { return r.name === row.name; })[0];
  if (byName) {
    return { id: byName.id, name: byName.name, legislatorId: byName.legislatorId, created: false, relations: relations };
  }

  var matches = allRows.filter(function (r) { return r.name === row.name; });
  if (!matches.length) throw new Error('氏名 "' + row.name + '" が議員マスタ（全体）に見つかりません');
  if (matches.length > 1) throw new Error('氏名 "' + row.name + '" が複数該当し一意に決定できません（legislator_idで指定してください）');
  var allRow = matches[0];

  var created = createRelation({
    allMasterId: allRow.id,
    name: row.name,
    party: row.party || allRow.party,
    house: row.house || allRow.house,
    district: row.district || allRow.district,
    currentPost: row.currentPost || allRow.currentPost
  });

  var newRel = {
    id: created.id, name: row.name, legislatorId: created.legislatorId,
    party: row.party || allRow.party, house: row.house || allRow.house, district: row.district || allRow.district,
    allMasterId: allRow.id
  };
  return { id: created.id, name: row.name, legislatorId: created.legislatorId, created: true, relations: relations.concat([newRel]) };
}

/**
 * CSVから一括で「関係マスタへの新規登録／項目更新」「接触履歴の追加」を行う。
 * params: rows = [{ legislatorId, name, house, party, district, currentPost, electionResult,
 *                    factionNotes, internalContact, giftInRepName, zip, address, phone, note1, note2Url,
 *                    type, date, content, note, amount }, ...]
 * 各項目は空欄（''）なら「変更しない」扱い（既存値を保持）。type欄が空欄の行は接触履歴を追加しない。
 * 1行の失敗は他の行に影響せず、結果は行ごとにerrorとして返す。
 */
function bulkImport(params) {
  if (!params.rows || !params.rows.length) throw new Error('rowsが必要です');

  var relations = listRelations();
  var allRows = listLegislatorsAll();
  var results = [];

  params.rows.forEach(function (row, idx) {
    var rowNo = idx + 1;
    var displayName = row.name || row.legislatorId || ('行' + rowNo);
    try {
      var resolved = resolveRelationForBulkRow(row, relations, allRows);
      relations = resolved.relations;

      var nonEmptyRow = {};
      BULK_RELATION_FIELD_KEYS.forEach(function (key) {
        if (row[key] !== undefined && row[key] !== '') nonEmptyRow[key] = row[key];
      });
      var updateProps = buildUpdateProperties(RELATION_FIELDS, RELATION_EDITABLE_TYPES, nonEmptyRow, false);
      if (Object.keys(updateProps).length) {
        notionFetch('pages/' + resolved.id, 'patch', { properties: updateProps });
        cacheInvalidateList('listRelations');
      }

      var contactAdded = false;
      if (row.type) {
        addContact({
          relationPageId: resolved.id,
          type: row.type,
          date: row.date,
          content: row.content,
          note: row.note,
          amount: row.amount,
          summary: row.type + '：' + resolved.name + ' ' + String(row.content || '').slice(0, 20)
        });
        contactAdded = true;
      }

      results.push({
        row: rowNo, name: resolved.name, legislatorId: resolved.legislatorId,
        created: resolved.created, updated: Object.keys(updateProps).length > 0,
        contactAdded: contactAdded, error: null
      });
    } catch (err) {
      results.push({ row: rowNo, name: displayName, error: String(err.message || err) });
    }
  });

  return { results: results };
}

/* ---------------- ドメイン・サーバー・SSL情報の一括更新（CSV） ---------------- */

var ALL_MASTER_EDITABLE_TYPES = {
  domain: 'rich_text', domainService: 'rich_text', domainCompany: 'rich_text',
  domainExpiry: 'date', domainCardExpiry: 'date',
  serverService: 'rich_text', serverCompany: 'rich_text',
  hostingExpiry: 'date', hostingCardExpiry: 'date',
  sslVendor: 'rich_text', sslExpiry: 'date', sslCardExpiry: 'date', siteSeal: 'select'
};

/**
 * CSVの1行から議員マスタ（全体）の対象ページを解決する。
 * ドメイン指定があればドメインの完全一致を優先（表記ゆれ・同姓同名を避けられるため）、
 * 無ければ氏名の完全一致で解決する。0件・複数件はエラーとする（推測して更新しない）。
 */
function resolveLegislatorForDomainRow(row, allRows) {
  var matches;
  if (row.domain) {
    matches = allRows.filter(function (r) { return r.domain === row.domain; });
    if (!matches.length) throw new Error('ドメイン "' + row.domain + '" が議員マスタ（全体）に見つかりません');
  } else {
    if (!row.name) throw new Error('氏名またはドメインが必要です');
    matches = allRows.filter(function (r) { return r.name === row.name; });
    if (!matches.length) throw new Error('氏名 "' + row.name + '" が議員マスタ（全体）に見つかりません');
  }
  if (matches.length > 1) throw new Error('複数の候補が見つかりました（ドメインを指定して絞り込んでください）');
  return matches[0];
}

/**
 * CSVから議員マスタ（全体）のドメイン・サーバー・SSL情報（有効期限・決済カード有効期限含む）を一括更新する。
 * params: rows = [{ name(氏名, optional), domain(ドメイン, 一致確認・絞り込み用, optional),
 *                    expiry(ドメイン有効期限, YYYY-MM-DD), domainService, domainCompany, domainCardExpiry,
 *                    serverService, serverCompany, hostingExpiry, hostingCardExpiry,
 *                    sslVendor, sslExpiry(SSL有効期限, YYYY-MM-DD), sslCardExpiry, siteSeal }, ...]
 * name/domainのいずれかで対象議員を一意に特定できる行のみ更新する。空欄の項目は「変更しない」扱い。
 * 1行の失敗は他の行に影響しない。
 */
function bulkUpdateDomainExpiry(params) {
  if (!params.rows || !params.rows.length) throw new Error('rowsが必要です');

  var allRows = listLegislatorsAll();
  var results = [];

  params.rows.forEach(function (row, idx) {
    var rowNo = idx + 1;
    var displayName = row.name || row.domain || ('行' + rowNo);
    try {
      var legislator = resolveLegislatorForDomainRow(row, allRows);
      var editRow = { domainExpiry: row.expiry };
      ['domainService', 'domainCompany', 'domainCardExpiry',
       'serverService', 'serverCompany', 'hostingExpiry', 'hostingCardExpiry',
       'sslVendor', 'sslExpiry', 'sslCardExpiry', 'siteSeal'].forEach(function (key) {
        editRow[key] = row[key];
      });
      var nonEmptyRow = {};
      Object.keys(ALL_MASTER_EDITABLE_TYPES).forEach(function (key) {
        if (editRow[key] !== undefined && editRow[key] !== '') nonEmptyRow[key] = editRow[key];
      });
      var updateProps = buildUpdateProperties(ALL_FIELDS, ALL_MASTER_EDITABLE_TYPES, nonEmptyRow);
      notionFetch('pages/' + legislator.id, 'patch', { properties: updateProps });
      results.push({ row: rowNo, name: legislator.name, domain: legislator.domain, error: null });
    } catch (err) {
      results.push({ row: rowNo, name: displayName, error: String(err.message || err) });
    }
  });

  cacheInvalidateList('listAll');
  return { results: results };
}

/* ---------------- ニュース（Google News RSS経由） ---------------- */

var NEWS_LIMIT = 20;

function getChildText(el, name) {
  var child = el.getChild(name);
  return child ? child.getText() : '';
}

/**
 * 氏名でGoogle Newsを検索し、関連ニュースを取得する（同姓同名のニュースが混在する可能性あり）。
 * params: name(氏名)
 */
function getNews(params) {
  if (!params.name) throw new Error('nameが必要です');
  var query = '"' + String(params.name).trim() + '" 議員';
  var url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) + '&hl=ja&gl=JP&ceid=JP:ja';
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() >= 300) {
    throw new Error('ニュース取得エラー: HTTP ' + resp.getResponseCode());
  }
  var doc = XmlService.parse(resp.getContentText());
  var channel = doc.getRootElement().getChild('channel');
  var items = channel ? channel.getChildren('item') : [];
  return items.slice(0, NEWS_LIMIT).map(function (item) {
    var sourceEl = item.getChild('source');
    var source = sourceEl ? sourceEl.getText() : '';
    var title = getChildText(item, 'title');
    var suffix = ' - ' + source;
    if (source && title.slice(-suffix.length) === suffix) {
      title = title.slice(0, -suffix.length);
    }
    return { title: title, link: getChildText(item, 'link'), pubDate: getChildText(item, 'pubDate'), source: source };
  });
}

/* ---------------- 一回限りの移行スクリプト ---------------- */

/**
 * 「現職」「国会議員である」プロパティを議員マスタ（全体）に追加した直後に、
 * スクリプトエディタから1回だけ手動実行する（Webアクションとしては公開しない）。
 * 既存712名は全員「現職の国会議員」として作られたスナップショットのため、両方trueに揃える。
 *
 * 712件を1回の実行で処理すると6分の実行時間上限に引っかかるため、100件ずつのバッチに分割し、
 * 続きがあれば時間主導トリガーで数秒後に自分自身を再実行する（実行を1回押すだけで、
 * 完了まで自動的にバッチを繋いでいく）。途中で失敗しても未完了分から再実行すれば良い
 * （checkboxをtrueにするだけの操作なので、同じ行を再実行しても害はない）。
 * 完了後にこの関数を消す必要はない。
 */
var MIGRATE_FLAGS_BATCH_SIZE = 100;
var MIGRATE_FLAGS_OFFSET_KEY = 'migrateFlags_offset';

function migrateSetDefaultFlagsForAllLegislators() {
  deleteTriggersFor_('migrateSetDefaultFlagsForAllLegislators');

  var props = PropertiesService.getScriptProperties();
  var offset = Number(props.getProperty(MIGRATE_FLAGS_OFFSET_KEY) || '0');
  var pages = notionQueryAll(DATA_SOURCES.legislatorsAll);
  var end = Math.min(offset + MIGRATE_FLAGS_BATCH_SIZE, pages.length);

  for (var i = offset; i < end; i++) {
    notionFetch('pages/' + pages[i].id, 'patch', {
      properties: { '現職': { checkbox: true }, '国会議員である': { checkbox: true } }
    });
  }
  Logger.log('processed ' + offset + '〜' + end + ' / ' + pages.length);

  if (end < pages.length) {
    props.setProperty(MIGRATE_FLAGS_OFFSET_KEY, String(end));
    ScriptApp.newTrigger('migrateSetDefaultFlagsForAllLegislators').timeBased().after(5000).create();
  } else {
    props.deleteProperty(MIGRATE_FLAGS_OFFSET_KEY);
    cacheInvalidateList('listAll');
    Logger.log('完了: ' + pages.length + '件を更新しました');
  }
  return { processed: end, total: pages.length };
}

function deleteTriggersFor_(functionName) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === functionName) ScriptApp.deleteTrigger(t);
  });
}
