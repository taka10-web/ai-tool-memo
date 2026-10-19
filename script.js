// @ts-check

/**
 * @typedef {Object} AITool
 * @property {string} id 編集・削除対象を表示順に依存せず特定するための内部ID
 * @property {string} name
 * @property {number} monthly 月額料金（円、0以上の安全な整数）
 * @property {string} memo
 */

/**
 * 検証済みでIDを持たないツールデータ。追加と更新で共通に使う。
 * @typedef {Object} ToolDraft
 * @property {string} name
 * @property {number} monthly
 * @property {string} memo
 */

/**
 * フォームから受け取る未検証の入力値。
 * 空欄と 0 を区別するため、monthly も数値変換前の文字列のまま扱う。
 * @typedef {Object} ToolFormInput
 * @property {string} name
 * @property {string} monthly
 * @property {string} memo
 */

/** @typedef {'name' | 'monthly'} ValidatedField */

/** @typedef {Partial<Record<ValidatedField, string>>} FieldErrors */

/**
 * @typedef {{ ok: true, value: ToolDraft } | { ok: false, errors: FieldErrors }} ValidationResult
 */

/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, error: string }} FieldResult
 */

/** @typedef {'registered' | 'asc' | 'desc'} SortOrder */

/**
 * @typedef {{ ok: true, tools: AITool[] } | { ok: false, reason: string }} ParseResult
 */

/**
 * @typedef {{ status: 'missing' } | { status: 'loaded', tools: AITool[] } | { status: 'invalid', reason: string }} LoadResult
 */

/**
 * UI・メモリ・localStorage のずれを把握するための永続化状態。
 * @typedef {Object} PersistenceState
 * @property {Pick<Storage, 'getItem' | 'setItem'> | null} storage null は localStorage が利用できないことを表す
 * @property {boolean} writeProtected 読み込めなかった既存データを通常操作で上書きしないための保護フラグ
 * @property {boolean} hasUnsavedChanges メモリ上の内容が localStorage に反映されていない
 */

/** @typedef {'saved' | 'failed' | 'skipped'} PersistOutcome */

/**
 * @typedef {Object} AppState
 * @property {AITool[]} tools 登録順を保持した全データ。検索・ソートでは直接変更しない
 * @property {string} query
 * @property {SortOrder} sortOrder
 * @property {string | null} editingId
 * @property {Set<string>} selectedIds CSV 出力対象として選択中のID。画面上だけの状態で保存しない
 */

/** @typedef {'none' | 'some' | 'all'} SelectAllState */

/** @typedef {'success' | 'error' | 'info'} NoticeTone */

/**
 * @typedef {Object} DomRefs
 * @property {HTMLFormElement} form
 * @property {HTMLElement} formTitle
 * @property {HTMLInputElement} nameInput
 * @property {HTMLInputElement} monthlyInput
 * @property {HTMLTextAreaElement} memoInput
 * @property {HTMLElement} nameError
 * @property {HTMLElement} monthlyError
 * @property {HTMLButtonElement} submitButton
 * @property {HTMLButtonElement} cancelButton
 * @property {HTMLInputElement} searchInput
 * @property {HTMLSelectElement} sortSelect
 * @property {HTMLTableElement} table
 * @property {HTMLTableSectionElement} listBody
 * @property {HTMLElement} listTitle
 * @property {HTMLElement} emptyMessage
 * @property {HTMLElement} resultCount
 * @property {HTMLInputElement} selectAll
 * @property {HTMLElement} selectionCount
 * @property {HTMLButtonElement} csvButton
 * @property {HTMLButtonElement} resetButton
 * @property {HTMLElement} storageAlert
 * @property {HTMLElement} saveStatus
 * @property {HTMLElement} notice
 * @property {HTMLElement} noticeMessage
 * @property {HTMLButtonElement} noticeClose
 */

// テストから純粋関数を参照するための唯一の公開口。アプリ本体の状態は外部に出さない。
const AiToolMemo = (() => {
  'use strict';

  /** アプリ専用の保存キー。他アプリのデータと衝突させず、構造変更時に版を上げられるようにする */
  const STORAGE_KEY = 'ai-tool-memo:tools:v1';
  const LOG_PREFIX = '[ai-tool-memo]';

  /** @type {ReadonlyArray<Readonly<ToolDraft>>} */
  const INITIAL_TOOL_DATA = Object.freeze([
    Object.freeze({ name: 'Alpha', monthly: 3000, memo: '文章' }),
    Object.freeze({ name: 'Beta', monthly: 0, memo: '調査' }),
    Object.freeze({ name: 'Gamma', monthly: 5000, memo: '画像' }),
  ]);

  const CSV_HEADER = Object.freeze(['名前', '月額料金（円）', 'メモ']);
  const CSV_BOM = '﻿';
  // RFC 4180 は CRLF を行区切りとして定めている
  const CSV_LINE_BREAK = '\r\n';
  /**
   * 表計算ソフトが数式として解釈しうる先頭文字。全角記号も IME 経由で数式扱いされることがあるため含める。
   * 先頭の空白・制御文字を読み飛ばして判定し、空白を挟んだ回避も防ぐ。
   */
  const FORMULA_TRIGGER_PATTERN = /^[\p{Cc}\p{Z}]*[=+\-@＝＋－＠]/u;
  // OWASP の推奨に従い、タブ・改行で始まるセルも無害化する
  const LEADING_CONTROL_PATTERN = /^[\t\r\n]/;
  const FORMULA_ESCAPE_PREFIX = "'";

  /** ダウンロード開始前に URL を解放すると中断するブラウザがあるため、解放を少し遅らせる */
  const OBJECT_URL_REVOKE_DELAY_MS = 1000;
  const SUCCESS_NOTICE_DURATION_MS = 6000;

  /** @type {ReadonlyArray<SortOrder>} */
  const SORT_ORDERS = Object.freeze(['registered', 'asc', 'desc']);
  const DEFAULT_SORT_ORDER = 'registered';

  const yenFormatter = new Intl.NumberFormat('ja-JP');

  // ---------------------------------------------------------------------------
  // 表示用の整形
  // ---------------------------------------------------------------------------

  /**
   * @param {number} amount
   * @returns {string} 例: "3,000円"
   */
  function formatYen(amount) {
    return `${yenFormatter.format(amount)}円`;
  }

  // ---------------------------------------------------------------------------
  // 実行時の型検証（localStorage など外部由来データ用）
  // ---------------------------------------------------------------------------

  /**
   * @param {unknown} value
   * @returns {value is Record<string, unknown>}
   */
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * @param {unknown} value
   * @returns {value is number}
   */
  function isValidMonthly(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }

  /**
   * 大文字・小文字を区別しない重複判定用のキー。
   * @param {string} name
   * @returns {string}
   */
  function toNameKey(name) {
    return name.trim().toLowerCase();
  }

  /**
   * @param {unknown} item
   * @returns {{ ok: true, tool: AITool } | { ok: false, reason: string }}
   */
  function parseTool(item) {
    if (!isPlainObject(item)) {
      return { ok: false, reason: 'オブジェクトではありません' };
    }
    const { id, name, monthly, memo } = item;
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, reason: 'id が空でない文字列ではありません' };
    }
    if (typeof name !== 'string' || name.trim() === '') {
      return { ok: false, reason: 'name が空でない文字列ではありません' };
    }
    if (!isValidMonthly(monthly)) {
      return { ok: false, reason: 'monthly が0以上の安全な整数ではありません' };
    }
    if (typeof memo !== 'string') {
      return { ok: false, reason: 'memo が文字列ではありません' };
    }
    // 未知のプロパティを持ち込まないよう、必要な項目だけで組み立て直す
    return { ok: true, tool: { id, name: name.trim(), monthly, memo } };
  }

  /**
   * 不明なデータを AITool 配列として検証する。1件でも不正があれば全体を不正とする。
   * @param {unknown} data
   * @returns {ParseResult}
   */
  function parseToolList(data) {
    if (!Array.isArray(data)) {
      return { ok: false, reason: 'ルートが配列ではありません' };
    }
    /** @type {AITool[]} */
    const tools = [];
    const ids = new Set();
    const nameKeys = new Set();
    for (let index = 0; index < data.length; index += 1) {
      /** @type {unknown} */
      const item = data[index];
      const result = parseTool(item);
      if (!result.ok) {
        return { ok: false, reason: `${index}番目の要素: ${result.reason}` };
      }
      const { tool } = result;
      if (ids.has(tool.id)) {
        return { ok: false, reason: `${index}番目の要素: id が重複しています` };
      }
      const nameKey = toNameKey(tool.name);
      if (nameKeys.has(nameKey)) {
        return { ok: false, reason: `${index}番目の要素: name が重複しています` };
      }
      ids.add(tool.id);
      nameKeys.add(nameKey);
      tools.push(tool);
    }
    return { ok: true, tools };
  }

  // ---------------------------------------------------------------------------
  // 入力検証（追加・編集で共通）
  // ---------------------------------------------------------------------------

  /**
   * @param {string} rawName
   * @param {ReadonlyArray<AITool>} tools
   * @param {string | null} editingId 編集時は自身を重複判定から除外する
   * @returns {FieldResult<string>}
   */
  function validateName(rawName, tools, editingId) {
    const name = rawName.trim();
    if (name === '') {
      return { ok: false, error: '名前を入力してください。' };
    }
    const nameKey = toNameKey(name);
    const duplicated = tools.some((tool) => tool.id !== editingId && toNameKey(tool.name) === nameKey);
    if (duplicated) {
      return {
        ok: false,
        error: `「${name}」は既に登録されています（大文字・小文字の違いは区別しません）。別の名前を入力してください。`,
      };
    }
    return { ok: true, value: name };
  }

  /**
   * 月額料金の文字列を検証して数値へ変換する。
   * 空欄を数値変換すると 0 になってしまうため、空欄判定を必ず先に行う。
   * @param {string} rawMonthly
   * @returns {FieldResult<number>}
   */
  function validateMonthly(rawMonthly) {
    // 全角数字での入力も受け付けるため NFKC で半角に寄せる
    const text = rawMonthly.normalize('NFKC').trim();
    if (text === '') {
      return { ok: false, error: '月額料金を入力してください。無料の場合は 0 と入力してください。' };
    }
    if (text.startsWith('-')) {
      return { ok: false, error: 'マイナスの金額は入力できません。0以上の整数で入力してください。' };
    }
    if (/^(\d+\.\d*|\.\d+)$/.test(text)) {
      return { ok: false, error: '小数は入力できません。円単位の整数で入力してください。' };
    }
    if (!/^\d+$/.test(text)) {
      return { ok: false, error: '月額料金は数字のみで入力してください（例: 3000）。カンマや「円」は不要です。' };
    }
    const monthly = Number(text);
    if (!Number.isSafeInteger(monthly)) {
      return { ok: false, error: `月額料金は ${formatYen(Number.MAX_SAFE_INTEGER)} 以下で入力してください。` };
    }
    return { ok: true, value: monthly };
  }

  /**
   * @param {ToolFormInput} input
   * @param {ReadonlyArray<AITool>} tools 重複判定に使う登録済みデータ
   * @param {string | null} editingId 編集対象のID。追加時は null
   * @returns {ValidationResult}
   */
  function validateToolInput(input, tools, editingId) {
    const name = validateName(input.name, tools, editingId);
    const monthly = validateMonthly(input.monthly);
    if (!name.ok || !monthly.ok) {
      /** @type {FieldErrors} */
      const errors = {};
      if (!name.ok) errors.name = name.error;
      if (!monthly.ok) errors.monthly = monthly.error;
      return { ok: false, errors };
    }
    return { ok: true, value: { name: name.value, monthly: monthly.value, memo: input.memo } };
  }

  // ---------------------------------------------------------------------------
  // データ操作（元の配列を変更せず新しい配列を返す）
  // ---------------------------------------------------------------------------

  /**
   * @returns {AITool[]}
   */
  function createInitialTools() {
    return INITIAL_TOOL_DATA.map((draft, index) => ({ id: `initial-${index + 1}`, ...draft }));
  }

  /**
   * @returns {string}
   */
  function generateRandomId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * @param {ReadonlyArray<AITool>} tools
   * @returns {string} 既存IDと重複しないID
   */
  function createToolId(tools) {
    const usedIds = new Set(tools.map((tool) => tool.id));
    let id = generateRandomId();
    while (usedIds.has(id)) {
      id = generateRandomId();
    }
    return id;
  }

  /**
   * @param {ReadonlyArray<AITool>} tools
   * @param {ToolDraft} draft 検証済みデータ
   * @param {string} id
   * @returns {AITool[]}
   */
  function addTool(tools, draft, id) {
    return [...tools, { id, ...draft }];
  }

  /**
   * @param {ReadonlyArray<AITool>} tools
   * @param {string} id
   * @returns {void}
   * @throws {Error} 対象IDが存在しない場合
   */
  function assertToolExists(tools, id) {
    if (!tools.some((tool) => tool.id === id)) {
      throw new Error(`ID "${id}" のデータが見つかりません`);
    }
  }

  /**
   * @param {ReadonlyArray<AITool>} tools
   * @param {string} id
   * @param {ToolDraft} draft 検証済みデータ
   * @returns {AITool[]} 登録順を保ったまま対象だけを置き換えた配列
   * @throws {Error} 対象IDが存在しない場合
   */
  function updateTool(tools, id, draft) {
    assertToolExists(tools, id);
    return tools.map((tool) => (tool.id === id ? { id, ...draft } : tool));
  }

  /**
   * @param {ReadonlyArray<AITool>} tools
   * @param {string} id
   * @returns {AITool[]}
   * @throws {Error} 対象IDが存在しない場合
   */
  function removeTool(tools, id) {
    assertToolExists(tools, id);
    return tools.filter((tool) => tool.id !== id);
  }

  // ---------------------------------------------------------------------------
  // 検索・ソート
  // ---------------------------------------------------------------------------

  /**
   * 全角・半角や大文字・小文字の違いを吸収した検索用文字列。
   * @param {string} text
   * @returns {string}
   */
  function normalizeForSearch(text) {
    return text.normalize('NFKC').toLowerCase();
  }

  /**
   * 名前・メモの部分一致で絞り込む。
   * @param {ReadonlyArray<AITool>} tools
   * @param {string} query
   * @returns {AITool[]}
   */
  function filterTools(tools, query) {
    const keyword = normalizeForSearch(query).trim();
    if (keyword === '') {
      return [...tools];
    }
    return tools.filter(
      (tool) => normalizeForSearch(tool.name).includes(keyword) || normalizeForSearch(tool.memo).includes(keyword),
    );
  }

  /**
   * @param {ReadonlyArray<AITool>} tools
   * @param {SortOrder} order
   * @returns {AITool[]} 元の配列は変更しない
   */
  function sortTools(tools, order) {
    const copied = [...tools];
    if (order === 'registered') {
      return copied;
    }
    const direction = order === 'asc' ? 1 : -1;
    // Array.prototype.sort は ES2019 以降安定ソートのため、同額は元の登録順を保つ
    return copied.sort((a, b) => (a.monthly - b.monthly) * direction);
  }

  /**
   * @param {ReadonlyArray<AITool>} tools
   * @param {string} query
   * @param {SortOrder} order
   * @returns {AITool[]}
   */
  function getVisibleTools(tools, query, order) {
    return sortTools(filterTools(tools, query), order);
  }

  /**
   * select 要素の値は改ざんされうるため、既知の値以外は既定値に戻す。
   * @param {string} value
   * @returns {SortOrder}
   */
  function parseSortOrder(value) {
    return SORT_ORDERS.find((order) => order === value) ?? DEFAULT_SORT_ORDER;
  }

  // ---------------------------------------------------------------------------
  // CSV 出力対象の選択
  // ---------------------------------------------------------------------------

  /**
   * @param {ReadonlyArray<AITool>} tools
   * @param {ReadonlySet<string>} selectedIds
   * @returns {AITool[]} 選択中のデータ（表示順ではなく登録順）
   */
  function getSelectedTools(tools, selectedIds) {
    return tools.filter((tool) => selectedIds.has(tool.id));
  }

  /**
   * 削除などで存在しなくなったIDを選択から取り除く。
   * @param {ReadonlySet<string>} selectedIds
   * @param {ReadonlyArray<AITool>} tools
   * @returns {Set<string>}
   */
  function pruneSelection(selectedIds, tools) {
    return new Set(tools.filter((tool) => selectedIds.has(tool.id)).map((tool) => tool.id));
  }

  /**
   * @param {ReadonlyArray<AITool>} tools
   * @param {boolean} selected true なら全件を選択、false なら全件の選択を解除
   * @returns {Set<string>}
   */
  function selectAllTools(tools, selected) {
    return selected ? new Set(tools.map((tool) => tool.id)) : new Set();
  }

  /**
   * @param {ReadonlyArray<AITool>} tools
   * @param {ReadonlySet<string>} selectedIds
   * @returns {SelectAllState} 「全件選択」チェックボックスの表示状態
   */
  function getSelectAllState(tools, selectedIds) {
    const count = getSelectedTools(tools, selectedIds).length;
    if (count === 0) return 'none';
    return count === tools.length ? 'all' : 'some';
  }

  // ---------------------------------------------------------------------------
  // CSV
  // ---------------------------------------------------------------------------

  /**
   * 表計算ソフトで開いたときに数式として実行されないよう、危険な先頭文字を持つ値に ' を付ける。
   * @param {string} value
   * @returns {string}
   */
  function neutralizeCsvFormula(value) {
    if (FORMULA_TRIGGER_PATTERN.test(value) || LEADING_CONTROL_PATTERN.test(value)) {
      return `${FORMULA_ESCAPE_PREFIX}${value}`;
    }
    return value;
  }

  /**
   * RFC 4180 に従い、カンマ・ダブルクォート・改行を含む値をクォートする。
   * @param {string} value
   * @returns {string}
   */
  function escapeCsvField(value) {
    if (/[",\r\n]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  /**
   * @param {ReadonlyArray<AITool>} tools 検索条件に関係なく全データを渡す
   * @returns {string} BOM 付きの CSV 文字列（末尾も CRLF）
   */
  function buildCsv(tools) {
    const header = CSV_HEADER.map(escapeCsvField).join(',');
    const rows = tools.map((tool) =>
      [
        escapeCsvField(neutralizeCsvFormula(tool.name)),
        String(tool.monthly),
        escapeCsvField(neutralizeCsvFormula(tool.memo)),
      ].join(','),
    );
    return `${CSV_BOM}${[header, ...rows].join(CSV_LINE_BREAK)}${CSV_LINE_BREAK}`;
  }

  /**
   * @param {Date} date
   * @returns {string} 例: "ai-tools-20261020.csv"
   */
  function createCsvFileName(date) {
    const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
    return `ai-tools-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.csv`;
  }

  // ---------------------------------------------------------------------------
  // 永続化
  // ---------------------------------------------------------------------------

  /**
   * localStorage はプライベートモードや設定によってアクセス時点で例外を投げるため、取得自体を保護する。
   * @param {() => Pick<Storage, 'getItem' | 'setItem'>} getStorage
   * @returns {Pick<Storage, 'getItem' | 'setItem'> | null}
   */
  function openStorage(getStorage) {
    try {
      const storage = getStorage();
      storage.getItem(STORAGE_KEY);
      return storage;
    } catch (error) {
      console.error(`${LOG_PREFIX} localStorage を利用できません`, error);
      return null;
    }
  }

  /**
   * @param {Pick<Storage, 'getItem'>} storage
   * @returns {LoadResult}
   */
  function loadTools(storage) {
    /** @type {string | null} */
    let raw;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch (error) {
      console.error(`${LOG_PREFIX} 保存データの読み込みに失敗しました`, error);
      return { status: 'invalid', reason: '保存データを読み込めません' };
    }
    if (raw === null) {
      return { status: 'missing' };
    }
    /** @type {unknown} */
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      console.error(`${LOG_PREFIX} 保存データが JSON として解析できません`, error);
      return { status: 'invalid', reason: 'JSON として解析できません' };
    }
    const parsed = parseToolList(data);
    if (!parsed.ok) {
      return { status: 'invalid', reason: parsed.reason };
    }
    return { status: 'loaded', tools: parsed.tools };
  }

  /**
   * @param {Pick<Storage, 'setItem'>} storage
   * @param {ReadonlyArray<AITool>} tools
   * @returns {boolean} 保存に成功したか
   */
  function saveTools(storage, tools) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(tools));
      return true;
    } catch (error) {
      // 容量超過 (QuotaExceededError) などの原因を開発者が追えるよう記録する
      console.error(`${LOG_PREFIX} 保存に失敗しました`, error);
      return false;
    }
  }

  /**
   * 起動時の保存データ読み込み。どの失敗でもアプリは初期データで使える状態にする。
   * @param {() => Pick<Storage, 'getItem' | 'setItem'>} getStorage
   * @returns {{ persistence: PersistenceState, tools: AITool[] }}
   */
  function initPersistence(getStorage) {
    const storage = openStorage(getStorage);
    if (storage === null) {
      return {
        persistence: { storage: null, writeProtected: false, hasUnsavedChanges: false },
        tools: createInitialTools(),
      };
    }
    const loaded = loadTools(storage);
    if (loaded.status === 'loaded') {
      return { persistence: { storage, writeProtected: false, hasUnsavedChanges: false }, tools: loaded.tools };
    }
    if (loaded.status === 'invalid') {
      console.error(`${LOG_PREFIX} 保存データが不正なため初期データで起動します（保存データは保護されます）: ${loaded.reason}`);
      return { persistence: { storage, writeProtected: true, hasUnsavedChanges: false }, tools: createInitialTools() };
    }
    return { persistence: { storage, writeProtected: false, hasUnsavedChanges: false }, tools: createInitialTools() };
  }

  /**
   * メモリ上の変更を保存し、結果に応じて未保存状態を更新する。
   * @param {PersistenceState} persistence 変更される
   * @param {ReadonlyArray<AITool>} tools
   * @returns {PersistOutcome}
   */
  function persistTools(persistence, tools) {
    if (persistence.storage === null || persistence.writeProtected) {
      persistence.hasUnsavedChanges = true;
      return 'skipped';
    }
    const saved = saveTools(persistence.storage, tools);
    persistence.hasUnsavedChanges = !saved;
    return saved ? 'saved' : 'failed';
  }

  /**
   * @param {PersistenceState} persistence
   * @returns {string | null} 画面上部に常時表示する警告。問題がなければ null
   */
  function getStorageAlertMessage(persistence) {
    if (persistence.storage === null) {
      return 'このブラウザでは localStorage を利用できないため、一時的な利用モードで動作しています。ページを再読み込みしたり閉じたりすると、変更内容は失われます。';
    }
    if (persistence.writeProtected) {
      return '保存データを正しく読み込めなかったため、初期データを表示しています。既存の保存データを保護するため、変更は自動保存されません。「初期状態へ戻す」を実行すると、保存データを初期化して保存を再開します。';
    }
    if (persistence.hasUnsavedChanges) {
      return '未保存の変更があります。localStorage への保存に失敗しました（容量不足などが考えられます）。次の操作時に再度保存を試みます。';
    }
    return null;
  }

  /**
   * @param {PersistenceState} persistence
   * @returns {{ label: string, state: 'saved' | 'unsaved' }}
   */
  function getSaveStatus(persistence) {
    if (persistence.storage === null || persistence.writeProtected) {
      return { label: '保存停止中', state: 'unsaved' };
    }
    return persistence.hasUnsavedChanges ? { label: '未保存の変更あり', state: 'unsaved' } : { label: '保存済み', state: 'saved' };
  }

  /**
   * @param {string} actionMessage 例: "「Alpha」を追加しました"
   * @param {PersistOutcome} outcome
   * @returns {{ message: string, tone: NoticeTone }}
   */
  function describeChangeResult(actionMessage, outcome) {
    if (outcome === 'saved') {
      return { message: `${actionMessage}。保存しました。`, tone: 'success' };
    }
    if (outcome === 'failed') {
      return { message: `${actionMessage}が、保存に失敗しました。変更はこの画面上にのみ残っています（未保存）。`, tone: 'error' };
    }
    return { message: `${actionMessage}（この変更は保存されていません）。`, tone: 'info' };
  }

  // ---------------------------------------------------------------------------
  // DOM（ここから下はブラウザでのみ実行される）
  // ---------------------------------------------------------------------------

  /**
   * @template {HTMLElement} T
   * @param {string} id
   * @param {{ new (): T }} type
   * @returns {T}
   * @throws {Error} 要素が存在しない、または想定と異なる種類の場合
   */
  function getRequiredElement(id, type) {
    const element = document.getElementById(id);
    if (!(element instanceof type)) {
      throw new Error(`必須要素 #${id} が見つからないか、要素の種類が想定と異なります`);
    }
    return element;
  }

  /**
   * @returns {DomRefs}
   * @throws {Error} 必須要素が欠けている場合
   */
  function queryDom() {
    return {
      form: getRequiredElement('tool-form', HTMLFormElement),
      formTitle: getRequiredElement('form-title', HTMLElement),
      nameInput: getRequiredElement('tool-name', HTMLInputElement),
      monthlyInput: getRequiredElement('tool-monthly', HTMLInputElement),
      memoInput: getRequiredElement('tool-memo', HTMLTextAreaElement),
      nameError: getRequiredElement('tool-name-error', HTMLElement),
      monthlyError: getRequiredElement('tool-monthly-error', HTMLElement),
      submitButton: getRequiredElement('submit-button', HTMLButtonElement),
      cancelButton: getRequiredElement('cancel-edit-button', HTMLButtonElement),
      searchInput: getRequiredElement('search-input', HTMLInputElement),
      sortSelect: getRequiredElement('sort-select', HTMLSelectElement),
      table: getRequiredElement('tool-table', HTMLTableElement),
      listBody: getRequiredElement('tool-list', HTMLTableSectionElement),
      listTitle: getRequiredElement('list-title', HTMLElement),
      emptyMessage: getRequiredElement('empty-message', HTMLElement),
      resultCount: getRequiredElement('result-count', HTMLElement),
      selectAll: getRequiredElement('select-all', HTMLInputElement),
      selectionCount: getRequiredElement('selection-count', HTMLElement),
      csvButton: getRequiredElement('csv-button', HTMLButtonElement),
      resetButton: getRequiredElement('reset-button', HTMLButtonElement),
      storageAlert: getRequiredElement('storage-alert', HTMLElement),
      saveStatus: getRequiredElement('save-status', HTMLElement),
      notice: getRequiredElement('notice', HTMLElement),
      noticeMessage: getRequiredElement('notice-message', HTMLElement),
      noticeClose: getRequiredElement('notice-close', HTMLButtonElement),
    };
  }

  /**
   * @param {'th' | 'td'} tagName
   * @param {string} label スマートフォンのカード表示で項目名として使う
   * @param {string} text
   * @param {string} className
   * @returns {HTMLTableCellElement}
   */
  function createCell(tagName, label, text, className) {
    const cell = document.createElement(tagName);
    cell.className = className;
    cell.dataset.label = label;
    // ユーザー入力は必ず textContent で挿入し、HTML として解釈させない
    cell.textContent = text;
    if (tagName === 'th') {
      cell.scope = 'row';
    }
    return cell;
  }

  /**
   * @param {'edit' | 'delete'} action
   * @param {AITool} tool
   * @returns {HTMLButtonElement}
   */
  function createActionButton(action, tool) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = action === 'edit' ? 'button button-small' : 'button button-small button-danger-outline';
    button.textContent = action === 'edit' ? '編集' : '削除';
    button.setAttribute('aria-label', `「${tool.name}」を${button.textContent}`);
    button.dataset.action = action;
    button.dataset.id = tool.id;
    return button;
  }

  /**
   * @param {AITool} tool
   * @param {boolean} isSelected
   * @returns {HTMLTableCellElement}
   */
  function createSelectCell(tool, isSelected) {
    const cell = document.createElement('td');
    cell.className = 'cell-select';
    cell.dataset.label = 'CSV出力';
    // チェックボックス単体では小さすぎるため、label で包んでタップ領域を広げる
    const label = document.createElement('label');
    label.className = 'select-target';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isSelected;
    checkbox.dataset.id = tool.id;
    checkbox.setAttribute('aria-label', `「${tool.name}」をCSV出力の対象にする`);
    label.append(checkbox);
    cell.append(label);
    return cell;
  }

  /**
   * @param {AITool} tool
   * @param {boolean} isEditing
   * @param {boolean} isSelected
   * @returns {HTMLTableRowElement}
   */
  function createToolRow(tool, isEditing, isSelected) {
    const row = document.createElement('tr');
    if (isEditing) {
      row.classList.add('is-editing');
    }
    const memoCell = createCell('td', 'メモ', tool.memo, 'cell-memo');
    if (tool.memo.trim() === '') {
      memoCell.textContent = 'なし';
      memoCell.classList.add('is-empty');
    }
    const actionsCell = document.createElement('td');
    actionsCell.className = 'cell-actions';
    // td 自体を flex にすると表のセルとして描画されなくなるため、内側の要素で並べる
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.append(createActionButton('edit', tool), createActionButton('delete', tool));
    actionsCell.append(actions);
    row.append(
      createSelectCell(tool, isSelected),
      createCell('th', '名前', tool.name, 'cell-name'),
      createCell('td', '月額料金', formatYen(tool.monthly), 'cell-monthly'),
      memoCell,
      actionsCell,
    );
    return row;
  }

  /**
   * @param {DomRefs} dom
   * @param {AppState} state
   * @returns {void}
   */
  function renderList(dom, state) {
    const visibleTools = getVisibleTools(state.tools, state.query, state.sortOrder);
    dom.listBody.replaceChildren(
      ...visibleTools.map((tool) => createToolRow(tool, tool.id === state.editingId, state.selectedIds.has(tool.id))),
    );
    dom.resultCount.textContent = `全${state.tools.length}件中 ${visibleTools.length}件を表示`;

    const emptyText =
      state.tools.length === 0
        ? '登録されているAIツールはありません。フォームから追加してください。'
        : visibleTools.length === 0
          ? `「${state.query.trim()}」に一致するAIツールはありません。`
          : '';
    dom.emptyMessage.textContent = emptyText;
    dom.emptyMessage.hidden = emptyText === '';
    dom.table.hidden = visibleTools.length === 0;
  }

  /**
   * 行のチェックボックス以外の、選択に関する表示（全件選択・選択件数・CSVボタン）を更新する。
   * @param {DomRefs} dom
   * @param {AppState} state
   * @returns {void}
   */
  function renderSelection(dom, state) {
    const selectAllState = getSelectAllState(state.tools, state.selectedIds);
    dom.selectAll.checked = selectAllState === 'all';
    dom.selectAll.indeterminate = selectAllState === 'some';
    dom.selectAll.disabled = state.tools.length === 0;

    const selectedCount = getSelectedTools(state.tools, state.selectedIds).length;
    dom.selectionCount.textContent = `${selectedCount}件を選択中`;
    dom.csvButton.textContent = `選択した${selectedCount}件をCSV出力`;
  }

  /**
   * @param {DomRefs} dom
   * @param {AppState} state
   * @returns {void}
   */
  function renderFormMode(dom, state) {
    const editingTool = state.tools.find((tool) => tool.id === state.editingId);
    const isEditing = editingTool !== undefined;
    dom.form.classList.toggle('is-editing', isEditing);
    dom.formTitle.textContent = isEditing ? `「${editingTool.name}」を編集中` : '新しいAIツールを追加';
    dom.submitButton.textContent = isEditing ? '更新する' : '追加する';
    dom.cancelButton.hidden = !isEditing;
  }

  /**
   * @param {DomRefs} dom
   * @param {PersistenceState} persistence
   * @returns {void}
   */
  function renderStorageState(dom, persistence) {
    const alertMessage = getStorageAlertMessage(persistence);
    dom.storageAlert.textContent = alertMessage ?? '';
    dom.storageAlert.hidden = alertMessage === null;

    const status = getSaveStatus(persistence);
    dom.saveStatus.textContent = status.label;
    dom.saveStatus.dataset.state = status.state;
  }

  /**
   * @param {DomRefs} dom
   * @param {FieldErrors} errors
   * @returns {void}
   */
  function renderFieldErrors(dom, errors) {
    /** @type {ReadonlyArray<[HTMLInputElement, HTMLElement, string | undefined]>} */
    const fields = [
      [dom.nameInput, dom.nameError, errors.name],
      [dom.monthlyInput, dom.monthlyError, errors.monthly],
    ];
    for (const [input, errorElement, message] of fields) {
      errorElement.textContent = message ?? '';
      if (message === undefined) {
        input.removeAttribute('aria-invalid');
      } else {
        input.setAttribute('aria-invalid', 'true');
      }
    }
  }

  /**
   * @param {DomRefs} dom
   * @returns {ToolFormInput}
   */
  function readFormInput(dom) {
    return { name: dom.nameInput.value, monthly: dom.monthlyInput.value, memo: dom.memoInput.value };
  }

  /**
   * @param {DomRefs} dom
   * @param {AITool} tool
   * @returns {void}
   */
  function fillForm(dom, tool) {
    dom.nameInput.value = tool.name;
    dom.monthlyInput.value = String(tool.monthly);
    dom.memoInput.value = tool.memo;
  }

  /**
   * @param {HTMLElement} container
   * @param {string} action
   * @param {string} id
   * @returns {HTMLButtonElement | null}
   */
  function findRowButton(container, action, id) {
    // ID を CSS セレクタに埋め込まず dataset で比較し、セレクタの解釈に依存しない
    for (const button of container.querySelectorAll('button[data-action]')) {
      if (button instanceof HTMLButtonElement && button.dataset.action === action && button.dataset.id === id) {
        return button;
      }
    }
    return null;
  }

  /**
   * @param {string} url
   * @param {string} fileName
   * @returns {void}
   */
  function triggerDownload(url, fileName) {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.hidden = true;
    document.body.append(link);
    try {
      link.click();
    } finally {
      link.remove();
    }
  }

  /**
   * @param {string} content
   * @param {string} fileName
   * @param {string} mimeType
   * @returns {void}
   * @throws {Error} Blob 生成やダウンロード開始に失敗した場合
   */
  function downloadTextFile(content, fileName, mimeType) {
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    try {
      triggerDownload(url, fileName);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_REVOKE_DELAY_MS);
    }
  }

  /**
   * アプリを起動し、イベントを登録する。状態はこの関数のクロージャ内に閉じ込める。
   * @returns {void}
   * @throws {Error} 必須DOM要素が欠けている場合
   */
  function startApp() {
    const dom = queryDom();
    const { persistence, tools } = initPersistence(() => window.localStorage);
    /** @type {AppState} */
    const state = { tools, query: '', sortOrder: DEFAULT_SORT_ORDER, editingId: null, selectedIds: new Set() };
    /** @type {number | undefined} */
    let noticeTimer;

    function render() {
      renderList(dom, state);
      renderSelection(dom, state);
      renderFormMode(dom, state);
      renderStorageState(dom, persistence);
    }

    /**
     * @param {string} message
     * @param {NoticeTone} tone
     */
    function showNotice(message, tone) {
      window.clearTimeout(noticeTimer);
      dom.noticeMessage.textContent = message;
      dom.notice.dataset.tone = tone;
      dom.notice.dataset.open = 'true';
      dom.noticeClose.hidden = false;
      // エラーは読み落としを防ぐため、ユーザーが閉じるまで残す
      if (tone !== 'error') {
        noticeTimer = window.setTimeout(hideNotice, SUCCESS_NOTICE_DURATION_MS);
      }
    }

    function hideNotice() {
      window.clearTimeout(noticeTimer);
      dom.notice.dataset.open = 'false';
      dom.noticeClose.hidden = true;
      dom.noticeMessage.textContent = '';
    }

    /**
     * 全ての変更はここを通し、メモリ更新・保存・再描画・結果通知の順序を統一する。
     * @param {AITool[]} nextTools 検証済みの新しいデータ
     * @param {string} actionMessage
     */
    function commitTools(nextTools, actionMessage) {
      state.tools = nextTools;
      state.selectedIds = pruneSelection(state.selectedIds, nextTools);
      const outcome = persistTools(persistence, nextTools);
      render();
      const result = describeChangeResult(actionMessage, outcome);
      showNotice(result.message, result.tone);
    }

    function resetForm() {
      state.editingId = null;
      dom.form.reset();
      renderFieldErrors(dom, {});
    }

    /** @param {string} id */
    function startEditing(id) {
      const tool = state.tools.find((item) => item.id === id);
      if (tool === undefined) return;
      state.editingId = id;
      fillForm(dom, tool);
      renderFieldErrors(dom, {});
      render();
      dom.nameInput.focus();
    }

    function cancelEditing() {
      const editingId = state.editingId;
      resetForm();
      render();
      const editButton = editingId === null ? null : findRowButton(dom.listBody, 'edit', editingId);
      (editButton ?? dom.nameInput).focus();
    }

    /** @param {string} id */
    function deleteTool(id) {
      const tool = state.tools.find((item) => item.id === id);
      if (tool === undefined) return;
      if (!window.confirm(`「${tool.name}」を削除します。この操作は取り消せません。よろしいですか？`)) return;
      if (state.editingId === id) {
        resetForm();
      }
      commitTools(removeTool(state.tools, id), `「${tool.name}」を削除しました`);
      dom.listTitle.focus();
    }

    /** @param {SubmitEvent} event */
    function handleSubmit(event) {
      event.preventDefault();
      const editingId = state.editingId;
      const result = validateToolInput(readFormInput(dom), state.tools, editingId);
      if (!result.ok) {
        renderFieldErrors(dom, result.errors);
        (result.errors.name !== undefined ? dom.nameInput : dom.monthlyInput).focus();
        showNotice('入力内容に誤りがあります。各項目のメッセージを確認してください。', 'error');
        return;
      }
      const draft = result.value;
      if (editingId !== null && !state.tools.some((tool) => tool.id === editingId)) {
        resetForm();
        render();
        showNotice('編集対象のデータが見つかりませんでした。もう一度選択してください。', 'error');
        return;
      }
      const nextTools =
        editingId === null
          ? addTool(state.tools, draft, createToolId(state.tools))
          : updateTool(state.tools, editingId, draft);
      resetForm();
      commitTools(nextTools, `「${draft.name}」を${editingId === null ? '追加' : '更新'}しました`);
      dom.nameInput.focus();
    }

    function handleReset() {
      const protectionNote = persistence.writeProtected ? '\n読み込めなかった保存データは初期データで上書きされます。' : '';
      const confirmed = window.confirm(
        `登録データを初期の${INITIAL_TOOL_DATA.length}件に戻します。追加・編集・削除した内容は失われます。${protectionNote}\nよろしいですか？`,
      );
      if (!confirmed) return;
      // ユーザーが明示的に確認したため、破損データの保護を解除して上書きを許可する
      persistence.writeProtected = false;
      state.query = '';
      state.sortOrder = DEFAULT_SORT_ORDER;
      // 初期データは新しく作り直したものなので、以前の選択は引き継がない
      state.selectedIds = new Set();
      dom.searchInput.value = '';
      dom.sortSelect.value = DEFAULT_SORT_ORDER;
      resetForm();
      commitTools(createInitialTools(), '初期状態に戻しました');
    }

    function handleCsvDownload() {
      const selectedTools = getSelectedTools(state.tools, state.selectedIds);
      if (selectedTools.length === 0) {
        showNotice('CSVに出力する項目を選択してください。すべて出力する場合は「全件選択」を使用できます。', 'error');
        return;
      }
      /** @type {string} */
      let csv;
      try {
        csv = buildCsv(selectedTools);
      } catch (error) {
        console.error(`${LOG_PREFIX} CSV の生成に失敗しました`, error);
        showNotice('CSVファイルを作成できませんでした。時間をおいて再度お試しください。', 'error');
        return;
      }
      try {
        downloadTextFile(csv, createCsvFileName(new Date()), 'text/csv;charset=utf-8');
      } catch (error) {
        console.error(`${LOG_PREFIX} CSV のダウンロード開始に失敗しました`, error);
        showNotice('CSVファイルのダウンロードを開始できませんでした。ブラウザの設定を確認してください。', 'error');
        return;
      }
      showNotice(`CSVファイル（${selectedTools.length}件）のダウンロードを開始しました。`, 'success');
    }

    dom.form.addEventListener('submit', handleSubmit);
    dom.cancelButton.addEventListener('click', cancelEditing);
    dom.resetButton.addEventListener('click', handleReset);
    dom.csvButton.addEventListener('click', handleCsvDownload);
    dom.noticeClose.addEventListener('click', hideNotice);
    dom.nameInput.addEventListener('input', () => {
      dom.nameError.textContent = '';
      dom.nameInput.removeAttribute('aria-invalid');
    });
    dom.monthlyInput.addEventListener('input', () => {
      dom.monthlyError.textContent = '';
      dom.monthlyInput.removeAttribute('aria-invalid');
    });
    dom.searchInput.addEventListener('input', () => {
      state.query = dom.searchInput.value;
      renderList(dom, state);
    });
    dom.sortSelect.addEventListener('change', () => {
      state.sortOrder = parseSortOrder(dom.sortSelect.value);
      renderList(dom, state);
    });
    dom.form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.editingId !== null) {
        cancelEditing();
      }
    });
    dom.selectAll.addEventListener('change', () => {
      state.selectedIds = selectAllTools(state.tools, dom.selectAll.checked);
      renderList(dom, state);
      renderSelection(dom, state);
    });
    dom.listBody.addEventListener('change', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
      const { id } = target.dataset;
      if (id === undefined) return;
      // 行の再描画はせず、チェックボックスのフォーカスを保ったまま件数表示だけ更新する
      if (target.checked) {
        state.selectedIds.add(id);
      } else {
        state.selectedIds.delete(id);
      }
      renderSelection(dom, state);
    });
    dom.listBody.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest('button[data-action]');
      if (!(button instanceof HTMLButtonElement)) return;
      const { action, id } = button.dataset;
      if (id === undefined) return;
      if (action === 'edit') startEditing(id);
      if (action === 'delete') deleteTool(id);
    });

    render();
  }

  /**
   * 起動できなかったことを利用者に伝える。原因の詳細はコンソールに記録済み。
   * @returns {void}
   */
  function showFatalError() {
    const message = document.createElement('p');
    message.className = 'fatal-error';
    message.setAttribute('role', 'alert');
    message.textContent =
      'アプリケーションを起動できませんでした。ページを再読み込みしてください。解決しない場合は、開発者ツールのコンソールで詳細を確認してください。';
    document.body.prepend(message);
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
      try {
        startApp();
      } catch (error) {
        console.error(`${LOG_PREFIX} 初期化に失敗しました`, error);
        showFatalError();
      }
    });
  }

  return Object.freeze({
    STORAGE_KEY,
    INITIAL_TOOL_DATA,
    formatYen,
    parseToolList,
    validateToolInput,
    createInitialTools,
    createToolId,
    addTool,
    updateTool,
    removeTool,
    filterTools,
    sortTools,
    getVisibleTools,
    parseSortOrder,
    getSelectedTools,
    pruneSelection,
    selectAllTools,
    getSelectAllState,
    neutralizeCsvFormula,
    escapeCsvField,
    buildCsv,
    createCsvFileName,
    openStorage,
    loadTools,
    saveTools,
    initPersistence,
    persistTools,
    getStorageAlertMessage,
    getSaveStatus,
    describeChangeResult,
  });
})();
