// script.js の純粋関数を Node.js 標準のテストランナーで検証する（外部ライブラリ不要）。
// 実行: node --test script.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** ブラウザと同じくクラシックスクリプトとして読み込み、公開された AiToolMemo を取り出す */
function loadApp() {
  const source = fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8');
  const logs = [];
  const context = vm.createContext({
    console: { error: (...args) => logs.push(args) },
    crypto: globalThis.crypto,
    Intl,
  });
  const app = vm.runInContext(`${source}\n;AiToolMemo;`, context);
  return { app, logs };
}

const { app } = loadApp();

/** vm 内で生成されたオブジェクトはプロトタイプが異なるため、比較前に通常のオブジェクトへ変換する */
const plain = (value) => JSON.parse(JSON.stringify(value));

const tools = () => app.createInitialTools();

function createFakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  };
}

// ---------------------------------------------------------------------------

test('初期データは指定の3件で、ID が一意', () => {
  const initial = plain(tools());
  assert.deepEqual(
    initial.map(({ name, monthly, memo }) => ({ name, monthly, memo })),
    [
      { name: 'Alpha', monthly: 3000, memo: '文章' },
      { name: 'Beta', monthly: 0, memo: '調査' },
      { name: 'Gamma', monthly: 5000, memo: '画像' },
    ],
  );
  assert.equal(new Set(initial.map((t) => t.id)).size, 3);
  assert.equal(app.parseToolList(initial).ok, true);
});

test('料金表示は桁区切りと「円」', () => {
  assert.equal(app.formatYen(3000), '3,000円');
  assert.equal(app.formatYen(0), '0円');
  assert.equal(app.formatYen(Number.MAX_SAFE_INTEGER), '9,007,199,254,740,991円');
});

test.describe('入力検証: 名前', () => {
  const validate = (name, editingId = null) =>
    app.validateToolInput({ name, monthly: '100', memo: '' }, tools(), editingId);

  test('空欄・空白のみは不可', () => {
    for (const name of ['', '   ', '　\t']) {
      const result = validate(name);
      assert.equal(result.ok, false);
      assert.match(result.errors.name, /名前を入力/);
    }
  });

  test('前後の空白は除去して登録', () => {
    const result = validate('  Delta  ');
    assert.equal(result.ok, true);
    assert.equal(result.value.name, 'Delta');
  });

  test('同名と大文字・小文字違いは重複扱い', () => {
    for (const name of ['Alpha', 'alpha', ' ALPHA ']) {
      const result = validate(name);
      assert.equal(result.ok, false, name);
      assert.match(result.errors.name, /既に登録/);
    }
  });

  test('編集時は自分自身を重複判定から除外する', () => {
    assert.equal(validate('alpha', 'initial-1').ok, true);
    assert.equal(validate('Beta', 'initial-1').ok, false);
  });

  test('日本語の名前を許可', () => {
    assert.equal(validate('チャットAI').ok, true);
  });
});

test.describe('入力検証: 月額料金', () => {
  const validate = (monthly) => app.validateToolInput({ name: 'Delta', monthly, memo: '' }, tools(), null);

  test('空欄は 0 と混同せずエラー', () => {
    for (const monthly of ['', '   ']) {
      const result = validate(monthly);
      assert.equal(result.ok, false);
      assert.match(result.errors.monthly, /月額料金を入力/);
    }
  });

  test('0 は許可', () => {
    const result = validate('0');
    assert.equal(result.ok, true);
    assert.equal(result.value.monthly, 0);
  });

  test('正の整数・全角数字・前後空白は許可', () => {
    assert.equal(validate('3000').value.monthly, 3000);
    assert.equal(validate('１２３').value.monthly, 123);
    assert.equal(validate(' 42 ').value.monthly, 42);
    assert.equal(validate(String(Number.MAX_SAFE_INTEGER)).value.monthly, Number.MAX_SAFE_INTEGER);
  });

  test('負数は不可', () => {
    assert.match(validate('-1').errors.monthly, /マイナス/);
    assert.match(validate('-0').errors.monthly, /マイナス/);
  });

  test('小数は不可', () => {
    for (const monthly of ['1.5', '100.', '.5', '0.0']) {
      assert.match(validate(monthly).errors.monthly, /小数/, monthly);
    }
  });

  test('不正な文字列・NaN・Infinity・指数表記・カンマ付きは不可', () => {
    for (const monthly of ['abc', 'NaN', 'Infinity', '1e3', '3,000', '3000円', '0x10', '+5', '1 000']) {
      assert.match(validate(monthly).errors.monthly, /数字のみ/, monthly);
    }
  });

  test('安全な整数の範囲外は不可', () => {
    for (const monthly of ['9007199254740992', '9007199254740993', '1'.repeat(400)]) {
      assert.match(validate(monthly).errors.monthly, /以下で入力/, monthly);
    }
  });

  test('名前と料金のエラーを同時に返す', () => {
    const result = app.validateToolInput({ name: '', monthly: '', memo: '' }, tools(), null);
    assert.equal(result.ok, false);
    assert.ok(result.errors.name);
    assert.ok(result.errors.monthly);
  });
});

test('メモは空欄・日本語・改行を許可し、そのまま保持', () => {
  for (const memo of ['', '日本語のメモ', '1行目\n2行目']) {
    const result = app.validateToolInput({ name: 'Delta', monthly: '1', memo }, tools(), null);
    assert.equal(result.ok, true);
    assert.equal(result.value.memo, memo);
  }
});

test.describe('データ操作', () => {
  test('追加・更新・削除は元の配列を変更しない', () => {
    const original = tools();
    const snapshot = plain(original);
    const draft = { name: 'Delta', monthly: 100, memo: '' };

    const added = app.addTool(original, draft, 'new-id');
    assert.equal(added.length, 4);
    assert.deepEqual(plain(added[3]), { id: 'new-id', ...draft });

    const updated = app.updateTool(original, 'initial-2', draft);
    assert.deepEqual(plain(updated[1]), { id: 'initial-2', ...draft });
    assert.deepEqual(plain(updated.map((t) => t.id)), ['initial-1', 'initial-2', 'initial-3']);

    const removed = app.removeTool(original, 'initial-2');
    assert.deepEqual(plain(removed.map((t) => t.id)), ['initial-1', 'initial-3']);

    assert.deepEqual(plain(original), snapshot);
  });

  test('存在しない ID の更新・削除は例外', () => {
    assert.throws(() => app.updateTool(tools(), 'missing', { name: 'x', monthly: 0, memo: '' }));
    assert.throws(() => app.removeTool(tools(), 'missing'));
  });

  test('生成される ID は既存と重複しない', () => {
    const list = tools();
    const ids = new Set(list.map((t) => t.id));
    for (let i = 0; i < 50; i += 1) {
      const id = app.createToolId(list);
      assert.equal(ids.has(id), false);
    }
  });
});

test.describe('検索', () => {
  const list = () => [
    ...tools(),
    { id: 'x1', name: 'ChatBot', monthly: 2000, memo: '日本語の要約が得意' },
  ];
  const names = (result) => plain(result.map((t) => t.name));

  test('名前・メモの部分一致、大文字小文字を区別しない', () => {
    assert.deepEqual(names(app.filterTools(list(), 'chat')), ['ChatBot']);
    assert.deepEqual(names(app.filterTools(list(), 'ALP')), ['Alpha']);
    assert.deepEqual(names(app.filterTools(list(), '調査')), ['Beta']);
  });

  test('日本語・前後空白・全角英字', () => {
    assert.deepEqual(names(app.filterTools(list(), '  要約 ')), ['ChatBot']);
    assert.deepEqual(names(app.filterTools(list(), 'ＣＨＡＴ')), ['ChatBot']);
  });

  test('空文字は全件', () => {
    assert.equal(app.filterTools(list(), '').length, 4);
    assert.equal(app.filterTools(list(), '   ').length, 4);
  });

  test('一致なしは空配列', () => {
    assert.equal(app.filterTools(list(), '存在しない').length, 0);
  });

  test('HTML 風の文字列も単なる文字列として検索できる', () => {
    const xss = [{ id: 'x', name: '<img src=x onerror=alert(1)>', monthly: 0, memo: '' }];
    assert.equal(app.filterTools(xss, '<img').length, 1);
  });
});

test.describe('ソート', () => {
  const list = () => [
    { id: 'a', name: 'A', monthly: 3000, memo: '' },
    { id: 'b', name: 'B', monthly: 1000, memo: '' },
    { id: 'c', name: 'C', monthly: 3000, memo: '' },
    { id: 'd', name: 'D', monthly: 20000, memo: '' },
    { id: 'e', name: 'E', monthly: 0, memo: '' },
  ];
  const ids = (result) => plain(result.map((t) => t.id));

  test('数値として昇順・降順（文字列比較なら 20000 < 3000 になる）', () => {
    assert.deepEqual(ids(app.sortTools(list(), 'asc')), ['e', 'b', 'a', 'c', 'd']);
    assert.deepEqual(ids(app.sortTools(list(), 'desc')), ['d', 'a', 'c', 'b', 'e']);
  });

  test('同額は登録順を維持（昇順・降順とも）', () => {
    const asc = ids(app.sortTools(list(), 'asc'));
    const desc = ids(app.sortTools(list(), 'desc'));
    assert.ok(asc.indexOf('a') < asc.indexOf('c'));
    assert.ok(desc.indexOf('a') < desc.indexOf('c'));
  });

  test('元の配列を変更しない', () => {
    const original = list();
    app.sortTools(original, 'desc');
    assert.deepEqual(ids(original), ['a', 'b', 'c', 'd', 'e']);
  });

  test('検索とソートの組み合わせ', () => {
    const data = [...tools(), { id: 'x', name: 'Alphabet', monthly: 100, memo: '' }];
    assert.deepEqual(plain(app.getVisibleTools(data, 'alpha', 'asc').map((t) => t.name)), ['Alphabet', 'Alpha']);
  });

  test('未知のソート値は登録順に戻す', () => {
    assert.equal(app.parseSortOrder('asc'), 'asc');
    assert.equal(app.parseSortOrder('desc'), 'desc');
    assert.equal(app.parseSortOrder('evil'), 'registered');
  });
});

test.describe('CSV', () => {
  const csvOf = (list) => app.buildCsv(list);
  const row = (name, memo, monthly = 0) => [{ id: 'x', name, monthly, memo }];
  const body = (csv) => csv.slice(1).split('\r\n')[1];

  test('BOM・ヘッダー・CRLF・数値のみの料金', () => {
    const csv = csvOf(tools());
    assert.ok(csv.startsWith('﻿'));
    assert.equal(
      csv,
      '﻿名前,月額料金（円）,メモ\r\nAlpha,3000,文章\r\nBeta,0,調査\r\nGamma,5000,画像\r\n',
    );
  });

  test('0件でもヘッダーのみ出力', () => {
    assert.equal(csvOf([]), '﻿名前,月額料金（円）,メモ\r\n');
  });

  test('カンマ・ダブルクォート・改行をエスケープ', () => {
    assert.equal(body(csvOf(row('A,B', 'x'))), '"A,B",0,x');
    assert.equal(body(csvOf(row('say "hi"', 'x'))), '"say ""hi""",0,x');
    assert.equal(csvOf(row('A', '1行目\n2行目')).split('\r\n')[1], 'A,0,"1行目\n2行目"');
  });

  test('日本語はそのまま', () => {
    assert.equal(body(csvOf(row('日本語ツール', '文章生成'))), '日本語ツール,0,文章生成');
  });

  test('数式インジェクション対策: 危険な先頭文字に \' を付与', () => {
    const cases = {
      '=1+1': "'=1+1",
      '+SUM(A1)': "'+SUM(A1)",
      '-2+3': "'-2+3",
      '@cmd': "'@cmd",
      ' =1+1': "' =1+1",
      '　=1': "'　=1",
      '\u0001=1': "'\u0001=1",
      '＝1+1': "'＝1+1",
      '\tdata': "'\tdata",
      '\rdata': "'\rdata",
      safe: 'safe',
      'a=b': 'a=b',
    };
    for (const [input, expected] of Object.entries(cases)) {
      assert.equal(app.neutralizeCsvFormula(input), expected, JSON.stringify(input));
    }
  });

  test('数式対策とクォートの組み合わせ', () => {
    assert.equal(body(csvOf(row('=HYPERLINK("http://x","c")', ''))), '"\'=HYPERLINK(""http://x"",""c"")",0,');
  });

  test('ファイル名は日付入り', () => {
    assert.equal(app.createCsvFileName(new Date(2026, 0, 5)), 'ai-tools-20260105.csv');
  });
});

test.describe('保存データの実行時検証', () => {
  const valid = { id: 'a', name: 'A', monthly: 0, memo: '' };

  test('正しいデータ・空配列は有効', () => {
    assert.equal(app.parseToolList([valid]).ok, true);
    const empty = app.parseToolList([]);
    assert.equal(empty.ok, true);
    assert.equal(empty.tools.length, 0);
  });

  test('配列以外は不正', () => {
    for (const data of [null, {}, 'a', 1, undefined]) {
      assert.equal(app.parseToolList(data).ok, false, String(data));
    }
  });

  test('要素や各プロパティの型不整合は不正', () => {
    const invalidItems = [
      null,
      [],
      'text',
      { ...valid, id: undefined },
      { ...valid, id: '' },
      { ...valid, id: 1 },
      { ...valid, name: '' },
      { ...valid, name: '   ' },
      { ...valid, name: 1 },
      { ...valid, monthly: '100' },
      { ...valid, monthly: -1 },
      { ...valid, monthly: 1.5 },
      { ...valid, monthly: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, memo: undefined },
      { ...valid, memo: null },
    ];
    for (const item of invalidItems) {
      assert.equal(app.parseToolList([item]).ok, false, JSON.stringify(item));
    }
    // JSON では NaN / Infinity が null になるため、直接渡して確認する
    assert.equal(app.parseToolList([{ ...valid, monthly: NaN }]).ok, false);
    assert.equal(app.parseToolList([{ ...valid, monthly: Infinity }]).ok, false);
  });

  test('ID・名前（大文字小文字違い含む）の重複は不正', () => {
    assert.equal(app.parseToolList([valid, { ...valid, name: 'B' }]).ok, false);
    assert.equal(app.parseToolList([valid, { ...valid, id: 'b', name: 'a' }]).ok, false);
  });

  test('余分なプロパティは取り除く', () => {
    const result = app.parseToolList([{ ...valid, extra: '<script>' }]);
    assert.deepEqual(plain(result.tools), [valid]);
  });
});

test.describe('localStorage', () => {
  test('未保存なら missing、保存済み空配列は loaded（初期データを復活させない）', () => {
    assert.equal(app.loadTools(createFakeStorage()).status, 'missing');
    const result = app.loadTools(createFakeStorage({ [app.STORAGE_KEY]: '[]' }));
    assert.equal(result.status, 'loaded');
    assert.equal(result.tools.length, 0);
  });

  test('破損 JSON・不正構造は invalid', () => {
    for (const raw of ['{broken', '{"name":"A"}', '[{"id":"a","name":"A","monthly":"x","memo":""}]']) {
      assert.equal(app.loadTools(createFakeStorage({ [app.STORAGE_KEY]: raw })).status, 'invalid', raw);
    }
  });

  test('保存と復元の往復', () => {
    const storage = createFakeStorage();
    assert.equal(app.saveTools(storage, tools()), true);
    const loaded = app.loadTools(storage);
    assert.deepEqual(plain(loaded.tools), plain(tools()));
  });

  test('保存失敗（容量超過）は false を返し例外を外へ出さない', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    assert.equal(app.saveTools(storage, tools()), false);
  });

  test('localStorage 自体が使えない場合は null', () => {
    assert.equal(
      app.openStorage(() => {
        throw new Error('SecurityError');
      }),
      null,
    );
  });

  test('利用不可なら初期データ・保存停止中で起動', () => {
    const { persistence, tools: loaded } = app.initPersistence(() => {
      throw new Error('SecurityError');
    });
    assert.equal(persistence.storage, null);
    assert.equal(loaded.length, 3);
    assert.match(app.getStorageAlertMessage(persistence), /再読み込み/);
    assert.equal(app.persistTools(persistence, loaded), 'skipped');
    assert.equal(persistence.hasUnsavedChanges, true);
  });

  test('破損データは保護され、通常の保存では上書きしない', () => {
    const storage = createFakeStorage({ [app.STORAGE_KEY]: '{broken' });
    const { persistence, tools: loaded } = app.initPersistence(() => storage);
    assert.equal(persistence.writeProtected, true);
    assert.equal(loaded.length, 3);

    assert.equal(app.persistTools(persistence, loaded), 'skipped');
    assert.equal(storage.data.get(app.STORAGE_KEY), '{broken');
    assert.match(app.getStorageAlertMessage(persistence), /初期状態へ戻す/);

    // 明示的なリセットでは保護を解除してから保存する
    persistence.writeProtected = false;
    assert.equal(app.persistTools(persistence, loaded), 'saved');
    assert.equal(app.loadTools(storage).status, 'loaded');
  });

  test('保存失敗で未保存になり、次の保存成功で解除される', () => {
    let fail = true;
    const storage = createFakeStorage();
    const flaky = {
      getItem: storage.getItem,
      setItem: (key, value) => {
        if (fail) throw new Error('QuotaExceededError');
        storage.setItem(key, value);
      },
    };
    const { persistence } = app.initPersistence(() => flaky);
    assert.equal(app.persistTools(persistence, tools()), 'failed');
    assert.equal(persistence.hasUnsavedChanges, true);
    assert.equal(app.getSaveStatus(persistence).state, 'unsaved');
    assert.match(app.getStorageAlertMessage(persistence), /未保存/);

    fail = false;
    assert.equal(app.persistTools(persistence, tools()), 'saved');
    assert.equal(persistence.hasUnsavedChanges, false);
    assert.equal(app.getStorageAlertMessage(persistence), null);
  });

  test('保存結果のメッセージは成功時だけ「保存しました」', () => {
    assert.match(app.describeChangeResult('追加しました', 'saved').message, /保存しました/);
    assert.doesNotMatch(app.describeChangeResult('追加しました', 'failed').message, /保存しました。$/);
    assert.match(app.describeChangeResult('追加しました', 'failed').message, /失敗/);
    assert.match(app.describeChangeResult('追加しました', 'skipped').message, /保存されていません/);
  });

  test('他アプリのキーには触れない', () => {
    const storage = createFakeStorage({ other: 'keep' });
    app.saveTools(storage, []);
    assert.equal(storage.data.get('other'), 'keep');
  });
});

test.describe('CSV 出力対象の選択', () => {
  const ids = (list) => plain(list.map((t) => t.id));

  test('選択中のデータを表示順ではなく登録順で返す', () => {
    const selected = new Set(['initial-3', 'initial-1']);
    assert.deepEqual(ids(app.getSelectedTools(tools(), selected)), ['initial-1', 'initial-3']);
  });

  test('未選択なら空、選択データの CSV はヘッダー＋選択行のみ', () => {
    assert.equal(app.getSelectedTools(tools(), new Set()).length, 0);
    const csv = app.buildCsv(app.getSelectedTools(tools(), new Set(['initial-2'])));
    assert.equal(csv, '﻿名前,月額料金（円）,メモ\r\nBeta,0,調査\r\n');
  });

  test('全件選択・全件解除', () => {
    assert.deepEqual([...app.selectAllTools(tools(), true)], ['initial-1', 'initial-2', 'initial-3']);
    assert.equal(app.selectAllTools(tools(), false).size, 0);
  });

  test('全件選択の表示状態（none / some / all）', () => {
    assert.equal(app.getSelectAllState(tools(), new Set()), 'none');
    assert.equal(app.getSelectAllState(tools(), new Set(['initial-1'])), 'some');
    assert.equal(app.getSelectAllState(tools(), app.selectAllTools(tools(), true)), 'all');
    assert.equal(app.getSelectAllState([], new Set()), 'none');
  });

  test('存在しない ID は選択から取り除く（削除後・不明なID）', () => {
    const remaining = app.removeTool(tools(), 'initial-2');
    const pruned = app.pruneSelection(new Set(['initial-1', 'initial-2', 'ghost']), remaining);
    assert.deepEqual([...pruned], ['initial-1']);
    // 1件削除後に残りを全て選択していれば「全件選択」状態になる
    assert.equal(app.getSelectAllState(remaining, app.pruneSelection(new Set(['initial-1', 'initial-2', 'initial-3']), remaining)), 'all');
  });
});
