'use client';

import * as React from 'react';
import { Sidebar } from './sidebar';
import { ChatComponent } from './chat';
import type { Message, Session } from './types';

export type { Message, Session };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8000';

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Stable anonymous user ID — persists in localStorage across refreshes. */
function getAnonymousUserId(): string {
  if (typeof window === 'undefined') return 'anon';
  let id = localStorage.getItem('anon_user_id');
  if (!id) {
    id = 'anon_' + generateId();
    localStorage.setItem('anon_user_id', id);
  }
  return id;
}

function createSession(): Session {
  return {
    id: generateId(),
    title: 'New Chat',
    messages: [],
    createdAt: Date.now(),
  };
}

export const AppShell: React.FC = () => {
  const userId = React.useMemo(() => getAnonymousUserId(), []);
  const [sessions, setSessions] = React.useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = React.useState<string>('');
  const [historyLoading, setHistoryLoading] = React.useState(true);

  // Keep a ref that always holds the latest sessions so async callbacks
  // (like handleSaveSession) can read up-to-date data without stale closures.
  const sessionsRef = React.useRef<Session[]>([]);
  React.useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // ── Load history from backend on mount ──────────────────────────────────
  React.useEffect(() => {
    if (!userId) return;

    setHistoryLoading(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000); // 10 s timeout

    fetch(`${API_BASE}/history?user_id=${encodeURIComponent(userId)}`, {
      signal: controller.signal,
    })
      .then((res) => res.json())
      .then((data) => {
        const loaded: Session[] = data.sessions ?? [];
        if (loaded.length > 0) {
          setSessions(loaded);
          setActiveSessionId(loaded[0].id);
        } else {
          const first = createSession();
          setSessions([first]);
          setActiveSessionId(first.id);
        }
      })
      .catch(() => {
        // Fallback: start with a blank session if the API is unreachable / timed out
        const first = createSession();
        setSessions([first]);
        setActiveSessionId(first.id);
      })
      .finally(() => {
        clearTimeout(timeoutId);
        setHistoryLoading(false);
      });

    return () => {
      controller.abort();
      clearTimeout(timeoutId);
    };
  }, [userId]);

  // ── Persist a session to the backend ────────────────────────────────────
  const saveSessionToBackend = React.useCallback(
    async (session: Session, overrideMessages?: Message[]) => {
      if (!userId) return;
      const messages = overrideMessages ?? session.messages;
      try {
        await fetch(`${API_BASE}/history/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id:    userId,
            session_id: session.id,
            title:      session.title,
            messages,
            created_at: session.createdAt,
          }),
        });
      } catch {
        // History save failed — non-critical, silently ignore
      }
    },
    [userId],
  );

  // ── Handlers ─────────────────────────────────────────────────────────────
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  const handleNewChat = () => {
    const s = createSession();
    setSessions((prev) => [s, ...prev]);
    setActiveSessionId(s.id);
    // No backend save yet — an empty chat is not worth persisting
  };

  const handleSelectSession = (id: string) => setActiveSessionId(id);

  const handleDeleteSession = (id: string) => {
    // Delete from backend first (fire-and-forget)
    if (userId) {
      fetch(
        `${API_BASE}/history/session/${encodeURIComponent(id)}?user_id=${encodeURIComponent(userId)}`,
        { method: 'DELETE' },
      ).catch(() => {});
    }

    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (id === activeSessionId) {
        if (next.length > 0) {
          setActiveSessionId(next[0].id);
        } else {
          const fresh = createSession();
          setActiveSessionId(fresh.id);
          return [fresh];
        }
      }
      return next;
    });
  };

  // Called by ChatComponent on every messages state change (for UI sync only)
  const handleMessagesChange = React.useCallback((sessionId: string, messages: Message[]) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s;
        const firstUser = messages.find((m) => m.role === 'user');
        const title = firstUser
          ? firstUser.content.slice(0, 42) + (firstUser.content.length > 42 ? '…' : '')
          : s.title;
        return { ...s, messages, title };
      }),
    );
  }, []);

  // Called by ChatComponent only after a complete AI response
  // Receives the authoritative final messages array, bypassing stale closure issues
  const handleSaveSession = React.useCallback(
    (sessionId: string, finalMessages: Message[]) => {
      // Also update local state title from the final messages
      let sessionSnapshot: Session | undefined;
      setSessions((prev) => {
        const updated = prev.map((s) => {
          if (s.id !== sessionId) return s;
          const firstUser = finalMessages.find((m) => m.role === 'user');
          const title = firstUser
            ? firstUser.content.slice(0, 42) + (firstUser.content.length > 42 ? '…' : '')
            : s.title;
          sessionSnapshot = { ...s, messages: finalMessages, title };
          return sessionSnapshot;
        });
        return updated;
      });

      // We can't rely on sessionSnapshot from inside setState synchronously,
      // so read from the ref (which is updated after every render) but
      // fall back to constructing just what we need if the ref is slightly stale.
      const fromRef = sessionsRef.current.find((s) => s.id === sessionId);
      if (fromRef) {
        saveSessionToBackend(fromRef, finalMessages);
      }
    },
    [saveSessionToBackend],
  );

  // ── Loading state ─────────────────────────────────────────────────────
  if (historyLoading) {
    return (
      <div className="flex h-screen w-screen bg-slate-950 items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-slate-400 text-sm">Loading your chat history…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen bg-slate-950 overflow-hidden">
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onNewChat={handleNewChat}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
      />
      {activeSession && (
        <ChatComponent
          key={activeSession.id}
          sessionId={activeSession.id}
          initialMessages={activeSession.messages}
          onMessagesChange={handleMessagesChange}
          onSaveSession={handleSaveSession}
        />
      )}
    </div>
  );
};
