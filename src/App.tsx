import { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";

const STREAM_URL = "https://no.gendigi.net/origin-proxy/chunklist.m3u8";
const LOGO_URL = "https://raw.githubusercontent.com/ItsIsmailRobin/revtvFINAL/refs/heads/main/Logo.png";
const CHANNEL_NAME = "claprr-viewers";
const VOLUME_STORAGE_KEY = "claprr_volume";
const MUTED_STORAGE_KEY = "claprr_muted";

// ── Volume persistence helpers ─────────────────────────────────────────────
function getSavedVolume(): number {
  try {
    const v = localStorage.getItem(VOLUME_STORAGE_KEY);
    const m = localStorage.getItem(MUTED_STORAGE_KEY);
    if (m === "true") return 0; // was muted last time
    const parsed = parseFloat(v ?? "");
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  } catch {}
  return 0.8; // sensible default (unmuted)
}
function saveVolume(vol: number, muted: boolean) {
  try {
    localStorage.setItem(VOLUME_STORAGE_KEY, String(vol));
    localStorage.setItem(MUTED_STORAGE_KEY, muted ? "true" : "false");
  } catch {}
}

// ── Live viewer count (BroadcastChannel + localStorage fallback) ──────────
function useLiveViewerCount() {
  const [count, setCount] = useState(1);

  useEffect(() => {
    const hasBC = typeof BroadcastChannel !== "undefined";

    if (hasBC) {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      const peers = new Set<string>();
      const myId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      channel.postMessage({ type: "hello", id: myId });

      channel.onmessage = (e) => {
        const msg = e.data || {};
        if (msg.type === "hello") {
          channel.postMessage({ type: "peer", id: myId });
        } else if (msg.type === "peer" && msg.id && msg.id !== myId) {
          peers.add(msg.id);
          setCount(peers.size + 1);
        } else if (msg.type === "bye" && msg.id) {
          peers.delete(msg.id);
          setCount(peers.size + 1);
        } else if (msg.type === "ping") {
          channel.postMessage({ type: "pong", id: myId });
        } else if (msg.type === "pong" && msg.id && msg.id !== myId) {
          peers.add(msg.id);
          setCount(peers.size + 1);
        }
      };

      const ping = window.setInterval(() => {
        channel.postMessage({ type: "ping", id: myId });
        // Prune peers that haven't responded recently - handled by pong being sent on ping
      }, 2000);

      const onUnload = () => {
        try { channel.postMessage({ type: "bye", id: myId }); } catch {}
      };
      window.addEventListener("beforeunload", onUnload);
      window.addEventListener("pagehide", onUnload);

      const t = window.setTimeout(() => setCount(peers.size + 1), 600);

      return () => {
        window.clearInterval(ping);
        window.clearTimeout(t);
        window.removeEventListener("beforeunload", onUnload);
        window.removeEventListener("pagehide", onUnload);
        onUnload();
        channel.close();
      };
    }

    // ── localStorage fallback ──
    const TAB_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const STORAGE_KEY = "claprr_active_tabs";

    const getActive = (): Record<string, number> => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        const now = Date.now();
        for (const k of Object.keys(parsed)) {
          if (now - parsed[k] > 10000) delete parsed[k];
        }
        return parsed;
      } catch { return {}; }
    };

    const updateCount = () => {
      const active = getActive();
      active[TAB_ID] = Date.now();
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(active)); } catch {}
      setCount(Object.keys(active).length || 1);
    };

    updateCount();
    const beat = window.setInterval(updateCount, 2000);
    const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY) updateCount(); };
    window.addEventListener("storage", onStorage);

    const onUnload = () => {
      try {
        const active = getActive();
        delete active[TAB_ID];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(active));
      } catch {}
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("pagehide", onUnload);

    return () => {
      window.clearInterval(beat);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("pagehide", onUnload);
      onUnload();
    };
  }, []);

  return count;
}

// ── Detect iOS ────────────────────────────────────────────────────────────
function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

// ── Detect touch device ───────────────────────────────────────────────────
function isTouchDevice(): boolean {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const fullRestartCountRef = useRef(0);
  const isUnmountedRef = useRef(false);
  const everPlayedRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);
  const clickTimerRef = useRef<number | null>(null);

  // ── Saved volume/mute from localStorage ──
  const savedVol = getSavedVolume();
  const savedMuted = (() => {
    try { return localStorage.getItem(MUTED_STORAGE_KEY) === "true"; } catch { return false; }
  })();

  const [status, setStatus] = useState<"loading" | "playing" | "buffering" | "error">("loading");
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [muted, setMuted] = useState(savedMuted || savedVol === 0);
  const [volume, setVolume] = useState(savedVol > 0 ? savedVol : 0.8);
  const [isPaused, setIsPaused] = useState(false);
  const [showPlayPauseAnim, setShowPlayPauseAnim] = useState<"play" | "pause" | null>(null);

  const isTouch = isTouchDevice();
  const isIOSDevice = isIOS();

  const viewers = useLiveViewerCount();

  const MAX_FULL_RESTARTS = 8;
  const FULL_RESTART_DELAY = 3000;

  const detectNativeHls = () => {
    const v = document.createElement("video");
    return !!v.canPlayType("application/vnd.apple.mpegurl");
  };

  const showPlayPauseFlash = useCallback((type: "play" | "pause") => {
    setShowPlayPauseAnim(type);
    setTimeout(() => setShowPlayPauseAnim(null), 700);
  }, []);

  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      if (!isPaused) setShowControls(false);
    }, 3000);
  }, [isPaused]);

  const attemptPlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || isUnmountedRef.current) return;

    // Restore saved volume
    const vol = savedVol > 0 ? savedVol : 0.8;
    const shouldMute = savedMuted || savedVol === 0;
    video.volume = vol;
    video.muted = shouldMute;

    if (!video.paused) {
      setStatus("playing");
      setIsPaused(false);
      everPlayedRef.current = true;
      return;
    }
    const p = video.play();
    if (p && typeof p.then === "function") {
      p.then(() => {
        if (isUnmountedRef.current) return;
        setStatus("playing");
        setIsPaused(false);
        everPlayedRef.current = true;
      }).catch(() => {
        setTimeout(() => {
          if (isUnmountedRef.current || !videoRef.current) return;
          videoRef.current.muted = true;
          setMuted(true);
          videoRef.current.play()
            .then(() => { setStatus("playing"); everPlayedRef.current = true; })
            .catch(() => {});
        }, 250);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fullRestart = useCallback(() => {
    if (isUnmountedRef.current) return;
    if (fullRestartCountRef.current >= MAX_FULL_RESTARTS) {
      setStatus("error");
      return;
    }
    fullRestartCountRef.current += 1;
    setStatus("buffering");
    if (retryTimerRef.current) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = window.setTimeout(() => {
      if (!isUnmountedRef.current) initPlayer();
    }, FULL_RESTART_DELAY);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cleanup = useCallback(() => {
    if (retryTimerRef.current) { window.clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    if (hlsRef.current) { try { hlsRef.current.destroy(); } catch {} hlsRef.current = null; }
  }, []);

  const initHlsEngine = useCallback(() => {
    const video = videoRef.current;
    if (!video || isUnmountedRef.current) return;
    if (!Hls.isSupported()) { setStatus("error"); return; }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 30,
      maxBufferLength: 15,
      maxMaxBufferLength: 30,
      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 8,
      manifestLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: 99,
      manifestLoadingRetryDelay: 1000,
      levelLoadingTimeOut: 20000,
      levelLoadingMaxRetry: 99,
      levelLoadingRetryDelay: 1000,
      fragLoadingTimeOut: 25000,
      fragLoadingMaxRetry: 99,
      fragLoadingRetryDelay: 1000,
      xhrSetup: (xhr) => { try { xhr.withCredentials = false; } catch {} },
    });

    hls.loadSource(STREAM_URL);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => attemptPlay());
    hls.on(Hls.Events.LEVEL_LOADED, () => { if (video.paused) attemptPlay(); });
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      if (video.paused && !isPaused) attemptPlay();
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      switch (data.type) {
        case Hls.ErrorTypes.MEDIA_ERROR:
          try { hls.recoverMediaError(); } catch { fullRestart(); }
          break;
        case Hls.ErrorTypes.NETWORK_ERROR:
          try { hls.startLoad(-1); } catch {
            setTimeout(() => { try { hls.startLoad(-1); } catch { fullRestart(); } }, 2000);
          }
          break;
        default: fullRestart(); break;
      }
    });

    hlsRef.current = hls;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptPlay, fullRestart, isPaused]);

  const initPlayer = useCallback(() => {
    if (isUnmountedRef.current) return;
    const video = videoRef.current;
    if (!video) return;
    if (!everPlayedRef.current) setStatus("loading");
    cleanup();

    if (detectNativeHls()) {
      video.src = STREAM_URL;
      const onLoaded = () => {
        video.removeEventListener("loadedmetadata", onLoaded);
        video.removeEventListener("error", onError);
        attemptPlay();
      };
      const onError = () => {
        video.removeEventListener("loadedmetadata", onLoaded);
        video.removeEventListener("error", onError);
        initHlsEngine();
      };
      video.addEventListener("loadedmetadata", onLoaded);
      video.addEventListener("error", onError);
      return;
    }
    initHlsEngine();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanup, attemptPlay, initHlsEngine]);

  // ── Mount ──────────────────────────────────────────────────────────────
  useEffect(() => {
    isUnmountedRef.current = false;
    initPlayer();

    // Fullscreen change listeners (including webkit for iOS)
    const onFsChange = () => {
      const fsEl =
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement;
      setIsFullscreen(!!fsEl);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    document.addEventListener("mozfullscreenchange", onFsChange);

    return () => {
      isUnmountedRef.current = true;
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      document.removeEventListener("mozfullscreenchange", onFsChange);
      cleanup();
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Video event listeners ──────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlaying = () => {
      setStatus("playing");
      setIsPaused(false);
      everPlayedRef.current = true;
    };
    const onPause = () => setIsPaused(true);
    const onWaiting = () => { if (everPlayedRef.current) setStatus("buffering"); };
    const onCanPlay = () => { if (video.paused && !isPaused) attemptPlay(); };
    const onVolumeChange = () => {
      setMuted(video.muted);
      setVolume(video.volume);
      saveVolume(video.volume, video.muted);
    };

    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("volumechange", onVolumeChange);

    return () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("volumechange", onVolumeChange);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptPlay]);

  // ── Auto-hide controls ─────────────────────────────────────────────────
  useEffect(() => {
    const resetHide = () => {
      setShowControls(true);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      if (!isPaused) {
        hideTimerRef.current = window.setTimeout(() => {
          if (status === "playing" && !isPaused) setShowControls(false);
        }, 3000);
      }
    };
    window.addEventListener("mousemove", resetHide);
    window.addEventListener("touchstart", resetHide, { passive: true });
    resetHide();
    return () => {
      window.removeEventListener("mousemove", resetHide);
      window.removeEventListener("touchstart", resetHide);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [status, isPaused]);

  // ── Fullscreen (cross-platform including iOS) ──────────────────────────
  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    const video = videoRef.current;
    if (!el) return;

    try {
      const isFs =
        !!document.fullscreenElement ||
        !!(document as any).webkitFullscreenElement;

      if (!isFs) {
        // iOS Safari: fullscreen is only supported on the video element itself
        if (isIOSDevice && video) {
          if ((video as any).webkitEnterFullscreen) {
            (video as any).webkitEnterFullscreen();
            return;
          }
        }
        // Standard + webkit
        if (el.requestFullscreen) {
          await el.requestFullscreen();
        } else if ((el as any).webkitRequestFullscreen) {
          (el as any).webkitRequestFullscreen();
        } else if ((el as any).mozRequestFullScreen) {
          (el as any).mozRequestFullScreen();
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if ((document as any).webkitExitFullscreen) {
          (document as any).webkitExitFullscreen();
        } else if ((document as any).mozCancelFullScreen) {
          (document as any).mozCancelFullScreen();
        }
      }
    } catch {}
  }, [isIOSDevice]);

  // ── Volume ─────────────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const nextMuted = !v.muted;
    v.muted = nextMuted;
    if (!nextMuted && v.volume === 0) {
      v.volume = 0.5;
      setVolume(0.5);
    }
    setMuted(nextMuted);
    saveVolume(v.volume, nextMuted);
  }, []);

  const handleVolumeChange = useCallback((val: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = val;
    setVolume(val);
    const shouldMute = val === 0;
    if (shouldMute !== v.muted) v.muted = shouldMute;
    setMuted(shouldMute);
    saveVolume(val, shouldMute);
  }, []);

  // ── Play/Pause toggle (YouTube-style tap) ──────────────────────────────
  const handlePlayerTap = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;

    // On touch devices, first tap shows controls; second tap toggles play
    if (isTouch && !showControls) {
      resetHideTimer();
      return;
    }

    if (v.paused) {
      v.play().catch(() => {});
      showPlayPauseFlash("play");
      setIsPaused(false);
    } else {
      v.pause();
      showPlayPauseFlash("pause");
      setIsPaused(true);
      setShowControls(true);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    }
  }, [isTouch, showControls, resetHideTimer, showPlayPauseFlash]);

  // Double-tap fullscreen
  const handleDoubleClick = useCallback(() => {
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      toggleFullscreen();
    }
  }, [toggleFullscreen]);

  const manualRestart = useCallback(() => {
    fullRestartCountRef.current = 0;
    everPlayedRef.current = false;
    setIsPaused(false);
    initPlayer();
  }, [initPlayer]);

  const handleLogoClick = useCallback(() => {
    window.location.reload();
  }, []);

  const isInitialLoading = status === "loading" && !everPlayedRef.current;
  const isBuffering = status === "buffering";
  const effectiveVolume = muted ? 0 : volume;

  // Controls should always show on iOS in fullscreen (we handle this separately)
  const controlsVisible = showControls || status !== "playing" || isPaused;

  return (
    <div
      ref={containerRef}
      className="relative h-screen w-screen bg-black overflow-hidden select-none"
      onDoubleClick={handleDoubleClick}
    >
      {/* Background gradients */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-br from-black via-zinc-950 to-black" />
        <div className="absolute -top-32 -left-32 h-96 w-96 rounded-full bg-fuchsia-600/8 blur-3xl" />
        <div className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-indigo-600/8 blur-3xl" />
      </div>

      {/* ── Header ── */}
      <div
        className={`absolute top-0 left-0 right-0 z-20 flex items-center justify-between p-3 sm:p-5 transition-opacity duration-500 pointer-events-none ${
          controlsVisible ? "opacity-100" : "opacity-0"
        }`}
        style={{ pointerEvents: controlsVisible ? "auto" : "none" }}
      >
        {/* Logo — no outline, no glow animation, subtle hover scale only */}
        <button
          onClick={handleLogoClick}
          aria-label="Reload site"
          title="Click to reload"
          className="group relative focus:outline-none"
        >
          <img
            src={LOGO_URL}
            alt="Channel logo"
            draggable={false}
            className="
              relative h-10 sm:h-12 md:h-14
              w-auto max-w-[140px] sm:max-w-[180px] md:max-w-[220px]
              object-contain rounded-xl
              transition-transform duration-300 ease-out
              group-hover:scale-[1.04]
              group-active:scale-95
            "
          />
        </button>

        {/* Status badge — top right, clean + blurred */}
        <div className="flex items-center gap-2">
          <StatusBadge status={status} viewers={viewers} />
        </div>
      </div>

      {/* ── Video element ── */}
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-contain bg-black"
        playsInline
        autoPlay
        muted={muted}
        controls={false}
        onClick={handlePlayerTap}
        // iOS fullscreen events
        onWebkitBeginFullscreen={() => setIsFullscreen(true)}
        onWebkitEndFullscreen={() => setIsFullscreen(false)}
      />

      {/* ── Play/Pause animated flash (YouTube-style) ── */}
      {showPlayPauseAnim && (
        <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
          <div
            key={showPlayPauseAnim}
            className="flex h-20 w-20 items-center justify-center rounded-full bg-black/50 backdrop-blur-sm animate-play-flash"
          >
            {showPlayPauseAnim === "play" ? (
              <svg className="h-9 w-9 text-white ml-1" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            ) : (
              <svg className="h-9 w-9 text-white" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            )}
          </div>
        </div>
      )}

      {/* ── Initial loading ── */}
      {isInitialLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-5">
            {/* Spinner */}
            <div className="relative h-16 w-16">
              <div className="absolute inset-0 rounded-full border-[3px] border-white/10" />
              <div className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-white animate-spin" />
            </div>
            <div className="flex flex-col items-center gap-1">
              <p className="text-white font-semibold text-base tracking-wide">Connecting to stream</p>
              <div className="flex gap-1 mt-1">
                <span className="h-1.5 w-1.5 rounded-full bg-white/60 animate-bounce [animation-delay:0ms]" />
                <span className="h-1.5 w-1.5 rounded-full bg-white/60 animate-bounce [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 rounded-full bg-white/60 animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Buffering ── */}
      {isBuffering && !isInitialLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-black/50 backdrop-blur-md px-6 py-4 border border-white/10">
            <div className="relative h-9 w-9">
              <div className="absolute inset-0 rounded-full border-[3px] border-white/10" />
              <div className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-white animate-spin" />
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
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h2 className="text-white text-2xl font-bold">Stream Unavailable</h2>
            <p className="text-zinc-400 text-sm">Could not connect to the live stream.</p>
            <button
              onClick={manualRestart}
              className="mt-2 inline-flex items-center gap-2 rounded-full bg-white/10 border border-white/20 px-6 py-3 text-white font-semibold hover:bg-white/20 transition-all duration-200 hover:scale-105 active:scale-95"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              Retry
            </button>
          </div>
        </div>
      )}

      {/* ── Bottom controls ── */}
      <div
        className={`absolute bottom-0 left-0 right-0 z-20 p-3 sm:p-5 transition-opacity duration-300 ${
          controlsVisible ? "opacity-100" : "opacity-0"
        }`}
        style={{ pointerEvents: controlsVisible ? "auto" : "none" }}
      >
        {/* Gradient fade from bottom */}
        <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-black/70 to-transparent pointer-events-none" />

        <div className="relative flex items-center justify-between gap-3 rounded-2xl bg-black/40 backdrop-blur-xl border border-white/10 px-3 sm:px-4 py-2.5">
          <div className="flex items-center gap-2 sm:gap-3">

            {/* Reload */}
            <ControlBtn
              onClick={manualRestart}
              aria-label="Reload stream"
              title="Reload stream"
              isTouch={isTouch}
            >
              <svg
                className="h-5 w-5 text-white transition-transform duration-500 group-hover:rotate-180"
                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
              >
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </ControlBtn>

            {/* Mute toggle */}
            <ControlBtn
              onClick={toggleMute}
              aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
              title={muted || volume === 0 ? "Unmute" : "Mute"}
              isTouch={isTouch}
            >
              {muted || effectiveVolume === 0 ? (
                <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              ) : effectiveVolume < 0.5 ? (
                <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              ) : (
                <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              )}
            </ControlBtn>

            {/* Volume slider (hidden on mobile) */}
            <div className="hidden sm:flex items-center">
              <input
                type="range" min={0} max={1} step={0.01}
                value={effectiveVolume}
                onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                className="volume-slider h-1 w-24 lg:w-28 cursor-pointer appearance-none rounded-full outline-none"
                aria-label="Volume"
                style={{
                  background: `linear-gradient(to right, #ffffff 0%, #ffffff ${effectiveVolume * 100}%, rgba(255,255,255,0.2) ${effectiveVolume * 100}%, rgba(255,255,255,0.2) 100%)`,
                }}
              />
            </div>

            {/* LIVE badge */}
            <div className="flex items-center gap-1.5 ml-1">
              <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-white text-xs sm:text-sm font-bold tracking-widest">LIVE</span>
            </div>

            {/* Viewers */}
            <div className="flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold text-white/90">
              <svg className="h-3.5 w-3.5 text-white/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <span>{viewers.toLocaleString()}</span>
            </div>
          </div>

          {/* Fullscreen */}
          <ControlBtn
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            isTouch={isTouch}
          >
            {isFullscreen ? (
              <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                <path d="M3 16h3a2 2 0 0 1 2 2v3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" />
              </svg>
            ) : (
              <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                <path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
            )}
          </ControlBtn>
        </div>
      </div>
    </div>
  );
}

// ── ControlBtn ─────────────────────────────────────────────────────────────
// On desktop: hover + scale animations. On touch: no hover animation, just works.
function ControlBtn({
  onClick,
  children,
  isTouch,
  ...rest
}: {
  onClick: () => void;
  children: React.ReactNode;
  isTouch: boolean;
  "aria-label"?: string;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      {...rest}
      className={`group flex h-10 w-10 items-center justify-center rounded-full bg-white/10 border border-white/0 transition-all duration-200 active:scale-90 active:bg-white/25 ${
        isTouch
          ? "" // no hover on touch
          : "hover:bg-white/20 hover:scale-110 hover:border-white/15"
      }`}
    >
      {children}
    </button>
  );
}

// ── StatusBadge ────────────────────────────────────────────────────────────
function StatusBadge({ status, viewers }: { status: string; viewers: number }) {
  const map: Record<string, { label: string; dotClass: string; bgClass: string; textClass: string }> = {
    loading: {
      label: "Connecting",
      dotClass: "bg-amber-400",
      bgClass: "bg-amber-500/10 border-amber-500/20",
      textClass: "text-amber-300",
    },
    buffering: {
      label: "Buffering",
      dotClass: "bg-blue-400",
      bgClass: "bg-blue-500/10 border-blue-500/20",
      textClass: "text-blue-300",
    },
    playing: {
      label: "Live",
      dotClass: "bg-red-500",
      bgClass: "bg-red-500/10 border-red-500/25",
      textClass: "text-red-300",
    },
    error: {
      label: "Offline",
      dotClass: "bg-zinc-500",
      bgClass: "bg-zinc-500/10 border-zinc-500/20",
      textClass: "text-zinc-300",
    },
  };
  const s = map[status] ?? map.loading;

  return (
    <div
      className={`flex items-center gap-2 rounded-full border backdrop-blur-md px-3 py-1.5 text-xs font-semibold transition-all duration-500 ${s.bgClass} ${s.textClass}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${s.dotClass} ${
          status === "playing" || status === "loading" || status === "buffering"
            ? "animate-pulse"
            : ""
        }`}
      />
      <span>{s.label}</span>
      {/* Viewer count inline on mobile where bottom bar hides it */}
      <span className="sm:hidden opacity-70">· {viewers}</span>
    </div>
  );
}
