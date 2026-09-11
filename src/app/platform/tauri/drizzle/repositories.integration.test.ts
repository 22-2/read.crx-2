import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  tauriBBSMenuCacheRepository,
  tauriCacheRepository,
  tauriHistoryRepository,
  tauriReadStateRepository,
  tauriWriteHistoryRepository,
} from "src/app/platform/tauri/drizzle/repositories";
import type { IReadState } from "src/service-container/interfaces";

const { loadMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: loadMock,
  },
}));

vi.mock("src/core/URL", () => {
  class TestURL extends globalThis.URL {
    toBoard(): TestURL {
      const match = /^\/test\/read\.cgi\/([^/]+)\//.exec(this.pathname);
      if (match == null) {
        throw new Error("スレッドURLではありません");
      }
      return new TestURL(`${this.origin}/${match[1]}/`);
    }
  }

  // 変更理由: このテストの対象はURL解析ではなく、実SQLiteとDrizzleの接続である。
  // URL本体を読み込むと拡張機能専用polyfillまで初期化されるため、境界だけを置き換える。
  return { URL: TestURL };
});

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

const sqlite = new DatabaseSync(":memory:");

function toSqlInputValues(values: readonly unknown[]): SqlInputValue[] {
  return values.map((value) => {
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      typeof value === "string" ||
      ArrayBuffer.isView(value)
    ) {
      return value as SqlInputValue;
    }

    throw new TypeError(`SQLiteに渡せないバインド値です: ${Object.prototype.toString.call(value)}`);
  });
}

const rawDatabase = {
  async execute(query: string, bindValues: unknown[] = []): Promise<void> {
    sqlite.prepare(query).run(...toSqlInputValues(bindValues));
  },

  async select<T>(query: string, bindValues: unknown[] = []): Promise<T[]> {
    // 変更理由: Tauri SQLの返却形式と同じ列名付きオブジェクトを返し、
    // Drizzleのsqlite-proxy変換を実SQLiteの結果で検証する。
    return sqlite.prepare(query).all(...toSqlInputValues(bindValues)) as unknown as T[];
  },
};

describe("Tauri DrizzleリポジトリのSQLite統合", () => {
  beforeAll(async () => {
    // 変更理由: node:sqliteはNode 25以降に組み込まれているため、
    // ネイティブ依存を追加せずCIでも同じSQLite実装を実行できる。
    loadMock.mockResolvedValue(rawDatabase);
    await tauriCacheRepository.count();
  });

  beforeEach(() => {
    // 変更理由: DBコンテキストはモジュール内で共有されるため、各テストで
    // 一時DBの全テーブルを消去し、テスト間の状態混入を防ぐ。
    sqlite.exec(`
      DELETE FROM cache;
      DELETE FROM history;
      DELETE FROM read_state;
      DELETE FROM bbsmenu_cache;
      DELETE FROM write_history;
      DELETE FROM sqlite_sequence;
    `);
  });

  afterAll(() => {
    sqlite.close();
  });

  it("実SQLiteへ全テーブルのスキーマを適用できる", async () => {
    const tables = await rawDatabase.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );

    expect(tables.map((table) => table.name)).toEqual([
      "bbsmenu_cache",
      "cache",
      "history",
      "read_state",
      "sqlite_sequence",
      "write_history",
    ]);
  });

  it("bbsmenuキャッシュを保存して上書き取得できる", async () => {
    await tauriBBSMenuCacheRepository.put({
      key: "bbsmenu",
      data: "板一覧の初期値",
      lastUpdated: 100,
    });
    await tauriBBSMenuCacheRepository.put({
      key: "bbsmenu",
      data: "板一覧の更新値",
      lastUpdated: 200,
    });

    await expect(tauriBBSMenuCacheRepository.get("bbsmenu")).resolves.toEqual({
      key: "bbsmenu",
      data: "板一覧の更新値",
      lastUpdated: 200,
    });
  });

  it("キャッシュのJSONとnullable列を実SQLiteで往復できる", async () => {
    const threadUrl = "https://egg.5ch.io/test/read.cgi/software/1000000001/";
    const cacheUrl = "https://egg.5ch.io/software/dat/1000000001.dat";

    await tauriCacheRepository.put({
      url: cacheUrl,
      data: "1<>名前<>本文<>日付",
      parsed: { resCount: 1, tags: ["本文"] },
      lastUpdated: 100,
      lastModified: null,
      etag: "etag-1",
      resLength: 1,
      datSize: null,
      readcgiVer: 2,
      title: "SQLite統合テスト",
      threadUrl,
      boardUrl: "https://egg.5ch.io/software/",
      boardTitle: null,
      kind: "thread",
    });

    await tauriCacheRepository.put({
      url: cacheUrl,
      data: null,
      parsed: null,
      lastUpdated: 200,
      lastModified: 300,
      etag: null,
      resLength: null,
      datSize: 400,
      readcgiVer: null,
      title: null,
      threadUrl: null,
      boardUrl: null,
      boardTitle: null,
      kind: null,
    });

    await expect(tauriCacheRepository.get(cacheUrl)).resolves.toEqual({
      url: cacheUrl,
      data: null,
      parsed: null,
      lastUpdated: 200,
      lastModified: 300,
      etag: null,
      resLength: null,
      datSize: 400,
      readcgiVer: null,
      title: null,
      threadUrl: null,
      boardUrl: null,
      boardTitle: null,
      kind: null,
    });
    await expect(tauriCacheRepository.count()).resolves.toBe(1);
  });

  it("キャッシュログをkindで絞り、古い非ログキャッシュだけ削除できる", async () => {
    await tauriCacheRepository.put({
      url: "https://egg.5ch.io/software/dat/thread.dat",
      data: "スレキャッシュ",
      parsed: null,
      lastUpdated: 100,
      lastModified: null,
      etag: null,
      resLength: 10,
      datSize: 20,
      readcgiVer: null,
      title: "スレログ",
      threadUrl: "https://egg.5ch.io/test/read.cgi/software/1000000001/",
      boardUrl: "https://egg.5ch.io/software/",
      boardTitle: "ソフトウェア",
      kind: "thread",
    });
    await tauriCacheRepository.put({
      url: "https://egg.5ch.io/software/subject.txt",
      data: "板キャッシュ",
      parsed: null,
      lastUpdated: 50,
      lastModified: null,
      etag: null,
      resLength: null,
      datSize: null,
      readcgiVer: null,
      kind: null,
    });

    await expect(tauriCacheRepository.listLogs(0, -1)).resolves.toEqual([
      {
        url: "https://egg.5ch.io/software/dat/thread.dat",
        title: "スレログ",
        threadUrl: "https://egg.5ch.io/test/read.cgi/software/1000000001/",
        boardUrl: "https://egg.5ch.io/software/",
        boardTitle: "ソフトウェア",
        resLength: 10,
        datSize: 20,
        lastUpdated: 100,
      },
    ]);

    await tauriCacheRepository.clearOlderThan(75);

    await expect(tauriCacheRepository.get("https://egg.5ch.io/software/subject.txt")).resolves.toBe(
      null,
    );
    await expect(
      tauriCacheRepository.get("https://egg.5ch.io/software/dat/thread.dat"),
    ).resolves.not.toBeNull();
  });

  it("履歴を日付順で取得し、同一URLの重複をまとめられる", async () => {
    await tauriHistoryRepository.add("https://egg.5ch.io/thread/old", "古い履歴", 100, "板");
    await tauriHistoryRepository.add("https://egg.5ch.io/thread/same", "古い同一URL", 150, "板");
    await tauriHistoryRepository.add("https://egg.5ch.io/thread/same", "新しい同一URL", 200, "板");

    await expect(tauriHistoryRepository.get(0, -1)).resolves.toMatchObject([
      { title: "新しい同一URL", date: 200 },
      { title: "古い同一URL", date: 150 },
      { title: "古い履歴", date: 100 },
    ]);
    await expect(tauriHistoryRepository.getUnique(0, -1)).resolves.toMatchObject([
      { title: "新しい同一URL", date: 200 },
      { title: "古い履歴", date: 100 },
    ]);
    await expect(tauriHistoryRepository.count()).resolves.toBe(3);
  });

  it("既読状態を正規化して保存し、同じ値を取得できる", async () => {
    const url = "https://egg.5ch.io/test/read.cgi/software/1000000001/";
    const readState: IReadState = {
      url,
      last: 42,
      read: 40,
      received: 100,
      offset: 3,
      date: 1_700_000_000,
    };

    await expect(tauriReadStateRepository.set(readState)).resolves.toEqual({
      boardUrl: "https://egg.5ch.io/software/",
      normalizedUrl: url,
    });
    await expect(tauriReadStateRepository.get(url)).resolves.toEqual(readState);

    await tauriReadStateRepository.set({
      ...readState,
      last: 43,
      offset: undefined,
      date: undefined,
    });

    await expect(tauriReadStateRepository.get(url)).resolves.toEqual({
      url,
      last: 43,
      read: 40,
      received: 100,
      offset: undefined,
      date: undefined,
    });
  });

  it("書き込み履歴を追加・更新・取得・削除できる", async () => {
    const record = {
      url: "https://egg.5ch.io/test/read.cgi/software/1000000001/",
      res: 42,
      title: "書き込み履歴",
      name: "名前",
      mail: "sage",
      inputName: "入力名",
      inputMail: "入力メール",
      message: "本文",
      date: 1_700_000_000,
    };

    await tauriWriteHistoryRepository.add(record);
    const added = await tauriWriteHistoryRepository.getByUrl(record.url);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      url: record.url,
      res: record.res,
      title: record.title,
      name: record.name,
      mail: record.mail,
      input_name: record.inputName,
      input_mail: record.inputMail,
      message: record.message,
      date: record.date,
    });

    const id = added[0]!.id;
    await tauriWriteHistoryRepository.update({
      ...record,
      id,
      message: "更新後の本文",
      date: 1_700_000_100,
    });

    await expect(tauriWriteHistoryRepository.getAll()).resolves.toMatchObject([
      {
        id,
        url: record.url,
        res: record.res,
        title: record.title,
        name: record.name,
        mail: record.mail,
        input_name: record.inputName,
        input_mail: record.inputMail,
        message: "更新後の本文",
        date: 1_700_000_100,
      },
    ]);

    await tauriWriteHistoryRepository.remove(record.url, record.res);
    await expect(tauriWriteHistoryRepository.count()).resolves.toBe(0);
  });
});
