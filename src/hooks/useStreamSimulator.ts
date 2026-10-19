import { useState, useEffect, useRef, useCallback } from 'react';
import { StreamConfig, StreamStatus, RTMP_PRESETS } from '../types/stream';

export function useStreamSimulator() {
  const [status, setStatus] = useState<StreamStatus>({
    sessionState: 'IDLE',
    isStreaming: false,
    isConnect: true,
    isPaused: false,
    msg: null,
    error: null,
    frame: 0,
    fps: '0',
    time: '00:00:00',
    size: '0 kB',
    bitrate: '0 kbits/s',
    speed: '0',
    droppedFrames: 0,
    health: 'excellent',
    logs: [],
    isRealFFmpegRunning: false,
  });

  const [isServerActive, setIsServerActive] = useState<boolean>(true);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);

  const clearLogs = useCallback(() => {
    setStatus((prev) => ({ ...prev, logs: [] }));
  }, []);

  const clearMessage = useCallback(() => {
    setStatus((prev) => ({ ...prev, msg: null, error: null }));
  }, []);

  const setMessage = useCallback((msg: string) => {
    setStatus((prev) => ({ ...prev, msg }));
  }, []);

  // Upload video file directly to the backend server
  const uploadVideoFile = useCallback(async (file: File): Promise<{ success: boolean; serverFilePath?: string; message?: string }> => {
    setIsUploading(true);
    setUploadProgress(10);
    try {
      const formData = new FormData();
      formData.append('video', file);

      setUploadProgress(40);
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      setUploadProgress(85);
      const data = await res.json();
      setIsUploading(false);
      setUploadProgress(100);
      setTimeout(() => setUploadProgress(null), 1500);

      if (res.ok && data.success) {
        return { success: true, serverFilePath: data.serverFilePath };
      } else {
        return { success: false, message: data.message || 'File upload failed.' };
      }
    } catch (err: any) {
      setIsUploading(false);
      setUploadProgress(null);
      return { success: false, message: `Upload error: ${err.message}` };
    }
  }, []);

  // Check backend server health on mount
  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => {
        if (data.status === 'ok') {
          setIsServerActive(true);
        }
      })
      .catch(() => {
        setIsServerActive(false);
      });
  }, []);

  // Real-time status sync with backend server
  const syncServerStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/stream/status');
      if (res.ok) {
        const data = await res.json();

        setStatus((prev) => {
          // If server stopped streaming or encountered an error
          if (!data.isStreaming && prev.isStreaming) {
            return {
              ...prev,
              sessionState: data.sessionState || (data.error ? 'ERROR' : 'STOPPED'),
              isStreaming: false,
              isConnect: true,
              isRealFFmpegRunning: false,
              error: data.error || null,
              msg: data.error ? `Stream Error: ${data.error}` : 'Stream stopped.',
              logs: data.logs && data.logs.length > 0 ? data.logs : prev.logs,
            };
          }

          // If server is actively streaming
          if (data.isStreaming) {
            return {
              ...prev,
              sessionState: data.sessionState || (data.frame > 0 ? 'LIVE' : 'STARTING'),
              isStreaming: true,
              isConnect: false,
              isRealFFmpegRunning: data.isRealFFmpegRunning,
              frame: data.frame ?? prev.frame,
              fps: data.fps ?? prev.fps,
              time: data.time ?? prev.time,
              size: data.size ?? prev.size,
              bitrate: data.bitrate ?? prev.bitrate,
              speed: data.speed ?? prev.speed,
              droppedFrames: data.droppedFrames ?? prev.droppedFrames,
              health: data.health ?? prev.health,
              error: data.error ?? null,
              logs: data.logs && data.logs.length > 0 ? data.logs : prev.logs,
            };
          }

          // Otherwise keep idle / stopped state in sync
          return {
            ...prev,
            sessionState: data.sessionState || prev.sessionState,
            isRealFFmpegRunning: data.isRealFFmpegRunning,
            logs: data.logs && data.logs.length > 0 ? data.logs : prev.logs,
            error: data.error || prev.error,
          };
        });
      }
    } catch (err) {
      console.warn('Status poll failed:', err);
    }
  }, []);

  // Polling loop
  useEffect(() => {
    // Poll every 1s when active or starting
    pollTimerRef.current = setInterval(syncServerStatus, 1000);
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, [syncServerStatus]);

  // Start Stream Handler
  const startStream = useCallback(
    async (config: StreamConfig): Promise<{ success: boolean; messageKey: string; errorDetail?: string }> => {
      // Basic client validation
      const hasFile = config.videoSource === 'file' && (Boolean(config.videoFilePath.trim()) || Boolean(config.uploadedServerPath));
      const hasUrl = config.videoSource === 'url' && Boolean(config.videoUrl.trim());

      if (!hasFile && !hasUrl) {
        setStatus((prev) => ({ ...prev, sessionState: 'ERROR', error: 'Missing video source' }));
        return { success: false, messageKey: 'errorMissingSource' };
      }

      if (config.rtmpChoice === 'other' && !config.customRtmpUrl.trim()) {
        setStatus((prev) => ({ ...prev, sessionState: 'ERROR', error: 'Missing RTMP destination URL' }));
        return { success: false, messageKey: 'errorMissingRtmp' };
      }

      if (!config.streamKey.trim()) {
        setStatus((prev) => ({ ...prev, sessionState: 'ERROR', error: 'Missing Stream Key' }));
        return { success: false, messageKey: 'errorMissingKey' };
      }

      const baseUrl = config.rtmpChoice === 'other' ? config.customRtmpUrl : RTMP_PRESETS[config.rtmpChoice];
      if (!baseUrl) {
        setStatus((prev) => ({ ...prev, sessionState: 'ERROR', error: 'Invalid RTMP destination' }));
        return { success: false, messageKey: 'errorMissingRtmp' };
      }

      setStatus((prev) => ({
        ...prev,
        sessionState: 'STARTING',
        isStreaming: true,
        isConnect: false,
        msg: 'Connecting to RTMP server...',
        error: null,
        frame: 0,
        fps: '0',
        time: '00:00:00',
        size: '0 kB',
        bitrate: '0 kbits/s',
        speed: '0',
      }));

      try {
        const payload = {
          videoSource: config.videoSource,
          videoFilePath: config.videoFilePath,
          videoUrl: config.videoUrl,
          uploadedServerPath: config.uploadedServerPath,
          rtmpChoice: config.rtmpChoice,
          customRtmpUrl: config.customRtmpUrl,
          streamKey: config.streamKey,
          repeat: config.repeat,
          qualityPreset: config.qualityPreset || 'ultra',
        };

        const response = await fetch('/api/stream/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
          setStatus((prev) => ({
            ...prev,
            sessionState: 'ERROR',
            isStreaming: false,
            isConnect: true,
            error: data.message || 'Failed to start stream',
            msg: data.message || 'Failed to start stream',
          }));
          return { success: false, messageKey: data.message || 'Failed to start stream', errorDetail: data.message };
        }

        // Trigger immediate status sync
        await syncServerStatus();
        return { success: true, messageKey: 'successConnected' };
      } catch (err: any) {
        setStatus((prev) => ({
          ...prev,
          sessionState: 'ERROR',
          isStreaming: false,
          isConnect: true,
          error: `Network error connecting to backend: ${err.message}`,
          msg: `Network error: ${err.message}`,
        }));
        return { success: false, messageKey: `Network error: ${err.message}` };
      }
    },
    [syncServerStatus]
  );

  const pauseStream = useCallback(() => {
    setStatus((prev) => ({ ...prev, isPaused: !prev.isPaused }));
  }, []);

  const stopStream = useCallback(async () => {
    setStatus((prev) => ({ ...prev, sessionState: 'STOPPING' }));
    try {
      await fetch('/api/stream/stop', { method: 'POST' });
    } catch (err) {
      console.warn('Stop request error:', err);
    }
    await syncServerStatus();
  }, [syncServerStatus]);

  return {
    status,
    startStream,
    pauseStream,
    stopStream,
    clearMessage,
    setMessage,
    clearLogs,
    isServerActive,
    uploadVideoFile,
    isUploading,
    uploadProgress,
  };
}
