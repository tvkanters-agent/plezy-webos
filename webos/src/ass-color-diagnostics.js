// SPDX-License-Identifier: GPL-3.0-only
// Paused-frame comparison for devices with a separate hardware video plane.
// Never read back video pixels. Cross-origin video can taint the output canvas.
export function attachAssColorComparison(video, renderer) {
  const box = document.createElement('figure');
  box.className = 'ass-color-comparison';
  const label = document.createElement('figcaption');
  const sample = document.createElement('canvas');
  box.appendChild(label);
  box.appendChild(sample);
  let bounds;
  let frame;

  function draw() {
    frame = null;
    box.remove();
    if (!video.paused || video.seeking || !bounds) return;
    const overlay = renderer.canvas;
    const left = Math.max(0, bounds.x - 12), top = Math.max(0, bounds.y - 12);
    const width = Math.min(overlay.width - left, bounds.x + bounds.w + 12 - left);
    const height = Math.min(overlay.height - top, bounds.y + bounds.h + 12 - top);
    if (width <= 0 || height <= 0) return;
    const scale = Math.min(1, 720 / width, 320 / height);
    sample.width = Math.max(1, Math.round(width * scale));
    sample.height = Math.max(1, Math.round(height * scale));
    const ctx = sample.getContext('2d');
    label.textContent = 'Paused ASS · locally combined video and subtitles';
    try {
      ctx.fillStyle = '#ff00ff';
      ctx.fillRect(0, 0, sample.width, sample.height);
      ctx.scale(sample.width / width, sample.height / height);
      ctx.translate(-left, -top);
      ctx.drawImage(video, 0, 0, overlay.width, overlay.height);
      ctx.drawImage(overlay, 0, 0);
    } catch (_) {
      label.textContent = 'Paused ASS · video frame unavailable';
      sample.width = 0;
    }
    video.parentNode.appendChild(box);
  }

  function schedule() {
    if (frame == null) frame = requestAnimationFrame(draw);
  }
  function hide() {
    box.remove();
    if (frame != null) cancelAnimationFrame(frame);
    frame = null;
  }
  function onImage(event) {
    if (event.data.target !== 'canvas' || event.data.op !== 'renderCanvas') return;
    // The bundled wasm-blend worker sends one composited rectangle. Retain
    // geometry only, so diagnostics never keep the transferred bitmaps alive.
    const image = event.data.canvases[0];
    bounds = image && {x:image.x, y:image.y, w:image.w, h:image.h};
    if (video.paused) schedule();
  }
  renderer.worker.addEventListener('message', onImage);
  video.addEventListener('pause', schedule);
  video.addEventListener('seeked', schedule);
  video.addEventListener('seeking', hide);
  video.addEventListener('play', hide);
  return () => {
    hide();
    renderer.worker.removeEventListener('message', onImage);
    video.removeEventListener('pause', schedule);
    video.removeEventListener('seeked', schedule);
    video.removeEventListener('seeking', hide);
    video.removeEventListener('play', hide);
  };
}
