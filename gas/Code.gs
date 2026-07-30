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
        result = listLegislatorsAll();
        break;
      case 'listRelations':
        result = listRelations();
        break;
      case 'getContacts':
        result = getContactsByRelationId(params.relationPageId);
        break;
      case 'listContactsAll':
        result = listContactsAll();
        break;
      case 'getQualityNotes':
        result = getQualityNotesByRelationId(params.relationPageId);
        break;
      case 'addContact':
        result = addContact(params);
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
  var resp = UrlFetchApp.fetch('https://api.notion.com/v1/' + path, options);
  var code = resp.getResponseCode();
  var body = JSON.parse(resp.getContentText());
  if (code >= 300) {
    throw new Error('Notion API error ' + code + ': ' + (body.message || resp.getContentText()));
  }
  return body;
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
    case 'number':
      return prop.number;
    case 'date':
      return prop.date ? prop.date.start : null;
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

/* ---------------- アクション実装 ---------------- */

var ALL_FIELDS = {
  name: '氏名', kana: '読み', house: '議院', party: '政党', district: '選挙区',
  domain: 'ドメイン', domainService: 'ドメイン管理サービス', domainCompany: 'ドメイン管理会社',
  serverService: 'サーバー管理サービス', serverCompany: 'サーバー管理会社',
  sslVendor: 'SSLベンダー', siteSeal: 'サイトシール',
  relationId: '関係マスタ（重点対象）'
};

function listLegislatorsAll() {
  var pages = notionQueryAll(DATA_SOURCES.legislatorsAll);
  return pages.map(function (p) {
    var row = extractPage(p, ALL_FIELDS);
    row.relationId = (row.relationId && row.relationId[0]) || null;
    return row;
  });
}

var RELATION_FIELDS = {
  legislatorId: 'legislator_id', name: '氏名', party: '政党', house: '議院', district: '選挙区',
  currentPost: '現職役職', factionNotes: '派閥_備考', electionResult: '選挙結果',
  giftInRepName: '代表名で贈るか', internalContact: '社内担当コンタクト',
  note1: '備考1', note2Url: '備考2_URL等',
  zip: '送付先郵便番号', address: '送付先住所', phone: '送付先電話番号',
  allMasterId: '議員マスタ（全体）', contactIds: '接触履歴', qualityNoteIds: 'データ品質メモ'
};

function listRelations() {
  var pages = notionQueryAll(DATA_SOURCES.relations);
  return pages.map(function (p) {
    var row = extractPage(p, RELATION_FIELDS);
    row.allMasterId = (row.allMasterId && row.allMasterId[0]) || null;
    return row;
  });
}

var CONTACT_FIELDS = {
  summary: '概要', type: '種別', date: '日付', content: '内容',
  amount: '金額_円', units: '口数', note: '備考', rawText: '元テキスト',
  relationIds: '対象議員'
};

function getContactsByRelationId(relationPageId) {
  if (!relationPageId) throw new Error('relationPageId が必要です');
  var filter = { property: '対象議員', relation: { contains: relationPageId } };
  var sorts = [{ property: '日付', direction: 'descending' }];
  var pages = notionQueryAll(DATA_SOURCES.contacts, filter, sorts);
  return pages.map(function (p) { return extractPage(p, CONTACT_FIELDS); });
}

function listContactsAll() {
  var sorts = [{ property: '日付', direction: 'descending' }];
  var pages = notionQueryAll(DATA_SOURCES.contacts, null, sorts);
  return pages.map(function (p) {
    var row = extractPage(p, CONTACT_FIELDS);
    row.relationId = (row.relationIds && row.relationIds[0]) || null;
    return row;
  });
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
 * params: relationPageId, type(種別), date(YYYY-MM-DD), content(内容), note(備考), amount(金額_円, optional)
 */
function addContact(params) {
  if (!params.relationPageId) throw new Error('relationPageId が必要です');
  if (!params.type) throw new Error('type(種別) が必要です');

  var properties = {
    '概要': { title: [{ text: { content: String(params.summary || params.content || params.type) } }] },
    '種別': { select: { name: params.type } },
    '内容': { rich_text: [{ text: { content: String(params.content || '') } }] },
    '備考': { rich_text: [{ text: { content: String(params.note || '') } }] },
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
  return { id: page.id };
}
