export type AudioVisualizerOptions = {
  canvas: HTMLCanvasElement;
  audioElement?: HTMLAudioElement;
  mediaStream?: MediaStream;
  waveColor?: string;
  barColor?: string;
};

export type AudioVisualizer = {
  stop: () => void;
  resume: () => void;
};

export function attachAudioVisualizer(
  options: AudioVisualizerOptions,
): AudioVisualizer {
  const {
    canvas,
    audioElement,
    mediaStream,
    waveColor = "#38bdf8",
    barColor = "#818cf8",
  } = options;

  if (!audioElement && !mediaStream) {
    throw new Error(
      "attachAudioVisualizer requires audioElement or mediaStream",
    );
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("canvas 2d context unavailable");
  }

  const audioCtx = new AudioContext();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.75;

  const streamSource =
    mediaStream ??
    (audioElement?.srcObject instanceof MediaStream
      ? audioElement.srcObject
      : null);

  if (streamSource) {
    audioCtx.createMediaStreamSource(streamSource).connect(analyser);
  } else if (audioElement) {
    const source = audioCtx.createMediaElementSource(audioElement);
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
  } else {
    throw new Error(
      "attachAudioVisualizer requires audioElement or mediaStream",
    );
  }

  const ensureRunning = () => {
    if (audioCtx.state === "suspended") {
      void audioCtx.resume();
    }
  };

  if (audioElement) {
    audioElement.addEventListener("playing", ensureRunning);
  }
  for (const track of streamSource?.getAudioTracks() ?? []) {
    track.addEventListener("unmute", ensureRunning);
  }

  const timeData = new Uint8Array(analyser.fftSize);
  const freqData = new Uint8Array(analyser.frequencyBinCount);
  let rafId = 0;
  let stopped = false;

  const draw = () => {
    if (stopped) return;
    rafId = requestAnimationFrame(draw);

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    analyser.getByteTimeDomainData(timeData);
    ctx.lineWidth = 2;
    ctx.strokeStyle = waveColor;
    ctx.beginPath();
    const sliceWidth = width / timeData.length;
    let x = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = timeData[i] / 128.0;
      const y = (v * height) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    analyser.getByteFrequencyData(freqData);
    const barWidth = width / freqData.length;
    for (let i = 0; i < freqData.length; i++) {
      const barHeight = (freqData[i] / 255) * (height * 0.45);
      ctx.fillStyle = barColor;
      ctx.fillRect(i * barWidth, height - barHeight, barWidth - 1, barHeight);
    }
  };

  draw();

  return {
    stop: () => {
      stopped = true;
      cancelAnimationFrame(rafId);
      void audioCtx.close();
    },
    resume: ensureRunning,
  };
}
