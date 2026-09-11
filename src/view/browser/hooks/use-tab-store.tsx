import { normalizeBbsHostname } from "packages/ch-lib/src/index";
import React, {
  createContext,
  type Dispatch,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { platform } from "src/app/platform";
import { getStore2String } from "src/app/Store2Storage";
import { add as addHistoryRecord, remove as removeHistoryRecord } from "src/core/History";
import {
  buildHierarchy,
  getCurrentPage,
  getPageViewStateKey,
  type Page,
  type Pane,
  type Tab,
  type TabViewState,
} from "src/view/browser/types";
import {
  getAutoRefreshPageKey,
  resetAutoRefreshState,
} from "src/view/browser/utils/auto-refresh-pages";
import {
  getBrowserSessionJson,
  setBrowserSessionJson,
} from "src/view/browser/utils/browser-session-storage";
import {
  getBoardUrlFromThreadUrl,
  parseInternalBrowserPage,
} from "src/view/browser/utils/link-routing";
import browser from "webextension-polyfill";

export interface TabStoreState {
  // 横並びのペイン群。配列順がそのまま画面上の左→右の並び。
  panes: Pane[];
  // フォーカス中のペイン。タブ追加/キーボード操作などの暗黙の対象になる。
  activePaneId: string;
  // 閉じたタブの undo は全ペイン共有。
  closedTabs: Tab[];
}

export type TabAction =
  | { type: "ADD_TAB" }
  | { type: "OPEN_IN_NEW_TAB"; page: Page; background?: boolean }
  | { type: "OPEN_IN_NEW_TAB_FORCE"; page: Page }
  | { type: "CLOSE_TAB"; tabId: string }
  | { type: "CLOSE_OTHER_TABS"; tabId: string }
  | { type: "CLOSE_RIGHT_TABS"; tabId: string }
  | { type: "CLOSE_ALL_TABS" }
  | { type: "REOPEN_CLOSED_TAB" }
  | { type: "TOGGLE_PIN"; tabId: string }
  | { type: "MOVE_TAB"; dragTabId: string; toIndex: number }
  | { type: "SELECT_TAB"; tabId: string }
  | { type: "NAVIGATE"; page: Page }
  | { type: "NAVIGATE_TAB"; tabId: string; page: Page }
  | { type: "GO_BACK" }
  | { type: "GO_FORWARD" }
  | { type: "GO_TO_HISTORY_INDEX"; index: number }
  | {
      type: "UPDATE_TAB_VIEW_STATE";
      tabId: string;
      pageKey: string;
      patch: Partial<TabViewState>;
    }
  | { type: "UPDATE_TITLE"; title: string }
  | { type: "UPDATE_TITLE_FOR_TAB"; tabId: string; title: string; boardUrl?: string }
  | { type: "RELOAD" }
  | {
      type: "FOLLOW_NEXT_THREAD";
      page: Extract<Page, { type: "thread" }>;
      keepAutoRefresh?: boolean;
    }
  | {
      type: "SET_AUTO_REFRESH_ENABLED";
      enabled: boolean;
      pageKey?: string;
    }
  // --- ペイン操作（横分割） ---
  // いずれも対象ペインは注入された paneId（操作元ペイン）を基準にする。
  | { type: "SPLIT_PANE" }
  | { type: "OPEN_IN_RIGHT_PANE"; tabId: string }
  | { type: "CLOSE_PANE" }
  | { type: "SET_ACTIVE_PANE" }
  | {
      type: "MOVE_TAB_TO_PANE";
      tabId: string;
      fromPaneId: string;
      toPaneId: string;
      toIndex: number;
    }
  | { type: "RESTORE"; state: TabStoreState };

// ペインスコープ: 全アクションに「対象ペイン」を付与できる。
// 省略時はアクティブペインに作用する（グローバルハンドラ用）。
export type ScopedTabAction = TabAction & { paneId?: string };

// 閉じたタブの最大保持数
const MAX_CLOSED_TABS = 20;
// 横分割ペインの最大数。現状は2ペイン固定のオン/オフ運用にする。
const MAX_PANES = 2;
const CONFIG_KEY_PREFIX = "config_";

type NewTabPageMode = "home" | "related_board" | "custom_board";

function readConfigValue(key: string): string | null {
  try {
    return getStore2String(`${CONFIG_KEY_PREFIX}${key}`);
  } catch {
    return null;
  }
}

function resolveNewTabPageMode(raw: string | null): NewTabPageMode {
  if (raw === "home" || raw === "custom_board") {
    return raw;
  }

  // 未設定時は「関連する板」を既定にして、スレ閲覧中の導線を短縮する。
  return "related_board";
}

function shouldFocusNewTabOnOpen(): boolean {
  const rawValue = readConfigValue("focus_new_tab_on_open");
  if (rawValue === null) {
    return true;
  }
  return rawValue === "on";
}

function normalizePageLocation(rawLocation: string): string {
  try {
    const parsed = new window.URL(rawLocation);
    // 変更理由: 5ch.netから5ch.ioへ正規化したURLと、旧ドメインの履歴URLを
    // 同じ板として照合し、関連板タブで保存済みの板名を引き継ぐため。
    parsed.hostname = normalizeBbsHostname(parsed.hostname);
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "/");
  } catch {
    return rawLocation.trim().replace(/\/+$/, "");
  }
}

interface ThreadHistoryVisit {
  tabId: string;
  threadUrl: string;
  title: string;
  boardTitle: string;
  date: number;
  pending: Promise<void>;
}

function isHistoryDisabled(): boolean {
  return readConfigValue("no_history") === "on";
}

function deriveHistoryBoardTitle(threadUrl: string): string {
  try {
    const parsed = new window.URL(threadUrl);
    const match = parsed.pathname.match(/^(?:\/[\w-]+)?\/test\/read\.cgi\/([\w-]+)\/\d+\/?/);
    return decodeURIComponent(match?.[1] ?? "");
  } catch {
    return "";
  }
}

function getThreadVisitKey(tabId: string, threadUrl: string): string {
  return `${tabId}:${threadUrl}`;
}

function reportHistoryPersistenceError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${context}: ${message}`, error);

  const appMessage = (
    window as Window &
      typeof globalThis & {
        app?: {
          message?: {
            send?: (type: string, payload?: unknown) => void;
          };
        };
      }
  ).app?.message;

  appMessage?.send?.("notify", {
    message: `${context}: ${message}`,
    background_color: "red",
  });
}

function clearThreadVisitsForTab(visitStore: Map<string, ThreadHistoryVisit>, tabId: string): void {
  for (const key of visitStore.keys()) {
    if (key.startsWith(`${tabId}:`)) {
      visitStore.delete(key);
    }
  }
}

function getPageIdentity(page: Page): string {
  switch (page.type) {
    case "home":
      return "home";
    case "boardList":
      return "boardList";
    case "settings":
      return "settings";
    // クイックアクセス3種を別IDとして扱い、
    // 「既に開いている判定」で相互に潰し合って遷移不能になる回帰を防ぐ。
    case "bookmarkList":
      return "bookmarkList";
    case "historyList":
      return "historyList";
    case "writeHistoryList":
      return "writeHistoryList";
    case "logList":
      return "logList";
    case "threadList":
      return getAutoRefreshPageKey(page) ?? "threadList";
    case "thread":
      return getAutoRefreshPageKey(page) ?? "thread";
  }

  throw new Error("Unsupported page type");
}

function createThreadListPageFromBoardUrl(boardUrl: string): Extract<Page, { type: "threadList" }> {
  const normalized = normalizePageLocation(boardUrl);
  return {
    type: "threadList",
    title: normalized,
    boardUrl: normalized,
    boardTitle: normalized,
  };
}

function resolveRelatedBoardPage(
  sourcePage: Page | null,
): Extract<Page, { type: "threadList" }> | null {
  if (!sourcePage) {
    return null;
  }

  if (sourcePage.type === "threadList") {
    return {
      ...sourcePage,
      boardUrl: normalizePageLocation(sourcePage.boardUrl),
      boardTitle: sourcePage.boardTitle || normalizePageLocation(sourcePage.boardUrl),
      title:
        sourcePage.title || sourcePage.boardTitle || normalizePageLocation(sourcePage.boardUrl),
    };
  }

  if (sourcePage.type === "thread") {
    const boardUrl = deriveBoardUrlFromThreadUrl(sourcePage.threadUrl);
    if (!boardUrl) {
      return null;
    }

    return createThreadListPageFromBoardUrl(boardUrl);
  }

  return null;
}

function resolveRelatedBoardPageFromTabHistory(
  sourceTab: Tab | null,
): Extract<Page, { type: "threadList" }> | null {
  if (!sourceTab) {
    return null;
  }

  const currentPage = getCurrentPage(sourceTab);
  if (currentPage.type !== "thread") {
    return null;
  }

  const targetBoardUrl = deriveBoardUrlFromThreadUrl(currentPage.threadUrl);
  if (!targetBoardUrl) {
    return null;
  }

  const normalizedTargetBoardUrl = normalizePageLocation(targetBoardUrl);

  for (let index = sourceTab.currentIndex - 1; index >= 0; index -= 1) {
    const candidate = sourceTab.history[index];
    if (candidate.type !== "threadList") {
      continue;
    }

    if (normalizePageLocation(candidate.boardUrl) !== normalizedTargetBoardUrl) {
      continue;
    }

    return {
      ...candidate,
      boardUrl: normalizedTargetBoardUrl,
      boardTitle: candidate.boardTitle || candidate.title || normalizedTargetBoardUrl,
      title: candidate.title || candidate.boardTitle || normalizedTargetBoardUrl,
    };
  }

  return null;
}

function resolveConfiguredNewTabPage(sourcePage: Page | null, sourceTab: Tab | null = null): Page {
  const mode = resolveNewTabPageMode(readConfigValue("new_tab_page_mode"));

  if (mode === "home") {
    return { type: "home", title: "ホーム" };
  }

  if (mode === "custom_board") {
    const rawBoardUrl = readConfigValue("new_tab_page_board_url");
    if (typeof rawBoardUrl === "string" && rawBoardUrl.trim() !== "") {
      return createThreadListPageFromBoardUrl(rawBoardUrl);
    }

    return { type: "home", title: "ホーム" };
  }

  // 変更理由: 「関連する板」タブをスレッドから開くとき、
  // 直前の threadList 履歴にある確定板名を再利用して URL 仮タイトルの残留を防ぐ。
  const relatedBoardPage =
    resolveRelatedBoardPageFromTabHistory(sourceTab) ?? resolveRelatedBoardPage(sourcePage);
  if (relatedBoardPage) {
    return relatedBoardPage;
  }

  return { type: "home", title: "ホーム" };
}

function createTab(sourcePage: Page | null = null, sourceTab: Tab | null = null): Tab {
  const initialPage = resolveConfiguredNewTabPage(sourcePage, sourceTab);
  return {
    id: crypto.randomUUID(),
    history: buildHierarchy(initialPage),
    currentIndex: buildHierarchy(initialPage).length - 1,
    pinned: false,
    reloadKey: 0,
    autoRefreshEnabled: false,
    autoRefreshPageKey: null,
  };
}

function createTabFromPage(page: Page): Tab {
  const history = buildHierarchy(page);
  return {
    id: crypto.randomUUID(),
    history,
    currentIndex: history.length - 1,
    pinned: false,
    reloadKey: 0,
    autoRefreshEnabled: false,
    autoRefreshPageKey: null,
  };
}

// 単一タブを内包する新規ペインを生成する。
function createPane(initialTab: Tab): Pane {
  return {
    id: crypto.randomUUID(),
    tabs: [initialTab],
    activeTabId: initialTab.id,
  };
}

function readInitialPageFromLocation(): Page | null {
  try {
    const query = new window.URL(window.location.href).searchParams.get("q");
    if (typeof query !== "string" || query.trim() === "") {
      return null;
    }

    return parseInternalBrowserPage(query);
  } catch {
    return null;
  }
}

function sanitizeSessionState(state: TabStoreState): TabStoreState {
  return {
    ...state,
    // 変更理由: 自動更新は実行時状態として扱い、タブ復元/複製で意図せず再開しないよう永続化しない。
    panes: state.panes.map((pane) => ({
      ...pane,
      tabs: pane.tabs.map((tab) => resetAutoRefreshState(tab)),
    })),
    closedTabs: state.closedTabs.map((tab) => resetAutoRefreshState(tab)),
  };
}

function normalizeLoadedTab(tab: Tab): Tab {
  const normalized = {
    ...tab,
    pinned: tab.pinned ?? false,
    reloadKey: tab.reloadKey ?? 0,
  };
  // 変更理由: 旧セッションに自動更新状態が残っていても復元時は常にOFFへ正規化する。
  return resetAutoRefreshState(normalized);
}

// 旧形状（単一タブリスト）のセッションも読めるようにするための型。
type LegacyTabStoreState = {
  tabs?: Tab[];
  activeTabId?: string;
  closedTabs?: Tab[];
};

// セッション復元: localStorageから前回の状態を読み込む。
// 旧形状（{ tabs, activeTabId }）は単一ペインに包んで移行する。
function loadSession(): TabStoreState | null {
  try {
    const raw = getBrowserSessionJson();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TabStoreState & LegacyTabStoreState;

    // 新形状: panes を持つ
    if (parsed.panes?.length && parsed.activePaneId) {
      const panes = parsed.panes
        .filter((pane) => pane.tabs?.length > 0)
        .map((pane) => ({
          ...pane,
          tabs: pane.tabs.map((tab) => normalizeLoadedTab(tab)),
          activeTabId: pane.tabs.some((tab) => tab.id === pane.activeTabId)
            ? pane.activeTabId
            : pane.tabs[0].id,
        }));
      if (panes.length === 0) return null;
      const activePaneId = panes.some((p) => p.id === parsed.activePaneId)
        ? parsed.activePaneId
        : panes[0].id;
      return {
        panes,
        activePaneId,
        closedTabs: (parsed.closedTabs ?? []).map((tab) => normalizeLoadedTab(tab)),
      };
    }

    // 旧形状: 単一タブリスト → 単一ペインへ移行
    if (parsed.tabs && parsed.tabs.length > 0 && parsed.activeTabId) {
      const tabs = parsed.tabs.map((tab) => normalizeLoadedTab(tab));
      const activeTabId = tabs.some((tab) => tab.id === parsed.activeTabId)
        ? parsed.activeTabId
        : tabs[0].id;
      const pane: Pane = {
        id: crypto.randomUUID(),
        tabs,
        activeTabId,
      };
      return {
        panes: [pane],
        activePaneId: pane.id,
        closedTabs: (parsed.closedTabs ?? []).map((tab) => normalizeLoadedTab(tab)),
      };
    }
  } catch {
    // パース失敗時は無視
  }
  return null;
}

function saveSession(state: TabStoreState): void {
  try {
    void setBrowserSessionJson(JSON.stringify(sanitizeSessionState(state)));
  } catch {
    // 容量超過等は無視
  }
}

const initialPageFromLocation = readInitialPageFromLocation();
const restoredSession = initialPageFromLocation ? null : loadSession();
const initialState: TabStoreState =
  restoredSession ??
  (() => {
    const tab = initialPageFromLocation ? createTabFromPage(initialPageFromLocation) : createTab();
    const pane = createPane(tab);
    return {
      panes: [pane],
      activePaneId: pane.id,
      closedTabs: [],
    };
  })();

// --- ペイン解決ヘルパー ---

function getPane(state: TabStoreState, paneId: string): Pane {
  return state.panes.find((p) => p.id === paneId) ?? state.panes[0];
}

function getActivePane(state: TabStoreState): Pane {
  return getPane(state, state.activePaneId);
}

function resolvePaneId(state: TabStoreState, paneId?: string): string {
  if (paneId && state.panes.some((p) => p.id === paneId)) {
    return paneId;
  }
  return state.activePaneId;
}

function updatePane(
  state: TabStoreState,
  paneId: string,
  updater: (pane: Pane) => Pane,
): TabStoreState {
  return {
    ...state,
    panes: state.panes.map((pane) => (pane.id === paneId ? updater(pane) : pane)),
  };
}

function getPaneActiveTab(pane: Pane): Tab {
  return pane.tabs.find((t) => t.id === pane.activeTabId)!;
}

// アクティブペインのアクティブタブ。ウィンドウタイトルなどグローバル文脈で使う。
function getActivePaneActiveTab(state: TabStoreState): Tab {
  return getPaneActiveTab(getActivePane(state));
}

// 全ペインを横断してタブを探す（閲覧履歴記録など）。
function findTabAcrossPanes(state: TabStoreState, tabId: string): Tab | null {
  for (const pane of state.panes) {
    const tab = pane.tabs.find((t) => t.id === tabId);
    if (tab) return tab;
  }
  return null;
}

// 指定ペインのアクティブタブだけを更新する。
function updatePaneActiveTab(
  state: TabStoreState,
  paneId: string,
  updater: (tab: Tab) => Tab,
): TabStoreState {
  return updatePane(state, paneId, (pane) => ({
    ...pane,
    tabs: pane.tabs.map((t) => (t.id === pane.activeTabId ? updater(t) : t)),
  }));
}

function pushPageToTabHistory(tab: Tab, page: Page): Tab {
  const currentPage = getCurrentPage(tab);
  if (getPageIdentity(currentPage) === getPageIdentity(page)) {
    return tab;
  }

  // 現在位置以降の「進む」履歴を切り捨て、新ページを追加する。
  // 魔法なし: 祖先の自動補完はせず、ユーザーが実際に訪れたページだけを積む。
  const historyUntilCurrent = tab.history.slice(0, tab.currentIndex + 1);

  const inheritViewStateForNextThread = (): Tab["viewStates"] => {
    if (currentPage.type !== "thread" || page.type !== "thread") {
      return tab.viewStates;
    }

    const currentPageKey = getPageViewStateKey(currentPage);
    const nextPageKey = getPageViewStateKey(page);
    const currentViewState = tab.viewStates?.[currentPageKey];
    if (!currentViewState || tab.viewStates?.[nextPageKey]) {
      return tab.viewStates;
    }

    // 変更理由: 次スレへの移動では、同じタブで適用していた検索・レス絞り込みを
    // そのまま使える方が自然なため、対象スレに個別状態が無い場合だけ引き継ぐ。
    return {
      ...tab.viewStates,
      [nextPageKey]: currentViewState,
    };
  };

  if (page.type === "thread" && currentPage.type === "threadList") {
    const targetBoardUrl = deriveBoardUrlFromThreadUrl(page.threadUrl);
    const currentBoardUrl = normalizePageLocation(currentPage.boardUrl);

    // 関連する板を初期ページにした新規タブで別板のスレをURL直開きした場合、
    // 関連板をそのまま戻り先にすると対象スレとは別の板へ戻ってしまう。
    // 対象板の一覧をスレ直前に積み、戻る操作で対象板を復元できるようにする。
    if (targetBoardUrl && normalizePageLocation(targetBoardUrl) !== currentBoardUrl) {
      const targetBoardPage = createThreadListPageFromBoardUrl(targetBoardUrl);
      const newHistory = [...historyUntilCurrent, targetBoardPage, page];
      return {
        ...tab,
        history: newHistory,
        currentIndex: newHistory.length - 1,
        viewStates: inheritViewStateForNextThread(),
      };
    }
  }

  const newHistory = [...historyUntilCurrent, page];
  return {
    ...tab,
    history: newHistory,
    currentIndex: newHistory.length - 1,
    viewStates: inheritViewStateForNextThread(),
  };
}

function deriveBoardUrlFromThreadUrl(threadUrl: string): string | null {
  // 変更理由: URL判定を link-routing に集約し、タブ生成時だけ null フォールバック契約を維持する。
  const boardUrl = getBoardUrlFromThreadUrl(threadUrl);
  if (boardUrl !== threadUrl) {
    return boardUrl;
  }

  try {
    const parsed = new window.URL(threadUrl);
    const match = parsed.pathname.match(/^(?:\/[\w-]+)?\/test\/read\.cgi\/([\w-]+)\/\d+\/?/);
    if (!match) {
      return null;
    }

    // 変更理由: 互換ホスト判定外でも read.cgi 形式のURL直開きは存在するため、
    // 最低限 board セグメントだけ復元して canonical stack を壊さないようにする。
    return `${parsed.origin}/${match[1]}/`;
  } catch {
    return null;
  }
}

function buildCanonicalThreadListStack(
  threadListPage: Extract<Page, { type: "threadList" }>,
): Page[] {
  return [
    { type: "home", title: "ホーム" },
    { type: "boardList", title: "板一覧" },
    threadListPage,
  ];
}

function buildCanonicalThreadStack(
  threadPage: Extract<Page, { type: "thread" }>,
  sourceThreadListPage: Extract<Page, { type: "threadList" }> | null,
): Page[] {
  const targetBoardUrl = deriveBoardUrlFromThreadUrl(threadPage.threadUrl);
  const normalizedTargetBoardUrl = targetBoardUrl ? normalizePageLocation(targetBoardUrl) : null;

  const boardPageFromSource =
    sourceThreadListPage &&
    normalizedTargetBoardUrl &&
    normalizePageLocation(sourceThreadListPage.boardUrl) === normalizedTargetBoardUrl
      ? sourceThreadListPage
      : null;

  const boardPage: Extract<Page, { type: "threadList" }> = boardPageFromSource ?? {
    type: "threadList",
    title: targetBoardUrl ?? threadPage.threadUrl,
    boardUrl: targetBoardUrl ?? threadPage.threadUrl,
    boardTitle: targetBoardUrl ?? threadPage.threadUrl,
  };

  return [...buildCanonicalThreadListStack(boardPage), threadPage];
}

// 新規タブ専用: 現在ページをコンテキストにカノニカルな祖先履歴を生成する。
// インタブのナビゲーション（NAVIGATE）では使わず、祖先の自動補完はしない。
function buildHierarchyForNewTab(sourcePage: Page, targetPage: Page): Page[] {
  if (targetPage.type === "thread") {
    return buildCanonicalThreadStack(
      targetPage,
      sourcePage.type === "threadList" ? sourcePage : null,
    );
  }

  if (targetPage.type === "threadList") {
    return buildCanonicalThreadListStack(targetPage);
  }

  return buildHierarchy(targetPage);
}

// 閉じたタブを記録するヘルパー
function pushClosed(closedTabs: Tab[], tab: Tab): Tab[] {
  return [tab, ...closedTabs].slice(0, MAX_CLOSED_TABS);
}

function tabReducer(state: TabStoreState, action: ScopedTabAction): TabStoreState {
  switch (action.type) {
    case "ADD_TAB": {
      const paneId = resolvePaneId(state, action.paneId);
      const pane = getPane(state, paneId);
      const activeTab = getPaneActiveTab(pane);
      const sourcePage = getCurrentPage(activeTab);
      const newTab = createTab(sourcePage, activeTab);
      // 固定タブの後ろに非固定タブを追加
      return {
        ...updatePane(state, paneId, (p) => ({
          ...p,
          tabs: [...p.tabs, newTab],
          activeTabId: newTab.id,
        })),
        activePaneId: paneId,
      };
    }

    case "OPEN_IN_NEW_TAB": {
      // 同一 URL のタブが既に存在する場合はそちらをフォーカスして重複を防ぐ。
      // 重複判定はペイン内に閉じる（別ペインで同じスレを並べて見比べられるように）。
      // 強制的に新タブを開きたい場合は OPEN_IN_NEW_TAB_FORCE を使う。
      const paneId = resolvePaneId(state, action.paneId);
      const pane = getPane(state, paneId);
      const targetIdentity = getPageIdentity(action.page);
      const existingDuplicate = pane.tabs.find(
        (t) => getPageIdentity(getCurrentPage(t)) === targetIdentity,
      );
      if (existingDuplicate) {
        return {
          ...updatePane(state, paneId, (p) => ({
            ...p,
            activeTabId: existingDuplicate.id,
          })),
          activePaneId: paneId,
        };
      }

      // バックグラウンドで新規タブを開く（アクティブタブ/ペインを切り替えない）。
      // buildHierarchyForNewTab で現在ページの板名を引き継いだカノニカルな祖先履歴を付与する。
      // background フラグが true の場合は、設定値を無視して常にバックグラウンドで開く。
      const newTabForOpen = createTab();
      const sourcePageForOpen = getCurrentPage(getPaneActiveTab(pane));
      const newHistoryForOpen = buildHierarchyForNewTab(sourcePageForOpen, action.page);
      const shouldFocus = action.background ? false : shouldFocusNewTabOnOpen();
      const nextPane = updatePane(state, paneId, (p) => ({
        ...p,
        tabs: [
          ...p.tabs,
          {
            ...newTabForOpen,
            history: newHistoryForOpen,
            currentIndex: newHistoryForOpen.length - 1,
          },
        ],
        activeTabId: shouldFocus ? newTabForOpen.id : p.activeTabId,
      }));

      return {
        ...nextPane,
        activePaneId: shouldFocus ? paneId : state.activePaneId,
      };
    }

    case "OPEN_IN_NEW_TAB_FORCE": {
      const paneId = resolvePaneId(state, action.paneId);
      const pane = getPane(state, paneId);
      const newTabForForce = createTab();
      const sourcePageForForce = getCurrentPage(getPaneActiveTab(pane));
      const newHistoryForForce = buildHierarchyForNewTab(sourcePageForForce, action.page);
      return updatePane(state, paneId, (p) => ({
        ...p,
        tabs: [
          ...p.tabs,
          {
            ...newTabForForce,
            history: newHistoryForForce,
            currentIndex: newHistoryForForce.length - 1,
          },
        ],
        // activeTabId は変更しない
      }));
    }

    case "CLOSE_TAB": {
      const paneId = resolvePaneId(state, action.paneId);
      const pane = getPane(state, paneId);
      const target = pane.tabs.find((t) => t.id === action.tabId);
      // 固定タブは閉じられない
      if (!target || target.pinned) return state;
      if (pane.tabs.length <= 1) {
        // 変更理由: 最後の通常タブを削除してペインが空になると、表示と操作の対象を失うため、
        // 元タブを閉じたタブ履歴へ残したうえで、Issueの期待するホームタブへ置き換える。
        const replacement = createTabFromPage({ type: "home", title: "ホーム" });
        return {
          ...updatePane(state, paneId, (p) => ({
            ...p,
            tabs: [replacement],
            activeTabId: replacement.id,
          })),
          activePaneId: paneId,
          closedTabs: pushClosed(state.closedTabs, target),
        };
      }
      const closingIndex = pane.tabs.indexOf(target);
      const remaining = pane.tabs.filter((t) => t.id !== action.tabId);
      let newActiveId = pane.activeTabId;
      if (action.tabId === pane.activeTabId) {
        const newIndex = Math.min(closingIndex, remaining.length - 1);
        newActiveId = remaining[newIndex].id;
      }
      return {
        ...updatePane(state, paneId, (p) => ({
          ...p,
          tabs: remaining,
          activeTabId: newActiveId,
        })),
        activePaneId: paneId,
        closedTabs: pushClosed(state.closedTabs, target),
      };
    }

    case "CLOSE_OTHER_TABS": {
      const paneId = resolvePaneId(state, action.paneId);
      const pane = getPane(state, paneId);
      // 指定タブと固定タブ以外を閉じる
      const closed = pane.tabs.filter((t) => t.id !== action.tabId && !t.pinned);
      const remaining = pane.tabs.filter((t) => t.id === action.tabId || t.pinned);
      if (remaining.length === 0) return state;
      let newClosed = state.closedTabs;
      for (const t of closed) {
        newClosed = pushClosed(newClosed, t);
      }
      return {
        ...updatePane(state, paneId, (p) => ({
          ...p,
          tabs: remaining,
          activeTabId: action.tabId,
        })),
        activePaneId: paneId,
        closedTabs: newClosed,
      };
    }

    case "CLOSE_RIGHT_TABS": {
      const paneId = resolvePaneId(state, action.paneId);
      const pane = getPane(state, paneId);
      const idx = pane.tabs.findIndex((t) => t.id === action.tabId);
      if (idx === -1) return state;
      const rightTabs = pane.tabs.slice(idx + 1).filter((t) => !t.pinned);
      if (rightTabs.length === 0) return state;
      const rightIds = new Set(rightTabs.map((t) => t.id));
      const remaining = pane.tabs.filter((t) => !rightIds.has(t.id));
      let newClosed = state.closedTabs;
      for (const t of rightTabs) {
        newClosed = pushClosed(newClosed, t);
      }
      let newActiveId = pane.activeTabId;
      if (rightIds.has(pane.activeTabId)) {
        newActiveId = action.tabId;
      }
      return {
        ...updatePane(state, paneId, (p) => ({
          ...p,
          tabs: remaining,
          activeTabId: newActiveId,
        })),
        activePaneId: paneId,
        closedTabs: newClosed,
      };
    }

    case "CLOSE_ALL_TABS": {
      const paneId = resolvePaneId(state, action.paneId);
      const pane = getPane(state, paneId);
      // 固定タブ以外をすべて閉じ、新しいタブを開く
      const pinned = pane.tabs.filter((t) => t.pinned);
      const closed = pane.tabs.filter((t) => !t.pinned);
      let newClosed = state.closedTabs;
      for (const t of closed) {
        newClosed = pushClosed(newClosed, t);
      }
      const activeTab = getPaneActiveTab(pane);
      const sourcePage = getCurrentPage(activeTab);
      const newTab = createTab(sourcePage, activeTab);
      return {
        ...updatePane(state, paneId, (p) => ({
          ...p,
          tabs: [...pinned, newTab],
          activeTabId: newTab.id,
        })),
        activePaneId: paneId,
        closedTabs: newClosed,
      };
    }

    case "REOPEN_CLOSED_TAB": {
      if (state.closedTabs.length === 0) return state;
      const paneId = resolvePaneId(state, action.paneId);
      const [reopened, ...rest] = state.closedTabs;
      // 変更理由: 閉じたタブを新規タブとして開き直す時は、自動更新状態を引き継がない。
      const restored: Tab = {
        ...resetAutoRefreshState(reopened),
        id: crypto.randomUUID(),
      };
      return {
        ...updatePane(state, paneId, (p) => ({
          ...p,
          tabs: [...p.tabs, restored],
          activeTabId: restored.id,
        })),
        activePaneId: paneId,
        closedTabs: rest,
      };
    }

    case "TOGGLE_PIN": {
      const paneId = resolvePaneId(state, action.paneId);
      return updatePane(state, paneId, (p) => {
        const tabs = p.tabs.map((t) => (t.id === action.tabId ? { ...t, pinned: !t.pinned } : t));
        // 固定タブを左に、非固定タブを右に並び替え
        tabs.sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1));
        return { ...p, tabs };
      });
    }

    case "MOVE_TAB": {
      const paneId = resolvePaneId(state, action.paneId);
      const pane = getPane(state, paneId);
      const dragTab = pane.tabs.find((t) => t.id === action.dragTabId);
      if (!dragTab) {
        return state;
      }

      // 変更理由: @dnd-kit の OptimisticSortingPlugin はドラッグ中に DOM を物理的に
      // 並べ替え、最終位置を source.sortable.index（グループ内インデックス）として確定する。
      // ドロップ先タブIDから移動先を逆算すると、その投影インデックスとズレてホイール順序が
      // 表示順と食い違うため、グループ内インデックスを直接の真実として並べ替える。
      const group = pane.tabs.filter((t) => t.pinned === dragTab.pinned);
      const others = pane.tabs.filter((t) => t.pinned !== dragTab.pinned);
      const fromIndex = group.findIndex((t) => t.id === action.dragTabId);
      const toIndex = Math.max(0, Math.min(action.toIndex, group.length - 1));
      if (fromIndex === -1 || fromIndex === toIndex) {
        return state;
      }

      const reorderedGroup = [...group];
      reorderedGroup.splice(toIndex, 0, reorderedGroup.splice(fromIndex, 1)[0]);
      // ピン留めタブは常に左、通常タブは常に右、の不変条件を保って再結合する。
      return updatePane(state, paneId, (p) => ({
        ...p,
        tabs: dragTab.pinned ? [...reorderedGroup, ...others] : [...others, ...reorderedGroup],
      }));
    }

    case "SELECT_TAB": {
      const paneId = resolvePaneId(state, action.paneId);
      return {
        ...updatePane(state, paneId, (p) => ({
          ...p,
          activeTabId: action.tabId,
        })),
        activePaneId: paneId,
      };
    }

    case "NAVIGATE": {
      const paneId = resolvePaneId(state, action.paneId);
      const pane = getPane(state, paneId);
      const currentPage = getCurrentPage(getPaneActiveTab(pane));
      if (getPageIdentity(currentPage) === getPageIdentity(action.page)) {
        return state;
      }

      return {
        ...updatePaneActiveTab(state, paneId, (tab) =>
          resetAutoRefreshState(pushPageToTabHistory(tab, action.page)),
        ),
        activePaneId: paneId,
      };
    }

    case "NAVIGATE_TAB": {
      const paneId = resolvePaneId(state, action.paneId);
      const pane = getPane(state, paneId);
      const targetTab = pane.tabs.find((tab) => tab.id === action.tabId);
      if (!targetTab) {
        return state;
      }

      if (getPageIdentity(getCurrentPage(targetTab)) === getPageIdentity(action.page)) {
        return {
          ...updatePane(state, paneId, (p) => ({
            ...p,
            activeTabId: action.tabId,
          })),
          activePaneId: paneId,
        };
      }

      // 指定タブの実履歴を保ったままページを追加する。
      return {
        ...updatePane(state, paneId, (p) => ({
          ...p,
          activeTabId: action.tabId,
          tabs: p.tabs.map((t) =>
            t.id === action.tabId ? resetAutoRefreshState(pushPageToTabHistory(t, action.page)) : t,
          ),
        })),
        activePaneId: paneId,
      };
    }

    case "GO_BACK": {
      const paneId = resolvePaneId(state, action.paneId);
      const tab = getPaneActiveTab(getPane(state, paneId));
      if (tab.currentIndex <= 0) return state;
      return updatePaneActiveTab(state, paneId, (t) =>
        resetAutoRefreshState({
          ...t,
          currentIndex: t.currentIndex - 1,
        }),
      );
    }

    case "GO_FORWARD": {
      const paneId = resolvePaneId(state, action.paneId);
      const tab = getPaneActiveTab(getPane(state, paneId));
      if (tab.currentIndex >= tab.history.length - 1) return state;
      return updatePaneActiveTab(state, paneId, (t) =>
        resetAutoRefreshState({
          ...t,
          currentIndex: t.currentIndex + 1,
        }),
      );
    }

    case "GO_TO_HISTORY_INDEX": {
      const paneId = resolvePaneId(state, action.paneId);
      const tab = getPaneActiveTab(getPane(state, paneId));
      if (action.index < 0 || action.index >= tab.history.length) return state;
      if (action.index === tab.currentIndex) return state;
      return updatePaneActiveTab(state, paneId, (t) =>
        resetAutoRefreshState({
          ...t,
          currentIndex: action.index,
        }),
      );
    }

    case "UPDATE_TAB_VIEW_STATE": {
      // view state はタブIDで一意に特定できるため、ペインを跨いだ更新にも耐える。
      return {
        ...state,
        panes: state.panes.map((pane) => ({
          ...pane,
          tabs: pane.tabs.map((tab) => {
            if (tab.id !== action.tabId) {
              return tab;
            }

            return {
              ...tab,
              viewStates: {
                ...tab.viewStates,
                [action.pageKey]: {
                  ...tab.viewStates?.[action.pageKey],
                  ...action.patch,
                },
              },
            };
          }),
        })),
      };
    }

    case "UPDATE_TITLE": {
      const paneId = resolvePaneId(state, action.paneId);
      const tab = getPaneActiveTab(getPane(state, paneId));
      const currentPage = { ...tab.history[tab.currentIndex] };
      currentPage.title = action.title;
      const newHistory = [...tab.history];
      newHistory[tab.currentIndex] = currentPage;
      return updatePaneActiveTab(state, paneId, (t) => ({
        ...t,
        history: newHistory,
      }));
    }

    case "UPDATE_TITLE_FOR_TAB": {
      // 背景ペイン/タブの非同期タイトル解決でも動くよう、全ペインを横断して該当タブを更新する。
      // boardUrl がある場合は、現在ページではなく対象板の履歴を更新する。
      // URL直開き後に板名解決が完了しても、履歴中の板一覧へ結果を残すため。
      return {
        ...state,
        panes: state.panes.map((pane) => {
          if (!pane.tabs.some((t) => t.id === action.tabId)) {
            return pane;
          }
          return {
            ...pane,
            tabs: pane.tabs.map((tab) => {
              if (tab.id !== action.tabId) {
                return tab;
              }

              const targetBoardUrl = action.boardUrl
                ? normalizePageLocation(action.boardUrl)
                : null;
              const updatedHistory = tab.history.map((page, index) => {
                const isTargetPage = targetBoardUrl
                  ? page.type === "threadList" &&
                    normalizePageLocation(page.boardUrl) === targetBoardUrl
                  : index === tab.currentIndex;
                if (!isTargetPage || page.title === action.title) {
                  return page;
                }

                if (page.type === "threadList") {
                  return {
                    ...page,
                    // 変更理由: 板名解決がページ遷移後に完了しても、title と boardTitle を
                    // 同時に更新して関連板導線と板名表示の不一致を防ぐ。
                    title: action.title,
                    boardTitle: action.title,
                  };
                }

                return {
                  ...page,
                  title: action.title,
                };
              });

              if (updatedHistory.every((page, index) => page === tab.history[index])) {
                return tab;
              }

              return {
                ...tab,
                history: updatedHistory,
              };
            }),
          };
        }),
      };
    }

    case "RELOAD": {
      // 履歴を変えずにreloadKeyをインクリメントする。
      // ContentAreaがこれをkeyに使うことでページコンポーネントが再マウントされ、データ再取得が走る。
      const paneId = resolvePaneId(state, action.paneId);
      return updatePaneActiveTab(state, paneId, (tab) => ({
        ...tab,
        reloadKey: tab.reloadKey + 1,
      }));
    }

    case "FOLLOW_NEXT_THREAD": {
      const paneId = resolvePaneId(state, action.paneId);
      return updatePaneActiveTab(state, paneId, (tab) => {
        const nextTab = pushPageToTabHistory(tab, action.page);
        // 自動次スレ移動は「このタブの流れ」を保つのが目的なので、
        // 既存タブ集約を経由せず現在タブの履歴と自動更新束縛を同時に更新する。
        return {
          ...nextTab,
          autoRefreshEnabled: action.keepAutoRefresh ? true : nextTab.autoRefreshEnabled,
          autoRefreshPageKey: action.keepAutoRefresh
            ? getAutoRefreshPageKey(action.page)
            : nextTab.autoRefreshPageKey,
        };
      });
    }

    case "SET_AUTO_REFRESH_ENABLED": {
      const paneId = resolvePaneId(state, action.paneId);
      return updatePaneActiveTab(state, paneId, (tab) => ({
        ...tab,
        autoRefreshEnabled: action.enabled,
        autoRefreshPageKey: action.enabled ? (action.pageKey ?? tab.autoRefreshPageKey) : null,
      }));
    }

    // --- ペイン操作 ---

    case "SPLIT_PANE": {
      // 最大ペイン数に達していれば分割しない（2ペイン固定運用）。
      if (state.panes.length >= MAX_PANES) return state;
      // 操作元ペインの右隣に、現在ページを引き継いだ新規ペインを作成してフォーカスする。
      const sourcePaneId = resolvePaneId(state, action.paneId);
      const sourceIndex = state.panes.findIndex((p) => p.id === sourcePaneId);
      const sourcePane = state.panes[sourceIndex];
      const sourceActiveTab = sourcePane ? getPaneActiveTab(sourcePane) : null;
      const sourcePage = sourceActiveTab ? getCurrentPage(sourceActiveTab) : null;
      const newPane = createPane(createTab(sourcePage, sourceActiveTab));
      const panes = [...state.panes];
      panes.splice(sourceIndex + 1, 0, newPane);
      return { ...state, panes, activePaneId: newPane.id };
    }

    case "CLOSE_PANE": {
      // 最低1ペインは維持する。
      if (state.panes.length <= 1) return state;
      const paneId = resolvePaneId(state, action.paneId);
      const index = state.panes.findIndex((p) => p.id === paneId);
      if (index === -1) return state;
      const closingPane = state.panes[index];
      const panes = state.panes.filter((p) => p.id !== paneId);
      // 閉じたペインのタブは undo 可能にするため closedTabs へ積む。
      let newClosed = state.closedTabs;
      for (const t of closingPane.tabs) {
        newClosed = pushClosed(newClosed, t);
      }
      let activePaneId = state.activePaneId;
      if (state.activePaneId === paneId) {
        activePaneId = panes[Math.min(index, panes.length - 1)].id;
      }
      return { ...state, panes, activePaneId, closedTabs: newClosed };
    }

    case "SET_ACTIVE_PANE": {
      const paneId = resolvePaneId(state, action.paneId);
      if (paneId === state.activePaneId) return state;
      return { ...state, activePaneId: paneId };
    }

    case "OPEN_IN_RIGHT_PANE": {
      // 操作元ペインのタブを右隣ペインへ移動する。右隣が無ければ新規作成する。
      const sourcePaneId = resolvePaneId(state, action.paneId);
      const sourceIndex = state.panes.findIndex((p) => p.id === sourcePaneId);
      if (sourceIndex === -1) return state;
      const sourcePane = state.panes[sourceIndex];
      const movingTab = sourcePane.tabs.find((t) => t.id === action.tabId);
      if (!movingTab) return state;

      // 元ペインから対象タブを除く。空になるなら既定タブを補充してペインを維持する。
      let remainingSourceTabs = sourcePane.tabs.filter((t) => t.id !== action.tabId);
      if (remainingSourceTabs.length === 0) {
        remainingSourceTabs = [createTab()];
      }
      const newSourceActiveId =
        sourcePane.activeTabId === action.tabId
          ? remainingSourceTabs[remainingSourceTabs.length - 1].id
          : sourcePane.activeTabId;
      const updatedSourcePane: Pane = {
        ...sourcePane,
        tabs: remainingSourceTabs,
        activeTabId: newSourceActiveId,
      };

      const rightPane = state.panes[sourceIndex + 1];
      if (rightPane) {
        const updatedRightPane: Pane = {
          ...rightPane,
          tabs: [...rightPane.tabs, movingTab],
          activeTabId: movingTab.id,
        };
        const panes = state.panes.map((p) =>
          p.id === sourcePaneId ? updatedSourcePane : p.id === rightPane.id ? updatedRightPane : p,
        );
        return { ...state, panes, activePaneId: rightPane.id };
      }

      // 右隣が無く、かつ最大ペイン数に達している場合は移動先が作れないので何もしない。
      if (state.panes.length >= MAX_PANES) return state;

      const newPane = createPane(movingTab);
      const panes = state.panes.map((p) => (p.id === sourcePaneId ? updatedSourcePane : p));
      panes.splice(sourceIndex + 1, 0, newPane);
      return { ...state, panes, activePaneId: newPane.id };
    }

    case "MOVE_TAB_TO_PANE": {
      // ペイン間でタブを移動する（将来のドラッグ&ドロップ用の土台）。
      const fromPane = state.panes.find((p) => p.id === action.fromPaneId);
      const toPane = state.panes.find((p) => p.id === action.toPaneId);
      if (!fromPane || !toPane || fromPane.id === toPane.id) return state;
      const movingTab = fromPane.tabs.find((t) => t.id === action.tabId);
      if (!movingTab) return state;

      let remainingFrom = fromPane.tabs.filter((t) => t.id !== action.tabId);
      if (remainingFrom.length === 0) {
        remainingFrom = [createTab()];
      }
      const newFromActiveId =
        fromPane.activeTabId === action.tabId
          ? remainingFrom[remainingFrom.length - 1].id
          : fromPane.activeTabId;
      const toIndex = Math.max(0, Math.min(action.toIndex, toPane.tabs.length));
      const newToTabs = [...toPane.tabs];
      newToTabs.splice(toIndex, 0, movingTab);
      return {
        ...state,
        panes: state.panes.map((p) =>
          p.id === action.fromPaneId
            ? { ...p, tabs: remainingFrom, activeTabId: newFromActiveId }
            : p.id === action.toPaneId
              ? { ...p, tabs: newToTabs, activeTabId: movingTab.id }
              : p,
        ),
        activePaneId: action.toPaneId,
      };
    }

    case "RESTORE":
      return sanitizeSessionState(action.state);

    default:
      return state;
  }
}

// --- Context ---

// グローバルコンテキスト: ペイン配列を含む全体状態を保持する。
interface TabContextValue {
  state: TabStoreState;
  // startTransition 配下の dispatch でも常に最新 state を参照できるよう同期 ref を公開する。
  stateRef: React.RefObject<TabStoreState>;
  dispatch: Dispatch<ScopedTabAction>;
}

// ペインスコープ: useTabStore が返す「自ペインのスライス」。
// 旧 TabStoreState と同じ形のため、消費側はほぼ無改修で自ペインを操作できる。
export interface PaneScopedState {
  tabs: Tab[];
  activeTabId: string;
  closedTabs: Tab[];
}

export interface PaneScopedTabStore {
  state: PaneScopedState;
  // stateRef はグローバル状態を指す。ペイン解決には paneId を併用する。
  stateRef: React.RefObject<TabStoreState>;
  dispatch: Dispatch<ScopedTabAction>;
  activeTab: Tab;
  currentPage: Page;
  paneId: string;
}

const TabContext = createContext<TabContextValue | null>(null);
const TabDispatchContext = createContext<Dispatch<ScopedTabAction> | null>(null);
// 各ペインのサブツリーに paneId を供給する。未提供時はアクティブペインにフォールバックする。
const PaneContext = createContext<{ paneId: string } | null>(null);

export const PaneProvider: React.FC<{
  paneId: string;
  children: ReactNode;
}> = ({ paneId, children }) => {
  const value = useMemo(() => ({ paneId }), [paneId]);
  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>;
};

export const TabProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [state, baseDispatch] = useReducer(tabReducer, initialState);
  const stateRef = useRef(state);
  const threadVisitRef = useRef<Map<string, ThreadHistoryVisit>>(new Map());
  // ウィンドウタイトル更新用に、アクティブペインのアクティブタブの現在ページを参照する。
  const currentPage = getCurrentPage(getActivePaneActiveTab(state));

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const persistThreadVisit = useCallback(
    (tabId: string, page: Extract<Page, { type: "thread" }>) => {
      if (isHistoryDisabled()) {
        clearThreadVisitsForTab(threadVisitRef.current, tabId);
        return;
      }

      const date = Date.now();
      const visitKey = getThreadVisitKey(tabId, page.threadUrl);
      const visit: ThreadHistoryVisit = {
        tabId,
        threadUrl: page.threadUrl,
        title: page.title,
        boardTitle: deriveHistoryBoardTitle(page.threadUrl),
        date,
        pending: Promise.resolve(),
      };

      clearThreadVisitsForTab(threadVisitRef.current, tabId);

      visit.pending = addHistoryRecord(
        visit.threadUrl,
        visit.title,
        visit.date,
        visit.boardTitle,
      ).catch((error) => {
        reportHistoryPersistenceError("閲覧履歴の保存に失敗しました", error);
      });

      threadVisitRef.current.set(visitKey, visit);
    },
    [],
  );

  const syncThreadVisitTitle = useCallback(
    (tabId: string, page: Extract<Page, { type: "thread" }>, title: string) => {
      const visitKey = getThreadVisitKey(tabId, page.threadUrl);
      const visit = threadVisitRef.current.get(visitKey);
      if (!visit || visit.title === title || title.trim() === "") {
        return;
      }

      visit.pending = visit.pending
        .then(async () => {
          await removeHistoryRecord(visit.threadUrl, visit.date);
          await addHistoryRecord(visit.threadUrl, title, visit.date, visit.boardTitle);
          visit.title = title;
        })
        .catch((error) => {
          reportHistoryPersistenceError("閲覧履歴タイトルの更新に失敗しました", error);
        });
    },
    [],
  );

  const dispatch = useCallback<Dispatch<ScopedTabAction>>(
    (action) => {
      const prevState = stateRef.current;
      const nextState = tabReducer(prevState, action);
      stateRef.current = nextState;
      baseDispatch(action);

      const recordThreadVisitForTab = (tabId: string) => {
        const nextTab = findTabAcrossPanes(nextState, tabId);
        if (!nextTab) {
          return;
        }

        const nextPage = getCurrentPage(nextTab);
        if (nextPage.type !== "thread") {
          return;
        }

        const prevTab = findTabAcrossPanes(prevState, tabId);
        const prevPage = prevTab ? getCurrentPage(prevTab) : null;
        if (prevPage?.type === "thread" && prevPage.threadUrl === nextPage.threadUrl) {
          return;
        }

        // 変更理由: 戻る/進むではなく「開く系 action」で current page が thread に変わった瞬間に記録し、
        // 背景タブでも表示待ちなしで履歴へ出るようにする。
        persistThreadVisit(tabId, nextPage);
      };

      switch (action.type) {
        case "NAVIGATE":
        case "FOLLOW_NEXT_THREAD":
        case "NAVIGATE_TAB": {
          // 対象ペイン（注入された paneId、無ければアクティブペイン）のアクティブタブを記録する。
          const paneId = resolvePaneId(prevState, action.paneId);
          recordThreadVisitForTab(getPane(nextState, paneId).activeTabId);
          return;
        }

        case "OPEN_IN_NEW_TAB":
        case "OPEN_IN_NEW_TAB_FORCE":
        case "REOPEN_CLOSED_TAB": {
          const prevTabIds = new Set(prevState.panes.flatMap((p) => p.tabs).map((tab) => tab.id));
          const insertedTab = nextState.panes
            .flatMap((p) => p.tabs)
            .find((tab) => !prevTabIds.has(tab.id));
          if (insertedTab) {
            recordThreadVisitForTab(insertedTab.id);
          }
          return;
        }

        case "UPDATE_TITLE": {
          const paneId = resolvePaneId(nextState, action.paneId);
          const activeTabId = getPane(nextState, paneId).activeTabId;
          const nextTab = findTabAcrossPanes(nextState, activeTabId);
          const nextPage = nextTab ? getCurrentPage(nextTab) : null;
          if (nextPage?.type === "thread") {
            syncThreadVisitTitle(activeTabId, nextPage, action.title);
          }
          return;
        }

        case "UPDATE_TITLE_FOR_TAB": {
          if (action.boardUrl) {
            return;
          }
          const nextTab = findTabAcrossPanes(nextState, action.tabId);
          const nextPage = nextTab ? getCurrentPage(nextTab) : null;
          if (nextPage?.type === "thread") {
            syncThreadVisitTitle(action.tabId, nextPage, action.title);
          }
          return;
        }

        default:
          return;
      }
    },
    [baseDispatch, persistThreadVisit, syncThreadVisitTitle],
  );

  // background からの新タブ追加指示を受け取り OPEN_IN_NEW_TAB をディスパッチする
  useEffect(() => {
    const handleMessage = (message: unknown) => {
      const msg = message as { type?: unknown; url?: unknown };
      if (msg.type === "open-tab-in-viewer" && typeof msg.url === "string") {
        const page = parseInternalBrowserPage(msg.url);
        if (page) {
          dispatch({ type: "OPEN_IN_NEW_TAB", page });
        }
      }
    };
    browser.runtime.onMessage.addListener(handleMessage);
    return () => {
      browser.runtime.onMessage.removeListener(handleMessage);
    };
  }, [dispatch]);

  // セッション永続化: state変更時にlocalStorageへ保存
  useEffect(() => {
    saveSession(state);
  }, [state]);

  // アクティブタブのページタイトルが変わったらウィンドウタイトルを更新する
  useEffect(() => {
    const title = currentPage.title ? `${currentPage.title} - read.crx 2` : "read.crx 2";
    platform.window.setTitle(title).catch(() => {});
  }, [currentPage.title]);

  // ブラウザの戻る/進むをアプリ内ナビゲーションに接続
  // history.pushState/popstateの状態同期に頼らず、キーボード/マウスイベントで直接制御する
  // タブ切り替え時にブラウザ履歴が汚染されるバグを回避するため
  useEffect(() => {
    // 拡張機能ページからの離脱防止用ダミー履歴エントリ
    history.replaceState({ app: true }, "");

    const handlePopState = () => {
      // ブラウザのBack/Forward操作によるページ離脱を防止し、アプリ内GO_BACKに変換
      history.pushState({ app: true }, "");
      dispatch({ type: "GO_BACK" });
    };

    // Alt+Left/Rightで戻る/進む
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.shiftKey) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          dispatch({ type: "GO_BACK" });
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          dispatch({ type: "GO_FORWARD" });
        }
      }
    };

    // マウスサイドボタン（戻る=3/進む=4）
    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        dispatch({ type: "GO_BACK" });
      } else if (e.button === 4) {
        e.preventDefault();
        dispatch({ type: "GO_FORWARD" });
      }
    };

    window.addEventListener("popstate", handlePopState);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dispatch]);

  const contextValue = useMemo<TabContextValue>(
    () => ({ state, stateRef, dispatch }),
    [state, dispatch],
  );

  return (
    <TabDispatchContext.Provider value={dispatch}>
      <TabContext.Provider value={contextValue}>{children}</TabContext.Provider>
    </TabDispatchContext.Provider>
  );
};

// 注入された paneId を解決する（無効/未提供ならアクティブペイン）。
function usePaneIdFromContext(state: TabStoreState): string {
  const paneCtx = useContext(PaneContext);
  if (paneCtx && state.panes.some((p) => p.id === paneCtx.paneId)) {
    return paneCtx.paneId;
  }
  return state.activePaneId;
}

export function useTabStore(): PaneScopedTabStore {
  const ctx = useContext(TabContext);
  if (!ctx) {
    throw new Error("useTabStore must be used within TabProvider");
  }
  const paneId = usePaneIdFromContext(ctx.state);
  const pane = getPane(ctx.state, paneId);
  const activeTab = getPaneActiveTab(pane);
  const currentPage = getCurrentPage(activeTab);

  // 旧 TabStoreState と同形のスライスを返す（消費側無改修のため）。
  const state: PaneScopedState = useMemo(
    () => ({
      tabs: pane.tabs,
      activeTabId: pane.activeTabId,
      closedTabs: ctx.state.closedTabs,
    }),
    [pane.tabs, pane.activeTabId, ctx.state.closedTabs],
  );

  const globalDispatch = ctx.dispatch;
  const dispatch = useMemo<Dispatch<ScopedTabAction>>(
    () => (action) => {
      // 既に paneId を持つアクション（ペイン管理系の明示指定）はそのまま流す。
      globalDispatch(action.paneId !== undefined ? action : { ...action, paneId });
    },
    [globalDispatch, paneId],
  );

  return {
    state,
    stateRef: ctx.stateRef,
    dispatch,
    activeTab,
    currentPage,
    paneId,
  };
}

export function useTabDispatch(): Dispatch<ScopedTabAction> {
  const globalDispatch = useContext(TabDispatchContext);
  if (!globalDispatch) {
    throw new Error("useTabDispatch must be used within TabProvider");
  }
  // state を購読せず paneId だけ取り出すことで、ディスパッチ専用の消費側の再レンダリングを避ける。
  const paneCtx = useContext(PaneContext);
  const paneId = paneCtx?.paneId;
  return useMemo<Dispatch<ScopedTabAction>>(
    () => (action) => {
      if (action.paneId !== undefined || paneId === undefined) {
        globalDispatch(action);
      } else {
        globalDispatch({ ...action, paneId });
      }
    },
    [globalDispatch, paneId],
  );
}

const EMPTY_TAB_VIEW_STATE: TabViewState = {};

export function useTabViewState(
  tabId: string,
  page: Page,
): {
  state: TabViewState;
  update: (patch: Partial<TabViewState>) => void;
} {
  const { state, dispatch } = useTabStore();
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  const pageKey = getPageViewStateKey(page);
  const persistedState = tab?.viewStates?.[pageKey] ?? EMPTY_TAB_VIEW_STATE;

  const update = useCallback(
    (patch: Partial<TabViewState>) => {
      dispatch({
        type: "UPDATE_TAB_VIEW_STATE",
        tabId,
        pageKey,
        patch,
      });
    },
    [dispatch, pageKey, tabId],
  );

  return {
    state: persistedState,
    update,
  };
}

// App レイアウト用: ペイン配列とアクティブペインを取得する。
export function useTabPanes(): { panes: Pane[]; activePaneId: string } {
  const ctx = useContext(TabContext);
  if (!ctx) {
    throw new Error("useTabPanes must be used within TabProvider");
  }
  return { panes: ctx.state.panes, activePaneId: ctx.state.activePaneId };
}

export function useActivePaneId(): string {
  const ctx = useContext(TabContext);
  if (!ctx) {
    throw new Error("useActivePaneId must be used within TabProvider");
  }
  return ctx.state.activePaneId;
}

// 現在のサブツリーが属するペインの id（無ければアクティブペイン）。
export function usePaneId(): string {
  const ctx = useContext(TabContext);
  if (!ctx) {
    throw new Error("usePaneId must be used within TabProvider");
  }
  return usePaneIdFromContext(ctx.state);
}
