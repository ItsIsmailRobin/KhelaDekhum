import { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";

const STREAM_TXT_URL = "/stream.txt";
const LOGO_URL = "/logo.png";
const VOLUME_STORAGE_KEY = "revtv-volume";

function getSavedVolume(): number | null {
  try {
    const saved = localStorage.getItem(VOLUME_STORAGE_KEY);
    if (saved === null) return null;
    const value = Number(saved);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
  } catch {
    return null;
  }
}

function saveVolume(value: number) {
  try { localStorage.setItem(VOLUME_STORAGE_KEY, String(Math.max(0, Math.min(1, value)))); } catch {}
}

function applyVolume(video: HTMLVideoElement, value: number) {
  video.volume = Math.max(0, Math.min(1, value));
  video.muted = video.volume === 0;
}

function getBufferedAhead(video: HTMLVideoElement) {
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) {
      return video.buffered.end(i) - video.currentTime;
    }
  }
  return 0;
}

function PlayIcon({ className = "h-9 w-9 text-white" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path
        d="M8.5 5.8v12.4c0 .8.9 1.28 1.58.85l9.28-6.2a1.02 1.02 0 0 0 0-1.7l-9.28-6.2C9.4 4.52 8.5 5 8.5 5.8Z"
      />
    </svg>
  );
}

function UnmuteIcon({ className = "h-9 w-9 text-white" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function PauseIcon({ className = "h-9 w-9 text-white" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="7" y="5" width="3.5" height="14" rx="1.2" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1.2" />
    </svg>
  );
}

function PlayerIconShell({
  children,
  persistent = false,
}: {
  children: React.ReactNode;
  persistent?: boolean;
}) {
  return (
    <div
      className={`grid h-20 w-20 place-items-center rounded-full bg-black/55 backdrop-blur-sm ${
        persistent ? "animate-unmute-pulse" : "animate-play-flash"
      }`}
    >
      <span className="grid h-9 w-9 place-items-center leading-none">
        {children}
      </span>
    </div>
  );
}

async function clearAllSiteData() {
  try { localStorage.clear(); } catch {}
  try { sessionStorage.clear(); } catch {}
  if ("caches" in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {}
  }
  try {
    document.cookie.split(";").forEach((c) => {
      document.cookie = c
        .replace(/^ +/, "")
        .replace(/=.*/, "=;expires=" + new Date(0).toUTCString() + ";path=/");
    });
  } catch {}
  try {
    document.cookie.split(";").forEach((c) => {
      const name = c.split("=")[0]?.trim();
      if (name) document.cookie = `${name}=;expires=${new Date(0).toUTCString()};path=/;SameSite=Lax`;
    });
  } catch {}
  try {
    if ("indexedDB" in window && "databases" in indexedDB) {
      const dbs = await (indexedDB as any).databases();
      await Promise.all(dbs.map((db) => db.name ? new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(db.name as string);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      }) : Promise.resolve()));
    }
  } catch {}
  window.location.reload();
}

function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}
function isTouch(): boolean {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const retryRef = useRef<number | null>(null);
  const hideRef = useRef<number | null>(null);
  const previousVolumeRef = useRef(getSavedVolume() ?? 1);
  const deadRef = useRef(false);
  const everRef = useRef(false);
  const restartCnt = useRef(0);
  const isPausedRef = useRef(false);

  const [status, setStatus] = useState<"loading" | "playing" | "error">("loading");
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [flashAnim, setFlashAnim] = useState<"play" | "pause" | null>(null);
  const [volume, setVolume] = useState(() => getSavedVolume() ?? 1);
  const [streamUrl, setStreamUrl] = useState("");
  const [needsUnmute, setNeedsUnmute] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const iosDevice = isIOS();
  const touchDev = isTouch();

  const snapToLive = useCallback(() => {
    const video = videoRef.current;
    const hls = hlsRef.current;
    if (!video) return;
    if (hls) {
      try {
        const lsp = hls.liveSyncPosition;
        if (lsp !== null && isFinite(lsp)) video.currentTime = lsp;
      } catch {}
    }
    if (!hls && video.seekable.length > 0) {
      video.currentTime = video.seekable.end(video.seekable.length - 1);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(STREAM_TXT_URL, { cache: "no-store" })
      .then((res) => res.text())
      .then((text) => {
        if (cancelled) return;
        const nextUrl = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        if (nextUrl) setStreamUrl(nextUrl);
        else setStatus("error");
      })
      .catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || needsUnmute) return;
    try { applyVolume(video, volume); } catch {}
  }, [volume, needsUnmute]);

  const attemptPlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || deadRef.current) return;
    const soundVolume = volume > 0 ? volume : previousVolumeRef.current || 1;
    if (needsUnmute) video.muted = true;
    else applyVolume(video, soundVolume);
    if (!video.paused) { setStatus("playing"); everRef.current = true; return; }
    video
      .play()
      .then(() => {
        if (deadRef.current) return;
        if (!needsUnmute) applyVolume(video, soundVolume);
        setStatus("playing");
        everRef.current = true;
      })
      .catch(() => {
        setTimeout(() => {
          if (deadRef.current || !videoRef.current) return;
          const v = videoRef.current;
          v.muted = true;
          v.play()
            .then(() => {
              setStatus("playing");
              everRef.current = true;
              setNeedsUnmute(true);
            })
            .catch(() => {
              setNeedsUnmute(true);
            });
        }, 200);
      });
  }, [needsUnmute, volume]);

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
    if (hlsRef.current) { try { hlsRef.current.destroy(); } catch {} hlsRef.current = null; }
  }, []);

  const initHlsEngine = useCallback(() => {
    const video = videoRef.current;
    if (!video || deadRef.current || !streamUrl) return;
    if (!Hls.isSupported()) { setStatus("error"); return; }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 6,
      maxBufferLength: 6,
      maxMaxBufferLength: 10,
      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 4,
      highBufferWatchdogPeriod: 1,
      nudgeMaxRetry: 5,
      manifestLoadingTimeOut: 12000,
      manifestLoadingMaxRetry: 999,
      manifestLoadingRetryDelay: 500,
      levelLoadingTimeOut: 12000,
      levelLoadingMaxRetry: 999,
      levelLoadingRetryDelay: 500,
      fragLoadingTimeOut: 15000,
      fragLoadingMaxRetry: 999,
      fragLoadingRetryDelay: 500,
      xhrSetup: (xhr) => { try { xhr.withCredentials = false; } catch {} },
    });

    hls.loadSource(streamUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      hls.currentLevel = -1;
      hls.loadLevel = -1;
      hls.autoLevelCapping = -1;
      snapToLive();
      attemptPlay();
    });
    hls.on(Hls.Events.LEVEL_LOADED, () => { if (video.paused && !isPausedRef.current) attemptPlay(); });
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      if (hls.levels.length > 0 && getBufferedAhead(video) >= 4) {
        hls.nextAutoLevel = hls.levels.length - 1;
      }
      if (video.paused && !isPausedRef.current) attemptPlay();
    });

    hls.on(Hls.Events.FRAG_CHANGED, () => {
      if (isPausedRef.current) return;
      try {
        const lsp = hls.liveSyncPosition;
        if (lsp !== null && isFinite(lsp) && video.currentTime < lsp - 8)
          video.currentTime = lsp;
      } catch {}
    });

    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        try { hls.recoverMediaError(); } catch { fullRestart(); }
      } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        try { hls.startLoad(-1); } catch {
          setTimeout(() => { try { hls.startLoad(-1); } catch { fullRestart(); } }, 1500);
        }
      } else { fullRestart(); }
    });

    hlsRef.current = hls;
  }, [attemptPlay, snapToLive, fullRestart, streamUrl]);

  const initPlayer = useCallback(() => {
    if (deadRef.current) return;
    const video = videoRef.current;
    if (!video || !streamUrl) return;
    if (!everRef.current) setStatus("loading");
    cleanup();

    if (needsUnmute) video.muted = true;
    else applyVolume(video, volume);

    const nativeHls = !!video.canPlayType("application/vnd.apple.mpegurl");
    if (nativeHls) {
      video.src = streamUrl;
      const onMeta = () => { cleanup2(); snapToLive(); attemptPlay(); };
      const onErr = () => { cleanup2(); initHlsEngine(); };
      const cleanup2 = () => {
        video.removeEventListener("loadedmetadata", onMeta);
        video.removeEventListener("error", onErr);
      };
      video.addEventListener("loadedmetadata", onMeta);
      video.addEventListener("error", onErr);
      return;
    }
    initHlsEngine();
  }, [cleanup, attemptPlay, snapToLive, initHlsEngine, streamUrl, needsUnmute, volume]);

  useEffect(() => {
    deadRef.current = false;
    if (videoRef.current) {
      if (needsUnmute) videoRef.current.muted = true;
      else applyVolume(videoRef.current, volume);
    }
    initPlayer();

    const onFsChange = () => {
      const fs =
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement;
      setIsFullscreen(!!fs);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);

    return () => {
      deadRef.current = true;
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      cleanup();
      if (hideRef.current) window.clearTimeout(hideRef.current);
    };
  }, [streamUrl]); // eslint-disable-line

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlaying = () => { setStatus("playing"); setIsPaused(false); isPausedRef.current = false; everRef.current = true; };
    const onPause = () => { setIsPaused(true); isPausedRef.current = true; };
    const onCanPlay = () => { if (video.paused && !isPausedRef.current) attemptPlay(); };
    const onVolChange = () => {
      if (needsUnmute) return;
      const nextVolume = video.muted ? 0 : video.volume;
      setVolume(nextVolume);
      if (nextVolume > 0) {
        previousVolumeRef.current = nextVolume;
        saveVolume(nextVolume);
      }
    };

    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("volumechange", onVolChange);

    return () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("volumechange", onVolChange);
    };
  }, [attemptPlay, needsUnmute]);

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
    window.addEventListener("mousemove", show);
    window.addEventListener("touchstart", show, { passive: true });
    show();
    return () => {
      window.removeEventListener("mousemove", show);
      window.removeEventListener("touchstart", show);
      if (hideRef.current) window.clearTimeout(hideRef.current);
    };
  }, [status]);

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    const video = videoRef.current;
    if (!el) return;
    const isFs = !!(
      document.fullscreenElement || (document as any).webkitFullscreenElement
    );
    try {
      if (!isFs) {
        if (iosDevice && video && (video as any).webkitEnterFullscreen) {
          (video as any).webkitEnterFullscreen();
          return;
        }
        if (el.requestFullscreen) await el.requestFullscreen();
        else if ((el as any).webkitRequestFullscreen) (el as any).webkitRequestFullscreen();
      } else {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if ((document as any).webkitExitFullscreen) (document as any).webkitExitFullscreen();
      }
    } catch {}
  }, [iosDevice]);

  const flashRef = useRef<number | null>(null);
  const showFlash = useCallback((type: "play" | "pause") => {
    setFlashAnim(type);
    if (flashRef.current) window.clearTimeout(flashRef.current);
    flashRef.current = window.setTimeout(() => setFlashAnim(null), 700);
  }, []);

  const unmutePlayer = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const nextVolume = previousVolumeRef.current || volume || 1;
    applyVolume(v, nextVolume);
    saveVolume(nextVolume);
    setVolume(nextVolume);
    setNeedsUnmute(false);
    setShowControls(true);
    v.play().then(() => {
      applyVolume(v, nextVolume);
      setStatus("playing");
      setIsPaused(false);
      isPausedRef.current = false;
      everRef.current = true;
    }).catch(() => {
      setNeedsUnmute(true);
    });
    showFlash("play");
  }, [showFlash, volume]);

  const handlePlayerTap = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (showClearConfirm) return;
    if (needsUnmute) {
      unmutePlayer();
      return;
    }
    if (v.paused) {
      snapToLive();
      applyVolume(v, volume);
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
  }, [needsUnmute, volume, snapToLive, showFlash, unmutePlayer, showClearConfirm]);

  const manualRestart = useCallback(() => {
    restartCnt.current = 0;
    everRef.current = false;
    isPausedRef.current = false;
    setIsPaused(false);
    initPlayer();
  }, [initPlayer]);

  const handleClearCache = useCallback(() => { setShowClearConfirm(true); }, []);
  const confirmClearCache = useCallback(() => { clearAllSiteData(); }, []);
  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.muted || volume === 0) {
      const nextVolume = previousVolumeRef.current || 1;
      applyVolume(v, nextVolume);
      saveVolume(nextVolume);
      setVolume(nextVolume);
      setNeedsUnmute(false);
    } else {
      previousVolumeRef.current = volume || previousVolumeRef.current || 1;
      v.muted = true;
      setVolume(0);
    }
  }, [volume]);
  const handleVolumeChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const next = Number(event.target.value) / 100;
    const v = videoRef.current;
    setVolume(next);
    if (next > 0) {
      previousVolumeRef.current = next;
      saveVolume(next);
    }
    setNeedsUnmute(false);
    if (v) applyVolume(v, next);
  }, []);

  const isInitialLoading = status === "loading" && !everRef.current;
  const shouldShowUnmuteOverlay = needsUnmute && status !== "error";
  const controlsVisible = touchDev || showControls || status !== "playing" || isPaused || needsUnmute || showClearConfirm;

  return (
    <div
      ref={containerRef}
      className="relative h-screen w-screen bg-black overflow-hidden select-none"
      style={{ height: "100dvh" }}
      onDoubleClick={toggleFullscreen}
    >
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-br from-black via-zinc-950 to-black" />
        <div className="absolute -top-32 -left-32 h-96 w-96 rounded-full bg-fuchsia-600/6 blur-3xl" />
        <div className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-indigo-600/6 blur-3xl" />
      </div>

      <div
        className={`absolute left-0 top-0 z-20 transition-opacity duration-500 ${
          controlsVisible ? "opacity-100" : "opacity-70"
        }`}
        style={{
          pointerEvents: "auto",
          paddingTop: "max(12px, env(safe-area-inset-top))",
          paddingLeft: "max(12px, env(safe-area-inset-left))",
        }}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
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
      </div>

      <div
        className="absolute right-0 top-0 z-20 transition-opacity duration-500 opacity-80"
        style={{
          pointerEvents: "auto",
          paddingTop: "max(12px, env(safe-area-inset-top))",
          paddingRight: "max(16px, env(safe-area-inset-right))",
        }}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <StatusBadge status={status} onClick={snapToLive} />
      </div>

      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-contain bg-black"
        playsInline
        autoPlay
        controls={false}
        onClick={handlePlayerTap}
        onWebkitBeginFullscreen={() => setIsFullscreen(true)}
        onWebkitEndFullscreen={() => setIsFullscreen(false)}
      />

      {flashAnim && (
        <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
          <div
            key={flashAnim + Date.now()}
          >
            {flashAnim === "play" ? (
              <PlayerIconShell><PlayIcon /></PlayerIconShell>
            ) : (
              <PlayerIconShell><PauseIcon /></PlayerIconShell>
            )}
          </div>
        </div>
      )}

      {isInitialLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="relative flex flex-col items-center gap-5">
            <div className="relative h-16 w-16">
              <div className="absolute inset-0 rounded-full border-[3px] border-white/10" />
              <div className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-white animate-spin" />
            </div>
            <p className="text-white font-semibold text-base tracking-wide">Connecting to Stream</p>
          </div>
        </div>
      )}

      {shouldShowUnmuteOverlay && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 backdrop-blur-md" onClick={unmutePlayer}>
          <div className="relative flex flex-col items-center gap-5">
            <button
              onClick={(event) => {
                event.stopPropagation();
                unmutePlayer();
              }}
              aria-label="Unmute"
              className="relative grid place-items-center"
            >
              <PlayerIconShell persistent><UnmuteIcon /></PlayerIconShell>
            </button>
            <p className="text-white font-semibold text-base tracking-wide">TAP TO UNMUTE</p>
          </div>
        </div>
      )}

      {showClearConfirm && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <div className="w-full max-w-sm rounded-2xl bg-black/80 border border-white/15 p-5 text-center shadow-2xl">
            <p className="text-white font-semibold text-base">Are you sure to clean cache and site data?</p>
            <div className="mt-5 flex items-center justify-center gap-3">
              <button
                onClick={() => setShowClearConfirm(false)}
                className="rounded-full bg-white/10 border border-white/10 px-5 py-2 text-sm font-semibold text-white transition-all duration-200 hover:bg-white/20 active:scale-95"
              >
                Cancel
              </button>
              <button
                onClick={confirmClearCache}
                className="rounded-full bg-[#f54266]/20 border border-[#f54266]/40 px-5 py-2 text-sm font-semibold text-white transition-all duration-200 hover:bg-[#f54266]/30 active:scale-95"
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      )}

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
              className="inline-flex items-center gap-2 rounded-full bg-white/10 border border-white/20 px-6 py-3 text-white font-semibold hover:bg-white/20 transition-all duration-200 hover:scale-105 active:scale-95"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              Retry
            </button>
          </div>
        </div>
      )}

      <div
        className={`absolute bottom-0 left-0 right-0 z-20 transition-opacity duration-300 ${
          controlsVisible ? "opacity-100" : "opacity-0"
        }`}
        style={{
          pointerEvents: controlsVisible ? "auto" : "none",
          paddingBottom: "max(10px, env(safe-area-inset-bottom))",
          paddingLeft: "max(10px, env(safe-area-inset-left))",
          paddingRight: "max(10px, env(safe-area-inset-right))",
          paddingTop: "6px",
        }}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <div className="absolute bottom-0 left-0 right-0 h-36 bg-gradient-to-t from-black/70 to-transparent pointer-events-none" />

        <div className="relative flex items-center justify-between gap-1.5 sm:gap-2 rounded-2xl bg-black/40 backdrop-blur-xl border border-white/10 px-1.5 sm:px-3 py-2">
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
            <ControlBtn onClick={manualRestart} aria-label="Reload" title="Reload stream" isTouch={touchDev}>
              <svg className="h-4 w-4 sm:h-5 sm:w-5 text-white transition-transform duration-500 group-hover:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </ControlBtn>

            <ControlBtn onClick={toggleMute} aria-label={volume === 0 ? "Unmute" : "Mute"} title={volume === 0 ? "Unmute" : "Mute"} isTouch={touchDev}>
              {volume === 0 ? (
                <svg className="h-4 w-4 sm:h-5 sm:w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              ) : (
                <svg className="h-4 w-4 sm:h-5 sm:w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              )}
            </ControlBtn>

            <div className="flex items-center flex-shrink min-w-[42px] w-12 sm:w-24 lg:w-28">
              <input
                aria-label="Volume"
                type="range"
                min="0"
                max="100"
                value={Math.round(volume * 100)}
                onChange={handleVolumeChange}
                className="h-1 w-full appearance-none rounded-full bg-white/25 accent-white"
                style={{
                  background: `linear-gradient(to right, white 0%, white ${Math.round(volume * 100)}%, rgba(255,255,255,.25) ${Math.round(volume * 100)}%, rgba(255,255,255,.25) 100%)`,
                }}
              />
            </div>

          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            <ControlBtn onClick={handleClearCache} aria-label="Clear cache & reload" title="Clear cache & reload" isTouch={touchDev}>
              <svg className="h-4 w-4 sm:h-5 sm:w-5" viewBox="0 0 24 24" fill="none" stroke="#f54266" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14H6L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
                <path d="M8 6l1-3h6l1 3" />
              </svg>
            </ControlBtn>

            <ControlBtn
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              isTouch={touchDev}
            >
              {isFullscreen ? (
                <svg className="h-4 w-4 sm:h-5 sm:w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                  <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                  <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                  <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                </svg>
              ) : (
                <svg className="h-4 w-4 sm:h-5 sm:w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                  <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                  <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                  <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                </svg>
              )}
            </ControlBtn>
          </div>
        </div>
      </div>
    </div>
  );
}

function ControlBtn({
  onClick, children, isTouch, ...rest
}: {
  onClick: () => void;
  children: React.ReactNode;
  isTouch: boolean;
  "aria-label"?: string;
  title?: string;
}) {
  return (
    <button
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      {...rest}
      className={`group grid h-9 w-9 sm:h-10 sm:w-10 flex-shrink-0 place-items-center rounded-full bg-white/10 border border-transparent transition-all duration-200 active:scale-90 active:bg-white/25 ${
        isTouch ? "" : "hover:bg-white/20 hover:scale-110 hover:border-white/15"
      }`}
    >
      {children}
    </button>
  );
}

function StatusBadge({ status, onClick }: { status: string; onClick: () => void }) {
  const cfg: Record<string, { label: string; dot: string; bg: string; text: string }> = {
    loading: { label: "Connecting", dot: "bg-amber-300 animate-pulse", bg: "bg-white/[0.04] border-white/[0.07]", text: "text-white/65" },
    playing: { label: "Live", dot: "bg-red-500 animate-pulse", bg: "bg-white/[0.04] border-white/[0.07]", text: "text-white/70" },
    error: { label: "Offline", dot: "bg-zinc-500", bg: "bg-white/[0.04] border-white/[0.07]", text: "text-white/65" },
  };
  const s = cfg[status] ?? cfg.loading;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Go live"
      className={`flex items-center gap-2 rounded-full border backdrop-blur-[2px] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] transition-all duration-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] hover:bg-white/[0.07] active:scale-95 ${s.bg} ${s.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      <span>{s.label}</span>
    </button>
  );
}
