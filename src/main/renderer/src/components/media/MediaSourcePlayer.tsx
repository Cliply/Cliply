// Adapted from LosslessCut MediaSourcePlayer.tsx at 6fc47dd4.
// See third-party/losslesscut/README.md and LICENSE. IPC replaces Electron remote.
import type { CSSProperties, RefObject, ReactEventHandler, FocusEventHandler } from "react"
import { useEffect, useRef, useState, useCallback, useMemo, memo } from "react"
import { Film } from "lucide-react"
import { mediaApi } from "@/lib/api"

type PreviewStream = { index: number }
// Main fixes compatibility previews at 30 fps in compatibility-player.js.
const PREVIEW_FRAME_DURATION = 1 / 30
function invariant(value: unknown): asserts value { if (!value) throw new Error("Missing preview element") }
// Leading and trailing calls match the upstream preview restart debounce.
function debounce(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let trailing = false
  const invoke = () => {
    if (!timer) fn(); else trailing = true
    clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; if (trailing) { trailing = false; fn() } }, ms)
  }
  invoke.cancel = () => { clearTimeout(timer); timer = undefined; trailing = false }
  return invoke
}
function createMediaSourceStream({ sourceId, seekTo }: { sourceId: string; seekTo: number }) {
  let id: string | undefined
  let cancelled = false
  return {
    abort() { cancelled = true; if (id) void mediaApi.compatStop(id).catch(() => {}) },
    // Main resolves this opaque ID and owns stream selection/encoder settings.
    promise: mediaApi.compatStart({ sourceId, seekTo }).then(session => {
      id = session.sessionId
      if (cancelled) { void mediaApi.compatStop(id).catch(() => {}); return undefined }
      return () => mediaApi.compatRead(session.sessionId)
    })
  }
}

async function startPlayback({ sourceId, slaveVideo, masterVideo, videoStreamIndex, audioStreams, seekTo, signal, onCanPlay, onResetNeeded, onWaiting }: {
  sourceId: string,
  slaveVideo: HTMLMediaElement,
  masterVideo: HTMLMediaElement,
  videoStreamIndex?: number | undefined,
  audioStreams: PreviewStream[],
  seekTo: number,
  signal: AbortSignal,
  onCanPlay: () => void,
  onResetNeeded: () => void,
  onWaiting: () => void,
}) {
  let bufferEndTime: number | undefined;
  let bufferStartTime = seekTo;
  // Abort can arrive before asynchronous setup creates each resource.
  let mediaSourceProcess: ReturnType<typeof createMediaSourceStream> | undefined = undefined;
  let syncInterval: ReturnType<typeof setInterval> | undefined = undefined;
  let objectUrl: string | undefined = undefined;
  let processChunkTimeout: ReturnType<typeof setTimeout>;

  signal.addEventListener('abort', () => {
    slaveVideo.pause();
    if (syncInterval != null) clearInterval(syncInterval);
    if (processChunkTimeout != null) clearTimeout(processChunkTimeout);
    mediaSourceProcess?.abort();
    if (objectUrl != null) URL.revokeObjectURL(objectUrl);
    slaveVideo.removeAttribute('src');
  });

  let lastRemoveTimestamp = seekTo;

  const setPlaybackRate = (r: number) => {
    const maxAllowedPlaybackRate = 16; // or else we get an error in Chromium
    const newAdjustedRate = Math.min(maxAllowedPlaybackRate, r * masterVideo.playbackRate);
    if (slaveVideo.playbackRate === newAdjustedRate) {
      return;
    }

    slaveVideo.playbackRate = newAdjustedRate;
  };

  // set it a bit faster, so that we don't easily fall behind (better too fast than too slow)
  const setStandardPlaybackRate = () => setPlaybackRate(1.05);

  setStandardPlaybackRate();

  const codecs: string[] = [];
  if (videoStreamIndex != null) codecs.push('avc1.42C01F');
  if (audioStreams.length > 0) codecs.push('mp4a.40.2');
  const codecTag = codecs.join(', ');

  const mimeCodec = `video/mp4; codecs="${codecTag}"`;

  if (!MediaSource.isTypeSupported(mimeCodec)) {
    throw new Error(`Unsupported MIME type or codec: ${mimeCodec}`);
  }

  mediaSourceProcess = createMediaSourceStream({ sourceId, seekTo });
  const readChunk = await mediaSourceProcess.promise;
  if (readChunk == null) {
    if (signal.aborted) return;
    throw new Error('Media source process did not initialize');
  }

  if (signal.aborted) return;
  const mediaSource = new MediaSource();

  objectUrl = URL.createObjectURL(mediaSource);
  slaveVideo.src = objectUrl;

  await new Promise((resolve) => { mediaSource.addEventListener('sourceopen', resolve, { once: true }); });

  const sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
  sourceBuffer.timestampOffset = seekTo - PREVIEW_FRAME_DURATION; // upstream one-frame correction: https://github.com/mifi/lossless-cut/issues/2591#issuecomment-3478018458

  signal.addEventListener('abort', () => { try { if (mediaSource.readyState === 'open') sourceBuffer.abort(); } catch { /* already detached */ } });

  const getBufferEndTime = () => {
    if (mediaSource.readyState !== 'open') {
      return undefined;
    }

    if (sourceBuffer.buffered.length === 0) {
      return undefined;
    }

    return sourceBuffer.buffered.end(0);
  };

  const processChunk = async () => {
    try {
      const chunk = await readChunk();
      if (chunk == null) {
        if (mediaSource.readyState === 'open' && !sourceBuffer.updating) mediaSource.endOfStream();
        return;
      }

      if (signal.aborted) return;

      sourceBuffer.appendBuffer(chunk as unknown as BufferSource);
    } catch (err) {
      console.error('processChunk failed', err);
      processChunkTimeout = setTimeout(processChunk, 1000);
    }
  };

  sourceBuffer.addEventListener('error', (err) => console.error('sourceBuffer error, check DevTools ▶ More Tools ▶ Media', err));

  const handleCanPlay = () => {
    onCanPlay();
  };
  slaveVideo.addEventListener('canplay', handleCanPlay);

  const handleWaiting = () => {
    if (slaveVideo.paused || slaveVideo.ended) return; // we don't care if paused
    onWaiting();
  };

  slaveVideo.addEventListener('waiting', handleWaiting);

  signal.addEventListener('abort', () => {
    slaveVideo.removeEventListener('canplay', handleCanPlay);
    slaveVideo.removeEventListener('waiting', handleWaiting);
  });

  sourceBuffer.addEventListener('updateend', () => {
    if (signal.aborted) return;

    const bufferThrottleSec = 10; // how many seconds ahead of playback we want to buffer
    const bufferMaxSec = bufferThrottleSec + 60; // how many seconds we want to buffer in total (ahead of playback and behind)

    bufferEndTime = getBufferEndTime();

    if (bufferEndTime != null) {
      const bufferedDuration = bufferEndTime - lastRemoveTimestamp;

      if (bufferedDuration > bufferMaxSec && !sourceBuffer.updating) {
        try {
          lastRemoveTimestamp = bufferEndTime;
          const removeTo = bufferEndTime - bufferMaxSec;
          bufferStartTime = removeTo;
          sourceBuffer.remove(0, removeTo); // updateend will be emitted again when this is done
          return;
        } catch (err) {
          console.error('sourceBuffer remove failed', err);
        }
      }

      const bufferAheadSec = bufferEndTime - masterVideo.currentTime;
      if (bufferAheadSec > bufferThrottleSec) {
        processChunkTimeout = setTimeout(processChunk, 1000);
        return;
      }
    }

    // make sure we always process the next chunk
    processChunk();
  });

  // Synchronize state between the two video elements
  syncInterval = setInterval(async () => {
    try {
      const maxSecAfterBufferToWaitFor = 5;
      if (masterVideo.currentTime < bufferStartTime || (bufferEndTime != null && masterVideo.currentTime - bufferEndTime > maxSecAfterBufferToWaitFor)) {
        onResetNeeded();
        return;
      }

      if (masterVideo.paused || masterVideo.ended) {
        const resolution = 1000;
        if (Math.round(slaveVideo.currentTime * resolution) !== Math.round(masterVideo.currentTime * resolution)) {
          slaveVideo.currentTime = masterVideo.currentTime;
        }
      } else { // playing
        // make sure the playback keeps up while playing
        // or when seeking while playing
        // https://stackoverflow.com/questions/23301496/how-to-keep-a-live-mediasource-video-stream-in-sync
        const playbackDiff = masterVideo.currentTime - slaveVideo.currentTime;
        if (Math.abs(playbackDiff) > 1) {
          slaveVideo.currentTime = masterVideo.currentTime;
          setStandardPlaybackRate();
        } else if (playbackDiff != null && playbackDiff > 0.3) {
          setPlaybackRate(1.5);
        } else {
          setStandardPlaybackRate();
        }
      }

      if (slaveVideo.volume !== masterVideo.volume) {
        slaveVideo.volume = masterVideo.volume;
      }
      // Cliply exposes native controls; their mute flag is separate from volume.
      // The master contains silence, so it can retain the user's actual mute state.
      if (slaveVideo.muted !== masterVideo.muted) slaveVideo.muted = masterVideo.muted;

      const masterStopped = masterVideo.paused || masterVideo.ended;
      const slaveStopped = slaveVideo.paused || slaveVideo.ended;

      if (slaveStopped && !masterStopped) {
        await slaveVideo.play();
      } else if (!slaveStopped && masterStopped) {
        slaveVideo.pause();
      }
    } catch (err) {
      console.error('play/pause failed', err);
    }
  }, 30);

  // OK, everything initialized and ready to stream!
  processChunk();
}

function MediaSourcePlayer({ sourceId, videoStream, audioStreams, masterVideoRef, baseVideoStyle, onFailure }: {
  sourceId: string,
  videoStream: PreviewStream | undefined,
  audioStreams: PreviewStream[],
  masterVideoRef: RefObject<HTMLMediaElement | null>,
  baseVideoStyle: CSSProperties,
  onFailure: () => void,
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [showCanvas, setShowCanvas] = useState(false);

  const onVideoError = useCallback<ReactEventHandler<HTMLVideoElement>>((error) => {
    console.error('video error', error);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    invariant(video != null);

    const masterVideo = masterVideoRef.current;
    invariant(masterVideo != null);

    const canvas = canvasRef.current;
    invariant(canvas != null);

    let abortController: AbortController;

    const start = async () => {
      abortController?.abort();
      abortController = new AbortController();

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
      setShowCanvas(true);
      setLoading(true);

      const seekTo = masterVideo.currentTime;
      if (masterVideo.ended) return;

      try {
        await startPlayback({
          signal: abortController.signal,
          sourceId,
          slaveVideo: video,
          masterVideo,
          videoStreamIndex: videoStream?.index,
          audioStreams,
          seekTo,
          onCanPlay: () => {
            setLoading(false);
            setShowCanvas(false);
          },
          onResetNeeded: () => {
            abortController.abort();
            startDebounced();
          },
          onWaiting: () => {
            setLoading(true);
          },
        });
      } catch (err) {
        if (!abortController.signal.aborted) { console.error('Preview failed', err); onFailure(); }
      }
    };

    const startDebounced = debounce(start, 500);

    startDebounced();

    return () => { startDebounced.cancel(); abortController?.abort(); };
  }, [audioStreams, sourceId, masterVideoRef, videoStream, onFailure]);

  const onFocus = useCallback<FocusEventHandler<HTMLVideoElement>>((e) => {
    // prevent video element from stealing focus in fullscreen mode https://github.com/mifi/lossless-cut/issues/543#issuecomment-1868167775
    e.target.blur();
  }, []);

  const videoStyle = useMemo<CSSProperties>(() => ({
    ...baseVideoStyle, position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, display: 'block',
  }), [baseVideoStyle]);

  return (
    <div style={{ width: '100%', left: 0, right: 0, top: 0, bottom: 40, position: 'absolute', overflow: 'hidden', background: 'black', pointerEvents: 'none' }}>
      <video style={{ ...videoStyle, visibility: showCanvas ? 'hidden' : 'initial' }} ref={videoRef} playsInline onError={onVideoError} tabIndex={-1} onFocusCapture={onFocus} />
      <canvas style={{ ...videoStyle, display: showCanvas ? 'initial' : 'none' }} ref={canvasRef} />

      {loading && (
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <Film className="animate-pulse" style={{ padding: '1em', background: 'rgba(0,0,0,0.2)', borderRadius: '50%' }} />
        </div>
      )}
    </div>
  );
}

export default memo(MediaSourcePlayer);
