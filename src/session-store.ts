import { Store, type SessionData } from 'express-session';
import Database from 'better-sqlite3';

type DatabaseType = ReturnType<typeof Database>;
type GetStmt = Database.Statement<[string]>;
type SetStmt = Database.Statement<[string, string, number]>;
type DestroyStmt = Database.Statement<[string]>;
type TouchStmt = Database.Statement<[number, string]>;
type CleanupStmt = Database.Statement<[number]>;

// 基于 better-sqlite3 的持久化 session store
// 服务重启不丢失登录状态，与主 DB 共享连接
export class SqliteSessionStore extends Store {
  private db: DatabaseType;
  private getStmt: GetStmt;
  private setStmt: SetStmt;
  private destroyStmt: DestroyStmt;
  private touchStmt: TouchStmt;
  private cleanupStmt: CleanupStmt;

  constructor(db: DatabaseType, cleanupIntervalMs: number = 60 * 60 * 1000) {
    super();
    this.db = db;
    this.getStmt = db.prepare<[string]>('SELECT data, expires_at FROM sessions WHERE sid = ?');
    this.setStmt = db.prepare<[string, string, number]>(
      'INSERT OR REPLACE INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)'
    );
    this.destroyStmt = db.prepare<[string]>('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = db.prepare<[number, string]>('UPDATE sessions SET expires_at = ? WHERE sid = ?');
    this.cleanupStmt = db.prepare<[number]>('DELETE FROM sessions WHERE expires_at < ?');

    // 启动时立即清一次过期，并定时清理
    this.cleanup();
    setInterval(() => this.cleanup(), cleanupIntervalMs).unref();
  }

  private cleanup(): void {
    try {
      this.cleanupStmt.run(Date.now());
    } catch (e) {
      console.error('Session cleanup failed:', (e as Error).message);
    }
  }

  private computeExpiresAt(session: SessionData): number {
    const cookie = session.cookie;
    if (cookie && cookie.expires) {
      const t = new Date(cookie.expires).getTime();
      if (!Number.isNaN(t)) return t;
    }
    if (cookie && typeof cookie.maxAge === 'number') {
      return Date.now() + cookie.maxAge;
    }
    // 兜底：30 天
    return Date.now() + 30 * 24 * 60 * 60 * 1000;
  }

  get = (
    sid: string,
    callback: (err: unknown, session?: SessionData | null) => void
  ): void => {
    try {
      const row = this.getStmt.get(sid) as { data: string; expires_at: number } | undefined;
      if (!row) return callback(null, null);
      if (row.expires_at < Date.now()) {
        this.destroyStmt.run(sid);
        return callback(null, null);
      }
      const session = JSON.parse(row.data) as SessionData;
      callback(null, session);
    } catch (e) {
      callback(e);
    }
  };

  set = (sid: string, session: SessionData, callback?: (err?: unknown) => void): void => {
    try {
      const expiresAt = this.computeExpiresAt(session);
      this.setStmt.run(sid, JSON.stringify(session), expiresAt);
      callback?.();
    } catch (e) {
      callback?.(e);
    }
  };

  destroy = (sid: string, callback?: (err?: unknown) => void): void => {
    try {
      this.destroyStmt.run(sid);
      callback?.();
    } catch (e) {
      callback?.(e);
    }
  };

  touch = (sid: string, session: SessionData, callback?: (err?: unknown) => void): void => {
    try {
      const expiresAt = this.computeExpiresAt(session);
      this.touchStmt.run(expiresAt, sid);
      callback?.();
    } catch (e) {
      callback?.(e);
    }
  };
}
