'use client';

import * as React from 'react';
import Image from 'next/image';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8000';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Send, User, Loader2, Paperclip, CheckCircle, XCircle,
  Mic, MicOff, Copy, Check, Download, Pencil, X, FileText, Eye,
  Globe, GitMerge, ArrowLeft, Trash2, FolderOpen,
} from 'lucide-react';
import type { Message } from './types';

type UploadStatus = 'idle' | 'uploading' | 'embedding' | 'success' | 'error';
type PdfEntry = { name: string; displayName: string; objectUrl: string };

interface ChatProps {
  sessionId: string;
  initialMessages: Message[];
  onMessagesChange: (sessionId: string, messages: Message[]) => void;
  /** Called once after each complete user↔assistant exchange so the parent can persist the session. */
  onSaveSession?: (sessionId: string, messages: Message[]) => void;
}

export const ChatComponent: React.FC<ChatProps> = ({
  sessionId,
  initialMessages,
  onMessagesChange,
  onSaveSession,
}) => {
  const [messages, setMessages] = React.useState<Message[]>(initialMessages);
  const [input, setInput] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [suggestions, setSuggestions] = React.useState<string[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = React.useState(false);
  const [uploadStatus, setUploadStatus] = React.useState<UploadStatus>('idle');
  const [uploadedFileName, setUploadedFileName] = React.useState<string | null>(null);
  const [uploadedFileServerName, setUploadedFileServerName] = React.useState<string | null>(null);
  const [isListening, setIsListening] = React.useState(false);
  const [voiceSupported, setVoiceSupported] = React.useState(false);

  // ── New feature state ─────────────────────────────────────────────────────
  const [copiedIndex, setCopiedIndex] = React.useState<number | null>(null);
  const [editingIndex, setEditingIndex] = React.useState<number | null>(null);
  const [editValue, setEditValue] = React.useState('');
  const [exportMenuOpen, setExportMenuOpen] = React.useState(false);
  const [hoveredMsgIndex, setHoveredMsgIndex] = React.useState<number | null>(null);

  // ── PDF library ───────────────────────────────────────────────────────────
  const [pdfLibrary, setPdfLibrary] = React.useState<PdfEntry[]>([]);
  const [previewPdfName, setPreviewPdfName] = React.useState<string | null>(null);
  const [showPdfLibrary, setShowPdfLibrary] = React.useState(false);
  const [mergeSelected, setMergeSelected] = React.useState<string[]>([]);
  const [mergeName, setMergeName] = React.useState('');
  const [mergeLoading, setMergeLoading] = React.useState(false);
  const [perPdfLang, setPerPdfLang] = React.useState<Record<string, string>>({});
  const [translatingPdf, setTranslatingPdf] = React.useState<string | null>(null);

  const recognitionRef = React.useRef<SpeechRecognition | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const exportMenuRef = React.useRef<HTMLDivElement>(null);
  const pendingUploadRef = React.useRef<{ displayName: string; objectUrl: string } | null>(null);

  // Cleanup all blob URLs on unmount
  React.useEffect(() => {
    return () => {
      pdfLibrary.forEach((p) => {
        if (p.objectUrl.startsWith('blob:')) URL.revokeObjectURL(p.objectUrl);
      });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-dismiss upload status pill 2 s after success (file appears as a chip)
  React.useEffect(() => {
    if (uploadStatus === 'success') {
      const t = setTimeout(() => setUploadStatus('idle'), 2000);
      return () => clearTimeout(t);
    }
  }, [uploadStatus]);

  // Close export dropdown on outside click
  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Detect Web Speech API support (client-side only)
  React.useEffect(() => {
    const SR = typeof window !== 'undefined'
      ? (window.SpeechRecognition ?? window.webkitSpeechRecognition)
      : undefined;
    setVoiceSupported(!!SR);
  }, []);

  const toggleVoice = React.useCallback(() => {
    // Stop if already listening
    if (isListening) {
      recognitionRef.current?.stop();
      return;
    }

    const SR =
      window.SpeechRecognition ??
      window.webkitSpeechRecognition;
    if (!SR) return;

    const recognition = new SR();
    recognition.lang = 'en-US';
    recognition.interimResults = true;  // show live transcript in the input
    recognition.maxAlternatives = 1;
    recognition.continuous = false;     // auto-stops after a pause

    let finalTranscript = '';

    recognition.onstart = () => setIsListening(true);

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalTranscript += t;
        else interim += t;
      }
      // Show both confirmed + in-progress transcript in the textarea
      setInput(finalTranscript + interim);
    };

    recognition.onerror = () => {
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
      // Auto-send once speech ends and we have something to say
      if (finalTranscript.trim()) {
        setInput('');
        // Directly invoke sendMessage with the final transcript
        // We use a small timeout so React can flush the setInput('') first
        setTimeout(() => {
          sendMessageRef.current?.(finalTranscript.trim());
        }, 0);
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isListening]);

  // Stable ref so recognition.onend closure can always call the latest sendMessage
  const sendMessageRef = React.useRef<((text: string) => void) | null>(null);

  // Always keep a ref to the latest messages so we can read them without
  // adding them to a useEffect dependency array (avoids infinite loops).
  const messagesRef = React.useRef<Message[]>(messages);
  messagesRef.current = messages;

  // Persist messages up to AppShell (for chat history).
  // Only fires when loading flips false (i.e. streaming finished), not on every
  // token — which would exceed React's max update depth.
  React.useEffect(() => {
    if (loading) return;
    onMessagesChange(sessionId, messagesRef.current);
  }, [loading, sessionId, onMessagesChange]);

  // Auto-scroll to the latest message
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.pdf')) {
      setUploadStatus('error');
      setUploadedFileName('Only PDF files are accepted');
      return;
    }
    setUploadedFileName(file.name);
    setUploadStatus('uploading');

    // Store local blob URL — will be moved to the library when embedding finishes
    const objUrl = URL.createObjectURL(file);
    pendingUploadRef.current = { displayName: file.name, objectUrl: objUrl };

    try {
      const formData = new FormData();
      formData.append('pdf', file);
      const res = await fetch(`${API_BASE}/upload/pdf`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      const serverFilename: string = data.filename ?? file.name;
      setUploadedFileServerName(serverFilename);
      setUploadStatus('embedding');

      // Poll /upload/status until embedding finishes (max ~60s)
      let pollCount = 0;
      const MAX_POLLS = 30; // 30 × 2s = 60s timeout
      const pollInterval = setInterval(async () => {
        pollCount += 1;
        if (pollCount >= MAX_POLLS) {
          // Timed out — assume done so the UI doesn't lock up
          setUploadStatus('success');
          clearInterval(pollInterval);
          const pending = pendingUploadRef.current;
          if (pending) {
            setPdfLibrary((prev) => {
              const filtered = prev.filter((p) => p.name !== serverFilename);
              return [...filtered, { name: serverFilename, displayName: pending.displayName, objectUrl: pending.objectUrl }];
            });
            setShowPdfLibrary(true);
            pendingUploadRef.current = null;
          }
          return;
        }
        try {
          const statusRes = await fetch(
            `${API_BASE}/upload/status?filename=${encodeURIComponent(serverFilename)}`
          );
          if (statusRes.ok) {
            const statusData = await statusRes.json();
            if (statusData.status === 'done') {
              setUploadStatus('success');
              clearInterval(pollInterval);
              const pending = pendingUploadRef.current;
              if (pending) {
                setPdfLibrary((prev) => {
                  const filtered = prev.filter((p) => p.name !== serverFilename);
                  return [...filtered, { name: serverFilename, displayName: pending.displayName, objectUrl: pending.objectUrl }];
                });
                setShowPdfLibrary(true);
                pendingUploadRef.current = null;
              }
            } else if (statusData.status === 'error') {
              setUploadStatus('error');
              clearInterval(pollInterval);
            }
          }
        } catch {
          // non-critical — keep polling
        }
      }, 2000);
    } catch {
      setUploadStatus('error');
    }
    // reset input so same file can be re-picked
    e.target.value = '';
  };

  const dismissUpload = () => {
    setUploadStatus('idle');
    setUploadedFileName(null);
  };

  // ── Delete PDF from library + server ─────────────────────────────────────
  const handleDeletePdf = async (name: string) => {
    try {
      await fetch(`${API_BASE}/pdfs/${encodeURIComponent(name)}`, { method: 'DELETE' });
    } catch { /* non-critical */ }
    setPdfLibrary((prev) => {
      const entry = prev.find((p) => p.name === name);
      if (entry?.objectUrl.startsWith('blob:')) URL.revokeObjectURL(entry.objectUrl);
      return prev.filter((p) => p.name !== name);
    });
    setMergeSelected((prev) => prev.filter((n) => n !== name));
    if (previewPdfName === name) setPreviewPdfName(null);
  };

  // ── Merge selected PDFs ───────────────────────────────────────────────────
  const handleMerge = async () => {
    if (mergeSelected.length < 2 || mergeLoading) return;
    const outName = mergeName.trim() || `merged_${Date.now()}`;
    setMergeLoading(true);
    try {
      const res = await fetch(`${API_BASE}/pdf/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filenames: mergeSelected, output_name: outName }),
      });
      if (!res.ok) throw new Error('Merge failed');
      const data = await res.json();
      const serverName: string = data.filename;
      // Add merged PDF to library using its server download URL (no local blob)
      const objectUrl = `http://localhost:8000/pdf/download/${encodeURIComponent(serverName)}`;
      setPdfLibrary((prev) => [
        ...prev.filter((p) => p.name !== serverName),
        { name: serverName, displayName: serverName, objectUrl },
      ]);
      setMergeSelected([]);
      setMergeName('');
      // Show embedding progress in the bottom pill
      setUploadedFileName(serverName);
      setUploadedFileServerName(serverName);
      setUploadStatus('embedding');
      let count = 0;
      const poll = setInterval(async () => {
        count++;
        if (count >= 30) { setUploadStatus('success'); clearInterval(poll); return; }
        try {
          const sr = await fetch(`${API_BASE}/upload/status?filename=${encodeURIComponent(serverName)}`);
          if (sr.ok) {
            const sd = await sr.json();
            if (sd.status === 'done') { setUploadStatus('success'); clearInterval(poll); }
            else if (sd.status === 'error') { setUploadStatus('error'); clearInterval(poll); }
          }
        } catch { /* keep polling */ }
      }, 2000);
    } catch {
      alert('Merge failed. Please check that the selected PDFs exist on the server.');
    } finally {
      setMergeLoading(false);
    }
  };

  // ── Translate PDF ─────────────────────────────────────────────────────────
  const handleTranslate = async (filename: string, lang: string) => {
    if (translatingPdf || loading) return;
    setShowPdfLibrary(false);
    setTranslatingPdf(filename);
    const userMsg: Message = { role: 'user', content: `Translate "${filename}" to ${lang}` };
    const snapshotBefore = messages;
    setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '' }]);
    setLoading(true);
    let fullText = '';
    let hadError = false;
    try {
      const res = await fetch(`${API_BASE}/pdf/translate/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, language: lang }),
      });
      if (!res.ok || !res.body) throw new Error('Translation failed');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        // Keep the last (potentially incomplete) line in the buffer
        sseBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'token' && parsed.data) {
              fullText += parsed.data;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  content: updated[updated.length - 1].content + parsed.data,
                };
                return updated;
              });
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch {
      hadError = true;
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: 'Error: Translation failed. Please try again.' };
        return updated;
      });
    } finally {
      setLoading(false);
      setTranslatingPdf(null);
      if (!hadError && fullText.trim()) {
        onSaveSession?.(sessionId, [
          ...snapshotBefore,
          userMsg,
          { role: 'assistant', content: fullText },
        ]);
      }
    }
  };

  // ── Copy message ──────────────────────────────────────────────────────────
  const copyMessage = async (content: string, index: number) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 1500);
    } catch { /* clipboard not available */ }
  };

  // ── Export chat ───────────────────────────────────────────────────────────
  const exportChat = (format: 'txt' | 'md') => {
    setExportMenuOpen(false);
    const lines: string[] = [];
    if (format === 'md') {
      lines.push(`# Chat Export\n`);
      messages.forEach((m) => {
        lines.push(`### ${m.role === 'user' ? '\u{1F464} You' : '\u{1F916} Assistant'}\n`);
        lines.push(m.content + '\n');
      });
    } else {
      messages.forEach((m) => {
        lines.push(`[${m.role === 'user' ? 'You' : 'Assistant'}]: ${m.content}\n`);
      });
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat-export.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Summarize PDF ─────────────────────────────────────────────────────────
  const summarize = () => {
    const prompt = pdfLibrary.length > 1
      ? `Please provide a comprehensive summary of each of the ${pdfLibrary.length} uploaded PDFs: ${pdfLibrary.map((p) => p.displayName).join(', ')}.`
      : 'Please provide a comprehensive summary of the uploaded PDF document.';
    sendMessageRef.current?.(prompt);
  };

  // ── Edit message ──────────────────────────────────────────────────────────
  const startEdit = (index: number, content: string) => {
    setEditingIndex(index);
    setEditValue(content);
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditValue('');
  };

  const submitEdit = () => {
    if (!editValue.trim() || editingIndex === null) return;
    // Discard the edited message and everything after it, then re-send
    const before = messages.slice(0, editingIndex);
    setMessages(before);
    setEditingIndex(null);
    setEditValue('');
    setTimeout(() => { sendMessageRef.current?.(editValue.trim()); }, 0);
  };

  const sendMessage = async (overrideText?: string) => {
    const trimmed = (overrideText ?? input).trim();
    if (!trimmed || loading) return;

    setSuggestions([]);
    const userMessage: Message = { role: 'user', content: trimmed };
    // Snapshot messages *before* this exchange so we can reconstruct final state
    const messagesBeforeExchange = messages;
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    // Add an empty assistant message that we'll stream into
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    let fullAnswer = '';
    let hadError = false;

    try {
      const history = messages.map((m) => ({ role: m.role, content: m.content }));
      const res = await fetch(`${API_BASE}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          history,
          active_pdfs: pdfLibrary.map((p) => p.name),
        }),
      });
      if (!res.ok || !res.body) throw new Error('Stream failed');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        // Keep the last (potentially incomplete) line in the buffer
        sseBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'token' && parsed.data) {
              fullAnswer += parsed.data;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  content: updated[updated.length - 1].content + parsed.data,
                };
                return updated;
              });
            }
          } catch {
            // skip malformed chunks
          }
        }
      }

      // Fetch follow-up suggestions after answer is complete
      if (fullAnswer.trim()) {
        setSuggestionsLoading(true);
        try {
          const sugRes = await fetch(
            `${API_BASE}/suggestions?message=${encodeURIComponent(trimmed)}&answer=${encodeURIComponent(fullAnswer)}`
          );
          if (sugRes.ok) {
            const sugData = await sugRes.json();
            setSuggestions(sugData.suggestions ?? []);
          }
        } catch {
          // suggestions are non-critical, ignore errors
        } finally {
          setSuggestionsLoading(false);
        }
      }
    } catch {
      hadError = true;
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: 'Error: Could not reach the server.',
        };
        return updated;
      });
    } finally {
      setLoading(false);
      // Persist the completed exchange to the backend (skip on error)
      if (!hadError && fullAnswer.trim()) {
        const finalMessages: Message[] = [
          ...messagesBeforeExchange,
          userMessage,
          { role: 'assistant', content: fullAnswer },
        ];
        onSaveSession?.(sessionId, finalMessages);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Keep ref always pointing at the latest sendMessage (avoids stale closure in recognition.onend)
  // Direct assignment during render is the correct pattern — no useEffect needed
  sendMessageRef.current = sendMessage;

  const handleSuggestionClick = (s: string) => {
    setSuggestions([]);
    sendMessage(s);
  };

  // ── Shared markdown component map ─────────────────────────────────────────
  const mdComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
    h1: ({ children }) => <h1 className="text-lg font-bold mt-3 mb-1 first:mt-0">{children}</h1>,
    h2: ({ children }) => <h2 className="text-base font-bold mt-3 mb-1 first:mt-0">{children}</h2>,
    h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1 first:mt-0">{children}</h3>,
    ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
    em: ({ children }) => <em className="italic text-slate-300">{children}</em>,
    code: ({ children, className }) => {
      const isBlock = className?.includes('language-');
      return isBlock ? (
        <code className="block bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 my-2 text-xs font-mono text-green-300 overflow-x-auto whitespace-pre">{children}</code>
      ) : (
        <code className="bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs font-mono text-green-300">{children}</code>
      );
    },
    pre: ({ children }) => <pre className="my-2">{children}</pre>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-blue-500 pl-3 my-2 text-slate-400 italic">{children}</blockquote>
    ),
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline hover:text-blue-300">{children}</a>
    ),
    table: ({ children }) => (
      <div className="overflow-x-auto my-2">
        <table className="min-w-full text-xs border-collapse border border-slate-600">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-slate-700">{children}</thead>,
    th: ({ children }) => <th className="border border-slate-600 px-2 py-1 text-left font-semibold">{children}</th>,
    td: ({ children }) => <td className="border border-slate-600 px-2 py-1">{children}</td>,
    hr: () => <hr className="border-slate-600 my-2" />,
  };

  return (
    <div className="flex flex-1 h-screen min-w-0 overflow-hidden">

      {/* ── Chat column ──────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 h-screen bg-slate-950 text-white min-w-0">

        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-700 flex items-center gap-2 flex-wrap">
          <Image src="/icon.svg" alt="PDF Chat icon" width={26} height={26} />
          <h2 className="text-base font-semibold flex-1 min-w-0">PDF Chat</h2>

          {/* Summarize button — visible when any PDF is available */}
          {(pdfLibrary.length > 0 || uploadStatus === 'embedding') && (
            <button
              onClick={summarize}
              disabled={loading || uploadStatus === 'embedding'}
              title={uploadStatus === 'embedding' ? 'Waiting for embedding…' : 'Summarize the uploaded PDF'}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-600 transition-colors disabled:opacity-40 shrink-0"
            >
              <FileText size={13} />
              Summarize
            </button>
          )}

          {/* PDF Library button */}
          {(pdfLibrary.length > 0 || uploadStatus === 'uploading' || uploadStatus === 'embedding') && (
            <button
              onClick={() => setShowPdfLibrary((v) => !v)}
              title="Manage PDFs"
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors shrink-0 ${
                showPdfLibrary
                  ? 'bg-blue-600 text-white border-blue-500'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border-slate-600'
              }`}
            >
              <FolderOpen size={13} />
              {pdfLibrary.length > 0 ? `PDFs (${pdfLibrary.length})` : 'PDFs'}
            </button>
          )}

          {/* Export dropdown */}
          {messages.length > 0 && (
            <div className="relative shrink-0" ref={exportMenuRef}>
              <button
                onClick={() => setExportMenuOpen((v) => !v)}
                title="Export chat"
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-600 transition-colors"
              >
                <Download size={13} />
                Export
              </button>
              {exportMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-36 bg-slate-800 border border-slate-600 rounded-xl shadow-xl z-20 overflow-hidden">
                  <button
                    onClick={() => exportChat('md')}
                    className="w-full text-left px-4 py-2.5 text-xs text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
                  >
                    Export as .md
                  </button>
                  <button
                    onClick={() => exportChat('txt')}
                    className="w-full text-left px-4 py-2.5 text-xs text-slate-300 hover:bg-slate-700 hover:text-white transition-colors border-t border-slate-700"
                  >
                    Export as .txt
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

      {/* Message list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center pb-24">
            <Image src="/icon.svg" alt="PDF RAG" width={56} height={56} className="opacity-30" />
            <p className="text-slate-400 text-base font-medium">What can I help you with?</p>
            <p className="text-slate-600 text-sm max-w-xs">
              Click the <span className="inline-flex items-center gap-1 text-slate-500"><Paperclip size={13} /> attach</span> button below to upload a PDF, then ask anything about it.
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            onMouseEnter={() => setHoveredMsgIndex(i)}
            onMouseLeave={() => setHoveredMsgIndex(null)}
          >
              {msg.role === 'assistant' && (
                <div className="mt-1 shrink-0">
                  <Image src="/icon.svg" alt="assistant" width={22} height={22} />
                </div>
              )}

              <div className={`flex flex-col gap-1 max-w-[75%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                {/* ── Edit mode ── */}
                {editingIndex === i ? (
                  <div className="flex flex-col gap-2 w-full">
                    <textarea
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEdit(); }
                        if (e.key === 'Escape') cancelEdit();
                      }}
                      className="bg-slate-800 border border-blue-500 rounded-2xl px-4 py-3 text-sm text-white outline-none resize-none w-full min-h-[60px]"
                      autoFocus
                    />
                    <div className="flex gap-2 justify-end">
                      <button onClick={cancelEdit} className="text-xs px-3 py-1 rounded-lg bg-slate-800 text-slate-400 hover:text-white border border-slate-600 transition-colors">
                        Cancel
                      </button>
                      <button onClick={submitEdit} disabled={!editValue.trim()} className="text-xs px-3 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 transition-colors">
                        Send
                      </button>
                    </div>
                  </div>
                ) : (
                  /* ── Normal message bubble ── */
                  <div
                    className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-blue-600 text-white rounded-br-sm whitespace-pre-wrap'
                        : 'bg-slate-800 text-slate-100 rounded-bl-sm'
                    }`}
                  >
                    {msg.role === 'user' ? (
                      msg.content
                    ) : (
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                        {msg.content}
                      </ReactMarkdown>
                    )}
                  </div>
                )}

                {/* ── Per-message action buttons (hover) ── */}
                {editingIndex !== i && hoveredMsgIndex === i && msg.content && (
                  <div className="flex gap-1">
                    <button
                      onClick={() => copyMessage(msg.content, i)}
                      title="Copy"
                      className="p-1 rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
                    >
                      {copiedIndex === i
                        ? <Check size={13} className="text-green-400" />
                        : <Copy size={13} />}
                    </button>
                    {msg.role === 'user' && !loading && (
                      <button
                        onClick={() => startEdit(i, msg.content)}
                        title="Edit message"
                        className="p-1 rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
                      >
                        <Pencil size={13} />
                      </button>
                    )}
                  </div>
                )}
              </div>

              {msg.role === 'user' && (
                <div className="mt-1 shrink-0">
                  <User size={18} className="text-slate-400" />
                </div>
              )}
            </div>
        ))}

          {/* ── Typing indicator — animated bouncing dots ── */}
          {loading && messages[messages.length - 1]?.content === '' && (
            <div className="flex gap-3 justify-start">
              <Image src="/icon.svg" alt="assistant" width={22} height={22} className="mt-1 shrink-0" />
              <div className="bg-slate-800 rounded-2xl rounded-bl-sm px-4 py-3.5 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
                <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
                <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div className="p-4 border-t border-slate-700">
        {/* Suggestion chips */}
        {(suggestions.length > 0 || suggestionsLoading) && (
          <div className="flex flex-wrap gap-2 mb-3">
            {suggestionsLoading
              ? [1, 2, 3].map((i) => (
                  <div key={i} className="h-8 w-40 rounded-full bg-slate-800 animate-pulse" />
                ))
              : suggestions.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => handleSuggestionClick(s)}
                    className="text-xs px-3 py-1.5 rounded-full border border-slate-600 bg-slate-800 text-slate-300 hover:border-blue-500 hover:text-white hover:bg-slate-700 transition-colors text-left"
                  >
                    {s}
                  </button>
                ))}
          </div>
        )}
        {/* Active PDF chips — one per uploaded file */}
        {pdfLibrary.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {pdfLibrary.map((pdf) => (
              <div
                key={pdf.name}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-800 border border-slate-600 text-xs text-slate-200"
              >
                <FileText size={11} className="text-blue-400 shrink-0" />
                <span className="max-w-[160px] truncate" title={pdf.displayName}>{pdf.displayName}</span>
                <button
                  onClick={() => handleDeletePdf(pdf.name)}
                  title="Remove PDF"
                  className="ml-0.5 text-slate-500 hover:text-red-400 transition-colors"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Upload status pill — only for in-progress / error states */}
        {(uploadStatus === 'uploading' || uploadStatus === 'embedding' || uploadStatus === 'error' || uploadStatus === 'success') && (
          <div className={`flex items-center gap-2 mb-2 px-3 py-1.5 rounded-full w-fit text-xs font-medium
            ${uploadStatus === 'uploading' ? 'bg-slate-800 text-slate-300' : ''}
            ${uploadStatus === 'embedding' ? 'bg-slate-800 text-blue-400 border border-blue-700/50' : ''}
            ${uploadStatus === 'success' ? 'bg-green-900/40 text-green-400 border border-green-700' : ''}
            ${uploadStatus === 'error' ? 'bg-red-900/40 text-red-400 border border-red-700' : ''}
          `}>
            {uploadStatus === 'uploading' && <Loader2 size={12} className="animate-spin" />}
            {uploadStatus === 'embedding' && <Loader2 size={12} className="animate-spin text-blue-400" />}
            {uploadStatus === 'success' && <CheckCircle size={12} />}
            {uploadStatus === 'error' && <XCircle size={12} />}
            <span className="max-w-[220px] truncate">
              {uploadStatus === 'embedding' ? `Embedding "${uploadedFileName}"…` : uploadedFileName}
            </span>
            {(uploadStatus === 'success' || uploadStatus === 'error') && (
              <button onClick={dismissUpload} className="ml-1 opacity-60 hover:opacity-100">✕</button>
            )}
          </div>
        )}
        <div className="flex items-end gap-2 bg-slate-800 rounded-2xl px-3 py-2">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={handleFileChange}
          />
          {/* Attach button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadStatus === 'uploading' || uploadStatus === 'embedding'}
            title="Upload PDF"
            className="mb-1 text-slate-400 hover:text-blue-400 disabled:opacity-30 transition-colors shrink-0"
          >
            <Paperclip size={18} />
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isListening
                ? 'Listening… speak now'
                : uploadStatus === 'embedding'
                ? `Embedding "${uploadedFileName}"… please wait`
                : pdfLibrary.length > 0
                ? `${pdfLibrary.length} PDF${pdfLibrary.length > 1 ? 's' : ''} ready — ask anything…`
                : 'Attach a PDF then ask anything… (Enter to send)'
            }
            rows={1}
            className={`flex-1 bg-transparent resize-none outline-none text-sm text-white py-1 max-h-32 transition-colors ${
              isListening ? 'placeholder-red-400' : 'placeholder-slate-500'
            }`}
          />
          {/* Mic button — only shown when Speech API is available */}
          {voiceSupported && (
            <button
              onClick={toggleVoice}
              disabled={loading}
              title={isListening ? 'Stop listening' : 'Speak your message'}
              className={`mb-1 transition-colors disabled:opacity-30 shrink-0 ${
                isListening
                  ? 'text-red-400 animate-pulse hover:text-red-300'
                  : 'text-slate-400 hover:text-blue-400'
              }`}
            >
              {isListening ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
          )}
          <button
            onClick={() => sendMessage()}
            disabled={loading || !input.trim()}
            className="mb-1 text-blue-400 hover:text-blue-300 disabled:opacity-30 transition-colors"
          >
            <Send size={18} />
          </button>
        </div>
        <p className="text-xs text-slate-600 text-center mt-1">
          {isListening
            ? 'Speak now — will auto-send when you stop · click 🎤 to cancel'
            : 'Shift+Enter for new line · Enter to send · 🎤 to speak'}
        </p>
        </div>
      </div>

      {/* ── PDF Library Panel ────────────────────────────────────────────────── */}
      {showPdfLibrary && (
        <div className="w-[45%] flex flex-col border-l border-slate-700 bg-slate-900 shrink-0">
          {/* Panel header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-700 shrink-0">
            {previewPdfName && (
              <button
                onClick={() => setPreviewPdfName(null)}
                className="text-slate-400 hover:text-white transition-colors shrink-0"
                title="Back to library"
              >
                <ArrowLeft size={16} />
              </button>
            )}
            <span className="text-sm font-medium text-white flex-1 truncate">
              {previewPdfName ?? `PDF Library (${pdfLibrary.length})`}
            </span>
            <button
              onClick={() => { setShowPdfLibrary(false); setPreviewPdfName(null); }}
              className="text-slate-500 hover:text-white transition-colors"
              title="Close"
            >
              <X size={16} />
            </button>
          </div>

          {/* Preview mode — show iframe */}
          {previewPdfName ? (
            <iframe
              src={pdfLibrary.find((p) => p.name === previewPdfName)?.objectUrl}
              className="flex-1 w-full"
              title="PDF Preview"
            />
          ) : (
            /* Library list mode */
            <>
              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {pdfLibrary.length === 0 ? (
                  <div className="flex flex-col items-center gap-3 mt-16 text-center px-6">
                    <FolderOpen size={36} className="text-slate-700" />
                    <p className="text-xs text-slate-500">No PDFs yet.<br />Upload a PDF to get started.</p>
                  </div>
                ) : (
                  pdfLibrary.map((pdf) => (
                    <div key={pdf.name} className="bg-slate-800 rounded-xl p-3 space-y-2">
                      {/* Name row: checkbox + icon + name + preview + delete */}
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={mergeSelected.includes(pdf.name)}
                          onChange={(e) =>
                            setMergeSelected((prev) =>
                              e.target.checked ? [...prev, pdf.name] : prev.filter((n) => n !== pdf.name)
                            )
                          }
                          className="accent-blue-500 shrink-0"
                          title="Select for merge"
                        />
                        <FileText size={13} className="text-slate-400 shrink-0" />
                        <span className="text-xs text-slate-200 flex-1 truncate" title={pdf.displayName}>
                          {pdf.displayName}
                        </span>
                        <button
                          onClick={() => setPreviewPdfName(pdf.name)}
                          title="Preview"
                          className="p-1 text-slate-500 hover:text-blue-400 transition-colors"
                        >
                          <Eye size={13} />
                        </button>
                        <button
                          onClick={() => handleDeletePdf(pdf.name)}
                          title="Remove from library"
                          className="p-1 text-slate-500 hover:text-red-400 transition-colors"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      {/* Translate row */}
                      <div className="flex items-center gap-2 pl-5">
                        <Globe size={11} className="text-slate-500 shrink-0" />
                        <select
                          value={perPdfLang[pdf.name] ?? 'French'}
                          onChange={(e) =>
                            setPerPdfLang((prev) => ({ ...prev, [pdf.name]: e.target.value }))
                          }
                          className="flex-1 text-xs bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-300 outline-none"
                        >
                          {['French', 'Spanish', 'German', 'Chinese', 'Japanese', 'Arabic', 'Hindi', 'Portuguese', 'Russian', 'Italian'].map((l) => (
                            <option key={l} value={l}>{l}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => handleTranslate(pdf.name, perPdfLang[pdf.name] ?? 'French')}
                          disabled={translatingPdf !== null || loading}
                          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 transition-colors shrink-0"
                        >
                          {translatingPdf === pdf.name
                            ? <Loader2 size={11} className="animate-spin" />
                            : <Globe size={11} />}
                          Translate
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Merge bar — appears when 2+ are selected */}
              {mergeSelected.length >= 2 && (
                <div className="shrink-0 border-t border-slate-700 p-3 space-y-2">
                  <p className="text-xs text-slate-400 flex items-center gap-1.5">
                    <GitMerge size={12} />
                    Merging {mergeSelected.length} PDFs
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={mergeName}
                      onChange={(e) => setMergeName(e.target.value)}
                      placeholder="merged.pdf"
                      className="flex-1 text-xs bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white placeholder-slate-500 outline-none"
                    />
                    <button
                      onClick={handleMerge}
                      disabled={mergeLoading}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-green-700 hover:bg-green-600 text-white disabled:opacity-40 transition-colors shrink-0"
                    >
                      {mergeLoading
                        ? <Loader2 size={11} className="animate-spin" />
                        : <GitMerge size={11} />}
                      Merge
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

    </div>
  );
};

export default ChatComponent;
