'use client';

import * as React from 'react';
import {
  ArrowLeft, X, FolderOpen, FileText, Eye, Trash2,
  Globe, GitMerge, Loader2,
} from 'lucide-react';
import type { PdfEntry } from './types';

const TRANSLATE_LANGS = [
  'French', 'Spanish', 'German', 'Chinese', 'Japanese',
  'Arabic', 'Hindi', 'Portuguese', 'Russian', 'Italian',
];

interface PDFLibraryPanelProps {
  pdfLibrary: PdfEntry[];
  loading: boolean;
  translatingPdf: string | null;
  mergeLoading: boolean;
  onDelete: (name: string) => void;
  onTranslate: (filename: string, lang: string) => void;
  /** Called with the list of filenames to merge and the desired output filename. */
  onMerge: (filenames: string[], outputName: string) => void;
  onClose: () => void;
}

export const PDFLibraryPanel: React.FC<PDFLibraryPanelProps> = ({
  pdfLibrary,
  loading,
  translatingPdf,
  mergeLoading,
  onDelete,
  onTranslate,
  onMerge,
  onClose,
}) => {
  const [previewPdfName, setPreviewPdfName] = React.useState<string | null>(null);
  const [mergeSelected, setMergeSelected] = React.useState<string[]>([]);
  const [mergeName, setMergeName] = React.useState('');
  const [perPdfLang, setPerPdfLang] = React.useState<Record<string, string>>({});

  const handleDelete = (name: string) => {
    onDelete(name);
    setMergeSelected((prev) => prev.filter((n) => n !== name));
    if (previewPdfName === name) setPreviewPdfName(null);
  };

  const handleMergeClick = () => {
    if (mergeSelected.length < 2 || mergeLoading) return;
    const outName = mergeName.trim() || `merged_${Date.now()}`;
    onMerge(mergeSelected, outName);
    setMergeSelected([]);
    setMergeName('');
  };

  return (
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
          onClick={() => { onClose(); setPreviewPdfName(null); }}
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
        <>
          {/* Library list */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {pdfLibrary.length === 0 ? (
              <div className="flex flex-col items-center gap-3 mt-16 text-center px-6">
                <FolderOpen size={36} className="text-slate-700" />
                <p className="text-xs text-slate-500">
                  No PDFs yet.<br />Upload a PDF to get started.
                </p>
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
                          e.target.checked
                            ? [...prev, pdf.name]
                            : prev.filter((n) => n !== pdf.name)
                        )
                      }
                      className="accent-blue-500 shrink-0"
                      title="Select for merge"
                    />
                    <FileText size={13} className="text-slate-400 shrink-0" />
                    <span
                      className="text-xs text-slate-200 flex-1 truncate"
                      title={pdf.displayName}
                    >
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
                      onClick={() => handleDelete(pdf.name)}
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
                      {TRANSLATE_LANGS.map((l) => (
                        <option key={l} value={l}>{l}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => onTranslate(pdf.name, perPdfLang[pdf.name] ?? 'French')}
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
                  onClick={handleMergeClick}
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
  );
};
