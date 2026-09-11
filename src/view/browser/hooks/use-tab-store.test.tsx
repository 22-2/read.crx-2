import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getCurrentPage, getPageViewStateKey } from "src/view/browser/types";
import { getAutoRefreshPageKey } from "src/view/browser/utils/auto-refresh-pages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { historyAddMock, historyRemoveMock } = vi.hoisted(() => ({
  historyAddMock: vi.fn().mockResolvedValue(undefined),
  historyRemoveMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("src/app/platform", () => ({
  // use-tab-store はタイトル更新以外で platform を使わないため、
  // 拡張機能専用 polyfill を読み込まずに reducer の振る舞い検証へ集中する。
  platform: {
    window: {
      setTitle: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock("src/core/History", () => ({
  add: historyAddMock,
  remove: historyRemoveMock,
}));

// webextension-polyfill は拡張機能環境以外では import 時に例外を投げるため、
// reducer の振る舞い検証に不要な runtime API を最小モックで差し替える。
vi.mock("webextension-polyfill", () => ({
  default: {
    runtime: {
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  },
}));

function createMemoryStorage(): Storage {
  const items = new Map<string, string>();

  return {
    get length() {
      return items.size;
    },
    clear() {
      items.clear();
    },
    getItem(key: string) {
      return items.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(items.keys())[index] ?? null;
    },
    removeItem(key: string) {
      items.delete(key);
    },
    setItem(key: string, value: string) {
      items.set(key, value);
    },
  };
}

describe("TabProvider auto refresh state", () => {
  beforeEach(() => {
    const localStorageMock = createMemoryStorage();
    vi.stubGlobal("localStorage", localStorageMock);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: localStorageMock,
    });
    localStorage.removeItem("chlens_browser_session");
    historyAddMock.mockReset();
    historyRemoveMock.mockReset();
    historyAddMock.mockResolvedValue(undefined);
    historyRemoveMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("別ページへ移動した時点で自動更新状態を解除する", async () => {
    vi.resetModules();
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { activeTab, currentPage, dispatch } = useTabStore();
      const isCurrentThreadAutoRefreshEnabled =
        currentPage.type === "thread" &&
        activeTab.autoRefreshEnabled &&
        activeTab.autoRefreshPageKey === getAutoRefreshPageKey(currentPage);

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "thread",
                  title: "thread-1",
                  threadUrl: "https://example.com/test/read.cgi/foo/1/",
                },
              })
            }
          >
            thread-1 へ移動
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "SET_AUTO_REFRESH_ENABLED",
                enabled: true,
                pageKey: "thread:https://example.com/test/read.cgi/foo/1/",
              })
            }
          >
            thread-1 で自動更新ON
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "thread",
                  title: "thread-2",
                  threadUrl: "https://example.com/test/read.cgi/foo/2/",
                },
              })
            }
          >
            thread-2 へ移動
          </button>
          <output data-testid="stored-thread-url">{activeTab.autoRefreshPageKey ?? ""}</output>
          <output data-testid="current-thread-enabled">
            {isCurrentThreadAutoRefreshEnabled ? "enabled" : "disabled"}
          </output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("thread-1 へ移動"));
    fireEvent.click(screen.getByText("thread-1 で自動更新ON"));

    expect(screen.getByTestId("stored-thread-url")).toHaveTextContent(
      "thread:https://example.com/test/read.cgi/foo/1/",
    );
    expect(screen.getByTestId("current-thread-enabled")).toHaveTextContent("enabled");

    fireEvent.click(screen.getByText("thread-2 へ移動"));

    expect(screen.getByTestId("stored-thread-url")).toHaveTextContent("");
    expect(screen.getByTestId("current-thread-enabled")).toHaveTextContent("disabled");
  });

  it("戻るで移動してきたページでも自動更新状態は復元しない", async () => {
    vi.resetModules();
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { activeTab, currentPage, dispatch } = useTabStore();
      const isCurrentThreadAutoRefreshEnabled =
        currentPage.type === "thread" &&
        activeTab.autoRefreshEnabled &&
        activeTab.autoRefreshPageKey === getAutoRefreshPageKey(currentPage);

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "thread",
                  title: "thread-1",
                  threadUrl: "https://example.com/test/read.cgi/foo/1/",
                },
              })
            }
          >
            thread-1 へ移動
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "SET_AUTO_REFRESH_ENABLED",
                enabled: true,
                pageKey: "thread:https://example.com/test/read.cgi/foo/1/",
              })
            }
          >
            thread-1 で自動更新ON
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "thread",
                  title: "thread-2",
                  threadUrl: "https://example.com/test/read.cgi/foo/2/",
                },
              })
            }
          >
            thread-2 へ移動
          </button>
          <button onClick={() => dispatch({ type: "GO_BACK" })}>戻る</button>
          <output data-testid="stored-thread-url">{activeTab.autoRefreshPageKey ?? ""}</output>
          <output data-testid="current-thread-enabled">
            {isCurrentThreadAutoRefreshEnabled ? "enabled" : "disabled"}
          </output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("thread-1 へ移動"));
    fireEvent.click(screen.getByText("thread-1 で自動更新ON"));
    fireEvent.click(screen.getByText("thread-2 へ移動"));
    fireEvent.click(screen.getByText("戻る"));

    expect(screen.getByTestId("stored-thread-url")).toHaveTextContent("");
    expect(screen.getByTestId("current-thread-enabled")).toHaveTextContent("disabled");
  });

  it("セッション保存時に自動更新状態を永続化しない", async () => {
    vi.resetModules();
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { dispatch } = useTabStore();

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "thread",
                  title: "thread-1",
                  threadUrl: "https://example.com/test/read.cgi/foo/1/",
                },
              })
            }
          >
            thread-1 へ移動
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "SET_AUTO_REFRESH_ENABLED",
                enabled: true,
                pageKey: "thread:https://example.com/test/read.cgi/foo/1/",
              })
            }
          >
            thread-1 で自動更新ON
          </button>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("thread-1 へ移動"));
    fireEvent.click(screen.getByText("thread-1 で自動更新ON"));

    const raw = localStorage.getItem("chlens_browser_session");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? "{}") as {
      panes: Array<{
        tabs: Array<{
          autoRefreshEnabled: boolean;
          autoRefreshPageKey: string | null;
        }>;
      }>;
    };

    expect(parsed.panes[0].tabs[0].autoRefreshEnabled).toBe(false);
    expect(parsed.panes[0].tabs[0].autoRefreshPageKey).toBeNull();
  });

  it("セッション復元時に保存済み自動更新状態をリセットする", async () => {
    localStorage.setItem(
      "chlens_browser_session",
      JSON.stringify({
        tabs: [
          {
            id: "tab-1",
            history: [
              {
                type: "thread",
                title: "thread-1",
                threadUrl: "https://example.com/test/read.cgi/foo/1/",
              },
            ],
            currentIndex: 0,
            pinned: false,
            reloadKey: 0,
            autoRefreshEnabled: true,
            autoRefreshPageKey: "thread:https://example.com/test/read.cgi/foo/1/",
          },
        ],
        activeTabId: "tab-1",
        closedTabs: [],
      }),
    );

    vi.resetModules();
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { activeTab } = useTabStore();
      return (
        <>
          <output data-testid="saved-enabled">
            {activeTab.autoRefreshEnabled ? "enabled" : "disabled"}
          </output>
          <output data-testid="saved-url">{activeTab.autoRefreshPageKey ?? ""}</output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    expect(screen.getByTestId("saved-enabled")).toHaveTextContent("disabled");
    expect(screen.getByTestId("saved-url")).toHaveTextContent("");
  });

  it("FOLLOW_NEXT_THREAD は現在タブの履歴と自動更新束縛を次スレへ引き継ぐ", async () => {
    vi.resetModules();
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { activeTab, currentPage, dispatch } = useTabStore();
      const isCurrentThreadAutoRefreshEnabled =
        currentPage.type === "thread" &&
        activeTab.autoRefreshEnabled &&
        activeTab.autoRefreshPageKey === getAutoRefreshPageKey(currentPage);

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "thread",
                  title: "thread-1",
                  threadUrl: "https://example.com/test/read.cgi/foo/1/",
                },
              })
            }
          >
            thread-1 へ移動
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "SET_AUTO_REFRESH_ENABLED",
                enabled: true,
                pageKey: "thread:https://example.com/test/read.cgi/foo/1/",
              })
            }
          >
            thread-1 で自動更新ON
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "FOLLOW_NEXT_THREAD",
                page: {
                  type: "thread",
                  title: "thread-2",
                  threadUrl: "https://example.com/test/read.cgi/foo/2/",
                },
                keepAutoRefresh: true,
              })
            }
          >
            次スレへ追従
          </button>
          <output data-testid="stored-thread-url">{activeTab.autoRefreshPageKey ?? ""}</output>
          <output data-testid="history-length">{activeTab.history.length}</output>
          <output data-testid="current-thread-title">{currentPage.title}</output>
          <output data-testid="current-thread-enabled">
            {isCurrentThreadAutoRefreshEnabled ? "enabled" : "disabled"}
          </output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("thread-1 へ移動"));
    fireEvent.click(screen.getByText("thread-1 で自動更新ON"));
    fireEvent.click(screen.getByText("次スレへ追従"));

    expect(screen.getByTestId("stored-thread-url")).toHaveTextContent(
      "thread:https://example.com/test/read.cgi/foo/2/",
    );
    // 現仕様の NAVIGATE は祖先(home/板/スレ一覧)を自動補完しないため、
    // 初期[home] → thread-1 で1段 → thread-2 で1段の計3エントリになる。
    expect(screen.getByTestId("history-length")).toHaveTextContent("3");
    expect(screen.getByTestId("current-thread-title")).toHaveTextContent("thread-2");
    expect(screen.getByTestId("current-thread-enabled")).toHaveTextContent("enabled");
  });

  it("OPEN_IN_NEW_TAB では現在タブのページタイトルを変更しない", async () => {
    vi.resetModules();
    // 現仕様では新規タブを開くと既定でそちらへフォーカスが移る。
    // このテストの主眼は「元タブのページが汚染されないこと」なので、
    // 背景オープン設定にしてアクティブタブを元のままに固定して検証する。
    localStorage.setItem("config_focus_new_tab_on_open", "off");
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { state, activeTab, currentPage, dispatch } = useTabStore();

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "threadList",
                  title: "板A",
                  boardUrl: "https://example.com/board-a/",
                  boardTitle: "板A",
                },
              })
            }
          >
            板Aへ移動
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "OPEN_IN_NEW_TAB",
                page: {
                  type: "thread",
                  title: "新規スレ",
                  threadUrl: "https://example.com/test/read.cgi/board-a/1/",
                },
              })
            }
          >
            新規タブで開く
          </button>
          <output data-testid="active-tab-id">{activeTab.id}</output>
          <output data-testid="current-page-title">{currentPage.title}</output>
          <output data-testid="current-page-type">{currentPage.type}</output>
          <output data-testid="tabs-count">{state.tabs.length}</output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("板Aへ移動"));
    const activeTabIdBefore = screen.getByTestId("active-tab-id").textContent;

    expect(screen.getByTestId("current-page-title")).toHaveTextContent("板A");
    expect(screen.getByTestId("current-page-type")).toHaveTextContent("threadList");

    fireEvent.click(screen.getByText("新規タブで開く"));

    expect(screen.getByTestId("tabs-count")).toHaveTextContent("2");
    expect(screen.getByTestId("active-tab-id").textContent).toBe(activeTabIdBefore);
    expect(screen.getByTestId("current-page-title")).toHaveTextContent("板A");
    expect(screen.getByTestId("current-page-type")).toHaveTextContent("threadList");
  });

  it("OPEN_IN_NEW_TAB した背景スレは表示前でも閲覧履歴へ記録する", async () => {
    vi.resetModules();
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { dispatch } = useTabStore();

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "threadList",
                  title: "板A",
                  boardUrl: "https://example.com/board-a/",
                  boardTitle: "板A",
                },
              })
            }
          >
            板Aへ移動
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "OPEN_IN_NEW_TAB",
                page: {
                  type: "thread",
                  title: "背景スレ",
                  threadUrl: "https://example.com/test/read.cgi/board-a/1/",
                },
              })
            }
          >
            背景タブでスレを開く
          </button>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("板Aへ移動"));
    historyAddMock.mockClear();

    fireEvent.click(screen.getByText("背景タブでスレを開く"));

    expect(historyAddMock).toHaveBeenCalledTimes(1);
    expect(historyAddMock).toHaveBeenCalledWith(
      "https://example.com/test/read.cgi/board-a/1/",
      "背景スレ",
      expect.any(Number),
      "board-a",
    );
  });

  it("URL直開きのスレはタイトル解決後に同じ履歴レコードを補正する", async () => {
    vi.resetModules();
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { state, dispatch } = useTabStore();

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "thread",
                  title: "https://example.com/test/read.cgi/board-a/1/",
                  threadUrl: "https://example.com/test/read.cgi/board-a/1/",
                },
              })
            }
          >
            URL直開き
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "UPDATE_TITLE_FOR_TAB",
                tabId: state.activeTabId,
                title: "解決後タイトル",
              })
            }
          >
            タイトル解決
          </button>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("URL直開き"));

    expect(historyAddMock).toHaveBeenCalledWith(
      "https://example.com/test/read.cgi/board-a/1/",
      "https://example.com/test/read.cgi/board-a/1/",
      expect.any(Number),
      "board-a",
    );

    const recordedDate = historyAddMock.mock.calls[0][2] as number;
    historyAddMock.mockClear();

    fireEvent.click(screen.getByText("タイトル解決"));

    await waitFor(() => {
      expect(historyRemoveMock).toHaveBeenCalledWith(
        "https://example.com/test/read.cgi/board-a/1/",
        recordedDate,
      );
      expect(historyAddMock).toHaveBeenCalledWith(
        "https://example.com/test/read.cgi/board-a/1/",
        "解決後タイトル",
        recordedDate,
        "board-a",
      );
    });
  });

  it("OPEN_IN_NEW_TAB は設定オフ時にバックグラウンドで新規タブを作成する", async () => {
    vi.resetModules();
    localStorage.setItem("config_focus_new_tab_on_open", "off");
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { state, activeTab, currentPage, dispatch } = useTabStore();

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "threadList",
                  title: "板A",
                  boardUrl: "https://example.com/board-a/",
                  boardTitle: "板A",
                },
              })
            }
          >
            板Aへ移動
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "OPEN_IN_NEW_TAB",
                page: {
                  type: "thread",
                  title: "既存スレ",
                  threadUrl: "https://example.com/test/read.cgi/board-a/1/",
                },
              })
            }
          >
            既存スレを新しいタブで開く
          </button>
          <output data-testid="tabs-count">{state.tabs.length}</output>
          <output data-testid="active-tab-id">{activeTab.id}</output>
          <output data-testid="current-page-title">{currentPage.title}</output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("板Aへ移動"));
    const originalActiveTabId = screen.getByTestId("active-tab-id").textContent;

    fireEvent.click(screen.getByText("既存スレを新しいタブで開く"));
    expect(screen.getByTestId("tabs-count")).toHaveTextContent("2");
    expect(screen.getByTestId("active-tab-id").textContent).toBe(originalActiveTabId);

    // 現仕様では重複防止が働くため、同じURLを再度開いても新規タブは増えず、
    // 既存の該当タブへフォーカスが移る（背景設定でも重複時はそのタブを表示する）。
    fireEvent.click(screen.getByText("既存スレを新しいタブで開く"));

    expect(screen.getByTestId("tabs-count")).toHaveTextContent("2");
    expect(screen.getByTestId("active-tab-id").textContent).not.toBe(originalActiveTabId);
    expect(screen.getByTestId("current-page-title")).toHaveTextContent("既存スレ");
  });

  it("OPEN_IN_NEW_TAB は設定オン時に新しいタブをアクティブにする", async () => {
    vi.resetModules();
    localStorage.setItem("config_focus_new_tab_on_open", "on");
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { state, activeTab, currentPage, dispatch } = useTabStore();

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "threadList",
                  title: "板A",
                  boardUrl: "https://example.com/board-a/",
                  boardTitle: "板A",
                },
              })
            }
          >
            板Aへ移動
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "OPEN_IN_NEW_TAB",
                page: {
                  type: "thread",
                  title: "既存スレ",
                  threadUrl: "https://example.com/test/read.cgi/board-a/1/",
                },
              })
            }
          >
            既存スレを新しいタブで開く
          </button>
          <output data-testid="tabs-count">{state.tabs.length}</output>
          <output data-testid="active-tab-id">{activeTab.id}</output>
          <output data-testid="current-page-title">{currentPage.title}</output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("板Aへ移動"));
    const originalActiveTabId = screen.getByTestId("active-tab-id").textContent;

    fireEvent.click(screen.getByText("既存スレを新しいタブで開く"));
    expect(screen.getByTestId("tabs-count")).toHaveTextContent("2");
    expect(screen.getByTestId("active-tab-id").textContent).not.toBe(originalActiveTabId);
    expect(screen.getByTestId("current-page-title")).toHaveTextContent("既存スレ");
  });

  it("NAVIGATE は別タブに同じページがあっても現在タブの履歴に積む", async () => {
    vi.resetModules();
    // 既存スレを別タブで開く操作は背景前提なので、
    // フォーカス移動でアクティブタブが入れ替わらないよう背景オープン設定にする。
    localStorage.setItem("config_focus_new_tab_on_open", "off");
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { state, currentPage, dispatch } = useTabStore();

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "threadList",
                  title: "板A",
                  boardUrl: "https://example.com/board-a/",
                  boardTitle: "板A",
                },
              })
            }
          >
            板Aへ移動
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "OPEN_IN_NEW_TAB",
                page: {
                  type: "thread",
                  title: "既存スレ",
                  threadUrl: "https://example.com/test/read.cgi/board-a/1/",
                },
              })
            }
          >
            既存スレを背景で開く
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "threadList",
                  title: "板B",
                  boardUrl: "https://example.com/board-b/",
                  boardTitle: "板B",
                },
              })
            }
          >
            板Bへ移動
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "thread",
                  title: "既存スレ",
                  threadUrl: "https://example.com/test/read.cgi/board-a/1/",
                },
              })
            }
          >
            既存スレをクリック
          </button>
          <output data-testid="tabs-count">{state.tabs.length}</output>
          <output data-testid="current-page-title">{currentPage.title}</output>
          <output data-testid="tab-titles">
            {state.tabs.map((tab) => tab.history[tab.currentIndex]?.title ?? "").join("|")}
          </output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("板Aへ移動"));
    fireEvent.click(screen.getByText("既存スレを背景で開く"));
    fireEvent.click(screen.getByText("板Bへ移動"));

    expect(screen.getByTestId("current-page-title")).toHaveTextContent("板B");

    fireEvent.click(screen.getByText("既存スレをクリック"));

    // タブ数は変わらず、現在タブの履歴に積まれる（別タブへ飛ばない）
    expect(screen.getByTestId("tabs-count")).toHaveTextContent("2");
    expect(screen.getByTestId("current-page-title")).toHaveTextContent("既存スレ");
    expect(screen.getByTestId("tab-titles")).toHaveTextContent("既存スレ|既存スレ");
  });

  it("クイックアクセス間の遷移で既存ページ判定が誤爆せず切り替わる", async () => {
    vi.resetModules();
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { currentPage, dispatch } = useTabStore();

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: { type: "bookmarkList", title: "ブックマークリスト" },
              })
            }
          >
            ブックマークを開く
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: { type: "historyList", title: "閲覧履歴" },
              })
            }
          >
            履歴を開く
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: { type: "writeHistoryList", title: "書き込み履歴" },
              })
            }
          >
            書き込み履歴を開く
          </button>
          <output data-testid="current-page-type">{currentPage.type}</output>
          <output data-testid="current-page-title">{currentPage.title}</output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("ブックマークを開く"));
    expect(screen.getByTestId("current-page-type")).toHaveTextContent("bookmarkList");

    fireEvent.click(screen.getByText("履歴を開く"));
    expect(screen.getByTestId("current-page-type")).toHaveTextContent("historyList");
    expect(screen.getByTestId("current-page-title")).toHaveTextContent("閲覧履歴");

    fireEvent.click(screen.getByText("書き込み履歴を開く"));
    expect(screen.getByTestId("current-page-type")).toHaveTextContent("writeHistoryList");
    expect(screen.getByTestId("current-page-title")).toHaveTextContent("書き込み履歴");
  });

  it("同一タブでスレURLへ遷移した時は戻るで前のスレへ戻る", async () => {
    vi.resetModules();
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { currentPage, activeTab, dispatch } = useTabStore();

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "threadList",
                  title: "板A",
                  boardUrl: "https://example.com/board-a/",
                  boardTitle: "板A",
                },
              })
            }
          >
            板Aへ移動
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "thread",
                  title: "thread-1",
                  threadUrl: "https://example.com/test/read.cgi/board-a/1/",
                },
              })
            }
          >
            thread-1 へ移動
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "thread",
                  title: "thread-2",
                  threadUrl: "https://example.com/test/read.cgi/board-a/2/",
                },
              })
            }
          >
            thread-2 へ移動
          </button>
          <button onClick={() => dispatch({ type: "GO_BACK" })}>戻る</button>
          <output data-testid="current-page-title">{currentPage.title}</output>
          <output data-testid="current-page-type">{currentPage.type}</output>
          <output data-testid="history-titles">
            {activeTab.history.map((page) => page.title).join("|")}
          </output>
          <output data-testid="history-index">{String(activeTab.currentIndex)}</output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("板Aへ移動"));
    fireEvent.click(screen.getByText("thread-1 へ移動"));
    fireEvent.click(screen.getByText("thread-2 へ移動"));

    expect(screen.getByTestId("current-page-title")).toHaveTextContent("thread-2");
    // 祖先の自動補完なし: ユーザーが実際に訪れたページのみ積まれる
    expect(screen.getByTestId("history-titles")).toHaveTextContent("ホーム|板A|thread-1|thread-2");
    expect(screen.getByTestId("history-index")).toHaveTextContent("3");

    fireEvent.click(screen.getByText("戻る"));

    expect(screen.getByTestId("current-page-title")).toHaveTextContent("thread-1");
    expect(screen.getByTestId("current-page-type")).toHaveTextContent("thread");
    expect(screen.getByTestId("history-index")).toHaveTextContent("2");
  });

  it("ホームからURL直開きしたスレで戻るとホームへ戻る", async () => {
    vi.resetModules();
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { currentPage, activeTab, dispatch } = useTabStore();

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "thread",
                  title: "direct-thread",
                  threadUrl: "https://example.com/test/read.cgi/board-a/1/",
                },
              })
            }
          >
            スレをURL直開き
          </button>
          <button onClick={() => dispatch({ type: "GO_BACK" })}>戻る</button>
          <output data-testid="current-page-type">{currentPage.type}</output>
          <output data-testid="current-page-title">{currentPage.title}</output>
          <output data-testid="history-titles">
            {activeTab.history.map((page) => page.title).join("|")}
          </output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("スレをURL直開き"));

    // 祖先の自動補完なし: ホームと直開きスレだけが積まれる
    expect(screen.getByTestId("history-titles")).toHaveTextContent("ホーム|direct-thread");

    fireEvent.click(screen.getByText("戻る"));

    expect(screen.getByTestId("current-page-type")).toHaveTextContent("home");
    expect(screen.getByTestId("current-page-title")).toHaveTextContent("ホーム");
  });

  it("UPDATE_TITLE_FOR_TAB は対象タブだけを更新し、アクティブタブを汚染しない", async () => {
    vi.resetModules();
    // 背景タブを開いた状態を作るため、新規タブのフォーカス移動を無効化する。
    localStorage.setItem("config_focus_new_tab_on_open", "off");
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { state, activeTab, currentPage, dispatch } = useTabStore();

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "threadList",
                  title: "アクティブ板",
                  boardUrl: "https://example.com/board-a/",
                  boardTitle: "アクティブ板",
                },
              })
            }
          >
            activeを板Aへ
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "OPEN_IN_NEW_TAB",
                page: {
                  type: "thread",
                  title: "背景タブ初期",
                  threadUrl: "https://example.com/test/read.cgi/board-a/1/",
                },
              })
            }
          >
            背景タブを開く
          </button>
          <button
            onClick={() => {
              const target = state.tabs.find((tab) => tab.id !== state.activeTabId);
              if (!target) return;
              dispatch({
                type: "UPDATE_TITLE_FOR_TAB",
                tabId: target.id,
                title: "背景タブ更新後",
              });
            }}
          >
            背景タブのタイトル更新
          </button>
          <output data-testid="tabs-count">{state.tabs.length}</output>
          <output data-testid="active-tab-id">{activeTab.id}</output>
          <output data-testid="active-page-title">{currentPage.title}</output>
          <output data-testid="background-page-title">
            {state.tabs.find((tab) => tab.id !== state.activeTabId)?.history.at(-1)?.title ?? ""}
          </output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("activeを板Aへ"));
    const activeTabIdBefore = screen.getByTestId("active-tab-id").textContent;

    fireEvent.click(screen.getByText("背景タブを開く"));
    expect(screen.getByTestId("tabs-count")).toHaveTextContent("2");

    fireEvent.click(screen.getByText("背景タブのタイトル更新"));

    expect(screen.getByTestId("active-tab-id").textContent).toBe(activeTabIdBefore);
    expect(screen.getByTestId("active-page-title")).toHaveTextContent("アクティブ板");
    expect(screen.getByTestId("background-page-title")).toHaveTextContent("背景タブ更新後");
  });

  it("ホームから板URLを直接開くと履歴に積まれ、進むは効かない", async () => {
    vi.resetModules();
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { currentPage, activeTab, dispatch } = useTabStore();

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "threadList",
                  title: "板A",
                  boardUrl: "https://example.com/board-a/",
                  boardTitle: "板A",
                },
              })
            }
          >
            板URL直開き
          </button>
          <button onClick={() => dispatch({ type: "GO_FORWARD" })}>進む</button>
          <output data-testid="current-page-type">{currentPage.type}</output>
          <output data-testid="history-titles">
            {activeTab.history.map((page) => page.title).join("|")}
          </output>
          <output data-testid="history-index">{String(activeTab.currentIndex)}</output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("板URL直開き"));
    expect(screen.getByTestId("current-page-type")).toHaveTextContent("threadList");
    // 祖先の自動補完なし: ホームと板だけが積まれる
    expect(screen.getByTestId("history-titles")).toHaveTextContent("ホーム|板A");
    expect(screen.getByTestId("history-index")).toHaveTextContent("1");

    fireEvent.click(screen.getByText("進む"));
    expect(screen.getByTestId("current-page-type")).toHaveTextContent("threadList");
    expect(screen.getByTestId("history-index")).toHaveTextContent("1");
  });

  it("新規タブ直後は進むが効かない", async () => {
    vi.resetModules();
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { state, currentPage, dispatch } = useTabStore();

      return (
        <>
          <button onClick={() => dispatch({ type: "ADD_TAB" })}>新規タブ</button>
          <button onClick={() => dispatch({ type: "GO_FORWARD" })}>進む</button>
          <output data-testid="tabs-count">{state.tabs.length}</output>
          <output data-testid="current-page-type">{currentPage.type}</output>
          <output data-testid="history-length">
            {String(state.tabs.find((tab) => tab.id === state.activeTabId)?.history.length ?? 0)}
          </output>
          <output data-testid="history-index">
            {String(state.tabs.find((tab) => tab.id === state.activeTabId)?.currentIndex ?? -1)}
          </output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("新規タブ"));
    expect(screen.getByTestId("tabs-count")).toHaveTextContent("2");
    expect(screen.getByTestId("current-page-type")).toHaveTextContent("home");
    expect(screen.getByTestId("history-length")).toHaveTextContent("1");
    expect(screen.getByTestId("history-index")).toHaveTextContent("0");

    fireEvent.click(screen.getByText("進む"));
    expect(screen.getByTestId("current-page-type")).toHaveTextContent("home");
    expect(screen.getByTestId("history-index")).toHaveTextContent("0");
  });

  it("関連する板モードの新規タブはスレ履歴内の確定板名を再利用する", async () => {
    localStorage.setItem("config_new_tab_page_mode", "related_board");

    vi.resetModules();
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { currentPage, dispatch } = useTabStore();

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "threadList",
                  title: "Software",
                  boardUrl: "https://egg.5ch.net/software/",
                  boardTitle: "Software",
                },
              })
            }
          >
            板へ移動
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "thread",
                  title: "スレA",
                  threadUrl: "https://egg.5ch.net/test/read.cgi/software/1000000004/",
                },
              })
            }
          >
            スレへ移動
          </button>
          <button onClick={() => dispatch({ type: "ADD_TAB" })}>新規タブ</button>
          <output data-testid="current-page-type">{currentPage.type}</output>
          <output data-testid="current-page-title">{currentPage.title}</output>
          <output data-testid="current-page-board-title">
            {currentPage.type === "threadList" ? currentPage.boardTitle : ""}
          </output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("板へ移動"));
    fireEvent.click(screen.getByText("スレへ移動"));
    fireEvent.click(screen.getByText("新規タブ"));

    expect(screen.getByTestId("current-page-type")).toHaveTextContent("threadList");
    expect(screen.getByTestId("current-page-title")).toHaveTextContent("Software");
    expect(screen.getByTestId("current-page-board-title")).toHaveTextContent("Software");
  });

  it("関連板から別板のスレをURL直開きした戻るで対象板へ戻る", async () => {
    localStorage.setItem("config_new_tab_page_mode", "related_board");

    vi.resetModules();
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { currentPage, activeTab, dispatch } = useTabStore();

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "threadList",
                  title: "エッヂ",
                  boardUrl: "http://bbs.eddibb.cc/liveedge/",
                  boardTitle: "エッヂ",
                },
              })
            }
          >
            板Aへ移動
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "thread",
                  title: "スレA",
                  threadUrl: "http://bbs.eddibb.cc/test/read.cgi/liveedge/1000000006/",
                },
              })
            }
          >
            板Aのスレへ移動
          </button>
          <button onClick={() => dispatch({ type: "ADD_TAB" })}>関連板の新規タブ</button>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "thread",
                  title: "スレB",
                  threadUrl: "https://egg.5ch.io/test/read.cgi/software/123/",
                },
              })
            }
          >
            板BのスレをURL直開き
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "UPDATE_TITLE_FOR_TAB",
                tabId: activeTab.id,
                title: "Software",
                boardUrl: "https://egg.5ch.io/software/",
              })
            }
          >
            板B名を解決
          </button>
          <button onClick={() => dispatch({ type: "GO_BACK" })}>戻る</button>
          <output data-testid="current-page-type">{currentPage.type}</output>
          <output data-testid="current-page-title">{currentPage.title}</output>
          <output data-testid="current-page-board-url">
            {currentPage.type === "threadList" ? currentPage.boardUrl : ""}
          </output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("板Aへ移動"));
    fireEvent.click(screen.getByText("板Aのスレへ移動"));
    fireEvent.click(screen.getByText("関連板の新規タブ"));
    fireEvent.click(screen.getByText("板BのスレをURL直開き"));
    fireEvent.click(screen.getByText("板B名を解決"));
    fireEvent.click(screen.getByText("戻る"));

    expect(screen.getByTestId("current-page-type")).toHaveTextContent("threadList");
    expect(screen.getByTestId("current-page-title")).toHaveTextContent("Software");
    expect(screen.getByTestId("current-page-board-url")).toHaveTextContent(
      "https://egg.5ch.io/software/",
    );
  });

  it("板ページから新規タブで開いたスレは戻る時に板URLではなく板タイトルを維持する", async () => {
    vi.resetModules();
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");

    function Harness() {
      const { state, currentPage, dispatch } = useTabStore();

      return (
        <>
          <button
            onClick={() =>
              dispatch({
                type: "NAVIGATE",
                page: {
                  type: "threadList",
                  title: "エッヂ",
                  boardUrl: "http://bbs.eddibb.cc/liveedge/",
                  boardTitle: "エッヂ",
                },
              })
            }
          >
            板へ移動
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "OPEN_IN_NEW_TAB_FORCE",
                page: {
                  type: "thread",
                  title: "スレ1",
                  threadUrl: "http://bbs.eddibb.cc/test/read.cgi/liveedge/1000000006/",
                },
              })
            }
          >
            新規タブでスレ
          </button>
          <button
            onClick={() => {
              const background = state.tabs.find((tab) => tab.id !== state.activeTabId);
              if (!background) return;
              dispatch({ type: "SELECT_TAB", tabId: background.id });
            }}
          >
            背景タブへ切替
          </button>
          <button onClick={() => dispatch({ type: "GO_BACK" })}>戻る</button>
          <output data-testid="current-page-type">{currentPage.type}</output>
          <output data-testid="current-page-title">{currentPage.title}</output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("板へ移動"));
    fireEvent.click(screen.getByText("新規タブでスレ"));
    fireEvent.click(screen.getByText("背景タブへ切替"));

    expect(screen.getByTestId("current-page-type")).toHaveTextContent("thread");
    expect(screen.getByTestId("current-page-title")).toHaveTextContent("スレ1");

    fireEvent.click(screen.getByText("戻る"));

    expect(screen.getByTestId("current-page-type")).toHaveTextContent("threadList");
    expect(screen.getByTestId("current-page-title")).toHaveTextContent("エッヂ");
  });

  it("タブごとの検索状態をスレ遷移とセッション保存で維持する", async () => {
    vi.resetModules();
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");
    const thread1 = {
      type: "thread" as const,
      title: "スレ1",
      threadUrl: "https://example.com/test/read.cgi/foo/1/",
    };
    const thread2 = {
      type: "thread" as const,
      title: "スレ2",
      threadUrl: "https://example.com/test/read.cgi/foo/2/",
    };

    function Harness() {
      const { activeTab, currentPage, dispatch } = useTabStore();
      const currentViewState = activeTab.viewStates?.[getPageViewStateKey(currentPage)];

      return (
        <>
          <button onClick={() => dispatch({ type: "NAVIGATE", page: thread1 })}>スレ1へ移動</button>
          <button
            onClick={() =>
              dispatch({
                type: "UPDATE_TAB_VIEW_STATE",
                tabId: activeTab.id,
                pageKey: getPageViewStateKey(thread1),
                patch: { searchQuery: "保存する検索語", filter: "image", searchTarget: "name" },
              })
            }
          >
            スレ1の検索状態を保存
          </button>
          <button onClick={() => dispatch({ type: "NAVIGATE", page: thread2 })}>スレ2へ移動</button>
          <button onClick={() => dispatch({ type: "GO_BACK" })}>スレ1へ戻る</button>
          <output data-testid="current-thread-url">
            {currentPage.type === "thread" ? currentPage.threadUrl : ""}
          </output>
          <output data-testid="current-search-query">{currentViewState?.searchQuery ?? ""}</output>
          <output data-testid="current-filter">{currentViewState?.filter ?? ""}</output>
          <output data-testid="current-search-target">
            {currentViewState?.searchTarget ?? ""}
          </output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    fireEvent.click(screen.getByText("スレ1へ移動"));
    fireEvent.click(screen.getByText("スレ1の検索状態を保存"));
    fireEvent.click(screen.getByText("スレ2へ移動"));

    expect(screen.getByTestId("current-thread-url")).toHaveTextContent(thread2.threadUrl);
    expect(screen.getByTestId("current-search-query")).toHaveTextContent("保存する検索語");
    expect(screen.getByTestId("current-filter")).toHaveTextContent("image");
    expect(screen.getByTestId("current-search-target")).toHaveTextContent("name");

    fireEvent.click(screen.getByText("スレ1へ戻る"));

    expect(screen.getByTestId("current-thread-url")).toHaveTextContent(thread1.threadUrl);
    expect(screen.getByTestId("current-search-query")).toHaveTextContent("保存する検索語");
    expect(screen.getByTestId("current-filter")).toHaveTextContent("image");
    expect(screen.getByTestId("current-search-target")).toHaveTextContent("name");

    await waitFor(() => {
      const raw = localStorage.getItem("chlens_browser_session");
      const parsed = JSON.parse(raw ?? "{}") as {
        panes?: Array<{
          tabs?: Array<{
            viewStates?: Record<string, { searchQuery?: string; searchTarget?: string }>;
          }>;
        }>;
      };
      expect(
        parsed.panes?.[0]?.tabs?.[0]?.viewStates?.[getPageViewStateKey(thread1)]?.searchQuery,
      ).toBe("保存する検索語");
      expect(
        parsed.panes?.[0]?.tabs?.[0]?.viewStates?.[getPageViewStateKey(thread1)]?.searchTarget,
      ).toBe("name");
    });
  });

  it("最後のタブを閉じるとホームタブへ置き換え、元タブを閉じたタブ履歴へ残す", async () => {
    vi.resetModules();
    const { TabProvider, useTabStore } = await import("src/view/browser/hooks/use-tab-store");
    const threadPage = {
      type: "thread" as const,
      title: "閉じるスレッド",
      threadUrl: "https://example.com/test/read.cgi/foo/1/",
    };

    function Harness() {
      const { state, activeTab, currentPage, dispatch } = useTabStore();

      return (
        <>
          <button onClick={() => dispatch({ type: "NAVIGATE", page: threadPage })}>
            スレッドへ移動
          </button>
          <button onClick={() => dispatch({ type: "CLOSE_TAB", tabId: activeTab.id })}>
            最後のタブを閉じる
          </button>
          <button onClick={() => dispatch({ type: "REOPEN_CLOSED_TAB" })}>閉じたタブを開く</button>
          <output data-testid="tabs-count">{state.tabs.length}</output>
          <output data-testid="active-tab-id">{activeTab.id}</output>
          <output data-testid="current-page-type">{currentPage.type}</output>
          <output data-testid="current-page-title">{currentPage.title}</output>
          <output data-testid="closed-tabs-count">{state.closedTabs.length}</output>
          <output data-testid="closed-page-type">
            {state.closedTabs[0] ? getCurrentPage(state.closedTabs[0]).type : ""}
          </output>
          <output data-testid="closed-page-title">
            {state.closedTabs[0] ? getCurrentPage(state.closedTabs[0]).title : ""}
          </output>
        </>
      );
    }

    render(
      <TabProvider>
        <Harness />
      </TabProvider>,
    );

    const originalTabId = screen.getByTestId("active-tab-id").textContent;
    fireEvent.click(screen.getByText("スレッドへ移動"));
    fireEvent.click(screen.getByText("最後のタブを閉じる"));

    expect(screen.getByTestId("tabs-count")).toHaveTextContent("1");
    expect(screen.getByTestId("active-tab-id").textContent).not.toBe(originalTabId);
    expect(screen.getByTestId("current-page-type")).toHaveTextContent("home");
    expect(screen.getByTestId("current-page-title")).toHaveTextContent("ホーム");
    expect(screen.getByTestId("closed-tabs-count")).toHaveTextContent("1");
    expect(screen.getByTestId("closed-page-type")).toHaveTextContent("thread");
    expect(screen.getByTestId("closed-page-title")).toHaveTextContent("閉じるスレッド");

    fireEvent.click(screen.getByText("閉じたタブを開く"));

    expect(screen.getByTestId("tabs-count")).toHaveTextContent("2");
    expect(screen.getByTestId("current-page-type")).toHaveTextContent("thread");
    expect(screen.getByTestId("current-page-title")).toHaveTextContent("閉じるスレッド");
    expect(screen.getByTestId("closed-tabs-count")).toHaveTextContent("0");
  });
});
