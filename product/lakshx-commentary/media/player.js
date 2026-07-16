"use strict";
/*
 * LakshX Music webview player. Owns the single <audio> element and talks to
 * extension.js over postMessage.
 *
 * extension → webview:
 *   { type:"setStation", url, name, homepage }  set source + label (no autoplay)
 *   { type:"play" }                             play (only valid after the user's first click gesture)
 *   { type:"pause" }                            pause
 *   { type:"volume", value }                    set target volume 0..100
 * webview → extension:
 *   { type:"ready" }                            listener is live — safe to send setStation/play now (handshake)
 *   { type:"state", value:"playing"|"paused"|"error" }
 *   { type:"volumeChanged", value }             user moved the slider (extension persists it)
 *   { type:"needsGesture" }                     a programmatic play() was blocked; the user must click Play
 */
(function () {
  const vscode = acquireVsCodeApi();
  const audio = document.getElementById("audio");
  const playPause = document.getElementById("playPause");
  const playPauseLabel = document.getElementById("playPauseLabel");
  const volume = document.getElementById("volume");
  const stationName = document.getElementById("stationName");
  const stationLink = document.getElementById("stationLink");
  const statusEl = document.getElementById("status");

  let targetVolume = 0.6; // 0..1, the user's chosen level
  let hasSource = false;

  function applyVolume() {
    audio.volume = Math.max(0, Math.min(1, targetVolume));
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "status " + cls;
  }

  function reflectPlayState() {
    const playing = !audio.paused && !audio.ended;
    playPauseLabel.textContent = playing ? "⏸ Pause" : "▶ Play";
    playPause.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  function post(msg) {
    try { vscode.postMessage(msg); } catch (_e) { /* not in a webview host */ }
  }

  function tryPlay(fromGesture) {
    if (!hasSource) return;
    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch(() => {
        // Autoplay policy or a network hiccup. If this wasn't a real click,
        // tell the extension the user has to press Play.
        if (!fromGesture) post({ type: "needsGesture" });
        setStatus("Click Play to start", "paused");
        reflectPlayState();
      });
    }
  }

  // ---- user gesture: the FIRST play must come from here (Chromium autoplay policy) ----
  playPause.addEventListener("click", () => {
    if (audio.paused) tryPlay(true);
    else audio.pause();
  });

  volume.addEventListener("input", () => {
    targetVolume = Number(volume.value) / 100;
    applyVolume();
    post({ type: "volumeChanged", value: Number(volume.value) });
  });

  // ---- audio element state → extension ----
  audio.addEventListener("playing", () => { setStatus("Playing", "playing"); reflectPlayState(); post({ type: "state", value: "playing" }); });
  audio.addEventListener("pause", () => { setStatus("Paused", "paused"); reflectPlayState(); post({ type: "state", value: "paused" }); });
  audio.addEventListener("waiting", () => { setStatus("Buffering…", "buffering"); });
  audio.addEventListener("stalled", () => { setStatus("Buffering…", "buffering"); });
  audio.addEventListener("error", () => {
    setStatus("Stream error", "error");
    reflectPlayState();
    post({ type: "state", value: "error" });
  });

  // ---- extension → webview ----
  window.addEventListener("message", (event) => {
    const m = event.data || {};
    switch (m.type) {
      case "setStation": {
        const wasPlaying = !audio.paused;
        stationName.textContent = m.name || "LakshX Music";
        if (m.homepage) {
          stationLink.href = m.homepage;
          stationLink.hidden = false;
        } else {
          stationLink.hidden = true;
        }
        if (typeof m.url === "string" && m.url) {
          audio.src = m.url;
          hasSource = true;
          // Switching station while already playing continues playback (the
          // gesture was already granted by the earlier click).
          if (wasPlaying) tryPlay(false);
          else setStatus("Ready — click Play", "paused");
        } else {
          hasSource = false;
          setStatus("No stream", "paused");
        }
        reflectPlayState();
        break;
      }
      case "play":
        tryPlay(false);
        break;
      case "pause":
        audio.pause();
        break;
      case "volume":
        if (typeof m.value === "number") {
          targetVolume = Math.max(0, Math.min(1, m.value / 100));
          volume.value = String(Math.round(targetVolume * 100));
          applyVolume();
        }
        break;
      default:
        break;
    }
  });

  applyVolume();
  reflectPlayState();
  // Handshake: tell the extension the listener is live so it can safely send
  // setStation/play without the message being dropped (webview-load race).
  post({ type: "ready" });
})();
