"""
SQLite persistence layer for per-user chat history.

Schema
------
sessions
  id             TEXT  PK
  user_id        TEXT  NOT NULL  (Clerk user ID)
  title          TEXT  NOT NULL
  messages_json  TEXT  NOT NULL  (JSON array of {role, content})
  created_at     INTEGER NOT NULL  (unix ms)
  updated_at     INTEGER NOT NULL  (unix ms)
"""

import json
import os
import sqlite3

DB_PATH = os.path.join(os.path.dirname(__file__), "chat_history.db")


# ── Connection ──────────────────────────────────────────────────────────────

def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")   # safe for concurrent async access
    return conn


# ── Bootstrap ───────────────────────────────────────────────────────────────

def init_db() -> None:
    """Create tables and indexes if they don't already exist."""
    with _get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id            TEXT    PRIMARY KEY,
                user_id       TEXT    NOT NULL,
                title         TEXT    NOT NULL,
                messages_json TEXT    NOT NULL DEFAULT '[]',
                created_at    INTEGER NOT NULL,
                updated_at    INTEGER NOT NULL
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_user "
            "ON sessions(user_id, updated_at DESC)"
        )
        conn.commit()


# ── CRUD ────────────────────────────────────────────────────────────────────

def get_sessions(user_id: str) -> list[dict]:
    """Return all sessions for *user_id*, newest first."""
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC",
            (user_id,),
        ).fetchall()
    return [
        {
            "id":        row["id"],
            "title":     row["title"],
            "messages":  json.loads(row["messages_json"]),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }
        for row in rows
    ]


def upsert_session(
    *,
    user_id:    str,
    session_id: str,
    title:      str,
    messages:   list,
    created_at: int,
    updated_at: int,
) -> None:
    """Insert or update a session row."""
    with _get_conn() as conn:
        conn.execute(
            """
            INSERT INTO sessions (id, user_id, title, messages_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title         = excluded.title,
                messages_json = excluded.messages_json,
                updated_at    = excluded.updated_at
            """,
            (
                session_id,
                user_id,
                title,
                json.dumps(messages),
                created_at,
                updated_at,
            ),
        )
        conn.commit()


def delete_session(*, user_id: str, session_id: str) -> None:
    """Delete a session only if it belongs to *user_id*."""
    with _get_conn() as conn:
        conn.execute(
            "DELETE FROM sessions WHERE id = ? AND user_id = ?",
            (session_id, user_id),
        )
        conn.commit()
