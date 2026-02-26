export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface Session {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
}

/** A PDF entry held in the shared library (app-shell level state). */
export interface PdfEntry {
  /** Server-side filename (used for API calls). */
  name: string;
  /** Original display name shown in the UI. */
  displayName: string;
  /** Blob URL (local upload) or server download URL (merged PDF). */
  objectUrl: string;
}
