"use client";

import React, { useState, useEffect, useRef } from 'react';
import {
  Play,
  CheckCircle,
  XCircle,
  Loader2,
  Globe,
  Key,
  Database,
  BookOpen,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';

type LogEntry = {
  id: string;
  status: 'pending' | 'matched' | 'skipped' | 'failed';
  message: string;
  timestamp: string;
};

type SummaryStats = {
  total: number;
  matched: number;
  skipped: number;
  failed: number;
};

interface ScanState {
  plexUrl: string;
  plexToken: string;
  tmdbKey: string;
  tidbKey: string;
  library: string;
  dryRun: boolean;
  loadingLibraries: boolean;
  scanning: boolean;
  progress: { current: number; total: number; percent: number };
  logs: LogEntry[];
  stats: SummaryStats;
  status: 'idle' | 'running' | 'completed' | 'error';
  errorMessage: string | null;
}

const Index = () => {
  const [state, setState] = useState<ScanState>({
    plexUrl: 'http://localhost:32400',
    plexToken: '',
    tmdbKey: '',
    tidbKey: '',
    library: '',
    dryRun: false,
    loadingLibraries: false,
    scanning: false,
    progress: { current: 0, total: 0, percent: 0 },
    logs: [],
    stats: { total: 0, matched: 0, skipped: 0, failed: 0 },
    status: 'idle',
    errorMessage: null,
  });

  const [libraries, setLibraries] = useState<string[]>([]);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of logs
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [state.logs]);

  const handleLoadLibraries = async () => {
    if (!state.plexUrl || !state.plexToken) {
      setState(prev => ({ ...prev, errorMessage: 'Plex URL and Token are required.' }));
      return;
    }
    setState(prev => ({ ...prev, loadingLibraries: true, errorMessage: null, logs: [] }));
    try {
      const url = `${state.plexUrl}/library/sections`;
      const headers = { 'X-Plex-Token': state.plexToken };
      const response = await fetch(url, { headers });
      
      if (!response.ok) throw new Error(`Plex API error: ${response.status}`);
      
      const data = await response.json();
      const tvLibraries = data.MediaContainer?.Directory
        ?.filter((s: any) => s.type === 'show')
        .map((s: any) => s.title) || [];
      
      setLibraries(tvLibraries);
      if (tvLibraries.length > 0) {
        setState(prev => ({ ...prev, library: tvLibraries[0] }));
      }
    } catch (err: any) {
      setState(prev => ({ ...prev, errorMessage: err.message }));
    } finally {
      setState(prev => ({ ...prev, loadingLibraries: false }));
    }
  };

  const handleStartScan = async () => {
    if (!state.library || !state.tmdbKey || !state.tidbKey) {
      setState(prev => ({ ...prev, errorMessage: 'All configuration fields are required.' }));
      return;
    }
    setState(prev => ({ 
      ...prev, 
      scanning: true, 
      status: 'running', 
      progress: { current: 0, total: 0, percent: 0 },
      logs: [],
      stats: { total: 0, matched: 0, skipped: 0, failed: 0 },
      errorMessage: null,
    }));

    try {
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          library_name: state.library,
          tmdb_api_key: state.tmdbKey,
          tidb_api_key: state.tidbKey,
          dry_run: state.dryRun,
        }),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Scan start failed');
      
      // Poll for results
      const taskId = result.task_id;
      const pollInterval = setInterval(async () => {
        const res = await fetch(`/api/scan/results?task_id=${taskId}&plex_url=${state.plexUrl}&plex_token=${state.plexToken}`);
        const data = await res.json();
        
        setState(prev => ({
          ...prev,
          status: data.status as any,
          progress: data.progress,
          logs: data.log,
          stats: {
            total: data.results.length,
            matched: data.results.filter((r: any) => r.status === 'matched').length,
            skipped: data.results.filter((r: any) => r.status === 'skipped').length,
            failed: data.results.filter((r: any) => r.status === 'failed').length,
          }
        }));

        if (data.status === 'completed' || data.status === 'failed') {
          clearInterval(pollInterval);
        }
      }, 1000);

      // Clean up interval on unmount or state change (simplified here)
      return () => clearInterval(pollInterval);

    } catch (err: any) {
      setState(prev => ({ ...prev, status: 'error', errorMessage: err.message, scanning: false }));
    }
  };

  const handleReset = () => {
    setState({
      plexUrl: 'http://localhost:32400',
      plexToken: '',
      tmdbKey: '',
      tidbKey: '',
      library: '',
      dryRun: false,
      loadingLibraries: false,
      scanning: false,
      progress: { current: 0, total: 0, percent: 0 },
      logs: [],
      stats: { total: 0, matched: 0, skipped: 0, failed: 0 },
      status: 'idle',
      errorMessage: null,
    });
    setLibraries([]);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'matched': return <CheckCircle className="text-green-500" />;
      case 'skipped': return <AlertCircle className="text-yellow-500" />;
      case 'failed': return <XCircle className="text-red-500" />;
      default: return <Loader2 className="text-blue-500 animate-spin" />;
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <div className="max-w-5xl mx-auto px-4 py-8">
        
        {/* Header */}
        <header className="mb-8 text-center">
          <h1 className="text-3xl font-extrabold text-slate-800 mb-2">🎬 Plex Intro Uploader</h1>
          <p className="text-slate-500">Extract intro markers and submit to TheIntroDB</p>
        </header>

        {/* Configuration Card */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Database className="text-blue-500" />
            Configuration
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">Plex URL</label>
              <div className="relative">
                <Globe className="absolute left-2 top-2.5 text-slate-400 w-5 h-5" />
                <input
                  type="url"
                  value={state.plexUrl}
                  onChange={(e) => setState(prev => ({ ...prev, plexUrl: e.target.value }))}
                  className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="http://192.168.1.100:32400"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">Plex Token</label>
              <div className="relative">
                <Key className="absolute left-2 top-2.5 text-slate-400 w-5 h-5" />
                <input
                  type="password"
                  value={state.plexToken}
                  onChange={(e) => setState(prev => ({ ...prev, plexToken: e.target.value }))}
                  className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Your Plex API token"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">TMDB API Key</label>
              <div className="relative">
                <Key className="absolute left-2 top-2.5 text-slate-400 w-5 h-5" />
                <input
                  type="password"
                  value={state.tmdbKey}
                  onChange={(e) => setState(prev => ({ ...prev, tmdbKey: e.target.value }))}
                  className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="tmdb_xxxxxxxxxxx"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">TheIntroDB API Key</label>
              <div className="relative">
                <Key className="absolute left-2 top-2.5 text-slate-400 w-5 h-5" />
                <input
                  type="password"
                  value={state.tidbKey}
                  onChange={(e) => setState(prev => ({ ...prev, tidbKey: e.target.value }))}
                  className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="tidb_xxxxxxxxxxx"
                />
              </div>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-600 mb-1">Target Library</label>
              <select
                value={state.library}
                onChange={(e) => setState(prev => ({ ...prev, library: e.target.value }))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">-- Select a library first --</option>
                {libraries.map((lib) => (
                  <option key={lib} value={lib}>{lib}</option>
                ))}
              </select>
            </div>
            <div className="md:col-span-2 flex items-center gap-2">
              <input
                type="checkbox"
                id="dry-run"
                checked={state.dryRun}
                onChange={(e) => setState(prev => ({ ...prev, dryRun: e.target.checked }))}
                className="w-4 h-4 text-blue-600 rounded"
              />
              <label htmlFor="dry-run" className="text-sm text-slate-600">
                Dry run (preview without submitting to TheIntroDB)
              </label>
            </div>
          </div>
          <div className="mt-6 flex gap-3">
            <button
              onClick={handleLoadLibraries}
              disabled={state.loadingLibraries || state.scanning}
              className="px-4 py-2 bg-white border border-slate-300 text-slate-700 font-medium rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {state.loadingLibraries ? <Loader2 className="animate-spin" /> : <BookOpen />}
              {state.loadingLibraries ? 'Loading...' : 'Load Libraries'}
            </button>
            <button
              onClick={handleStartScan}
              disabled={!state.library || state.scanning || state.loadingLibraries}
              className="flex-1 px-4 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {state.scanning ? <Loader2 className="animate-spin" /> : <Play />}
              {state.scanning ? 'Scanning...' : 'Start Scan'}
            </button>
          </div>
          {state.errorMessage && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-600 rounded-lg flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {state.errorMessage}
            </div>
          )}
        </div>

        {/* Progress Section */}
        {(state.scanning || state.status === 'running' || state.logs.length > 0) && (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <Loader2 className="text-blue-500 animate-spin" />
              Scan Progress
            </h2>
            <div className="mb-4">
              <div className="w-full bg-slate-200 rounded-full h-2 mb-1">
                <div 
                  className="bg-blue-600 h-2 rounded-full transition-all duration-300" 
                  style={{ width: `${state.progress.percent}%` }}
                ></div>
              </div>
              <div className="flex justify-between text-sm text-slate-500">
                <span>{state.progress.current} / {state.progress.total} episodes</span>
                <span>{Math.round(state.progress.percent)}%</span>
              </div>
            </div>
            <div 
              ref={logContainerRef}
              className="bg-slate-900 text-slate-100 rounded-lg p-4 h-64 overflow-y-auto font-mono text-sm space-y-1"
            >
              {state.logs.map((log, index) => (
                <div key={log.id || index} className="flex gap-2">
                  <div className="min-w-[40px] flex items-center">{getStatusIcon(log.status)}</div>
                  <div className="flex-1">
                    <span className="text-slate-400 text-xs">{log.timestamp}</span>
                    <p dangerouslySetInnerHTML={{ __html: log.message }} />
                  </div>
                </div>
              ))}
              {state.logs.length === 0 && (
                <div className="text-slate-500 italic">Waiting for scan results...</div>
              )}
            </div>
          </div>
        )}

        {/* Summary Section */}
        {state.status === 'completed' && (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <CheckCircle className="text-green-500" />
              Scan Summary
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="p-4 bg-slate-50 rounded-lg text-center">
                <div className="text-2xl font-bold text-slate-800">{state.stats.total}</div>
                <div className="text-sm text-slate-500">Total</div>
              </div>
              <div className="p-4 bg-green-50 rounded-lg text-center">
                <div className="text-2xl font-bold text-green-600">{state.stats.matched}</div>
                <div className="text-sm text-green-600">Matched</div>
              </div>
              <div className="p-4 bg-yellow-50 rounded-lg text-center">
                <div className="text-2xl font-bold text-yellow-600">{state.stats.skipped}</div>
                <div className="text-sm text-yellow-600">Skipped</div>
              </div>
              <div className="p-4 bg-red-50 rounded-lg text-center">
                <div className="text-2xl font-bold text-red-600">{state.stats.failed}</div>
                <div className="text-sm text-red-600">Failed</div>
              </div>
            </div>
            <button
              onClick={handleReset}
              className="w-full px-4 py-2 bg-slate-100 text-slate-700 font-medium rounded-lg hover:bg-slate-200 flex items-center justify-center gap-2"
            >
              <RefreshCw />
              Start New Scan
            </button>
          </div>
        )}

        <footer className="mt-8 text-center text-sm text-slate-400">
          <p>Plex Intro Uploader — Powered by FastAPI & TheIntroDB</p>
          <p className="mt-1">
            <a href="https://theintrodb.org" className="hover:text-blue-500">TheIntroDB</a> ·
            <a href="https://www.plex.tv" className="hover:text-blue-500">Plex</a> ·
            <a href="https://www.themoviedb.org" className="hover:text-blue-500">TMDB</a>
          </p>
        </footer>
      </div>
    </div>
  );
};

export default Index;