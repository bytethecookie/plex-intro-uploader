"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Play, CheckCircle, XCircle, Loader2, Globe, Key, Database, BookOpen,
  AlertCircle, RefreshCw, Upload, Settings2, ChevronDown, ChevronRight,
  AlertTriangle, RotateCcw,
} from 'lucide-react';
import InputField from '@/components/InputField';

// --- Types ---

type LogEntry = { status: string; message: string };

type EpisodeResult = {
  show_title?: string;
  title: string;
  season: number;
  episode: number;
  tvdb_id: string;
  imdb_id?: string;
  intro_start?: number;
  intro_end?: number;
  start_ms?: number;
  end_ms?: number;
  duration_ms?: number;
  status: 'matched' | 'skipped' | 'failed';
  message: string;
  previously_submitted_introdb?: boolean;
  previously_submitted_skipdb?: boolean;
};

type SubmitResult = {
  title: string;
  season: number;
  episode: number;
  destination: string;
  // submitted | rejected | rate_limited | error
  status: string;
  message: string;
  http_status?: number;
  external_id?: string;
};

// --- Indeterminate checkbox ---

const IndeterminateCheckbox = ({
  checked, indeterminate, onChange, className = '',
}: {
  checked: boolean; indeterminate: boolean; onChange: () => void; className?: string;
}) => {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate && !checked; }, [indeterminate, checked]);
  return (
    <input ref={ref} type="checkbox" checked={checked} onChange={onChange}
      onClick={e => e.stopPropagation()}
      className={`w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 ${className}`} />
  );
};

// --- Submit status chip ---

const StatusChip = ({ status }: { status: string }) => {
  const cfg: Record<string, { cls: string; icon: React.ReactNode; label: string }> = {
    submitted:    { cls: 'bg-emerald-100 text-emerald-700', icon: <CheckCircle className="w-3 h-3" />, label: 'Submitted' },
    rejected:     { cls: 'bg-red-100 text-red-700',         icon: <XCircle className="w-3 h-3" />,     label: 'Rejected' },
    rate_limited: { cls: 'bg-amber-100 text-amber-700',     icon: <AlertTriangle className="w-3 h-3" />, label: 'Rate limited' },
    error:        { cls: 'bg-slate-100 text-slate-600',     icon: <XCircle className="w-3 h-3" />,     label: 'Error' },
  };
  const c = cfg[status] ?? cfg.error;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${c.cls}`}>
      {c.icon}{c.label}
    </span>
  );
};

// --- Persistence ---

const CONFIG_KEY = 'plex-intro-config';
const loadLocalConfig = () => { try { const s = localStorage.getItem(CONFIG_KEY); return s ? JSON.parse(s) : {}; } catch { return {}; } };
const saveLocalConfig = (cfg: Record<string, unknown>) => { try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch { /* */ } };

// --- Main component ---

const Index = () => {
  const saved = loadLocalConfig();

  // Config — seeded from localStorage, then overwritten by server on mount
  const [plexUrl, setPlexUrl] = useState<string>(saved.plexUrl || 'http://localhost:32400');
  const [plexToken, setPlexToken] = useState<string>(saved.plexToken || '');
  const [tmdbKey, setTmdbKey] = useState<string>(saved.tmdbKey || '');
  const [introbKey, setIntrobKey] = useState<string>(saved.introbKey || '');
  const [skipdbKey, setSkipdbKey] = useState<string>(saved.skipdbKey || '');
  const [library, setLibrary] = useState<string>(saved.library || '');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [libraries, setLibraries] = useState<string[]>([]);

  const [showPlexToken, setShowPlexToken] = useState(false);
  const [showTmdbKey, setShowTmdbKey] = useState(false);
  const [showIntrobKey, setShowIntrobKey] = useState(false);
  const [showSkipdbKey, setShowSkipdbKey] = useState(false);

  // Which community DB(s) to submit to
  const [submitIntrodb, setSubmitIntrodb] = useState<boolean>(saved.submitIntrodb ?? true);
  const [submitSkipdb, setSubmitSkipdb] = useState<boolean>(saved.submitSkipdb ?? false);

  // Backend
  const [backendConnected, setBackendConnected] = useState(false);
  const [lastCheck, setLastCheck] = useState<Date | null>(null);

  // Scan
  const [scanStatus, setScanStatus] = useState<'idle' | 'running' | 'completed' | 'error'>('idle');
  const [progress, setProgress] = useState({ current: 0, total: 0, percent: 0 });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [results, setResults] = useState<EpisodeResult[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loadingLibraries, setLoadingLibraries] = useState(false);

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collapsedShows, setCollapsedShows] = useState<Set<string>>(new Set());
  const [collapsedSeasons, setCollapsedSeasons] = useState<Set<string>>(new Set());

  // Submit
  const [submitRunning, setSubmitRunning] = useState(false);
  const [submitDone, setSubmitDone] = useState(false);
  const [submitProgress, setSubmitProgress] = useState({ current: 0, total: 0, percent: 0 });
  const [submitResults, setSubmitResults] = useState<SubmitResult[]>([]);
  // Keep the ordered list of episodes we submitted so we can match back by index for retry
  const [submittedEpisodes, setSubmittedEpisodes] = useState<EpisodeResult[]>([]);

  const logRef = useRef<HTMLDivElement>(null);

  // --- Derived ---

  const matchedResults = useMemo(() => results.filter(r => r.status === 'matched'), [results]);
  const resultKey = (r: EpisodeResult) => `${r.imdb_id}_S${r.season}E${r.episode}`;

  const groupedResults = useMemo(() => {
    const map: Record<string, Record<number, EpisodeResult[]>> = {};
    for (const ep of matchedResults) {
      const show = ep.show_title || 'Unknown Show';
      if (!map[show]) map[show] = {};
      if (!map[show][ep.season]) map[show][ep.season] = [];
      map[show][ep.season].push(ep);
    }
    return Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([show, seasons]) => ({
        show,
        seasons: Object.entries(seasons)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([season, eps]) => ({
            season: Number(season),
            episodes: [...eps].sort((a, b) => a.episode - b.episode),
          })),
      }));
  }, [matchedResults]);

  const selectedCount = useMemo(
    () => matchedResults.filter(r => selectedIds.has(resultKey(r))).length,
    [matchedResults, selectedIds]
  );
  const allSelected = matchedResults.length > 0 && selectedCount === matchedResults.length;
  const anySelected = selectedCount > 0;

  // Destinations actually usable right now (toggled on AND has an API key configured)
  const activeDestinations = useMemo(() => [
    submitIntrodb && introbKey && 'introdb',
    submitSkipdb && skipdbKey && 'skipdb',
  ].filter(Boolean) as string[], [submitIntrodb, submitSkipdb, introbKey, skipdbKey]);

  const getShowEps    = (show: string) => matchedResults.filter(r => (r.show_title || 'Unknown Show') === show);
  const getSeasonEps  = (show: string, s: number) => matchedResults.filter(r => (r.show_title || 'Unknown Show') === show && r.season === s);
  const isShowSel     = (show: string) => getShowEps(show).every(r => selectedIds.has(resultKey(r)));
  const isShowPartial = (show: string) => { const eps = getShowEps(show); return eps.some(r => selectedIds.has(resultKey(r))) && !eps.every(r => selectedIds.has(resultKey(r))); };
  const isSeasonSel   = (show: string, s: number) => getSeasonEps(show, s).every(r => selectedIds.has(resultKey(r)));
  const isSeasonPartial = (show: string, s: number) => { const eps = getSeasonEps(show, s); return eps.some(r => selectedIds.has(resultKey(r))) && !eps.every(r => selectedIds.has(resultKey(r))); };

  // An episode counts as "already sent" once it's been submitted to every destination currently enabled
  const isFullySent = useCallback((r: EpisodeResult) => {
    return activeDestinations.length > 0 && activeDestinations.every(d =>
      d === 'introdb' ? r.previously_submitted_introdb : r.previously_submitted_skipdb
    );
  }, [activeDestinations]);

  const stats = useMemo(() => ({
    total: results.length,
    matched: matchedResults.length,
    skipped: results.filter(r => r.status === 'skipped').length,
    failed: results.filter(r => r.status === 'failed').length,
    prevSubmitted: matchedResults.filter(isFullySent).length,
  }), [results, matchedResults, isFullySent]);

  const rateLimitedCount  = submitResults.filter(r => r.status === 'rate_limited').length;
  const rejectedCount     = submitResults.filter(r => r.status === 'rejected').length;
  const submitErrorCount  = submitResults.filter(r => r.status === 'error').length;
  const submittedCount    = submitResults.filter(r => r.status === 'submitted').length;

  // One episode can produce multiple result rows (one per destination) — count distinct failed episodes
  const failedEpisodeKeys = useMemo(() => new Set(
    submitResults.filter(r => r.status !== 'submitted').map(r => `${r.season}_${r.episode}_${r.title}`)
  ), [submitResults]);
  const failedSubmitCount = failedEpisodeKeys.size;

  // --- Persistence ---

  // Load config from server on mount (overwrites localStorage seed)
  useEffect(() => {
    fetch('/api/config')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (!cfg) return;
        if (cfg.plexUrl)   setPlexUrl(cfg.plexUrl);
        if (cfg.plexToken) setPlexToken(cfg.plexToken);
        if (cfg.tmdbKey)   setTmdbKey(cfg.tmdbKey);
        if (cfg.introbKey) setIntrobKey(cfg.introbKey);
        if (cfg.skipdbKey) setSkipdbKey(cfg.skipdbKey);
        if (cfg.library)   setLibrary(cfg.library);
      })
      .catch(() => { /* backend not up yet — localStorage seed is fine */ });
  }, []);

  // Save to localStorage immediately on any change
  useEffect(() => {
    saveLocalConfig({ plexUrl, plexToken, tmdbKey, introbKey, skipdbKey, library, submitIntrodb, submitSkipdb });
  }, [plexUrl, plexToken, tmdbKey, introbKey, skipdbKey, library, submitIntrodb, submitSkipdb]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  // --- Backend health ---

  const checkBackend = useCallback(async () => {
    try { const r = await fetch('/api/health'); setBackendConnected(r.ok); }
    catch { setBackendConnected(false); }
    setLastCheck(new Date());
  }, []);

  useEffect(() => {
    checkBackend();
    const iv = setInterval(checkBackend, 5000);
    return () => clearInterval(iv);
  }, [checkBackend]);

  // --- Config save ---

  const [configSaved, setConfigSaved] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const handleSaveConfig = useCallback(async () => {
    setConfigSaved('saving');
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plexUrl, plexToken, tmdbKey, introbKey, skipdbKey, library }),
      });
      setConfigSaved(r.ok ? 'saved' : 'error');
    } catch {
      setConfigSaved('error');
    }
    setTimeout(() => setConfigSaved('idle'), 2500);
  }, [plexUrl, plexToken, tmdbKey, introbKey, skipdbKey, library]);

  // --- Scan ---

  const handleLoadLibraries = useCallback(async () => {
    if (!plexUrl || !plexToken) { setErrorMessage('Enter Plex URL and Token first.'); return; }
    setLoadingLibraries(true); setErrorMessage(null);
    try {
      const r = await fetch(`${plexUrl}/library/sections`, {
        headers: { Accept: 'application/json', 'X-Plex-Token': plexToken },
      });
      if (!r.ok) throw new Error(`Plex error: ${r.status}`);
      const data = await r.json();
      const tvLibs = (data.MediaContainer?.Directory ?? [])
        .filter((s: any) => s.type === 'show').map((s: any) => s.title as string);
      setLibraries(tvLibs);
      if (tvLibs.length > 0) setLibrary(tvLibs[0]);
    } catch (e: any) { setErrorMessage(e.message); }
    finally { setLoadingLibraries(false); }
  }, [plexUrl, plexToken]);

  const handleStartScan = useCallback(async () => {
    if (!library || !tmdbKey) { setErrorMessage('Plex library and TMDB key are required.'); return; }
    if (!introbKey && !skipdbKey) { setErrorMessage('Enter an IntroDB and/or SkipDB API key.'); return; }
    if (!backendConnected) { setErrorMessage('Backend not connected.'); return; }

    setScanStatus('running');
    setProgress({ current: 0, total: 0, percent: 0 });
    setLogs([]); setResults([]);
    setSelectedIds(new Set()); setSubmitResults([]); setSubmittedEpisodes([]);
    setSubmitDone(false); setSubmitRunning(false);
    setErrorMessage(null);
    setCollapsedShows(new Set()); setCollapsedSeasons(new Set());

    let poll: ReturnType<typeof setInterval> | null = null;
    try {
      const r = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ library_name: library, tmdb_api_key: tmdbKey, plex_url: plexUrl, plex_token: plexToken }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || 'Scan failed to start');
      const taskId = data.task_id;

      poll = setInterval(async () => {
        try {
          const res = await fetch(`/api/scan/results?task_id=${taskId}`);
          const d = await res.json();
          setProgress(d.progress ?? { current: 0, total: 0, percent: 0 });
          setLogs(d.log ?? []);
          setResults(d.results ?? []);
          setScanStatus(d.status);
          if (d.status === 'completed' || d.status === 'failed') {
            if (poll) clearInterval(poll);
            if (d.status === 'completed') {
              // Default-uncheck episodes already sent to every currently enabled destination
              setSelectedIds(new Set(
                d.results
                  .filter((r: EpisodeResult) => r.status === 'matched' && !isFullySent(r))
                  .map(resultKey)
              ));
            }
          }
        } catch { /* transient */ }
      }, 1000);
    } catch (e: any) { setScanStatus('error'); setErrorMessage(e.message); }
  }, [library, tmdbKey, introbKey, skipdbKey, plexUrl, plexToken, backendConnected, isFullySent]);

  // --- Selection ---

  const toggleSelectAll = useCallback(() => {
    setSelectedIds(allSelected ? new Set() : new Set(matchedResults.map(resultKey)));
  }, [allSelected, matchedResults]);

  const toggleShow = useCallback((show: string) => {
    const eps = getShowEps(show);
    const allSel = eps.every(r => selectedIds.has(resultKey(r)));
    setSelectedIds(prev => {
      const next = new Set(prev);
      eps.forEach(ep => allSel ? next.delete(resultKey(ep)) : next.add(resultKey(ep)));
      return next;
    });
  }, [selectedIds, matchedResults]);

  const toggleSeason = useCallback((show: string, season: number) => {
    const eps = getSeasonEps(show, season);
    const allSel = eps.every(r => selectedIds.has(resultKey(r)));
    setSelectedIds(prev => {
      const next = new Set(prev);
      eps.forEach(ep => allSel ? next.delete(resultKey(ep)) : next.add(resultKey(ep)));
      return next;
    });
  }, [selectedIds, matchedResults]);

  const toggleEp = useCallback((key: string) => {
    setSelectedIds(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }, []);

  const toggleCollapseShow = useCallback((show: string) => {
    setCollapsedShows(prev => { const n = new Set(prev); n.has(show) ? n.delete(show) : n.add(show); return n; });
  }, []);

  const toggleCollapseSeason = useCallback((key: string) => {
    setCollapsedSeasons(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }, []);

  // --- Submit ---

  // Shared submit runner. `destinationOverrides` (keyed by resultKey) lets a retry target only
  // the destinations that actually failed for a given episode, instead of every active destination.
  const runSubmit = useCallback(async (
    toSubmit: EpisodeResult[],
    destinationOverrides?: Map<string, string[]>
  ) => {
    if (!toSubmit.length) return;

    const totalCalls = toSubmit.reduce(
      (sum, ep) => sum + (destinationOverrides?.get(resultKey(ep))?.length ?? activeDestinations.length),
      0
    );
    if (totalCalls === 0) { setErrorMessage('Select at least one destination to submit to.'); return; }

    setSubmitRunning(true); setSubmitDone(false);
    setSubmitResults([]); setSubmittedEpisodes(toSubmit);
    setSubmitProgress({ current: 0, total: totalCalls, percent: 0 });
    setErrorMessage(null);

    let poll: ReturnType<typeof setInterval> | null = null;
    try {
      const r = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          introdb_api_key: introbKey,
          skipdb_api_key: skipdbKey,
          destinations: activeDestinations,
          episodes: toSubmit.map(ep => ({
            imdb_id: ep.imdb_id, season: ep.season, episode: ep.episode,
            title: ep.title, start_ms: ep.start_ms, end_ms: ep.end_ms,
            duration_ms: ep.duration_ms,
            destinations: destinationOverrides?.get(resultKey(ep)),
          })),
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || 'Submit failed');

      const taskId = data.task_id;
      poll = setInterval(async () => {
        try {
          const res = await fetch(`/api/submit/results?task_id=${taskId}`);
          const d = await res.json();
          setSubmitProgress({ current: d.current, total: d.total, percent: d.percent });
          setSubmitResults(d.results);
          if (d.status === 'completed') {
            if (poll) clearInterval(poll);
            setSubmitRunning(false);
            setSubmitDone(true);
          }
        } catch { /* transient */ }
      }, 1000);
    } catch (e: any) {
      setSubmitRunning(false);
      setErrorMessage(e.message);
    }
  }, [introbKey, skipdbKey, activeDestinations]);

  const handleSubmit = useCallback(() => {
    const toSubmit = matchedResults.filter(r => selectedIds.has(resultKey(r)));
    runSubmit(toSubmit);
  }, [matchedResults, selectedIds, runSubmit]);

  // Retry only the destinations that actually failed for each episode — an episode that succeeded
  // on IntroDB but was rate-limited on SkipDB is resubmitted to SkipDB alone, not both again.
  const handleRetryFailed = useCallback(() => {
    const failedDestinationsByEp = new Map<string, Set<string>>();
    for (const r of submitResults) {
      if (r.status === 'submitted') continue;
      const matchKey = `${r.season}_${r.episode}_${r.title}`;
      if (!failedDestinationsByEp.has(matchKey)) failedDestinationsByEp.set(matchKey, new Set());
      failedDestinationsByEp.get(matchKey)!.add(r.destination);
    }

    const retryEpisodes: EpisodeResult[] = [];
    const overrides = new Map<string, string[]>();
    for (const ep of submittedEpisodes) {
      const dests = failedDestinationsByEp.get(`${ep.season}_${ep.episode}_${ep.title}`);
      if (dests && dests.size > 0) {
        retryEpisodes.push(ep);
        overrides.set(resultKey(ep), Array.from(dests));
      }
    }

    setSelectedIds(new Set(retryEpisodes.map(resultKey)));
    runSubmit(retryEpisodes, overrides);
  }, [submitResults, submittedEpisodes, runSubmit]);

  const handleReset = useCallback(() => {
    setScanStatus('idle'); setProgress({ current: 0, total: 0, percent: 0 });
    setLogs([]); setResults([]); setSelectedIds(new Set());
    setSubmitResults([]); setSubmittedEpisodes([]); setSubmitDone(false); setSubmitRunning(false);
    setErrorMessage(null);
  }, []);

  // --- Helpers ---

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'matched':  return <CheckCircle className="text-emerald-500 w-4 h-4" />;
      case 'skipped':  return <AlertCircle className="text-amber-500 w-4 h-4" />;
      case 'failed':   return <XCircle className="text-red-500 w-4 h-4" />;
      default:         return <Loader2 className="text-blue-500 animate-spin w-4 h-4" />;
    }
  };

  const renderLog = (msg: string) =>
    msg.includes('<') ? <span dangerouslySetInnerHTML={{ __html: msg }} /> : <span>{msg}</span>;

  const fmtTime = (d: Date | null) => d ? d.toLocaleTimeString() : 'Never';
  const fmtSE = (s: number, e: number) => `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`;

  const isScanning = scanStatus === 'running';
  const isDone = scanStatus === 'completed';
  const showSubmitSection = submitRunning || submitDone;

  // --- Render ---

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 text-slate-900 font-sans">
      <div className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white">
        <div className="max-w-5xl mx-auto px-4 py-8">
          <div className="flex items-center gap-3 mb-2">
            <Settings2 className="w-6 h-6" />
            <h1 className="text-2xl font-bold">🎬 Plex Intro Uploader</h1>
          </div>
          <p className="text-blue-100 text-sm">Scan your Plex library for intro markers, review results, then submit to IntroDB and/or SkipDB</p>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">

        {/* Backend status */}
        <div className="p-4 bg-white/80 backdrop-blur-sm border border-slate-200 rounded-xl shadow-sm flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-2.5 h-2.5 rounded-full ${backendConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
            <div>
              <h3 className="font-semibold text-slate-700">Backend {backendConnected ? 'Connected' : 'Disconnected'}</h3>
              <p className="text-xs text-slate-400">Last check: {fmtTime(lastCheck)}</p>
            </div>
          </div>
          <button onClick={checkBackend} className="p-1.5 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors">
            <RefreshCw className="w-3.5 h-3.5 text-slate-600" />
          </button>
        </div>

        {/* Configuration */}
        <div className="bg-white/80 backdrop-blur-sm rounded-xl shadow-sm border border-slate-200 p-6">
          <h2 className="text-lg font-semibold mb-5 flex items-center gap-2 text-slate-800">
            <Database className="text-blue-500 w-5 h-5" />Configuration
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <InputField label="Plex URL" value={plexUrl} onChange={setPlexUrl} placeholder="http://localhost:32400" icon={Globe} />
            <InputField label="Plex Token" value={plexToken} onChange={setPlexToken} placeholder="Your Plex API token" icon={Key}
              type="password" showToggle toggleState={showPlexToken} onToggle={() => setShowPlexToken(v => !v)} />
            <InputField label="TMDB API Key" value={tmdbKey} onChange={setTmdbKey} placeholder="tmdb_xxxxxxxxxxx" icon={Key}
              type="password" showToggle toggleState={showTmdbKey} onToggle={() => setShowTmdbKey(v => !v)} />
            <InputField label="IntroDB API Key" value={introbKey} onChange={setIntrobKey} placeholder="idb_..." icon={Key}
              type="password" showToggle toggleState={showIntrobKey} onToggle={() => setShowIntrobKey(v => !v)} />
            <InputField label="SkipDB API Key" value={skipdbKey} onChange={setSkipdbKey} placeholder="skdb_..." icon={Key}
              type="password" showToggle toggleState={showSkipdbKey} onToggle={() => setShowSkipdbKey(v => !v)} />
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-600 mb-1">Target Library</label>
              <select value={library} onChange={e => setLibrary(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 transition-all">
                <option value="">-- Select a library --</option>
                {libraries.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
          </div>
          <div className="mt-6 flex gap-3 flex-wrap">
            <button onClick={handleSaveConfig} disabled={configSaved === 'saving'}
              className={`px-4 py-2.5 font-medium rounded-lg flex items-center gap-2 transition-all border ${
                configSaved === 'saved'  ? 'bg-emerald-50 border-emerald-300 text-emerald-700' :
                configSaved === 'error'  ? 'bg-red-50 border-red-300 text-red-700' :
                'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
              } disabled:opacity-50 disabled:cursor-not-allowed`}>
              {configSaved === 'saving' ? <Loader2 className="animate-spin w-4 h-4" /> :
               configSaved === 'saved'  ? <CheckCircle className="w-4 h-4" /> :
               configSaved === 'error'  ? <AlertCircle className="w-4 h-4" /> :
               <Key className="w-4 h-4" />}
              {configSaved === 'saving' ? 'Saving…' :
               configSaved === 'saved'  ? 'Saved!' :
               configSaved === 'error'  ? 'Save failed' : 'Save keys'}
            </button>
            <button onClick={handleLoadLibraries} disabled={loadingLibraries || isScanning}
              className="px-4 py-2.5 bg-white border border-slate-300 text-slate-700 font-medium rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-all">
              {loadingLibraries ? <Loader2 className="animate-spin w-4 h-4" /> : <BookOpen className="w-4 h-4" />}
              {loadingLibraries ? 'Loading...' : 'Load Libraries'}
            </button>
            <button onClick={handleStartScan} disabled={!library || isScanning || loadingLibraries || !backendConnected}
              className="flex-1 px-4 py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all">
              {isScanning ? <Loader2 className="animate-spin w-4 h-4" /> : <Play className="w-4 h-4" />}
              {isScanning ? 'Scanning...' : 'Scan Library'}
            </button>
          </div>
          {errorMessage && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-600 rounded-lg flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span className="text-sm">{errorMessage}</span>
            </div>
          )}
        </div>

        {/* Scan log */}
        {(isScanning || logs.length > 0) && (
          <div className="bg-white/80 backdrop-blur-sm rounded-xl shadow-sm border border-slate-200 p-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2 text-slate-800">
              {isScanning ? <Loader2 className="text-blue-500 animate-spin w-5 h-5" /> : <CheckCircle className="text-green-500 w-5 h-5" />}
              Scan Progress
            </h2>
            {isScanning && (
              <div className="mb-4">
                <div className="w-full bg-slate-100 rounded-full h-2 mb-1.5">
                  <div className="bg-blue-600 h-2 rounded-full transition-all duration-300" style={{ width: `${Math.max(progress.percent, 0.5)}%` }} />
                </div>
                <div className="flex justify-between text-xs text-slate-400">
                  <span>{progress.current} / {progress.total} episodes</span>
                  <span>{Math.round(progress.percent)}%</span>
                </div>
              </div>
            )}
            <div ref={logRef} className="bg-slate-900 text-slate-100 rounded-lg p-4 h-64 overflow-y-auto font-mono text-xs space-y-1.5">
              {logs.length === 0
                ? <div className="text-slate-500 italic">Waiting…</div>
                : logs.map((log, i) => (
                  <div key={i} className="flex gap-2.5">
                    <div className="mt-0.5 min-w-[16px]">{getStatusIcon(log.status)}</div>
                    <div className="flex-1">{renderLog(log.message)}</div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Results */}
        {isDone && (
          <div className="bg-white/80 backdrop-blur-sm rounded-xl shadow-sm border border-slate-200 p-6">
            <h2 className="text-lg font-semibold mb-5 flex items-center gap-2 text-slate-800">
              <CheckCircle className="text-green-500 w-5 h-5" />Scan Results
            </h2>

            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
              {[
                { label: 'Scanned',    value: stats.total,         bg: 'bg-slate-50',  val: 'text-slate-700',   lbl: 'text-slate-500' },
                { label: 'Matched',    value: stats.matched,       bg: 'bg-emerald-50',val: 'text-emerald-600', lbl: 'text-emerald-500' },
                { label: 'Skipped',    value: stats.skipped,       bg: 'bg-amber-50',  val: 'text-amber-600',   lbl: 'text-amber-500' },
                { label: 'Failed',     value: stats.failed,        bg: 'bg-red-50',    val: 'text-red-600',     lbl: 'text-red-500' },
                { label: 'Already sent', value: stats.prevSubmitted, bg: 'bg-blue-50', val: 'text-blue-600',    lbl: 'text-blue-500' },
              ].map(({ label, value, bg, val, lbl }) => (
                <div key={label} className={`p-3 ${bg} rounded-xl text-center`}>
                  <div className={`text-2xl font-bold ${val}`}>{value}</div>
                  <div className={`text-xs ${lbl} mt-0.5`}>{label}</div>
                </div>
              ))}
            </div>

            {/* Grouped results table */}
            {matchedResults.length > 0 && (
              <>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm text-slate-600">
                    Select episodes to submit. Click a show or season header to collapse it.
                    <span className="ml-2 text-slate-400 text-xs">Intro times = seconds from start of episode.</span>
                  </p>
                  <span className="text-xs text-slate-400 shrink-0 ml-3">{selectedCount} of {matchedResults.length} selected</span>
                </div>

                <div className="border border-slate-200 rounded-lg overflow-hidden mb-4">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 border-b border-slate-200">
                      <tr>
                        <th className="py-3 px-3 w-10">
                          <IndeterminateCheckbox checked={allSelected} indeterminate={anySelected && !allSelected} onChange={toggleSelectAll} />
                        </th>
                        <th className="py-3 px-3 text-left font-medium text-slate-600">Show / Episode</th>
                        <th className="py-3 px-3 text-left font-medium text-slate-600 w-36">Intro (start → end)</th>
                        <th className="py-3 px-3 text-left font-medium text-slate-600 w-24 hidden md:table-cell">Sent before</th>
                        <th className="py-3 px-3 text-left font-medium text-slate-600 w-20 hidden md:table-cell">IMDB</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupedResults.map(({ show, seasons }) => {
                        const showCollapsed = collapsedShows.has(show);
                        const showEpCount = getShowEps(show).length;
                        const showSelCount = getShowEps(show).filter(r => selectedIds.has(resultKey(r))).length;
                        return (
                          <React.Fragment key={show}>
                            <tr className="bg-slate-100 border-y border-slate-200 cursor-pointer hover:bg-slate-200 transition-colors"
                              onClick={() => toggleCollapseShow(show)}>
                              <td className="py-2.5 px-3">
                                <IndeterminateCheckbox checked={isShowSel(show)} indeterminate={isShowPartial(show)} onChange={() => toggleShow(show)} />
                              </td>
                              <td className="py-2.5 px-3" colSpan={3}>
                                <div className="flex items-center gap-2">
                                  {showCollapsed ? <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" /> : <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />}
                                  <span className="font-semibold text-slate-800">{show}</span>
                                  <span className="text-xs text-slate-400">{showSelCount}/{showEpCount} selected</span>
                                </div>
                              </td>
                            </tr>
                            {!showCollapsed && seasons.map(({ season, episodes }) => {
                              const seasonKey = `${show}_S${season}`;
                              const seasonCollapsed = collapsedSeasons.has(seasonKey);
                              const seasonSelCount = getSeasonEps(show, season).filter(r => selectedIds.has(resultKey(r))).length;
                              return (
                                <React.Fragment key={seasonKey}>
                                  <tr className="bg-slate-50 border-b border-slate-100 cursor-pointer hover:bg-slate-100 transition-colors"
                                    onClick={() => toggleCollapseSeason(seasonKey)}>
                                    <td className="py-2 px-3 pl-8">
                                      <IndeterminateCheckbox checked={isSeasonSel(show, season)} indeterminate={isSeasonPartial(show, season)} onChange={() => toggleSeason(show, season)} />
                                    </td>
                                    <td className="py-2 px-3" colSpan={3}>
                                      <div className="flex items-center gap-2">
                                        {seasonCollapsed ? <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
                                        <span className="font-medium text-slate-600 text-xs uppercase tracking-wide">Season {season}</span>
                                        <span className="text-xs text-slate-400">{seasonSelCount}/{episodes.length} selected</span>
                                      </div>
                                    </td>
                                  </tr>
                                  {!seasonCollapsed && episodes.map(ep => {
                                    const key = resultKey(ep);
                                    const checked = selectedIds.has(key);
                                    return (
                                      <tr key={key} onClick={() => toggleEp(key)}
                                        className={`border-b border-slate-50 cursor-pointer transition-colors ${checked ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-slate-50'}`}>
                                        <td className="py-2 px-3 pl-12">
                                          <input type="checkbox" checked={checked} onChange={() => toggleEp(key)}
                                            onClick={e => e.stopPropagation()}
                                            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                                        </td>
                                        <td className="py-2 px-3">
                                          <span className="text-slate-400 font-mono text-xs mr-2">{fmtSE(ep.season, ep.episode)}</span>
                                          <span className="text-slate-800">{ep.title}</span>
                                        </td>
                                        <td className="py-2 px-3 text-slate-500 text-xs whitespace-nowrap">
                                          {ep.intro_start}s → {ep.intro_end}s
                                        </td>
                                        <td className="py-2 px-3 hidden md:table-cell space-x-1">
                                          {ep.previously_submitted_introdb && (
                                            <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-600">
                                              <CheckCircle className="w-3 h-3" />IntroDB
                                            </span>
                                          )}
                                          {ep.previously_submitted_skipdb && (
                                            <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-600">
                                              <CheckCircle className="w-3 h-3" />SkipDB
                                            </span>
                                          )}
                                        </td>
                                        <td className="py-2 px-3 text-slate-300 font-mono text-xs hidden md:table-cell">{ep.imdb_id}</td>
                                      </tr>
                                    );
                                  })}
                                </React.Fragment>
                              );
                            })}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center gap-4 mb-3 text-sm">
                  <span className="text-slate-500 font-medium">Submit to:</span>
                  <label className={`flex items-center gap-1.5 ${!introbKey ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
                    <input type="checkbox" checked={submitIntrodb && !!introbKey} disabled={!introbKey}
                      onChange={() => setSubmitIntrodb(v => !v)}
                      className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                    <span className="text-slate-700">IntroDB</span>
                  </label>
                  <label className={`flex items-center gap-1.5 ${!skipdbKey ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
                    <input type="checkbox" checked={submitSkipdb && !!skipdbKey} disabled={!skipdbKey}
                      onChange={() => setSubmitSkipdb(v => !v)}
                      className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                    <span className="text-slate-700">SkipDB</span>
                  </label>
                </div>

                <div className="flex gap-3">
                  <button onClick={handleSubmit} disabled={submitRunning || selectedCount === 0 || activeDestinations.length === 0}
                    className="flex-1 px-4 py-2.5 bg-emerald-600 text-white font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all">
                    <Upload className="w-4 h-4" />
                    Submit {selectedCount} Episode{selectedCount !== 1 ? 's' : ''}
                  </button>
                  <button onClick={handleReset}
                    className="px-4 py-2.5 bg-slate-100 text-slate-700 font-medium rounded-lg hover:bg-slate-200 flex items-center gap-2 transition-all">
                    <RefreshCw className="w-4 h-4" />New Scan
                  </button>
                </div>
              </>
            )}

            {matchedResults.length === 0 && (
              <div className="text-center py-8 text-slate-400">
                <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p>No intro markers found in this library.</p>
              </div>
            )}
          </div>
        )}

        {/* Submission progress + results */}
        {showSubmitSection && (
          <div className="bg-white/80 backdrop-blur-sm rounded-xl shadow-sm border border-slate-200 p-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2 text-slate-800">
              {submitRunning
                ? <><Loader2 className="text-blue-500 animate-spin w-5 h-5" />Submitting…</>
                : <><CheckCircle className="text-green-500 w-5 h-5" />Submission Complete</>}
            </h2>

            {/* Progress bar */}
            <div className="mb-4">
              <div className="w-full bg-slate-100 rounded-full h-2 mb-1.5">
                <div className="bg-emerald-500 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${Math.max(submitProgress.percent, submitRunning ? 0.5 : 0)}%` }} />
              </div>
              <div className="flex justify-between text-xs text-slate-400">
                <span>{submitProgress.current} / {submitProgress.total} episodes</span>
                <span>{Math.round(submitProgress.percent)}%</span>
              </div>
            </div>

            {/* Summary chips (shown when done) */}
            {submitDone && (
              <div className="flex flex-wrap gap-2 mb-4">
                {submittedCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-100 text-emerald-700 text-sm font-medium rounded-full">
                    <CheckCircle className="w-3.5 h-3.5" />{submittedCount} submitted
                  </span>
                )}
                {rejectedCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-red-100 text-red-700 text-sm font-medium rounded-full">
                    <XCircle className="w-3.5 h-3.5" />{rejectedCount} rejected
                  </span>
                )}
                {rateLimitedCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-100 text-amber-700 text-sm font-medium rounded-full">
                    <AlertTriangle className="w-3.5 h-3.5" />{rateLimitedCount} rate limited
                  </span>
                )}
                {submitErrorCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-slate-100 text-slate-600 text-sm font-medium rounded-full">
                    <XCircle className="w-3.5 h-3.5" />{submitErrorCount} errors
                  </span>
                )}
              </div>
            )}

            {/* Live results table */}
            {submitResults.length > 0 && (
              <div className="border border-slate-200 rounded-lg overflow-hidden mb-4">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-3 text-left font-medium text-slate-600">Episode</th>
                      <th className="py-2.5 px-3 text-left font-medium text-slate-600 w-24">Destination</th>
                      <th className="py-2.5 px-3 text-left font-medium text-slate-600 w-32">Status</th>
                      <th className="py-2.5 px-3 text-left font-medium text-slate-600 hidden md:table-cell">Detail</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {submitResults.map((r, i) => (
                      <tr key={i} className={
                        r.status === 'submitted'    ? 'bg-emerald-50' :
                        r.status === 'rate_limited' ? 'bg-amber-50' :
                        r.status === 'rejected'     ? 'bg-red-50' : ''
                      }>
                        <td className="py-2.5 px-3 font-medium text-slate-800">
                          {fmtSE(r.season, r.episode)} — {r.title}
                        </td>
                        <td className="py-2.5 px-3 text-slate-500 text-xs capitalize">{r.destination}</td>
                        <td className="py-2.5 px-3"><StatusChip status={r.status} /></td>
                        <td className="py-2.5 px-3 text-slate-500 text-xs hidden md:table-cell font-mono">{r.message}</td>
                      </tr>
                    ))}
                    {submitRunning && submitResults.length < submitProgress.total && (
                      <tr className="animate-pulse">
                        <td colSpan={4} className="py-2.5 px-3 text-slate-400 text-xs">
                          <Loader2 className="inline w-3.5 h-3.5 mr-1.5 animate-spin" />
                          Processing…
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {/* Action buttons */}
            {submitDone && (
              <div className="flex gap-3 flex-wrap">
                {failedSubmitCount > 0 && (
                  <button onClick={handleRetryFailed}
                    className="px-4 py-2.5 bg-amber-500 text-white font-medium rounded-lg hover:bg-amber-600 flex items-center gap-2 transition-all">
                    <RotateCcw className="w-4 h-4" />
                    Retry failed ({failedSubmitCount})
                  </button>
                )}
                <button onClick={handleReset}
                  className="px-4 py-2.5 bg-slate-100 text-slate-700 font-medium rounded-lg hover:bg-slate-200 flex items-center gap-2 transition-all">
                  <RefreshCw className="w-4 h-4" />New Scan
                </button>
              </div>
            )}
          </div>
        )}

        <footer className="text-center text-xs text-slate-400 pb-6">
          <p>Plex Intro Uploader — FastAPI · IntroDB · SkipDB</p>
          <p className="mt-1 space-x-2">
            <a href="https://introdb.app" className="hover:text-blue-500 transition-colors">IntroDB</a>
            <span>·</span>
            <a href="https://skipdb.tv" className="hover:text-blue-500 transition-colors">SkipDB</a>
            <span>·</span>
            <a href="https://www.plex.tv" className="hover:text-blue-500 transition-colors">Plex</a>
            <span>·</span>
            <a href="https://www.themoviedb.org" className="hover:text-blue-500 transition-colors">TMDB</a>
          </p>
        </footer>
      </div>
    </div>
  );
};

export default Index;
