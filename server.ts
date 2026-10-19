import express, { Request, Response } from 'express';
import cors from 'cors';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Ensure upload directory exists
const UPLOAD_DIR = path.resolve(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer storage setup for real video file uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    cb(null, `${uniqueSuffix}_${sanitizedName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max file size
  fileFilter: (_req, file, cb) => {
    // Allowed extensions and mimetypes
    const allowedExts = /\.(mp4|webm|mkv|mov|avi|flv|ts|m4v)$/i;
    if (file.mimetype.startsWith('video/') || allowedExts.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only video files (MP4, WebM, MOV, MKV, AVI, etc.) are permitted.'));
    }
  },
});

// RTMP / RTMPS Destination presets
// Using RTMPS (port 443) by default for YouTube and Facebook because port 1935 is blocked in cloud environments like Cloud Run
const RTMP_PRESETS: Record<string, string> = {
  yt: 'rtmps://a.rtmps.youtube.com/live2/',
  yt_rtmp: 'rtmp://a.rtmp.youtube.com/live2/',
  fb: 'rtmps://live-api-s.facebook.com:443/rtmp/',
  tiktok: 'rtmp://push-rtmp-l1-sg01.tiktokcdn.com/game/',
  twitch: 'rtmp://live.twitch.tv/app/',
  kick: 'rtmps://fa723fc1b171.global-contribute.live-video.net:443/app/',
  other: '',
};

type SessionState = 'IDLE' | 'STARTING' | 'LIVE' | 'RECONNECTING' | 'STOPPING' | 'STOPPED' | 'ERROR';

// Global streaming state
interface ServerStreamState {
  sessionState: SessionState;
  isStreaming: boolean;
  isPaused: boolean;
  frame: number;
  fps: string;
  time: string;
  size: string;
  bitrate: string;
  speed: string;
  droppedFrames: number;
  health: 'excellent' | 'good' | 'fair' | 'poor';
  logs: Array<{ id: string; timestamp: string; level: 'info' | 'warn' | 'error' | 'success'; message: string }>;
  destination: string;
  source: string;
  error: string | null;
  keepAliveUrl: string | null;
  lastPingTime: string | null;
}

const streamState: ServerStreamState = {
  sessionState: 'IDLE',
  isStreaming: false,
  isPaused: false,
  frame: 0,
  fps: '0',
  time: '00:00:00',
  size: '0 kB',
  bitrate: '0 kbits/s',
  speed: '0',
  droppedFrames: 0,
  health: 'excellent',
  logs: [],
  destination: '',
  source: '',
  error: null,
  keepAliveUrl: process.env.RENDER_EXTERNAL_URL || null,
  lastPingTime: null,
};

let activeProcess: ChildProcessWithoutNullStreams | null = null;
let recentStderrLines: string[] = [];

function addServerLog(message: string, level: 'info' | 'warn' | 'error' | 'success' = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const id = Math.random().toString(36).substring(2, 9);
  streamState.logs.push({ id, timestamp, level, message });
  if (streamState.logs.length > 250) {
    streamState.logs.shift();
  }
}

// Check ffmpeg availability
function checkFFmpegInstalled(): boolean {
  try {
    return fs.existsSync('/usr/bin/ffmpeg') || fs.existsSync('/usr/local/bin/ffmpeg');
  } catch {
    return false;
  }
}

// SSRF URL validator for remote sources
function isValidSafeRemoteUrl(rawUrl: string): boolean {
  if (rawUrl.startsWith('/public/') || rawUrl.startsWith('public/')) {
    return true;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    // Block localhost, private IPs, link-local, cloud metadata
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname === '169.254.169.254' ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Self Keep-Alive interval (Pings itself to prevent Render from going to sleep)
setInterval(() => {
  const targetUrl = streamState.keepAliveUrl || process.env.RENDER_EXTERNAL_URL;
  if (targetUrl) {
    const cleanUrl = targetUrl.replace(/\/$/, '');
    const pingEndpoint = `${cleanUrl}/api/health`;
    fetch(pingEndpoint)
      .then((res) => {
        if (res.ok) {
          streamState.lastPingTime = new Date().toLocaleTimeString();
          if (streamState.isStreaming) {
            addServerLog(`[Keep-Alive ⚡] Self-ping successful at ${streamState.lastPingTime}. Server will NOT sleep!`, 'success');
          }
        }
      })
      .catch((err) => {
        console.warn('Keep-alive ping error:', err.message);
      });
  }
}, 7 * 60 * 1000);

// API: File Upload Endpoint
app.post('/api/upload', (req: Request, res: Response) => {
  upload.single('video')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: `Upload failed: ${err.message}` });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No video file provided.' });
    }
    addServerLog(`[Upload] File uploaded successfully to server: ${req.file.originalname} (${(req.file.size / (1024 * 1024)).toFixed(1)} MB)`, 'success');
    return res.json({
      success: true,
      serverFilePath: req.file.path,
      fileName: req.file.originalname,
      fileSize: req.file.size,
    });
  });
});

// API: Health check & system capabilities
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    ffmpegInstalled: checkFFmpegInstalled(),
    isStreaming: streamState.isStreaming,
    sessionState: streamState.sessionState,
    keepAliveConfigured: Boolean(streamState.keepAliveUrl || process.env.RENDER_EXTERNAL_URL),
    lastPingTime: streamState.lastPingTime,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

// API: Set Keep-Alive URL dynamically from UI
app.post('/api/keepalive/set-url', (req: Request, res: Response) => {
  const { url } = req.body;
  if (url && typeof url === 'string') {
    streamState.keepAliveUrl = url.trim();
    addServerLog(`[Keep-Alive ⚡] Auto-ping URL set to: ${streamState.keepAliveUrl}`, 'info');
    res.json({ success: true, message: 'Keep-Alive URL configured successfully!' });
  } else {
    res.status(400).json({ success: false, message: 'Invalid URL provided' });
  }
});

// API: Current stream status
app.get('/api/stream/status', (_req: Request, res: Response) => {
  res.json({
    ...streamState,
    isRealFFmpegRunning: activeProcess !== null,
  });
});

// API: Start Real FFmpeg Livestream
app.post('/api/stream/start', (req: Request, res: Response) => {
  const {
    videoSource,
    videoFilePath,
    videoUrl,
    uploadedServerPath,
    rtmpChoice,
    customRtmpUrl,
    streamKey,
    repeat,
    qualityPreset,
  } = req.body;

  if (activeProcess) {
    res.status(400).json({ success: false, message: 'Stream is already running! Stop the current stream before starting a new one.' });
    return;
  }

  // Determine base RTMP/RTMPS destination
  let baseRtmp = rtmpChoice === 'other' ? customRtmpUrl : RTMP_PRESETS[rtmpChoice];
  if (!baseRtmp) {
    res.status(400).json({ success: false, message: 'Invalid or missing RTMP destination URL.' });
    return;
  }

  // Auto-upgrade raw YouTube RTMP port 1935 to RTMPS port 443 if user typed rtmp://a.rtmp.youtube.com
  if (baseRtmp.includes('rtmp://a.rtmp.youtube.com')) {
    baseRtmp = baseRtmp.replace('rtmp://a.rtmp.youtube.com', 'rtmps://a.rtmps.youtube.com');
  }

  if (!streamKey || !streamKey.trim()) {
    res.status(400).json({ success: false, message: 'Stream Key is required to connect to the platform.' });
    return;
  }

  // Resolve input source
  let resolvedInputSource = '';
  if (videoSource === 'file') {
    // Priority: uploaded server file path > local videoFilePath
    const candidatePath = uploadedServerPath || videoFilePath;
    if (!candidatePath || !candidatePath.trim()) {
      res.status(400).json({
        success: false,
        message: 'No video file specified. Please upload a video file or choose a sample video.',
      });
      return;
    }

    // Check if file exists on server filesystem or is a URL
    if (candidatePath.startsWith('http://') || candidatePath.startsWith('https://')) {
      resolvedInputSource = candidatePath;
    } else {
      const fullPath = path.isAbsolute(candidatePath) ? candidatePath : path.resolve(__dirname, candidatePath);
      if (!fs.existsSync(fullPath)) {
        res.status(400).json({
          success: false,
          message: `The video file "${candidatePath}" was not found on the server. Please upload it first using the upload button or use a remote video URL.`,
        });
        return;
      }
      resolvedInputSource = fullPath;
    }
  } else {
    // URL source
    if (!videoUrl || !videoUrl.trim()) {
      res.status(400).json({ success: false, message: 'Video URL cannot be empty.' });
      return;
    }
    if (!isValidSafeRemoteUrl(videoUrl.trim())) {
      res.status(400).json({
        success: false,
        message: 'Invalid video URL. Only public http:// and https:// URLs are permitted.',
      });
      return;
    }
    const trimmedUrl = videoUrl.trim();
    if (trimmedUrl.startsWith('/public/') || trimmedUrl.startsWith('public/')) {
      const cleanPath = trimmedUrl.replace(/^\/?public\//, '');
      const localPublicFile = path.resolve(__dirname, 'public', cleanPath);
      if (fs.existsSync(localPublicFile)) {
        resolvedInputSource = localPublicFile;
      } else {
        resolvedInputSource = trimmedUrl;
      }
    } else {
      resolvedInputSource = trimmedUrl;
    }
  }

  const cleanBase = baseRtmp.endsWith('/') ? baseRtmp : `${baseRtmp}/`;
  const fullRtmpDestination = `${cleanBase}${streamKey.trim()}`;

  // Reset state
  recentStderrLines = [];
  streamState.sessionState = 'STARTING';
  streamState.isStreaming = true;
  streamState.isPaused = false;
  streamState.frame = 0;
  streamState.fps = '0';
  streamState.time = '00:00:00';
  streamState.size = '0 kB';
  streamState.bitrate = '0 kbits/s';
  streamState.speed = '0';
  streamState.droppedFrames = 0;
  streamState.health = 'excellent';
  streamState.destination = cleanBase;
  streamState.source = resolvedInputSource;
  streamState.error = null;
  streamState.logs = [];

  addServerLog(`[Server Engine] Starting real FFmpeg broadcast pipeline...`, 'info');
  addServerLog(`[Input Source] ${resolvedInputSource}`, 'info');
  addServerLog(`[Destination] ${cleanBase} [Stream Key protected]`, 'info');

  const ffmpegArgs: string[] = [];

  // Loop infinitely if repeat enabled
  if (repeat) {
    ffmpegArgs.push('-stream_loop', '-1');
  }

  // If source is local public asset, resolve to absolute filesystem path
  if (resolvedInputSource.startsWith('/public/') || resolvedInputSource.startsWith('public/')) {
    const cleanPublicPath = resolvedInputSource.replace(/^\/?public\//, '');
    const localPublicFile = path.resolve(__dirname, 'public', cleanPublicPath);
    if (fs.existsSync(localPublicFile)) {
      resolvedInputSource = localPublicFile;
    }
  }

  // Network reconnect flags and browser User-Agent for remote video URLs (prevents 403 Forbidden)
  if (resolvedInputSource.startsWith('http://') || resolvedInputSource.startsWith('https://')) {
    ffmpegArgs.push(
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5'
    );
  }

  // Real-time pacing flag
  ffmpegArgs.push('-re');

  // Input source
  ffmpegArgs.push('-i', resolvedInputSource);

  // Audio & Video encoding pipeline optimized for YouTube & RTMP streaming
  // dump_extra=freq=keyframe dumps SPS/PPS with every keyframe to prevent "Preparing stream" stalls
  // tune zerolatency removes lookahead buffering so initial frames arrive instantly
  if (qualityPreset === 'eco') {
    // 720p / 1200 kbps: Super low bandwidth consumption for Render 24/7 free tier
    ffmpegArgs.push(
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-g', '60',
      '-keyint_min', '60',
      '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p',
      '-bsf:v', 'dump_extra=freq=keyframe',
      '-b:v', '1200k',
      '-maxrate', '1500k',
      '-bufsize', '2400k',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ar', '44100',
      '-ac', '2'
    );
  } else {
    // 720p/1080p 2500 kbps: Strict 2.0s GOP keyframes (Required by YouTube Live)
    ffmpegArgs.push(
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-g', '60',
      '-keyint_min', '60',
      '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p',
      '-bsf:v', 'dump_extra=freq=keyframe',
      '-b:v', '2500k',
      '-maxrate', '3000k',
      '-bufsize', '5000k',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '2'
    );
  }

  ffmpegArgs.push(
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    fullRtmpDestination
  );

  // Log command with stream key redacted
  const safeCommandArgs = ffmpegArgs.map((arg) => (arg === fullRtmpDestination ? `${cleanBase}••••••••` : arg));
  addServerLog(`[Command] ffmpeg ${safeCommandArgs.join(' ')}`, 'info');

  try {
    const proc = spawn('ffmpeg', ffmpegArgs);
    activeProcess = proc;

    proc.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) addServerLog(line, 'info');
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      const lines = text.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        recentStderrLines.push(trimmed);
        if (recentStderrLines.length > 50) {
          recentStderrLines.shift();
        }

        // Parse real-time live FFmpeg telemetry
        if (trimmed.includes('frame=')) {
          // Process is actively generating frames -> State is LIVE
          streamState.sessionState = 'LIVE';

          const frameMatch = trimmed.match(/frame=\s*(\d+)/);
          const fpsMatch = trimmed.match(/fps=\s*([\d.]+)/);
          const timeMatch = trimmed.match(/time=\s*([\d:.]+)/);
          const sizeMatch = trimmed.match(/size=\s*(\d+[kKmMbB]+)/);
          const bitrateMatch = trimmed.match(/bitrate=\s*([\d.]+kbits\/s)/);
          const speedMatch = trimmed.match(/speed=\s*([\d.]+)x/);

          if (frameMatch) streamState.frame = parseInt(frameMatch[1], 10);
          if (fpsMatch) streamState.fps = fpsMatch[1];
          if (timeMatch) streamState.time = timeMatch[1].split('.')[0];
          if (sizeMatch) streamState.size = sizeMatch[1];
          if (bitrateMatch) streamState.bitrate = bitrateMatch[1];
          if (speedMatch) streamState.speed = `${speedMatch[1]}x`;

          // Periodic telemetry log every ~90 frames
          if (streamState.frame % 90 === 0) {
            addServerLog(`[Telemetry] frame=${streamState.frame} fps=${streamState.fps} time=${streamState.time} bitrate=${streamState.bitrate} speed=${streamState.speed}`, 'info');
          }
        } else if (trimmed.includes('Stream mapping:')) {
          addServerLog(`[Handshake] RTMP Server Connection Accepted! Stream mapping OK.`, 'success');
        } else if (
          trimmed.includes('Error') ||
          trimmed.includes('error') ||
          trimmed.includes('Connection refused') ||
          trimmed.includes('Input/output error') ||
          trimmed.includes('Server error') ||
          trimmed.includes('No such file')
        ) {
          addServerLog(`[Error] ${trimmed}`, 'error');
          streamState.error = trimmed;
        } else if (trimmed.includes('Opening')) {
          addServerLog(trimmed, 'info');
        }
      }
    });

    proc.on('close', (code) => {
      activeProcess = null;
      streamState.isStreaming = false;

      if (code === 0) {
        streamState.sessionState = 'STOPPED';
        addServerLog(`[Process] FFmpeg process completed cleanly (code 0).`, 'info');
      } else {
        streamState.sessionState = 'ERROR';
        // Extract the most descriptive error line from recent stderr
        const errDetail =
          streamState.error ||
          recentStderrLines.reverse().find((l) => l.includes('error') || l.includes('Error') || l.includes('No such') || l.includes('Connection')) ||
          `FFmpeg exited with error code ${code}`;
        streamState.error = errDetail;
        addServerLog(`[Process Failed] FFmpeg exited with code ${code}. Detail: ${errDetail}`, 'error');
      }
    });

    proc.on('error', (err) => {
      addServerLog(`[Process Error] Failed to start FFmpeg: ${err.message}`, 'error');
      activeProcess = null;
      streamState.isStreaming = false;
      streamState.sessionState = 'ERROR';
      streamState.error = err.message;
    });

    res.json({
      success: true,
      message: 'Real FFmpeg livestream process started on server!',
    });
  } catch (err: any) {
    activeProcess = null;
    streamState.isStreaming = false;
    streamState.sessionState = 'ERROR';
    streamState.error = err.message;
    res.status(500).json({ success: false, message: `Failed to launch FFmpeg: ${err.message}` });
  }
});

// API: Stop Real FFmpeg Livestream
app.post('/api/stream/stop', (_req: Request, res: Response) => {
  streamState.sessionState = 'STOPPING';

  if (activeProcess) {
    addServerLog(`[Server Engine] Stopping FFmpeg process PID ${activeProcess.pid}...`, 'warn');
    activeProcess.kill('SIGINT');
    setTimeout(() => {
      if (activeProcess) {
        activeProcess.kill('SIGKILL');
        activeProcess = null;
      }
    }, 1500);
  }

  streamState.isStreaming = false;
  streamState.sessionState = 'STOPPED';
  addServerLog(`[Server Engine] Livestream stopped cleanly.`, 'success');
  res.json({ success: true, message: 'Livestream stopped.' });
});

// Graceful process cleanup on server termination
process.on('SIGTERM', () => {
  if (activeProcess) {
    activeProcess.kill('SIGKILL');
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  if (activeProcess) {
    activeProcess.kill('SIGKILL');
  }
  process.exit(0);
});

// Start Express server
async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.resolve(distPath, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 DoLive Full-Stack Server running at http://0.0.0.0:${PORT}`);
    console.log(`🎬 FFmpeg binary detected: ${checkFFmpegInstalled() ? 'YES (/usr/bin/ffmpeg)' : 'NO'}`);
  });
}

startServer();
