import { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";

const STREAM_URL = "https://no.gendigi.net/origin-proxy/chunklist.m3u8";
const LOGO_URL =
  "https://raw.githubusercontent.com/ItsIsmailRobin/revtvFINAL/refs/heads/main/Logo.png";

// ─── Constants ────────────────────────────────────────────────────────────────
const VIEWERS_KEY   = "claprr_viewers_v2";   // shared cross-tab viewer registry
const HEARTBEAT_MS  = 800;                    // how often each tab pulses
const STALE_MS      = 2500;                   // tab considered gone after this
const BC_CHANNEL    = "claprr_bc";

// ─── Force 100% volume — always, no mute ─────────────────────────────────────
function forceVolume(video: HTMLVideoElement) {
  video.volume = 1;
  video.muted  = false;
}

// ─── Cross-tab real-time viewer count ────────────────────────────────────────
// Uses localStorage for cross-domain/cross-tab counting with instant updates
// via the "storage" event AND BroadcastChannel for same-origin same-tab speed.
function useLiveViewerCount(): number {
  const [count, setCount] = useState(1);
  const myIdRef = useRef(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  useEffect(() => {
    const myId = myIdRef.current;

    // ── localStorage registry ──
    const readRegistry = (): Record<string, number> => {
      try {
        const raw = localStorage.getItem(VIEWERS_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch { return {}; }
    };

    const writeRegistry = (reg: Record<string, number>) => {
      try { localStorage.setItem(VIEWERS_KEY, JSON.stringify(reg)); } catch {}
    };

    const pruneAndCount = (): number => {
      const now = Date.now();
      const reg = readRegistry();
      let changed = false;
      for (const k of Object.keys(reg)) {
        if (now - reg[k] > STALE_MS) { delete reg[k]; changed = true; }
      }
      if (changed) writeRegistry(reg);
      return Math.max(1, Object.keys(reg).length);
    };

    const heartbeat = () => {
      const reg = readRegistry();
      reg[myId] = Date.now();
      writeRegistry(reg);
      setCount(pruneAndCount());
    };

    const remove = () => {
      const reg = readRegistry();
      delete reg[myId];
      writeRegistry(reg);
    };

    // ── BroadcastChannel for instant same-origin updates ──
    let bc: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      bc = new BroadcastChannel(BC_CHANNEL);
      bc.onmessage = () => setCount(pruneAndCount());
    }

    const notifyPeers = () => { try { bc?.postMessage("ping"); } catch {} };

    // Join immediately
    heartbeat();
    notifyPeers();

    // Pulse
    const timer = window.setInterval(() => {
      heartbeat();
      notifyPeers();
    }, HEARTBEAT_MS);

    // React to other tabs changing localStorage
    const onStorage = (e: StorageEvent) => {
      if (e.key === VIEWERS_KEY) setCount(pruneAndCount());
    };
    window.addEventListener("storage", onStorage);

    // Leave
    const onLeave = () => { remove(); notifyPeers(); };
    window.addEventListener("beforeunload", onLeave);
    window.addEventListener("pagehide",     onLeave);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") onLeave();
      else heartbeat();
    });

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("beforeunload", onLeave);
      window.removeEventListener("pagehide",     onLeave);
      onLeave();
      try { bc?.close(); } catch {}
    };
  }, []);

  return count;
}

// ─── Platform helpers ──────────────────────────────────────────────────────
function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}
function isTouch(): boolean {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

// ─── Main component ────────────────────────────────────────────────────────
export default function App() {
  const videoRef     = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef       = useRef<Hls | null>(null);
  const retryRef     = useRef<number | null>(null);
  const hideRef      = useRef<number | null>(null);
  const deadRef      = useRef(false);
  const everRef      = useRef(false);
  const restartCnt   = useRef(0);
  const isPausedRef  = useRef(false);

  const [status,        setStatus]        = useState<"loading"|"playing"|"buffering"|"error">("loading");
  const [showControls,  setShowControls]  = useState(true);
  const [isFullscreen,  setIsFullscreen]  = useState(false);
  // Volume UI — always 100%, never muted
  const [volume]       = useState(1);
  const muted          = false;
  const effectiveVol   = 1;
  const [isPaused,      setIsPaused]      = useState(false);
  const [flashAnim,     setFlashAnim]     = useState<"play"|"pause"|null>(null);

  const iosDevice = isIOS();
  const touchDev  = isTouch();
  const viewers   = useLiveViewerCount();

  // ── Snap to live edge ─────────────────────────────────────────────────
  const snapToLive = useCallback(() => {
    const video = videoRef.current;
    const hls   = hlsRef.current;
    if (!video) return;
    // For HLS.js: seek to live sync position
    if (hls) {
      try {
        const liveSyncPos = hls.liveSyncPosition;
        if (liveSyncPos !== null && isFinite(liveSyncPos)) {
          video.currentTime = liveSyncPos;
        }
      } catch {}
    }
    // For native HLS (Safari): seek to end of seekable range
    if (!hls && video.seekable.length > 0) {
      video.currentTime = video.seekable.end(video.seekable.length - 1);
    }
  }, []);

  // ── Play with forced volume ────────────────────────────────────────────
  const attemptPlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || deadRef.current) return;
    forceVolume(video);
    if (!video.paused) { setStatus("playing"); everRef.current = true; return; }
    video.play()
      .then(() => {
        if (deadRef.current) return;
        forceVolume(video);
        setStatus("playing");
        everRef.current = true;
      })
      .catch(() => {
        // Browser blocked autoplay even with volume — mute as last resort then unmute
        setTimeout(() => {
          if (deadRef.current || !videoRef.current) return;
          const v = videoRef.current;
          v.muted = true;
          v.play().then(() => {
            // Unmute after play starts (user interaction required on some browsers)
            setTimeout(() => { try { v.muted = false; v.volume = 1; } catch {} }, 300);
            setStatus("playing");
            everRef.current = true;
          }).catch(() => {});
        }, 200);
      });
  }, []);

  // ── HLS engine ───────────────────────────────────────────────────────
  const fullRestart = useCallback(() => {
    if (deadRef.current) return;
    if (restartCnt.current >= 20) { setStatus("error"); return; }
    restartCnt.current++;
    if (retryRef.current) window.clearTimeout(retryRef.current);
    retryRef.current = window.setTimeout(() => {
      if (!deadRef.current) initPlayer(); // eslint-disable-line
    }, 2500);
  }, []); // eslint-disable-line

  const cleanup = useCallback(() => {
    if (retryRef.current) { window.clearTimeout(retryRef.current); retryRef.current = null; }
    if (hlsRef.current)   { try { hlsRef.current.destroy(); } catch {} hlsRef.current = null; }
  }, []);

  const initHlsEngine = useCallback(() => {
    const video = videoRef.current;
    if (!video || deadRef.current) return;
    if (!Hls.isSupported()) { setStatus("error"); return; }

    const hls = new Hls({
      enableWorker:         true,
      lowLatencyMode:       true,
      // Ultra-low buffer — stay glued to live edge
      backBufferLength:         8,
      maxBufferLength:          8,
      maxMaxBufferLength:      12,
      liveSyncDurationCount:    2,
      liveMaxLatencyDurationCount: 4,
      // Aggressive stall recovery
      highBufferWatchdogPeriod: 1,
      nudgeMaxRetry:            5,
      // Network retries
      manifestLoadingTimeOut:  12000,
      manifestLoadingMaxRetry: 999,
      manifestLoadingRetryDelay: 500,
      levelLoadingTimeOut:     12000,
      levelLoadingMaxRetry:    999,
      levelLoadingRetryDelay:  500,
      fragLoadingTimeOut:      15000,
      fragLoadingMaxRetry:     999,
      fragLoadingRetryDelay:   500,
      xhrSetup: (xhr) => { try { xhr.withCredentials = false; } catch {} },
    });

    hls.loadSource(STREAM_URL);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => { snapToLive(); attemptPlay(); });
    hls.on(Hls.Events.LEVEL_LOADED,    () => { if (video.paused && !isPausedRef.current) attemptPlay(); });
    hls.on(Hls.Events.FRAG_BUFFERED,   () => { if (video.paused && !isPausedRef.current) attemptPlay(); });

    // Drift correction — if we fall behind live edge, snap back
    hls.on(Hls.Events.FRAG_CHANGED, () => {
      if (isPausedRef.current) return;
      try {
        const lsp = hls.liveSyncPosition;
        if (lsp !== null && isFinite(lsp) && video.currentTime < lsp - 8) {
          video.currentTime = lsp;
        }
      } catch {}
    });

    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        try { hls.recoverMediaError(); } catch { fullRestart(); }
      } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        try { hls.startLoad(-1); } catch { setTimeout(() => { try { hls.startLoad(-1); } catch { fullRestart(); } }, 1500); }
      } else { fullRestart(); }
    });

    hlsRef.current = hls;
  }, [attemptPlay, snapToLive, fullRestart]);

  const initPlayer = useCallback(() => {
    if (deadRef.current) return;
    const video = videoRef.current;
    if (!video) return;
    if (!everRef.current) setStatus("loading");
    cleanup();

    const nativeHls = !!video.canPlayType("application/vnd.apple.mpegurl");
    if (nativeHls) {
      video.src = STREAM_URL;
      forceVolume(video);
      const onMeta  = () => { cleanup2(); snapToLive(); attemptPlay(); };
      const onErr   = () => { cleanup2(); initHlsEngine(); };
      const cleanup2 = () => {
        video.removeEventListener("loadedmetadata", onMeta);
        video.removeEventListener("error", onErr);
      };
      video.addEventListener("loadedmetadata", onMeta);
      video.addEventListener("error", onErr);
      return;
    }
    initHlsEngine();
  }, [cleanup, attemptPlay, snapToLive, initHlsEngine]);

  // ── Mount ─────────────────────────────────────────────────────────────
  useEffect(() => {
    deadRef.current = false;
    initPlayer();

    const onFsChange = () => {
      const fs = document.fullscreenElement || (document as any).webkitFullscreenElement;
      setIsFullscreen(!!fs);
    };
    document.addEventListener("fullscreenchange",       onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);

    return () => {
      deadRef.current = true;
      document.removeEventListener("fullscreenchange",       onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      cleanup();
      if (hideRef.current) window.clearTimeout(hideRef.current);
    };
  }, []); // eslint-disable-line

  // ── Video events ──────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlaying     = () => { setStatus("playing");  setIsPaused(false); isPausedRef.current = false; everRef.current = true; };
    const onPause       = () => { setIsPaused(true);     isPausedRef.current = true; };
    const onWaiting     = () => { if (everRef.current) setStatus("buffering"); };
    const onCanPlay     = () => { if (video.paused && !isPausedRef.current) attemptPlay(); };
    // Always force 100% volume if something changes it
    const onVolChange   = () => { if (!isPausedRef.current) forceVolume(video); };

    video.addEventListener("playing",       onPlaying);
    video.addEventListener("pause",         onPause);
    video.addEventListener("waiting",       onWaiting);
    video.addEventListener("canplay",       onCanPlay);
    video.addEventListener("volumechange",  onVolChange);

    return () => {
      video.removeEventListener("playing",      onPlaying);
      video.removeEventListener("pause",        onPause);
      video.removeEventListener("waiting",      onWaiting);
      video.removeEventListener("canplay",      onCanPlay);
      video.removeEventListener("volumechange", onVolChange);
    };
  }, [attemptPlay]);

  // ── Auto-hide controls ────────────────────────────────────────────────
  useEffect(() => {
    const show = () => {
      setShowControls(true);
      if (hideRef.current) window.clearTimeout(hideRef.current);
      if (!isPausedRef.current) {
        hideRef.current = window.setTimeout(() => {
          if (!isPausedRef.current) setShowControls(false);
        }, 3000);
      }
    };
    window.addEventListener("mousemove",  show);
    window.addEventListener("touchstart", show, { passive: true });
    show();
    return () => {
      window.removeEventListener("mousemove",  show);
      window.removeEventListener("touchstart", show);
      if (hideRef.current) window.clearTimeout(hideRef.current);
    };
  }, [status]);

  // ── Fullscreen ────────────────────────────────────────────────────────
  const toggleFullscreen = useCallback(async () => {
    const el    = containerRef.current;
    const video = videoRef.current;
    if (!el) return;
    const isFs = !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
    try {
      if (!isFs) {
        if (iosDevice && video && (video as any).webkitEnterFullscreen) {
          (video as any).webkitEnterFullscreen(); return;
        }
        if      (el.requestFullscreen)               await el.requestFullscreen();
        else if ((el as any).webkitRequestFullscreen) (el as any).webkitRequestFullscreen();
      } else {
        if      (document.exitFullscreen)               await document.exitFullscreen();
        else if ((document as any).webkitExitFullscreen) (document as any).webkitExitFullscreen();
      }
    } catch {}
  }, [iosDevice]);

  // ── Play/Pause toggle — snap to live on resume ────────────────────────
  const flashRef = useRef<number | null>(null);
  const showFlash = useCallback((type: "play"|"pause") => {
    setFlashAnim(type);
    if (flashRef.current) window.clearTimeout(flashRef.current);
    flashRef.current = window.setTimeout(() => setFlashAnim(null), 700);
  }, []);

  const handlePlayerTap = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (touchDev && !showControls) { setShowControls(true); return; }
    if (v.paused) {
      snapToLive();
      forceVolume(v);
      v.play().catch(() => {});
      showFlash("play");
      setIsPaused(false);
      isPausedRef.current = false;
    } else {
      v.pause();
      showFlash("pause");
      setIsPaused(true);
      isPausedRef.current = true;
      setShowControls(true);
      if (hideRef.current) window.clearTimeout(hideRef.current);
    }
  }, [touchDev, showControls, snapToLive, showFlash]);

  const manualRestart = useCallback(() => {
    restartCnt.current = 0;
    everRef.current = false;
    isPausedRef.current = false;
    setIsPaused(false);
    initPlayer();
  }, [initPlayer]);

  const isInitialLoading = status === "loading" && !everRef.current;
  const isBuffering      = status === "buffering" && !isInitialLoading;
  const controlsVisible  = showControls || status !== "playing" || isPaused;

  return (
    <div
      ref={containerRef}
      className="relative h-screen w-screen bg-black overflow-hidden select-none"
      onDoubleClick={toggleFullscreen}
    >
      {/* Background */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-br from-black via-zinc-950 to-black" />
        <div className="absolute -top-32 -left-32 h-96 w-96 rounded-full bg-fuchsia-600/6 blur-3xl" />
        <div className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-indigo-600/6 blur-3xl" />
      </div>

      {/* ── Header ── */}
      <div
        className={`absolute top-0 left-0 right-0 z-20 flex items-center justify-between p-3 sm:p-5 transition-opacity duration-500 ${controlsVisible ? "opacity-100" : "opacity-0"}`}
        style={{ pointerEvents: controlsVisible ? "auto" : "none" }}
      >
        <button
          onClick={() => window.location.reload()}
          aria-label="Reload site"
          className="group focus:outline-none"
        >
          <img
            src={LOGO_URL}
            alt="Channel logo"
            draggable={false}
            className="h-10 sm:h-12 md:h-14 w-auto max-w-[140px] sm:max-w-[180px] object-contain rounded-xl transition-transform duration-300 group-hover:scale-[1.04] group-active:scale-95"
          />
        </button>
        <StatusBadge status={status} viewers={viewers} />
      </div>

      {/* ── Video ── */}
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-contain bg-black"
        playsInline
        autoPlay
        muted={false}
        controls={false}
        onClick={handlePlayerTap}
        onWebkitBeginFullscreen={() => setIsFullscreen(true)}
        onWebkitEndFullscreen={() => setIsFullscreen(false)}
      />

      {/* ── Play/Pause flash ── */}
      {flashAnim && (
        <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
          <div key={flashAnim + Date.now()} className="flex h-20 w-20 items-center justify-center rounded-full bg-black/50 backdrop-blur-sm animate-play-flash">
            {flashAnim === "play"
              ? <svg className="h-9 w-9 text-white ml-1" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              : <svg className="h-9 w-9 text-white" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
            }
          </div>
        </div>
      )}

      {/* ── Initial loading ── */}
      {isInitialLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-5">
            <div className="relative h-16 w-16">
              <div className="absolute inset-0 rounded-full border-[3px] border-white/10"/>
              <div className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-white animate-spin"/>
            </div>
            <div className="flex flex-col items-center gap-2">
              <p className="text-white font-semibold text-base tracking-wide">Connecting to stream</p>
              <div className="flex gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-white/60 animate-bounce [animation-delay:0ms]"/>
                <span className="h-1.5 w-1.5 rounded-full bg-white/60 animate-bounce [animation-delay:150ms]"/>
                <span className="h-1.5 w-1.5 rounded-full bg-white/60 animate-bounce [animation-delay:300ms]"/>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Buffering ── */}
      {isBuffering && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-black/50 backdrop-blur-md px-6 py-4 border border-white/10">
            <div className="relative h-9 w-9">
              <div className="absolute inset-0 rounded-full border-[3px] border-white/10"/>
              <div className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-white animate-spin"/>
            </div>
            <p className="text-white/80 text-sm font-medium">Buffering…</p>
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {status === "error" && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/85 backdrop-blur-sm">
          <div className="text-center space-y-4 max-w-sm px-6">
            <div className="mx-auto h-16 w-16 rounded-full bg-red-500/20 flex items-center justify-center">
              <svg className="h-8 w-8 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <h2 className="text-white text-2xl font-bold">Stream Unavailable</h2>
            <p className="text-zinc-400 text-sm">Could not connect to the live stream.</p>
            <button onClick={manualRestart} className="inline-flex items-center gap-2 rounded-full bg-white/10 border border-white/20 px-6 py-3 text-white font-semibold hover:bg-white/20 transition-all duration-200 hover:scale-105 active:scale-95">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
              Retry
            </button>
          </div>
        </div>
      )}

      {/* ── Bottom controls ── */}
      <div
        className={`absolute bottom-0 left-0 right-0 z-20 p-3 sm:p-5 transition-opacity duration-300 ${controlsVisible ? "opacity-100" : "opacity-0"}`}
        style={{ pointerEvents: controlsVisible ? "auto" : "none" }}
      >
        <div className="absolute bottom-0 left-0 right-0 h-36 bg-gradient-to-t from-black/70 to-transparent pointer-events-none"/>
        <div className="relative flex items-center justify-between gap-3 rounded-2xl bg-black/40 backdrop-blur-xl border border-white/10 px-3 sm:px-4 py-2.5">
          <div className="flex items-center gap-2 sm:gap-3">

            {/* Reload */}
            <ControlBtn onClick={manualRestart} aria-label="Reload" title="Reload stream" isTouch={touchDev}>
              <svg className="h-5 w-5 text-white transition-transform duration-500 group-hover:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
            </ControlBtn>

            {/* Volume — always 100%, shown as static full icon (no mute toggle) */}
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10">
              <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
              </svg>
            </div>

            {/* Volume bar — decorative, always full */}
            <div className="hidden sm:flex items-center">
              <div className="h-1 w-24 lg:w-28 rounded-full bg-white"/>
            </div>

            {/* LIVE */}
            <div className="flex items-center gap-1.5 ml-1">
              <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse"/>
              <span className="text-white text-xs sm:text-sm font-bold tracking-widest">LIVE</span>
            </div>

            {/* Viewers */}
            <div className="flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold text-white/90">
              <svg className="h-3.5 w-3.5 text-white/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
              <span className="tabular-nums">{viewers.toLocaleString()}</span>
            </div>
          </div>

          {/* Fullscreen */}
          <ControlBtn onClick={toggleFullscreen} aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"} title={isFullscreen ? "Exit fullscreen" : "Fullscreen"} isTouch={touchDev}>
            {isFullscreen
              ? <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>
              : <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
            }
          </ControlBtn>
        </div>
      </div>
    </div>
  );
}

// ── ControlBtn ────────────────────────────────────────────────────────────
function ControlBtn({ onClick, children, isTouch, ...rest }: {
  onClick: () => void; children: React.ReactNode; isTouch: boolean;
  "aria-label"?: string; title?: string;
}) {
  return (
    <button
      onClick={onClick}
      {...rest}
      className={`group flex h-10 w-10 items-center justify-center rounded-full bg-white/10 border border-transparent transition-all duration-200 active:scale-90 active:bg-white/25 ${isTouch ? "" : "hover:bg-white/20 hover:scale-110 hover:border-white/15"}`}
    >
      {children}
    </button>
  );
}

// ── StatusBadge ───────────────────────────────────────────────────────────
function StatusBadge({ status, viewers }: { status: string; viewers: number }) {
  const cfg: Record<string, { label: string; dot: string; bg: string; text: string }> = {
    loading:   { label: "Connecting", dot: "bg-amber-400 animate-pulse", bg: "bg-amber-500/10 border-amber-500/20", text: "text-amber-300" },
    buffering: { label: "Buffering",  dot: "bg-blue-400 animate-pulse",  bg: "bg-blue-500/10 border-blue-500/20",   text: "text-blue-300"  },
    playing:   { label: "Live",       dot: "bg-red-500 animate-pulse",   bg: "bg-red-500/10 border-red-500/25",     text: "text-red-300"   },
    error:     { label: "Offline",    dot: "bg-zinc-500",                 bg: "bg-zinc-500/10 border-zinc-500/20",   text: "text-zinc-300"  },
  };
  const s = cfg[status] ?? cfg.loading;
  return (
    <div className={`flex items-center gap-2 rounded-full border backdrop-blur-md px-3 py-1.5 text-xs font-semibold transition-all duration-500 ${s.bg} ${s.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`}/>
      <span>{s.label}</span>
      <span className="opacity-60 tabular-nums">· {viewers}</span>
    </div>
  );
}
