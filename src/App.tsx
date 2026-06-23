import {
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import Hls from "hls.js";
import { cn } from "./utils/cn";

// ── Constants ─────────────────────────────────────────────────────────────────
const VOLUME_KEY = "kd_volume";      // always 1 forced
const MUTED_KEY  = "kd_muted";       // persisted mute state
const HIDE_DELAY = 3500;             // ms before controls hide

// ── Helpers ───────────────────────────────────────────────────────────────────
const isTouchDevice = () =>
  typeof window !== "undefined" &&
  ("ontouchstart" in window || navigator.maxTouchPoints > 0);

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const videoRef   = useRef<HTMLVideoElement>(null);
  const hlsRef     = useRef<Hls | null>(null);
  const wrapRef    = useRef<HTMLDivElement>(null);
  const hideTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── State ──────────────────────────────────────────────────────────────────
  const [streamUrl, setStreamUrl]         = useState<string>("");
  const [logoUrl, setLogoUrl]             = useState<string>("");
  const [status, setStatus]               = useState<"loading"|"playing"|"error">("loading");
  const [muted, setMuted]                 = useState<boolean>(() => {
    // On first visit → start muted (browser policy), remember after
    const saved = localStorage.getItem(MUTED_KEY);
    return saved === null ? true : saved === "true";
  });
  const [isFirstVisit, setIsFirstVisit]   = useState<boolean>(() => {
    return localStorage.getItem(MUTED_KEY) === null;
  });
  const [isFullscreen, setIsFullscreen]   = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [flashIcon, setFlashIcon]         = useState<"play"|"pause"|null>(null);
  const [touchDev]                        = useState(isTouchDevice);

  // ── Fetch stream URL from public/stream.txt ────────────────────────────────
  useEffect(() => {
    fetch("/stream.txt")
      .then(r => r.text())
      .then(t => setStreamUrl(t.trim()))
      .catch(() => setStreamUrl(""));
  }, []);

  // ── Logo: try /logo.png, fall back to SVG inline ───────────────────────────
  useEffect(() => {
    const img = new Image();
    img.onload  = () => setLogoUrl("/logo.png");
    img.onerror = () => setLogoUrl("");   // empty = use inline SVG
    img.src = "/logo.png";
  }, []);

  // ── Volume: always force 100% ──────────────────────────────────────────────
  // Volume is always 1.0 — mute state is separate
  const applyVolume = useCallback((vid: HTMLVideoElement) => {
    vid.volume = 1;
    vid.muted  = muted;
    localStorage.setItem(VOLUME_KEY, "1");
  }, [muted]);

  // ── HLS Setup ─────────────────────────────────────────────────────────────
  const setupHls = useCallback((url: string) => {
    const vid = videoRef.current;
    if (!vid || !url) return;

    // Cleanup previous
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    setStatus("loading");

    const onCanPlay = () => {
      applyVolume(vid);
      vid.play().catch(() => {
        // Autoplay blocked — stay muted and try again
        vid.muted = true;
        vid.play().catch(() => {});
      });
    };

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 30,
      });
      hlsRef.current = hls;
      hls.loadSource(url);
      hls.attachMedia(vid);
      hls.on(Hls.Events.MANIFEST_PARSED, onCanPlay);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) setStatus("error");
      });
    } else if (vid.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS
      vid.src = url;
      vid.addEventListener("loadedmetadata", onCanPlay, { once: true });
    } else {
      setStatus("error");
    }
  }, [applyVolume]);

  useEffect(() => {
    if (streamUrl) setupHls(streamUrl);
    return () => {
      hlsRef.current?.destroy();
    };
  }, [streamUrl, setupHls]);

  // ── Video event listeners ─────────────────────────────────────────────────
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;

    const onPlaying  = () => { setStatus("playing"); applyVolume(vid); };
    const onWaiting  = () => setStatus("loading");
    const onError    = () => setStatus("error");
    const onVolChange = () => {
      // Immediately snap volume back to 1 if something tries to change it
      if (vid.volume !== 1) vid.volume = 1;
    };

    vid.addEventListener("playing",     onPlaying);
    vid.addEventListener("waiting",     onWaiting);
    vid.addEventListener("error",       onError);
    vid.addEventListener("volumechange", onVolChange);

    return () => {
      vid.removeEventListener("playing",      onPlaying);
      vid.removeEventListener("waiting",      onWaiting);
      vid.removeEventListener("error",        onError);
      vid.removeEventListener("volumechange", onVolChange);
    };
  }, [applyVolume]);

  // ── Fullscreen listeners ──────────────────────────────────────────────────
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // ── Controls auto-hide ────────────────────────────────────────────────────
  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), HIDE_DELAY);
  }, []);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  useEffect(() => {
    scheduleHide();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [scheduleHide]);

  // ── Tap / click on video area ──────────────────────────────────────────────
  const handleVideoTap = useCallback(() => {
    const vid = videoRef.current;
    if (!vid) return;

    if (isFirstVisit || muted) {
      // Unmute
      const newMuted = false;
      setMuted(newMuted);
      setIsFirstVisit(false);
      localStorage.setItem(MUTED_KEY, "false");
      vid.muted = false;
      vid.volume = 1;
      if (vid.paused) vid.play().catch(() => {});
      showControls();
      return;
    }

    // Toggle play/pause with flash icon
    if (vid.paused) {
      vid.play().catch(() => {});
      setFlashIcon("play");
    } else {
      vid.pause();
      setFlashIcon("pause");
    }
    showControls();

    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashIcon(null), 700);
  }, [isFirstVisit, muted, showControls]);

  // ── Mute toggle ────────────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const newMuted = !muted;
    setMuted(newMuted);
    setIsFirstVisit(false);
    localStorage.setItem(MUTED_KEY, String(newMuted));
    vid.muted  = newMuted;
    vid.volume = 1;
    showControls();
  }, [muted, showControls]);

  // ── Manual restart (reload icon) ───────────────────────────────────────────
  const manualRestart = useCallback(() => {
    if (streamUrl) setupHls(streamUrl);
    showControls();
  }, [streamUrl, setupHls, showControls]);

  // ── Clear cache & reload (recycle-bin icon) ────────────────────────────────
  const handleClearCache = useCallback(async () => {
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } catch (_) {}
    window.location.reload();
  }, []);

  // ── Fullscreen ────────────────────────────────────────────────────────────
  const toggleFullscreen = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
    showControls();
  }, [showControls]);

  // ── Pointer events for controls visibility ────────────────────────────────
  const onPointerMove = useCallback(() => showControls(), [showControls]);

  // ── Tap-to-unmute overlay: show on first visit or while muted ─────────────
  const showUnmuteOverlay = muted || isFirstVisit;

  return (
    <div
      ref={wrapRef}
      className="relative w-full h-full bg-black overflow-hidden select-none"
      onPointerMove={onPointerMove}
      onPointerDown={onPointerMove}
      style={{ touchAction: "none" }}
    >
      {/* ── Video element ── */}
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-contain"
        playsInline
        autoPlay
        muted={muted}
        preload="auto"
        onContextMenu={e => e.preventDefault()}
      />

      {/* ── Loading spinner ── */}
      {status === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
        </div>
      )}

      {/* ── Offline / error ── */}
      {status === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-10 gap-3 pointer-events-none">
          <svg className="w-14 h-14 text-white/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <p className="text-white/50 text-sm font-medium">Stream offline</p>
        </div>
      )}

      {/* ── Tap-to-unmute / blur overlay ── */}
      {showUnmuteOverlay && (
        <div
          className="absolute inset-0 z-20 flex flex-col items-center justify-center cursor-pointer"
          onClick={handleVideoTap}
          style={{ backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", background: "rgba(0,0,0,0.45)" }}
        >
          {/* Play/Unmute icon with pulse animation */}
          <div className="flex flex-col items-center gap-4 animate-play-flash" style={{ animation: "none", opacity: 1, transform: "none" }}>
            <div
              className="w-20 h-20 rounded-full flex items-center justify-center"
              style={{ background: "rgba(255,255,255,0.15)", border: "2px solid rgba(255,255,255,0.4)" }}
            >
              {/* Play triangle icon — same as the play/pause flash icon */}
              <svg className="w-10 h-10 text-white ml-1" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            </div>
            <span className="text-white/90 text-sm font-semibold tracking-wide">
              {isFirstVisit ? "Tap to Play" : "Tap to Unmute"}
            </span>
          </div>
        </div>
      )}

      {/* ── Play/Pause flash icon ── */}
      {flashIcon && !showUnmuteOverlay && (
        <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
          <div className="w-20 h-20 rounded-full flex items-center justify-center animate-play-flash"
            style={{ background: "rgba(0,0,0,0.45)", border: "2px solid rgba(255,255,255,0.35)" }}>
            {flashIcon === "play" ? (
              <svg className="w-10 h-10 text-white ml-1" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            ) : (
              <svg className="w-8 h-8 text-white" viewBox="0 0 24 24" fill="currentColor">
                <rect x="5" y="3" width="4" height="18" rx="1" />
                <rect x="15" y="3" width="4" height="18" rx="1" />
              </svg>
            )}
          </div>
        </div>
      )}

      {/* ── Tap zone (when overlay not shown) ── */}
      {!showUnmuteOverlay && (
        <div
          className="absolute inset-0 z-10"
          onClick={handleVideoTap}
          style={{ WebkitTapHighlightColor: "transparent" }}
        />
      )}

      {/* ── Controls bar ── */}
      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 z-30 transition-opacity duration-300",
          controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        style={{ pointerEvents: controlsVisible ? "auto" : "none" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Gradient fade */}
        <div className="absolute bottom-0 left-0 right-0 h-40 bg-gradient-to-t from-black/80 to-transparent pointer-events-none" />

        <div className="controls-bar relative flex items-center justify-between gap-2 w-full">

          {/* ── Left group ── */}
          <div className="flex items-center gap-2 min-w-0 flex-shrink-0">

            {/* Reload icon */}
            <ControlBtn onClick={manualRestart} aria-label="Reload stream" title="Reload stream" isTouch={touchDev}>
              <svg className="h-5 w-5 text-white transition-transform duration-500 group-hover:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </ControlBtn>

            {/* Volume button + slider */}
            <VolumeControl
              muted={muted}
              onToggleMute={toggleMute}
              isTouch={touchDev}
            />

            {/* LIVE badge */}
            <LiveBadge status={status} />

          </div>

          {/* ── Center: Logo ── */}
          <div className="flex-1 flex items-center justify-center min-w-0">
            {logoUrl ? (
              <img src={logoUrl} alt="KhelaDekhum" className="h-7 sm:h-8 max-w-[120px] object-contain drop-shadow-lg" />
            ) : (
              <InlineLogo />
            )}
          </div>

          {/* ── Right group ── */}
          <div className="flex items-center gap-2 flex-shrink-0">

            {/* 🗑 Recycle-bin / Clear cache */}
            <ControlBtn onClick={handleClearCache} aria-label="Clear cache & reload" title="Clear cache & reload" isTouch={touchDev}>
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="#f54266" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                {/* Recycle bin icon */}
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            </ControlBtn>

            {/* Fullscreen */}
            <ControlBtn onClick={toggleFullscreen} aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"} title={isFullscreen ? "Exit fullscreen" : "Fullscreen"} isTouch={touchDev}>
              {isFullscreen ? (
                <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                  <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                  <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                  <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                </svg>
              ) : (
                <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
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

// ── VolumeControl ─────────────────────────────────────────────────────────────
// Volume is ALWAYS 100% — slider is decorative/locked at 100.
// Button toggles mute only.
function VolumeControl({
  muted,
  onToggleMute,
  isTouch,
}: {
  muted: boolean;
  onToggleMute: () => void;
  isTouch: boolean;
}) {
  // slider always at 100
  const vol = 100;

  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      <ControlBtn onClick={onToggleMute} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"} isTouch={isTouch}>
        {muted ? (
          /* Muted icon */
          <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <line x1="23" y1="9" x2="17" y2="15" />
            <line x1="17" y1="9" x2="23" y2="15" />
          </svg>
        ) : (
          /* Unmuted/Volume-high icon */
          <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          </svg>
        )}
      </ControlBtn>

      {/* Volume bar — desktop only, always at 100%, not interactive */}
      <div className="hidden md:flex items-center w-20">
        <input
          type="range"
          className="volume-slider w-full"
          min={0}
          max={100}
          value={vol}
          readOnly
          onChange={() => {/* locked at 100 */}}
          style={{ "--vol": `${vol}%` } as React.CSSProperties}
          aria-label="Volume (locked at 100%)"
        />
      </div>
    </div>
  );
}

// ── LiveBadge ─────────────────────────────────────────────────────────────────
function LiveBadge({ status }: { status: string }) {
  const cfg: Record<string, { label: string; dot: string; bg: string; text: string }> = {
    loading: { label: "Connecting", dot: "bg-amber-400 animate-pulse", bg: "bg-amber-500/20 border border-amber-500/30", text: "text-amber-300" },
    playing: { label: "LIVE",       dot: "bg-red-500 animate-pulse",   bg: "bg-red-500/20 border border-red-500/30",     text: "text-red-300"   },
    error:   { label: "Offline",    dot: "bg-zinc-500",                 bg: "bg-zinc-500/20 border border-zinc-500/30",   text: "text-zinc-300"  },
  };
  const s = cfg[status] ?? cfg.loading;
  return (
    <span className={cn("flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold tracking-wider flex-shrink-0", s.bg, s.text)}>
      <span className={cn("h-1.5 w-1.5 rounded-full flex-shrink-0", s.dot)} />
      {s.label}
    </span>
  );
}

// ── ControlBtn ────────────────────────────────────────────────────────────────
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
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex items-center justify-center rounded-lg flex-shrink-0",
        "w-9 h-9 sm:w-10 sm:h-10",
        "bg-white/10 hover:bg-white/20 active:bg-white/30",
        "backdrop-blur-sm transition-all duration-150",
        isTouch ? "active:scale-90" : "hover:scale-110"
      )}
      style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
      {...rest}
    >
      {children}
    </button>
  );
}

// ── InlineLogo ────────────────────────────────────────────────────────────────
// SVG fallback when /logo.png is not found
function InlineLogo() {
  return (
    <div className="flex items-center gap-2 drop-shadow-lg">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ background: "linear-gradient(135deg, #f54266 0%, #c0175a 100%)" }}>
        <svg className="w-4 h-4 text-white ml-0.5" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5,3 19,12 5,21" />
        </svg>
      </div>
      <span className="text-white font-bold text-base sm:text-lg tracking-tight leading-none">
        Khela<span style={{ color: "#f54266" }}>Dekhum</span>
      </span>
    </div>
  );
}
