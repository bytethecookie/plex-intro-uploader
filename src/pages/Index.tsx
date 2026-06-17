"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
  Server,
  Copy,
  Check,
  Eye,
  EyeOff,
  Settings2,
} from 'lucide-react';
import InputField from '@/components/InputField';

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
  showPlexToken: boolean;
  showTmdbKey: boolean;
  showTidbKey: boolean;
  loadingLibraries: boolean;
  scanning: boolean;
  progress: { current: number; total: number; percent: number };
  logs: LogEntry[];
  stats: SummaryStats;
  status: 'idle' | 'running' | 'completed' | 'error';
  errorMessage: string | null;
  backendConnected: boolean;
  lastBackendCheck: Date | null;
}

const loadConfig = (): Partial<ScanState> => {
  try {
    const saved = localStorage.getItem('plex-intro-config');
    if (saved) {
      return JSON.parse(saved);
    }
  } catch {
    // ignore
  }
  return {};
};

const saveConfig = (config: Partial<ScanState>) => {
  try {
    const { showPlexToken, showTmdbKey, showTidbKey, lastBackendCheck, ...toSave } = config;
    localStorage.setItem('plex-intro-config', JSON.stringify(toSave));
  } catch {
    // ignore
  }
};

const Index = () => {
  const savedConfig = loadConfig();
  
  const [state, setState] = useState<ScanState>({
    plexUrl: savedConfig.plexUrl || 'http://localhost:32400',
    plexToken: savedConfig.plexToken || '',
    tmdbKey: savedConfig.tmdbKey || '',
    tidbKey: savedConfig.tidbKey || '',
    library: savedConfig.library || '',
    dryRun: savedConfig.dryRun ?? false,
    showPlexToken: false,
    showTmdbKey: false,
    showTidbKey: false,
    loadingLibraries: false,
    scanning: false,
    progress: { current: 0, total: 0, percent: 0 },
    logs: [],
    stats: { total: 0, matched: 0, skipped: 0, failed: 0 },
    status: 'idle',
    errorMessage: null,
    backendConnected: false,
    lastBackendCheck: null,
  });

  const [libraries, setLibraries] = useState<string[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Save config whenever it changes (excluding UI-only state)
  useEffect(() => {
    saveConfig({
      plexUrl: state.plexUrl,
      plexToken: state.plexToken,
      tmdbKey: state.tmdbKey,
      tidbKey: state.tidbKey,
      library: state.library,
      dryRun: state.dryRun,
    });
  }, [state.plexUrl, state.plexToken, state.tmdbKey, state.tidbKey, state.library, state.dryRun]);

  // Auto-scroll to bottom of logs
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [state.logs]);

  // Check backend connectivity
  const checkBackend = useCallback(async () => {
    try {
      const response = await fetch('/api/health');
      const connected = response.ok;
      setState(prev => ({ 
        ...prev, 
        backendConnected: connected,
        lastBackendCheck: new Date()
      }));
    } catch {
      setState(prev => ({ 
        ...prev, 
        backendConnected: false,
        lastBackendCheck: new Date()
      }));
    }
  }, []);

  // Initial backend check
  useEffect(() => {
    checkBackend();
    // Check every 5 seconds
    const interval = setInterval(checkBackend, 5000);
    return () => clearInterval(interval);
  }, [checkBackend]);

  const copyToClipboard = useCallback(async (text: string, key: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // fallback
    }
  }, []);

  const handleLoadLibraries = useCallback(async () => {
    const url = state.plexUrl || 'http://localhost:32400';
    const token = state.plexToken || '';
    
    if (!url || !token) {
      setState(prev => ({ ...prev, errorMessage: 'Please enter both Plex URL and Token.' }));
      return;
    }

    setState(prev => ({ ...prev, loadingLibraries: true, errorMessage: null, logs: [] }));
    try {
      const endpoint = `${url}/library/sections`;
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        ...(token && { 'X-Plex-Token': token }),
      };
      const response = await fetch(endpoint, { headers });
      
      if (!response.ok) {
        // Better error messages based on status code
        let errorMsg = `Plex API error: ${response.status}`;
        if (response.status === 401 || response.status === 403) {
          errorMsg = 'Invalid Plex token. Please check your credentials.';
        } else if (response.status === 404 || response.status === 503) {
          errorMsg = 'Plex server is not responding. Check if the server is running and the URL is correct.';
        }
        throw new Error(errorMsg);
      }
      
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        throw new Error(`Unexpected response format. Try adding /library/sections to the URL.`);
      }
      
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
  }, [state.plexUrl, state.plexToken]);

  const handleStartScan = useCallback(async () => {
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

    let pollInterval: any = null;

    try {
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          library_name: state.library,
          tmdb_api_key: state.tmdbKey,
          tidb_api_key: state.tidbKey,
          dry_run: state.dryRun,
          plex_url: state.plexUrl,
          plex_token: state.plexToken,
        }),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Scan start failed');
      
      const taskId = result.task_id;
      
      pollInterval = setInterval(async () => {
        const res = await fetch(`/api/scan/results?task_id=${taskId}`);
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

    } catch (err: any) {
      setState(prev => ({ ...prev, status: 'error', errorMessage: err.message, scanning: false }));
    }
  }, [state.library, state.tmdbKey, state.tidbKey, state.dryRun, state.plexUrl, state.plexToken]);

  const handleReset = useCallback(() => {
    setState({
      plexUrl: state.plexUrl || 'http://localhost:32400',
      plexToken: '',
      tmdbKey: '',
      tidbKey: '',
      library: '',
      dryRun: false,
      showPlexToken: false,
      showTmdbKey: false,
      showTidbKey: false,
      loadingLibraries: false,
      scanning: false,
      progress: { current: 0, total: 0, percent: 0 },
      logs: [],
      stats: { total: 0, matched: 0, skipped: 0, failed: 0 },
      status: 'idle',
      errorMessage: null,
      backendConnected: state.backendConnected,
      lastBackendCheck: state.lastBackendCheck,
    });
    setLibraries([]);
  }, [state.plexUrl, state.backendConnected, state.lastBackendCheck]);

  const handleChange = useCallback((field: keyof Omit<ScanState, 'logs' | 'stats' | 'status' | 'errorMessage' | 'loadingLibraries' | 'scanning' | 'progress' | 'backendConnected' | 'lastBackendCheck' | 'library'>, value: any) => {
    setState(prev => ({ ...prev, [field]: value }));
  }, []);

  const handleToggle = useCallback((field: 'showPlexToken' | 'showTmdbKey' | 'showTidbKey') => {
    setState(prev => ({ ...prev, [field]: !prev[field] }));
  }, []);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'matched': return <CheckCircle className="text-emerald-500" />;
      case 'skipped': return <AlertCircle className="text-amber-500" />;
      case 'failed': return <XCircle className="text-red-500" />;
      default: return <Loader2 className="text-blue-500 animate-spin" />;
    }
  };

  const formatDateTime = (date: Date | null) => {
    if (!date) return 'Never';
    return date.toLocaleTimeString();
  };

  // Render log messages that contain HTML (from backend)
  const renderLogMessage = (message: string) => {
    // If message contains HTML tags, render as HTML
    if (message.includes('<')) {
      return <span dangerouslySetInnerHTML={{ __html: message }} />;
    }
    return <span>{message}</span>;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 text-slate-900 font-sans">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white">
        <div className="max-w-5xl mx-auto px-4 py-8">
          <div className="flex items-center gap-3 mb-2">
            <Settings2 className="w-6 h-6" />
            <h1 className="text-2xl font-bold">🎬 Plex Intro Uploader</h1>
          </div>
          <p className="text-blue-100 text-sm">Extract intro markers from your Plex library and submit them to TheIntroDB</p>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* Backend Status */}
        <div className="mb-6">
          <div className="p-4 bg-white/80 backdrop-blur-sm border border-slate-200 rounded-xl shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-2.5 h-2.5 rounded-full ${state.backendConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                <div>
                  <h3 className="font-semibold text-slate-700">
                    Backend {state.backendConnected ? 'Connected' : 'Disconnected'}
                  </h3>
                  <p className="text-xs text-slate-400">
                    Last check: {formatDateTime(state.lastBackendCheck)}
                  </p>
                </div>
              </div>
              <button
                onClick={checkBackend}
                className="px-3 py-1.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-md transition-colors text-slate-600"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Configuration Card */}
        <div className="bg-white/80 backdrop-blur-sm rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
          <h2 className="text-lg font-semibold mb-5 flex items-center gap-2 text-slate-800">
            <Database className="text-blue-500 w-5 h-5" />
            Configuration
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <InputField
              label="Plex URL"
              value={state.plexUrl}
              onChange={(val) => handleChange('plexUrl' as any, val)}
              placeholder="http://localhost:32400"
              icon={Globe}
              copyKey="plexUrl"
              isCopied={copiedKey === 'plexUrl'}
              onCopy={() => copyToClipboard(state.plexUrl, 'plexUrl')}
            />
            <InputField
              label="Plex Token"
              value={state.plexToken}
              onChange={(val) => handleChange('plexToken' as any, val)}
              placeholder="Your Plex API token"
              icon={Key}
              type="password"
              showToggle
              toggleState={state.showPlexToken}
              onToggle={() => handleToggle('showPlexToken')}
              copyKey="plexToken"
              isCopied={copiedKey === 'plexToken'}
              onCopy={() => copyToClipboard(state.plexToken, 'plexToken')}
            />
            <InputField
              label="TMDB API Key"
              value={state.tmdbKey}
              onChange={(val) => handleChange('tmdbKey' as any, val)}
              placeholder="tmdb_xxxxxxxxxxx"
              icon={Key}
              type="password"
              showToggle
              toggleState={state.showTmdbKey}
              onToggle={() => handleToggle('showTmdbKey')}
              copyKey="tmdbKey"
              isCopied={copiedKey === 'tmdbKey'}
              onCopy={() => copyToClipboard(state.tmdbKey, 'tmdbKey')}
            />
            <InputField
              label="TheIntroDB API Key"
              value={state.tidbKey}
              onChange={(val) => handleChange('tidbKey' as any, val)}
              placeholder="tidb_xxxxxxxxxxx"
              icon={Key}
              type="password"
              showToggle
              toggleState={state.showTidbKey}
              onToggle={() => handleToggle('showTidbKey')}
              copyKey="tidbKey"
              isCopied={copiedKey === 'tidbKey'}
              onCopy={() => copyToClipboard(state.tidbKey, 'tidbKey')}
            />
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-600 mb-1">Target Library</label>
              <select
                value={state.library}
                onChange={(e) => setState(prev => ({ ...prev, library: e.target.value }))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all"
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
                className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500"
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
              className="px-4 py-2.5 bg-white border border-slate-300 text-slate-700 font-medium rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-all"
            >
              {state.loadingLibraries ? <Loader2 className="animate-spin w-4 h-4" /> : <BookOpen className="w-4 h-4" />}
              {state.loadingLibraries ? 'Loading...' : 'Load Libraries'}
            </button>
            <button
              onClick={handleStartScan}
              disabled={!state.library || state.scanning || state.loadingLibraries}
              className="flex-1 px-4 py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all"
            >
              {state.scanning ? <Loader2 className="animate-spin w-4 h-4" /> : <Play className="w-4 h-4" />}
              {state.scanning ? 'Scanning...' : 'Start Scan'}
            </button>
          </div>
          {state.errorMessage && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-600 rounded-lg flex items-center gap-2 animate-in">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span className="text-sm">{state.errorMessage}</span>
            </div>
          )}
        </div>

        {/* Progress Section */}
        {(state.scanning || state.status === 'running' || state.logs.length > 0) && (
          <div className="bg-white/80 backdrop-blur-sm rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2 text-slate-800">
              {state.scanning ? <Loader2 className="text-blue-500 animate-spin w-5 h-5" /> : <CheckCircle className="text-green-500 w-5 h-5" />}
              Scan Progress
            </h2>
            {state.status === 'running' && (
              <div className="mb-4">
                <div className="w-full bg-slate-100 rounded-full h-2 mb-1.5">
                  <div 
                    className="bg-blue-600 h-2 rounded-full transition-all duration-300" 
                    style={{ width: `${Math.max(state.progress.percent, 0.1)}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-slate-400">
                  <span>{state.progress.current} / {state.progress.total} episodes</span>
                  <span>{Math.round(state.progress.percent)}%</span>
                </div>
              </div>
            )}
            <div 
              ref={logContainerRef}
              className="bg-slate-900 text-slate-100 rounded-lg p-4 h-64 overflow-y-auto font-mono text-xs space-y-1.5 scrollbar-thin"
            >
              {state.logs.length === 0 && state.status === 'running' ? (
                <div className="text-slate-500 italic">Waiting for scan results...</div>
              ) : (
                state.logs.map((log, index) => (
                  <div key={log.id || index} className="flex gap-2.5">
                    <div className="mt-1.5 min-w-[16px]">{getStatusIcon(log.status)}</div>
                    <div className="flex-1">
                      {renderLogMessage(log.message)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Summary */}
        {state.status === 'completed' && (
          <div className="bg-white/80 backdrop-blur-sm rounded-xl shadow-sm border border-slate-200 p-6">
            <h2 className="text-lg font-semibold mb-5 flex items-center gap-2 text-slate-800">
              <CheckCircle className="text-green-500 w-5 h-5" />
              Scan Summary
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="p-4 bg-slate-50 rounded-xl text-center">
                <div className="text-2xl font-bold text-slate-700">{state.stats.total}</div>
                <div className="text-xs text-slate-400 mt-1">Total Episodes</div>
              </div>
              <div className="p-4 bg-emerald-50 rounded-xl text-center">
                <div className="text-2xl font-bold text-emerald-600">{state.stats.matched}</div>
                <div className="text-xs text-emerald-500 mt-1">Matched</div>
              </div>
              <div className="p-4 bg-amber-50 rounded-xl text-center">
                <div className="text-2xl font-bold text-amber-600">{state.stats.skipped}</div>
                <div className="text-xs text-amber-500 mt-1">Skipped</div>
              </div>
              <div className="p-4 bg-red-50 rounded-xl text-center">
                <div className="text-2xl font-bold text-red-600">{state.stats.failed}</div>
                <div className="text-xs text-red-500 mt-1">Failed</div>
              </div>
            </div>
            <button
              onClick={handleReset}
              className="w-full px-4 py-2.5 bg-slate-100 text-slate-700 font-medium rounded-lg hover:bg-slate-200 flex items-center justify-center gap-2 transition-all"
            >
              <RefreshCw className="w-4 h-4" />
              Start New Scan
            </button>
          </div>
        )}

        <footer className="mt-8 text-center text-xs text-slate-400 pb-6">
          <p>Plex Intro Uploader — Powered by FastAPI & TheIntroDB</p>
          <p className="mt-1">
            <a href="https://theintrodb.org" className="hover:text-blue-500 transition-colors">TheIntroDB</a> ·
            <a href="https://www.plex.tv" className="hover:text-blue-500 transition-colors">Plex</a> ·
            <a href="https://www.themoviedb.org" className="hover:text-blue-500 transition-colors">TMDB</a>
          </p>
        </footer>
      </div>
    </div>
  );
};

export default Index;