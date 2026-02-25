'use client'
import * as React from 'react';
import { Upload, CheckCircle, Loader2, AlertCircle } from 'lucide-react';

type Status = 'idle' | 'uploading' | 'success' | 'error';

const FileUploadComponent: React.FC = () => {
    const [status, setStatus] = React.useState<Status>('idle');
    const [fileName, setFileName] = React.useState<string | null>(null);

    const handleFileUploadButtonClick = () => {
        const el = document.createElement('input');
        el.setAttribute('type', 'file');
        el.setAttribute('accept', 'application/pdf');
        el.addEventListener('change', async (ev) => {
            if (el.files && el.files.length > 0) {
                const file = el.files.item(0);
                if (file) {
                    setFileName(file.name);
                    setStatus('uploading');
                    try {
                        const formData = new FormData();
                        formData.append('pdf', file);
                        const res = await fetch('http://localhost:8000/upload/pdf', {
                            method: 'POST',
                            body: formData,
                        });
                        if (!res.ok) throw new Error('Upload failed');
                        setStatus('success');
                    } catch {
                        setStatus('error');
                    }
                }
            }
        });
        el.click();
    };

    const statusIcon = {
        idle: <Upload size={32} className="text-slate-300" />,
        uploading: <Loader2 size={32} className="text-blue-400 animate-spin" />,
        success: <CheckCircle size={32} className="text-green-400" />,
        error: <AlertCircle size={32} className="text-red-400" />,
    };

    const statusText = {
        idle: 'Click to upload a PDF',
        uploading: 'Uploading…',
        success: 'Uploaded! Embedding in background.',
        error: 'Upload failed. Try again.',
    };

    return (
        <div
            onClick={status === 'uploading' ? undefined : handleFileUploadButtonClick}
            className={`bg-slate-900 text-white shadow-2xl flex flex-col justify-center items-center p-8 rounded-2xl border-2 w-64 gap-4 transition-colors cursor-pointer
                ${status === 'idle' ? 'border-slate-600 hover:border-blue-500' : ''}
                ${status === 'uploading' ? 'border-blue-400 cursor-default' : ''}
                ${status === 'success' ? 'border-green-500' : ''}
                ${status === 'error' ? 'border-red-500' : ''}
            `}
        >
            {statusIcon[status]}
            <div className="text-center">
                <p className="text-sm font-medium">{statusText[status]}</p>
                {fileName && (
                    <p className="text-xs text-slate-400 mt-1 break-all">{fileName}</p>
                )}
            </div>
            {status === 'success' && (
                <button
                    onClick={(e) => { e.stopPropagation(); setStatus('idle'); setFileName(null); }}
                    className="text-xs text-slate-400 underline hover:text-white"
                >
                    Upload another
                </button>
            )}
        </div>
    );
};

export default FileUploadComponent;