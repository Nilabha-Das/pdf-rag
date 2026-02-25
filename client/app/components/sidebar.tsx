'use client';

import * as React from 'react';
import Image from 'next/image';
import { SquarePen, MessageSquare, Trash2, Sun, Moon, Search, X, User } from 'lucide-react';
import type { Session } from './types';

interface SidebarProps {
  sessions: Session[];
  activeSessionId: string;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  activeSessionId,
  onNewChat,
  onSelectSession,
  onDeleteSession,
}) => {
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [isDark, setIsDark] = React.useState(true);
  // Hydrate theme from localStorage on mount
  React.useEffect(() => {
    const stored = localStorage.getItem('theme');
    setIsDark(stored !== 'light');
  }, []);

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    if (next) {
      document.documentElement.classList.remove('light');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.add('light');
      localStorage.setItem('theme', 'light');
    }
  };

  const filteredSessions = searchQuery.trim()
    ? sessions.filter((s) =>
        s.title.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : sessions;

  return (
    <div className="flex flex-col h-screen w-64 bg-slate-900 border-r border-slate-700 shrink-0">
      {/* Logo + theme toggle */}
      <div className="flex items-center gap-2 px-4 py-4 border-b border-slate-700">
        <Image src="/icon.svg" alt="PDF RAG" width={28} height={28} />
        <span className="text-white font-bold text-sm flex-1">PDF RAG Chat</span>
        <button
          onClick={toggleTheme}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
        >
          {isDark ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>

      {/* New Chat button */}
      <div className="px-3 py-3">
        <button
          onClick={onNewChat}
          className="flex items-center gap-2 w-full px-3 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
        >
          <SquarePen size={16} />
          New Chat
        </button>
      </div>

      {/* Search box */}
      {sessions.length > 1 && (
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 bg-slate-800 rounded-lg px-2.5 py-1.5">
            <Search size={13} className="text-slate-500 shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search chats…"
              className="flex-1 bg-transparent text-xs text-white placeholder-slate-500 outline-none"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="text-slate-500 hover:text-slate-300">
                <X size={12} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* History label */}
      {sessions.length > 0 && (
        <p className="text-xs text-slate-500 font-medium px-4 pb-1 pt-1 uppercase tracking-wider">
          {searchQuery ? `${filteredSessions.length} result${filteredSessions.length !== 1 ? 's' : ''}` : 'Recent'}
        </p>
      )}

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
        {filteredSessions.map((s) => (
          <div
            key={s.id}
            onMouseEnter={() => setHoveredId(s.id)}
            onMouseLeave={() => setHoveredId(null)}
            onClick={() => onSelectSession(s.id)}
            className={`group flex items-center gap-2 px-3 py-2.5 rounded-xl cursor-pointer transition-colors text-sm
              ${s.id === activeSessionId
                ? 'bg-slate-700 text-white'
                : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
          >
            <MessageSquare size={14} className="shrink-0 text-slate-400" />
            <span className="flex-1 truncate">{s.title}</span>
            {(hoveredId === s.id || s.id === activeSessionId) && (
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteSession(s.id); }}
                className="shrink-0 text-slate-500 hover:text-red-400 transition-colors"
                title="Delete chat"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        ))}

        {filteredSessions.length === 0 && (
          <p className="text-xs text-slate-600 text-center mt-6 px-4">
            {searchQuery ? 'No chats match your search.' : 'No chats yet. Start by uploading a PDF.'}
          </p>
        )}
      </div>

      {/* Footer — anonymous user */}
      <div className="px-4 py-3 border-t border-slate-700">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center shrink-0">
            <User size={16} className="text-slate-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-slate-300 font-medium truncate">Anonymous</p>
            <p className="text-xs text-slate-600 truncate">Local session</p>
          </div>
        </div>
      </div>
    </div>
  );
};
